// GI light leak: a light that is switched OFF must stop feeding the field.
//
// The reported bug: disabling the directional light left the scene "partially
// lit in the corners". Root cause — GISystem collected lights with
// `scene.traverse` + `object.visible`, but the engine hides an ENTITY by
// clearing the flag on the entity's object3D, not on the child light, and
// `traverse` (unlike three's renderer) keeps descending past an invisible
// parent. So three drew nothing while the cascades kept bouncing the sun.
//
// Asserted on the MECHANISM (the analytic light slots the feedback pass and
// the mirror/hit terms read), not on screen pixels: the slot uniforms are the
// single place a light's direct contribution enters the field, and reading
// them needs no viewport canvas — which is what makes this test deterministic
// on an editor whose panel mount is intermittently flaky.
//
// Covers all three ways a light goes away, because they take different code
// paths: the component toggle (LightComponent.onDisable → light.visible), the
// entity toggle (Engine's per-frame enabled resolve → parent.visible), and
// intensity 0.
import puppeteer from "puppeteer-core";

const url = process.argv[2] ?? "http://localhost:5201/";
const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 1 });
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\]|GI-LV/.test(t)) console.log(`${m.type()}: ${t}`);
});
page.on("pageerror", (e) => console.log(`pageerror: ${e.stack ?? e.message}`));

await page.goto(url, { waitUntil: "load", timeout: 30000 });
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
});
await new Promise((r) => setTimeout(r, 5000));

const result = await page.evaluate(async () => {
  const { THREE } = await import("/src/engine/index.js");
  await import("/src/modules/index.js");
  const { enableEngineModule } = await import("/src/engine/modules.js");
  const { ensureEngine } = await import("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  await enableEngineModule(engine, "gi");
  globalThis.__engine = engine;

  // A plain room so the volume has something to fit and bounce off.
  const wall = (size, position, color) => {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(...size),
      new THREE.MeshStandardNodeMaterial({ color, roughness: 0.9, metalness: 0 }),
    );
    mesh.position.set(...position);
    engine.scene.add(mesh);
  };
  wall([8, 0.2, 8], [0, -0.1, 0], 0xcccccc);
  wall([8, 0.2, 8], [0, 5.1, 0], 0xb8c3cf);
  wall([8, 5, 0.2], [0, 2.5, -4.1], 0xb8c3cf);
  wall([0.2, 5, 8], [-4.1, 2.5, 0], 0x9f2418);
  wall([0.2, 5, 8], [4.1, 2.5, 0], 0x3a9f24);

  // A REAL entity + LightComponent, because the entity-level toggle is the
  // path that was broken; a bare THREE.DirectionalLight would not exercise it.
  const lightEntity = engine.createEntity({ name: "Sun" });
  lightEntity.addComponent("light", { kind: "directional", intensity: 4, color: "#ffffff" });
  lightEntity.object3D.position.set(3, 6, 3);

  const giEntity = engine.createEntity({ name: "GI" });
  giEntity.addComponent("global-illumination", { autoFit: true, quality: "medium", intensity: 1 });
  engine.camera.position.set(0, 2.5, 7);
  engine.camera.lookAt(0, 2, 0);

  // Poll rather than sleep a fixed time: the first build waits on SDF bakes
  // and a pipeline compile wave, both of which vary by machine and by how
  // warm the caches are.
  const giModule = engine.modules?.get("gi") ?? null;
  let system = giModule?.system ?? null;
  for (let i = 0; i < 60 && !system?.state?.lightSlots; i++) {
    await new Promise((r) => setTimeout(r, 500));
    system = engine.modules?.get("gi")?.system ?? null;
  }
  if (!system?.state?.lightSlots) {
    return {
      error: "GI never built",
      diag: {
        moduleKeys: [...(engine.modules?.keys?.() ?? [])],
        hasModule: !!giModule,
        hasSystem: !!system,
        hasState: !!system?.state,
        component: !!system?.component,
        componentEnabled: system?.component?.enabled ?? null,
        entities: [...engine.entities.values()].map((e) => e.name),
      },
    };
  }

  // `enabledInEditor` is a FLAG; the engine's per-frame resolve is what turns
  // it into `object3D.visible`. Poll for that rather than sleeping a fixed
  // time — headless Chrome throttles rAF, so a fixed wait reads a stale
  // object3D and reports a fix as broken (it did, first run).
  const settle = async () => {
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (lightEntity.object3D.visible === lightEntity.enabledInEditor) break;
    }
    // Plus a few frames for the GI tick to copy visibility into its slots.
    await new Promise((r) => setTimeout(r, 1500));
  };
  const sample = () => ({
    collected: system._lightObjects?.length ?? -1,
    activeSlots: system.state.lightSlots.filter((s) => s.active.value > 0.5).length,
    entityFlag: lightEntity.enabledInEditor,
    objectVisible: lightEntity.object3D.visible,
    lightVisible: lightEntity.getComponent("light")?.light?.visible ?? null,
  });

  const steps = [];
  steps.push({ label: "light on", ...sample() });

  const component = lightEntity.getComponent("light");

  // 1. Entity toggle — THE reported bug.
  lightEntity.setEnabledInEditor(false);
  await settle();
  steps.push({ label: "entity disabled", ...sample() });

  lightEntity.setEnabledInEditor(true);
  await settle();
  steps.push({ label: "entity re-enabled", ...sample() });

  // 2. Component toggle (already worked — guard against regressing it).
  // `setEnabled`, not `component.enabled = …`: only the method dispatches
  // onEnable/onDisable, which is what actually clears `light.visible`.
  component.setEnabled(false);
  await settle();
  steps.push({ label: "component disabled", ...sample() });

  component.setEnabled(true);
  await settle();
  steps.push({ label: "component re-enabled", ...sample() });

  // 3. Intensity 0.
  component.setProp("intensity", 0);
  await settle();
  steps.push({ label: "intensity 0", ...sample() });

  return { steps };
});

if (result.error) {
  console.log(`FAIL: ${result.error}`);
  if (result.diag) console.log(JSON.stringify(result.diag, null, 2));
  await browser.close();
  process.exit(1);
}

for (const s of result.steps) {
  console.log(
    `${s.label.padEnd(22)} collected=${s.collected} activeSlots=${s.activeSlots}` +
      ` entityFlag=${s.entityFlag} object3D.visible=${s.objectVisible} light.visible=${s.lightVisible}`,
  );
}

const by = (label) => result.steps.find((s) => s.label === label);
const checks = [
  ["light on feeds GI", by("light on").activeSlots === 1],
  ["entity disabled stops GI", by("entity disabled").activeSlots === 0],
  ["entity re-enabled resumes GI", by("entity re-enabled").activeSlots === 1],
  ["component disabled stops GI", by("component disabled").activeSlots === 0],
  ["component re-enabled resumes GI", by("component re-enabled").activeSlots === 1],
  ["intensity 0 stops GI", by("intensity 0").activeSlots === 0],
];
let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}`);
  if (!ok) failed++;
}
console.log(failed === 0 ? "GI-LV ALL PASS" : `GI-LV ${failed} FAILED`);
await browser.close();
process.exit(failed === 0 ? 0 : 1);
