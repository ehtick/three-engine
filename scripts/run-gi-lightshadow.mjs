// GI-TRACED DIRECT SHADOWS — end-to-end instrument.
//
// REQUIRES AN EXCLUSIVE GPU AND VITE ON 5201. It opens the real project through
// the editor's own path, so nothing else may be driving the adapter while it
// runs.
//
//   node node_modules/vite/bin/vite.js --port 5201 --strictPort
//   node scripts/run-gi-lightshadow.mjs
//
// WHAT IT PROVES, and why each check exists:
//   A. The sun's live three.js light really carries a custom
//      `shadow.shadowNode`, it is THE GI SYSTEM'S node (identity-checked
//      against the system's own map, not merely "some node"), and it is not a
//      CSMShadowNode. Without this the feature silently degrades to shadow
//      maps and every downstream image still looks plausible.
//   B. The resolve owns a `lightShadow` target and the sun claimed a channel.
//   C. The channel actually contains a SHADOW PATTERN. A GPU accumulator reads
//      the sun's channel over a pixel grid and the mean must land strictly
//      inside (0.02, 0.98): all-white means the march never blocked (the
//      fail-open / exhausted-budget bug — see #buildLightShadow's step table),
//      all-black means it blocked everywhere (a self-shadowing lift bug — see
//      the resolve's 1.5-voxel lift note). Both failure modes are invisible to
//      a "does the texture exist" check, which is why the mean is the assertion.
//   D. The scene is left exactly as it was found (shadowMode restored).
//
// Env:
//   PROJECT=<path>   default C:/Users/Khudiiash/Documents/GAME
//   HEADED=1
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
await installTauriShim(page, {});

let built = false;
page.on("console", (m) => {
  const t = m.text();
  // `[gi] light shadows:` is the ground-truth line for this feature — without
  // it a failure below cannot be told apart from "the build declined it".
  if (/\[gi\] built|\[gi\] light shadows|\[gi\] occupancy backend|\[gi\] ray-hit|compile wave/.test(t)) console.log(`  ${t.slice(0, 180)}`);
  if (/\[gi\] built/.test(t)) built = true;
  if (m.type() === "error" && !/favicon|404/.test(t)) console.log(`  console.error: ${t.slice(0, 250)}`);
});
page.on("pageerror", (e) => {
  const msg = e.stack ?? e.message ?? String(e);
  if (!/save_scene/.test(msg)) console.log(`  pageerror: ${msg.slice(0, 600)}`);
});

await page.evaluateOnNewDocument((PROJECT) => {
  localStorage.setItem("engine.projectRoot.v1", PROJECT);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([PROJECT]));
}, PROJECT);

await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, PROJECT);
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 150000 });

// The editor's React tree remounts unpredictably after boot/rebuild waves
// (double-createRoot → removeChild → __editorApi gone for a stretch) — every
// api touch waits it out and retries, same armor run-gi-spawn-blink.mjs wears.
const call = async (op, args = {}) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.waitForFunction(() => !!globalThis.__editorApi?.entities, { timeout: 120000 }).catch(() => {});
    try {
      return await page.evaluate(async ({ op, args }) => {
        try { return { ok: true, value: await globalThis.__editorApi.call(op, args) }; }
        catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
      }, { op, args });
    } catch (err) {
      if (attempt === 2) return { ok: false, error: err?.message ?? String(err) };
      await wait(4000);
    }
  }
};

let entities = [];
for (let i = 0; i < 120; i++) {
  const r = await call("entity.list", {});
  if (r.ok && Array.isArray(r.value) && r.value.length > 0) { entities = r.value; break; }
  await wait(1000);
}
const componentOf = (e, type) => (e.components ?? []).find((c) => c.type === type);
const giCandidates = entities.filter((e) => componentOf(e, "global-illumination"));
const giEntity = giCandidates.find((e) => componentOf(e, "global-illumination")?.props?.enabled !== false) ?? giCandidates[0];
if (!giEntity) { console.log("FATAL: gi entity missing"); await browser.close(); process.exit(1); }
// The SUN: a directional light component. Prefer one already casting shadows —
// `shadowMode` only exists on a shadow caster.
const sunEntity =
  entities.find((e) => componentOf(e, "light")?.props?.kind === "directional" && componentOf(e, "light")?.props?.castShadow) ??
  entities.find((e) => componentOf(e, "light")?.props?.kind === "directional");
if (!sunEntity) { console.log("FATAL: no directional light in the scene"); await browser.close(); process.exit(1); }
const sunProps = componentOf(sunEntity, "light").props ?? {};
const originalShadowMode = sunProps.shadowMode ?? "map";
const originalCastShadow = sunProps.castShadow !== false;
console.log(`  sun: "${sunEntity.name}" (shadowMode ${originalShadowMode}, castShadow ${originalCastShadow})`);

// Converge fully before touching anything: built + the editor settle.
for (let i = 0; i < 120 && !built; i++) await wait(1000);
await wait(12000);

