/**
 * Splines as a scene TOOL, in the real editor (roadmap item 16).
 *
 * `test:spline` proves the arithmetic. Everything here is a claim the headless
 * suite structurally cannot make:
 *
 *   - that a knot handle is where the knot is *on screen*, and stays a constant
 *     size in pixels as the camera moves — the whole reason the handles are
 *     scaled per frame rather than given a world radius,
 *   - that a real click on a handle selects it and hands the transform gizmo
 *     over to it, instead of re-selecting the path entity out from under it,
 *   - that Ctrl+click on the drawn curve inserts a knot BETWEEN the right pair
 *     rather than appending one to the end (the two are indistinguishable in a
 *     unit test and unmistakable in a viewport),
 *   - that a drag is ONE undo step,
 *   - and that the swept road is really on screen and really moves when a knot
 *     does — a pixel readback, because a triangle count says nothing about
 *     whether anything was drawn.
 *
 *   npx vite --port 5201
 *   node scripts/run-spline-smoke.mjs [url]
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
  const built = await page.evaluate(async () => {
    const { ensureEngine } = await globalThis.__importLive("/src/editor/engineInstance.js");
    const engine = await ensureEngine();
    globalThis.__engine = engine;
    const editing = await globalThis.__importLive("/src/editor/splineEditing.js");
    globalThis.__editing = editing;
    const { commandBus } = await globalThis.__importLive("/src/editor/commands/CommandBus.js");
    globalThis.__bus = commandBus;
    const { useSelectionStore } = await globalThis.__importLive("/src/editor/store/selectionStore.js");
    globalThis.__selection = useSelectionStore;

    // An L-shaped road in the XZ plane, seen from directly above. Overhead is
    // the framing an author actually lays a road in, and it makes every knot's
    // screen position a simple function of its world X/Z.
    const path = engine.createEntity({ name: "Road" });
    path.addComponent("spline", {
      knots: [
        { position: [-8, 0, -6] },
        { position: [0, 0, -6] },
        { position: [8, 0, 4] },
      ],
      type: "catmullrom",
    });
    path.addComponent("splineMesh", { profile: "road", width: 3, density: 2 });
    globalThis.__pathId = path.id;

    const viewport = globalThis.__viewport;
    viewport.camera.position.set(0, 26, 0.01);
    viewport.orbit.target.set(0, 0, 0);
    viewport.orbit.update();
    engine.scene.updateMatrixWorld(true);
    useSelectionStore.getState().select(path.id);
    return {
      length: path.getComponent("spline").length,
      triangles: path.getComponent("splineMesh").triangleCount,
    };
  });
  check("a road entity with a path and a swept mesh was built", built.triangles > 0, `${built.triangles} triangles`);
  check("the path measured a sensible length", built.length > 18 && built.length < 30, built.length.toFixed(2));
  await wait(1500);

  // --- The road is genuinely on screen ---------------------------------------
  /** Averages a patch of the live canvas at a projected WORLD point. */
  const sampleAt = async (worldPoint) =>
    run((point) => {
      const e = globalThis.__engine;
      const THREE = globalThis.__ENGINE_THREE__;
      const viewport = globalThis.__viewport;
      return new Promise((resolve) => {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const v = new THREE.Vector3(point[0], point[1], point[2]).project(viewport.camera);
            const src = e.renderer.domElement;
            const c = document.createElement("canvas");
            c.width = src.width;
            c.height = src.height;
            c.getContext("2d").drawImage(src, 0, 0);
            const px = Math.round((v.x * 0.5 + 0.5) * c.width);
            const py = Math.round((-v.y * 0.5 + 0.5) * c.height);
            const d = c.getContext("2d").getImageData(Math.max(0, px - 3), Math.max(0, py - 3), 7, 7).data;
            const sum = [0, 0, 0];
            for (let i = 0; i < d.length; i += 4) {
              sum[0] += d[i];
              sum[1] += d[i + 1];
              sum[2] += d[i + 2];
            }
            const n = d.length / 4;
            resolve({ pixel: sum.map((v2) => Math.round(v2 / n)), px, py });
          }),
        );
      });
    }, worldPoint);

  // Colour the road so a pixel read says "the road" rather than "something".
  await run(() => {
    const e = globalThis.__engine;
    const THREE = globalThis.__ENGINE_THREE__;
    const mesh = e.getEntity(globalThis.__pathId).getComponent("splineMesh");
    mesh.mesh.material = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color("#ff2080") });
  });
  await wait(600);

  // Magenta rather than a brightness test: the output transform lifts every
  // channel, so "is it bright" is true of the editor's own background too.
  const isRoad = (pixel) => pixel[0] - pixel[1] > 60 && pixel[0] - pixel[2] > 40;

  // Sampled OFF the centre line and away from every knot. From directly
  // overhead the path's own gizmo polyline lies exactly along the centre of the
  // road it generated, and a knot handle is a white sphere drawn on top of it —
  // aim at either and the readback reports the overlay, not the road.
  const ROAD_POINT = [-4, 0.02, -6.9];
  const onRoad = await sampleAt(ROAD_POINT);
  check("the swept road's pixels are on screen", isRoad(onRoad.pixel), `rgb(${onRoad.pixel})`);
  const offRoad = await sampleAt([0, 0.02, 8]);
  check("…and only where the road is", !isRoad(offRoad.pixel), `rgb(${offRoad.pixel})`);

  // --- Edit mode + handles ---------------------------------------------------
  const armed = await run(() => {
    globalThis.__editing.setSplineEditArmed(true);
    return new Promise((resolve) => {
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const e = globalThis.__engine;
          const knots = e.scene.getObjectByName("__splineKnots");
          const tangents = e.scene.getObjectByName("__splineTangents");
          resolve({ knots: knots?.count ?? -1, tangents: tangents?.count ?? -1 });
        }),
      );
    });
  });
  check("arming edit mode puts a handle on every knot", armed.knots === 3, `${armed.knots} handles`);
  check(
    "…and no tangent handles on a catmull-rom path, whose handles are derived",
    armed.tangents === 0,
    `${armed.tangents}`,
  );

  /** Screen coords (client px) of knot `i`'s handle. */
  const handleScreen = async (index) =>
    run((i) => {
      const e = globalThis.__engine;
      const THREE = globalThis.__ENGINE_THREE__;
      const viewport = globalThis.__viewport;
      const spline = e.getEntity(globalThis.__pathId).getComponent("spline");
      const knot = spline.props.knots[i];
      const p = new THREE.Vector3().fromArray(knot.position);
      e.getEntity(globalThis.__pathId).object3D.updateWorldMatrix(true, false);
      p.applyMatrix4(e.getEntity(globalThis.__pathId).object3D.matrixWorld).project(viewport.camera);
      const rect = viewport.canvas.getBoundingClientRect();
      return {
        x: rect.left + (p.x * 0.5 + 0.5) * rect.width,
        y: rect.top + (-p.y * 0.5 + 0.5) * rect.height,
      };
    }, index);

  /** On-screen radius of a handle instance, in pixels. */
  const handlePixels = async (index) =>
    run((i) => {
      const e = globalThis.__engine;
      const THREE = globalThis.__ENGINE_THREE__;
      const viewport = globalThis.__viewport;
      const mesh = e.scene.getObjectByName("__splineKnots");
      const m = new THREE.Matrix4();
      mesh.getMatrixAt(i, m);
      const centre = new THREE.Vector3().setFromMatrixPosition(m);
      const radius = new THREE.Vector3().setFromMatrixScale(m).x;
      const edge = centre.clone().add(
        new THREE.Vector3().setFromMatrixColumn(viewport.camera.matrixWorld, 0).multiplyScalar(radius),
      );
      const rect = viewport.canvas.getBoundingClientRect();
      const toPx = (v) => {
        const p = v.clone().project(viewport.camera);
        return [(p.x * 0.5 + 0.5) * rect.width, (-p.y * 0.5 + 0.5) * rect.height];
      };
      const a = toPx(centre);
      const b = toPx(edge);
      return Math.hypot(b[0] - a[0], b[1] - a[1]);
    }, index);

  const nearPixels = await handlePixels(0);
  await run(() => {
    const viewport = globalThis.__viewport;
    viewport.camera.position.set(0, 90, 0.01);
    viewport.orbit.update();
  });
  await wait(500);
  const farPixels = await handlePixels(0);
  check(
    "handles keep their size in PIXELS as the camera pulls back",
    Math.abs(nearPixels - farPixels) / Math.max(1, nearPixels) < 0.15,
    `${nearPixels.toFixed(1)}px → ${farPixels.toFixed(1)}px`,
  );
  await run(() => {
    const viewport = globalThis.__viewport;
    viewport.camera.position.set(0, 26, 0.01);
    viewport.orbit.update();
  });
  await wait(500);

  // --- Clicking a handle -----------------------------------------------------
  const knot1 = await handleScreen(1);
  await page.mouse.click(knot1.x, knot1.y);
  await wait(400);
  const picked = await run(() => {
    const editing = globalThis.__editing;
    const viewport = globalThis.__viewport;
    return {
      selection: editing.getSplineEdit().selection,
      gizmoTarget: viewport.gizmo.object?.name ?? null,
      entitySelection: globalThis.__selection.getState().ids.length,
    };
  });
  check("clicking a knot selects it", picked.selection?.knot === 1, JSON.stringify(picked.selection));
  check(
    "…and the transform gizmo moves onto the knot, not the path entity",
    picked.gizmoTarget === "__splineHandleProxy",
    `${picked.gizmoTarget}`,
  );
  check("…while the path entity stays selected, so edit mode survives", picked.entitySelection === 1);

  // --- Dragging a knot -------------------------------------------------------
  const dragged = await run(() => {
    const e = globalThis.__engine;
    const editing = globalThis.__editing;
    const spline = e.getEntity(globalThis.__pathId).getComponent("spline");
    const before = JSON.stringify(spline.props.knots);
    const undoBefore = globalThis.__bus.undoStack?.length ?? 0;
    // Drive the proxy the way the gizmo does, through the same three calls the
    // viewport wires to its drag events.
    editing.beginSplineDrag();
    const proxy = editing.splineHandleProxy();
    for (let i = 0; i < 10; i++) {
      proxy.position.z -= 0.6;
      editing.applySplineDrag();
    }
    editing.commitSplineDrag();
    return {
      before,
      after: JSON.stringify(spline.props.knots),
      z: spline.props.knots[1].position[2],
      steps: (globalThis.__bus.undoStack?.length ?? 0) - undoBefore,
    };
  });
  check("dragging a knot moves it", dragged.z < -10, `z = ${dragged.z}`);
  check("…and the whole drag is ONE undo step", dragged.steps === 1, `${dragged.steps} steps`);

  const roadMoved = await sampleAt(ROAD_POINT);
  check(
    "…and the swept road followed the knot off that spot",
    !isRoad(roadMoved.pixel),
    `rgb(${roadMoved.pixel})`,
  );

  const undone = await run(() => {
    globalThis.__bus.undo();
    const spline = globalThis.__engine.getEntity(globalThis.__pathId).getComponent("spline");
    return { knots: JSON.stringify(spline.props.knots), z: spline.props.knots[1].position[2] };
  });
  check("one Ctrl+Z puts the knot back where it started", Math.abs(undone.z + 6) < 1e-6, `z = ${undone.z}`);
  await wait(500);
  const roadBack = await sampleAt(ROAD_POINT);
  check("…and the road with it", isRoad(roadBack.pixel), `rgb(${roadBack.pixel})`);

  // --- Ctrl+click inserts on the curve ---------------------------------------
  const insertPoint = await run(() => {
    const e = globalThis.__engine;
    const THREE = globalThis.__ENGINE_THREE__;
    const viewport = globalThis.__viewport;
    const entity = e.getEntity(globalThis.__pathId);
    const spline = entity.getComponent("spline");
    // A point a quarter of the way along — inside the FIRST segment, so a knot
    // inserted there must land at index 1 rather than being appended.
    const p = spline.worldPointAt(spline.length * 0.25, new THREE.Vector3());
    const v = p.clone().project(viewport.camera);
    const rect = viewport.canvas.getBoundingClientRect();
    return {
      x: rect.left + (v.x * 0.5 + 0.5) * rect.width,
      y: rect.top + (-v.y * 0.5 + 0.5) * rect.height,
      before: spline.props.knots.length,
    };
  });
  await page.keyboard.down("Control");
  await page.mouse.click(insertPoint.x, insertPoint.y);
  await page.keyboard.up("Control");
  await wait(400);
  const inserted = await run(() => {
    const spline = globalThis.__engine.getEntity(globalThis.__pathId).getComponent("spline");
    return {
      count: spline.props.knots.length,
      positions: spline.props.knots.map((k) => k.position.map((v) => Math.round(v * 10) / 10)),
      selection: globalThis.__editing.getSplineEdit().selection,
    };
  });
  check("Ctrl+click on the curve inserts a knot", inserted.count === insertPoint.before + 1, `${inserted.count} knots`);
  check(
    "…BETWEEN the pair it was clicked between, not appended to the end",
    inserted.positions[1][0] > -8 && inserted.positions[1][0] < 0 && inserted.positions[3][0] === 8,
    JSON.stringify(inserted.positions),
  );
  check("…and the new knot is the one selected", inserted.selection?.knot === 1, JSON.stringify(inserted.selection));

  // --- Shift+click extends onto a surface ------------------------------------
  const extended = await run(() => {
    const e = globalThis.__engine;
    const THREE = globalThis.__ENGINE_THREE__;
    const viewport = globalThis.__viewport;
    // A plate off the end of the road, to prove the append snaps to geometry
    // rather than always landing on y = 0.
    const plate = e.createEntity({ name: "Plate" });
    plate.addComponent("mesh", { geometry: "box", width: 6, height: 1, depth: 6 });
    plate.object3D.position.set(14, 2, 8);
    e.scene.updateMatrixWorld(true);
    const v = new THREE.Vector3(14, 2.5, 8).project(viewport.camera);
    const rect = viewport.canvas.getBoundingClientRect();
    return {
      x: rect.left + (v.x * 0.5 + 0.5) * rect.width,
      y: rect.top + (-v.y * 0.5 + 0.5) * rect.height,
      before: e.getEntity(globalThis.__pathId).getComponent("spline").props.knots.length,
    };
  });
  await wait(800);
  await page.keyboard.down("Shift");
  await page.mouse.click(extended.x, extended.y);
  await page.keyboard.up("Shift");
  await wait(400);
  const appended = await run(() => {
    const spline = globalThis.__engine.getEntity(globalThis.__pathId).getComponent("spline");
    const last = spline.props.knots[spline.props.knots.length - 1].position;
    return { count: spline.props.knots.length, last: last.map((v) => Math.round(v * 100) / 100) };
  });
  check("Shift+click appends a knot", appended.count === extended.before + 1, `${appended.count} knots`);
  check(
    "…snapped onto the surface under the cursor, not the ground plane",
    appended.last[1] > 2,
    JSON.stringify(appended.last),
  );

  // --- Deleting --------------------------------------------------------------
  const deleted = await run(() => {
    const editing = globalThis.__editing;
    const spline = globalThis.__engine.getEntity(globalThis.__pathId).getComponent("spline");
    editing.selectKnot(2, null);
    const before = spline.props.knots.length;
    editing.deleteSelectedKnot();
    return { before, after: spline.props.knots.length };
  });
  check("X deletes the selected knot", deleted.after === deleted.before - 1, `${deleted.before} → ${deleted.after}`);

  const floor = await run(() => {
    const editing = globalThis.__editing;
    const entity = globalThis.__engine.getEntity(globalThis.__pathId);
    const spline = entity.getComponent("spline");
    spline.setKnots([{ position: [0, 0, 0] }, { position: [5, 0, 0] }]);
    editing.selectKnot(1, null);
    const removed = editing.deleteSelectedKnot();
    return { removed, count: spline.props.knots.length };
  });
  check(
    "…but refuses to go below two knots, which is the least that is still a path",
    floor.removed === false && floor.count === 2,
    JSON.stringify(floor),
  );

  // --- Bezier handles --------------------------------------------------------
  const bezier = await run(() => {
    const entity = globalThis.__engine.getEntity(globalThis.__pathId);
    entity.getComponent("spline").setProp("type", "bezier");
    return new Promise((resolve) => {
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const e = globalThis.__engine;
          resolve({
            knots: e.scene.getObjectByName("__splineKnots")?.count ?? -1,
            tangents: e.scene.getObjectByName("__splineTangents")?.count ?? -1,
          });
        }),
      );
    });
  });
  check(
    "switching to bezier adds two tangent handles per knot",
    bezier.knots === 2 && bezier.tangents === 4,
    `${bezier.knots} knots, ${bezier.tangents} tangents`,
  );

  const mirrored = await run(() => {
    const editing = globalThis.__editing;
    const spline = globalThis.__engine.getEntity(globalThis.__pathId).getComponent("spline");
    editing.selectKnot(0, "out");
    editing.beginSplineDrag();
    const proxy = editing.splineHandleProxy();
    proxy.position.set(0, 3, 0);
    editing.applySplineDrag();
    editing.commitSplineDrag();
    const knot = spline.props.knots[0];
    return { in: knot.handleIn, out: knot.handleOut };
  });
  check(
    "dragging one tangent mirrors the other, so the knot has no crease",
    Math.abs(mirrored.in[1] + mirrored.out[1]) < 1e-6 && Math.abs(mirrored.out[1] - 3) < 1e-6,
    JSON.stringify(mirrored),
  );

  // --- Leaving edit mode -----------------------------------------------------
  const disarmed = await run(() => {
    globalThis.__editing.setSplineEditArmed(false);
    return new Promise((resolve) => {
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const e = globalThis.__engine;
          const viewport = globalThis.__viewport;
          resolve({
            knots: e.scene.getObjectByName("__splineKnots")?.count ?? -1,
            gizmoTarget: viewport.gizmo.object?.name ?? null,
            selection: globalThis.__editing.getSplineEdit().selection,
          });
        }),
      );
    });
  });
  check("leaving edit mode hides the handles", disarmed.knots === 0, `${disarmed.knots}`);
  check("…drops the knot selection", disarmed.selection === null, JSON.stringify(disarmed.selection));
  check(
    "…and gives the transform gizmo back to the entity",
    disarmed.gizmoTarget !== "__splineHandleProxy",
    `${disarmed.gizmoTarget}`,
  );

  // --- The inspector section renders and acts --------------------------------
  const inspector = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll("button")];
    const edit = buttons.find((b) => b.textContent?.includes("Edit Path"));
    const add = buttons.find((b) => b.textContent?.includes("Add Knot"));
    edit?.click();
    return { hasEdit: !!edit, hasAdd: !!add };
  });
  check("the Inspector renders the spline section", inspector.hasEdit && inspector.hasAdd);
  await wait(300);
  const armedFromUi = await run(() => globalThis.__editing.getSplineEdit().armed);
  check("…and its Edit Path button really arms viewport editing", armedFromUi === true);

  const addedFromUi = await page.evaluate(() => {
    const before = globalThis.__engine.getEntity(globalThis.__pathId).getComponent("spline").props.knots.length;
    [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Add Knot"))?.click();
    return before;
  });
  await wait(300);
  const afterUi = await run(
    () => globalThis.__engine.getEntity(globalThis.__pathId).getComponent("spline").props.knots.length,
  );
  check("…and Add Knot appends one", afterUi === addedFromUi + 1, `${addedFromUi} → ${afterUi}`);

  // --- A cart on the rail ----------------------------------------------------
  const cart = await run(() => {
    const e = globalThis.__engine;
    // Its own rail rather than the road the tests above have been reshaping:
    // a cart's position is in path units, so a check written against a path
    // whose length changed three sections ago is a check about nothing.
    const rail = e.createEntity({ name: "Rail" });
    rail.addComponent("spline", {
      knots: [{ position: [-20, 0, 12] }, { position: [20, 0, 12] }],
      type: "linear",
    });
    globalThis.__railId = rail.id;
    const entity = e.createEntity({ name: "Cart" });
    entity.addComponent("mesh", { geometry: "box" });
    const follower = entity.addComponent("splineFollower", {
      path: rail.id,
      position: 0,
      speed: 4,
      wrap: "loop",
    });
    const start = entity.object3D.position.toArray();
    follower.position = 10;
    return { start, moved: entity.object3D.position.toArray() };
  });
  check(
    "a follower placed on the path snaps onto it in the EDITOR, before Play",
    Math.hypot(cart.moved[0] - cart.start[0], cart.moved[2] - cart.start[2]) > 1,
    `${JSON.stringify(cart.start)} → ${JSON.stringify(cart.moved)}`,
  );

  const played = await run(() => {
    const e = globalThis.__engine;
    const entity = [...e.entities.values()].find((x) => x.name === "Cart");
    const follower = entity.getComponent("splineFollower");
    follower.seek(0);
    const before = follower.position;
    e.playing = true;
    return new Promise((resolve) => {
      let frames = 0;
      const step = () => {
        if (++frames < 30) return requestAnimationFrame(step);
        e.playing = false;
        resolve({ before, after: follower.position });
      };
      requestAnimationFrame(step);
    });
  });
  check("…and drives itself along the path once playing", played.after > played.before, `${played.before.toFixed(2)} → ${played.after.toFixed(2)}`);

  // --- A fence instanced along the rail --------------------------------------
  const fence = await run(() => {
    const e = globalThis.__engine;
    const host = e.createEntity({ name: "Fence" });
    host.addComponent("mesh", { geometry: "box", width: 0.3, height: 2, depth: 0.3 });
    const instancer = host.addComponent("instancer", {
      mode: "path",
      pathEntity: globalThis.__railId,
      pathDistribution: "spacing",
      pathSpacing: 4,
      count: 200,
      pathAlign: "tangent",
    });
    globalThis.__fenceId = host.id;
    return { count: instancer.instancedMesh?.count ?? -1 };
  });
  // The rail is 40 units long, so a post every 4 units is 11 of them.
  check("an instancer lays posts along a path by spacing", fence.count === 11, `${fence.count} posts`);

  const relaid = await run(() => {
    const e = globalThis.__engine;
    const rail = e.getEntity(globalThis.__railId).getComponent("spline");
    const instancer = e.getEntity(globalThis.__fenceId).getComponent("instancer");
    const buffer = instancer.instancedMesh;
    // Double the rail's length by dragging its end knot, the way the viewport
    // handle does.
    rail.setKnot(1, { position: [60, 0, 12] });
    const immediate = instancer.instancedMesh.count;
    return new Promise((resolve) => {
      requestAnimationFrame(() =>
        requestAnimationFrame(() =>
          resolve({
            immediate,
            after: instancer.instancedMesh.count,
            sameBuffer: instancer.instancedMesh === buffer,
          }),
        ),
      );
    });
  });
  check(
    "…and stretching the path adds posts on the next frame, reusing the buffer",
    relaid.after === 21 && relaid.sameBuffer,
    `${relaid.immediate} → ${relaid.after}, same buffer ${relaid.sameBuffer}`,
  );

  // --- The path's hierarchy icon ---------------------------------------------
  const icon = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".hierarchy-row, [data-entity-id]")];
    const row = rows.find((r) => r.textContent?.trim().startsWith("Road"));
    const svg = row?.querySelector(".entity-icon");
    return { found: !!row, classes: svg?.getAttribute("class") ?? null };
  });
  check(
    "a path entity gets its own hierarchy icon, not the generic circle",
    icon.found && /icon-path/.test(icon.classes ?? ""),
    `${icon.classes}`,
  );

  // --- Apply Transform is offered where it can act, and only there ----------
  // Riding this harness because it already has both shapes of entity on hand:
  // "Fence" carries a Mesh, "Road" carries a path and a swept mesh but no Mesh
  // component, so it has no geometry of its own to bake into.
  const menuFor = async (name) => {
    await page.evaluate((entityName) => {
      document.querySelector(".dropdown-overlay")?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      const rows = [...document.querySelectorAll("[data-entity-id]")];
      const row = rows.find((r) => r.textContent?.trim().startsWith(entityName));
      const rect = row.getBoundingClientRect();
      row.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: Math.round(rect.left + 8),
          clientY: Math.round(rect.top + 6),
        }),
      );
    }, name);
    await wait(250);
    return page.evaluate(() =>
      [...document.querySelectorAll(".context-menu, .dropdown-menu")]
        .map((m) => m.textContent ?? "")
        .join("|"),
    );
  };

  const meshMenu = await menuFor("Fence");
  check(
    "Apply Transform is offered on an entity with geometry",
    /Apply Transform/.test(meshMenu) && /All Transforms/.test(meshMenu) && /Rotation & Scale/.test(meshMenu),
    meshMenu.slice(0, 60),
  );
  await page.keyboard.press("Escape");
  await wait(150);

  const pathMenu = await menuFor("Road");
  check(
    "…and withheld from one that has no mesh of its own to bake into",
    !/Apply Transform/.test(pathMenu),
    pathMenu.slice(0, 60),
  );
  await page.keyboard.press("Escape");
  await wait(150);

  const bakeField = await page.evaluate(() => {
    const engine = globalThis.__engine;
    const store = globalThis.__selection;
    store.getState().select(globalThis.__fenceId);
    return new Promise((resolve) =>
      setTimeout(() => {
        const labels = [...document.querySelectorAll(".field-label")].map((n) => n.textContent?.trim());
        resolve(labels.filter(Boolean));
      }, 400),
    );
  });
  check(
    "the Instancer exposes Bake Source Transform in the Inspector",
    bakeField.includes("Bake Source Transform"),
    bakeField.filter((l) => /Bake|Path|Spacing/.test(l)).join(", "),
  );

  const applyGuard = await page.evaluate(async () => {
    const { applyTransformStatus, applyTransformToGeometry } = await globalThis.__importLive(
      "/src/editor/applyTransform.js",
    );
    const entity = globalThis.__engine.getEntity(globalThis.__fenceId);
    entity.object3D.scale.set(2, 2, 2);
    const status = applyTransformStatus(globalThis.__fenceId);
    const undoBefore = globalThis.__bus.undoStack.length;
    const result = await applyTransformToGeometry(globalThis.__fenceId, "scale");
    return {
      fork: status.fork,
      ok: result.ok,
      message: result.message,
      undoAdded: globalThis.__bus.undoStack.length - undoBefore,
      scale: entity.object3D.scale.toArray(),
    };
  });
  check(
    "a primitive mesh is reported as needing a fork — its geometry is procedural",
    applyGuard.fork === true,
  );
  check(
    "…and with no project open it refuses cleanly instead of half-applying",
    // This harness runs on "Skip the project", so there is nowhere to write the
    // new .geom. The guard must fire BEFORE anything is changed: a refusal that
    // still cleared the scale would leave the object at the wrong size.
    applyGuard.ok === false &&
      /Open a project/.test(applyGuard.message) &&
      applyGuard.undoAdded === 0 &&
      applyGuard.scale[0] === 2,
    `${applyGuard.message} · undo +${applyGuard.undoAdded} · scale ${applyGuard.scale}`,
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

console.log(`\nSPLINE-SMOKE ${fail ? "FAIL" : "PASS"} — ${pass}/${pass + fail} checks`);
process.exit(fail ? 1 : 0);
