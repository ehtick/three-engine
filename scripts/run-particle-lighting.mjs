// Do particles actually integrate with scene lighting?
//
// The user reported "no GI with particles — no emissive, no shadows". The
// machinery exists in ParticleComponent (#buildInstancedRenderer,
// castShadowPositionNode, maskShadowNode, the lightCount → PointLight bridge)
// but every switch defaults to false and no preset enables any of them. This
// measures whether the machinery WORKS once enabled, so presets can be built on
// it honestly.
//
//   npx vite --port 5201        (RESTART it after editing src/ — see below)
//   node scripts/run-particle-lighting.mjs
//
// Vite rewrites imports of files edited since server start to `…?t=<mtime>`,
// which hands this harness a SECOND Engine singleton. Restart vite first.
//
// MEASUREMENT DESIGN (an earlier version got this wrong and reported a
// confident false negative):
//   - The sun is ANGLED so the shadow lands beside the blob, not under it.
//     With the light overhead the particles occupy the same screen pixels as
//     their own shadow, so hiding them to get a baseline changes the pixels
//     directly and the "shadow" measurement means nothing.
//   - The sample box is the PROJECTED world position of the expected shadow,
//     not a guessed fraction of the frame. The first attempt sampled a fixed
//     y-band that turned out to be above the horizon — it read a constant ~213
//     even with every light deleted, which is what exposed the bug.
//   - A plain shadow-casting Mesh CONTROL runs first. Until the control shows a
//     measurable drop, no particle result is trustworthy.
import puppeteer from "puppeteer-core";

const url = process.argv[2] ?? "http://localhost:5201/";
const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 800 });
const errors = [];
page.on("console", (m) => {
  const t = m.text();
  if (/PL-/.test(t)) console.log(t);
  else if (m.type() === "error") errors.push(t);
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

await page.goto(url, { waitUntil: "load", timeout: 45000 });
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
});
await new Promise((r) => setTimeout(r, 6000));

const setup = await page.evaluate(async () => {
  const { THREE } = await import("/src/engine/index.js");
  const { ensureEngine } = await import("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  globalThis.__engine = engine;

  // The editor boots with its own ambient/environment lighting, which washes a
  // directional shadow out almost completely. Strip it so the sun below is the
  // only illumination.
  engine.scene.environment = null;
  const preexisting = [];
  engine.scene.traverse((o) => {
    if (o.isLight) preexisting.push(o);
  });
  for (const l of preexisting) l.parent?.remove(l);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(40, 40),
    new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 1 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  floor.name = "floor";
  engine.scene.add(floor);

  // Angled sun: direction is (target - position) normalised.
  const SUN_POS = new THREE.Vector3(6, 8, 0);
  const sun = new THREE.DirectionalLight(0xffffff, 3);
  sun.position.copy(SUN_POS);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  for (const [k, v] of Object.entries({ left: -10, right: 10, top: 10, bottom: -10 })) sun.shadow.camera[k] = v;
  sun.shadow.camera.near = 0.1;
  sun.shadow.camera.far = 40;
  engine.scene.add(sun);

  // Where a caster centred at BLOB_POS lands its shadow on the y=0 plane.
  const BLOB_POS = new THREE.Vector3(0, 3, 0);
  const dir = new THREE.Vector3(0, 0, 0).sub(SUN_POS).normalize();
  const t = BLOB_POS.y / -dir.y;
  const shadowPoint = BLOB_POS.clone().addScaledVector(dir, t); // y == 0

  const SIZE = 320;
  const target = new THREE.RenderTarget(SIZE, SIZE);
  const cam = new THREE.PerspectiveCamera(45, 1, 0.1, 80);
  cam.position.set(0, 9, 14);
  cam.lookAt(0, 0.5, 0);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();

  // Project the shadow point to pixels once; sample a small box around it.
  const ndc = shadowPoint.clone().project(cam);
  const px = Math.round(((ndc.x + 1) / 2) * SIZE);
  // readRenderTargetPixelsAsync is bottom-up (WebGL convention), so NDC +y maps
  // straight to increasing row index — no flip.
  const py = Math.round(((ndc.y + 1) / 2) * SIZE);
  const R = 22;

  globalThis.__pl = {
    THREE,
    floor,
    sun,
    target,
    cam,
    SIZE,
    shadowPoint,
    box: { x0: Math.max(0, px - R), x1: Math.min(SIZE, px + R), y0: Math.max(0, py - R), y1: Math.min(SIZE, py + R) },
    async sampleShadowRegion() {
      const r = engine.renderer;
      r.setRenderTarget(target);
      await r.renderAsync(engine.scene, cam);
      const data = await r.readRenderTargetPixelsAsync(target, 0, 0, SIZE, SIZE);
      r.setRenderTarget(null);
      const { x0, x1, y0, y1 } = globalThis.__pl.box;
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const o = (y * SIZE + x) * 4;
          sum += data[o] + data[o + 1] + data[o + 2];
          n += 3;
        }
      }
      return sum / Math.max(1, n);
    },
  };

  const graph = {
    nodes: [
      { id: "emit", type: "emitSphere", props: { radius: 1.2 }, position: { x: 0, y: 0 } },
      { id: "slow", type: "float", props: { value: 0.05 }, position: { x: 0, y: 150 } },
      { id: "vel", type: "multiply", props: {}, position: { x: 200, y: 60 } },
      { id: "size", type: "float", props: { value: 0.55 }, position: { x: 0, y: 300 } },
      { id: "col", type: "color", props: { value: "#ffffff" }, position: { x: 0, y: 420 } },
      {
        id: "sys",
        type: "system",
        props: {
          capacity: 2000,
          // Births are staggered across ONE lifetime (initCompute seeds
          // `age = -hash*lifetime`), so a long lifetime leaves most particles
          // unborn and invisible seconds in. Keep it short, then wait past it.
          lifetime: 2,
          lifetimeJitter: 0,
          sizeJitter: 0,
          additive: false,
          lit: true,
          castShadow: true,
          receiveShadow: true,
          geometryType: "quad",
        },
        position: { x: 460, y: 120 },
      },
    ],
    edges: [
      { source: "emit", sourceHandle: "pos", target: "sys", targetHandle: "position" },
      { source: "emit", sourceHandle: "dir", target: "vel", targetHandle: "a" },
      { source: "slow", sourceHandle: "out", target: "vel", targetHandle: "b" },
      { source: "vel", sourceHandle: "out", target: "sys", targetHandle: "velocity" },
      { source: "size", sourceHandle: "out", target: "sys", targetHandle: "size" },
      { source: "col", sourceHandle: "out", target: "sys", targetHandle: "color" },
    ],
  };

  const entity = engine.createEntity({ name: "ShadowParticles" });
  entity.object3D.position.copy(BLOB_POS);
  entity.addComponent("particles", { graph });
  globalThis.__pl.entity = entity;

  return {
    ok: true,
    id: String(entity.id),
    shadowPoint: shadowPoint.toArray().map((v) => +v.toFixed(2)),
    box: globalThis.__pl.box,
  };
});
check("scene built", setup.ok, `${setup.id}, shadow lands at ${JSON.stringify(setup.shadowPoint)}, sampling ${JSON.stringify(setup.box)}`);

