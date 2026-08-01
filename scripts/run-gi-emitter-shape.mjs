// Emitter SHAPE check: an ELONGATED, Y-ROTATED emissive box over a floor.
// The sphere emitter model gave every lamp circular iso-lux contours and a
// disc reflection; the box model must make both ANISOTROPIC, aligned with
// the box's long axis.
//
// Metrics (all world-projected, never eyeballed screen fractions):
//   1. DIFFUSE pool anisotropy — floor luminance along the box's long axis
//      vs its short axis at equal distances. Sphere ≈ 1.0, box must be
//      clearly > 1 near the lamp.
//   2. METAL=1 glow shape — luminance at the MIRRORED box center vs a point
//      offset perpendicular, past the silhouette but inside the old
//      bounding-sphere disc. Sphere ≈ 1, box must be ≫ 1.
//
// Env: SPHERE=1 forces the legacy sphere model (globalThis.__giSphereEmitters)
// for the A/B; METAL=1 swaps the floor to metalness 1 / roughness 0.4;
// HEADED=1; TAG=<suffix> for the screenshot name.
import puppeteer from "puppeteer-core";
import sharp from "sharp";

const url = process.argv[2] ?? "http://localhost:5233/";
const METAL = !!process.env.METAL;
const SPHERE = !!process.env.SPHERE;
const TAG = process.env.TAG ?? `${METAL ? "metal" : "diffuse"}-${SPHERE ? "sphere" : "box"}`;

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 840, deviceScaleFactor: 1 });
page.on("console", (message) => {
  const text = message.text();
  if (/\[gi\]|GI-ES/.test(text) || message.type() === "error") console.log(`${message.type()}: ${text}`);
});
page.on("pageerror", (error) => console.log(`pageerror: ${error.stack ?? error.message}`));

await page.goto(url, { waitUntil: "load", timeout: 30000 });
for (let i = 0; i < 40; i++) {
  const ready = await page.evaluate(() => {
    if (globalThis.__viewport?.orbit) return true;
    [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
    return !!globalThis.__viewport?.orbit;
  });
  if (ready) break;
  await new Promise((r) => setTimeout(r, 500));
}
await new Promise((r) => setTimeout(r, 3000));

const ROT = (35 * Math.PI) / 180; // lamp yaw — anisotropy must follow it
const setup = await page.evaluate(
  async ({ METAL, SPHERE, ROT, TILT }) => {
    if (SPHERE) globalThis.__giSphereEmitters = true;
    if (TILT) globalThis.__giShapeTilt = true;
    const { THREE } = await import("/src/engine/index.js");
    await import("/src/modules/index.js");
    const { enableEngineModule } = await import("/src/engine/modules.js");
    const { ensureEngine } = await import("/src/editor/engineInstance.js");
    const engine = await ensureEngine();
    await enableEngineModule(engine, "gi");
    globalThis.__engine = engine;
    globalThis.__THREE = THREE;

    const floorMat = new THREE.MeshStandardNodeMaterial({
      color: 0xffffff,
      roughness: METAL ? 0.4 : 0.9,
      metalness: METAL ? 1 : 0,
    });
    const floor = new THREE.Mesh(new THREE.BoxGeometry(26, 0.2, 26), floorMat);
    floor.position.set(0, -0.1, 0);
    floor.name = "floor";
    engine.scene.add(floor);

    const lampMaterial = new THREE.MeshStandardNodeMaterial({ color: 0x000000, roughness: 1 });
    lampMaterial.emissive = new THREE.Color(0xffffff);
    lampMaterial.emissiveIntensity = 6;
    // ELONGATED box, yawed — the whole point of the test. TILT=1 adds a
    // full 3D tilt (the user's lamp hovers rotated on all axes).
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(3, 0.5, 0.8), lampMaterial);
    lamp.position.set(0, 1.4, 0);
    lamp.rotation.y = ROT;
    if (new URLSearchParams(location.search).get("__tilt") || globalThis.__giShapeTilt) {
      lamp.rotation.set(-0.45, ROT, 0.35);
    }
    lamp.name = "lamp";
    engine.scene.add(lamp);

    const giEntity = engine.createEntity({ name: "GI" });
    giEntity.addComponent("global-illumination", {
      autoFit: true,
      quality: "high",
      intensity: 1,
      emissiveShadows: true,
      reflections: true,
    });
    console.log("GI-ES scene ready");
    return { lamp: lamp.position.toArray() };
  },
  { METAL, SPHERE, ROT, TILT: !!process.env.TILT },
);

const settle = (ms) => new Promise((r) => setTimeout(r, ms));
await settle(6000);
for (let i = 0; i < 60; i++) {
  await settle(1000);
  if (!(await page.evaluate(() => globalThis.__engine?.renderSuspended === true))) break;
}
await settle(3500);

