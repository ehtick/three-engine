// Move-cost check: frame-time overhead of continuously animating an object
// while the GI module is live (per-frame SDF/brick dirtying), against a
// static baseline — plus a correctness check that the object's GI shadow
// actually follows it instead of sticking to its old position.
// Env: THROTTLE=0 disables the move throttle (globalThis.__giNoMoveThrottle),
// DIRTY=0 disables dirty-brick invalidation (globalThis.__giNoDirtyBrick),
// HEADED=1, TAG=<suffix> (default "on").
import puppeteer from "puppeteer-core";
import sharp from "sharp";

const url = process.argv[2] ?? "http://localhost:5233/";
const TAG = process.env.TAG ?? "on";
const NO_THROTTLE = process.env.THROTTLE === "0";
const NO_DIRTY = process.env.DIRTY === "0";
// HEAVY=1: walls + a prop ring → a much larger auto-fit volume and ~30
// active slots, so the whole-volume composite genuinely exceeds the vsync
// budget — the base scene is light enough that both A/B configs pin at the
// display's refresh rate and the frame-time delta reads as zero. Walls also
// pin the auto-fit bounds, removing the mid-swing refit nondeterminism.
const HEAVY = process.env.HEAVY === "1";

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 840, deviceScaleFactor: 1 });
let sdfLog = "";
page.on("console", (message) => {
  const text = message.text();
  if (/mesh SDF (baked|loaded)/.test(text)) sdfLog += `${text}\n`;
  if (/\[gi\]|GI-MV/.test(text) || message.type() === "error") console.log(`${message.type()}: ${text}`);
});
page.on("pageerror", (error) => console.log(`pageerror: ${error.stack ?? error.message}`));

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
await new Promise((r) => setTimeout(r, 3000));

await page.evaluate(async ({ NO_THROTTLE, NO_DIRTY, HEAVY }) => {
  if (NO_THROTTLE) globalThis.__giNoMoveThrottle = true;
  if (NO_DIRTY) globalThis.__giNoDirtyBrick = true;
  const { THREE } = await import("/src/engine/index.js");
  await import("/src/modules/index.js");
  const { enableEngineModule } = await import("/src/engine/modules.js");
  const { ensureEngine } = await import("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  await enableEngineModule(engine, "gi");
  globalThis.__engine = engine;
  globalThis.__THREE = THREE;

  const mat = (color, roughness = 0.9) => new THREE.MeshStandardNodeMaterial({ color, roughness, metalness: 0 });
  const floor = new THREE.Mesh(new THREE.BoxGeometry(16, 0.2, 16), mat(0xffffff));
  floor.position.set(0, -0.1, 0);
  engine.scene.add(floor);

  const lampMaterial = new THREE.MeshStandardNodeMaterial({ color: 0x000000, roughness: 1 });
  lampMaterial.emissive = new THREE.Color(0xffffff);
  lampMaterial.emissiveIntensity = 10;
  const lamp = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.12, 1.6), lampMaterial);
  lamp.position.set(0, 5.2, 0);
  engine.scene.add(lamp);

  // Same 16k-tri knot as the hi-res SDF harness — qualifies for the 128³
  // hi-res mesh-SDF block, so the "mesh SDF (baked|loaded)" wait applies.
  const knot = new THREE.Mesh(new THREE.TorusKnotGeometry(1.0, 0.28, 200, 40), mat(0xb8b8c0, 0.8));
  knot.position.set(0, 2.2, 0);
  knot.rotation.x = Math.PI / 2;
  knot.name = "knot";
  engine.scene.add(knot);
  globalThis.__knot = knot;

  if (HEAVY) {
    // Four SOLID slab walls (each an exact analytic box slot — no bake
    // latency, no inverted-shell detection to depend on) + a ring of props.
    const slab = (w, h, d, x, y, z) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(0xd8d8d8, 0.95));
      m.position.set(x, y, z);
      engine.scene.add(m);
    };
    slab(10.4, 5, 0.2, 0, 2.5, -5.1);
    slab(10.4, 5, 0.2, 0, 2.5, 5.1);
    slab(0.2, 5, 10.4, -5.1, 2.5, 0);
    slab(0.2, 5, 10.4, 5.1, 2.5, 0);
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      const prop = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.2, 0.6), mat(0x9aa4b0, 0.85));
      prop.position.set(Math.cos(a) * 4.0, 0.6, Math.sin(a) * 4.0);
      engine.scene.add(prop);
    }
  }

  const giEntity = engine.createEntity({ name: "GI" });
  giEntity.addComponent("global-illumination", {
    autoFit: true,
    quality: "high",
    intensity: 1,
    emissiveShadows: true,
    reflections: true,
  });
  console.log("GI-MV scene ready");
}, { NO_THROTTLE, NO_DIRTY, HEAVY });

