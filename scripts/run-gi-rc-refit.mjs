// Verifies the IN-PLACE auto-fit refit: moving an object far enough to
// change the fitted bounds must NOT trigger a rebuild + compile wave (the
// "10s freeze after I release the drag" report). World params are uniforms
// (sdfScene world bundle), so a refit is a uniform update + recomposite.
// PASS criteria:
//   1. "[gi] auto-fit: refit in place (no recompile)" appears after the move
//   2. renderSuspended NEVER goes true after the initial wave (no 2nd wave)
//   3. worst frame around the refit < 250ms
//   4. lamp pool still renders (floor luminance sane) after the refit
import puppeteer from "puppeteer-core";
import sharp from "sharp";

const url = process.argv[2] ?? "http://localhost:5201/";
const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
let refitLog = null;
let rebuildLog = null;
page.on("console", (message) => {
  const text = message.text();
  if (/refit in place/.test(text)) refitLog = text;
  if (/compile wave started/.test(text)) rebuildLog = (rebuildLog ?? 0) + 1;
  if (/\[gi\]|GI-RF|pageerror/.test(text)) console.log(`${message.type()}: ${text}`);
});
page.on("pageerror", (error) => console.log(`pageerror: ${error.stack ?? error.message}`));

await page.goto(url, { waitUntil: "load", timeout: 30000 });
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
});
await new Promise((resolve) => setTimeout(resolve, 5000));

await page.evaluate(async () => {
  const { THREE } = await import("/src/engine/index.js");
  await import("/src/modules/index.js");
  const { enableEngineModule } = await import("/src/engine/modules.js");
  const { ensureEngine } = await import("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  await enableEngineModule(engine, "gi");
  globalThis.__engine = engine;
  globalThis.__THREE = THREE;

  const material = (color) => new THREE.MeshStandardNodeMaterial({ color, roughness: 0.9, metalness: 0 });
  const addBox = (size, position, color, name) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material(color));
    mesh.position.set(...position);
    mesh.name = name;
    engine.scene.add(mesh);
    return mesh;
  };
  addBox([5, 0.1, 5], [0, -0.05, 0], 0xcccccc, "floor");
  addBox([5, 0.1, 5], [0, 4.05, 0], 0xb8c3cf, "ceiling");
  addBox([5, 4, 0.1], [0, 2, -2.55], 0xb8c3cf, "back");
  addBox([0.1, 4, 5], [-2.55, 2, 0], 0x9f2418, "red");
  addBox([0.1, 4, 5], [2.55, 2, 0], 0x3a9f24, "green");
  const lampMaterial = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 1 });
  lampMaterial.emissive = new THREE.Color(0xffffff);
  lampMaterial.emissiveIntensity = 10;
  const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4), lampMaterial);
  lamp.position.set(0, 3.3, 0.3);
  lamp.name = "lamp";
  engine.scene.add(lamp);
  // The prop whose move will stretch the fitted bounds.
  const crate = addBox([0.8, 0.8, 0.8], [1.6, 0.4, 1.4], 0xb08040, "crate");
  globalThis.__crate = crate;

  const giEntity = engine.createEntity({ name: "GI" });
  giEntity.object3D.position.set(0, 2, 0);
  giEntity.addComponent("global-illumination", { autoFit: true, quality: "medium", intensity: 1 });

  engine.camera.position.set(0.4, 1.2, 4.6);
  engine.camera.lookAt(-0.2, 0.9, -0.5);
  engine.camera.updateMatrixWorld(true);
  console.log("GI-RF scene ready");
});

const waitForWave = async (extra = 1500) => {
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const suspended = await page.evaluate(() => globalThis.__engine?.renderSuspended === true);
    if (i > 3 && !suspended) break;
  }
  await new Promise((r) => setTimeout(r, extra));
};
await waitForWave(2000);
const wavesAtStart = rebuildLog ?? 0;

async function floorLuma(tag) {
  const shot = await page.screenshot();
  const { data, info } = await sharp(shot).raw().toBuffer({ resolveWithObject: true });
  const point = await page.evaluate(() => {
    const engine = globalThis.__engine;
    const THREE = globalThis.__THREE;
    engine.camera.updateMatrixWorld(true);
    const canvas = [...document.querySelectorAll("canvas")].sort((a, b) => b.width * b.height - a.width * a.height)[0];
    const rect = canvas.getBoundingClientRect();
    const projected = new THREE.Vector3(-0.5, 0.06, 0.8).project(engine.camera);
    return {
      px: Math.round(rect.x + ((projected.x + 1) / 2) * rect.width),
      py: Math.round(rect.y + ((1 - projected.y) / 2) * rect.height),
    };
  });
  const idx = (point.py * info.width + point.px) * info.channels;
  const luma = Math.round(0.2126 * data[idx] + 0.7152 * data[idx + 1] + 0.0722 * data[idx + 2]);
  console.log(`${tag}: floor luma L${luma}`);
  return luma;
}

const before = await floorLuma("before-move");

// Move the crate 4m outward — well past the refit tolerance for a ~6m
// volume — and start watching frame times.
await page.evaluate(() => {
  globalThis.__frames = [];
  let last = performance.now();
  const tick = () => {
    const now = performance.now();
    globalThis.__frames.push(now - last);
    last = now;
    if (globalThis.__framesOn) requestAnimationFrame(tick);
  };
  globalThis.__framesOn = true;
  requestAnimationFrame(tick);
  // No editor event needed: the refit check runs on the periodic
  // fingerprint cadence and reads live matrices.
  globalThis.__crate.position.set(4.6, 0.4, 1.4);
});

// Refit needs: 3s cadence + 2-scan debounce → give it 12s.
await new Promise((r) => setTimeout(r, 12000));
const result = await page.evaluate(() => {
  globalThis.__framesOn = false;
  const frames = globalThis.__frames;
  return {
    worst: Math.max(...frames),
    suspended: globalThis.__engine.renderSuspended === true,
  };
});
const after = await floorLuma("after-refit");
const waves = (rebuildLog ?? 0) - wavesAtStart;

console.log(
  `refit log: ${refitLog ? "YES" : "NO"}; extra waves: ${waves}; worst frame ${result.worst.toFixed(0)}ms; ` +
    `suspended now: ${result.suspended}`,
);
const pass = !!refitLog && waves === 0 && result.worst < 250 && after > 20 && Math.abs(after - before) < 40;
console.log(pass ? "PASS: refit in place, no wave, lighting stable" : `FAIL (before L${before} after L${after})`);
await browser.close();
process.exit(pass ? 0 : 1);
