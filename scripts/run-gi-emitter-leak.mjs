// Big-panel emitter vs a ceiling: three checks in one two-story scene.
//   1. LEAK — a 2×2 emissive panel 0.9m under a slab; the room ABOVE the
//      slab must stay dark straight over the panel. The old bounding-sphere
//      trace exclusion (~2.3m here) swallowed the slab → a circle of light
//      on the upper ceiling ("light licking through a wall").
//   2. RING — radial luminance profile on the slab's underside around the
//      panel must fall off smoothly; the old exclusion boundary painted a
//      ring of sudden penumbra onset ("dirty shadows").
//   3. TINT — a mirror ball next to a TEXTURED cube: the reflection must
//      carry the texture's mean color, not flat white.
//
// Env: SPHERE=1 legacy sphere-emitter model, NOTINT=1 disable the texture
// mean-color, HEADED=1, TAG=<suffix>.
import puppeteer from "puppeteer-core";
import sharp from "sharp";

const url = process.argv[2] ?? "http://localhost:5233/";
const SPHERE = !!process.env.SPHERE;
const NOTINT = !!process.env.NOTINT;
const TAG = process.env.TAG ?? `${SPHERE ? "sphere" : "box"}${NOTINT ? "-notint" : ""}`;

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 840, deviceScaleFactor: 1 });
page.on("console", (message) => {
  const text = message.text();
  if (/\[gi\]|GI-EL/.test(text) || message.type() === "error") console.log(`${message.type()}: ${text}`);
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

await page.evaluate(
  async ({ SPHERE, NOTINT }) => {
    if (SPHERE) globalThis.__giSphereEmitters = true;
    if (NOTINT) globalThis.__giNoTextureTint = true;
    const { THREE } = await import("/src/engine/index.js");
    await import("/src/modules/index.js");
    const { enableEngineModule } = await import("/src/engine/modules.js");
    const { ensureEngine } = await import("/src/editor/engineInstance.js");
    const engine = await ensureEngine();
    await enableEngineModule(engine, "gi");
    globalThis.__engine = engine;
    globalThis.__THREE = THREE;

    const mat = (color, roughness = 0.9, metalness = 0) =>
      new THREE.MeshStandardNodeMaterial({ color, roughness, metalness });

    const floor = new THREE.Mesh(new THREE.BoxGeometry(14, 0.2, 14), mat(0xffffff));
    floor.position.set(0, -0.1, 0);
    engine.scene.add(floor);

    // The panel lamp, floating 0.9m below the slab.
    const lampMaterial = new THREE.MeshStandardNodeMaterial({ color: 0x000000, roughness: 1 });
    lampMaterial.emissive = new THREE.Color(0xffffff);
    lampMaterial.emissiveIntensity = 8;
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(2, 0.12, 2), lampMaterial);
    lamp.position.set(0, 3.0, 0);
    engine.scene.add(lamp);

    // Ceiling slab of the lower room = floor of the room above.
    const slab = new THREE.Mesh(new THREE.BoxGeometry(8, 0.3, 8), mat(0xffffff));
    slab.position.set(0, 4.15, 0);
    engine.scene.add(slab);

    // Upper room's ceiling — the surface the leak used to paint a circle on.
    const upper = new THREE.Mesh(new THREE.BoxGeometry(8, 0.2, 8), mat(0xffffff));
    upper.position.set(0, 7.0, 0);
    engine.scene.add(upper);

    // TINT check: red/blue checker texture (mean ≈ magenta) + mirror ball.
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext("2d");
    for (let y = 0; y < 2; y++)
      for (let x = 0; x < 2; x++) {
        ctx.fillStyle = (x + y) % 2 ? "#0000ff" : "#ff0000";
        ctx.fillRect(x * 32, y * 32, 32, 32);
      }
    const checker = new THREE.CanvasTexture(canvas);
    checker.colorSpace = THREE.SRGBColorSpace;
    // Placed so the TINT camera keeps the cube OFF-SCREEN: screen-space
    // reflections can only reflect rasterized pixels, so an off-screen
    // cube's reflection in the ball can come ONLY from the GI field.
    const cubeMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0 });
    cubeMat.map = checker;
    const cube = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), cubeMat);
    cube.position.set(0, 1.0, -2.4);
    engine.scene.add(cube);

    const ballMat = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0, metalness: 1 });
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.9, 48, 32), ballMat);
    ball.position.set(0, 1.0, -4.6);
    engine.scene.add(ball);

    const giEntity = engine.createEntity({ name: "GI" });
    // ONE PROPERTY on the component. `emissiveShadows` is not something any
    // preset turns on, so a probe that needs it forces it through the
    // measurement hatch — see src/modules/gi/giConfig.js.
    globalThis.__giConfigOverride = { emissiveShadows: true, reflections: true };
    giEntity.addComponent("global-illumination", { quality: "high" });
    console.log("GI-EL scene ready");
  },
  { SPHERE, NOTINT },
);

