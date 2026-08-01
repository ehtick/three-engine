/**
 * GPU occlusion culling in a real browser, against a real WebGPU frame
 * (roadmap item 14).
 *
 * The headless test proves the maths against a fabricated depth buffer. This
 * proves the buffer is real:
 *
 *   - that the occluder pass actually renders, and writes view-space METRES —
 *     the pyramid is read back and compared against the distance to the wall,
 *   - that the readback survives WebGPU's row padding, which if it did not
 *     would produce a sheared depth buffer and cull things in the wrong places,
 *   - and the only number that matters at the end: that DRAW CALLS go down. A
 *     culling system that hides objects without removing draws has cost a depth
 *     pass and bought nothing.
 *
 *   npx vite --port 5201
 *   node scripts/run-occlusion-smoke.mjs [url]
 *
 * HEADED=1 to watch it run.
 */
import puppeteer from "puppeteer-core";

const url = process.argv[2] ?? "http://localhost:5201/";

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}   ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.stack ?? e.message}`));

await page.evaluateOnNewDocument(() => {
  globalThis.__importLive = (p) => {
    const prefix = location.origin + p;
    const fetched = performance
      .getEntriesByType("resource")
      .map((e) => e.name)
      .filter((n) => n === prefix || n.startsWith(`${prefix}?`));
    const live = fetched.find((n) => n.includes("?")) ?? fetched[0];
    return import(/* @vite-ignore */ live ?? p);
  };
});

const run = async (body, arg) =>
  page.evaluate(
    // eslint-disable-next-line no-new-func
    (source, value) => new Function(`return (${source})`)()(value),
    body.toString(),
    arg ?? null,
  );

/** Waits `n` animation frames inside the page. */
const frames = (n) =>
  run((count) =>
    new Promise((resolve) => {
      let i = 0;
      const step = () => (++i < count ? requestAnimationFrame(step) : resolve(true));
      requestAnimationFrame(step);
    }), n);

try {
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  await page.evaluate(() => {
    [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
  });
  await page.waitForFunction(() => !!globalThis.__viewport?.orbit, { timeout: 60000 });
  await wait(4000);

  // --- Scene -----------------------------------------------------------------
  const built = await page.evaluate(async () => {
    const { ensureEngine } = await globalThis.__importLive("/src/editor/engineInstance.js");
    const engine = await ensureEngine();
    globalThis.__engine = engine;
    const THREE = globalThis.__ENGINE_THREE__;

    // A wall across the view at 20 m, and forty props hidden behind it at 60 m.
    // Each prop gets its own geometry so static batching cannot merge them —
    // otherwise the draw-call comparison at the end would be measuring batching
    // rather than culling.
    const wall = engine.createEntity({ name: "Wall" });
    wall.addComponent("mesh", { geometry: "box", castShadow: false, receiveShadow: false });
    wall.object3D.position.set(0, 0, -20);
    wall.object3D.scale.set(60, 60, 1);

    const hidden = [];
    for (let i = 0; i < 40; i++) {
      const prop = engine.createEntity({ name: `Hidden${i}` });
      const mesh = prop.addComponent("mesh", { geometry: "box", castShadow: false, receiveShadow: false });
      mesh.mesh.geometry = new THREE.BoxGeometry(1 + i * 0.001, 1, 1);
      prop.object3D.position.set(-10 + (i % 10) * 2, -4 + Math.floor(i / 10) * 2, -60);
      hidden.push(prop.id);
    }
    // One prop in front of the wall and one well off to the side: the controls,
    // and the two objects whose disappearance would be a real bug.
    const inFront = engine.createEntity({ name: "InFront" });
    inFront.addComponent("mesh", { geometry: "box", castShadow: false, receiveShadow: false });
    inFront.object3D.position.set(0, 0, -10);
    const aside = engine.createEntity({ name: "Aside" });
    aside.addComponent("mesh", { geometry: "box", castShadow: false, receiveShadow: false });
    aside.object3D.position.set(120, 0, -60);

    globalThis.__ids = { wall: wall.id, hidden, inFront: inFront.id, aside: aside.id };

    const viewport = globalThis.__viewport;
    viewport.camera.position.set(0, 0, 10);
    viewport.orbit.target.set(0, 0, -20);
    viewport.orbit.update();
    engine.scene.updateMatrixWorld(true);
    return { entities: engine.entities.size, enabled: engine.occlusion.enabled };
  });
  check("the occlusion scene was built", built.entities >= 43, `${built.entities} entities`);
  check("occlusion culling is off by default", built.enabled === false);

  await frames(10);
  const before = await run(() => {
    const e = globalThis.__engine;
    return {
      drawCalls: e.stats.readout.drawCalls,
      visible: globalThis.__ids.hidden.filter((id) => e.getEntity(id).object3D.visible).length,
    };
  });
  check(
    "with it off, all forty hidden props are drawn",
    before.visible === 40,
    `${before.visible} visible, ${before.drawCalls} draw calls`,
  );

  // --- Turn it on through the SETTINGS path (what the editor toggle does) -----
  const enabled = await run(() => {
    const e = globalThis.__engine;
    e.applySettings({
      ...e.settings,
      performance: { ...e.settings.performance, occlusionCulling: true },
    });
    return { enabled: e.occlusion.enabled };
  });
  check("the scene setting arms the system", enabled.enabled === true);

  // Several frames: one to render the depth pass, one or two for the readback
  // to land, one for the decision to be applied and drawn.
  await frames(30);

  const depth = await run(() => {
    const e = globalThis.__engine;
    const pyramid = e.occlusion.pyramid;
    if (!pyramid.ready) return { ready: false };
    const level = pyramid.levels[0];
    const at = (u, v) => level.data[Math.floor(v * level.height) * level.width + Math.floor(u * level.width)];
    return {
      ready: true,
      width: level.width,
      height: level.height,
      centre: at(0.5, 0.5),
      // Four points across the frame: a sheared readback (unstripped row
      // padding) shows up as these disagreeing, since each row would be offset a
      // little further than the last.
      corners: [at(0.2, 0.2), at(0.8, 0.2), at(0.2, 0.8), at(0.8, 0.8)],
      occluders: e.occlusion.stats.occluders,
      tested: e.occlusion.stats.tested,
      culled: e.occlusion.stats.culled,
    };
  });
  check("the depth pass produced a pyramid", depth.ready === true, `${depth.width}×${depth.height}`);
  check(
    "…holding the wall's distance in METRES, not a projected depth value",
    Math.abs(depth.centre - 30) < 1.5,
    `centre reads ${depth.centre?.toFixed?.(2)} (the wall is 30 m from the camera)`,
  );
  check(
    "…consistently across the frame, so the readback's row padding was stripped",
    depth.corners?.every((d) => Math.abs(d - depth.centre) < 2),
    `corners ${depth.corners?.map((d) => d.toFixed(1)).join(", ")}`,
  );
  check(
    "only the wall was tagged as an occluder — forty small props are not worth a draw",
    depth.occluders === 1,
    `${depth.occluders} occluders`,
  );

  const after = await run(() => {
    const e = globalThis.__engine;
    return {
      drawCalls: e.stats.readout.drawCalls,
      hidden: globalThis.__ids.hidden.filter((id) => e.getEntity(id)._occluded === true).length,
      inFront: e.getEntity(globalThis.__ids.inFront)._occluded === true,
      aside: e.getEntity(globalThis.__ids.aside)._occluded === true,
      wall: e.getEntity(globalThis.__ids.wall)._occluded === true,
      culled: e.occlusion.stats.culled,
    };
  });
  check(
    "every prop behind the wall is culled",
    after.hidden === 40,
    `${after.hidden}/40 culled, stats say ${after.culled}`,
  );
  check("the prop in FRONT of the wall is not", after.inFront === false);
  check("the prop beside the wall is not", after.aside === false);
  check("and the wall itself is not culled against its own depth", after.wall === false);
  check(
    "draw calls actually went down — the whole point",
    after.drawCalls < before.drawCalls - 30,
    `${before.drawCalls} → ${after.drawCalls}`,
  );

  // --- Moving the camera so the wall no longer covers them -------------------
  const moved = await run(() => {
    const e = globalThis.__engine;
    const viewport = globalThis.__viewport;
    // Around the side of the wall: the props are now in clear view, and the
    // stale buffer must not keep them hidden for more than the frame or two it
    // takes a new capture to land.
    viewport.camera.position.set(90, 0, -60);
    viewport.orbit.target.set(0, 0, -60);
    viewport.orbit.update();
    return new Promise((resolve) => {
      let i = 0;
      const step = () => {
        if (++i < 40) return requestAnimationFrame(step);
        resolve({
          hidden: globalThis.__ids.hidden.filter((id) => e.getEntity(id)._occluded === true).length,
          drawCalls: e.stats.readout.drawCalls,
        });
      };
      requestAnimationFrame(step);
    });
  });
  check(
    "stepping around the wall brings them all back",
    moved.hidden === 0,
    `${moved.hidden} still hidden, ${moved.drawCalls} draw calls`,
  );

  // --- Turning it off --------------------------------------------------------
  const off = await run(() => {
    const e = globalThis.__engine;
    const viewport = globalThis.__viewport;
    viewport.camera.position.set(0, 0, 10);
    viewport.orbit.target.set(0, 0, -20);
    viewport.orbit.update();
    return new Promise((resolve) => {
      let i = 0;
      const step = () => {
        if (i === 25) {
          const stillHidden = globalThis.__ids.hidden.filter((id) => e.getEntity(id)._occluded === true).length;
          e.applySettings({
            ...e.settings,
            performance: { ...e.settings.performance, occlusionCulling: false },
          });
          globalThis.__stillHidden = stillHidden;
        }
        if (++i < 32) return requestAnimationFrame(step);
        resolve({
          culledWhileOn: globalThis.__stillHidden,
          occluded: globalThis.__ids.hidden.filter((id) => e.getEntity(id)._occluded === true).length,
          visible: globalThis.__ids.hidden.filter((id) => e.getEntity(id).object3D.visible).length,
          layerTags: globalThis.__ids.hidden.filter((id) => {
            const mesh = e.getEntity(id).getComponent("mesh").mesh;
            return mesh.layers.isEnabled(29);
          }).length,
        });
      };
      requestAnimationFrame(step);
    });
  });
  check("the props were culled again when the camera came back", off.culledWhileOn === 40, `${off.culledWhileOn}/40`);
  check(
    "switching it off puts every one of them back on screen",
    off.occluded === 0 && off.visible === 40,
    `${off.visible}/40 visible`,
  );
  check(
    "…and clears the occluder layer tags it wrote, so batching is not left split",
    off.layerTags === 0,
    `${off.layerTags} still tagged`,
  );

  // The filter is narrow ON PURPOSE. An earlier version dropped anything
  // matching /WebGPU/, which swallowed "Render pipeline creation failed …" —
  // the message that was the entire reason the depth pass wrote nothing. A
  // validation error from the backend is exactly the class of failure a smoke
  // exists to catch, so only the known-benign startup noise is ignored.
  const real = errors.filter((e) => {
    if (/GPUValidationError|pipeline creation failed|Uncaptured/i.test(e)) return true;
    if (/GPUAdapter|Deprecation|favicon|WebGPU is experimental/i.test(e)) return false;
    return !/Failed to load resource/i.test(e);
  });
  if (real.length) {
    console.log("\nConsole errors:");
    for (const e of real.slice(0, 8)) console.log(`  ${e}`);
  }
  check("no console errors", real.length === 0, `${real.length}`);
} catch (error) {
  check("the smoke ran to completion", false, error.message);
} finally {
  await browser.close();
}

console.log(`\nOCCLUSION-SMOKE ${fail ? "FAIL" : "PASS"} — ${pass}/${pass + fail} checks`);
process.exit(fail ? 1 : 0);
