// Hierarchical instanced SDF: tile sharing, InstancedMesh placements, and the
// top-level candidate grid.
//
// Three things can silently go wrong here, and all three look like "the GI is
// a bit off" rather than like a crash:
//
//   1. TILE SHARING writes the wrong texels. Every instance of a geometry
//      points at ONE tile now, so a bad origin or a refcount that frees a live
//      tile corrupts every copy of that prop at once.
//   2. INSTANCE TRANSFORMS compose in the wrong order. An InstancedMesh
//      placement's world matrix is `mesh.matrixWorld * instanceMatrix[i]`;
//      swap those and the whole scatter collapses onto the prototype — which
//      still renders a plausible-looking field, just in the wrong places.
//   3. THE GRID DROPS A CANDIDATE. The composite is the field itself, so a
//      slot missing from a cell's list is a hole, and holes read as light
//      leaking through solid geometry. This is the one worth being paranoid
//      about, so it is checked two ways: against a brute-force CPU list, and
//      by comparing the composited occupancy A/B against the flat scan.
//
// Asserted on atlas/grid state and one GPU occupancy readback rather than on
// screen pixels — no viewport canvas needed, which keeps it clear of the
// editor's intermittent panel-mount flake (see run-gi-light-visibility).
import puppeteer from "puppeteer-core";

const url = process.argv[2] ?? "http://localhost:5201/";
const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 1 });
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\]|GI-IS/.test(t)) console.log(`${m.type()}: ${t}`);
});
page.on("pageerror", (e) => console.log(`pageerror: ${e.stack ?? e.message}`));

await page.goto(url, { waitUntil: "load", timeout: 30000 });
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
});
await new Promise((r) => setTimeout(r, 5000));