const settle = (ms) => new Promise((r) => setTimeout(r, ms));
await settle(6000);
for (let i = 0; i < 60; i++) {
  await settle(1000);
  if (!(await page.evaluate(() => globalThis.__engine?.renderSuspended === true))) break;
}
await settle(3500);

const aim = async (eye, target) => {
  await page.evaluate(({ eye, target }) => {
    const engine = globalThis.__engine;
    const viewport = globalThis.__viewport;
    engine.camera.position.set(...eye);
    if (viewport?.orbit) {
      viewport.orbit.target.set(...target);
      viewport.orbit.update();
    }
    engine.camera.lookAt(...target);
    engine.camera.updateMatrixWorld(true);
    engine.camera.layers.disable(31);
    engine.scene.traverse((o) => {
      if (o.isGridHelper || o.type === "GridHelper") o.visible = false;
    });
  }, { eye, target });
  await settle(1000);
};

const grab = async (tag) => {
  const box = await page.evaluate(() => {
    const c = [...document.querySelectorAll("canvas")]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height)[0];
    return { x: c.r.x, y: c.r.y, width: c.r.width, height: c.r.height };
  });
  const png = await page.screenshot({ clip: box });
  const out = `scripts/gi-diag-emitter-leak-${tag}.png`;
  await sharp(png).toFile(out);
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  return {
    out,
    at: (fx, fy) => {
      const px = Math.min(info.width - 1, Math.max(0, Math.round(fx * info.width)));
      const py = Math.min(info.height - 1, Math.max(0, Math.round(fy * info.height)));
      const i = (py * info.width + px) * info.channels;
      return [data[i], data[i + 1], data[i + 2]];
    },
  };
};
const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const project = (points) =>
  page.evaluate((pts) => {
    const engine = globalThis.__engine;
    const THREE = globalThis.__THREE;
    engine.camera.updateMatrixWorld(true);
    return pts.map(([x, y, z]) => {
      const v = new THREE.Vector3(x, y, z).project(engine.camera);
      return [(v.x + 1) / 2, (1 - v.y) / 2];
    });
  }, points);

console.log(`\n=== emitter leak/ring/tint (${TAG}) ===`);

// ---- 1. LEAK: upper-ceiling underside, straight above the panel vs off-axis.
await aim([10.5, 5.4, 10.5], [0, 5.8, 0]);
let img = await grab(`${TAG}-upper`);
{
  const pts = [
    [0, 6.88, 0], [0.5, 6.88, 0.5], [-0.5, 6.88, -0.5],
    [3.3, 6.88, 0], [-3.3, 6.88, 0], [0, 6.88, 3.3],
  ];
  const screen = await project(pts);
  const L = screen.map(([fx, fy]) => lum(img.at(fx, fy)));
  const center = (L[0] + L[1] + L[2]) / 3;
  const edge = (L[3] + L[4] + L[5]) / 3;
  console.log(`  upper ceiling above panel: center L=${center.toFixed(1)} off-axis L=${edge.toFixed(1)}` +
    `  (raw ${L.map((v) => v.toFixed(0)).join("/")})`);
  console.log(`  LEAK ${center > edge + 12 && center > 25 ? "PRESENT — circle of light through the slab" : "none"}`);
  console.log(`  shot ${img.out}`);
}

