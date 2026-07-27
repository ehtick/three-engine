// Compile-wave A/B for the roughness BUCKET path.
//
// Why this harness exists: every other GI harness builds plain
// MeshStandardNodeMaterials with a NUMERIC `.roughness`, which is the only
// material shape that ever reached giLight's cheap compile buckets. The
// editor's real materials all come from shaderGraph, which assigns
// `roughnessNode = float(<slider>)` — and the old bucket test treated ANY
// roughnessNode as "dynamic roughness", i.e. the full mirror + hit-lighting
// shader, for every wall and floor in a real project. Harness scenes were
// fast, the user's editor was not.
//
// This scene uses editor-shaped materials (roughnessNode set) and measures the
// compile wave both ways:
//   DYNAMIC=1  → roughnessNode is a non-const expression (float(r).mul(1)),
//                unresolvable → bucket 3 = the pre-fix behaviour.
//   (default)  → roughnessNode is float(r), a ConstNode → resolved bucket.
//
// Reports: wave wall-time (enable → renderSuspended false), worst main-thread
// frame, post-wave steady frame time, and the [gi] bucket tally line.
import puppeteer from "puppeteer-core";

const url = process.argv[2] ?? "http://localhost:5201/";
const DYNAMIC = !!process.env.DYNAMIC;
const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\]|GI-BK/.test(t) || m.type() === "error" || m.type() === "warning") {
    console.log(`${(performance.now() / 1000).toFixed(1)}s ${m.type()}: ${t}`);
  }
});
page.on("pageerror", (e) => console.log(`pageerror: ${e.stack ?? e.message}`));

await page.goto(url, { waitUntil: "load", timeout: 30000 });
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
});
await new Promise((r) => setTimeout(r, 5000));

// A/B switch for the per-builder Fn layouts (giFn.js): NOLAYOUTS=1 reproduces
// the previous shipped codegen on the SAME machine state.
if (process.env.NOLAYOUTS) await page.evaluate(() => { globalThis.__giNoLayouts = true; });

await page.evaluate(async (dynamic) => {
  const { THREE } = await import("/src/engine/index.js");
  // Bare "three/tsl" is a vite alias, not resolvable from an injected script.
  const TSL = await import("/node_modules/three/build/three.tsl.js");
  await import("/src/modules/index.js");
  const { enableEngineModule } = await import("/src/engine/modules.js");
  const { ensureEngine } = await import("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  await enableEngineModule(engine, "gi");
  globalThis.__engine = engine;

  // Editor-shaped material: shaderGraph always assigns roughnessNode.
  // `.mul(1)` makes the node non-constant without changing its value — the
  // pre-fix bucket behaviour for a plain slider roughness.
  const roughNode = (r) => (dynamic ? TSL.float(r).mul(1) : TSL.float(r));
  const editorMaterial = (color, r, metal = 0, side = THREE.FrontSide) => {
    const m = new THREE.MeshStandardNodeMaterial({ color, side });
    m.roughness = r;
    m.metalness = metal;
    m.colorNode = TSL.color(new THREE.Color(color));
    m.roughnessNode = roughNode(r);
    m.metalnessNode = TSL.float(metal);
    return m;
  };

  const addPlane = (size, position, rotation, color, name, r = 0.9) => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(...size), editorMaterial(color, r, 0, THREE.DoubleSide));
    mesh.position.set(...position);
    mesh.rotation.set(...rotation);
    mesh.name = name;
    engine.scene.add(mesh);
    return mesh;
  };
  addPlane([12, 12], [0, 0, 0], [-Math.PI / 2, 0, 0], 0xcccccc, "ground", 0.7);
  addPlane([12, 12], [0, 9, 0], [Math.PI / 2, 0, 0], 0xb8c3cf, "ceiling", 0.9);
  addPlane([12, 9], [0, 4.5, -6], [0, Math.PI, 0], 0xb8c3cf, "back", 0.8);
  addPlane([12, 9], [-6, 4.5, 0], [0, -Math.PI / 2, 0], 0x9f2418, "red", 0.7);
  addPlane([12, 9], [6, 4.5, 0], [0, Math.PI / 2, 0], 0x3a9f24, "green", 0.7);
  // 20 distinct materials, same spread as run-gi-rebuild-cost.mjs so the two
  // harnesses' wave numbers are comparable.
  for (let i = 0; i < 20; i++) {
    const r = 0.2 + (i % 5) * 0.18;
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.5, 0.5),
      editorMaterial(new THREE.Color().setHSL(i / 20, 0.6, 0.55).getHex(), r, i % 2 ? 0.9 : 0),
    );
    box.position.set(-4 + (i % 5) * 2, 0.6 + Math.floor(i / 5) * 1.4, -3 + (i % 3) * 3);
    engine.scene.add(box);
  }
  const lampMat = editorMaterial(0xffffff, 1);
  lampMat.emissive = new THREE.Color(0xffffff);
  lampMat.emissiveIntensity = 8;
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.5, 24, 16), lampMat);
  lamp.position.set(0, 8.2, 0);
  lamp.name = "lamp";
  engine.scene.add(lamp);

  engine.camera.position.set(0.4, 4.2, 16.5);
  engine.camera.lookAt(0, 3.6, 0);
  engine.camera.updateMatrixWorld(true);
  console.log(`GI-BK scene ready (dynamic=${dynamic}, no GI yet)`);
}, DYNAMIC);

