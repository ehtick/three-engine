// LATTICE ARTIFACT harness — the "dotted grid / quilted pattern on flat walls"
// the user reported at ultra (screenshot 2026-07-27).
//
// Loads the user's real project (same loader as run-gi-rc-testproject), then
// aims the viewport camera SQUARE AT THE BACK WALL from a fixed world position
// so the sampled wall patch lands on the same pixels at every quality preset.
// Reports, for a clean patch of that wall:
//   • bandRMS  — high-pass residual (box r=2 minus box r=14, RMS). This is the
//     metric session 7f established: |d2| is dominated by the true 1/r²
//     gradient's curvature and measured NOTHING, a high-pass residual
//     separates steps from gradient. Higher = more visible lattice.
//   • period   — autocorrelation peak of that residual, in WORLD METRES (the
//     wall's px/m comes from projecting two known world points, and profiles
//     are resampled to a fixed samples-per-metre first, because the editor
//     dock gives the viewport a different height from run to run).
//     THIS IS WHAT NAMED THE BUG: the period came out at 1.00m while c0 probe
//     spacing at ultra is 0.50m. Exactly 2x = the PARENT cascade's lattice,
//     which pointed straight at the c0<-c1 merge rather than at the probe
//     lattice or the final gather.
//
// RESULT (2026-07-27, user's scene, ultra, interleaved): HARDMERGE=1
// bandRMS 0.678/0.679 period 1.00m  ->  fixed 0.223/0.399 period 0.47m, wall
// brightness unchanged (165.1 -> 167.1), GPU unchanged (7.43 -> 7.06ms).
//
// Env: QUALITY, PROJECT, SCENE, PERF=1, GIOFF=1, TAG=<name>, and the A/Bs:
//   HARDMERGE=1  restore the old binary merge-visibility cut (reproduces the
//                artifact — this is the switch that identified it)
//   MERGETOL=<n> merge-visibility fade tolerance in field voxels (default 1.75)
//   NOVIS/NOPLANE/NOANGLE  drop the final gather's probe rejection terms
//                (all three measured INNOCENT — NOVIS was byte-identical)
//   WHOCLEARS=1  stack-probe engine.clear() + dump entities at sample time,
//                for when a run renders an unexpectedly empty/dark viewport
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

const url = process.argv[2] ?? "http://localhost:5233/";
const PROJECT = process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/Test";
const SCENE = process.env.SCENE ?? "Untitled.scene";

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const scene = readJson(path.join(PROJECT, "scenes", SCENE));

const materials = {};
const resolveMat = (ref) => {
  if (!ref) return;
  const normalized = ref.replace(/\\/g, "/");
  if (materials[ref] !== undefined) return;
  const candidates = [normalized, path.join(PROJECT, path.basename(normalized))];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      materials[ref] = readJson(candidate);
      return;
    }
  }
  materials[ref] = null;
};
const walk = (entities) => {
  for (const entity of entities ?? []) {
    for (const component of entity.components ?? []) {
      if (component.type === "mesh") {
        for (let i = 1; i <= 8; i++) resolveMat(component.props[i === 1 ? "material" : `material${i}`]);
      }
    }
    walk(entity.children);
  }
};
walk(scene.entities);

const overrides = { quality: process.env.QUALITY ?? null, giOff: !!process.env.GIOFF };
// Shader A/B flags, set on globalThis BEFORE the GI module builds its graphs.
const flags = {
  __giNoVisProxy: !!process.env.NOVIS,
  __giNoPlaneCut: !!process.env.NOPLANE,
  __giNoAngleCut: !!process.env.NOANGLE,
  __giHardMergeVis: !!process.env.HARDMERGE,
  __giMergeVisTol: process.env.MERGETOL ? Number(process.env.MERGETOL) : 0,
};

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1800, height: 1100, deviceScaleFactor: 1 });
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\]|GI-LAT/.test(t)) console.log(`  ${t}`);
  if (m.type() === "error") console.log(`error: ${t}`);
});
page.on("pageerror", (e) => console.log(`pageerror: ${e.stack ?? e.message}`));