const result = await page.evaluate(async () => {
  const { THREE } = await import("/src/engine/index.js");
  await import("/src/modules/index.js");
  const { enableEngineModule } = await import("/src/engine/modules.js");
  const { ensureEngine } = await import("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  await enableEngineModule(engine, "gi");
  globalThis.__engine = engine;

  const room = (size, position, color) => {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(...size),
      new THREE.MeshStandardNodeMaterial({ color, roughness: 0.9, metalness: 0 }),
    );
    mesh.position.set(...position);
    engine.scene.add(mesh);
    return mesh;
  };
  room([16, 0.2, 16], [0, -0.1, 0], 0xcccccc);
  room([16, 0.2, 16], [0, 6.1, 0], 0xb8c3cf);
  room([16, 6, 0.2], [0, 3, -8.1], 0xb8c3cf);

  // COPIES OF ONE GEOMETRY. Not primitives — an analytic box would never
  // claim a tile and the dedup would be untested. A lathe gives an
  // anonymous, non-primitive BufferGeometry that has to bake.
  const propGeometry = new THREE.LatheGeometry(
    [new THREE.Vector2(0, 0), new THREE.Vector2(0.35, 0.2), new THREE.Vector2(0.22, 0.7), new THREE.Vector2(0, 0.85)],
    12,
  );
  const propMaterial = new THREE.MeshStandardNodeMaterial({ color: 0xb07a3c, roughness: 0.8 });
  const COPIES = 24;
  for (let i = 0; i < COPIES; i++) {
    const mesh = new THREE.Mesh(propGeometry, propMaterial);
    mesh.position.set(-7 + (i % 8) * 2, 0.4, -6 + Math.floor(i / 8) * 2);
    engine.scene.add(mesh);
  }

  // A REAL InstancedMesh — the thing GI used to skip outright.
  const INSTANCES = 20;
  const instGeometry = new THREE.IcosahedronGeometry(0.35, 1);
  const instanced = new THREE.InstancedMesh(
    instGeometry,
    new THREE.MeshStandardNodeMaterial({ color: 0x3f7fb0, roughness: 0.7 }),
    INSTANCES,
  );
  instanced.name = "Scatter";
  const m = new THREE.Matrix4();
  for (let i = 0; i < INSTANCES; i++) {
    m.makeTranslation(-6 + (i % 5) * 3, 1.6 + Math.floor(i / 5) * 0.9, 2 + Math.floor(i / 5) * 0.5);
    instanced.setMatrixAt(i, m);
  }
  instanced.instanceMatrix.needsUpdate = true;
  // A non-identity parent transform: composing world × instance in the wrong
  // order is invisible while the parent is identity.
  instanced.position.set(0.5, 0.25, -0.75);
  instanced.updateMatrixWorld(true);
  engine.scene.add(instanced);

  const lightEntity = engine.createEntity({ name: "Sun" });
  lightEntity.addComponent("light", { kind: "directional", intensity: 4, color: "#ffffff" });
  lightEntity.object3D.position.set(4, 8, 4);

  const giEntity = engine.createEntity({ name: "GI" });
  giEntity.addComponent("global-illumination", { autoFit: true, quality: "medium", intensity: 1 });

  const waitForBuild = async () => {
    let system = null;
    for (let i = 0; i < 90; i++) {
      system = engine.modules?.get("gi")?.system ?? null;
      // Wait for the BAKES too, not just the build: slots seat as their SDFs
      // arrive, so sampling too early sees a half-populated atlas.
      const atlas = system?.state?.atlas;
      if (atlas && atlas.assignments.filter(Boolean).length >= COPIES + INSTANCES) return system;
      await new Promise((r) => setTimeout(r, 500));
    }
    return system;
  };
  const system = await waitForBuild();
  if (!system?.state?.atlas) return { error: "GI never built" };

  const { atlas, volume } = system.state;
  const grid = volume.grid;
  const assignments = atlas.assignments;

  // ---------------------------------------------------------------- tiles
  const seated = assignments.filter(Boolean);
  const bakedSeated = seated.filter((a) => !a.analytic);
  const tileKeys = new Set(bakedSeated.map((a) => a.tileKey));
  // Every instance of one geometry must land on the SAME tile origin.
  const originsByKey = new Map();
  let originMismatch = 0;
  for (let i = 0; i < assignments.length; i++) {
    const a = assignments[i];
    if (!a || a.analytic) continue;
    const o = atlas.tileOrigin.array[i];
    const sig = `${o.x},${o.y},${o.z},${o.w}`;
    const seen = originsByKey.get(a.tileKey);
    if (seen === undefined) originsByKey.set(a.tileKey, sig);
    else if (seen !== sig) originMismatch++;
  }

  // ----------------------------------------------------------- instances
  const instanceSlots = [];
  for (let i = 0; i < assignments.length; i++) {
    if (assignments[i]?.mesh === instanced) instanceSlots.push(i);
  }
  // worldToLocal must invert `mesh.matrixWorld * instanceMatrix[i]`.
  const expected = new THREE.Matrix4();
  const composed = new THREE.Matrix4();
  let transformError = 0;
  for (const slot of instanceSlots) {
    const a = assignments[slot];
    instanced.getMatrixAt(a.instanceId, expected);
    expected.premultiply(instanced.matrixWorld);
    composed.copy(atlas.worldToLocal.array[slot]).invert();
    for (let k = 0; k < 16; k++) {
      transformError = Math.max(transformError, Math.abs(composed.elements[k] - expected.elements[k]));
    }
  }

  // ---------------------------------------------------------------- grid
  // Brute force: at a sample point, which slots does the flat scan consider?
  // Every one of them MUST appear in the grid's list, or the composite would
  // miss geometry there.
  const bounds = volume.bounds;
  const containing = (p) => {
    const out = [];
    for (let i = 0; i < assignments.length; i++) {
      if (!assignments[i]) continue;
      const lo = atlas.aabbMin.array[i];
      const hi = atlas.aabbMax.array[i];
      if (lo.w < 0.5) continue;
      if (p.x > lo.x && p.y > lo.y && p.z > lo.z && p.x < hi.x && p.y < hi.y && p.z < hi.z) out.push(i);
    }
    return out;
  };
  const probes = [];
  let gridMisses = 0;
  let gridScanAll = 0;
  if (grid) {
    const size = new THREE.Vector3().subVectors(bounds.max, bounds.min);
    for (let sx = 1; sx <= 5; sx++) {
      for (let sy = 1; sy <= 3; sy++) {
        for (let sz = 1; sz <= 5; sz++) {
          const p = new THREE.Vector3(
            bounds.min.x + (size.x * sx) / 6,
            bounds.min.y + (size.y * sy) / 4,
            bounds.min.z + (size.z * sz) / 6,
          );
          const listed = grid.candidatesAt(p, bounds);
          if (listed === null) {
            gridScanAll++; // overflowed → the shader scans everything, correct
            continue;
          }
          const need = containing(p);
          const set = new Set(listed);
          const missing = need.filter((s) => !set.has(s));
          if (missing.length) gridMisses++;
          probes.push({ need: need.length, listed: listed.length, missing: missing.length });
        }
      }
    }
  }

  // -------------------------------------------- A/B: field must be identical
  // The strongest check available without pixels: composited occupancy with
  // the grid vs. with the flat scan. Any candidate the grid drops shows up
  // here as fewer occupied cells.
  const renderer = engine.renderer;
  const statsWith = await volume.readbackStats(renderer);
  const occupiedWith = statsWith.occupiedCells;

  globalThis.__giNoInstanceGrid = true;
  system.requestRebuild();
  const rebuilt = await (async () => {
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const s = engine.modules?.get("gi")?.system ?? null;
      const a = s?.state?.atlas;
      if (a && !a.grid && a.assignments.filter(Boolean).length >= COPIES + INSTANCES) return s;
    }
    return null;
  })();
  let occupiedWithout = -1;
  let flatSeated = -1;
  if (rebuilt) {
    occupiedWithout = (await rebuilt.state.volume.readbackStats(renderer)).occupiedCells;
    flatSeated = rebuilt.state.atlas.assignments.filter(Boolean).length;
  }
  delete globalThis.__giNoInstanceGrid;

  return {
    copies: COPIES,
    instances: INSTANCES,
    seated: seated.length,
    bakedSeated: bakedSeated.length,
    uniqueTiles: tileKeys.size,
    tilesLive: atlas._tiles.size,
    tileCapacity: atlas.tileCapacity,
    instanceCapacity: atlas.capacity,
    originMismatch,
    instanceSlots: instanceSlots.length,
    transformError,
    hasGrid: !!grid,
    gridStats: grid ? { ...grid.stats } : null,
    probes: probes.length,
    gridMisses,
    gridScanAll,
    occupiedWith,
    occupiedWithout,
    flatSeated,
  };
});

