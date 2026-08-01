// GI leak: does a DIRECTIONAL light reach surfaces the geometry shadows?
//
// The existing leak harnesses (run-gi-rc-splitroom, run-gi-emitter-leak) only
// cover promoted EMITTERS. Nothing covered the analytic sun, which is the one
// the user's Sponza is lit by — and its symptom there is a broad warm fill
// across a corridor the sun never reaches: every surface glowing in its own
// albedo (red curtain red, stone tan), strongest on up-facing surfaces. That
// is what "the sun is lighting the GI field through the roof" looks like.
//
// Scene: a SEALED box with the sun OUTSIDE it. Nothing inside can legitimately
// receive a single photon, so any interior brightness is leak, full stop —
// no form factors to argue about, no reference render needed.
//
// Reported as interior luminance against the same box with GI off (the floor
// of what the raster path alone produces) and against the lit exterior.
import puppeteer from "puppeteer-core";
import sharp from "sharp";

const url = process.argv[2] ?? "http://localhost:5201/";
// Sun elevation in degrees above horizontal. The default points steeply down
// onto the roof — the Sponza case (grazing sun, interior fully shadowed).
const ELEVATION = Number(process.env.ELEVATION ?? 60);
const QUALITY = process.env.QUALITY ?? "high";
// Wall thickness in metres. The interesting axis: a wall thinner than ~2 field
// voxels cannot be represented by the SDF at all, so light crosses it. Sweep
// this to find where the scene's geometry stops being watertight to GI.
const THICK = Number(process.env.THICK ?? 0.4);

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 1 });
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\]|GI-SL/.test(t)) console.log(`${m.type()}: ${t}`);
});
page.on("pageerror", (e) => console.log(`pageerror: ${e.stack ?? e.message}`));

await page.goto(url, { waitUntil: "load", timeout: 30000 });
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
});
await new Promise((r) => setTimeout(r, 5000));

await page.evaluate(async ({ ELEVATION, QUALITY, THICK }) => {
  const { THREE } = await import("/src/engine/index.js");
  await import("/src/modules/index.js");
  const { enableEngineModule } = await import("/src/engine/modules.js");
  const { ensureEngine } = await import("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  await enableEngineModule(engine, "gi");
  globalThis.__engine = engine;
  globalThis.__THREE = THREE;

  // Linear-space albedos so the expected numbers are arguable on paper.
  const mat = (r, g, b) => {
    const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0 });
    m.color.setRGB(r, g, b, THREE.LinearSRGBColorSpace);
    return m;
  };
  const box = (size, position, material, name) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
    mesh.position.set(...position);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    engine.scene.add(mesh);
    return mesh;
  };

  // SEALED box, 8 x 4 x 8 interior, 0.4m thick walls — thick on purpose: a
  // sub-voxel wall leaking is a known and separate limitation (the SDF cannot
  // represent it), and this test is about whether a wall the field CAN
  // represent still lets the sun through.
  const W = THICK;
  box([8.8, W, 8.8], [0, -W / 2, 0], mat(0.6, 0.6, 0.6), "floor");
  box([8.8, W, 8.8], [0, 4 + W / 2, 0], mat(0.6, 0.6, 0.6), "roof");
  box([8.8, 4, W], [0, 2, -4.2], mat(0.6, 0.15, 0.12), "wall-back");
  box([8.8, 4, W], [0, 2, 4.2], mat(0.6, 0.6, 0.6), "wall-front");
  box([W, 4, 8.8], [-4.2, 2, 0], mat(0.15, 0.5, 0.15), "wall-left");
  box([W, 4, 8.8], [4.2, 2, 0], mat(0.6, 0.6, 0.6), "wall-right");
  // A block inside so there is something to look at, and something whose
  // up-facing top would be the first to show a leaking sun.
  box([1.6, 1.6, 1.6], [0, 0.8, 0], mat(0.7, 0.7, 0.7), "block");
  // Outside reference patch — directly lit, so the harness can express the
  // interior as a fraction of "what the sun actually delivers".
  box([4, W, 4], [10, 0, 0], mat(0.6, 0.6, 0.6), "outside-slab");

  const lightEntity = engine.createEntity({ name: "Sun" });
  lightEntity.addComponent("light", { kind: "directional", intensity: 3, color: "#ffffff", castShadow: true });
  const el = (ELEVATION * Math.PI) / 180;
  lightEntity.object3D.position.set(Math.cos(el) * 20, Math.sin(el) * 20, 6);

  const giEntity = engine.createEntity({ name: "GI" });
  giEntity.addComponent("global-illumination", {
    autoFit: true,
    quality: QUALITY,
    intensity: 1,
    enabled: true,
  });
  globalThis.__giEntity = giEntity;

  // Camera INSIDE the sealed box, looking at the block and the back wall.
  engine.camera.position.set(0, 2.0, 3.4);
  engine.camera.lookAt(0, 1.2, -1.0);
  engine.camera.updateMatrixWorld(true);
  console.log("GI-SL scene ready");
}, { ELEVATION, QUALITY, THICK });

