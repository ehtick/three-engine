// Perf harness: user-scale split room (same scene as run-gi-rc-lowerroom),
// measures rAF frame deltas at rest and while continuously dragging the
// knot (8s), plus occupancy determinism after the drag returns to rest.
import puppeteer from "puppeteer-core";

const url = process.argv[2] ?? "http://localhost:5201/";
const quality = process.env.GI_QUALITY ?? "high";
const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
page.on("console", (message) => {
  const text = message.text();
  if (/\[gi\]|GI-PF|pageerror/.test(text)) console.log(`${message.type()}: ${text}`);
});
page.on("pageerror", (error) => console.log(`pageerror: ${error.stack ?? error.message}`));

await page.goto(url, { waitUntil: "load", timeout: 30000 });
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
});
await new Promise((resolve) => setTimeout(resolve, 5000));

await page.evaluate(async (giQuality) => {
  const { THREE } = await import("/src/engine/index.js");
  await import("/src/modules/index.js");
  const { enableEngineModule } = await import("/src/engine/modules.js");
  const { ensureEngine } = await import("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  await enableEngineModule(engine, "gi");
  globalThis.__engine = engine;

  const material = (color) =>
    new THREE.MeshStandardNodeMaterial({ color, roughness: 0.9, metalness: 0, side: THREE.DoubleSide });
  const addPlane = (size, position, rotation, color, name) => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(...size), material(color));
    mesh.position.set(...position);
    mesh.rotation.set(...rotation);
    mesh.name = name;
    engine.scene.add(mesh);
    return mesh;
  };
  addPlane([60, 60], [0, 0, 0], [-Math.PI / 2, 0, 0], 0xcccccc, "ground");
  addPlane([12, 12], [0, 9, 0], [Math.PI / 2, 0, 0], 0xb8c3cf, "ceiling");
  addPlane([12, 9], [0, 4.5, -6], [0, Math.PI, 0], 0xb8c3cf, "back");
  addPlane([12, 9], [-6, 4.5, 0], [0, -Math.PI / 2, 0], 0x9f2418, "red");
  addPlane([12, 9], [6, 4.5, 0], [0, Math.PI / 2, 0], 0x3a9f24, "green");
  addPlane([12, 12], [0, 4.5, 0], [-Math.PI / 2, 0, 0], 0xd0d0d0, "slab");

  const lampMaterial = () => {
    const m = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 1 });
    m.emissive = new THREE.Color(0xffffff);
    m.emissiveIntensity = 8;
    return m;
  };
  const upperLamp = new THREE.Mesh(new THREE.SphereGeometry(0.5, 24, 16), lampMaterial());
  upperLamp.position.set(0, 8.2, 0);
  engine.scene.add(upperLamp);
  const midLamp = new THREE.Mesh(new THREE.SphereGeometry(0.6, 24, 16), lampMaterial());
  midLamp.position.set(1.6, 2.2, 1.0);
  engine.scene.add(midLamp);

  const knot = new THREE.Mesh(
    new THREE.TorusKnotGeometry(0.9, 0.32, 220, 24),
    new THREE.MeshStandardNodeMaterial({ color: 0x888a90, roughness: 0.25, metalness: 0.9 }),
  );
  knot.position.set(-1.6, 1.5, 0.6);
  knot.name = "knot";
  engine.scene.add(knot);
  globalThis.__knot = knot;

  const giEntity = engine.createEntity({ name: "GI" });
  giEntity.addComponent("global-illumination", { autoFit: true, quality: giQuality, intensity: 1 });

  engine.camera.position.set(0.4, 4.2, 16.5);
  engine.camera.lookAt(0, 3.6, 0);
  engine.camera.updateMatrixWorld(true);
  console.log("GI-PF scene ready");
}, quality);

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

async function measureFrames(tag, ms, drag) {
  const stats = await page.evaluate(
    async ({ ms, drag }) => {
      const engine = globalThis.__engine;
      const knot = globalThis.__knot;
      const deltas = [];
      const start = performance.now();
      let last = start;
      return await new Promise((resolve) => {
        const step = (now) => {
          deltas.push(now - last);
          last = now;
          if (drag) {
            const t = (now - start) / 1000;
            knot.position.x = -1.6 + Math.sin(t * 2.2) * 2.2;
            knot.position.z = 0.6 + Math.cos(t * 1.7) * 1.4;
            knot.updateMatrixWorld(true);
          }
          if (now - start < ms) requestAnimationFrame(step);
          else {
            deltas.shift();
            const sorted = [...deltas].sort((a, b) => a - b);
            resolve({
              avg: deltas.reduce((a, b) => a + b, 0) / deltas.length,
              p95: sorted[Math.floor(sorted.length * 0.95)],
              worst: sorted[sorted.length - 1],
              frames: deltas.length,
            });
          }
        };
        requestAnimationFrame(step);
      });
    },
    { ms, drag },
  );
  console.log(
    `${tag}: avg ${stats.avg.toFixed(1)}ms p95 ${stats.p95.toFixed(1)}ms worst ${stats.worst.toFixed(1)}ms (${stats.frames} frames)`,
  );
}

const occupancy = () =>
  page.evaluate(async () => {
    const engine = globalThis.__engine;
    const volume = engine.modules.get("gi").system.state.volume;
    const data = new Float32Array(await engine.renderer.getArrayBufferAsync(volume.stagingBuffer.value));
    let occ = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0.5) occ++;
    return occ;
  });

await measureFrames("rest", 4000, false);
const occBefore = await occupancy();
await measureFrames("drag", 8000, true);
await page.evaluate(() => {
  globalThis.__knot.position.set(-1.6, 1.5, 0.6);
  globalThis.__knot.updateMatrixWorld(true);
});
await settle(1500);
await waitForWave(1500);
const occAfter = await occupancy();
console.log(`occupancy rest=${occBefore} afterDrag=${occAfter} drift=${occAfter - occBefore}`);

await browser.close();
process.exit(0);