// Aim via the orbit target (OrbitControls re-aims the camera every frame).
await page.evaluate(({ eye, target }) => {
  const engine = globalThis.__engine;
  const viewport = globalThis.__viewport;
  engine.camera.position.set(...eye);
  if (viewport?.orbit) {
    viewport.orbit.target.set(...target);
    viewport.orbit.update();
  }
  engine.camera.lookAt(...target);
  engine.camera.updateMatrixWorld(true);
  engine.camera.layers.disable(31);
  engine.scene.traverse((o) => {
    if (o.isGridHelper || o.type === "GridHelper") o.visible = false;
  });
}, { eye: METAL ? [7.5, 5.0, 10.5] : [4.5, 12.0, 6.5], target: [0, 0.4, 0] });
await settle(1200);

const shot = await page.evaluate(() => {
  const c = [...document.querySelectorAll("canvas")]
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height)[0];
  return { x: c.r.x, y: c.r.y, width: c.r.width, height: c.r.height };
});
const png = await page.screenshot({ clip: shot });
const out = `scripts/gi-diag-emitter-shape-${TAG}.png`;
await sharp(png).toFile(out);
const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
const sampleAt = (fx, fy) => {
  const px = Math.min(info.width - 1, Math.max(0, Math.round(fx * info.width)));
  const py = Math.min(info.height - 1, Math.max(0, Math.round(fy * info.height)));
  const i = (py * info.width + px) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
};
const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

const project = (points) =>
  page.evaluate((pts) => {
    const engine = globalThis.__engine;
    const THREE = globalThis.__THREE;
    engine.camera.updateMatrixWorld(true);
    return pts.map(([x, y, z]) => {
      const v = new THREE.Vector3(x, y, z).project(engine.camera);
      return [(v.x + 1) / 2, (1 - v.y) / 2, v.z < 1 ? 1 : 0];
    });
  }, points);

console.log(`\n--- emitter shape (${TAG}) ---`);
const long = [Math.cos(ROT), 0, -Math.sin(ROT)];
const short = [Math.sin(ROT), 0, Math.cos(ROT)];
const [lx, ly, lz] = setup.lamp;

if (!METAL) {
  // DIFFUSE POOL ANISOTROPY at three distances, both signs averaged.
  for (const d of [2.5, 3.5, 4.5]) {
    const pts = [
      [lx + long[0] * d, 0.02, lz + long[2] * d],
      [lx - long[0] * d, 0.02, lz - long[2] * d],
      [lx + short[0] * d, 0.02, lz + short[2] * d],
      [lx - short[0] * d, 0.02, lz - short[2] * d],
    ];
    const screen = await project(pts);
    const L = screen.map(([fx, fy]) => lum(sampleAt(fx, fy)));
    const alongL = (L[0] + L[1]) / 2;
    const acrossL = (L[2] + L[3]) / 2;
    console.log(
      `  d=${d}m  along ${alongL.toFixed(1)}  across ${acrossL.toFixed(1)}  anisotropy ${(alongL / Math.max(acrossL, 1)).toFixed(2)}` +
        `  (raw ${L.map((v) => v.toFixed(0)).join("/")})`,
    );
  }
  console.log("  sphere model ⇒ anisotropy ≈ 1.00 at every d; box model ⇒ > ~1.15 near the lamp");
} else {
  // GLOW SHAPE: mirrored-box center vs perpendicular offsets (past the box
  // silhouette, inside the old bounding-sphere disc), all mirrored through
  // the floor plane y=0 so they land on the REFLECTION in the metal floor.
  const mirrored = (p) => [p[0], -p[1], p[2]];
  const boundR = Math.hypot(1.5, 0.25, 0.4);
  const inPt = mirrored([lx, ly, lz]);
  const outA = mirrored([lx + short[0] * 1.1, ly, lz + short[2] * 1.1]); // 0.4 half + 0.7 past
  const outB = mirrored([lx - short[0] * 1.1, ly, lz - short[2] * 1.1]);
  const tipIn = mirrored([lx + long[0] * 1.3, ly, lz + long[2] * 1.3]); // still inside the long half 1.5
  const screen = await project([inPt, outA, outB, tipIn]);
  const L = screen.map(([fx, fy]) => lum(sampleAt(fx, fy)));
  console.log(`  bounding sphere r=${boundR.toFixed(2)} — offsets 1.1m are INSIDE the old disc`);
  console.log(
    `  reflection center L=${L[0].toFixed(1)}  perp offsets L=${L[1].toFixed(1)}/${L[2].toFixed(1)}  long tip L=${L[3].toFixed(1)}`,
  );
  const ratio = L[0] / Math.max((L[1] + L[2]) / 2, 1);
  console.log(
    `  center/perp ratio ${ratio.toFixed(2)} — sphere model ≈ 1 (disc covers all), box model ≫ 1 (perp is outside the box)` +
      `  long-tip/perp ${(L[3] / Math.max((L[1] + L[2]) / 2, 1)).toFixed(2)} (box keeps the tip bright)`,
  );
}
console.log(`SHOT ${out}`);
await browser.close();