// ---- 2. RING: radial profile on the slab underside.
await aim([9.5, 1.6, 9.5], [0, 3.9, 0]);
img = await grab(`${TAG}-slab`);
{
  const pts = [];
  for (let r = 1.3; r <= 3.7; r += 0.15) pts.push([r * 0.7071, 3.99, r * 0.7071]);
  const screen = await project(pts);
  const L = screen.map(([fx, fy]) => lum(img.at(fx, fy)));
  let reversals = 0;
  for (let i = 2; i < L.length; i++) {
    const a = Math.sign(L[i - 1] - L[i - 2]);
    const b = Math.sign(L[i] - L[i - 1]);
    if (a !== 0 && b !== 0 && a !== b && Math.abs(L[i] - L[i - 1]) > 2) reversals++;
  }
  console.log(`  slab-underside radial L: ${L.map((v) => v.toFixed(0)).join(" ")}`);
  console.log(`  reversals (>2 lum): ${reversals} — a smooth pool falloff is 0-2; the exclusion ring shows as more`);
  console.log(`  shot ${img.out}`);
}

// ---- 3. TINT: the checker cube's reflection in the mirror ball. Sample a
// GRID over the ball's screen disc and take the most saturated pixel — the
// cube's reflection is somewhere on the ball, never at a guessable spot.
await aim([-3.6, 1.25, -4.6], [0, 1.0, -4.6]);
img = await grab(`${TAG}-ball`);
{
  const cubeVisible = await page.evaluate(() => {
    const engine = globalThis.__engine;
    const THREE = globalThis.__THREE;
    engine.camera.updateMatrixWorld(true);
    const v = new THREE.Vector3(0, 1.0, -2.4).project(engine.camera);
    return Math.abs(v.x) < 1.15 && Math.abs(v.y) < 1.15;
  });
  console.log(`  cube on screen: ${cubeVisible} (must be false — else SSR contaminates the check)`);
  const disc = await page.evaluate(() => {
    const engine = globalThis.__engine;
    const THREE = globalThis.__THREE;
    engine.camera.updateMatrixWorld(true);
    const c = new THREE.Vector3(0, 1.0, -4.6).project(engine.camera);
    const rim = new THREE.Vector3(0, 1.9, -4.6).project(engine.camera);
    const cx = (c.x + 1) / 2, cy = (1 - c.y) / 2;
    const ry = Math.abs((1 - rim.y) / 2 - cy);
    return { cx, cy, ry };
  });
  const samples = [];
  for (let gy = -0.7; gy <= 0.71; gy += 0.175)
    for (let gx = -0.7; gx <= 0.71; gx += 0.175) {
      if (gx * gx + gy * gy > 0.72 * 0.72) continue;
      samples.push(img.at(disc.cx + gx * disc.ry, disc.cy + gy * disc.ry));
    }
  const scored = samples.map((c) => ({ c, sat: (c[0] + c[2]) / 2 - c[1] }));
  scored.sort((a, b) => b.sat - a.sat);
  const best = scored[0];
  const bright = samples.filter((c) => Math.max(...c) > 20).length;
  console.log(`  ball disc: ${samples.length} samples, ${bright} non-dark`);
  console.log(
    `  most saturated: rgb(${best.c.join(",")}) — (R+B)/2−G = ${best.sat.toFixed(0)}: ` +
      `white reflection ⇒ ~0, texture-tinted (magenta checker) ⇒ clearly positive`,
  );
  console.log(`  shot ${img.out}`);
}
await browser.close();