await new Promise((r) => setTimeout(r, 5000));

// --- what did the component actually build? --------------------------------
const built = await page.evaluate(() => {
  const c = globalThis.__pl.entity.getComponent("particles");
  const sub = c?.subsystems?.[0];
  const obj = sub?.object;
  return {
    subsystems: c?.subsystems?.length ?? 0,
    objectType: obj?.type ?? null,
    castShadow: !!obj?.castShadow,
    isStandard: !!sub?.material?.isMeshStandardNodeMaterial,
    hasCastShadowPositionNode: !!sub?.material?.castShadowPositionNode,
    hasMaskShadowNode: !!sub?.material?.maskShadowNode,
  };
});
console.log(`PL- built ${JSON.stringify(built)}`);
check("lit particles use a lighting-model material", built.isStandard);
check("shadow-casting particles render as a real mesh", built.objectType === "Mesh", built.objectType);
check("mesh.castShadow is set", built.castShadow);
check("material wires castShadowPositionNode", built.hasCastShadowPositionNode);
check("material wires maskShadowNode", built.hasMaskShadowNode);

// --- CONTROL: can this rig see ANY shadow? ---------------------------------
const control = await page.evaluate(async () => {
  const { THREE, entity } = globalThis.__pl;
  const engine = globalThis.__engine;
  entity.getComponent("particles").subsystems[0].object.visible = false;

  const box = new THREE.Mesh(
    new THREE.BoxGeometry(2.4, 2.4, 2.4),
    new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 1 }),
  );
  box.position.set(0, 3, 0);
  box.castShadow = true;
  engine.scene.add(box);
  await new Promise((r) => setTimeout(r, 500));
  const withBox = await globalThis.__pl.sampleShadowRegion();
  box.visible = false;
  await new Promise((r) => setTimeout(r, 200));
  const withoutBox = await globalThis.__pl.sampleShadowRegion();
  engine.scene.remove(box);
  entity.getComponent("particles").subsystems[0].object.visible = true;
  return { withBox, withoutBox };
});
const controlDrop = control.withoutBox - control.withBox;
console.log(`PL- CONTROL mesh: lit=${control.withoutBox.toFixed(1)} shadowed=${control.withBox.toFixed(1)}`);
check("CONTROL: an ordinary mesh casts a measurable shadow here", controlDrop > 8, `Δ ${controlDrop.toFixed(1)} / 255`);

