// Hi-res (128³) mesh-SDF check: a 16k-tri torus knot between an emissive
// panel and the floor. Asserts the bake actually ran at 128 (console dims),
// then profiles the knot's shadow on the floor — the 64³ bake melts the
// knot's loops together (blobby shadow), 128³ separates them.
// Env: HIRES=0 forces the legacy 64³ path (globalThis.__giNoHiResSdf),
// HEADED=1, TAG=<suffix>.
import puppeteer from "puppeteer-core";
import sharp from "sharp";

const url = process.argv[2] ?? "http://localhost:5233/";
const LEGACY = process.env.HIRES === "0";
const TAG = process.env.TAG ?? (LEGACY ? "64" : "128");

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
  if (/\[gi\]|GI-HR/.test(text) || message.type() === "error") console.log(`${message.type()}: ${text}`);
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

await page.evaluate(async ({ LEGACY }) => {
  if (LEGACY) globalThis.__giNoHiResSdf = true;
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

  // 16k tris → qualifies for the 128³ hi-res block.
  const knot = new THREE.Mesh(new THREE.TorusKnotGeometry(1.0, 0.28, 200, 40), mat(0xb8b8c0, 0.8));
  knot.position.set(0, 2.2, 0);
  knot.rotation.x = Math.PI / 2;
  engine.scene.add(knot);
  console.log(`GI-HR knot tris: ${knot.geometry.index.count / 3}`);

  const giEntity = engine.createEntity({ name: "GI" });
  // ONE PROPERTY on the component. `emissiveShadows` is not something any
  // preset turns on, so a probe that needs it forces it through the
  // measurement hatch — see src/modules/gi/giConfig.js.
  globalThis.__giConfigOverride = { emissiveShadows: true, reflections: true };
  giEntity.addComponent("global-illumination", { quality: "high" });
  console.log("GI-HR scene ready");
}, { LEGACY });

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

const box = await page.evaluate(() => {
  const c = [...document.querySelectorAll("canvas")]
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height)[0];
  return { x: c.r.x, y: c.r.y, width: c.r.width, height: c.r.height };
});
const png = await page.screenshot({ clip: box });
const out = `scripts/gi-diag-sdf-hires-${TAG}.png`;
await sharp(png).toFile(out);
const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const at = (fx, fy) => {
  const px = Math.min(info.width - 1, Math.max(0, Math.round(fx * info.width)));
  const py = Math.min(info.height - 1, Math.max(0, Math.round(fy * info.height)));
  const i = (py * info.width + px) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
};

console.log(`\n=== hi-res SDF (${TAG}) ===`);
console.log(sdfLog.trim() || "  (no SDF bake/load line captured!)");
const dims = [...sdfLog.matchAll(/: (\d+)x(\d+)x(\d+)/g)].map((m) => Math.max(+m[1], +m[2], +m[3]));
const maxDim = Math.max(0, ...dims);
console.log(`  largest baked axis: ${maxDim} — expect ${LEGACY ? "≤64" : ">64 (hi-res block)"}`);

// Shadow profile across the knot's shadow: the knot has a HOLE through its
// middle — a good SDF lets light through it (bright band between dark
// lobes); a melted 64³ blob shadows it solid.
const profile = [];
const screen = await page.evaluate(() => {
  const engine = globalThis.__engine;
  const THREE = globalThis.__THREE;
  engine.camera.updateMatrixWorld(true);
  const out = [];
  for (let x = -2.4; x <= 2.4; x += 0.15) {
    const v = new THREE.Vector3(x, 0.02, 0).project(engine.camera);
    out.push([(v.x + 1) / 2, (1 - v.y) / 2]);
  }
  return out;
});
for (const [fx, fy] of screen) profile.push(Math.round(lum(at(fx, fy))));
console.log(`  floor shadow profile (x −2.4..2.4): ${profile.join(" ")}`);
const mid = profile.slice(12, 21);
console.log(`  centre band (under the knot hole): min ${Math.min(...mid)} max ${Math.max(...mid)}`);
console.log(`SHOT ${out}`);
await browser.close();