await page.goto(url, { waitUntil: "load", timeout: 30000 });
for (let i = 0; i < 40; i++) {
  const ready = await page.evaluate(() => {
    if (globalThis.__viewport?.orbit) return true;
    [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
    return !!globalThis.__viewport?.orbit;
  });
  if (ready) break;
  await new Promise((r) => setTimeout(r, 500));
}
await new Promise((r) => setTimeout(r, 4000));

// WHOCLEARS=1: name whatever wipes the harness-built scene (stack-stashing
// probe, the same trick that cracked the resize bug in session 8).
if (process.env.WHOCLEARS) {
  await page.evaluate(async () => {
    const { ensureEngine } = await import("/src/editor/engineInstance.js");
    const engine = await ensureEngine();
    const clear = engine.clear.bind(engine);
    engine.clear = function (...args) {
      console.log(`GI-LAT engine.clear() from\n${new Error().stack}`);
      return clear(...args);
    };
  });
}
await page.evaluate((f) => Object.assign(globalThis, f), flags);

// The dock finishes laying out asynchronously, and the viewport canvas's
// HEIGHT is what sets both px/m and the pixel count the resolve pays for — so
// a run that samples before the layout settles is not comparable to one that
// samples after. Wait for two identical reads.
const readClip = () =>
  page.evaluate(() => {
    const c = [...document.querySelectorAll("canvas")]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height)[0];
    return c ? { x: c.r.x, y: c.r.y, width: Math.round(c.r.width), height: Math.round(c.r.height) } : null;
  });
let clip = null;
for (let i = 0; i < 20; i++) {
  const next = await readClip();
  if (next && clip && next.width === clip.width && next.height === clip.height) { clip = next; break; }
  clip = next;
  await new Promise((r) => setTimeout(r, 700));
}
if (!clip) throw new Error("no viewport canvas");


