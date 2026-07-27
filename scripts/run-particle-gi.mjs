// Do particles light the room THROUGH the GI field?
//
// `lightCount` predates GI: it fakes particle emission with real PointLights,
// which GI only sees second-hand. `giEmission` instead publishes the particle
// cloud to GI's per-frame analytic emitter slots — the same slots emissive
// meshes are promoted into — so the cloud injects into the voxel bounce, casts
// the GI emissive shadow, and shows up in mirrors.
//
//   npx vite --port 5201     (RESTART after editing src/ — Vite's ?t= query
//                             otherwise hands this harness a 2nd Engine)
//   node scripts/run-particle-gi.mjs
//
// TWO TRAPS THIS HARNESS EXISTS TO AVOID (both cost a full round of false
// negatives before they were understood):
//
//   1. GI silently never builds unless the module is enabled BEFORE the
//      component is added AND the component gets `autoFit: true`. Otherwise
//      there is no `[gi]` log line at all and every pixel is 0, which looks
//      exactly like a broken feature. So: wait for the literal `[gi] built …`
//      line, then wait out the material compile wave via `renderSuspended`.
//
//   2. You CANNOT sample GI by rendering the scene yourself. GI resolves
//      deferred in SCREEN SPACE (giScreen.js): the gbuffer comes from
//      `engine.camera` and irradiance is sampled at `screenUV`. Rendering from
//      a private camera into your own RenderTarget reads that texture at
//      meaningless positions — a known-good emissive-mesh control measured
//      Δ0.00 that way, on a probe box where a plain PointLight measured 235.7.
//      So this drives the REAL viewport camera and screenshots the page, the
//      same as every working run-gi-rc-*.mjs.
import puppeteer from "puppeteer-core";
import sharp from "sharp";

const url = process.argv[2] ?? "http://localhost:5201/";
const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 860 });

const errors = [];
const giLog = [];
page.on("console", (m) => {
  const t = m.text();
  if (/^\[gi\]/.test(t)) giLog.push(t);
  if (/PGI-/.test(t)) console.log(t);
  else if (m.type() === "error") errors.push(t);
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

await page.goto(url, { waitUntil: "load", timeout: 45000 });
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
});
await settle(6000);

await page.evaluate(async () => {
  const { THREE } = await import("/src/engine/index.js");
  await import("/src/modules/index.js");
  const { enableEngineModule } = await import("/src/engine/modules.js");
  const { ensureEngine } = await import("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  globalThis.__engine = engine;
  globalThis.__THREE = THREE;

  // Unlit room: the ONLY illumination must be GI carrying an emitter's light.
  engine.scene.environment = null;
  const lights = [];
  engine.scene.traverse((o) => {
    if (o.isLight) lights.push(o);
  });
  for (const l of lights) l.parent?.remove(l);

  const wall = (size, pos, rot, name) => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(...size),
      new THREE.MeshStandardNodeMaterial({ color: 0xdddddd, roughness: 0.95, metalness: 0, side: THREE.DoubleSide }),
    );
    m.position.set(...pos);
    m.rotation.set(...rot);
    m.name = name;
    engine.scene.add(m);
    return m;
  };
  wall([6, 6], [0, 0, 0], [-Math.PI / 2, 0, 0], "floor");
  wall([6, 6], [0, 6, 0], [Math.PI / 2, 0, 0], "ceiling");
  wall([6, 6], [0, 3, -3], [0, 0, 0], "back");
  wall([6, 6], [-3, 3, 0], [0, Math.PI / 2, 0], "left");
  wall([6, 6], [3, 3, 0], [0, -Math.PI / 2, 0], "right");

  engine.camera.position.set(0, 3, 6.4);
  engine.camera.lookAt(0, 3, 0);
  engine.camera.updateMatrixWorld(true);

  // Module FIRST, then the component WITH autoFit (see trap 1 above).
  await enableEngineModule(engine, "gi");
  const giEntity = engine.createEntity({ name: "GI" });
  giEntity.addComponent("global-illumination", { autoFit: true, quality: "medium", intensity: 1 });
});

