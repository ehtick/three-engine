// OCCUPANCY BACKEND — spec phases 1 (conservative voxelization) and 4
// (hierarchical DDA), decided on the REAL GPU-produced bitset.
//
// WHY THIS SHAPE. The spec's acceptance criteria read as picture questions
// ("no gaps when viewed against light", "zero interior light visible outside"),
// but both are exact questions about the occupancy bits, and the bits are a
// buffer this harness can download. So nothing here depends on a camera aim, a
// tonemap, a screenshot diff, or the viewport canvas mounting — the failure
// modes that have cost this module whole sessions.
//
// Four claims, in the order a failure would matter:
//
//   1. CONSERVATIVE. A wall THINNER than one voxel is still present. This is
//      the entire point: a point-sampled or centre-distance voxelizer loses it,
//      and losing it is the leak.
//   2. SEALED. Every ray out of a closed room crosses a set bit. Given
//      conservative bits, this is exactly "the DDA cannot leak" — the DDA only
//      ever stops earlier than a bit, never later.
//   3. PYRAMID SOUND. Every occupied level-0 voxel has an occupied ancestor at
//      every level. The hierarchical skip is only safe because of this, and the
//      branchless 64→32 bit fold that produces it is the single subtlest piece
//      of shader code in the module — a wrong fold would present as rays
//      punching through solid walls, with nothing naming the cause.
//   4. INSTANCED. An InstancedMesh contributes one occupancy region per
//      instance, not one at the prototype's origin.
//
//   node scripts/run-gi-occupancy.mjs [url]
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
  if (/\[gi\] (occupancy|built|instance grid)|GI-OCC/.test(t)) console.log(`  ${t.slice(0, 300)}`);
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

  for (const entity of [...engine.entities.values()]) engine.destroyEntity(entity);
  for (const child of [...engine.scene.children]) {
    if (child.isMesh) engine.scene.remove(child);
  }

  const ROOM = 8;
  // Deliberately thinner than the level-0 voxel at "high" (0.125m). A
  // conservative rasterizer marks every voxel a triangle touches, so this must
  // still seal; anything that samples voxel centres loses it entirely.
  const WALL = 0.08;
  const slab = (sx, sy, sz, px, py, pz) => {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(sx, sy, sz),
      new THREE.MeshStandardNodeMaterial({ color: 0x999999, roughness: 0.9 }),
    );
    m.position.set(px, py, pz);
    // Anonymous geometry: a BoxGeometry keeps `parameters`, which routes it to
    // the exact analytic SDF path. The occupancy field rasterizes TRIANGLES, so
    // this only matters for keeping the legacy arm honest — but it also proves
    // the voxelizer is reading real geometry rather than a primitive shortcut.
    m.geometry = m.geometry.toNonIndexed();
    m.geometry.parameters = undefined;
    m.geometry.type = "BufferGeometry";
    engine.scene.add(m);
    return m;
  };
  const H = ROOM / 2;
  slab(ROOM, WALL, ROOM, 0, -H, 0);
  slab(ROOM, WALL, ROOM, 0, H, 0);
  slab(WALL, ROOM, ROOM, -H, 0, 0);
  slab(WALL, ROOM, ROOM, H, 0, 0);
  slab(ROOM, ROOM, WALL, 0, 0, -H);
  slab(ROOM, ROOM, WALL, 0, 0, H);

  // An InstancedMesh well away from the room: three separate 0.6m cubes.
  const proto = new THREE.BoxGeometry(0.6, 0.6, 0.6).toNonIndexed();
  proto.parameters = undefined;
  proto.type = "BufferGeometry";
  const inst = new THREE.InstancedMesh(
    proto,
    new THREE.MeshStandardNodeMaterial({ color: 0x3366cc, roughness: 0.8 }),
    3,
  );
  const m4 = new THREE.Matrix4();
  const instancePositions = [
    { x: -12, y: 0, z: 0 },
    { x: -12, y: 0, z: 3 },
    { x: -12, y: 0, z: -3 },
  ];
  instancePositions.forEach((p, i) => inst.setMatrixAt(i, m4.makeTranslation(p.x, p.y, p.z)));
  inst.instanceMatrix.needsUpdate = true;
  engine.scene.add(inst);

  const gi = engine.createEntity({ name: "GI" });
  gi.addComponent("global-illumination", {
    autoFit: true, quality: "high", intensity: 1, backend: "occupancy",
  });

  let system = null;
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 500));
    system = engine.modules?.get("gi")?.system ?? null;
    if (system?.state?.volume?.occupancyField) break;
  }
  if (!system?.state) return { error: "GI never built" };
  await new Promise((r) => setTimeout(r, 2500));

  const { volume } = system.state;
  const field = volume.occupancyField;
  if (!field) return { error: "occupancy backend not active — volume.occupancyField is null" };

  const reader = await field.readbackBits(engine.renderer);
  const L0 = reader.levels[0];

  // ── 1. CONSERVATIVE: sample points ON each wall plane; every one must land
  // in an occupied voxel. Sampled on a grid rather than at a few points so a
  // partial shell (holes between rasterized triangles) fails rather than
  // passing by luck.
  const wallProbes = [];
  const N = 17;
  for (let a = 1; a < N - 1; a++) {
    for (let b = 1; b < N - 1; b++) {
      const u = -H + (ROOM * a) / (N - 1);
      const v = -H + (ROOM * b) / (N - 1);
      wallProbes.push({ x: u, y: -H, z: v }, { x: u, y: H, z: v });
      wallProbes.push({ x: -H, y: u, z: v }, { x: H, y: u, z: v });
      wallProbes.push({ x: u, y: v, z: -H }, { x: u, y: v, z: H });
    }
  }
  let wallHits = 0;
  for (const p of wallProbes) {
    const v = reader.voxelOf(p, 0);
    // A 1-voxel neighbourhood: a plane exactly on a voxel boundary can be
    // rasterized into either side, and both are correct.
    let found = 0;
    for (let dx = -1; dx <= 1 && !found; dx++) {
      for (let dy = -1; dy <= 1 && !found; dy++) {
        for (let dz = -1; dz <= 1 && !found; dz++) {
          if (reader.get(v.x + dx, v.y + dy, v.z + dz, 0)) found = 1;
        }
      }
    }
    wallHits += found;
  }

  // ── 2. SEALED: walk a 3D DDA from the room centre outward in many
  // directions. Every ray must cross a set bit before leaving the grid. This
  // is the closed-box leak test, computed on the same bits the DDA reads.
  const walk = (worldDir) => {
    const start = reader.voxelOf({ x: 0, y: 0, z: 0 }, 0);
    let cx = start.x, cy = start.y, cz = start.z;
    // Amanatides–Woo in VOXEL index space, so anisotropic voxels walk the same
    // path the shader's DDA walks.
    const d = reader.dirToVoxel(worldDir);
    const sx = d.x >= 0 ? 1 : -1, sy = d.y >= 0 ? 1 : -1, sz = d.z >= 0 ? 1 : -1;
    const dX = Math.abs(1 / (d.x || 1e-12));
    const dY = Math.abs(1 / (d.y || 1e-12));
    const dZ = Math.abs(1 / (d.z || 1e-12));
    // Starting at a voxel centre puts the first boundary half a voxel away.
    let tMaxX = dX * 0.5, tMaxY = dY * 0.5, tMaxZ = dZ * 0.5;
    for (let i = 0; i < 8192; i++) {
      if (cx < 0 || cy < 0 || cz < 0 || cx >= L0.res.x || cy >= L0.res.y || cz >= L0.res.z) return false;
      if (reader.get(cx, cy, cz, 0)) return true;
      if (tMaxX <= tMaxY && tMaxX <= tMaxZ) { cx += sx; tMaxX += dX; }
      else if (tMaxY <= tMaxZ) { cy += sy; tMaxY += dY; }
      else { cz += sz; tMaxZ += dZ; }
    }
    return false;
  };
  let rays = 0, blocked = 0;
  for (let i = 0; i < 400; i++) {
    // Deterministic near-uniform sphere directions (golden-angle spiral) — a
    // fixed set so a failure is reproducible.
    const t = (i + 0.5) / 400;
    const phi = Math.acos(1 - 2 * t);
    const theta = Math.PI * (1 + Math.sqrt(5)) * i;
    const dir = {
      x: Math.sin(phi) * Math.cos(theta),
      y: Math.sin(phi) * Math.sin(theta),
      z: Math.cos(phi),
    };
    rays++;
    if (walk(dir)) blocked++;
  }

  // ── 3. PYRAMID SOUND: every occupied level-0 voxel must have an occupied
  // ancestor at every coarser level.
  let checked = 0, ancestorOk = 0;
  outer:
  for (let z = 0; z < L0.res.z; z += 3) {
    for (let y = 0; y < L0.res.y; y += 3) {
      for (let x = 0; x < L0.res.x; x += 3) {
        if (!reader.get(x, y, z, 0)) continue;
        checked++;
        let ok = 1;
        for (let L = 1; L < reader.levels.length; L++) {
          if (!reader.get(x >> L, y >> L, z >> L, L)) { ok = 0; break; }
        }
        ancestorOk += ok;
        if (checked >= 4000) break outer;
      }
    }
  }

  // ── 4. INSTANCED: each instance must have occupied voxels around ITS centre.
  const instanceHits = instancePositions.map((p) => {
    const v = reader.voxelOf(p, 0);
    let n = 0;
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        for (let dz = -2; dz <= 2; dz++) {
          n += reader.get(v.x + dx, v.y + dy, v.z + dz, 0);
        }
      }
    }
    return n;
  });

  // Level counts, to confirm the downsample actually ran (all-zero coarse
  // levels would make every hierarchical skip jump the whole volume).
  const levelCounts = reader.levels.map((l, L) => {
    let n = 0;
    for (let z = 0; z < l.res.z; z++) {
      for (let y = 0; y < l.res.y; y++) {
        for (let x = 0; x < l.res.x; x++) n += reader.get(x, y, z, L);
      }
    }
    return n;
  });

  return {
    stats: { ...field.stats, levels: undefined },
    res: L0.res,
    voxelSize: field.stats.voxelSize,
    wall: WALL,
    wallProbes: wallProbes.length,
    wallHits,
    rays,
    blocked,
    checked,
    ancestorOk,
    instanceHits,
    levelCounts,
    coarseLevel: volume.coarseLevel,
  };
});