const built = await page.evaluate(async ({ scene, materials, overrides }) => {
  const { THREE } = await import("/src/engine/index.js");
  await import("/src/modules/index.js");
  const { enableEngineModule } = await import("/src/engine/modules.js");
  const { ensureEngine } = await import("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  await enableEngineModule(engine, "gi");
  globalThis.__engine = engine;
  globalThis.__THREE = THREE;

  const geometryFor = (kind) =>
    ({
      plane: () => new THREE.PlaneGeometry(1, 1),
      box: () => new THREE.BoxGeometry(1, 1, 1),
      sphere: () => new THREE.SphereGeometry(0.5, 32, 16),
      cylinder: () => new THREE.CylinderGeometry(0.5, 0.5, 1, 32),
      torus: () => new THREE.TorusGeometry(0.5, 0.2, 16, 48),
    })[kind]?.() ?? new THREE.BoxGeometry(1, 1, 1);

  const { compileShaderGraph } = await import("/src/engine/tslGraph.js");
  const { applyGraphMutations, MATERIAL_DEFAULTS } = await import("/src/engine/materialAsset.js");
  const materialFor = async (ref) => {
    const def = materials[ref] ?? null;
    const m = new THREE.MeshPhysicalNodeMaterial();
    m.side = THREE.DoubleSide;
    m.color.set(def?.color ?? MATERIAL_DEFAULTS.color);
    m.roughness = def?.roughness ?? MATERIAL_DEFAULTS.roughness;
    m.metalness = def?.metalness ?? MATERIAL_DEFAULTS.metalness;
    if (def?.shaderGraph) {
      const result = await compileShaderGraph(def.shaderGraph);
      if (result) applyGraphMutations(m, result, false);
    }
    m.needsUpdate = true;
    return m;
  };

  const info = { giProps: null, meshes: [] };
  const build = async (def, parentObject) => {
    const entity = engine.createEntity({ name: def.name });
    const object = entity.object3D;
    object.position.set(...def.position);
    object.rotation.set(...def.rotation);
    object.scale.set(...def.scale);
    if (parentObject) parentObject.add(object);
    for (const component of def.components ?? []) {
      if (component.type === "mesh") {
        const mesh = new THREE.Mesh(geometryFor(component.props.geometry), await materialFor(component.props.material));
        mesh.name = def.name;
        object.add(mesh);
        info.meshes.push({ name: def.name, mesh });
      } else if (component.type === "global-illumination") {
        info.giProps = { ...component.props };
        info.giEntity = entity;
      }
    }
    for (const child of def.children ?? []) await build(child, object);
    return entity;
  };
  for (const def of scene.entities) await build(def, null);
  // DETERMINISTIC LIGHTING. Depending on how the editor's async boot races the
  // harness, the scene may or may not still carry the default "Directional
  // Light" newScene() drops in — and with it the wall is sunlit, without it the
  // room is lit only by the emissive lamp (which is what the user actually
  // sees). Same run, wildly different luminance. Always remove it.
  for (const entity of [...engine.entities.values()]) {
    if (entity.name === "Directional Light") engine.destroyEntity(entity);
  }

  const props = { ...info.giProps };
  if (overrides.quality) props.quality = overrides.quality;
  // GIOFF=1 leaves the component off entirely — the GPU baseline the preset
  // costs are measured against.
  if (!overrides.giOff) globalThis.__gi = info.giEntity.addComponent("global-illumination", props);
  engine.scene.updateMatrixWorld(true);

  const box = new THREE.Box3();
  for (const { mesh } of info.meshes) box.expandByObject(mesh);
  const worldOf = (name) => {
    const hit = info.meshes.find((m) => m.name === name);
    if (!hit) return null;
    hit.mesh.geometry.computeBoundingSphere();
    return hit.mesh.geometry.boundingSphere.center.clone().applyMatrix4(hit.mesh.matrixWorld).toArray();
  };
  console.log(`GI-LAT ready quality=${props.quality}`);
  return { props, contentMin: box.min.toArray(), contentMax: box.max.toArray(), lamp: worldOf("Light") };
}, { scene, materials, overrides });

for (let i = 0; i < 120; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  if (!(await page.evaluate(() => globalThis.__engine?.renderSuspended === true))) break;
}
await new Promise((r) => setTimeout(r, 4000));

// FIXED camera: square on the back wall, inside the room. Identical for every
// preset so the sampled patch is the same pixels — quality must be the only
// variable in an A/B.
const [minX, minY, minZ] = built.contentMin;
const [maxX, maxY] = built.contentMax;
const wallZ = minZ + 0.02;
const cx = (minX + maxX) / 2;
const cy = (minY + maxY) / 2;
console.log(`  content ${built.contentMin.map((v)=>v.toFixed(1))} .. ${built.contentMax.map((v)=>v.toFixed(1))}`);
// Stand LEFT OF CENTRE, under the lamp, 9m off the wall: dead centre puts the
// scene's box (which the user has moved and rescaled more than once) right in
// front of the lens, and a dark box filling the frame reads as "GI produced
// nothing". Left of centre is also the brightest part of the back wall in an
// emissive-only room, which is where the lattice is visible at all — the same
// region as the user's screenshot.
const aimX = cx - 5;
const aimY = cy + 2;
const target = [aimX, aimY, wallZ];
const eye = [aimX, aimY, wallZ + 9];
// VERIFY THE AIM. OrbitControls owns the camera every frame, and a silently
// missed aim renders some other part of the room — which reads as "GI produced
// nothing" (a flat wall) rather than as an error. Re-aim until it sticks.
let aimed = null;
for (let attempt = 0; attempt < 6; attempt++) {
  aimed = await page.evaluate(({ eye, target }) => {
    const engine = globalThis.__engine;
    const viewport = globalThis.__viewport;
    if (!engine?.camera || !viewport?.orbit) return null;
    viewport.orbit.target.set(...target);
    engine.camera.position.set(...eye);
    engine.camera.lookAt(...target);
    viewport.orbit.update();
    engine.camera.updateMatrixWorld(true);
    engine.camera.layers.disable(31);
    return { position: engine.camera.position.toArray(), target: viewport.orbit.target.toArray() };
  }, { eye, target });
  const off = aimed && Math.hypot(...aimed.position.map((v, i) => v - eye[i]));
  if (off != null && off < 0.05) break;
  await new Promise((r) => setTimeout(r, 800));
}
if (!aimed) throw new Error("no viewport camera to aim");
if (process.env.WHOCLEARS) {
  const state = await page.evaluate(() => {
    const engine = globalThis.__engine;
    return {
      entities: [...engine.entities.values()].map((e) => e.name),
      camera: engine.camera.position.toArray().map((v) => Number(v.toFixed(2))),
      sameEngine: globalThis.__engine === engine,
      giAttached: !!globalThis.__gi,
    };
  });
  console.log(`  GI-LAT state: cam ${state.camera} entities ${JSON.stringify(state.entities)}`);
}
const aimError = Math.hypot(...aimed.position.map((v, i) => v - eye[i]));
if (aimError > 0.05) throw new Error(`camera aim did not stick (off by ${aimError.toFixed(2)}m) — rerun`);
await new Promise((r) => setTimeout(r, 1500));

const project = (points) =>
  page.evaluate((pts) => {
    const engine = globalThis.__engine;
    const THREE = globalThis.__THREE;
    const camera = engine.camera;
    camera.updateMatrixWorld(true);
    return pts.map(([x, y, z]) => {
      const v = new THREE.Vector3(x, y, z).project(camera);
      return [(v.x + 1) / 2, (1 - v.y) / 2];
    });
  }, points);

// Wall patch: LEFT-OF-CENTRE and LOW — clear of the lamp (upper left, but it
// sits 10m in front of the wall) and of the 12m box (right of centre).
// Upper-left of the back wall: the lamp hangs there, so this is where the
// indirect falloff is bright enough for the lattice to show — and it is the
// same region as the user's screenshot. Low on the wall the emissive-only
// scene is near-black and nothing is measurable.
const patchWorld = {
  x0: aimX - 2.5, x1: aimX + 2.5,
  y0: aimY - 2.0, y1: aimY + 2.0,
};
const [pA, pB] = await project([
  [patchWorld.x0, patchWorld.y0, wallZ],
  [patchWorld.x1, patchWorld.y1, wallZ],
]);
const shot = await page.screenshot({ clip });
const { default: sharp } = await import("sharp");
const { data, info } = await sharp(shot).raw().toBuffer({ resolveWithObject: true });
const W = info.width, H = info.height, C = info.channels;
const lumAt = (x, y) => {
  const i = (Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))) * C;
  return 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
};
const px0 = Math.round(Math.min(pA[0], pB[0]) * W);
const px1 = Math.round(Math.max(pA[0], pB[0]) * W);
const py0 = Math.round(Math.min(pA[1], pB[1]) * H);
const py1 = Math.round(Math.max(pA[1], pB[1]) * H);
// px per world metre on that wall (used to convert the period to metres).
const pxPerMetre = (px1 - px0) / (patchWorld.x1 - patchWorld.x0);