const setProp = (key, value) =>
  call("component.setProp", { id: sunEntity.id, type: "light", key, value });

const restore = async () => {
  await setProp("shadowMode", originalShadowMode);
  await setProp("sourceAngle", sunProps.sourceAngle ?? 0.53);
  if (!originalCastShadow) await setProp("castShadow", false);
  if (process.env.EMISSIVE_OFF) {
    await call("component.setProp", {
      id: giEntity.id, type: "global-illumination", key: "emissiveShadows", value: originalEmissive,
    });
  }
  if (process.env.RAYHIT_MODE) {
    await call("component.setProp", {
      id: giEntity.id, type: "global-illumination", key: "rayHitMode", value: originalRayHitMode,
    });
  }
  if (process.env.SKIP != null) {
    await call("component.setProp", {
      id: giEntity.id, type: "global-illumination", key: "rayHitSkipDistance", value: originalSkip,
    });
  }
};

// SKIP=1|0 — force the Phase-5 coarse ride regardless of the saved prop (the
// ride's budget-exhaustion bug was only visible with it ON, and the scene may
// be saved with it OFF from the user's own A/B). MUST flip BEFORE shadowMode:
// it is structural, and a second compile wave after the claim left the field
// mid-convergence at measurement (control 2.51 → 0.46, mean check false-FAIL).
const giProps = componentOf(giEntity, "global-illumination")?.props ?? {};
const originalSkip = giProps.rayHitSkipDistance !== false;
if (process.env.SKIP != null) {
  const want = process.env.SKIP === "1";
  const r = await call("component.setProp", {
    id: giEntity.id, type: "global-illumination", key: "rayHitSkipDistance", value: want,
  });
  console.log(r.ok ? `  rayHitSkipDistance -> ${want}` : `  rayHitSkipDistance set failed: ${r.error}`);
  await wait(20000);
}

// STEPS=<n> — override the light-shadow DDA step budget (__giDirectShadowSteps,
// read at resolve build time, i.e. after the flip below). The discriminator
// arm for residual specks: if they vanish at 256 steps they are legacy-DDA
// budget exhaustion failing open (level>0), not voxelization holes. In-page
// only; the page dies at exit, nothing to restore.
if (process.env.STEPS) {
  await page.evaluate((n) => { globalThis.__giDirectShadowSteps = n; }, Number(process.env.STEPS));
  console.log(`  __giDirectShadowSteps -> ${process.env.STEPS}`);
}

// KIND=1 — verdict-kind map arm: the shadow channel paints which acceptance
// class decided each pixel (miss=white, plane=0.75, triangle=0.5, box=0.25,
// budget-clamp=black). Must be set before the flip builds the resolve.
if (process.env.KIND) {
  await page.evaluate(() => { globalThis.__giShadowKindDebug = true; });
  console.log("  verdict-kind map ON");
}

// castShadow first: three only compiles a shadow branch for a shadow-casting
// light, so `shadowMode: "gi"` on a non-caster is inert by construction.
if (!originalCastShadow) {
  const r = await setProp("castShadow", true);
  if (!r.ok) console.log(`  castShadow set failed: ${r.error}`);
}
const flip = await setProp("shadowMode", "gi");
console.log(flip.ok ? "  shadowMode -> gi" : `  FATAL: shadowMode set failed (${flip.error})`);
if (!flip.ok) { await browser.close(); process.exit(1); }

// EMISSIVE_OFF=1 — the DECOUPLING arm: gi light shadows used to REQUIRE
// Emissive Shadows (the sphere marcher could only share the emitter trace's
// bindings). The DDA arm binds only the occupancy bits buffer, so it must
// survive emissiveShadows=false. A dropped compute batch (the failure this
// arm exists to catch) collapses the irradiance CONTROL, so the existing
// checks already judge it.
const originalEmissive = giProps.emissiveShadows !== false;
// RAYHIT_MODE=<mode|auto> — run the measurement under a different ray-hit
// mode (the shadow DDA resolves hits through it, so "square shadows" on
// brick-box vs smooth silhouettes on plane-coverage is directly visible in
// the screenshot). Restored after.
const originalRayHitMode = giProps.rayHitMode ?? "auto";
if (process.env.RAYHIT_MODE) {
  const r = await call("component.setProp", {
    id: giEntity.id, type: "global-illumination", key: "rayHitMode", value: process.env.RAYHIT_MODE,
  });
  console.log(r.ok ? `  rayHitMode -> ${process.env.RAYHIT_MODE}` : `  rayHitMode set failed: ${r.error}`);
  await wait(15000);
}
if (process.env.EMISSIVE_OFF) {
  const r = await call("component.setProp", {
    id: giEntity.id, type: "global-illumination", key: "emissiveShadows", value: false,
  });
  console.log(r.ok ? "  emissiveShadows -> false (decoupling arm)" : `  emissiveShadows set failed: ${r.error}`);
  await wait(15000);
}

