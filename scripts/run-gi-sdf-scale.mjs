// SDF-UNDER-TRANSFORM harness. The GI field is composited from per-mesh
// analytic/baked SDFs whose world distances are derived from each mesh's
// world matrix — if that derivation is wrong, a SCALED mesh occupies the
// wrong region of the field and every downstream effect (shadow traces,
// mirror rays, probe visibility) is wrong with it.
//
// The test is numeric, not visual: the volume is MANUAL (fixed bounds and
// cell size, so nothing about the field changes between measurements), one
// primitive sits at the centre, and we count OCCUPIED cells as its scale
// changes. Occupancy is a shell ~1.74 cells thick around the surface, so
// for a sphere it must grow as the SURFACE AREA (∝ scale²) and for a box as
// its surface area too. A solid-filled blob (the failure mode when local
// and world units are mixed) grows as the VOLUME (∝ scale³) and overshoots
// the predicted count by an order of magnitude.
import puppeteer from "puppeteer-core";

const url = process.argv[2] ?? "http://localhost:5201/";
const SIZE = 24; // manual volume size, m
const VOXEL = 0.25; // manual cell size, m

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 900, height: 600, deviceScaleFactor: 1 });
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\]|GI-SDF/.test(t) || m.type() === "error") console.log(`${m.type()}: ${t}`);
});
page.on("pageerror", (e) => console.log(`pageerror: ${e.stack ?? e.message}`));

await page.goto(url, { waitUntil: "load", timeout: 30000 });
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
});
await new Promise((r) => setTimeout(r, 5000));

await page.evaluate(async ({ size, voxel }) => {
  const { THREE } = await import("/src/engine/index.js");
  await import("/src/modules/index.js");
  const { enableEngineModule } = await import("/src/engine/modules.js");
  const { ensureEngine } = await import("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  await enableEngineModule(engine, "gi");
  globalThis.__engine = engine;
  globalThis.__THREE = THREE;

  const mat = () => new THREE.MeshStandardNodeMaterial({ color: 0xcccccc, roughness: 0.9, side: THREE.DoubleSide });
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.5, 32, 16), mat());
  sphere.name = "probe-sphere";
  engine.scene.add(sphere);
  const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat());
  box.name = "probe-box";
  box.visible = false;
  engine.scene.add(box);
  globalThis.__sphere = sphere;
  globalThis.__box = box;

  // MANUAL volume: fixed bounds + fixed cell size, so the only thing that
  // changes between measurements is the mesh transform.
  const giEntity = engine.createEntity({ name: "GI" });
  giEntity.object3D.position.set(0, 0, 0);
  globalThis.__gi = giEntity.addComponent("global-illumination", {
    autoFit: false,
    quality: "medium",
    sizeX: size, sizeY: size, sizeZ: size,
    voxelSize: voxel,
    probeSpacing: 1.5,
    cascadeCount: 4, c0DirRes: 4,
    intensity: 1, bounce: 1, temporalBlend: 0.25,
    reflections: false, hitLighting: false, emissiveShadows: true,
    autoRebake: true, debugProbes: "off",
  });
  console.log("GI-SDF scene ready");
}, { size: SIZE, voxel: VOXEL });

const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const waitForWave = async (extra = 1200) => {
  for (let i = 0; i < 90; i++) {
    await settle(1000);
    if (!(await page.evaluate(() => globalThis.__engine?.renderSuspended === true))) break;
  }
  await settle(extra);
};
await settle(9000);
await waitForWave(1500);

const occupancy = () =>
  page.evaluate(async () => {
    const engine = globalThis.__engine;
    const volume = engine.modules.get("gi").system.state.volume;
    const data = new Float32Array(await engine.renderer.getArrayBufferAsync(volume.stagingBuffer.value));
    let occ = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0.5) occ++;
    return { occ, minCell: volume.minCell, capWorld: volume.capWorld };
  });

