// PROBE — read-only against the real GAME project (nothing written to disk,
// installTauriShim gets no writableRoot, exactly like run-gi-diagnose-game.mjs).
//
// WHY THIS EXISTS: _inspect-bvh-atlas.mjs proved that Main.scene, as it is
// AUTHORED RIGHT NOW, has zero isCompressedTexture maps reaching the BVH
// atlas (every material's "map" is "" — Red.mat/Mirror.mat/materials/*.mat
// are all flat shaderGraph colors, no image texture anywhere) — so the
// "red/gold KTX2 box" scenario has nothing to exercise in the CURRENT
// project state, and the existing "Box" mirror's surrounding room geometry
// makes camera framing unreliable (run-gi-diagnose-game.mjs's own Section D
// produced all-black screenshots there — a documented pre-existing framing
// issue for this specific small room, not something this probe can fix).
//
// This adds, IN MEMORY ONLY: a real THREE.CompressedTexture (hand-encoded
// BC1/DXT1, solid "gold/red" ~rgb(222,121,17), format+isCompressedTexture
// shape identical to what a transcoded KTX2 texture produces) on a probe
// sphere, plus a plain metal mirror panel, both floated in open air above
// the authored scene so the shot is unobstructed. This exercises the EXACT
// code path the fix targets (bvhScene.js buildAlbedoAtlas's
// `map.isCompressedTexture` branch -> pendingGpuTiles -> giScreen.js
// blitBvhAtlasTiles -> atlasTextureNode.value swap) inside the SAME live
// engine/GISystem instance the real project boots, then reads back both
// ground-truth JS state AND a screenshot of the mirror's reflected color.
import path from "node:path";
import puppeteer from "puppeteer-core";
import sharp from "sharp";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5280/";
const PROJECT = "C:/Users/Khudiiash/Documents/GAME";
const SCENE = "scenes/Main.scene";
const scenePath = path.join(PROJECT, SCENE).replace(/\\/g, "/");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const consoleLog = [];
const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
await installTauriShim(page, { verbose: !!process.env.VERBOSE }); // read-only: no writableRoot

page.on("console", (m) => {
  const text = m.text();
  consoleLog.push(text);
  if (/\[gi\]/.test(text) || m.type() === "error") console.log(`  page ${m.type()}: ${text.slice(0, 300)}`);
});
page.on("pageerror", (e) => console.log(`  pageerror: ${e.stack ?? e.message}`));

await page.evaluateOnNewDocument(() => {
  globalThis.__importLive = (p) => {
    const prefix = location.origin + p;
    const fetched = performance.getEntriesByType("resource").map((e) => e.name).filter((n) => n === prefix || n.startsWith(`${prefix}?`));
    const live = fetched.find((n) => n.includes("?")) ?? fetched[0];
    return import(/* @vite-ignore */ live ?? p);
  };
});

await page.goto(url, { waitUntil: "load", timeout: 60000 });

console.log(`Opening project ${PROJECT}, scene ${scenePath} ...`);
const opened = await page.evaluate(
  async ({ PROJECT, scenePath }) => {
    try {
      const { useProjectStore } = await globalThis.__importLive("/src/editor/store/projectStore.js");
      await useProjectStore.getState().openProject(PROJECT);
      const { syncProjectModules } = await globalThis.__importLive("/src/editor/modules.js");
      await syncProjectModules();
      const { openScenePath } = await globalThis.__importLive("/src/editor/sceneIO.js");
      await openScenePath(scenePath);
      const { ensureEngine } = await globalThis.__importLive("/src/editor/engineInstance.js");
      const engine = await ensureEngine();
      globalThis.__engine = engine;
      const { THREE } = await globalThis.__importLive("/src/engine/index.js");
      globalThis.__THREE = THREE;
      const { EDITOR_LAYER } = await globalThis.__importLive("/src/engine/editorLayers.js");
      globalThis.__EDITOR_LAYER = EDITOR_LAYER;
      return { ok: true, entities: engine.entities.size };
    } catch (err) {
      return { ok: false, error: err?.stack ?? err?.message ?? String(err) };
    }
  },
  { PROJECT, scenePath },
);
if (!opened.ok) {
  console.log(`FATAL: ${opened.error}`);
  await browser.close();
  process.exit(1);
}
console.log(`  opened: ${opened.entities} entities`);