// --- the actual subject ----------------------------------------------------
const measureShadow = async (geometryType) =>
  page.evaluate(async (geo) => {
    const comp = globalThis.__pl.entity.getComponent("particles");
    const graph = structuredClone(comp.props.graph);
    graph.nodes.find((n) => n.type === "system").props.geometryType = geo;
    comp.setProp("graph", graph);
    // Rebuild + let every particle be born.
    await new Promise((r) => setTimeout(r, 4500));
    const obj = comp.subsystems[0].object;
    obj.visible = true;
    const withParticles = await globalThis.__pl.sampleShadowRegion();
    obj.visible = false;
    await new Promise((r) => setTimeout(r, 200));
    const withoutParticles = await globalThis.__pl.sampleShadowRegion();
    obj.visible = true;
    return { withParticles, withoutParticles };
  }, geometryType);

for (const geo of ["quad", "sphere"]) {
  const shadow = await measureShadow(geo);
  const drop = shadow.withoutParticles - shadow.withParticles;
  console.log(`PL- [${geo}] lit=${shadow.withoutParticles.toFixed(1)} shadowed=${shadow.withParticles.toFixed(1)}`);
  check(`[${geo}] particles cast a shadow onto the floor`, drop > 8, `Δ ${drop.toFixed(1)} / 255`);
}

// --- particle → scene-light bridge (the path GI can consume) ---------------
const lights = await page.evaluate(async () => {
  const c = globalThis.__pl.entity.getComponent("particles");
  const graph = structuredClone(c.props.graph);
  const sys = graph.nodes.find((n) => n.type === "system");
  sys.props.lightCount = 3;
  sys.props.lightIntensity = 8;
  c.setProp("graph", graph);
  await new Promise((r) => setTimeout(r, 4000));
  const rig = c.subsystems?.[0]?.lightRig;
  return {
    rigLights: rig?.lights?.length ?? 0,
    maxIntensity: Math.max(0, ...(rig?.lights ?? []).map((l) => l.intensity)),
    inScene: (rig?.lights ?? []).filter((l) => !!l.parent).length,
  };
});
console.log(`PL- lightRig ${JSON.stringify(lights)}`);
check("lightCount spawns real scene lights parented to the entity", lights.rigLights === 3 && lights.inScene === 3);
check("particle-driven lights get intensity from the GPU readback", lights.maxIntensity > 0.01, `${lights.maxIntensity.toFixed(2)}`);

// --- every shipped preset must compile on a real device --------------------
// tests/particle-presets.test.mjs validates them statically (node types, ports,
// params); only a GPU run catches a TSL/compile failure — including the
// 8-storage-buffers-per-stage limit that AGENTS.md warns about, which a Vite
// build cannot see because it never creates pipelines.
const presetResults = await page.evaluate(async () => {
  const { PARTICLE_PRESETS } = await import("/src/editor/particlePresets.js");
  const { compileParticleGraph } = await import("/src/engine/particleGraph.js");
  const out = [];
  for (const [name, graph] of Object.entries(PARTICLE_PRESETS)) {
    try {
      const compiled = await compileParticleGraph(graph);
      out.push({ name, ok: true, systems: compiled.systems.length });
    } catch (err) {
      out.push({ name, ok: false, error: err.message ?? String(err) });
    }
  }
  return out;
});
const badPresets = presetResults.filter((p) => !p.ok);
console.log(`PL- presets ${presetResults.map((p) => `${p.name}:${p.ok ? p.systems : "FAIL"}`).join(" ")}`);
check(
  `all ${presetResults.length} presets compile`,
  badPresets.length === 0,
  badPresets.map((p) => `${p.name}: ${p.error}`).join("; "),
);

const gpuErrors = errors.filter((e) => /storage buffers|validation|exceeds the maximum|not compatible/i.test(e));
check("no WebGPU validation errors", gpuErrors.length === 0, gpuErrors[0] ?? "");

const failed = results.filter((r) => !r.ok);
console.log(`\nPL ${failed.length ? "FAIL" : "PASS"} — ${results.length - failed.length}/${results.length}`);
if (errors.length) for (const e of errors.slice(0, 6)) console.log(`  err: ${e.slice(0, 200)}`);
await browser.close();
process.exit(failed.length ? 1 : 0);
