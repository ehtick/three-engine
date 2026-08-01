/**
 * LOD groups in a real browser, against a real WebGPU frame (roadmap item 14).
 *
 * The headless test proves the arithmetic. This proves the two things only a
 * live frame can:
 *
 *   - that the level the system PICKED is the level whose pixels are on screen
 *     — the engine resolves `object3D.visible` itself, once per frame, and an
 *     LOD group that wrote that field directly would be silently overwritten
 *     with nothing to see but "the LODs do nothing",
 *   - that a switch does not leave the previous level still drawing through a
 *     static batch's instanced proxy, which is invisible to every headless
 *     check because the member's own `visible` flag is correctly false.
 *
 *   npx vite --port 5201
 *   node scripts/run-lod-smoke.mjs [url]
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

// Vite serves a touched module as both `foo.js` and `foo.js?t=<mtime>`, and
// importing the wrong one gets a SECOND Engine singleton that no panel is
// looking at. Import whichever URL the page actually fetched.
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

    // One prop, three levels, each a flatly-lit distinct colour so a pixel
    // read says WHICH level is drawn rather than merely that something is.
    // Same size at every level: an LOD chain whose bounding sphere changed per
    // level would be measuring a different object each time it switched.
    globalThis.__COLORS = ["#ff2020", "#20ff20", "#2060ff"];
    const group = engine.createEntity({ name: "Prop" });
    group.object3D.position.set(0, 2, 0);
    const children = [];
    for (let i = 0; i < 3; i++) {
      const child = engine.createEntity({ name: `Prop_LOD${i}` });
      child.setParent(group);
      child.addComponent("mesh", { geometry: "box", castShadow: false, receiveShadow: false });
      children.push(child.id);
    }
    const component = group.addComponent("lod", { levels: [0.5, 0.25, 0.06], hysteresis: 0.05 });

    globalThis.__ids = { group: group.id, children };
    globalThis.__lod = component;

    // Aim straight down the +Z axis at the prop, so the object's centre is the
    // frame's centre and the floor grid never crosses it.
    const viewport = globalThis.__viewport;
    viewport.orbit.target.set(0, 2, 0);
    viewport.camera.position.set(0, 2, 10);
    viewport.orbit.update();
    engine.scene.updateMatrixWorld(true);
    return { levels: component.levelCount };
  });
  check("the LOD scene was built", built.levels === 3, `${built.levels} levels`);
  await wait(1200);

  // Colour the levels only NOW. A mesh component resolves its material
  // asynchronously (an empty `material` prop still means "load the default"),
  // so an override applied in the same tick as `addComponent` is quietly
  // replaced by white when that load lands — and every colour assertion below
  // then reads the same lit grey and blames the LOD system.
  const materials = await run(() => {
    const e = globalThis.__engine;
    const THREE = globalThis.__ENGINE_THREE__;
    return globalThis.__ids.children.map((id, i) => {
      const component = e.getEntity(id).getComponent("mesh");
      // Basic, not physical: the check is "which level is drawn", and a lit
      // material makes that a question about the scene's lighting instead.
      component.mesh.material = new THREE.MeshBasicNodeMaterial({
        color: new THREE.Color(globalThis.__COLORS[i]),
      });
      const m = component.mesh.material;
      return { type: m.type, color: m.color?.getHexString?.() ?? null };
    });
  });
  check(
    "each level kept the distinct colour this test gave it",
    materials.map((m) => m.color).join(",") === "ff2020,20ff20,2060ff",
    JSON.stringify(materials),
  );

  /**
   * Parks the camera at the distance that yields `coverage`, waits for the
   * frame, and reports what the system chose AND what is actually on screen.
   */
  const at = async (coverage) =>
    run((target) => {
      const e = globalThis.__engine;
      const viewport = globalThis.__viewport;
      const THREE = globalThis.__ENGINE_THREE__;
      const component = e.getEntity(globalThis.__ids.group).getComponent("lod");

      // Solve for the distance rather than guessing one: the viewport's fov and
      // aspect are whatever the panel happens to be, and a hard-coded distance
      // would put the test in a different band on a different window size.
      const sphere = new THREE.Sphere();
      const box = new THREE.Box3().setFromObject(e.getEntity(globalThis.__ids.group).object3D);
      box.getBoundingSphere(sphere);
      const fov = (viewport.camera.fov * Math.PI) / 180;
      const distance = (sphere.radius * 2) / (2 * Math.tan(fov / 2) * target);
      viewport.camera.position.set(0, 2, distance);
      viewport.orbit.target.set(0, 2, 0);
      viewport.orbit.update();

      return new Promise((resolve) => {
        // Three frames: one for the LOD pass to see the new camera, one for the
        // batch rebuild it may have triggered, one to be drawn.
        requestAnimationFrame(() =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              const src = e.renderer.domElement;
              const c = document.createElement("canvas");
              c.width = src.width;
              c.height = src.height;
              const ctx = c.getContext("2d");
              ctx.drawImage(src, 0, 0);
              // Off the exact centre and averaged over a patch: a single pixel
              // at dead centre reads whatever overlay the editor draws there.
              const px = Math.floor(c.width / 2) + 6;
              const py = Math.floor(c.height / 2) + 6;
              const d = ctx.getImageData(px - 3, py - 3, 7, 7).data;
              const sum = [0, 0, 0];
              for (let i = 0; i < d.length; i += 4) {
                sum[0] += d[i];
                sum[1] += d[i + 1];
                sum[2] += d[i + 2];
              }
              const n = d.length / 4;
              resolve({
                level: component.activeLevel,
                coverage: component.coverage,
                pixel: sum.map((v) => Math.round(v / n)),
                visible: globalThis.__ids.children.map((id) => e.getEntity(id).object3D.visible),
              });
            }),
          ),
        );
      });
    }, coverage);

  /** Which of the three level colours a sampled pixel is closest to (-1 = none). */
  const colorOf = (pixel) => {
    const targets = [
      [255, 32, 32],
      [32, 255, 32],
      [32, 96, 255],
    ];
    let best = -1;
    let bestD = 90; // generous: tonemapping and the output transform move these
    targets.forEach((t, i) => {
      const d = Math.abs(t[0] - pixel[0]) + Math.abs(t[1] - pixel[1]) + Math.abs(t[2] - pixel[2]);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  };

  // --- The chosen level is the level on screen -------------------------------
  const near = await at(0.7);
  check("close up it picks the finest level", near.level === 0, `coverage ${near.coverage.toFixed(3)}`);
  check("…and exactly one level is visible", near.visible.filter(Boolean).length === 1, JSON.stringify(near.visible));
  check("…and LOD0's pixels are the ones on screen", colorOf(near.pixel) === 0, `rgb(${near.pixel})`);

  const mid = await at(0.35);
  check("pulling back steps to LOD1", mid.level === 1, `coverage ${mid.coverage.toFixed(3)}`);
  check("…and LOD1's pixels replace them", colorOf(mid.pixel) === 1, `rgb(${mid.pixel})`);

  const far = await at(0.12);
  check("further still steps to LOD2", far.level === 2, `coverage ${far.coverage.toFixed(3)}`);
  check("…and LOD2's pixels replace those", colorOf(far.pixel) === 2, `rgb(${far.pixel})`);

  const culled = await at(0.03);
  check("past the last threshold it culls", culled.level === -1, `coverage ${culled.coverage.toFixed(3)}`);
  check("…and no level is left drawing", culled.visible.every((v) => !v), JSON.stringify(culled.visible));
  check("…so no level colour is on screen", colorOf(culled.pixel) === -1, `rgb(${culled.pixel})`);

  // --- Hysteresis, measured against a live render loop -----------------------
  const jitter = await run(() => {
    const e = globalThis.__engine;
    const viewport = globalThis.__viewport;
    const component = e.getEntity(globalThis.__ids.group).getComponent("lod");
    return new Promise((resolve) => {
      // Park where the measured coverage sits on the 0.5 boundary, then breathe
      // by a fraction of a percent — a prop at a fixed distance with a camera
      // that is never perfectly still.
      const base = 4.9;
      let frame = 0;
      let switches = 0;
      let previous = component.activeLevel;
      const step = () => {
        viewport.camera.position.set(0, 2, base + Math.sin(frame * 0.7) * 0.02);
        viewport.orbit.target.set(0, 2, 0);
        viewport.orbit.update();
        if (frame > 5 && component.activeLevel !== previous) switches++;
        previous = component.activeLevel;
        if (++frame < 90) return requestAnimationFrame(step);
        resolve({ switches, coverage: component.coverage });
      };
      requestAnimationFrame(step);
    });
  });
  check("a camera breathing on a threshold does not flicker", jitter.switches <= 1, `${jitter.switches} switches over 90 frames`);

  // --- Batching: the check no headless test can make -------------------------
  const batched = await run(() => {
    const e = globalThis.__engine;
    const THREE = globalThis.__ENGINE_THREE__;
    const viewport = globalThis.__viewport;
    // Twenty groups sharing one geometry + material per level: exactly the
    // shape static batching merges, and therefore exactly the shape that hides
    // a stale level behind an instanced proxy.
    const materials = globalThis.__COLORS.map((c) => new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(c) }));
    const geometries = [0, 1, 2].map(() => new THREE.BoxGeometry(1, 1, 1));
    const groups = [];
    for (let i = 0; i < 20; i++) {
      const group = e.createEntity({ name: `Farm${i}` });
      group.object3D.position.set(-10 + i, 2, -6);
      for (let level = 0; level < 3; level++) {
        const child = e.createEntity({ name: `Farm${i}_LOD${level}` });
        child.setParent(group);
        const mesh = child.addComponent("mesh", { geometry: "box", castShadow: false, receiveShadow: false });
        mesh.mesh.geometry = geometries[level];
        mesh.mesh.material = materials[level];
      }
      groups.push(group.addComponent("lod", { levels: [0.3, 0.1, 0], hysteresis: 0.02 }));
    }
    e.scene.updateMatrixWorld(true);

    const settle = (position) =>
      new Promise((resolve) => {
        viewport.camera.position.set(...position);
        viewport.orbit.target.set(0, 2, -6);
        viewport.orbit.update();
        let n = 0;
        const step = () => (++n < 6 ? requestAnimationFrame(step) : resolve());
        requestAnimationFrame(step);
      });

    return (async () => {
      await settle([0, 2, 4]); // close: everything on LOD0
      const beforeLevels = groups.map((g) => g.activeLevel);
      await settle([0, 2, 40]); // far: everything should have stepped down
      const afterLevels = groups.map((g) => g.activeLevel);

      // The real question: does any batch still hold a member whose entity the
      // LOD system has hidden? That member draws through the proxy regardless
      // of its own `visible`, so finding one means two levels on screen.
      let staleMembers = 0;
      let batchedMembers = 0;
      for (const batch of e.batching.batches) {
        for (const member of batch.members) {
          batchedMembers++;
          const entity = e.entities.get(member.userData.entityId);
          if (entity?._lodHidden === true) staleMembers++;
        }
      }
      return {
        beforeLevels,
        afterLevels,
        staleMembers,
        batchedMembers,
        batches: e.batching.batches.length,
        saved: e.batching.savedDrawCalls,
      };
    })();
  });
  // Asserted as "the same level" rather than "level 0": these twenty sit in a
  // row eleven metres wide, so how much of the frame each covers depends on the
  // panel's fov and aspect. Pinning an absolute level here would make the test
  // fail when someone resizes a dock.
  check(
    "twenty identical props in a row all agree on a level",
    new Set(batched.beforeLevels).size === 1,
    `levels ${[...new Set(batched.beforeLevels)]}`,
  );
  check(
    "…and all step to a coarser one together when the camera pulls back",
    batched.afterLevels.every((l, i) => l === -1 || l > batched.beforeLevels[i]),
    `${[...new Set(batched.beforeLevels)]} → ${[...new Set(batched.afterLevels)]}`,
  );
  check("they are actually being batched", batched.batchedMembers > 0, `${batched.batchedMembers} members in ${batched.batches} batches, ${batched.saved} draw calls saved`);
  check(
    "no batch is still drawing a level the LOD system hid",
    batched.staleMembers === 0,
    `${batched.staleMembers} stale members`,
  );

  // --- Removing it gives the scene back --------------------------------------
  const restored = await run(() => {
    const e = globalThis.__engine;
    const group = e.getEntity(globalThis.__ids.group);
    group.removeComponent("lod");
    return new Promise((resolve) => {
      requestAnimationFrame(() =>
        requestAnimationFrame(() =>
          resolve({ visible: globalThis.__ids.children.map((id) => e.getEntity(id).object3D.visible) }),
        ),
      );
    });
  });
  check(
    "removing the component puts every level back on screen",
    restored.visible.every(Boolean),
    JSON.stringify(restored.visible),
  );

  const real = errors.filter((e) => {
    if (/WebGPU|GPUAdapter|Deprecation|favicon/i.test(e)) return false;
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

console.log(`\nLOD-SMOKE ${fail ? "FAIL" : "PASS"} — ${pass}/${pass + fail} checks`);
process.exit(fail ? 1 : 0);