const waitForWave = async () => {
  for (let i = 0; i < 90; i++) {
    const suspended = await page.evaluate(() => globalThis.__engine?.renderSuspended === true);
    if (!suspended) return;
    await settle(1000);
  }
};

for (let i = 0; i < 60 && !giLog.some((l) => /built/.test(l)); i++) await settle(1500);
await waitForWave();
await settle(3000);
check("GI built", giLog.some((l) => /built/.test(l)), giLog.find((l) => /built/.test(l))?.slice(0, 110) ?? "no line");

/**
 * Luminance of the left wall, read from the ACTUAL viewport. Probe points are
 * projected through `engine.camera` (the camera GI's gbuffer uses) into canvas
 * pixels, then sampled from a page screenshot.
 */
async function sampleWall(tag) {
  const points = await page.evaluate(() => {
    const THREE = globalThis.__THREE;
    const engine = globalThis.__engine;
    engine.camera.updateMatrixWorld(true);
    const canvas = document.querySelector("canvas");
    const rect = canvas.getBoundingClientRect();
    const out = [];
    // Spread along the left wall, away from the emitter at the room centre.
    for (const z of [0.4, 1.0, 1.6]) {
      for (const y of [2.2, 3.0, 3.8]) {
        const projected = new THREE.Vector3(-2.92, y, z).project(engine.camera);
        if (Math.abs(projected.x) > 0.97 || Math.abs(projected.y) > 0.97) continue;
        out.push({
          px: Math.round(rect.x + ((projected.x + 1) / 2) * rect.width),
          // A screenshot is top-down; NDC +y is up.
          py: Math.round(rect.y + ((1 - projected.y) / 2) * rect.height),
        });
      }
    }
    return out;
  });
  const shot = await page.screenshot({ path: `scripts/gi-diag-particle-${tag}.png` });
  const { data, info } = await sharp(shot).raw().toBuffer({ resolveWithObject: true });
  if (!points.length) return { luma: 0, samples: 0 };
  let sum = 0;
  for (const p of points) {
    const i = (p.py * info.width + p.px) * info.channels;
    sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  }
  return { luma: sum / points.length, samples: points.length };
}

// --- CONTROL: a known-good emissive mesh must light that wall through GI ----
const dark = await sampleWall("dark");
await page.evaluate(async () => {
  const THREE = globalThis.__THREE;
  const mat = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 1 });
  mat.emissive = new THREE.Color(0xff6a1e);
  mat.emissiveIntensity = 14;
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.45, 24, 16), mat);
  lamp.position.set(0, 3, 0);
  lamp.name = "controlLamp";
  globalThis.__lamp = lamp;
  globalThis.__engine.scene.add(lamp);
  // A mesh added after the build is only promoted on the next rescan.
  globalThis.__engine.modules?.get?.("gi")?.system?.requestRebuild?.();
});
await settle(5000);
await waitForWave();
await settle(4000);
const lit = await sampleWall("control-lit");
console.log(`PGI- CONTROL dark=${dark.luma.toFixed(2)} lit=${lit.luma.toFixed(2)} (${lit.samples} samples)`);
check("CONTROL: an emissive mesh lights the wall through GI", lit.luma - dark.luma > 3, `Δ ${(lit.luma - dark.luma).toFixed(2)}`);

await page.evaluate(() => {
  globalThis.__engine.scene.remove(globalThis.__lamp);
  globalThis.__engine.modules?.get?.("gi")?.system?.requestRebuild?.();
});
await settle(5000);
await waitForWave();