const settle = async (budgetMs) => {
  const t = Date.now();
  while (Date.now() - t < budgetMs) {
    await wait(1000);
    const busy = await page.evaluate(() => globalThis.__engine?.renderSuspended === true);
    if (!busy && Date.now() - t > 6000) break;
  }
};
await settle(60000);
await wait(3000);
let n1 = await page.evaluate(() => globalThis.__engine.entities.size);
await wait(8000);
let n2 = await page.evaluate(() => globalThis.__engine.entities.size);
if (n1 !== n2) {
  console.log(`  entity count still growing (${n1} -> ${n2}), settling more...`);
  await settle(30000);
}
for (let i = 0; i < 40; i++) {
  const ready = await page.evaluate(() => !!globalThis.__viewport?.orbit && !!globalThis.__engine?.camera);
  if (ready) break;
  await wait(500);
}
console.log("  settled, viewport ready.");

// -----------------------------------------------------------------------
// Add the probe pair: a hand-encoded BC1 CompressedTexture sphere + a
// plain metal mirror panel, floated well above the authored room.
// -----------------------------------------------------------------------
const preMark = Date.now();
const setup = await page.evaluate(() => {
  const engine = globalThis.__engine;
  const THREE = globalThis.__THREE;

  // Anchor near the REAL "Box" mirror (metalness>=0.8, roughness<=0.3 —
  // same heuristic run-gi-diagnose-game.mjs's Section D uses), not a
  // whole-scene AABB: this project has some far-flung mesh with an
  // enormous Y extent (traversal found box.max.y in the tens of
  // thousands), which floated an earlier attempt 45km in the air, well
  // outside the auto-fit GI volume — hence an all-black shot there.
  const resolveScalar = (node, fallback) => {
    if (node == null) return fallback;
    let n = node;
    for (let depth = 0; depth < 8 && n; depth++) {
      if (n.isConstNode || n.isUniformNode) return typeof n.value === "number" ? n.value : fallback;
      n = n.node ?? null;
    }
    return fallback;
  };
  let mirrorEntity = null;
  engine.scene.traverse((o) => {
    if (mirrorEntity || !o.isMesh || !o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const hit = mats.find((m) => {
      const metalness = resolveScalar(m?.metalnessNode, m?.metalness ?? 0);
      const roughness = resolveScalar(m?.roughnessNode, m?.roughness ?? 1);
      return metalness >= 0.8 && roughness <= 0.3;
    });
    if (hit) mirrorEntity = o;
  });
  const anchor = new THREE.Vector3();
  if (mirrorEntity) {
    mirrorEntity.updateMatrixWorld(true);
    mirrorEntity.getWorldPosition(anchor);
  }
  // A modest, bounded offset, cross-checked against a direct query of this
  // room's own Floor/Ceiling/Partition/Red/Green entity AABBs (y in
  // [0, ~4] between floor and the partition slab at y=3.96..4.06, x in
  // [-2.17, 2.93], z in [-2.5, 2.5] — a first attempt at +2.4y landed
  // almost exactly ON that partition, which is why it produced an
  // all-black "looking at the underside of a slab" shot).
  const origin = anchor.clone().add(new THREE.Vector3(0, 0.5, 1.3));

  // Hand-encoded BC1/DXT1 block, 4x4 grid of 4x4-texel blocks (16x16px),
  // every block identical: color0 = target color (RGB565), color1 = 0
  // (strictly less, forcing 4-color OPAQUE mode, never punch-through),
  // every texel index 0 (selects color0 exactly, no interpolation). This is
  // the exact same object shape (isCompressedTexture===true, .image is a
  // {data,width,height} mip record) a transcoded KTX2 texture produces —
  // buildAlbedoAtlas's ctx.drawImage cannot draw it, only the GPU can
  // sample it, which is precisely the code path under test.
  const R = 224, G = 120, B = 20; // warm gold/red, unambiguously not white/gray
  const r5 = Math.round((R / 255) * 31);
  const g6 = Math.round((G / 255) * 63);
  const b5 = Math.round((B / 255) * 31);
  const color0 = (r5 << 11) | (g6 << 5) | b5;
  const color1 = 0;
  const blocks = 4 * 4;
  const data = new Uint8Array(blocks * 8);
  for (let i = 0; i < blocks; i++) {
    const o = i * 8;
    data[o] = color0 & 0xff;
    data[o + 1] = (color0 >> 8) & 0xff;
    data[o + 2] = color1 & 0xff;
    data[o + 3] = (color1 >> 8) & 0xff;
    // bytes o+4..o+7 already zero-initialized -> every 2-bit index is 0 -> color0
  }
  const map = new THREE.CompressedTexture([{ data, width: 16, height: 16 }], 16, 16, THREE.RGB_S3TC_DXT1_Format);
  map.colorSpace = THREE.SRGBColorSpace;
  map.minFilter = THREE.LinearFilter;
  map.magFilter = THREE.LinearFilter;
  map.needsUpdate = true;

  // Sized to fit this specific small room (x in [-2.17,2.93], z in
  // [-2.5,2.5], y in [0, ~4] — see the origin comment above): a 2.2m mirror
  // panel centered 0.85m off the anchor would poke straight through the
  // "Green" wall at x=2.83..2.93, so both the panel and the separation are
  // scaled well down from the first (too-big) attempt.
  const sphereRadius = 0.35;
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(sphereRadius, 32, 24),
    new THREE.MeshStandardNodeMaterial({ map, roughness: 0.6, metalness: 0, color: 0xffffff }),
  );
  sphere.name = "PROBE-compressed-sphere";
  sphere.position.copy(origin).add(new THREE.Vector3(-0.85, 0, 0));
  sphere.castShadow = true;
  sphere.receiveShadow = true;
  engine.scene.add(sphere);
  sphere.updateMatrixWorld(true);

  const mirror = new THREE.Mesh(
    new THREE.BoxGeometry(0.7, 0.7, 0.12),
    new THREE.MeshStandardNodeMaterial({ metalness: 1, roughness: 0, color: 0xffffff }),
  );
  mirror.name = "PROBE-mirror-panel";
  mirror.position.copy(origin).add(new THREE.Vector3(0.85, 0, 0));
  // Face the mirror toward the sphere (mirror's local +Z is its front).
  mirror.lookAt(sphere.position);
  mirror.castShadow = true;
  mirror.receiveShadow = true;
  engine.scene.add(mirror);
  mirror.updateMatrixWorld(true);

  const gi = engine.modules.get("gi");
  if (!gi?.system) return { ok: false, error: "gi module/system not found" };
  gi.system.requestRebuild();

  return {
    ok: true,
    spherePos: sphere.position.toArray(),
    mirrorPos: mirror.position.toArray(),
    targetColor: [R, G, B],
    mapIsCompressed: !!map.isCompressedTexture,
  };
});
console.log(`  probe setup: ${JSON.stringify(setup)}`);
if (!setup.ok) {
  await browser.close();
  process.exit(1);
}

