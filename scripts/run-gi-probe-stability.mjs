// PROBE STABILITY UNDER TRANSFORMS. The user's report is that the GI
// "changes a lot" when objects are moved or scaled — the auto-fit volume
// followed the content AABB continuously, so any edit that nudged the bounds
// re-derived the probe spacing, moved every probe, and re-shuffled the whole
// indirect-light pattern.
//
// This measures it directly: build a room under a GI entity, then move and
// scale a prop inside it and check that
//   (1) the probe spacing never changes,
//   (2) the volume either stays put or slides by a WHOLE number of probe
//       cells (so probe world positions are preserved), and
//   (3) the lit wall behind the prop keeps its brightness profile.
import puppeteer from "puppeteer-core";

const url = process.argv[2] ?? "http://localhost:5201/";
const QUALITY = process.env.GI_QUALITY ?? "medium";

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1100, height: 750, deviceScaleFactor: 1 });
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\]|GI-ST/.test(t) || m.type() === "error") console.log(`${m.type()}: ${t}`);
});
page.on("pageerror", (e) => console.log(`pageerror: ${e.stack ?? e.message}`));

await page.goto(url, { waitUntil: "load", timeout: 30000 });
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
});
await new Promise((r) => setTimeout(r, 5000));

await page.evaluate(async (quality) => {
  const { THREE } = await import("/src/engine/index.js");
  await import("/src/modules/index.js");
  const { enableEngineModule } = await import("/src/engine/modules.js");
  const { ensureEngine } = await import("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  await enableEngineModule(engine, "gi");
  globalThis.__engine = engine;
  globalThis.__THREE = THREE;

  const mat = (hex, rough = 0.85) =>
    new THREE.MeshStandardNodeMaterial({ color: hex, roughness: rough, metalness: 0, side: THREE.DoubleSide });

  // Room under the GI entity, at a non-unit scale (the user's project is
  // built at 10×, which is exactly the case that used to break).
  const giEntity = engine.createEntity({ name: "GI" });
  const root = giEntity.object3D;
  root.position.set(12, 4, -7);
  root.scale.setScalar(4);

  const addPlane = (size, position, rotation, hex, name) => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(...size), mat(hex));
    mesh.position.set(...position);
    mesh.rotation.set(...rotation);
    mesh.name = name;
    root.add(mesh);
    return mesh;
  };
  const H = Math.PI / 2;
  addPlane([4, 3], [0, 0, -2], [0, 0, 0], 0xd8d8d8, "back");
  addPlane([4, 4], [0, -1.5, 0], [-H, 0, 0], 0xd0d0d0, "floor");
  addPlane([4, 4], [0, 1.5, 0], [H, 0, 0], 0xd0d0d0, "ceiling");
  addPlane([4, 3], [-2, 0, 0], [0, H, 0], 0xcc3322, "left");
  addPlane([4, 3], [2, 0, 0], [0, -H, 0], 0x22aa44, "right");

  const lampMat = mat(0xffffff, 1);
  lampMat.emissive = new THREE.Color(0xffffff);
  lampMat.emissiveIntensity = 6;
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.18, 24, 16), lampMat);
  lamp.position.set(0, 1.1, 0.4);
  lamp.name = "lamp";
  root.add(lamp);

  const prop = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.9, 0.6), mat(0xb0b4bc, 0.6));
  prop.position.set(-0.6, -1.0, 0.2);
  prop.name = "prop";
  root.add(prop);
  globalThis.__prop = prop;
  globalThis.__root = root;

  giEntity.addComponent("global-illumination", { autoFit: true, quality, intensity: 1 });
  console.log("GI-ST scene ready");
}, QUALITY);

const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const waitForWave = async (extra = 1500) => {
  for (let i = 0; i < 90; i++) {
    await settle(1000);
    if (!(await page.evaluate(() => globalThis.__engine?.renderSuspended === true))) break;
  }
  await settle(extra);
};
await settle(9000);
await waitForWave(2000);

// Aim the viewport at the back wall (OrbitControls owns the orientation —
// see ViewportPanel's dev-only __viewport handle).
await page.evaluate(() => {
  const engine = globalThis.__engine;
  const viewport = globalThis.__viewport;
  const root = globalThis.__root;
  const centre = root.localToWorld(new globalThis.__THREE.Vector3(0, 0, 0));
  const eye = root.localToWorld(new globalThis.__THREE.Vector3(0, 0.4, 5.5));
  engine.camera.position.copy(eye);
  if (viewport?.orbit) {
    viewport.orbit.target.copy(centre);
    viewport.orbit.update();
  }
  engine.camera.lookAt(centre);
  engine.camera.layers.disable(31);
  engine.camera.updateMatrixWorld(true);
});
await settle(1500);