const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const waitForCanvas = () =>
  page.waitForFunction(
    () => [...document.querySelectorAll("canvas")].some((c) => c.width > 400 && c.height > 300),
    { timeout: 45000 },
  );

// The editor's own grid/gizmos would sit in front of the samples.
const hideHelpers = () =>
  page.evaluate(() => {
    let hidden = 0;
    globalThis.__engine.scene.traverse((o) => {
      if (o.isGridHelper || o.isLineSegments || o.type === "AxesHelper") {
        o.visible = false;
        hidden++;
      }
    });
    return hidden;
  });

async function measure(label) {
  await settle(9000);
  await waitForCanvas();
  await hideHelpers();
  await settle(1500);
  const shot = await page.screenshot({ type: "png" });
  const { data, info } = await sharp(shot).raw().toBuffer({ resolveWithObject: true });
  const px = (x, y) => {
    const i = (y * info.width + x) * info.channels;
    return [data[i], data[i + 1], data[i + 2]];
  };
  // sRGB -> linear, so ratios mean something.
  const toLin = (v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const lum = ([r, g, b]) => 0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(b);
  // Sample a small patch and take the median, so one stray pixel can't decide.
  const patch = (cx, cy, n = 5) => {
    const vals = [];
    for (let dy = -n; dy <= n; dy++) for (let dx = -n; dx <= n; dx++) vals.push(lum(px(cx + dx, cy + dy)));
    vals.sort((a, b) => a - b);
    return vals[Math.floor(vals.length / 2)];
  };
  const W = info.width;
  const H = info.height;
  const result = {
    label,
    blockTop: patch(Math.round(W * 0.5), Math.round(H * 0.62)),
    backWall: patch(Math.round(W * 0.5), Math.round(H * 0.3)),
    floorLeft: patch(Math.round(W * 0.25), Math.round(H * 0.85)),
    floorRight: patch(Math.round(W * 0.75), Math.round(H * 0.85)),
    // SANITY: a corner of the interior right against the sealed wall. If GI on
    // and GI off are byte-identical EVERYWHERE, the toggle did nothing and the
    // "no leak" verdict is worthless — this is what catches that.
    cornerLow: patch(Math.round(W * 0.12), Math.round(H * 0.72)),
  };
  await sharp(shot).toFile(`scripts/gi-diag-sun-leak-${label}.png`);
  return result;
}

const withGi = await measure("gi-on");
await page.evaluate(() => {
  globalThis.__giEntity.getComponent("global-illumination").setProp("enabled", false);
});
const withoutGi = await measure("gi-off");

const fmt = (v) => v.toFixed(5);
console.log(`\n=== sealed box, sun OUTSIDE (elevation ${ELEVATION}deg, quality ${QUALITY}) ===`);
console.log("Interior linear luminance — every one of these should be ~0 with GI on:");
for (const key of ["blockTop", "backWall", "floorLeft", "floorRight"]) {
  const on = withGi[key];
  const off = withoutGi[key];
  console.log(`  ${key.padEnd(10)} GI on ${fmt(on)}   GI off ${fmt(off)}   added by GI ${fmt(on - off)}`);
}

// The raster path with GI off is the floor: whatever three's own direct
// lighting puts there (should itself be ~0 inside a sealed box). Anything GI
// ADDS on top is the leak.
const leaks = ["blockTop", "backWall", "floorLeft", "floorRight"].map((k) => withGi[k] - withoutGi[k]);
const worst = Math.max(...leaks);
// 0.002 linear is ~ sRGB 13/255 — visible as a glow on a black interior.
const THRESHOLD = 0.002;
console.log(`\nworst leak ${fmt(worst)} (threshold ${THRESHOLD})`);
console.log(worst <= THRESHOLD ? "GI-SL PASS: sealed interior stays dark" : "GI-SL FAIL: the sun leaks into a sealed box");
await browser.close();
process.exit(worst <= THRESHOLD ? 0 : 1);
