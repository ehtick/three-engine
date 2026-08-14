// ONE-OFF (2026-08-14, §12.66): frameid probe proved the shadow map re-renders
// EVERY frame (94.9/s) with fresh matrices at far=50 — map and matrix are
// mutually consistent; the sun direction matches the scene file exactly. Yet
// stored depth at scattered view points is a nearly CONSTANT 0.31 while the
// surfaces sit at 0.51-0.58: a FLAT occluder perpendicular to the light covers
// the whole view footprint. This boot hunts the GHOST CASTER:
//   1. CPU sun-ray raycast per point → what SHOULD the stored depth be
//   2. dense 96×96 window around a black texel → the ghost's shape
//   3. full castShadow-mesh census (name/type/layers/bbox/worldPos)
//   4. kill tests: castShadow off per candidate group → which one lights it
// Delete with the fix.
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = "C:/Users/Khudiiash/Documents/GAME";
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
page.on("console", (m) => { if (/\[gi\] built/.test(m.text())) built = true; });
await page.evaluateOnNewDocument((project) => {
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
  globalThis.__editorKeepRendering = true;
}, PROJECT);
console.log(`opening ${PROJECT} …`);
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, PROJECT);
for (let i = 0; i < 240 && !built; i++) await wait(1000);
if (!built) { console.log("FATAL: never built"); await browser.close(); process.exit(1); }
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 60000 });
await wait(20000);

const readFrame = () => page.evaluate(async () => {
  const engine = globalThis.__editorApi.entities.live("KT0sShKBX-")?.engine;
  return await new Promise((resolve) => {
    let n = 0;
    const off = engine.onPostRender(() => {
      if (++n < 2) return;
      off();
      const src = engine.renderer.domElement;
      const c = document.createElement("canvas");
      c.width = src.width; c.height = src.height;
      const ctx = c.getContext("2d");
      ctx.drawImage(src, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let black = 0, lumSum = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] <= 2 && d[i + 1] <= 2 && d[i + 2] <= 2) black++;
        lumSum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      }
      resolve({ blackFrac: +(black / (d.length / 4)).toFixed(4), meanLum: +(lumSum / (d.length / 4) / 255).toFixed(4) });
    });
  });
});
console.log(`0-base ${JSON.stringify(await readFrame())}`);

// STEP 1+3: CPU sun-ray truth + full caster census.
const truth = await page.evaluate(async () => {
  const engine = globalThis.__editorApi.entities.live("KT0sShKBX-")?.engine;
  const THREE = await import("/node_modules/three/build/three.webgpu.js");
  let light = null;
  engine.scene.traverse((o) => { if (o.isDirectionalLight && !light) light = o; });
  const s = light.shadow;
  const dir = new THREE.Vector3();
  light.getWorldDirection(dir); // points FROM light toward target
  const cam = engine.camera;
  const ray = new THREE.Raycaster();
  const pts = [];
  for (const [nx, ny] of [[0, 0], [-0.4, -0.3], [0.4, -0.3]]) {
    ray.setFromCamera(new THREE.Vector2(nx, ny), cam);
    const hits = ray.intersectObjects(engine.scene.children, true).filter((h) => h.object.isMesh && h.object.visible);
    if (hits[0]) pts.push(hits[0].point);
  }
  const shadowCamPos = s.camera.getWorldPosition(new THREE.Vector3());
  const results = [];
  for (const p of pts) {
    // sun-ray: start 45m up-light of the point, cast along dir
    const origin = p.clone().addScaledVector(dir, -45);
    ray.set(origin, dir.clone().normalize());
    ray.far = 100;
    const hits = ray.intersectObjects(engine.scene.children, true)
      .filter((h) => h.object.isMesh && h.object.visible && h.object.castShadow);
    const first = hits[0] ?? null;
    // expected stored depth = ortho depth of first hit from the shadow camera
    const near = s.camera.near, far = s.camera.far;
    const depthOf = (wp) => {
      const v = wp.clone().applyMatrix4(s.camera.matrixWorldInverse);
      return (-v.z - near) / (far - near);
    };
    results.push({
      point: p.toArray().map((v) => +v.toFixed(2)),
      pointDepth: +depthOf(p).toFixed(4),
      firstHit: first ? {
        name: (first.object.name || first.object.parent?.name || "?").slice(0, 40),
        type: first.object.type,
        depth: +depthOf(first.point).toFixed(4),
        distToPoint: +first.point.distanceTo(p).toFixed(2),
      } : null,
    });
  }
  // caster census
  const casters = [];
  engine.scene.traverse((o) => {
    if ((o.isMesh || o.isBatchedMesh || o.isInstancedMesh) && o.castShadow && o.visible) {
      const geo = o.geometry;
      if (!geo.boundingBox) geo.computeBoundingBox();
      const bb = geo.boundingBox;
      const size = new THREE.Vector3().subVectors(bb.max, bb.min).multiply(o.getWorldScale(new THREE.Vector3()));
      casters.push({
        name: (o.name || o.parent?.name || "?").slice(0, 44),
        type: o.type,
        layers: o.layers.mask,
        pos: o.getWorldPosition(new THREE.Vector3()).toArray().map((v) => +v.toFixed(1)),
        size: size.toArray().map((v) => +v.toFixed(1)),
        tris: (geo.index ? geo.index.count : geo.attributes.position?.count ?? 0) / 3 | 0,
      });
    }
  });
  return { dir: dir.toArray().map((v) => +v.toFixed(3)), shadowCamPos: shadowCamPos.toArray().map((v) => +v.toFixed(1)), engineCamPos: cam.getWorldPosition(new THREE.Vector3()).toArray().map((v) => +v.toFixed(1)), results, casterCount: casters.length, casters: casters.slice(0, 60) };
});
console.log(JSON.stringify(truth, null, 1));