// The light is REBUILT by the flip (new three.js instance → new uuid → the
// lights hash changes → materials recompile), and GI only re-scans the light
// list on its fingerprint cadence. Give both room, plus a compile wave.
await wait(15000);

// SURFACE-RECORD POOL AUDIT — the record march is only as real as its pool:
// a brick that fails its claim silently keeps occupied-box semantics, and at
// scene scale a capped pool degrades MOST cells that way (full-voxel square
// silhouettes with `marcher records` proudly in the log).
const alloc = await page.evaluate(async (anchorId) => {
  const engine = globalThis.__editorApi?.entities?.live(anchorId)?.engine;
  const occ = engine?.modules?.get?.("gi")?.system?.state?.volume?.occupancyField;
  if (!occ?.readbackSurfaceAlloc) return { error: "no occupancy field / readback" };
  try {
    return await occ.readbackSurfaceAlloc(engine.renderer);
  } catch (e) {
    return { error: e?.stack ?? String(e) };
  }
}, sunEntity.id);
console.log(`  surface records: ${JSON.stringify(alloc)}`);

// A KNOWN sun, not the saved one: the scene ships with the sun aimed so the
// whole interior is legitimately blocked (measured: dark 98%, GI control
// near-black), which collapses the mean check into "is the leak rate under
// 2%". Overhead-ish light puts both shadow states in view. In-memory only —
// the harness never saves the scene, and the page dies at exit.
await page.evaluate((sunId) => {
  const obj = globalThis.__editorApi?.entities?.live(sunId)?.object3D;
  if (!obj) return false;
  obj.rotation.set((-65 * Math.PI) / 180, (30 * Math.PI) / 180, 0);
  obj.updateMatrixWorld(true);
  return true;
}, sunEntity.id);
// FRAME THE SCENE from its own measured bounds — `viewport.focus` proved
// unreliable here (two runs still showed a dark close-up; an unframed
// measurement is unfalsifiable). Bounds are accumulated manually from mesh
// geometry boundingBoxes × matrixWorld: importing three for Box3 inside the
// page would be the duplicate-module trap. An exterior high 3/4 view is the
// clearest single image for "does this read as a shadow": lit roofs, a
// shadow side, and the building's ground shadow all in one frame.
// PER THE USER: frame from THEIR scene Camera entity first — the exact view
// their reports and screenshots come from. Bounds framing is the fallback.
const camEntity = entities.find((e) => componentOf(e, "camera"));
const camPose = camEntity
  ? await page.evaluate(({ camId }) => {
      const obj = globalThis.__editorApi?.entities?.live(camId)?.object3D;
      if (!obj) return null;
      obj.updateWorldMatrix(true, false);
      const e = obj.matrixWorld.elements;
      const pos = [e[12], e[13], e[14]];
      const fwd = [-e[8], -e[9], -e[10]];
      const len = Math.hypot(fwd[0], fwd[1], fwd[2]) || 1;
      return { pos, target: pos.map((v, i) => v + (fwd[i] / len) * 10) };
    }, { camId: camEntity.id })
  : null;
const modelRoot = entities.find((e) => /sponza|scene|level|environment/i.test(e.name ?? "")) ?? giEntity;
const framed = await page.evaluate(({ rootId }) => {
  const api = globalThis.__editorApi;
  const obj = api?.entities?.live(rootId)?.object3D;
  if (!obj) return null;
  obj.updateWorldMatrix(true, true);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  obj.traverse((n) => {
    if (!n.isMesh || !n.geometry) return;
    if (!n.geometry.boundingBox) n.geometry.computeBoundingBox();
    const bb = n.geometry.boundingBox;
    if (!bb) return;
    for (let i = 0; i < 8; i++) {
      const x = i & 1 ? bb.max.x : bb.min.x;
      const y = i & 2 ? bb.max.y : bb.min.y;
      const z = i & 4 ? bb.max.z : bb.min.z;
      const e = n.matrixWorld.elements;
      const wx = e[0] * x + e[4] * y + e[8] * z + e[12];
      const wy = e[1] * x + e[5] * y + e[9] * z + e[13];
      const wz = e[2] * x + e[6] * y + e[10] * z + e[14];
      min[0] = Math.min(min[0], wx); max[0] = Math.max(max[0], wx);
      min[1] = Math.min(min[1], wy); max[1] = Math.max(max[1], wy);
      min[2] = Math.min(min[2], wz); max[2] = Math.max(max[2], wz);
    }
  });
  if (!Number.isFinite(min[0])) return null;
  return { min, max };
}, { rootId: modelRoot.id });
if (camPose) {
  const r = await call("viewport.setCamera", { position: camPose.pos, target: camPose.target });
  console.log(r.ok ? `  camera = scene Camera entity: ${camPose.pos.map((v) => v.toFixed(1))}` : `  setCamera failed: ${r.error}`);
} else if (framed) {
  const c = framed.min.map((v, i) => (v + framed.max[i]) / 2);
  const s = framed.max.map((v, i) => v - framed.min[i]);
  const pos = [c[0] + s[0] * 0.65, framed.max[1] + s[1] * 0.5, c[2] + s[2] * 0.85];
  const r = await call("viewport.setCamera", { position: pos, target: c });
  console.log(r.ok ? `  camera framed: pos ${pos.map((v) => v.toFixed(1))} -> ${c.map((v) => v.toFixed(1))}` : `  setCamera failed: ${r.error}`);
} else {
  console.log("  WARN: no camera entity and no bounds — measuring the saved view");
}
await wait(3000);

