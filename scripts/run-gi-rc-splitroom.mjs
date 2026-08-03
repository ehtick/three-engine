// User's repro: room with lamp near ceiling, then a THICK slab splitting
// the room horizontally under the lamp. The floor below the slab must go
// DARK (only faint indirect), the top half stays lit. Measures floor
// luminance with and without the slab.
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
  if (/\[gi\]|GI-SR|pageerror/.test(text)) console.log(`${message.type()}: ${text}`);
});
page.on("pageerror", (error) => console.log(`pageerror: ${error.stack ?? error.message}`));

await page.goto(url, { waitUntil: "load", timeout: 30000 });
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
});
await new Promise((resolve) => setTimeout(resolve, 5000));

await page.evaluate(async ({ QUALITY, SPREAD, THIN, LAMPY }) => {
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
  lamp.position.set(0, LAMPY, 0.3);
  lamp.name = "lamp";
  engine.scene.add(lamp);

  // SPREAD inflates the AUTO-FIT VOLUME without changing the room, by parking
  // a small marker far away. That is the user's real situation and the one this
  // rig could never reproduce before: their scene is 42m across, so occupancy
  // voxels are coarse (0.25m at low, 0.175m at medium) while the walls that
  // have to seal stay thin. A small room seals at every tier precisely because
  // its voxels are fine — which is why "splitroom passes" was never evidence
  // that a BIG scene seals.
  if (SPREAD > 0) {
    const marker = addBox([0.4, 0.4, 0.4], [SPREAD, 0, SPREAD], 0x404040, "farMarker");
    marker.name = "farMarker";
  }

  // Thick slab splitting the room, 0.8m below the lamp (like the user's).
  const slab = new THREE.Mesh(new THREE.BoxGeometry(4.8, THIN, 4.8), material(0xd0d0d0));
  slab.position.set(0, 2.2, 0);
  slab.name = "slab";
  engine.scene.add(slab);
  globalThis.__slab = slab;

  const giEntity = engine.createEntity({ name: "GI" });
  giEntity.object3D.position.set(0, 2, 0);
  giEntity.addComponent("global-illumination", {
    autoFit: true, quality: QUALITY, intensity: 1,
  });

  engine.camera.position.set(0.4, 1.2, 4.6);
  engine.camera.lookAt(-0.2, 0.9, -0.5);
  engine.camera.updateMatrixWorld(true);
  console.log("GI-SR scene ready");
}, {
  QUALITY: process.env.QUALITY ?? "medium",
  SPREAD: Number(process.env.SPREAD ?? 0),
  THIN: Number(process.env.THIN ?? 0.6),
  // Clearance between the lamp and the slab. Exists to test whether a leak is
  // the light's own SELF-EXCLUSION region reaching the occluder: that region
  // scales with the SDF cell size, so it grows on a big volume at a low tier.
  LAMPY: Number(process.env.LAMPY ?? 3.3),
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

await settle(11000);
await waitForWave(2000);

async function measureFloor(tag) {
  const points = await page.evaluate(() => {
    const engine = globalThis.__engine;
    const THREE = globalThis.__THREE;
    engine.camera.updateMatrixWorld(true);
    const canvas = [...document.querySelectorAll("canvas")].sort((a, b) => b.width * b.height - a.width * a.height)[0];
    const rect = canvas.getBoundingClientRect();
    const out = [];
    for (const x of [-1.63, -0.82, -0.21, 0.28, 0.79, 1.58]) {
      const world = new THREE.Vector3(x, 0.06, 0.33);
      const projected = world.clone().project(engine.camera);
      if (Math.abs(projected.x) > 0.98 || Math.abs(projected.y) > 0.98) continue;
      const px = rect.x + ((projected.x + 1) / 2) * rect.width;
      const py = rect.y + ((1 - projected.y) / 2) * rect.height;
      out.push({ x, px: Math.round(px), py: Math.round(py) });
    }
    return out;
  });
  const shot = await page.screenshot({ path: `scripts/gi-diag-splitroom-${tag}.png` });
  const { data, info } = await sharp(shot).raw().toBuffer({ resolveWithObject: true });
  console.log(
    `${tag} floor-below:`,
    points
      .map((point) => {
        const idx = (point.py * info.width + point.px) * info.channels;
        const luma = Math.round(0.2126 * data[idx] + 0.7152 * data[idx + 1] + 0.0722 * data[idx + 2]);
        return `x=${point.x}:L${luma}`;
      })
      .join(" "),
  );
}

await measureFloor("with-slab");

await page.evaluate(() => {
  globalThis.__slab.visible = false;
  globalThis.__engine.modules.get("gi").system.requestRebuild();
});
await settle(4000);
await waitForWave(2000);
await measureFloor("no-slab");

await browser.close();
process.exit(0);
