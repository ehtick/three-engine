// Penumbra physics check: one pillar, one sphere lamp — small radius vs
// large radius (energy-normalized: intensity scaled by 1/r² so the flux
// matches). The floor shadow edge behind the pillar must be SMOOTH and its
// transition width must GROW with the lamp radius.
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
  if (/\[gi\]|GI-PN|pageerror/.test(text)) console.log(`${message.type()}: ${text}`);
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
  const floor = new THREE.Mesh(new THREE.BoxGeometry(16, 0.2, 12), material(0xcccccc));
  floor.position.set(0, -0.1, 0);
  floor.name = "floor";
  engine.scene.add(floor);
  // Dim enclosure so the room isn't pure-black beyond the lamp.
  const back = new THREE.Mesh(new THREE.BoxGeometry(16, 6, 0.2), material(0x888888));
  back.position.set(0, 3, -6);
  engine.scene.add(back);

  // Pillar occluder between lamp and the measured floor strip.
  const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.35, 2.6, 0.35), material(0xb0b0b0));
  pillar.position.set(0, 1.3, 0);
  pillar.name = "pillar";
  engine.scene.add(pillar);

  const lampMaterial = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 1 });
  lampMaterial.emissive = new THREE.Color(0xffffff);
  lampMaterial.emissiveIntensity = 60; // divided by r² at runtime
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 24), lampMaterial);
  lamp.position.set(3.2, 2.6, 0);
  lamp.name = "lamp";
  engine.scene.add(lamp);
  globalThis.__lamp = lamp;
  globalThis.__setLampRadius = (r) => {
    lamp.scale.setScalar(r);
    lampMaterial.emissiveIntensity = 60 / (r * r);
    const system = engine.modules.get("gi").system;
    system.requestRebuild(); // emissive intensity change → re-promotion
  };

  const giEntity = engine.createEntity({ name: "GI" });
  giEntity.addComponent("global-illumination", { autoFit: true, quality: "high", intensity: 1 });

  engine.camera.position.set(-1.5, 5.5, 7.5);
  engine.camera.lookAt(-1.5, 0, -0.5);
  engine.camera.updateMatrixWorld(true);
  console.log("GI-PN scene ready");
});

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await settle(9000);

async function hideGrid() {
  await page.evaluate(() => {
    let hidden = 0;
    globalThis.__engine.renderer?.info; // touch
    const roots = [globalThis.__engine.scene];
    if (globalThis.__engine.scene?.parent) roots.push(globalThis.__engine.scene.parent);
    for (const root of roots) {
      root?.traverse?.((o) => {
        if (o.isGridHelper || o.type === "GridHelper") {
          o.visible = false;
          hidden++;
        }
      });
    }
    console.log(`GI-PN grid helpers hidden: ${hidden}`);
    // Editor helpers (grid, gizmos) render on layer 31 — drop the whole
    // layer from the camera so no overlay pollutes pixel probes.
    globalThis.__engine.camera.layers.disable(31);
  });
}