// FACEKIND=1 — verdict-kind close-up of the RECEIVING faces of a tilted box:
// the teardrop-row artifact lives on up-facing tilted surfaces, and the class
// tone (miss=white, plane=0.75, triangle=0.5, box=0.25, clamp=black) is the
// attribution the shadow render cannot give. Two shots from the SAME pose:
// the kind map and the normal shadow term.
if (process.env.FACEKIND) {
  const spawned = await page.evaluate(async (anchorId) => {
    const api = globalThis.__editorApi;
    const eng = api?.entities?.live(anchorId)?.engine;
    if (!eng?.scene) return { error: "no engine/scene" };
    const { THREE } = await import("/src/engine/index.js");
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(1.6, 1.6, 1.6),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 }),
    );
    mesh.position.set(-1.5, 2.2, -0.4);
    mesh.rotation.set(0.5, 0.7, 0.3);
    mesh.updateMatrixWorld(true);
    eng.scene.add(mesh);
    globalThis.__BOXTEST_MESH__ = mesh;
    return { ok: true };
  }, sunEntity.id);
  console.log(`  FACEKIND spawn: ${JSON.stringify(spawned)}`);
  // The kind map is read at resolve build; the profiling flip is the
  // structural rebuild that also lets the box enter the GI fingerprint.
  await page.evaluate(() => { globalThis.__giShadowKindDebug = true; });
  const originalProfiling = giProps.rayHitProfiling === true;
  await call("component.setProp", {
    id: giEntity.id, type: "global-illumination", key: "rayHitProfiling", value: false,
  });
  await wait(30000);
  // Park the camera a few meters UP-SUN of the box and above it, aimed at its
  // center: the faces in frame are the sun-lit, artifact-bearing ones.
  const camInfo = await page.evaluate(async ({ sunId }) => {
    const api = globalThis.__editorApi;
    const sunObj = api?.entities?.live(sunId)?.object3D;
    const box = globalThis.__BOXTEST_MESH__;
    if (!sunObj || !box) return null;
    const { THREE } = await import("/src/engine/index.js");
    const q = sunObj.getWorldQuaternion(new THREE.Quaternion());
    const d = new THREE.Vector3(0, 0, -1).applyQuaternion(q).normalize();
    return { toSun: [-d.x, -d.y, -d.z], p: [box.position.x, box.position.y, box.position.z] };
  }, { sunId: sunEntity.id });
  console.log(`  FACEKIND cam: ${JSON.stringify(camInfo)}`);
  if (camInfo) {
    const { toSun, p } = camInfo;
    await call("viewport.setCamera", {
      position: [p[0] + toSun[0] * 3.2, p[1] + Math.max(toSun[1] * 3.2, 1.2) + 1.0, p[2] + toSun[2] * 3.2],
      target: p,
    });
    await wait(2500);
  }
  await page.screenshot({ path: "scripts/gi-facekind-map.png" });
  console.log("  FACEKIND kind map -> scripts/gi-facekind-map.png");
  // Same pose, normal shadow term.
  await page.evaluate(() => { globalThis.__giShadowKindDebug = false; });
  await call("component.setProp", {
    id: giEntity.id, type: "global-illumination", key: "rayHitProfiling", value: true,
  });
  await wait(25000);
  await page.screenshot({ path: "scripts/gi-facekind-shadow.png" });
  console.log("  FACEKIND shadow -> scripts/gi-facekind-shadow.png");
  await page.evaluate((anchorId) => {
    const eng = globalThis.__editorApi?.entities?.live(anchorId)?.engine;
    const mesh = globalThis.__BOXTEST_MESH__;
    if (eng?.scene && mesh) eng.scene.remove(mesh);
  }, sunEntity.id);
  await call("component.setProp", {
    id: giEntity.id, type: "global-illumination", key: "rayHitProfiling", value: originalProfiling,
  });
  await restore().catch(() => {});
  console.log("\nGI-LIGHTSHADOW FACEKIND DONE");
  await browser.close();
  process.exit(0);
}