// Wait for the rebuild + compile wave + settle.
let builtAt = null;
for (let i = 0; i < 120 && !builtAt; i++) {
  if (consoleLog.some((t) => /\[gi\] built/.test(t)) && Date.now() - preMark > 0) {
    // crude but sufficient: any "[gi] built" seen after we started polling
    builtAt = Date.now();
    break;
  }
  await wait(1000);
}
console.log(builtAt ? `  saw a post-probe "[gi] built" line` : `  WARN: no "[gi] built" seen within 120s`);
for (let i = 0; i < 90; i++) {
  const suspended = await page.evaluate(() => globalThis.__engine?.renderSuspended === true);
  if (!suspended) break;
  await wait(1000);
}
await wait(5000);

// -----------------------------------------------------------------------
// Ground truth: did pendingGpuTiles/blit actually engage for this mesh?
// -----------------------------------------------------------------------
const groundTruth = await page.evaluate(() => {
  const engine = globalThis.__engine;
  const gi = engine.modules.get("gi");
  const bvhScene = gi?.system?.state?.bvhScene;
  if (!bvhScene) return { ok: false, error: "no bvhScene" };
  const sphereIdx = bvhScene.meshes.findIndex((m) => m.name === "PROBE-compressed-sphere");
  return {
    ok: true,
    meshCount: bvhScene.meshCount,
    texturedCount: bvhScene.texturedCount,
    pendingGpuTilesLength: bvhScene.pendingGpuTiles.length,
    hasBlitTarget: !!bvhScene.blitTarget,
    atlasNodeIsBlitTarget: bvhScene.blitTarget ? bvhScene.atlasTextureNode.value === bvhScene.blitTarget.texture : null,
    sphereFoundInBvh: sphereIdx >= 0,
    sphereMeshIndex: sphereIdx,
  };
});
console.log(`\n  BVH ground truth after probe rebuild: ${JSON.stringify(groundTruth, null, 2)}`);