const box1d = (arr, r) =>
  arr.map((_, i) => {
    let s = 0, n = 0;
    for (let k = -r; k <= r; k++) {
      const j = i + k;
      if (j >= 0 && j < arr.length) { s += arr[j]; n++; }
    }
    return s / n;
  });

// The editor's dock gives the viewport a different HEIGHT from run to run, so
// px/m is not constant across runs and a pixel-radius high-pass would measure
// different world scales each time. Resample every profile onto a fixed
// SAMPLES-PER-METRE grid first, and express the filter radii in metres.
const SAMPLES_PER_M = 32;
const resample = (profile, pxPerM) => {
  const out = [];
  const n = Math.floor((profile.length / pxPerM) * SAMPLES_PER_M);
  for (let i = 0; i < n; i++) {
    const t = (i / SAMPLES_PER_M) * pxPerM;
    const a = Math.floor(t);
    const f = t - a;
    out.push(profile[a] * (1 - f) + profile[Math.min(profile.length - 1, a + 1)] * f);
  }
  return out;
};

const analyse = (raw, pxPerM) => {
  const profile = resample(raw, pxPerM);
  const fine = box1d(profile, Math.round(0.06 * SAMPLES_PER_M));
  const coarse = box1d(profile, Math.round(0.43 * SAMPLES_PER_M));
  const hp = fine.map((v, i) => v - coarse[i]);
  const rms = Math.sqrt(hp.reduce((a, b) => a + b * b, 0) / hp.length);
  const mean = hp.reduce((a, b) => a + b, 0) / hp.length;
  const ac = [];
  for (let lag = 1; lag < Math.min(3 * SAMPLES_PER_M, Math.floor(hp.length / 2)); lag++) {
    let s = 0;
    for (let i = 0; i + lag < hp.length; i++) s += (hp[i] - mean) * (hp[i + lag] - mean);
    ac.push([lag, s / (hp.length - lag)]);
  }
  // First interior local maximum with positive correlation = the period.
  let period = null;
  for (let i = 1; i < ac.length - 1; i++) {
    if (ac[i][1] > 0 && ac[i][1] > ac[i - 1][1] && ac[i][1] >= ac[i + 1][1] && ac[i][0] >= 0.1 * SAMPLES_PER_M) {
      period = ac[i][0] / SAMPLES_PER_M; // metres
      break;
    }
  }
  return { rms, period };
};

