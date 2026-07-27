// Mirror-quality check: Cornell room, one MIRROR sphere (roughness 0.05,
// metalness 1) and one mid-rough metal sphere (roughness 0.3). The mirror
// sphere must show crisp red/green wall regions (left/right of its
// silhouette) and the lamp glint; the rough sphere should be stable (no
// banding) but softer. Samples pixel colors on both spheres.
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
page.on("console", (message) => {
  const text = message.text();
  if (/\[gi\]|GI-MR|pageerror/.test(text)) console.log(`${message.type()}: ${text}`);
});
page.on("pageerror", (error) => console.log(`pageerror: ${error.stack ?? error.message}`));
page.on("error", (error) => console.log(`PAGE CRASHED: ${error.message}`));
page.on("console", (m) => { if (m.type() === "error") console.log(`console.error: ${m.text().slice(0, 300)}`); });

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
  addBox([6, 0.1, 6], [0, -0.05, 0], 0xcccccc, "floor");
  addBox([6, 0.1, 6], [0, 5.05, 0], 0xb8c3cf, "ceiling");
  addBox([6, 5, 0.1], [0, 2.5, -3.05], 0xb8c3cf, "back");
  addBox([0.1, 5, 6], [-3.05, 2.5, 0], 0x9f2418, "red");
  addBox([0.1, 5, 6], [3.05, 2.5, 0], 0x3a9f24, "green");

  const lampMaterial = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 1 });
  lampMaterial.emissive = new THREE.Color(0xffffff);
  lampMaterial.emissiveIntensity = 10;
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.4, 24, 16), lampMaterial);
  lamp.position.set(0, 4.4, 0.4);
  lamp.name = "lamp";
  engine.scene.add(lamp);

  const mirror = new THREE.Mesh(
    new THREE.SphereGeometry(1.0, 48, 32),
    new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.05, metalness: 1 }),
  );
  mirror.position.set(-1.1, 1.0, 0.4);
  mirror.name = "mirrorSphere";
  engine.scene.add(mirror);

  const roughMetal = new THREE.Mesh(
    new THREE.SphereGeometry(0.7, 48, 32),
    new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.3, metalness: 1 }),
  );
  roughMetal.position.set(1.4, 0.7, 0.8);
  roughMetal.name = "roughSphere";
  engine.scene.add(roughMetal);

  const giEntity = engine.createEntity({ name: "GI" });
  giEntity.addComponent("global-illumination", { autoFit: true, quality: "high", intensity: 1 });

  engine.camera.position.set(0.1, 1.9, 5.6);
  engine.camera.lookAt(0, 1.4, 0);
  engine.camera.updateMatrixWorld(true);
  console.log("GI-MR scene ready");
});

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitForWave = async (extra = 1500) => {
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const suspended = await page.evaluate(() => globalThis.__engine?.renderSuspended === true);
    if (!suspended) break;
  }
  await new Promise((r) => setTimeout(r, extra));
};

await settle(12000);
await waitForWave(2000);

const points = await page.evaluate(() => {
  const engine = globalThis.__engine;
  const THREE = globalThis.__THREE;
  engine.camera.updateMatrixWorld(true);
  const canvas = [...document.querySelectorAll("canvas")].sort((a, b) => b.width * b.height - a.width * a.height)[0];
  const rect = canvas.getBoundingClientRect();
  const project = (v, tag) => {
    const projected = v.clone().project(engine.camera);
    return {
      tag,
      px: Math.round(rect.x + ((projected.x + 1) / 2) * rect.width),
      py: Math.round(rect.y + ((1 - projected.y) / 2) * rect.height),
    };
  };
  // Mirror sphere at (-1.1, 1.0, 0.4) r=1: sample its left edge (should
  // reflect RED wall), right edge (GREEN wall), top (ceiling/lamp).
  return [
    project(new THREE.Vector3(-1.85, 1.0, 1.0), "mirrorLeft"),
    project(new THREE.Vector3(-0.35, 1.0, 1.05), "mirrorRight"),
    project(new THREE.Vector3(-1.1, 1.75, 0.9), "mirrorTop"),
    project(new THREE.Vector3(1.0, 0.7, 1.4), "roughLeft"),
    project(new THREE.Vector3(1.8, 0.7, 1.35), "roughRight"),
  ];
});
const shot = await page.screenshot({ path: "scripts/gi-diag-mirror.png" });
const { data, info } = await sharp(shot).raw().toBuffer({ resolveWithObject: true });
for (const point of points) {
  const idx = (point.py * info.width + point.px) * info.channels;
  console.log(`${point.tag}: rgb(${data[idx]}, ${data[idx + 1]}, ${data[idx + 2]})`);
}
console.log("SHOT scripts/gi-diag-mirror.png");
await browser.close();
process.exit(0);
