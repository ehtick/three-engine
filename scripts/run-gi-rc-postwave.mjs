// Verifies the GI compile wave warms the POSTPROCESS render context when a
// PostprocessComponent override is active (showInEditor). Before the fix,
// the wave warmed only the default-framebuffer context, so the first frame
// after resume sync-recompiled every material against the PassNode context
// — user-confirmed as ~half their startup freeze. PASS criteria:
//   1. no "[gi] first frame after compile wave took Xms" warning
//   2. measured first-frame-after-wave < 400ms
//   3. passthrough graph → scenePass has NO MRT (conditional-MRT check)
import puppeteer from "puppeteer-core";

const url = process.argv[2] ?? "http://localhost:5201/";
const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
let slowResumeWarning = null;
page.on("console", (message) => {
  const text = message.text();
  if (/first frame after compile wave/.test(text)) slowResumeWarning = text;
  if (/\[gi\]|GI-PW|pageerror/.test(text)) console.log(`${message.type()}: ${text}`);
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
  await enableEngineModule(engine, "postprocessing");
  await enableEngineModule(engine, "gi");
  globalThis.__engine = engine;

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
  engine.scene.add(lamp);

  // Camera entity with a postprocess override previewed through the EDITOR
  // camera — the exact setup where the wave used to warm the wrong context.
  const camEntity = engine.createEntity({ name: "Camera" });
  camEntity.addComponent("camera", {});
  camEntity.addComponent("postprocess", { enabled: true, showInEditor: true });
  globalThis.__postComp = camEntity.getComponent("postprocess");

  console.log("GI-PW scene ready (postprocess enabled, showInEditor)");
});

// Let the postprocess pipeline come up BEFORE GI builds, then add GI.
await new Promise((resolve) => setTimeout(resolve, 4000));
const overrideActive = await page.evaluate(() => {
  const engine = globalThis.__engine;
  for (const o of engine.renderOverrides) if (o.ownsCamera?.(engine)) return true;
  return false;
});
console.log(`override active before GI build: ${overrideActive}`);

await page.evaluate(() => {
  const engine = globalThis.__engine;
  const giEntity = engine.createEntity({ name: "GI" });
  giEntity.object3D.position.set(0, 2, 0);
  giEntity.addComponent("global-illumination", { autoFit: true, quality: "medium", intensity: 1 });
});

// Wait out the wave, then measure the first frames after resume.
for (let i = 0; i < 90; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const suspended = await page.evaluate(() => globalThis.__engine?.renderSuspended === true);
  if (i > 3 && !suspended) break;
}
const frameStats = await page.evaluate(
  () =>
    new Promise((resolve) => {
      const deltas = [];
      let last = performance.now();
      const tick = () => {
        const now = performance.now();
        deltas.push(now - last);
        last = now;
        if (deltas.length < 60) requestAnimationFrame(tick);
        else resolve({ worst: Math.max(...deltas.slice(1)), avg: deltas.reduce((a, b) => a + b, 0) / deltas.length });
      };
      requestAnimationFrame(tick);
    }),
);
console.log(`post-wave frames: worst ${frameStats.worst.toFixed(0)}ms avg ${frameStats.avg.toFixed(1)}ms`);

const mrtInfo = await page.evaluate(() => {
  const comp = globalThis.__postComp;
  return { hasMRT: !!comp?.scenePass?.getMRT?.(), needsKey: comp?._passNeedsKey ?? null };
});
console.log(`passthrough graph MRT attached: ${mrtInfo.hasMRT} (needs ${mrtInfo.needsKey})`);

const pass = !slowResumeWarning && frameStats.worst < 400 && overrideActive && !mrtInfo.hasMRT;
console.log(
  pass
    ? "PASS: wave warmed the postprocess context (no resume stall, no needless MRT)"
    : `FAIL: warning=${slowResumeWarning ?? "none"} worst=${frameStats.worst.toFixed(0)}ms override=${overrideActive} mrt=${mrtInfo.hasMRT}`,
);
await browser.close();
process.exit(pass ? 0 : 1);