// BOXTEST=1 — THE SILHOUETTE GROUND TRUTH the counters can't give: spawn a
// tilted box mid-atrium (never moved after spawn → static → records fitted on
// the next full chain), close-up the floor shadow under the RECORD MARCH,
// then rebuild with `__giLightShadowLegacyDda` and shoot the LEGACY arm from
// the same pose. If the two images match, the record march is not changing
// verdicts and the defect is inside the trace path — no amount of pool or
// routing work will show up until that is explained.
if (process.env.BOXTEST) {
  const spawned = await page.evaluate(async (anchorId) => {
    const api = globalThis.__editorApi;
    const eng = api?.entities?.live(anchorId)?.engine;
    if (!eng?.scene) return { error: "no engine/scene" };
    // Same-specifier dynamic import returns the editor's own module instance —
    // no duplicate-Engine trap (that needs a differing ?t= query).
    const { THREE } = await import("/src/engine/index.js");
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(1.2, 1.2, 1.2),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 }),
    );
    // Down-hall inside the -65° sun's lit floor pool (the scene camera at
    // ~(8.3,0.7,-0.4) looks straight at it) so the cast shadow lands ON LIT
    // floor — a shadow in ambient-only shade is invisible in the frame.
    mesh.position.set(-1.5, 1.7, -0.4);
    mesh.rotation.set(0.5, 0.7, 0.3);
    mesh.updateMatrixWorld(true);
    eng.scene.add(mesh);
    globalThis.__BOXTEST_MESH__ = mesh;
    return { ok: true };
  }, sunEntity.id);
  console.log(`  BOXTEST spawn: ${JSON.stringify(spawned)}`);
  // A RAW scene mesh does not reach the GI fingerprint on its own (the first
  // run proved it: the records frame had a shadowless box; the mesh only
  // entered the field on the NEXT structural rebuild). Force that rebuild now
  // — profiling off doubles as the user-realistic arm — then let records fit.
  const originalProfiling = giProps.rayHitProfiling === true;
  await call("component.setProp", {
    id: giEntity.id, type: "global-illumination", key: "rayHitProfiling", value: false,
  });
  await wait(30000);
  // NO MORE AIM GUESSWORK: project the box center along the sun's actual
  // world direction onto the floor and park the camera 3m from that point.
  const shadowSpot = await page.evaluate(async ({ sunId }) => {
    const api = globalThis.__editorApi;
    const sunObj = api?.entities?.live(sunId)?.object3D;
    const box = globalThis.__BOXTEST_MESH__;
    if (!sunObj || !box) return null;
    const { THREE } = await import("/src/engine/index.js");
    const q = sunObj.getWorldQuaternion(new THREE.Quaternion());
    const d = new THREE.Vector3(0, 0, -1).applyQuaternion(q).normalize();
    if (d.y >= -0.05) return null;
    const p = box.position;
    const t = -p.y / d.y;
    const spot = [p.x + d.x * t, 0, p.z + d.z * t];
    // Approach from the far side of the shadow so the box (between the sun
    // and the spot) cannot occlude it: continue past the spot along the
    // box→shadow direction.
    const ax = spot[0] - p.x, az = spot[2] - p.z;
    const len = Math.hypot(ax, az) || 1;
    return { spot, away: [ax / len, az / len] };
  }, { sunId: sunEntity.id });
  console.log(`  BOXTEST shadow spot: ${JSON.stringify(shadowSpot)}`);
  if (shadowSpot) {
    const { spot, away } = shadowSpot;
    await call("viewport.setCamera", {
      position: [spot[0] + away[0] * 2.6, 2.3, spot[2] + away[1] * 2.6],
      target: [spot[0], 0.05, spot[2]],
    });
    await wait(3000);
  }
  await page.screenshot({ path: "scripts/gi-boxtest-records.png" });
  console.log("  BOXTEST records arm -> scripts/gi-boxtest-records.png");

  // ROTATE-AND-SETTLE arm — the user's exact repro ("when I rotate it a bit,
  // it gets cubic"): a matrix write flips the slot DYNAMIC (records ignored,
  // box shadows — expected in the first shot), and the 90-quiet-frame demote
  // + staticDirty full chain should refit records at the new pose (second
  // shot). If the second shot is still cubic, the demote path is broken —
  // that would make ANY touched object permanently voxel-shadowed.
  await page.evaluate(() => {
    const m = globalThis.__BOXTEST_MESH__;
    if (m) { m.rotation.y += 0.35; m.updateMatrixWorld(true); }
  });
  await wait(2000);
  await page.screenshot({ path: "scripts/gi-boxtest-justrotated.png" });
  await wait(9000);
  await page.screenshot({ path: "scripts/gi-boxtest-settled.png" });
  console.log("  BOXTEST rotate arms -> justrotated (dynamic window) / settled (post-demote)");

  // Legacy arm: the hatch is read at resolve build; toggling profiling back
  // is the structural flip that forces the rebuild re-reading it.
  await page.evaluate(() => { globalThis.__giLightShadowLegacyDda = true; });
  await call("component.setProp", {
    id: giEntity.id, type: "global-illumination", key: "rayHitProfiling", value: true,
  });
  await wait(30000);
  await page.screenshot({ path: "scripts/gi-boxtest-legacy.png" });
  console.log("  BOXTEST legacy arm -> scripts/gi-boxtest-legacy.png");

  // Restore: hatch off, profiling back, mesh out. The scene file was never
  // touched; the page dies at exit anyway, but leave the live state clean.
  await page.evaluate((anchorId) => {
    globalThis.__giLightShadowLegacyDda = false;
    const eng = globalThis.__editorApi?.entities?.live(anchorId)?.engine;
    const mesh = globalThis.__BOXTEST_MESH__;
    if (eng?.scene && mesh) eng.scene.remove(mesh);
  }, sunEntity.id);
  await call("component.setProp", {
    id: giEntity.id, type: "global-illumination", key: "rayHitProfiling", value: originalProfiling,
  });
  await restore().catch(() => {});
  console.log("\nGI-LIGHTSHADOW BOXTEST DONE");
  await browser.close();
  process.exit(0);
}