const setShape = (which, scale, rotation = [0, 0, 0]) =>
  page.evaluate(({ which, scale, rotation }) => {
    const s = globalThis.__sphere;
    const b = globalThis.__box;
    s.visible = which === "sphere";
    b.visible = which === "box";
    const target = which === "sphere" ? s : b;
    target.scale.set(...(Array.isArray(scale) ? scale : [scale, scale, scale]));
    target.rotation.set(...rotation);
    s.updateMatrixWorld(true);
    b.updateMatrixWorld(true);
  }, { which, scale, rotation });

// Analytic primitives are SOLID by design (the interior clamps to distance
// 0 so thin walls seal), so an occupied region is the shape DILATED by the
// occupancy threshold 0.87·minCell — its volume over the cell volume. A
// correct SDF tracks that at every scale; a units-mixing one blows past it.
const predictSphere = (r, minCell) => ((4 / 3) * Math.PI * (r + 0.87 * minCell) ** 3) / minCell ** 3;
const predictEllipsoid = (rx, ry, rz, minCell) =>
  ((4 / 3) * Math.PI * (rx + 0.87 * minCell) * (ry + 0.87 * minCell) * (rz + 0.87 * minCell)) / minCell ** 3;
const predictBox = (hx, hy, hz, minCell) =>
  ((2 * hx + 1.74 * minCell) * (2 * hy + 1.74 * minCell) * (2 * hz + 1.74 * minCell)) / minCell ** 3;

const first = await occupancy();
const minCell = first.minCell;
console.log("");
console.log(`--- field: minCell ${minCell.toFixed(3)}m, cap ${first.capWorld.toFixed(2)}m, ${SIZE}m manual volume ---`);
console.log("");
console.log("shape        scale          occupied   predicted   ratio");

const rows = [];
const run = async (label, which, scale, rotation, predicted) => {
  await setShape(which, scale, rotation);
  await settle(1600);
  const { occ } = await occupancy();
  const ratio = occ / predicted;
  rows.push({ label, occ, predicted, ratio });
  console.log(
    `${label.padEnd(12)} ${String(Array.isArray(scale) ? scale.join("/") : scale).padEnd(14)} ` +
      `${String(occ).padStart(8)}   ${predicted.toFixed(0).padStart(9)}   ${ratio.toFixed(2)}`,
  );
  return ratio;
};

// Sphere: local radius 0.5 → world radius 0.5·scale.
await run("sphere", "sphere", 1, [0, 0, 0], predictSphere(0.5, minCell));
await run("sphere", "sphere", 2, [0, 0, 0], predictSphere(1.0, minCell));
await run("sphere", "sphere", 4, [0, 0, 0], predictSphere(2.0, minCell));
await run("sphere", "sphere", 8, [0, 0, 0], predictSphere(4.0, minCell));
await run("sphere-rot", "sphere", 3, [0.6, 0.9, 0.3], predictSphere(1.5, minCell));
await run("sphere-nu", "sphere", [4, 1, 6], [0, 0, 0], predictEllipsoid(2, 0.5, 3, minCell));
// Box: local half 0.5 → world half 0.5·scale (rotation must not change the
// dilated volume much — the prediction is the axis-aligned one, so a rotated
// box is expected to land slightly above it).
await run("box", "box", 1, [0, 0, 0], predictBox(0.5, 0.5, 0.5, minCell));
await run("box", "box", 4, [0, 0, 0], predictBox(2, 2, 2, minCell));
await run("box-rot", "box", 4, [0.6, 0.9, 0.3], predictBox(2, 2, 2, minCell));
await run("box-nu", "box", [6, 0.5, 3], [0, 0, 0], predictBox(3, 0.25, 1.5, minCell));

console.log("");
const worst = rows.reduce((a, b) => (Math.abs(Math.log(b.ratio)) > Math.abs(Math.log(a.ratio)) ? b : a));
console.log(
  `worst deviation: ${worst.label} ratio ${worst.ratio.toFixed(2)} ` +
    `(a correct SDF stays ~0.8-1.3 at every scale and rotation; a large ratio means the shape ` +
    `occupies far more of the field than it physically covers)`,
);
console.log(rows.every((r) => r.ratio > 0.7 && r.ratio < 1.45) ? "SDF-SCALE PASS" : "SDF-SCALE FAIL");

await browser.close();
process.exit(0);