const gpuBlitLines = consoleLog.filter((t) => /atlas gpu-blit/.test(t));
console.log(`\n  "atlas gpu-blit" console lines seen: ${gpuBlitLines.length}`);
gpuBlitLines.forEach((l) => console.log(`    ${l}`));

// -----------------------------------------------------------------------
// Screenshot: aim at the mirror from a clean, open-space angle.
// -----------------------------------------------------------------------
const getCanvasBox = () =>
  page.evaluate(() => {
    const c = [...document.querySelectorAll("canvas")].map((el) => ({ el, r: el.getBoundingClientRect() })).sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height)[0];
    return { x: c.r.x, y: c.r.y, width: c.r.width, height: c.r.height };
  });
const shoot = async (savePath) => {
  const box = await getCanvasBox();
  return savePath ? page.screenshot({ path: savePath, clip: box }) : page.screenshot({ clip: box });
};
const sampler = async (buffer) => {
  const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  return (fx, fy) => {
    const px = Math.min(info.width - 1, Math.max(0, Math.round(fx * info.width)));
    const py = Math.min(info.height - 1, Math.max(0, Math.round(fy * info.height)));
    const i = (py * info.width + px) * info.channels;
    return [data[i], data[i + 1], data[i + 2]];
  };
};
const projectPoint = ([x, y, z]) =>
  page.evaluate(
    (p) => {
      const engine = globalThis.__engine;
      const THREE = globalThis.__THREE;
      engine.camera.updateMatrixWorld(true);
      const v = new THREE.Vector3(...p).project(engine.camera);
      return [(v.x + 1) / 2, (1 - v.y) / 2];
    },
    [x, y, z],
  );