// The measurement gets one remount-race retry too: a dead __editorApi inside
// the evaluate throws out of the page, and losing a whole boot to that beat
// costs minutes.
let result = null;
for (let attempt = 0; attempt < 2 && !result; attempt++) {
  await page.waitForFunction(() => !!globalThis.__editorApi?.entities, { timeout: 120000 }).catch(() => {});
  try {
    result = await runMeasurement();
  } catch (err) {
    if (attempt === 1) { await restore().catch(() => {}); throw err; }
    console.log(`  measurement attempt died (${String(err.message).slice(0, 80)}) — waiting out the remount`);
    await wait(8000);
  }
}

// SECOND ARM AT 2°: the authored angle is 15° (k≈7.6 — a cone whose radius
// grows 1.3m per 10m, which through a cluttered interior may LEGITIMATELY
// occlude nearly everything). Angle is a live uniform (no rebuild), so the
// pair separates "the cone is physically huge" from "the march is broken":
// if 2° stays as dark as 15°, it is the march.
const originalSourceAngle = sunProps.sourceAngle ?? 0.53;
await setProp("sourceAngle", 2);
await wait(2500);
let result2 = null;
try { result2 = await runMeasurement(); } catch (err) {
  console.log(`  2-degree arm died: ${String(err?.message).slice(0, 80)}`);
}