// STEP 2: dense 96×96 window around center point's texel.
const windowRead = await page.evaluate(async () => {
  const engine = globalThis.__editorApi.entities.live("KT0sShKBX-")?.engine;
  const THREE = await import("/node_modules/three/build/three.webgpu.js");
  const TSL = await import("/node_modules/three/build/three.tsl.js");
  const renderer = engine.renderer;
  let light = null;
  engine.scene.traverse((o) => { if (o.isDirectionalLight && !light) light = o; });
  const s = light.shadow;
  const depthTex = s.map.depthTexture;
  const cam = engine.camera;
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2(0, 0), cam);
  const hit = ray.intersectObjects(engine.scene.children, true).filter((h) => h.object.isMesh && h.object.visible)[0];
  if (!hit) return { error: "no hit" };
  const v4 = new THREE.Vector4(hit.point.x, hit.point.y, hit.point.z, 1).applyMatrix4(s.matrix);
  const cu = v4.x / v4.w, cv = v4.y / v4.w;
  const mapW = s.mapSize?.x ?? 4096;
  const cx = Math.round(cu * mapW), cyA = Math.round((1 - cv) * mapW);
  const N = 96, STEP = 4; // 96×96 taps, 4-texel stride = 384² texel window (~7.5m at 80m/4096)
  const { Fn, instanceIndex, instancedArray, ivec2, texture, uint } = TSL;
  const buf = instancedArray(new Float32Array(N * N), "float");
  const node = texture(depthTex);
  const x0 = Math.max(0, cx - (N / 2) * STEP), y0 = Math.max(0, cyA - (N / 2) * STEP);
  const kernel = Fn(() => {
    const px = instanceIndex.mod(uint(N)).mul(uint(STEP)).add(uint(x0));
    const py = instanceIndex.div(uint(N)).mul(uint(STEP)).add(uint(y0));
    buf.element(instanceIndex).assign(node.load(ivec2(px.toInt(), py.toInt())).x);
  })().compute(N * N);
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  renderer.compute(kernel);
  for (let i = 0; i < 200; i++) {
    if ((globalThis.__giPendingComputePipelines?.size ?? 0) === 0) break;
    await frame();
  }
  await frame();
  renderer.compute(kernel);
  const a = new Float32Array(await renderer.getArrayBufferAsync(buf.value));
  let min = Infinity, max = -Infinity, sum = 0;
  const hist = {};
  for (const v of a) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    const b = (v * 20 | 0) / 20;
    hist[b.toFixed(2)] = (hist[b.toFixed(2)] ?? 0) + 1;
  }
  return { centerTexel: [cx, cyA], min: +min.toFixed(4), max: +max.toFixed(4), mean: +(sum / a.length).toFixed(4), hist };
});
console.log(`window ${JSON.stringify(windowRead)}`);

// STEP 4: kill tests — castShadow off per group, restore between tests.
const killTest = async (label, selector) => {
  await page.evaluate(async (sel) => {
    const engine = globalThis.__editorApi.entities.live("KT0sShKBX-")?.engine;
    const flagged = globalThis.__ghostFlagged = [];
    const UI_LAYER_GUESS = null;
    engine.scene.traverse((o) => {
      if (!(o.isMesh || o.isBatchedMesh || o.isInstancedMesh) || !o.castShadow) return;
      let match = false;
      if (sel === "batched") match = !!(o.isBatchedMesh || o.isInstancedMesh);
      else if (sel === "nonDefaultLayer") match = o.layers.mask !== 1;
      else if (sel === "unnamed") match = !o.name;
      else if (sel === "all") match = true;
      if (match) { flagged.push(o); o.castShadow = false; }
    });
    return flagged.length;
  }, selector);
  await wait(2000);
  const r = await readFrame();
  const count = await page.evaluate(() => {
    const n = globalThis.__ghostFlagged?.length ?? 0;
    for (const o of globalThis.__ghostFlagged ?? []) o.castShadow = true;
    globalThis.__ghostFlagged = [];
    return n;
  });
  await wait(1200);
  console.log(`kill[${label}] n=${count} → ${JSON.stringify(r)}`);
};
await killTest("batched/instanced", "batched");
await killTest("non-default-layer", "nonDefaultLayer");
await killTest("unnamed-meshes", "unnamed");
await killTest("ALL-meshes", "all");
console.log(`restored ${JSON.stringify(await readFrame())}`);
await browser.close();
