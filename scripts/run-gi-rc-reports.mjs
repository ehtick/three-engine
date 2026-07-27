// Reproduces the three issues reported from the real editor (2026-07-25):
//   A. a BIG emissive sphere "breaks lighting" (dark floor, hard-edged pools)
//   B. metal / roughness-0 materials show NO reflection (flat washed-out white)
//   C. volumetric materials render black and tank FPS under GI
//
// Everything uses EDITOR-SHAPED materials (shaderGraph assigns roughnessNode /
// metalnessNode to every material it builds), because plain numeric-roughness
// materials take different code paths — that difference is exactly what hid a
// whole class of bugs from earlier harnesses.
//
// The reflection test is a CAUSAL one rather than an eyeball: sample the metal
// sphere, recolour the side walls, sample again. If the sphere's pixels don't
// move, it is not reflecting the room whatever it looks like.
import puppeteer from "puppeteer-core";

const url = process.argv[2] ?? "http://localhost:5201/";
const EMISSIVE_RADIUS = Number(process.env.RADIUS ?? 1.2);
const QUALITY = process.env.QUALITY ?? "high";
const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 1 });
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\]|GI-RP/.test(t) || m.type() === "error") console.log(`${m.type()}: ${t}`);
});
page.on("pageerror", (e) => console.log(`pageerror: ${e.stack ?? e.message}`));

await page.goto(url, { waitUntil: "load", timeout: 30000 });
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
});
await new Promise((r) => setTimeout(r, 5000));

// A/B switch for the per-builder Fn layouts (giFn.js): NOLAYOUTS=1 reproduces
// the previous shipped codegen on the SAME machine state.
if (process.env.NOLAYOUTS) await page.evaluate(() => { globalThis.__giNoLayouts = true; });

await page.evaluate(async ({ radius, quality, withVolume }) => {
  const { THREE } = await import("/src/engine/index.js");
  const TSL = await import("/node_modules/three/build/three.tsl.js");
  await import("/src/modules/index.js");
  const { enableEngineModule } = await import("/src/engine/modules.js");
  const { ensureEngine } = await import("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  await enableEngineModule(engine, "gi");
  globalThis.__engine = engine;
  globalThis.__THREE = THREE;

  // Editor-shaped material: node-driven colour/roughness/metalness.
  const mat = (hex, rough, metal = 0, side = THREE.FrontSide) => {
    const m = new THREE.MeshStandardNodeMaterial({ side });
    m.color = new THREE.Color(hex);
    m.roughness = rough;
    m.metalness = metal;
    m.colorNode = TSL.color(new THREE.Color(hex));
    m.roughnessNode = TSL.float(rough);
    m.metalnessNode = TSL.float(metal);
    return m;
  };
  const plane = (size, pos, rot, material, name) => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(...size), material);
    mesh.position.set(...pos);
    mesh.rotation.set(...rot);
    mesh.name = name;
    engine.scene.add(mesh);
    return mesh;
  };
  // Cornell-ish room, 8 x 5 x 8.
  plane([8, 8], [0, 0, 0], [-Math.PI / 2, 0, 0], mat(0xdddddd, 0.85), "floor");
  plane([8, 8], [0, 5, 0], [Math.PI / 2, 0, 0], mat(0xdddddd, 0.85), "ceiling");
  plane([8, 5], [0, 2.5, -4], [0, 0, 0], mat(0xdddddd, 0.85), "back");
  globalThis.__redWall = plane([8, 5], [-4, 2.5, 0], [0, Math.PI / 2, 0], mat(0xcc2211, 0.85), "red");
  globalThis.__greenWall = plane([8, 5], [4, 2.5, 0], [0, -Math.PI / 2, 0], mat(0x22cc33, 0.85), "green");

  // A. BIG emissive sphere, centred in the room.
  const lampMat = mat(0xffffff, 1);
  lampMat.emissive = new THREE.Color(0xffffff);
  lampMat.emissiveIntensity = 6;
  lampMat.emissiveNode = TSL.color(new THREE.Color(0xffffff)).mul(6);
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 24), lampMat);
  lamp.position.set(0, 3.0, 0);
  lamp.name = "bigLamp";
  engine.scene.add(lamp);
  globalThis.__lamp = lamp;

  // B. Perfect mirror: roughness 0, metalness 1 (the user's material).
  const mirror = new THREE.Mesh(new THREE.SphereGeometry(0.9, 48, 32), mat(0xffffff, 0, 1));
  mirror.position.set(1.9, 1.0, 1.4);
  mirror.name = "mirrorBall";
  engine.scene.add(mirror);

  // C. Volumetric material (VolumeNodeMaterial) — reported as rendering black
  // under GI and tanking FPS.
  if (globalThis.__withVolume !== false) {
    const vol = new THREE.VolumeNodeMaterial();
    vol.userData.isVolumeMaterial = true;
    vol.transparent = true;
    vol.blending = THREE.AdditiveBlending;
    vol.scatteringNode = TSL.Fn(() => TSL.vec4(0.6, 0.7, 1.0, 0.06));
    const fog = new THREE.Mesh(new THREE.BoxGeometry(7.5, 4.6, 7.5), vol);
    fog.position.set(0, 2.3, 0);
    fog.name = "volumeBox";
    engine.scene.add(fog);
    globalThis.__fog = fog;
  }

  engine.camera.position.set(0, 2.4, 7.4);
  engine.camera.lookAt(0, 2.0, 0);
  engine.camera.updateMatrixWorld(true);
  engine.camera.layers.disable(31); // editor grid/gizmo layer pollutes probes

  const gi = engine.createEntity({ name: "GI" });
  globalThis.__gi = gi.addComponent("global-illumination", {
    autoFit: true, quality, intensity: 1, reflections: true, emissiveShadows: true,
  });
  console.log(`GI-RP scene ready (lamp radius ${radius}, quality ${quality})`);
}, { radius: EMISSIVE_RADIUS, quality: QUALITY });