async function runMeasurement() {
  return page.evaluate(async ({ anchorId, sunId }) => {
    const api = globalThis.__editorApi;
    const eng = api.entities.live(anchorId)?.engine;
    if (!eng?.renderer) throw new Error("no live engine");
    const renderer = eng.renderer;
    const giSystem = eng.modules.get("gi")?.system;
    if (!giSystem) throw new Error("no gi system");

    const sunEntity = api.entities.live(sunId);
    const sunLight = sunEntity?.getComponent("light")?.light ?? null;
    const entry = sunLight ? giSystem._lightShadowNodes?.get(sunLight) ?? null : null;
    const shadowNode = sunLight?.shadow?.shadowNode ?? undefined;
    const mask = entry?.mask?.value;
    // Channel index from the uniform mask the system actually set — reading it
    // back (rather than assuming slot 0) is what makes the accumulator below
    // sample the sun's own channel even if another light took the first slot.
    const channel = mask ? [mask.x, mask.y, mask.z, mask.w].findIndex((v) => v > 0.5) : -1;

    const targets = giSystem._giTargets ?? null;
    const size = giSystem._giTargetSize ?? null;
    const facts = {
      hasSunLight: !!sunLight,
      giShadowMode: sunLight?.userData?.giShadowMode ?? null,
      hasShadowNode: shadowNode !== undefined && shadowNode !== null,
      shadowNodeIsGiNode: !!entry && shadowNode === entry.node,
      shadowNodeClass: shadowNode?.constructor?.name ?? null,
      activeUniform: entry?.active?.value ?? null,
      channel,
      hasLightShadowTarget: !!targets?.lightShadow,
      bundleBuilt: !!giSystem.state?.screen?.lightShadow,
      steps: giSystem.state?.screen?.lightShadow?.steps ?? null,
      slotGiShadow: (giSystem.state?.lightSlots ?? []).map((s) => s.giShadow.value),
      slotSoft: (giSystem.state?.lightSlots ?? []).map((s) => s.soft.value),
      mean: null,
      irradianceMean: null,
      samples: 0,
    };
    if (!targets?.lightShadow || !size || channel < 0) return facts;

    const TSL = await import("/node_modules/three/build/three.tsl.js");
    const { Fn, If, instanceIndex, instancedArray, ivec2, texture, uniform, uint, vec3, atomicAdd } = TSL;

    // Fixed-point atomic sum over a coarse pixel grid — the same accumulator
    // shape run-gi-spawn-blink.mjs uses, one slot for the shadow channel and
    // one for irradiance (a lit scene is the control: an all-black shadow mean
    // means something very different if the whole resolve is black too).
    // Slot 2 is a KERNEL-ALIVE counter: +1 per invocation, so an all-zero
    // measurement can be told apart from a silently-dropped dispatch (an
    // invalid pipeline drops the compute without any error — the known
    // WebGPU failure mode this repo keeps re-hitting).
    // 3..5 are a coarse HISTOGRAM of the shadow channel (dark <0.1 / mid /
    // lit >0.9): a binary-verdict artifact (hard Breaks flipping with voxel
    // lattice phase) reads as dark+lit with an empty mid band, while a real
    // penumbra fills the middle — the discriminator the mean alone lacks.
    const sums = instancedArray(new Uint32Array(6), "uint").toAtomic();
    const { width, height } = size;
    const sx = Math.max(1, Math.floor(width / 192));
    const sy = Math.max(1, Math.floor(height / 144));
    const nx = Math.floor(width / sx);
    const ny = Math.floor(height / sy);
    const shadowTex = texture(targets.lightShadow);
    const irrTex = texture(targets.irradiance);
    const nxU = uniform(nx, "uint");
    // `channel` is a plain JS number by the time this kernel is built, so the
    // swizzle is picked HERE rather than with a GPU-side select — one less
    // thing that can be wrong inside the shader.
    const swizzle = ["x", "y", "z", "w"][channel];
    const kernel = Fn(() => {
      const px = instanceIndex.mod(nxU).mul(uint(sx));
      const py = instanceIndex.div(nxU).mul(uint(sy));
      const coord = ivec2(px.toInt(), py.toInt());
      const v = shadowTex.load(coord)[swizzle];
      atomicAdd(sums.element(uint(0)), v.mul(4096).min(2e6).toUint());
      const lum = irrTex.load(coord).xyz.dot(vec3(0.2126, 0.7152, 0.0722));
      atomicAdd(sums.element(uint(1)), lum.mul(4096).min(2e6).toUint());
      atomicAdd(sums.element(uint(2)), uint(1));
      If(v.lessThan(0.1), () => atomicAdd(sums.element(uint(3)), uint(1)));
      If(v.greaterThan(0.9), () => atomicAdd(sums.element(uint(4)), uint(1)));
      If(v.greaterThanEqual(0.1).and(v.lessThanEqual(0.9)), () => atomicAdd(sums.element(uint(5)), uint(1)));
    })().compute(nx * ny);

    // The compute pipeline compiles ASYNC and a dispatch submitted before it
    // is ready is SILENTLY SKIPPED (the repo's known WebGPU failure mode —
    // run 1 of this harness read all-zero for exactly this reason). Dispatch
    // per frame until the kernel-alive counter proves an execution; sums
    // accumulate across successful dispatches, so every mean divides by the
    // true invocation count rather than by one grid's worth.
    for (let i = 0; i < 8; i++) await new Promise((r) => requestAnimationFrame(r));
    let raw = new Uint32Array(6);
    for (let tries = 0; tries < 30 && raw[2] === 0; tries++) {
      renderer.compute(kernel);
      await new Promise((r) => requestAnimationFrame(r));
      raw = new Uint32Array(await renderer.getArrayBufferAsync(sums.value));
    }
    facts.samples = nx * ny;
    facts.kernelRan = raw[2];
    const n = Math.max(1, raw[2]);
    facts.mean = raw[0] / 4096 / n;
    facts.irradianceMean = raw[1] / 4096 / n;
    facts.histo = { dark: raw[3] / n, mid: raw[5] / n, lit: raw[4] / n };
    return facts;
  }, { anchorId: giEntity.id, sunId: sunEntity.id });
}

// Checks judge the SANE-angle arm; the authored-angle arm prints alongside.
const f = result2 ?? result ?? {};
const fAuthored = result ?? {};
const checks = [
  ["gi system claimed the sun's light", f.hasSunLight === true && f.giShadowMode === "gi"],
  ["sun carries a custom shadow.shadowNode", f.hasShadowNode === true],
  ["that node is the GI module's, not a CSM", f.shadowNodeIsGiNode === true && f.shadowNodeClass !== "CSMShadowNode"],
  ["the shadow node is active (uniform = 1)", f.activeUniform === 1],
  ["the resolve built a lightShadow bundle", f.bundleBuilt === true],
  ["the lightShadow target exists", f.hasLightShadowTarget === true],
  ["the sun claimed a channel", typeof f.channel === "number" && f.channel >= 0],
  ["a slot is flagged for gi shadows", (f.slotGiShadow ?? []).some((v) => v > 0.5)],
  ["the flagged slot published an angular radius", (f.slotSoft ?? []).some((v) => v > 0)],
  ["the accumulator kernel actually dispatched", f.kernelRan > 0 && f.kernelRan % (f.samples || 1) === 0],
  ["the resolve is producing light at all (control)", (f.irradianceMean ?? 0) > 0],
  [
    // Low bound 0.005, not 0.02: the terminator-dark fix (d48dec4) zeroes the
    // skip band, and an interior view at a 2° sun is legitimately shadow-
    // dominated (measured 0.013 on the reference camera). The check's job is
    // the two degenerate poles — an all-lit march that never blocks, and the
    // EXACTLY-0.0 texture of a broken lift/dropped dispatch.
    `channel ${f.channel} mean is a real shadow pattern (0.005 < mean < 0.98)`,
    typeof f.mean === "number" && f.mean > 0.005 && f.mean < 0.98,
  ],
];