// Column profile (average each image column over the patch rows) → horizontal
// period; row profile → vertical period. Averaging along the other axis is
// what lifts a ~0.5/255 lattice out of the dither.
const cols = [];
for (let x = px0; x < px1; x++) {
  let s = 0;
  for (let y = py0; y < py1; y++) s += lumAt(x, y);
  cols.push(s / (py1 - py0));
}
const rows = [];
for (let y = py0; y < py1; y++) {
  let s = 0;
  for (let x = px0; x < px1; x++) s += lumAt(x, y);
  rows.push(s / (px1 - px0));
}
// SANITY GATE. Vite's HMR occasionally remounts the editor's React root
// mid-run (console shows "createRoot() on a container that has already been
// passed to createRoot()"); the viewport that comes back has no GI resolve on
// it, and the wall renders as FLAT AMBIENT — mean L ~70 with no gradient at
// all, versus ~130 with a real falloff. That reads as "the preset produced
// nothing" instead of as a failure, so refuse to report it.
if (!overrides.giOff) {
  const span = Math.max(...cols) - Math.min(...cols);
  const mean = cols.reduce((a, b) => a + b, 0) / cols.length;
  if (mean < 20 || span < 3) {
    console.log(`  GI-LAT FLAT PATCH (L span ${span.toFixed(1)}, mean ${(cols.reduce((a, b) => a + b, 0) / cols.length).toFixed(1)})`);
    await page.screenshot({ path: `scripts/gi-diag-lattice-FLAT.png`, clip });
    throw new Error("the wall has no GI gradient — editor remounted mid-run, rerun");
  }
}
const h = analyse(cols, pxPerMetre);
const v = analyse(rows, pxPerMetre);
const patchMean = cols.reduce((a, b) => a + b, 0) / cols.length;

let perf = null;
if (process.env.PERF) {
  perf = await page.evaluate(async () => {
    const engine = globalThis.__engine;
    const gpu = [];
    const deltas = [];
    await new Promise((resolve) => {
      let last = performance.now();
      const start = last;
      const step = (now) => {
        deltas.push(now - last);
        last = now;
        const g = engine.stats?.readout?.gpuMs ?? 0;
        if (g > 0) gpu.push(g);
        if (now - start < 5000) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
    const pick = (a, q) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length * q)] : null);
    return { frame: pick(deltas, 0.5), gpu: pick(gpu, 0.5), gpuP95: pick(gpu, 0.95) };
  });
}

const tag = process.env.TAG ?? `q-${built.props.quality}`;
await page.screenshot({ path: `scripts/gi-diag-lattice-${tag}.png`, clip });

const flagsOn =
  Object.entries(flags).filter(([, on]) => on).map(([k, v]) => `${k.replace("__gi", "")}${v === true ? "" : `=${v}`}`).join(",") ||
  "none";
console.log("");
console.log(`--- LATTICE (${tag}) quality=${built.props.quality} flags=${flagsOn} ---`);
console.log(`  canvas ${clip.width}x${clip.height}  patch ${px1 - px0}x${py1 - py0}px  ${pxPerMetre.toFixed(1)} px/m  mean L ${patchMean.toFixed(1)}`);
console.log(`  horizontal: bandRMS ${h.rms.toFixed(3)}  period ${h.period ? h.period.toFixed(2) + "m" : "-"}`);
console.log(`  vertical:   bandRMS ${v.rms.toFixed(3)}  period ${v.period ? v.period.toFixed(2) + "m" : "-"}`);
if (perf) {
  const mpx = (clip.width * clip.height) / 1e6;
  console.log(`  perf: frame ${perf.frame?.toFixed(1)}ms  GPU ${perf.gpu?.toFixed(2)}ms (p95 ${perf.gpuP95?.toFixed(2)})  = ${(perf.gpu / mpx).toFixed(2)}ms/Mpx over ${mpx.toFixed(2)}Mpx`);
}
console.log(`  SHOT scripts/gi-diag-lattice-${tag}.png`);

await browser.close();
process.exit(0);