const readState = () =>
  page.evaluate(() => {
    const state = globalThis.__engine.modules.get("gi").system.state;
    return {
      min: state.bounds.min.toArray(),
      max: state.bounds.max.toArray(),
      probeSpacing: state.probeSpacing,
      buildSize: state.buildSize.toArray(),
      minCell: state.volume.minCell,
    };
  });

const box = await page.evaluate(() => {
  const c = [...document.querySelectorAll("canvas")]
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height)[0];
  return { x: c.r.x, y: c.r.y, width: c.r.width, height: c.r.height };
});
const profile = async () => {
  const shot = await page.screenshot({ clip: box });
  const { default: sharp } = await import("sharp");
  const { data, info } = await sharp(shot).raw().toBuffer({ resolveWithObject: true });
  // A horizontal scan across the back wall, above the prop.
  const row = Math.round(info.height * 0.38);
  const out = [];
  for (let i = 0; i <= 20; i++) {
    const col = Math.round(info.width * (0.2 + (i / 20) * 0.6));
    const p = (row * info.width + col) * info.channels;
    out.push(Math.round(0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2]));
  }
  return out;
};

const fmt = (a) => a.map((v) => v.toFixed(2)).join(",");
const base = await readState();
const baseProfile = await profile();
console.log("");
console.log(`--- build: volume ${fmt(base.buildSize)}m, probes ${base.probeSpacing?.toFixed(3)}m, cell ${base.minCell.toFixed(3)}m ---`);
console.log(`  bounds ${fmt(base.min)} .. ${fmt(base.max)}`);
console.log(`  wall profile: ${baseProfile.join(" ")}`);

const results = [];
const step = async (label, mutate, expectStable = true) => {
  await page.evaluate(mutate);
  // Past the 3s entity-driven refit cadence AND its two-scan debounce.
  await settle(9000);
  await waitForWave(1500);
  const now = await readState();
  const prof = await profile();
  const spacingHeld = Math.abs(now.probeSpacing - base.probeSpacing) < 1e-6;
  const shift = now.min.map((v, i) => v - base.min[i]);
  const onLattice = shift.every(
    (d) => Math.abs(d / base.probeSpacing - Math.round(d / base.probeSpacing)) < 1e-3,
  );
  const drift = prof.reduce((a, v, i) => a + Math.abs(v - baseProfile[i]), 0) / prof.length;
  results.push({ label, spacingHeld, onLattice, drift, expectStable });
  console.log("");
  console.log(`--- ${label} ---`);
  console.log(`  probes ${now.probeSpacing?.toFixed(3)}m ${spacingHeld ? "(HELD)" : "*** CHANGED ***"}, ` +
    `volume ${fmt(now.buildSize)}m`);
  console.log(`  bounds shifted by ${fmt(shift)} → ${onLattice ? "whole probe cells (probes preserved)" : "*** OFF-LATTICE (every probe moved) ***"}`);
  console.log(`  wall profile: ${prof.join(" ")}`);
  console.log(`  mean luminance drift vs build: ${drift.toFixed(1)}/255`);
};

// Edits INSIDE the room: the volume already covers them, so nothing about
// the field may change.
await step("prop moved 1.2m", () => {
  globalThis.__prop.position.x += 0.3; // ×4 root scale = 1.2m world
  globalThis.__prop.updateMatrixWorld(true);
});
await step("prop scaled 1.25×", () => {
  globalThis.__prop.scale.setScalar(1.25);
  globalThis.__prop.updateMatrixWorld(true);
});
await step("prop moved across the room", () => {
  globalThis.__prop.position.set(1.4, -1.0, -1.4);
  globalThis.__prop.updateMatrixWorld(true);
});
// Growing the SCENE legitimately grows the volume — reported, not asserted.
await step(
  "room widened (volume must grow)",
  () => {
    globalThis.__prop.position.set(4.5, -1.0, 0);
    globalThis.__prop.updateMatrixWorld(true);
  },
  false,
);

console.log("");
const stable = results.filter((r) => r.expectStable);
const spacingOk = stable.every((r) => r.spacingHeld);
const latticeOk = stable.every((r) => r.onLattice);
const lightOk = stable.every((r) => r.drift < 12);
console.log(`probe spacing held across in-volume edits: ${spacingOk}`);
console.log(`volume stayed on the probe lattice:       ${latticeOk}`);
console.log(`indirect light stayed put (<12/255):      ${lightOk}`);
for (const r of results.filter((x) => !x.expectStable)) {
  console.log(`(informational) ${r.label}: spacing ${r.spacingHeld ? "held" : "rescaled"}, drift ${r.drift.toFixed(1)}/255`);
}
console.log(spacingOk && latticeOk && lightOk ? "PROBE-STABILITY PASS" : "PROBE-STABILITY FAIL");

await page.screenshot({ path: "scripts/gi-diag-probe-stability.png", clip: box });
await browser.close();
process.exit(0);