console.log("\n=== GI LIGHT SHADOWS ===");
console.log(`  steps ${f.steps ?? "?"}, channel ${f.channel}, samples ${f.samples}, kernel invocations ${f.kernelRan ?? "n/a"}`);
console.log(`  shadow channel mean  ${typeof f.mean === "number" ? f.mean.toFixed(4) : "n/a"}  ` +
  `(1.0 = nothing ever blocked → the march is failing open; 0.0 = everything blocked → the ray lift is wrong)`);
console.log(`  irradiance mean      ${typeof f.irradianceMean === "number" ? f.irradianceMean.toFixed(4) : "n/a"}  (control)`);
console.log(`  slot giShadow flags  ${JSON.stringify(f.slotGiShadow ?? null)}`);
console.log(`  slot soft (radians)  ${JSON.stringify(f.slotSoft ?? null)}`);
if (f.histo) console.log(`  histogram @2deg      dark ${(f.histo.dark * 100).toFixed(1)}% / mid ${(f.histo.mid * 100).toFixed(1)}% / lit ${(f.histo.lit * 100).toFixed(1)}%  (empty mid = binary verdicts)`);
if (fAuthored.histo && fAuthored !== f)
  console.log(`  histogram @authored  dark ${(fAuthored.histo.dark * 100).toFixed(1)}% / mid ${(fAuthored.histo.mid * 100).toFixed(1)}% / lit ${(fAuthored.histo.lit * 100).toFixed(1)}%  (mean ${typeof fAuthored.mean === "number" ? fAuthored.mean.toFixed(4) : "n/a"})`);
console.log(`  shadowNode class     ${f.shadowNodeClass ?? "none"}`);
let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}`);
  if (!ok) failed++;
}

// The composed viewport, for a human (or agent) to actually LOOK at — the
// numbers above can't tell "real skylight dappling" from "lattice leaks".
await page.screenshot({ path: "scripts/gi-lightshadow-view.png" }).catch(() => {});
console.log("  viewport screenshot -> scripts/gi-lightshadow-view.png");

// SWEEP=1 — SUN ELEVATION SWEEP (user-requested instrument): X rotations
// from low morning to low evening, one settled screenshot per angle, so
// artifact populations can be attributed by angle-dependence — terminator
// residue moves with the grazing zones, dead-zone leaks stay put.
if (process.env.SWEEP) {
  for (const deg of [-30, -60, -90, -120, -145, -160]) {
    await page.evaluate(({ sunId, deg }) => {
      const obj = globalThis.__editorApi?.entities?.live(sunId)?.object3D;
      if (!obj) return false;
      obj.rotation.x = (deg * Math.PI) / 180;
      obj.updateMatrixWorld(true);
      return true;
    }, { sunId: sunEntity.id, deg });
    await wait(4500);
    const name = `scripts/gi-sweep-x${Math.abs(deg)}.png`;
    await page.screenshot({ path: name }).catch(() => {});
    console.log(`  SWEEP x=${deg} -> ${name}`);
  }
}

// DIAG=1 — THE ATTRIBUTION EXPERIMENT. Three screenshots that name the term
// an artifact lives in, with no interpretation left: (1) baseline is above;
// (2) sun on MAP shadows — anything that survives is not the gi-shadow
// channel; (3) GI COMPONENT OFF — anything that survives is not GI at all
// (environment IBL, bloom, three's own terms). Ordered so each arm only
// ever turns things OFF; everything is restored by restore().
if (process.env.DIAG) {
  await setProp("shadowMode", "map");
  await wait(12000);
  await page.screenshot({ path: "scripts/gi-diag-mapshadows.png" }).catch(() => {});
  console.log("  DIAG arm 2 (map shadows) -> scripts/gi-diag-mapshadows.png");
  await call("component.setProp", { id: giEntity.id, type: "global-illumination", key: "enabled", value: false });
  await wait(8000);
  await page.screenshot({ path: "scripts/gi-diag-gioff.png" }).catch(() => {});
  console.log("  DIAG arm 3 (GI off) -> scripts/gi-diag-gioff.png");
  await call("component.setProp", { id: giEntity.id, type: "global-illumination", key: "enabled", value: true });
}

// ALWAYS restore, pass or fail: this harness edits the user's real scene, and
// leaving a sun in gi mode would silently change every later measurement.
await restore();
console.log(`  restored shadowMode -> ${originalShadowMode}`);

console.log(failed === 0 ? "\nGI-LIGHTSHADOW ALL PASS" : `\nGI-LIGHTSHADOW ${failed} FAILED`);
await browser.close();
process.exit(failed === 0 ? 0 : 1);