// --- SUBJECT: the particle cloud -------------------------------------------
await page.evaluate(async () => {
  const engine = globalThis.__engine;
  const graph = {
    nodes: [
      { id: "emit", type: "emitSphere", props: { radius: 0.35 }, position: { x: 0, y: 0 } },
      { id: "slow", type: "float", props: { value: 0.02 }, position: { x: 0, y: 160 } },
      { id: "vel", type: "multiply", props: {}, position: { x: 200, y: 60 } },
      { id: "col", type: "color", props: { value: "#ff6a1e" }, position: { x: 0, y: 300 } },
      { id: "size", type: "float", props: { value: 0.12 }, position: { x: 0, y: 420 } },
      {
        id: "sys",
        type: "system",
        props: {
          capacity: 800, lifetime: 3, lifetimeJitter: 0, sizeJitter: 0, additive: true,
          giEmission: true, giEmissionStrength: 14,
        },
        position: { x: 470, y: 120 },
      },
    ],
    edges: [
      { source: "emit", sourceHandle: "pos", target: "sys", targetHandle: "position" },
      { source: "emit", sourceHandle: "dir", target: "vel", targetHandle: "a" },
      { source: "slow", sourceHandle: "out", target: "vel", targetHandle: "b" },
      { source: "vel", sourceHandle: "out", target: "sys", targetHandle: "velocity" },
      { source: "col", sourceHandle: "out", target: "sys", targetHandle: "color" },
      { source: "size", sourceHandle: "out", target: "sys", targetHandle: "size" },
    ],
  };
  const entity = engine.createEntity({ name: "GIParticles" });
  entity.object3D.position.set(0, 3, 0);
  entity.addComponent("particles", { graph });
  globalThis.__pEntity = entity;
  // A newly registered provider only claims a slot on the next scene collect.
  engine.modules?.get?.("gi")?.system?.requestRebuild?.();
});
await settle(6000);
await waitForWave();
await settle(4000);

const provider = await page.evaluate(() => {
  const rig = globalThis.__pEntity.getComponent("particles").subsystems?.[0]?.lightRig;
  const s = rig?.giShape;
  return {
    registered: globalThis.__engine.giEmitters?.size ?? 0,
    shape: s ? { c: s.center.toArray().map((v) => +v.toFixed(2)), radius: +s.radius.toFixed(2), rgb: [s.r, s.g, s.b].map((v) => +v.toFixed(2)) } : null,
  };
});
console.log(`PGI- provider ${JSON.stringify(provider)}`);
check("particle system registers a GI emitter provider", provider.registered > 0, `${provider.registered}`);
check("provider publishes an emitter sphere from the GPU readback", !!provider.shape, JSON.stringify(provider.shape));

const withEmission = await sampleWall("particles-on");
await page.evaluate(async () => {
  const c = globalThis.__pEntity.getComponent("particles");
  const graph = structuredClone(c.props.graph);
  graph.nodes.find((n) => n.type === "system").props.giEmission = false;
  c.setProp("graph", graph);
  globalThis.__engine.modules?.get?.("gi")?.system?.requestRebuild?.();
});
await settle(6000);
await waitForWave();
await settle(4000);
const withoutEmission = await sampleWall("particles-off");

console.log(`PGI- wall: giEmission on=${withEmission.luma.toFixed(2)} off=${withoutEmission.luma.toFixed(2)}`);
check(
  "particles light the room through GI",
  withEmission.luma - withoutEmission.luma > 3,
  `Δ ${(withEmission.luma - withoutEmission.luma).toFixed(2)} / 255`,
);

const gpuErrors = errors.filter((e) => /storage buffers|validation|exceeds the maximum/i.test(e));
check("no WebGPU validation errors", gpuErrors.length === 0, gpuErrors[0] ?? "");

const failed = results.filter((r) => !r.ok);
console.log(`\nPGI ${failed.length ? "FAIL" : "PASS"} — ${results.length - failed.length}/${results.length}`);
if (giLog.length) console.log(`gi: ${giLog.slice(-3).join("\n    ")}`);
await browser.close();
process.exit(failed.length ? 1 : 0);
