/**
 * The selection outline, measured in pixels, in the real editor.
 *
 * The claim under test is entirely visual and entirely screen-space, so there
 * is nothing a headless unit test could assert about it: the outline is not an
 * object in the scene graph (the bounding box it replaced was), it has no
 * transform to read back, and its whole point is a CONSTANT PIXEL WIDTH around
 * a silhouette — a property that only exists once something has been rasterised.
 * So this reads the live canvas.
 *
 * What it checks:
 *   - orange pixels appear just OUTSIDE a selected box's silhouette, and only
 *     there: not further out, and not across the object's own face (an outline
 *     that fills the shape is the classic dilate-without-subtracting-the-mask
 *     bug, and it looks perfectly fine in a thumbnail),
 *   - the ring traces the SILHOUETTE and not a bounding box — measured on a
 *     45°-yawed box, where the two differ by definition,
 *   - it closes over the top edge as well as the sides (a separable dilation
 *     that only ran on one axis passes every other check here),
 *   - deselecting removes it, and the Gizmos layer toggle owns it,
 *   - the active object is drawn in a lighter orange than the rest of the
 *     selection (Blender's distinction),
 *   - the mask pass leaves no trace: every layer mask and visibility flag it
 *     touches is the same after a frame as before, which is what keeps it from
 *     quietly dismantling static batching,
 *   - and `viewport.screenshot(includeGizmos)` shows it, so an agent can see
 *     what the user sees.
 *
 * TWO THINGS THIS HARNESS HAD TO LEARN, both of which cost a debugging round:
 *
 *   - The measurement runs INSIDE a post-render callback, not in a `requestAnimationFrame`
 *     after the fact. The editor's frame pacing suspends the render loop when
 *     nothing is changing, and `drawImage` of a WebGPU canvas that did not
 *     render this frame returns a BLANK image — not the last frame. Read from
 *     outside the loop and every pixel is zero, which looks exactly like "the
 *     feature draws nothing". `__editorKeepRendering` (the pin flag
 *     `editorFramePacing.js` already honours) keeps the loop alive.
 *   - Post-render callbacks run in registration order, so a capture registered
 *     after the panel's own outline pass sees the composited frame.
 *
 * The measurements themselves also run inside the page — a 1280x800 frame is
 * four million numbers, and moving that across the bridge is slower than the
 * render it is measuring.
 *
 *   npx vite --port 5201
 *   node scripts/run-selection-outline-smoke.mjs [url]
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
const notFound = [];
page.on("response", (r) => {
  if (r.status() === 404) notFound.push(r.url());
});
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.stack ?? e.message}`));

// Vite serves a touched module as both `foo.js` and `foo.js?t=<mtime>`, and
// importing the wrong one gets a SECOND module instance no panel is looking at.
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
  //
  // A SPHERE on the left half of the screen and a box on the right, both flat
  // blue and unlit.
  //
  // The sphere is the load-bearing choice. Its silhouette is a circle and its
  // bounding box is a square, so the corner of the box is far — a quarter of a
  // radius — from anything the object actually covers. That corner is where the
  // helper this replaced drew a line, and it is the one place where "traces the
  // silhouette" and "traces the bounds" give different pixels. A rotated cube
  // does NOT separate them: seen head-on, its projected corner IS its bounding
  // box corner.
  //
  // Flat unlit blue, because every assertion below is "is this pixel orange",
  // and a lit grey object under a sky gradient is orange-ish in places all by
  // itself.
  const built = await run(async () => {
    // Pin the render loop awake for the whole run — see the header.
    globalThis.__editorKeepRendering = true;
    const { ensureEngine } = await globalThis.__importLive("/src/editor/engineInstance.js");
    const engine = await ensureEngine();
    const { useSelectionStore } = await globalThis.__importLive("/src/editor/store/selectionStore.js");
    globalThis.__engine = engine;
    globalThis.__selection = useSelectionStore;

    const THREE = globalThis.__ENGINE_THREE__;
    const viewport = globalThis.__viewport;

    engine.scene.background = new THREE.Color(0x101418);
    engine.scene.environment = null;

    const make = (name, geometry, x) => {
      const entity = engine.createEntity({ name });
      entity.addComponent("mesh", { geometry });
      // The mesh primitives are unit-sized whatever you pass as props, so the
      // scale is where the on-screen size comes from.
      entity.object3D.position.set(x, 0, 0);
      entity.object3D.scale.setScalar(3);
      entity.object3D.updateMatrixWorld(true);
      entity.getComponent("mesh").mesh.material = new THREE.MeshBasicNodeMaterial({
        color: new THREE.Color(0x1030ff),
      });
      return entity;
    };
    globalThis.__shapeA = make("OutlineSphere", "sphere", -3).id;
    globalThis.__shapeB = make("OutlineBox", "box", 3).id;

    viewport.camera.position.set(0, 0, 11);
    viewport.orbit.target.set(0, 0, 0);
    viewport.orbit.update();
    engine.scene.updateMatrixWorld(true);
    return { a: globalThis.__shapeA, b: globalThis.__shapeB };
  });
  check("a sphere and a box were built", !!built.a && !!built.b, `${built.a} / ${built.b}`);
  // The 3D cursor sits at the origin and is yellow; keeping it out of frame is
  // one less thing for the colour classifier to be careful about.
  // The grid and the 3D cursor are the only other things the empty scene draws.
  // Switching them off makes "not the background" a sound test for "the shape",
  // which is what keeps the measurement independent of the output transform.
  await run(async () => {
    const { setLayerVisible } = await globalThis.__importLive("/src/editor/panels/ViewportPanel.jsx");
    setLayerVisible("cursor3D", false);
    setLayerVisible("grid", false);
  });
  await wait(800);

  // --- The one page-side measurement ----------------------------------------
  //
  // Waits for two completed frames (so the readback can't catch a half-applied
  // state change) and then measures the outline AGAINST THE RENDERED SHAPES,
  // not against a projection of where they ought to be.
  //
  // That is deliberate and it cost a debugging round to learn: projecting the
  // entity's corners with the viewport camera quietly assumed a 2-unit box,
  // when `geometry: "box"` is unit-sized whatever props you pass — so the
  // "silhouette edge" the harness scanned was 20px inside the real one, every
  // check came back zero, and it read exactly like a feature that draws
  // nothing. The shape's own blue pixels cannot be wrong about where it is.
  const measure = () =>
    run(() => {
      const engine = globalThis.__engine;
      return new Promise((resolve, reject) => {
        // Registered last, so it runs after the viewport's own outline pass
        // in the same frame. Skipping one frame first lets whatever state the
        // caller just changed reach a completed render.
        let frames = 0;
        const started = performance.now();
        const off = engine.onPostRender(() => {
          if (++frames < 2) return;
          off();
          {
            const src = engine.renderer.domElement;
            const c = document.createElement("canvas");
            c.width = src.width;
            c.height = src.height;
            const ctx = c.getContext("2d");
            ctx.drawImage(src, 0, 0);
            const data = ctx.getImageData(0, 0, c.width, c.height).data;

            const at = (x, y) => {
              const i = (Math.round(y) * c.width + Math.round(x)) * 4;
              return [data[i], data[i + 1], data[i + 2]];
            };
            // Orange in the outline's sense: red-dominant with a real red-blue
            // gap. Both theme colours (#ffa040 active, #ed5700 selected) pass;
            // the scene's blue-grey, the grid's neutral grey and the shapes'
            // blue do not.
            const orange = (p) => p[0] > 90 && p[0] - p[2] > 55 && p[0] - p[1] > 25 && p[1] >= p[2];
            // The shapes' own pixels: anything that is neither the flat
            // background nor the outline. Classifying by "not the background"
            // rather than by the material's colour keeps this independent of
            // the output transform — the renderer's tone mapping moves an
            // authored colour a long way, and a hard-coded RGB test for the
            // surface silently matches nothing when it does.
            const bg = at(2, 2);
            const shape = (p) =>
              !orange(p) &&
              (Math.abs(p[0] - bg[0]) > 12 || Math.abs(p[1] - bg[1]) > 12 || Math.abs(p[2] - bg[2]) > 12);
            const scanRow = (y, x0, x1) => {
              const hits = [];
              for (let x = Math.max(0, Math.round(x0)); x <= Math.min(c.width - 1, Math.round(x1)); x++) {
                const p = at(x, y);
                if (orange(p)) hits.push(p);
              }
              return hits;
            };
            const gr = (hits) =>
              hits.length ? hits.reduce((s, p) => s + p[1] / Math.max(1, p[0]), 0) / hits.length : 0;

            // Where each shape actually IS: the bounds of its own blue pixels.
            // The sphere is left of centre, the box right of it.
            const boundsOf = (x0, x1) => {
              let left = Infinity;
              let right = -1;
              let top = Infinity;
              let bottom = -1;
              let count = 0;
              for (let y = 0; y < c.height; y++) {
                for (let x = x0; x < x1; x++) {
                  if (!shape(at(x, y))) continue;
                  count++;
                  if (x < left) left = x;
                  if (x > right) right = x;
                  if (y < top) top = y;
                  if (y > bottom) bottom = y;
                }
              }
              return { left, right, top, bottom, count };
            };
            const half = Math.round(c.width / 2);
            const a = boundsOf(0, half);
            const b = boundsOf(half, c.width);
            if (!a.count || !b.count) {
              return resolve({ error: `shapes not on screen (${a.count} / ${b.count} px)` });
            }

            const midY = Math.round((a.top + a.bottom) / 2);
            const midX = Math.round((a.left + a.right) / 2);
            // Leftmost and rightmost blue pixel ON THIS ROW, so the bands below
            // are relative to the real silhouette rather than the bounds.
            let rowLeft = a.right;
            let rowRight = a.left;
            for (let x = a.left; x <= a.right; x++) {
              if (!shape(at(x, midY))) continue;
              if (x < rowLeft) rowLeft = x;
              if (x > rowRight) rowRight = x;
            }
            let colTop = a.bottom;
            for (let y = a.top; y <= a.bottom; y++) {
              if (shape(at(midX, y))) {
                colTop = y;
                break;
              }
            }

            let topRows = 0;
            for (let y = colTop - 6; y <= colTop - 1; y++) {
              if (orange(at(midX, Math.max(0, y)))) topRows++;
            }

            // The sphere's bounding-box corner. Its silhouette passes a quarter
            // of a radius away from here; the helper this replaced drew a line
            // straight through it.
            let corner = 0;
            for (let y = a.top - 3; y <= a.top + 3; y++) {
              for (let x = a.left - 3; x <= a.left + 3; x++) {
                if (orange(at(Math.max(0, x), Math.max(0, y)))) corner++;
              }
            }

            const ringA = scanRow(midY, rowLeft - 6, rowLeft - 1);
            const ringB = scanRow(Math.round((b.top + b.bottom) / 2), b.right + 1, b.right + 6);
            return resolve({
              canvas: [c.width, c.height],
              boundsA: a,
              boundsB: b,
              ringA: ringA.length,
              ringAColor: gr(ringA),
              ringASample: ringA[0] ?? null,
              ringB: ringB.length,
              ringBColor: gr(ringB),
              far: scanRow(midY, rowLeft - 44, rowLeft - 22).length,
              face: scanRow(midY, rowLeft + 6, rowRight - 6).length,
              corner,
              topRows,
            });
          }
        });
        // The pacing restarts a suspended loop on its own sample interval, so
        // a stall here means the loop never came back — say so rather than
        // hanging the bridge until it times out.
        const guard = setInterval(() => {
          if (frames >= 2) return clearInterval(guard);
          if (performance.now() - started > 8000) {
            clearInterval(guard);
            off();
            reject(new Error(`the render loop produced ${frames} frame(s) in 8s`));
          }
        }, 250);
      });
    });

  // --- Selected: the ring is where the silhouette is -------------------------
  await run(() => {
    globalThis.__selection.getState().select(globalThis.__shapeA);
    // The transform gizmo's own red X arrow reaches out through exactly the
    // band this test measures, and it is red enough to read as an outline.
    // Hiding the helper leaves the outline alone — that is gated on the Gizmos
    // LAYER, not on this flag.
    globalThis.__viewport.gizmo.getHelper().visible = false;
  });
  await wait(700);
  const one = await measure();
  if (one.error) throw new Error(one.error);

  check(
    "orange pixels sit just outside the silhouette's left edge",
    one.ringA >= 2,
    `${one.ringA} of a 6px band, e.g. rgb(${one.ringASample ?? "—"})`,
  );
  check("…and nothing orange 22-44px further out", one.far === 0, `${one.far} stray hit(s)`);
  check(
    "…and the face itself is not filled in (the mask is subtracted back out)",
    one.face === 0,
    `${one.face} orange pixel(s) across the face`,
  );
  check(
    "it traces the silhouette, not the bounding box",
    one.corner === 0,
    `${one.corner} hit(s) in the 7x7 patch at the sphere's bounds corner`,
  );
  check("…and the ring closes over the top edge too", one.topRows >= 2, `${one.topRows} row(s)`);
  check("…and the unselected shape has none", one.ringB === 0, `${one.ringB} hit(s)`);

  // --- Deselect --------------------------------------------------------------
  await run(() => globalThis.__selection.getState().clear());
  await wait(700);
  const none = await measure();
  check("deselecting removes it", none.ringA === 0, `${none.ringA} leftover hit(s)`);

  // --- Active vs merely selected --------------------------------------------
  await run(() => {
    // anchorId is the editor's "active object": the last plainly-clicked id.
    globalThis.__selection.getState().select([globalThis.__shapeA, globalThis.__shapeB], globalThis.__shapeB);
    globalThis.__viewport.gizmo.getHelper().visible = false;
  });
  await wait(700);
  const multi = await measure();
  check(
    "every selected object gets its own outline",
    multi.ringA >= 2 && multi.ringB >= 2,
    `${multi.ringA} + ${multi.ringB} hit(s)`,
  );
  check(
    "…and the ACTIVE one is a lighter orange than the rest",
    multi.ringBColor > multi.ringAColor + 0.08,
    `active g/r ${multi.ringBColor.toFixed(2)} vs selected ${multi.ringAColor.toFixed(2)}`,
  );

  // --- The Gizmos layer toggle owns it --------------------------------------
  const setGizmos = (visible) =>
    run(async (value) => {
      const { setLayerVisible } = await globalThis.__importLive("/src/editor/panels/ViewportPanel.jsx");
      setLayerVisible("gizmos", value);
    }, visible);
  await setGizmos(false);
  await wait(700);
  const off = await measure();
  check("switching the Gizmos layer off switches the outline off", off.ringA === 0, `${off.ringA} hit(s)`);
  await setGizmos(true);
  await wait(500);

  // --- The mask pass leaves nothing behind ----------------------------------
  //
  // It stamps a private layer bit on the selected meshes and forces batch
  // members visible for the duration of one pass. `mesh.layers.mask` is part of
  // the static batching key, so a bit surviving the frame is not cosmetic — it
  // silently regroups the scene on the next rebuild.
  const residue = await run(() => {
    const engine = globalThis.__engine;
    const before = [];
    engine.scene.traverse((o) => {
      if (o.isMesh) before.push({ object: o, mask: o.layers.mask, visible: o.visible });
    });
    return new Promise((resolve) => {
      let frames = 0;
      const off = engine.onPostRender(() => {
        if (++frames < 2) return;
        off();
        let changed = 0;
        let stamped = 0;
        for (const entry of before) {
          if (entry.object.layers.mask !== entry.mask || entry.object.visible !== entry.visible) changed++;
          // bits 25/26 — SELECTION_ACTIVE_LAYER / SELECTION_MASK_LAYER
          if (entry.object.layers.mask & ((1 << 25) | (1 << 26))) stamped++;
        }
        resolve({ changed, stamped, total: before.length });
      });
    });
  });
  check(
    "the mask pass restores every layer mask and visibility flag it touched",
    residue.changed === 0 && residue.stamped === 0,
    `${residue.changed} changed, ${residue.stamped} still stamped, of ${residue.total} meshes`,
  );

  // --- A screenshot shows what the user sees ---------------------------------
  const shot = await run(async () => {
    const Editor = globalThis.__editorApi;
    if (!Editor) return { error: "installEditorApi() never ran" };
    const decode = async (result) => {
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = `data:image/png;base64,${result.__image.base64}`;
      });
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, c.width, c.height).data;
      let orange = 0;
      for (let i = 0; i < data.length; i += 4) {
        const p = [data[i], data[i + 1], data[i + 2]];
        if (p[0] > 90 && p[0] - p[2] > 55 && p[0] - p[1] > 25 && p[1] >= p[2]) orange++;
      }
      return orange;
    };
    return {
      with: await decode(await Editor.call("viewport.screenshot", { width: 320, height: 240, includeGizmos: true })),
      without: await decode(await Editor.call("viewport.screenshot", { width: 320, height: 240 })),
    };
  });
  check(
    "viewport.screenshot(includeGizmos) shows the outline",
    !shot.error && shot.with > 40,
    shot.error ?? `${shot.with} orange px`,
  );
  check("…and the default screenshot still doesn't", !shot.error && shot.without === 0, `${shot.without} orange px`);

  // --- No errors -------------------------------------------------------------
  //
  // A bare "Failed to load resource: 404" console line carries no URL, so it is
  // matched against the responses actually seen — the editor 404s on its own
  // favicon in dev, and failing the run for that would train everyone to ignore
  // this check.
  const realMisses = notFound.filter((u) => !/favicon|\.map$/i.test(u));
  const relevant = errors.filter(
    (e) => !/favicon|WebSocket|Download the React/i.test(e) && !(/404/.test(e) && realMisses.length === 0),
  );
  check("no console errors", relevant.length === 0, relevant.slice(0, 3).join(" | "));
  check("nothing 404ed", realMisses.length === 0, realMisses.slice(0, 3).join(" | "));
} catch (err) {
  check("harness ran", false, err?.stack ?? String(err));
} finally {
  await browser.close();
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