const settle = (ms) => new Promise((r) => setTimeout(r, ms));
await settle(6000);
for (let i = 0; i < 90; i++) {
  await settle(1000);
  if (!(await page.evaluate(() => globalThis.__engine?.renderSuspended === true))) break;
}
// The knot SDF bakes async in the worker — wait for it to land.
for (let i = 0; i < 60 && !/mesh SDF/.test(sdfLog); i++) await settle(1000);
await settle(4000);
// `engine.camera` is the ViewportPanel's and can mount late (known flake).
for (let i = 0; i < 30; i++) {
  if (await page.evaluate(() => !!globalThis.__engine?.camera)) break;
  await settle(500);
}

await page.evaluate(() => {
  const engine = globalThis.__engine;
  const viewport = globalThis.__viewport;
  engine.camera.position.set(4.5, 7.5, 6.5);
  if (viewport?.orbit) {
    viewport.orbit.target.set(0, 0.4, 0);
    viewport.orbit.update();
  }
  engine.camera.lookAt(0, 0.4, 0);
  engine.camera.updateMatrixWorld(true);
  engine.camera.layers.disable(31);
  engine.scene.traverse((o) => {
    if (o.isGridHelper || o.type === "GridHelper") o.visible = false;
  });
});
await settle(1500);

// Frame-time cost: 6s of continuous knot motion, then a 3s static baseline.
// The first 10 frames of each run are warmup and excluded from the stats.
const measure = async (tag, ms, move) => {
  const stats = await page.evaluate(
    ({ ms, move }) => {
      const knot = globalThis.__knot;
      const deltas = [];
      let frame = 0;
      const start = performance.now();
      let last = start;
      return new Promise((resolve) => {
        const step = (now) => {
          frame++;
          if (frame > 10) deltas.push(now - last);
          last = now;
          if (move) knot.position.x = 2.2 * Math.sin(performance.now() * 0.0011);
          if (now - start < ms) {
            requestAnimationFrame(step);
          } else {
            const sorted = [...deltas].sort((a, b) => a - b);
            const round2 = (n) => Math.round(n * 100) / 100;
            resolve({
              avg: round2(deltas.reduce((a, b) => a + b, 0) / deltas.length),
              p95: round2(sorted[Math.floor(sorted.length * 0.95)]),
              worst: round2(sorted[sorted.length - 1]),
              frames: deltas.length,
            });
          }
        };
        requestAnimationFrame(step);
      });
    },
    { ms, move },
  );
  console.log(`${tag}: avg ${stats.avg} ms  p95 ${stats.p95} ms  worst ${stats.worst} ms  (${stats.frames} frames)`);
  return stats;
};

await measure("move", 6000, true);
await measure("static", 3000, false);

// Correctness: the shadow must follow the knot to its new resting spot
// rather than staying behind at the old one.
await page.evaluate(() => {
  globalThis.__knot.position.x = 2.0;
});
await settle(2500);

const box = await page.evaluate(() => {
  const c = [...document.querySelectorAll("canvas")]
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height)[0];
  return { x: c.r.x, y: c.r.y, width: c.r.width, height: c.r.height };
});
const png = await page.screenshot({ clip: box });
const out = `scripts/gi-diag-move-cost-${TAG}.png`;
await sharp(png).toFile(out);
const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const at = (fx, fy) => {
  const px = Math.min(info.width - 1, Math.max(0, Math.round(fx * info.width)));
  const py = Math.min(info.height - 1, Math.max(0, Math.round(fy * info.height)));
  const i = (py * info.width + px) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
};

const points = await page.evaluate(() => {
  const engine = globalThis.__engine;
  const THREE = globalThis.__THREE;
  engine.camera.updateMatrixWorld(true);
  const project = (x, y, z) => {
    const v = new THREE.Vector3(x, y, z).project(engine.camera);
    return [(v.x + 1) / 2, (1 - v.y) / 2];
  };
  return {
    // NOT directly under the knot: the lamp at x=0 projects the knot's
    // occlusion outward — a knot point at (2.0, 2.2) lands on the floor at
    // x = 2.0 · 5.2/(5.2−2.2) ≈ 3.5. Sampling at x=2.0 would sit on the
    // penumbra edge and make the PASS margin luck.
    shadowCentre: project(3.4, 0.02, 0), // centre of the cast shadow — expect dark
    oldSide: project(-2.0, 0.02, 0), // where it swung from — expect lit
    openFloor: project(0, 0.02, 3.5), // open floor reference
  };
});

console.log(`\n=== move cost (${TAG}) ===`);
const shadowCentre = Math.round(lum(at(...points.shadowCentre)));
const oldSide = Math.round(lum(at(...points.oldSide)));
const openFloor = Math.round(lum(at(...points.openFloor)));
console.log(`shadow-centre: ${shadowCentre}`);
console.log(`old-side: ${oldSide}`);
console.log(`open-floor: ${openFloor}`);
const pass = oldSide > shadowCentre + 15;
console.log(
  pass
    ? `PASS: old-side ${oldSide} > shadow-centre+15 (${shadowCentre + 15})`
    : `FAIL: old-side ${oldSide} <= shadow-centre+15 (${shadowCentre + 15})`,
);
console.log(`SHOT ${out}`);
await browser.close();