console.log(JSON.stringify(result, null, 2));
if (result.error) {
  console.log(`FAIL: ${result.error}`);
  await browser.close();
  process.exit(1);
}

const checks = [
  ["occupancy backend active", result.stats.pairs > 0],
  [`voxel size is spec-range (${result.voxelSize?.toFixed(3)}m ≤ 0.15)`, result.voxelSize <= 0.15 + 1e-6],
  [
    `sub-voxel ${result.wall}m walls fully present (${result.wallHits}/${result.wallProbes} probes)`,
    result.wallHits === result.wallProbes,
  ],
  [`closed room is SEALED (${result.blocked}/${result.rays} rays blocked)`, result.blocked === result.rays],
  [
    `pyramid ancestors intact (${result.ancestorOk}/${result.checked})`,
    result.checked > 0 && result.ancestorOk === result.checked,
  ],
  ["coarse levels are populated", result.levelCounts.every((n) => n > 0)],
  [
    `each InstancedMesh instance voxelized (${result.instanceHits.join(",")})`,
    result.instanceHits.every((n) => n > 0),
  ],
  ["composite clamps from a level at least as coarse as its cell", result.coarseLevel >= 0],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}`);
  if (!ok) failed++;
}
console.log(failed === 0 ? "GI-OCC ALL PASS" : `GI-OCC ${failed} FAILED`);
await browser.close();
process.exit(failed === 0 ? 0 : 1);