const aim = await page.evaluate(
  ({ mirrorPos, spherePos }) => {
    const engine = globalThis.__engine;
    const viewport = globalThis.__viewport;
    const EDITOR_LAYER = globalThis.__EDITOR_LAYER;
    if (!engine?.camera) return { hasCamera: false };
    // Eye MUST be on the same side of the mirror as the sphere (mirror was
    // built with .lookAt(spherePos), so its reflective face points toward
    // -X from the mirror, matching where the sphere sits) — a camera on the
    // mirror's BACK side (the first attempt: mirrorPos.x + 2.2, i.e. even
    // further +X than the mirror) can only ever see the unlit backface.
    // Placed a bit further -X than the sphere itself (camera, sphere,
    // mirror roughly colinear along X, camera farthest back), small
    // Y/Z offset for a 3/4 angle, all cross-checked against this room's
    // real x in [-2.17,2.93] / y in [0,3.96] / z in [-2.5,2.5] envelope.
    // Same side of the mirror as the sphere (its reflective face — all 6
    // box faces share one material, so any visible face works). This exact
    // eye formula is the one that already produced a real (non-black),
    // varied-color capture with a sample close to the target color.
    const mid = [(mirrorPos[0] + spherePos[0]) / 2, mirrorPos[1] + 1.2, (mirrorPos[2] + spherePos[2]) / 2];
    const eye = [spherePos[0] - 0.9, spherePos[1] + 0.4, spherePos[2] + 0.9];
    engine.camera.position.set(...eye);
    // ViewportPanel.jsx registers `engine.onUpdate(() => { viewport.orbit.update(); ... })`
    // — OrbitControls re-aims (lookAt) the camera at `orbit.target` on
    // EVERY frame, unconditionally, so a plain `.lookAt()` call here gets
    // its ORIENTATION silently overwritten one frame later even though the
    // position (recomputed from a spherical derived fresh off whatever
    // position is current) survives — this is the exact trap the DEV-only
    // `globalThis.__viewport` comment in that file warns about, and the
    // reason src/editor/api/ops/viewport.js's `viewport.setCamera` op sets
    // `orbit.target` and calls `orbit.update()` instead of `.lookAt()`.
    if (viewport?.orbit) {
      viewport.orbit.target.set(...mirrorPos);
      viewport.orbit.update();
    } else {
      engine.camera.lookAt(...mirrorPos);
    }
    engine.camera.updateMatrixWorld(true);
    engine.camera.layers.disable(EDITOR_LAYER);
    engine.scene.traverse((o) => {
      if (o.isGridHelper || o.type === "GridHelper") o.visible = false;
    });
    return { hasCamera: true, eye, mid };
  },
  { mirrorPos: setup.mirrorPos, spherePos: setup.spherePos },
);
console.log(`\n  camera aim: ${JSON.stringify(aim)}`);

// Re-check renderSuspended right before shooting, not just once earlier —
// the NEW compressed-texture material's own pipeline can trigger a SECOND,
// later compile wave (a distinct shader combination never compiled before)
// that starts after the first "not suspended" check already passed. A
// screenshot taken while suspended captures a frozen/stale canvas
// regardless of camera position — indistinguishable from a genuine framing
// miss, which is exactly the ambiguity earlier attempts ran into.
for (let i = 0; i < 60; i++) {
  const suspended = await page.evaluate(() => globalThis.__engine?.renderSuspended === true);
  if (!suspended) break;
  console.log(`  renderSuspended again before shoot, waiting... (${i})`);
  await wait(1000);
}
await wait(1500);

const outPath = "scripts/gi-diag-game-probe-mirror.png";
const buf = await shoot(outPath);
console.log(`  SHOT ${outPath}`);

const [mirrorUV] = await Promise.all([projectPoint(setup.mirrorPos)]);
console.log(`  mirror projected UV: ${mirrorUV.map((v) => v.toFixed(3))}`);
const at = await sampler(buf);
const samplePts = [
  [0, 0], [0.03, 0], [-0.03, 0], [0, 0.03], [0, -0.03], [0.02, 0.02], [-0.02, -0.02], [0.05, 0.05], [-0.05, -0.05],
].map(([dx, dy]) => [Math.min(0.98, Math.max(0.02, mirrorUV[0] + dx)), Math.min(0.98, Math.max(0.02, mirrorUV[1] + dy))]);
const samples = samplePts.map(([x, y]) => at(x, y));
console.log(`\n  mirror-region samples (target color ~rgb(222,121,17)):`);
samples.forEach((c, i) => console.log(`    [${samplePts[i].map((v) => v.toFixed(3))}] rgb(${c.join(",")})`));

const { info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
const cw = Math.round(info.width * 0.3);
const ch = Math.round(info.height * 0.3);
const cx = Math.min(info.width - cw, Math.max(0, Math.round(mirrorUV[0] * info.width - cw / 2)));
const cy = Math.min(info.height - ch, Math.max(0, Math.round(mirrorUV[1] * info.height - ch / 2)));
const zoomPath = "scripts/gi-diag-game-probe-mirror-zoom.png";
await sharp(buf).extract({ left: cx, top: cy, width: cw, height: ch }).resize(cw * 4, ch * 4, { kernel: "nearest" }).toFile(zoomPath);
console.log(`  SHOT ${zoomPath} (4x crop around mirror UV)`);

console.log("\n=== DONE ===");
await browser.close();
process.exit(0);