const waitForWave = async (extra = 2000) => {
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (!(await page.evaluate(() => globalThis.__engine?.renderSuspended === true))) break;
  }
  await new Promise((r) => setTimeout(r, extra));
};
await new Promise((r) => setTimeout(r, 6000));
await waitForWave(2500);

const canvasBox = async () =>
  page.evaluate(() => {
    const canvas = [...document.querySelectorAll("canvas")]
      .map((c) => ({ c, r: c.getBoundingClientRect() }))
      .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height)[0];
    const r = canvas.r;
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
const box = await canvasBox();

// Sample a grid of points from a screenshot.
const sample = async (label, points) => {
  const shot = await page.screenshot({ clip: box });
  const { default: sharp } = await import("sharp");
  const img = sharp(shot);
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const out = {};
  for (const [name, fx, fy] of points) {
    const px = Math.round(fx * info.width);
    const py = Math.round(fy * info.height);
    const i = (py * info.width + px) * info.channels;
    out[name] = [data[i], data[i + 1], data[i + 2]];
  }
  if (label) {
    console.log(
      `${label}: ` +
        Object.entries(out).map(([k, v]) => `${k}=rgb(${v.join(",")})`).join("  "),
    );
  }
  return out;
};

// --- A. does the floor stay lit under a big emitter? -----------------------
console.log("\n--- A. big emissive: floor + wall luminance ---");
await sample("floor/walls", [
  ["floorNear", 0.5, 0.9],
  ["floorMid", 0.5, 0.78],
  ["floorUnderLamp", 0.5, 0.7],
  ["floorLeft", 0.22, 0.8],
  ["floorRight", 0.78, 0.8],
  ["redWall", 0.06, 0.5],
  ["greenWall", 0.94, 0.5],
  ["ceiling", 0.5, 0.12],
  ["backWall", 0.5, 0.42],
]);

// --- B. is the mirror ball actually reflecting the room? -------------------
console.log("\n--- B. mirror ball (roughness 0, metalness 1) ---");
const mirrorPoints = [
  ["ballLeft", 0.655, 0.55],
  ["ballCenter", 0.70, 0.55],
  ["ballRight", 0.745, 0.55],
  ["ballTop", 0.70, 0.47],
];
const before = await sample("with red/green walls", mirrorPoints);
// Causal test: swap the wall colours and see whether the ball follows.
await page.evaluate(async () => {
  const TSL = await import("/node_modules/three/build/three.tsl.js");
  const { THREE } = await import("/src/engine/index.js");
  for (const [mesh, hex] of [[globalThis.__redWall, 0x1122ee], [globalThis.__greenWall, 0xeeee11]]) {
    mesh.material.color = new THREE.Color(hex);
    mesh.material.colorNode = TSL.color(new THREE.Color(hex));
    mesh.material.needsUpdate = true;
  }
  globalThis.__gi.system?.requestRebuild?.();
});
await new Promise((r) => setTimeout(r, 5000));
await waitForWave(3000);
const after = await sample("with blue/yellow walls", mirrorPoints);
let moved = 0;
for (const [name] of mirrorPoints) {
  const d = before[name].reduce((acc, v, i) => acc + Math.abs(v - after[name][i]), 0);
  if (d > 12) moved++;
  console.log(`  ${name}: Δ${d}`);
}
console.log(
  moved > 0
    ? `REFLECTION: ball reacts to wall colour at ${moved}/${mirrorPoints.length} points (reflecting)`
    : "REFLECTION: ball did NOT react to wall colour — NOT reflecting the room",
);

// --- C. volumetric material: not black, and what does it cost? ------------
console.log("");
console.log("--- C. volume material (box ENCLOSING the room) ---");
// Does geometry INSIDE/BEHIND the volume keep its GI? The prepass must not
// write the fog box into the gbuffer.
const giInsideVolume = async (label) => sample(label, [
  ["floorUnderLamp", 0.5, 0.7],
  ["redWall", 0.06, 0.5],
  ["greenWall", 0.94, 0.5],
  ["backWall", 0.5, 0.42],
]);
await giInsideVolume("with volume visible");
await page.evaluate(() => { globalThis.__fog.visible = false; });
await new Promise((r) => setTimeout(r, 2500));
await giInsideVolume("volume hidden      ");
await page.evaluate(() => { globalThis.__fog.visible = true; });
await new Promise((r) => setTimeout(r, 2500));

await sample("volume box", [
  ["volumeCenter", 0.27, 0.55],
  ["volumeEdge", 0.16, 0.60],
]);
const cost = await page.evaluate(async () => {
  const engine = globalThis.__engine;
  const read = async (ms) => {
    const samples = [];
    await new Promise((resolve) => {
      const t = setInterval(() => {
        const g = engine.stats?.readout?.gpuMs ?? 0;
        if (g > 0) samples.push(g);
      }, 100);
      setTimeout(() => { clearInterval(t); resolve(); }, ms);
    });
    samples.sort((a, b) => a - b);
    return samples.length ? samples[Math.floor(samples.length / 2)] : null;
  };
  const withVolume = await read(4000);
  globalThis.__fog.visible = false;
  const withoutVolume = await read(4000);
  globalThis.__fog.visible = true;
  return { withVolume, withoutVolume };
});
console.log(
  `GPU ms: with volume ${cost.withVolume?.toFixed(2)} / without ${cost.withoutVolume?.toFixed(2)}` +
    (cost.withVolume && cost.withoutVolume ? ` (volume costs ${(cost.withVolume - cost.withoutVolume).toFixed(2)}ms)` : ""),
);

await page.screenshot({ path: "scripts/gi-diag-reports.png", clip: box });
console.log("SHOT scripts/gi-diag-reports.png");
await browser.close();
process.exit(0);