async function profile(tag) {
  await hideGrid();
  await new Promise((resolve) => setTimeout(resolve, 400));
  // Sample the floor along the shadow sweep line: the shadow of the pillar
  // from a lamp at x=3.2 falls toward -x. Sweep x from -5 to 0 at z=0.
  const points = await page.evaluate(() => {
    const engine = globalThis.__engine;
    const THREE = globalThis.__THREE;
    engine.camera.updateMatrixWorld(true);
    const canvas = [...document.querySelectorAll("canvas")].sort((a, b) => b.width * b.height - a.width * a.height)[0];
    const rect = canvas.getBoundingClientRect();
    const out = [];
    for (let x = -5; x <= 0.01; x += 0.1) {
      // z sweep across the shadow band (shadow runs along -x, spread in z)
      const world = new THREE.Vector3(x, 0.02, 0);
      const projected = world.clone().project(engine.camera);
      if (Math.abs(projected.x) > 0.98 || Math.abs(projected.y) > 0.98) continue;
      const px = rect.x + ((projected.x + 1) / 2) * rect.width;
      const py = rect.y + ((1 - projected.y) / 2) * rect.height;
      out.push({ x: +x.toFixed(2), px: Math.round(px), py: Math.round(py) });
    }
    return out;
  });
  const shot = await page.screenshot({ path: `scripts/gi-diag-penumbra-${tag}.png` });
  const { data, info } = await sharp(shot).raw().toBuffer({ resolveWithObject: true });
  const profile = points.map((point) => {
    const idx = (point.py * info.width + point.px) * info.channels;
    return { x: point.x, L: 0.2126 * data[idx] + 0.7152 * data[idx + 1] + 0.0722 * data[idx + 2] };
  });
  console.log(
    `${tag} xProfile(z=0):`,
    profile.filter((_, i) => i % 5 === 0).map((p) => `${p.x}:${p.L.toFixed(0)}`).join(" "),
  );
  // Perpendicular (z) profile at x=-2 to measure edge width across the band.
  const zPoints = await page.evaluate(() => {
    const engine = globalThis.__engine;
    const THREE = globalThis.__THREE;
    const canvas = [...document.querySelectorAll("canvas")].sort((a, b) => b.width * b.height - a.width * a.height)[0];
    const rect = canvas.getBoundingClientRect();
    const out = [];
    for (let z = -1.6; z <= 1.6; z += 0.05) {
      const world = new THREE.Vector3(-1.2, 0.02, z);
      const projected = world.clone().project(engine.camera);
      if (Math.abs(projected.x) > 0.98 || Math.abs(projected.y) > 0.98) continue;
      const px = rect.x + ((projected.x + 1) / 2) * rect.width;
      const py = rect.y + ((1 - projected.y) / 2) * rect.height;
      out.push({ z: +z.toFixed(2), px: Math.round(px), py: Math.round(py) });
    }
    return out;
  });
  const zProfile = zPoints.map((point) => {
    const idx = (point.py * info.width + point.px) * info.channels;
    return { z: point.z, L: 0.2126 * data[idx] + 0.7152 * data[idx + 1] + 0.0722 * data[idx + 2] };
  });
  // Edge metrics on the z-profile: min inside shadow, max outside, and the
  // 20%→80% transition width on the +z edge.
  const Ls = zProfile.map((p) => p.L);
  const minL = Math.min(...Ls);
  const maxL = Math.max(...Ls);
  const lo = minL + 0.2 * (maxL - minL);
  const hi = minL + 0.8 * (maxL - minL);
  // walk from center (min region) toward +z
  const minIdx = Ls.indexOf(minL);
  let zLo = null;
  let zHi = null;
  for (let i = minIdx; i < zProfile.length; i++) {
    if (zLo === null && zProfile[i].L >= lo) zLo = zProfile[i].z;
    if (zHi === null && zProfile[i].L >= hi) { zHi = zProfile[i].z; break; }
  }
  const width = zLo !== null && zHi !== null ? +(zHi - zLo).toFixed(2) : null;
  // Roughness metric: max second-difference along the transition (smooth
  // edges have small curvature spikes).
  let maxJump = 0;
  for (let i = 1; i < zProfile.length; i++) {
    maxJump = Math.max(maxJump, Math.abs(zProfile[i].L - zProfile[i - 1].L));
  }
  console.log(
    `${tag}: shadowMin L${minL.toFixed(0)} lit L${maxL.toFixed(0)} edgeWidth(z20-80) ${width}m maxStep ${maxJump.toFixed(0)}`,
  );
  console.log(
    `${tag} zProfile:`,
    zProfile.filter((_, i) => i % 4 === 0).map((p) => `${p.z}:${p.L.toFixed(0)}`).join(" "),
  );
}

await profile("small-noresize"); // r = 1 initial
await page.evaluate(() => globalThis.__setLampRadius(0.15));
await settle(6000);
await profile("r015");
await page.evaluate(() => globalThis.__setLampRadius(0.9));
await settle(6000);
await profile("r090");

await browser.close();
process.exit(0);