// Wave wall-time: enable → renderSuspended back to false. Worst frame is
// sampled on the same rAF chain (it keeps ticking while the wave runs).
const result = await page.evaluate(async () => {
  const engine = globalThis.__engine;
  // Definitive wave window: trap every assignment to renderSuspended (a poll
  // can miss a wave that never yields to timers).
  const marks = [];
  let suspended = engine.renderSuspended ?? false;
  Object.defineProperty(engine, "renderSuspended", {
    configurable: true,
    get: () => suspended,
    set: (v) => { suspended = v; marks.push([performance.now(), !!v]); },
  });
  const t0 = performance.now();
  const giEntity = engine.createEntity({ name: "GI" });
  globalThis.__gi = giEntity.addComponent("global-illumination", {
    autoFit: true, quality: "high", intensity: 1, reflections: true,
  });
  let worst = 0, last = performance.now(), sawSuspend = false, waveEnd = 0;
  // Suspend transitions are polled on a TIMER, not rAF: the wave yields with
  // setTimeout(0), so interval callbacks interleave with it even if frames
  // are starved (an rAF-only poll can miss the whole suspended window).
  await new Promise((resolve) => {
    const step = (now) => {
      const d = now - last;
      last = now;
      if (d > worst) worst = d;
      // Exit off the recorded transitions, not a poll: true→false is logged by
      // the setter even when the wave never yields to timers.
      if (marks.some(([, v]) => v)) sawSuspend = true;
      if (sawSuspend && !waveEnd && !suspended) waveEnd = now;
      if (now - t0 < 90000 && !(waveEnd && now - waveEnd > 1500)) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
  // Steady-state frame time after the wave (main-thread rAF deltas).
  const deltas = [];
  await new Promise((resolve) => {
    let l = performance.now();
    const start = l;
    const step = (now) => {
      deltas.push(now - l);
      l = now;
      if (now - start < 4000) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
  deltas.sort((a, b) => a - b);
  // GPU time is what moves when the per-pixel GI shader gets cheaper — rAF
  // deltas are vsync-capped (8.3ms at 120Hz) and hide it entirely.
  const gpuSamples = [];
  await new Promise((resolve) => {
    const t = setInterval(() => {
      const g = engine.stats?.readout?.gpuMs ?? 0;
      if (g > 0) gpuSamples.push(g);
      if (gpuSamples.length >= 40) { clearInterval(t); resolve(); }
    }, 100);
    setTimeout(() => { clearInterval(t); resolve(); }, 9000);
  });
  gpuSamples.sort((a, b) => a - b);
  const firstOn = marks.find(([, v]) => v);
  const lastOff = [...marks].reverse().find(([, v]) => !v);
  return {
    gpuMs: gpuSamples.length ? gpuSamples[Math.floor(gpuSamples.length / 2)] : null,
    gpuSampleCount: gpuSamples.length,
    waveMs: waveEnd ? waveEnd - t0 : null,
    markedWaveMs: firstOn && lastOff && lastOff[0] > firstOn[0] ? lastOff[0] - firstOn[0] : null,
    marks: marks.map(([t, v]) => `${(t - t0).toFixed(0)}ms=${v}`).join(" "),
    worst,
    sawSuspend,
    median: deltas[Math.floor(deltas.length / 2)],
    p95: deltas[Math.floor(deltas.length * 0.95)],
    cacheSize: engine.renderer._nodes.nodeBuilderCache.size,
  };
});

console.log(
  `\n=== GI-BK ${DYNAMIC ? "DYNAMIC (pre-fix behaviour)" : "RESOLVED (fixed)"} ===\n` +
    `compile wave wall-time : ${result.markedWaveMs === null ? "n/a (no suspend recorded)" : `${(result.markedWaveMs / 1000).toFixed(1)}s`}` +
    `   [transitions: ${result.marks || "none"}]\n` +
    `worst main-thread frame: ${result.worst.toFixed(0)}ms\n` +
    `steady frame (median)  : ${result.median.toFixed(1)}ms   p95 ${result.p95.toFixed(1)}ms (vsync-capped)\n` +
    `GPU time (median)      : ${result.gpuMs === null ? "n/a (no timestamp queries)" : `${result.gpuMs.toFixed(2)}ms`} over ${result.gpuSampleCount} samples\n` +
    `node builder cache     : ${result.cacheSize}`,
);

await browser.close();
process.exit(0);