if (result.error) {
  console.log(`FAIL: ${result.error}`);
  await browser.close();
  process.exit(1);
}

console.log(JSON.stringify(result, null, 2));

const occDelta =
  result.occupiedWithout > 0 ? Math.abs(result.occupiedWith - result.occupiedWithout) / result.occupiedWithout : 1;

const checks = [
  ["every copy + instance seated", result.seated >= result.copies + result.instances],
  [
    `${result.copies} copies + ${result.instances} instances share few tiles`,
    result.uniqueTiles > 0 && result.uniqueTiles <= 4,
  ],
  ["tiles are shared, not per-slot", result.tilesLive < result.bakedSeated],
  ["all instances of a geometry point at one tile", result.originMismatch === 0],
  ["instance slots exceed tile capacity is possible", result.instanceCapacity >= result.tileCapacity],
  ["InstancedMesh contributed one slot per instance", result.instanceSlots === result.instances],
  ["instance world transforms compose correctly", result.transformError < 1e-5],
  ["instance grid is live", result.hasGrid === true],
  ["grid never drops a candidate", result.gridMisses === 0],
  ["grid actually culls", result.gridStats && result.gridStats.listed > 0],
  ["flat-scan build seats the same slots", result.flatSeated >= result.copies + result.instances],
  [`grid field matches flat field (Δ ${(occDelta * 100).toFixed(2)}%)`, occDelta < 0.01],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}`);
  if (!ok) failed++;
}
console.log(failed === 0 ? "GI-IS ALL PASS" : `GI-IS ${failed} FAILED`);
await browser.close();
process.exit(failed === 0 ? 0 : 1);
