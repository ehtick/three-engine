/**
 * Level design + character controller, headless.
 *
 * Three layers are covered here, and they are the three whose failures are
 * pictures rather than errors:
 *
 *  1. `blockoutGeometry.js` — what a piece IS. A wall whose door is missing, a
 *     slab standing on its origin instead of hanging below it, or a staircase
 *     whose steps don't reach the top all render perfectly happily.
 *  2. `blockoutDraw.js` — what a gesture MEANS. Every "the wall came out
 *     perpendicular to my drag" bug lives in one of the two yaw formulas, and
 *     an angle that is 90° out looks deliberate in a screenshot.
 *  3. `characterRigSpec.js` + the script templates — where the character's
 *     origin is, and whether the shipped source still compiles. A rig whose
 *     capsule is centred rather than seated puts the player half-buried in the
 *     floor of every level drawn by (1).
 *
 * No GPU, no browser, no editor: the geometry builder allocates real
 * BufferGeometries and everything else is arithmetic.
 */
import assert from "node:assert/strict";

// Rapier's wasm-bindgen glue takes a browser path the moment `window` exists
// and then calls `window.performance.now()`; see run-physics-test.mjs for the
// bare "unreachable" trap that follows if it is missing. The document stub is
// what the greybox material probes for a 2D canvas.
const stubElement = () => ({
  style: {},
  appendChild() {},
  removeChild() {},
  addEventListener() {},
  removeEventListener() {},
  setAttribute() {},
  classList: { add() {}, remove() {} },
  parentElement: null,
});
globalThis.document ??= {
  body: stubElement(),
  createElement: stubElement,
  addEventListener() {},
  removeEventListener() {},
  hidden: false,
};
globalThis.window ??= {
  devicePixelRatio: 1,
  addEventListener() {},
  removeEventListener() {},
  performance: globalThis.performance,
  crypto: globalThis.crypto,
};
globalThis.requestAnimationFrame ??= (fn) => setTimeout(() => fn(performance.now()), 16);
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${error.message}`);
  }
};

const {
  BLOCKOUT_COLORS,
  BLOCKOUT_SHAPES,
  blockoutBounds,
  blockoutBoxes,
  buildBlockoutGeometry,
  defaultSteps,
  wallSpans,
} = await import("../src/modules/level-design/blockoutGeometry.js");

const { footprint, offsetAlongWall, pieceFromDrag, snapValue } = await import("../src/editor/blockoutDraw.js");
const { characterRigSpec } = await import("../src/editor/characterRigSpec.js");
const { levelDesignModule } = await import("../src/modules/level-design/index.js");

const SETTINGS = {
  grid: 1,
  angleSnap: 15,
  wallHeight: 3,
  wallThickness: 0.2,
  slabThickness: 0.2,
  stairWidth: 1.4,
  storeyHeight: 3,
  rampRise: 1,
};

const bbox = (geometry) => {
  const box = geometry.boundingBox;
  return { min: box.min.toArray(), max: box.max.toArray() };
};

/* -------------------------------------------------------------------------- */
console.log("blockout geometry");

check("every shape builds non-empty geometry", () => {
  for (const shape of BLOCKOUT_SHAPES) {
    const { geometry } = buildBlockoutGeometry(shape, {});
    assert.ok(
      geometry.getAttribute("position").count > 0,
      `${shape} produced no vertices — its default size is missing from BLOCKOUT_DEFAULT_SIZE`,
    );
    assert.ok(BLOCKOUT_COLORS[shape], `${shape} has no palette colour`);
  }
});

check("a slab hangs BELOW its origin — its top face is the walkable elevation", () => {
  const { geometry } = buildBlockoutGeometry("floor", { size: [4, 0.2, 4] });
  const { min, max } = bbox(geometry);
  assert.equal(max[1], 0, "the slab's top must sit exactly at y = 0");
  // Float32 attributes: 0.2 does not survive the round trip exactly.
  assert.ok(Math.abs(min[1] + 0.2) < 1e-6, min[1]);
  assert.deepEqual(blockoutBounds("floor", { size: [4, 0.2, 4] })[1], [2, 0, 2]);
});

check("a wall STANDS on its origin", () => {
  const { min, max } = bbox(buildBlockoutGeometry("wall", { size: [4, 3, 0.2] }).geometry);
  assert.equal(min[1], 0);
  assert.equal(max[1], 3);
  assert.equal(min[0], -2, "a wall is centred on its length");
});

check("a solid wall is one box; a door splits it into three", () => {
  assert.equal(blockoutBoxes("wall", { size: [4, 3, 0.2] }).length, 1);
  const withDoor = blockoutBoxes("wall", {
    size: [4, 3, 0.2],
    openings: [{ offset: 0, width: 1, height: 2.1, sill: 0 }],
  });
  // left span, right span, header. No sill box: the door reaches the floor.
  assert.equal(withDoor.length, 3);
});

check("a window keeps its sill AND its header", () => {
  const spans = wallSpans(4, 3, [{ offset: 0, width: 1.4, height: 1.2, sill: 1 }]);
  const overHole = spans.filter((span) => span.start > -0.8 && span.end < 0.8);
  assert.equal(overHole.length, 2, "expected a sill below and a header above");
  assert.deepEqual(
    overHole.map((span) => [span.bottom, span.top]).sort((a, b) => a[0] - b[0]),
    [[0, 1], [2.2, 3]],
  );
});

check("an opening as wide as the wall leaves an archway, not a throw", () => {
  const spans = wallSpans(4, 3, [{ offset: 0, width: 10, height: 2.6, sill: 0 }]);
  assert.equal(spans.length, 1, "only the header survives");
  assert.equal(spans[0].bottom, 2.6);
  const { geometry } = buildBlockoutGeometry("wall", {
    size: [4, 3, 0.2],
    openings: [{ offset: 0, width: 10, height: 3, sill: 0 }],
  });
  // Entirely cut away: still a valid, empty geometry rather than null.
  assert.equal(geometry.getAttribute("position").count, 0);
});

check("overlapping openings cut once instead of stacking sills", () => {
  const spans = wallSpans(6, 3, [
    { offset: -0.5, width: 2, height: 2.1, sill: 0 },
    { offset: 0, width: 2, height: 2.1, sill: 0 },
  ]);
  // No span may start before the previous one ended.
  let cursor = -Infinity;
  for (const span of spans.filter((s) => s.top === 3 && s.bottom === 0)) {
    assert.ok(span.start >= cursor - 1e-9, "full-height spans overlap a hole");
    cursor = span.end;
  }
});

check("a staircase reaches exactly the top of its rise, in the step count asked for", () => {
  const { geometry, boxes } = buildBlockoutGeometry("stair", { size: [1.4, 3, 4], steps: 12 });
  assert.equal(boxes.length, 12);
  const { min, max } = bbox(geometry);
  assert.equal(max[1], 3, "the last tread must land on the storey above");
  assert.equal(min[1], 0);
  assert.equal(min[2], -2, "the run is centred on the origin");
  assert.equal(max[2], 2);
});

check("stairs derive ~18 cm risers when the step count is left at 0", () => {
  assert.equal(defaultSteps(3), 17); // 3 / 0.18 = 16.7
  assert.equal(defaultSteps(0.5), 3);
  assert.ok(defaultSteps(0.01) >= 1, "never zero steps");
});

check("open treads float; solid steps reach the ground", () => {
  const solid = blockoutBoxes("stair", { size: [1, 2, 4], steps: 4 });
  const open = blockoutBoxes("stair", { size: [1, 2, 4], steps: 4, open: true });
  const bottomOf = (box) => box.center[1] - box.size[1] / 2;
  assert.ok(solid.every((box) => Math.abs(bottomOf(box)) < 1e-9), "a solid stair fills to the floor");
  assert.ok(open.some((box) => bottomOf(box) > 0.1), "open treads are one riser thick");
});

check("a ramp is a smooth wedge — no interior steps for a capsule to catch on", () => {
  const { geometry } = buildBlockoutGeometry("ramp", { size: [1.6, 1, 4] });
  // 3 quads + 2 triangles = 8 triangles. A stepped approximation would be far more.
  assert.equal(geometry.index.count / 3, 8);
  const { min, max } = bbox(geometry);
  assert.equal(min[1], 0);
  assert.equal(max[1], 1);
});

check("a column's side count is honoured and clamped", () => {
  const square = buildBlockoutGeometry("column", { size: [0.4, 3, 0.4], sides: 4 });
  const round = buildBlockoutGeometry("column", { size: [0.4, 3, 0.4], sides: 16 });
  assert.ok(round.geometry.getAttribute("position").count > square.geometry.getAttribute("position").count);
  const clamped = buildBlockoutGeometry("column", { size: [0.4, 3, 0.4], sides: 2 });
  assert.ok(clamped.geometry.getAttribute("position").count > 0, "fewer than 3 sides must still build");
});

check("a 4-sided column is an axis-aligned square, not a diamond", () => {
  const { geometry } = buildBlockoutGeometry("column", { size: [0.4, 3, 0.4], sides: 4 });
  const { min, max } = bbox(geometry);
  // A diamond's bounding box would be the full 0.4 across; a square pillar
  // inscribed in the same circle measures 0.4/√2 ≈ 0.283.
  assert.ok(Math.abs(max[0] - min[0] - 0.4 / Math.SQRT2) < 1e-6, `got width ${max[0] - min[0]}`);
});

check("UVs are in metres, so one grid texture reads at true scale everywhere", () => {
  const { geometry } = buildBlockoutGeometry("wall", { size: [8, 3, 0.2] });
  const uv = geometry.getAttribute("uv");
  let maxU = 0;
  for (let i = 0; i < uv.count; i++) maxU = Math.max(maxU, uv.getX(i));
  assert.equal(maxU, 8, "an 8 m wall must span 8 units of u");
});

check("every triangle faces the way its normals say it does", () => {
  // The failure this exists for is INVISIBLE to every other check: get the
  // winding backwards and the vertex normals are still right, the bounding box
  // is still right, the triangle count is still right — and with front-face
  // culling you see straight through the outside of the piece into its far
  // inner wall. Columns and ramps shipped like that. So: for each triangle,
  // the cross product of its edges (which is what the GPU culls on) must point
  // the same way as the shading normal the emitter wrote.
  for (const shape of BLOCKOUT_SHAPES) {
    const { geometry } = buildBlockoutGeometry(shape, { sides: 6, steps: 3 });
    const position = geometry.getAttribute("position");
    const normal = geometry.getAttribute("normal");
    const index = geometry.index;
    let backwards = 0;
    for (let t = 0; t < index.count; t += 3) {
      const [a, b, c] = [index.getX(t), index.getX(t + 1), index.getX(t + 2)];
      const p = (i) => [position.getX(i), position.getY(i), position.getZ(i)];
      const [ax, ay, az] = p(a);
      const [bx, by, bz] = p(b);
      const [cx, cy, cz] = p(c);
      const e1 = [bx - ax, by - ay, bz - az];
      const e2 = [cx - ax, cy - ay, cz - az];
      const face = [
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0],
      ];
      const dot = face[0] * normal.getX(a) + face[1] * normal.getY(a) + face[2] * normal.getZ(a);
      if (dot <= 0) backwards++;
    }
    assert.equal(backwards, 0, `${shape}: ${backwards} of ${index.count / 3} triangles are inside out`);
  }
});

check("a degenerate size cannot produce NaN geometry", () => {
  const { geometry } = buildBlockoutGeometry("box", { size: [0, -1, Number.NaN] });
  const position = geometry.getAttribute("position");
  for (let i = 0; i < position.count * 3; i++) {
    assert.ok(Number.isFinite(position.array[i]), "NaN reached the vertex buffer");
  }
});

/* -------------------------------------------------------------------------- */
console.log("blockout drawing");

const P = (x, z, y = 0) => ({ x, y, z });

check("snapping rounds to the grid and leaves 0 alone", () => {
  assert.equal(snapValue(1.4, 1), 1);
  assert.equal(snapValue(1.6, 1), 2);
  assert.equal(snapValue(1.6, 0), 1.6);
  assert.equal(snapValue(-0.4, 0.5), -0.5);
});

check("a click fills the grid cell whose corner was clicked", () => {
  const cell = footprint(P(0, 0), P(0, 0), 1);
  assert.deepEqual([cell.sx, cell.sz], [1, 1]);
  assert.deepEqual([cell.cx, cell.cz], [0.5, 0.5], "the cell extends in +X/+Z from the click");
});

check("a drag backwards is the same rectangle as a drag forwards", () => {
  const forward = pieceFromDrag("floor", P(0, 0), P(4, 3), SETTINGS);
  const backward = pieceFromDrag("floor", P(4, 3), P(0, 0), SETTINGS);
  assert.deepEqual(forward.size, backward.size);
  assert.deepEqual(forward.position, backward.position);
});

check("a wall runs between the two points it was dragged between", () => {
  const alongX = pieceFromDrag("wall", P(0, 0), P(4, 0), SETTINGS);
  assert.equal(alongX.size[0], 4, "length is the drag distance");
  assert.deepEqual(alongX.position, [2, 0, 0]);
  assert.ok(Math.abs(alongX.rotationY) < 1e-9, "a +X wall needs no yaw");

  const alongZ = pieceFromDrag("wall", P(0, 0), P(0, 4), SETTINGS);
  assert.ok(Math.abs(alongZ.rotationY + Math.PI / 2) < 1e-9, `a +Z wall is yawed -90°, got ${alongZ.rotationY}`);
});

check("the wall's local +X really points from A to B", () => {
  // The check the yaw formula exists for: rotate local (length/2, 0, 0) by the
  // returned yaw and it must land on B.
  for (const [bx, bz] of [[4, 0], [0, 4], [-3, 3], [2, -5]]) {
    const wall = pieceFromDrag("wall", P(0, 0), P(bx, bz), SETTINGS);
    const half = wall.size[0] / 2;
    const endX = wall.position[0] + Math.cos(wall.rotationY) * half;
    const endZ = wall.position[2] - Math.sin(wall.rotationY) * half;
    assert.ok(Math.hypot(endX - bx, endZ - bz) < 1e-9, `wall to (${bx}, ${bz}) ends at (${endX}, ${endZ})`);
  }
});

check("offsetAlongWall inverts the wall's own rotation", () => {
  for (const [bx, bz] of [[4, 0], [0, 4], [-3, 3]]) {
    const wall = pieceFromDrag("wall", P(0, 0), P(bx, bz), SETTINGS);
    const centre = offsetAlongWall({ x: wall.position[0], z: wall.position[2] }, wall.position, wall.rotationY);
    assert.ok(Math.abs(centre) < 1e-9, "the wall's own centre is offset 0");
    const atEnd = offsetAlongWall({ x: bx, z: bz }, wall.position, wall.rotationY);
    assert.ok(Math.abs(atEnd - wall.size[0] / 2) < 1e-9, `end reads ${atEnd}, expected ${wall.size[0] / 2}`);
  }
});

check("a wall or stair needs a direction — a click draws nothing", () => {
  assert.equal(pieceFromDrag("wall", P(1, 1), P(1, 1), SETTINGS), null);
  assert.equal(pieceFromDrag("stair", P(1, 1), P(1, 1), SETTINGS), null);
  assert.ok(pieceFromDrag("floor", P(1, 1), P(1, 1), SETTINGS), "a floor click still places a tile");
});

check("a stair climbs one storey along the drag, and descends the other way", () => {
  const up = pieceFromDrag("stair", P(0, 0), P(0, 4), SETTINGS);
  assert.equal(up.size[1], 3, "rise is the storey height");
  assert.equal(up.size[2], 4, "run is the drag length");
  assert.equal(up.position[1], 0, "an ascending stair starts at the drawing elevation");

  const down = pieceFromDrag("stair", P(0, 0), P(0, 4), { ...SETTINGS, descend: true });
  assert.equal(down.position[1], -3, "a descending stair's base is one storey down");
  assert.ok(
    Math.abs(Math.abs(down.rotationY - up.rotationY) - Math.PI) < 1e-9,
    "descending flips the climb direction",
  );
});

check("a stair's top lands where the drag ended, one storey up", () => {
  const stair = pieceFromDrag("stair", P(0, 0), P(0, 4), SETTINGS);
  // Local +Z is the climb direction; the top of the run is at +run/2.
  const topZ = stair.position[2] + Math.cos(stair.rotationY) * (stair.size[2] / 2);
  assert.ok(Math.abs(topZ - 4) < 1e-9, `top at z=${topZ}`);
  assert.equal(stair.position[1] + stair.size[1], 3);
});

check("angle snapping only applies with the grid off", () => {
  const off = pieceFromDrag("wall", P(0, 0), P(4, 0.3), { ...SETTINGS, grid: 0, angleSnap: 45 });
  const snapped = Math.round((off.rotationY * 180) / Math.PI);
  assert.equal(Math.abs(snapped % 45), 0, `expected a multiple of 45°, got ${snapped}`);
  const gridded = pieceFromDrag("wall", P(0, 0), P(4, 0.3), { ...SETTINGS, grid: 1, angleSnap: 45 });
  assert.ok(Math.abs(gridded.rotationY) > 1e-6, "with the grid on, the endpoints decide the angle");
});

check("a column click is a default pillar; a drag thickens it", () => {
  const clicked = pieceFromDrag("column", P(2, 2), P(2, 2), SETTINGS);
  assert.deepEqual(clicked.position, [2, 0, 2]);
  assert.equal(clicked.size[0], 0.4);
  const dragged = pieceFromDrag("column", P(2, 2), P(2.5, 2), SETTINGS);
  assert.equal(dragged.size[0], 1);
});

/* -------------------------------------------------------------------------- */
console.log("character rig");

const rig = characterRigSpec({ scripts: { controller: "/p/scripts/A.ts", camera: "/p/scripts/B.ts" }, physics: true });

check("the rig's origin is at the character's feet", () => {
  const cc = rig.components.find((component) => component.type === "charactercontroller");
  assert.ok(cc, "no character controller in the rig");
  const { height, radius, offset } = cc.props;
  assert.equal(offset[1], height / 2 + radius, "the capsule must be lifted to sit on the origin");
  const body = rig.children.find((child) => child.name === "Body");
  assert.equal(body.transform.position[1], offset[1], "the stand-in mesh must sit where the capsule does");
});

check("the stand-in mesh matches the capsule it stands in for", () => {
  const cc = rig.components.find((component) => component.type === "charactercontroller").props;
  const body = rig.children.find((child) => child.name === "Body");
  // The capsule primitive is radius 0.5, cylinder 1 — scale maps it onto the collider.
  assert.deepEqual(body.transform.scale, [cc.radius / 0.5, cc.height, cc.radius / 0.5]);
});

check("the camera is a child, and the scripts run body-then-camera", () => {
  const camera = rig.children.find((child) => child.name === "Camera");
  assert.ok(camera?.components.some((component) => component.type === "camera"));
  const slots = rig.components.find((component) => component.type === "script").props.scripts;
  assert.match(slots[0].path, /A\.ts$/, "the controller must run first");
  assert.match(slots[1].path, /B\.ts$/);
  assert.equal(slots[1].attributes.view, "third");
});

check("first person starts the camera at eye height, third person behind", () => {
  const first = characterRigSpec({ view: "first", physics: true });
  const third = characterRigSpec({ view: "third", physics: true });
  const cameraOf = (spec) => spec.children.find((child) => child.name === "Camera").transform.position;
  assert.equal(cameraOf(first)[2], 0, "a first-person camera is not set back");
  assert.ok(cameraOf(third)[2] > 0, "a third-person camera starts behind the character");
});

check("without the physics module the rig still builds, minus the controller", () => {
  const bare = characterRigSpec({ physics: false });
  assert.ok(!bare.components.some((component) => component.type === "charactercontroller"));
  assert.ok(bare.children.some((child) => child.name === "Camera"), "the camera survives");
});

/* -------------------------------------------------------------------------- */
console.log("character scripts");

const { CHARACTER_CONTROLLER_SOURCE, CHARACTER_CAMERA_SOURCE } = await import(
  "../src/editor/templates/characterScripts.js"
);
const esbuild = await import("esbuild");

for (const [name, source] of [
  ["CharacterController.ts", CHARACTER_CONTROLLER_SOURCE],
  ["CharacterCamera.ts", CHARACTER_CAMERA_SOURCE],
]) {
  // The templates ship as source: a typo in them is a script the user's project
  // cannot load, discovered on Play rather than here.
  await (async () => {
    try {
      await esbuild.transform(source, {
        loader: "ts",
        tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
      });
      console.log(`  ok   ${name} compiles the way the editor loads it`);
    } catch (error) {
      failures++;
      console.error(`  FAIL ${name} does not compile`);
      console.error(`       ${error.message}`);
    }
  })();

  check(`${name} default-exports a class named after its file`, () => {
    const stem = name.replace(/\.ts$/, "");
    assert.match(source, new RegExp(`export default class ${stem}\\b`));
  });
}

check("the controller reads the actions the default Player map defines", () => {
  for (const action of ["Move", "Jump", "Sprint", "Crouch"]) {
    assert.match(CHARACTER_CONTROLLER_SOURCE, new RegExp(`"${action}"`), `no default binding for ${action}`);
  }
});

check("both scripts expose their tuning as @attribute fields", () => {
  const count = (source) => (source.match(/@attribute\(/g) ?? []).length;
  assert.ok(count(CHARACTER_CONTROLLER_SOURCE) >= 12, "the controller should be tunable without opening it");
  assert.ok(count(CHARACTER_CAMERA_SOURCE) >= 12, "the camera should be tunable without opening it");
});

check("the camera asks physics before pulling in — a wall must occlude, not clip", () => {
  assert.match(CHARACTER_CAMERA_SOURCE, /spherecast\(/);
});

/* -------------------------------------------------------------------------- */
console.log("third-person orbit");

/*
 * The checks above can only say the template PARSES. These load it the way the
 * editor does and drive the third-person branch, because the bug it shipped
 * with was not a syntax error: the camera eased its final WORLD position toward
 * the target, so a flick of the mouse turned the view instantly while the body
 * slid across the screen for another tenth of a second. Reported, accurately,
 * as "very weird, interpolated".
 *
 * Every assertion below is one frame long on purpose. A camera that arrives
 * late is the entire complaint, and "late" is invisible to a screenshot.
 */
const THREE = await import("three");

const CharacterCamera = await (async () => {
  const { code } = await esbuild.transform(
    // The real import resolves through the script runtime's "engine" alias,
    // which does not exist out here. The two names it brings in are a base
    // class the runtime does not require (it injects the context properties on
    // any class) and a decorator that only records inspector metadata, so the
    // stubs below leave the behaviour untouched.
    CHARACTER_CAMERA_SOURCE.replace(
      /^import \{[^}]*\} from "engine";/m,
      "class Script {}; const attribute = () => () => {};",
    ),
    { loader: "ts", tsconfigRaw: { compilerOptions: { experimentalDecorators: true } } },
  );
  const loaded = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  return loaded.default;
})();

/**
 * A camera script wired up the way the rig has it: the Camera object3D is a
 * CHILD of the character, so every frame the script has to cancel out whatever
 * rotation CharacterController just gave the body.
 *
 * `boom` inserts an empty in between — a spring arm, a recoil node, anything
 * someone adds later — which is the case where the camera's parent is not the
 * character itself and nothing else has refreshed its matrix.
 */
function mountCamera({ position = [0, 0, 0], bodyYaw = 0, damping, boom = false } = {}) {
  const body = new THREE.Object3D();
  body.position.set(...position);
  body.rotation.y = bodyYaw;
  const cameraObject = new THREE.Object3D();
  if (boom) {
    const arm = new THREE.Object3D();
    body.add(arm);
    arm.add(cameraObject);
  } else {
    body.add(cameraObject);
  }

  const camera = new CharacterCamera();
  camera.THREE = THREE;
  // Left at the shipped default unless a test names one, so the default itself
  // is under test: it used to be 0.08, and 0.08 is a visibly swimming camera.
  if (damping !== undefined) camera.damping = damping;
  camera.avoidWalls = false;
  camera.engine = { physics: null };
  camera.entity = {
    object3D: body,
    getWorldPosition: (target) => body.getWorldPosition(target),
    getScript: () => null,
  };
  camera.cameraEntity = { object3D: cameraObject };
  camera.currentDistance = camera.distance; // onStart's job
  return { camera, body, cameraObject };
}

/** Where the camera must be, from first principles: the shoulder offset in the
 *  camera's own frame, then `distance` straight back along the look direction. */
function orbitPoint(camera, [bx, by, bz]) {
  const sin = Math.sin(camera.yaw);
  const cos = Math.cos(camera.yaw);
  const [sx, sy, sz] = camera.shoulder;
  const flat = Math.cos(camera.pitch) * camera.distance;
  return new THREE.Vector3(
    bx + cos * sx - sin * sz + sin * flat,
    by + sy - Math.sin(camera.pitch) * camera.distance,
    bz - sin * sx - cos * sz + cos * flat,
  );
}

const worldOf = (object) => object.getWorldPosition(new THREE.Vector3());
const near = (got, want, what) =>
  assert.ok(got.distanceTo(want) < 1e-6, `${what}: at ${got.toArray()}, should be ${want.toArray()}`);

check("a flick of the mouse puts the camera on its new orbit the SAME frame", () => {
  const { camera, cameraObject } = mountCamera();
  camera.applyThirdPerson(1 / 60);
  camera.yaw = -Math.PI / 2;
  camera.pitch = 0.3;
  camera.applyThirdPerson(1 / 60);
  near(worldOf(cameraObject), orbitPoint(camera, [0, 0, 0]), "one frame after the flick");
});

check("follow damping lags the character, never the orbit", () => {
  // The regression gate. The old camera eased its FINAL position, so damping
  // this heavy left a flick about 7% of the way round, creeping into place over
  // the following ten frames — the swim the whole change is about.
  const { camera, cameraObject } = mountCamera({ damping: 0.25 });
  camera.applyThirdPerson(1 / 60); // the pivot settles on a character standing still
  camera.yaw = 2.2;
  camera.pitch = -0.4;
  camera.applyThirdPerson(1 / 60);
  near(worldOf(cameraObject), orbitPoint(camera, [0, 0, 0]), "a damped camera still orbits rigidly");
});

check("with damping off the camera follows the character one metre for one metre", () => {
  const { camera, body, cameraObject } = mountCamera();
  camera.applyThirdPerson(1 / 60);
  const before = worldOf(cameraObject);
  body.position.set(1, 0, 0);
  camera.applyThirdPerson(1 / 60);
  const moved = worldOf(cameraObject).sub(before);
  near(moved, new THREE.Vector3(1, 0, 0), "the camera did not keep up with the character");
});

check("the view points where the mouse says, whatever the body is doing", () => {
  const { camera, body, cameraObject } = mountCamera({ bodyYaw: 0.7 });
  camera.yaw = -2;
  camera.pitch = 0.35;
  camera.applyThirdPerson(1 / 60);
  const wanted = new THREE.Quaternion().setFromEuler(new THREE.Euler(camera.pitch, camera.yaw, 0, "YXZ"));
  const aligned = (what) => {
    const got = cameraObject.getWorldQuaternion(new THREE.Quaternion());
    assert.ok(Math.abs(Math.abs(got.dot(wanted)) - 1) < 1e-6, what);
  };
  aligned("the body's own rotation leaked into the view");
  body.rotation.y = -1.3; // CharacterController turns the body under it
  camera.applyThirdPerson(1 / 60);
  aligned("turning the body turned the camera with it");
});

check("the placement survives a boom arm between the character and the camera", () => {
  // The camera is placed in world space and converted into its parent's frame,
  // so the parent has to be whatever the camera is ACTUALLY hanging off —
  // which is the character only in the rig as shipped. Add a spring arm, a
  // recoil node, anything, and an implementation that assumed "parent === the
  // character" puts the camera somewhere else entirely. Turning the body
  // mid-test also pins down that the cancellation reads this frame's rotation
  // and not the one the last render left in the matrix.
  const { camera, body, cameraObject } = mountCamera({ position: [3, 0, -2], bodyYaw: 0.7, boom: true });
  camera.yaw = 1.1;
  camera.pitch = -0.2;
  camera.applyThirdPerson(1 / 60);
  near(worldOf(cameraObject), orbitPoint(camera, [3, 0, -2]), "hung off a boom arm");
  body.rotation.y = 1.9; // the controller turns the body, with no render in between
  camera.applyThirdPerson(1 / 60);
  near(worldOf(cameraObject), orbitPoint(camera, [3, 0, -2]), "after the body turned");
});

check("a teleport does not fly the camera across the level", () => {
  const { camera, body, cameraObject } = mountCamera({ damping: 0.25 });
  camera.applyThirdPerson(1 / 60);
  body.position.set(60, 0, -40); // warpTo, which calls snap() for exactly this
  camera.snap();
  camera.applyThirdPerson(1 / 60);
  near(worldOf(cameraObject), orbitPoint(camera, [60, 0, -40]), "the camera is still travelling there");
});

/**
 * A camera wired to a fake Camera COMPONENT, spying on `setProp` — for the FOV
 * kick, which is the one place CharacterCamera writes through the props/event
 * system every frame instead of touching a three.js object directly.
 */
function mountCameraWithFovSpy({ speed = 0, walkSpeed = 4.5 } = {}) {
  const { camera, body, cameraObject } = mountCamera();
  const calls = [];
  const cameraComponent = {
    props: { fov: 60 },
    setProp(key, value) {
      calls.push(value);
      this.props[key] = value;
    },
  };
  camera.baseFov = 60;
  camera.cameraEntity = { object3D: cameraObject, getComponent: (type) => (type === "camera" ? cameraComponent : null) };
  camera.entity.getScript = (name) => (name === "CharacterController" ? { speed, walkSpeed } : null);
  return { camera, calls, cameraComponent };
}

check("FOV settles and STOPS writing — an at-rest camera calls setProp zero times", () => {
  // The regression: the exponential in applyFov never lands on its target
  // exactly, so an earlier version called setProp() every single frame
  // forever — ~120 "hierarchy-changed" events a second for the whole of Play,
  // each one re-mirroring every entity in the scene for the editor's React
  // tree. Invisible until the moving entity was SELECTED (a full Inspector to
  // reconcile), which is why it read as "fps drops when we move the
  // character" rather than "fps drops in Play". Confirmed live: 114 → 120 fps
  // with this fix, walking with the Player selected (`run-character-motion-
  // perf.mjs`, arm `walk+turn+selected`).
  const { camera, calls } = mountCameraWithFovSpy({ speed: 0 }); // not sprinting
  for (let i = 0; i < 120; i++) camera.applyFov(1 / 60);
  assert.equal(calls.length, 0, `setProp called ${calls.length} times at rest — should never fire when nothing is changing`);
});

check("FOV converges during a sprint kick, then goes silent", () => {
  const { camera, calls, cameraComponent } = mountCameraWithFovSpy({ speed: 6, walkSpeed: 4.5 }); // sprinting
  for (let i = 0; i < 60; i++) camera.applyFov(1 / 60); // ~1s: reaches baseFov + sprintFov
  assert.ok(cameraComponent.props.fov > 64, `expected the sprint kick to land near ${60 + 6}, got ${cameraComponent.props.fov}`);
  const duringSprint = calls.length;
  assert.ok(duringSprint > 0, "a genuine FOV change must still call setProp");
  calls.length = 0;
  for (let i = 0; i < 120; i++) camera.applyFov(1 / 60); // hold the sprint steady
  assert.ok(calls.length < 5, `still calling setProp ${calls.length} times/2s after convergence — the storm is back`);
});

/* -------------------------------------------------------------------------- */
console.log("character animator");

/*
 * The default body's locomotion graph (`CHARACTER_LOCOMOTION_ANIM`, shipped
 * from `characterModel.js`) can't be exercised through `characterRigSpec`
 * (a pure-data function that has never heard of prefabs or animators) or
 * through `characterRig.js` (Tauri file I/O, no business running headless).
 * So this drives the REAL `AnimatorRuntime` against the REAL exported graph
 * object, with fake clips standing in for the GLB's — the same shape
 * `run-animation-test.mjs` uses for the engine's own animator suite. A typo in
 * a clip name, a threshold in the wrong order, or a transition condition
 * pointed at the wrong parameter would all be invisible in the editor (the
 * state machine fails silent-ish, one console.warn on first use) and are
 * exactly what this catches.
 */
const {
  CHARACTER_LOCOMOTION_ANIM,
  CHARACTER_MODEL_CLIPS,
  CHARACTER_MODEL_HEIGHT,
} = await import("../src/modules/character-controller/characterModelData.js");
// animGraph.js does `instanceof THREE.AnimationMixer` / builds THREE.Bone
// internally against "three/webgpu" specifically — importing plain "three"
// here (as the camera tests above do) would hand it objects from a SEPARATE
// module instance and fail those checks in confusing ways. Named distinctly
// from the `THREE` already in scope so neither import shadows the other.
const THREE_ANIM = await import("three/webgpu");
const { AnimatorRuntime } = await import("../src/engine/animGraph.js");

function makeLocomotionAnimator() {
  const root = new THREE_ANIM.Object3D();
  const bone = new THREE_ANIM.Bone();
  bone.name = "Root";
  root.add(bone);
  const track = (name) =>
    new THREE_ANIM.QuaternionKeyframeTrack(
      "Root.quaternion",
      [0, 1],
      [0, 0, 0, 1, 0, 0, 0, 1],
    );
  const clip = (name, duration = 1) => new THREE_ANIM.AnimationClip(name, duration, [track(name)]);
  const clips = [
    clip(CHARACTER_MODEL_CLIPS.idle),
    clip(CHARACTER_MODEL_CLIPS.run),
    clip(CHARACTER_MODEL_CLIPS.jumpUp, 0.25),
    clip(CHARACTER_MODEL_CLIPS.jumpDown, 0.35),
  ];
  const mixer = new THREE_ANIM.AnimationMixer(root);
  const runtime = new AnimatorRuntime(CHARACTER_LOCOMOTION_ANIM, mixer, clips, { root });
  return { runtime, root };
}

/** The Locomotion state's blend1d weight for one clip, by name. */
function weightOf(runtime, clipName) {
  const state = runtime.layers[0].states.get("state-locomotion");
  const index = state.defs.findIndex((d) => d.clip === clipName);
  return index < 0 ? 0 : state.weights[index];
}

check("a fresh animator starts in Locomotion, standing still", () => {
  const { runtime } = makeLocomotionAnimator();
  assert.equal(runtime.currentState?.name, "Locomotion");
  runtime.update(1 / 60); // refresh() runs inside update — nothing has weights yet at t=0
  assert.equal(weightOf(runtime, CHARACTER_MODEL_CLIPS.idle), 1, "idle should own the pose at Speed 0");
});

check("Speed at the controller's default Walk threshold selects Running cleanly", () => {
  // There is only one moving clip in this set — no separate walk cycle — so
  // Running owns the pose from the Walk threshold up through Sprint.
  const { runtime } = makeLocomotionAnimator();
  runtime.setParam("Speed", 4.5); // CharacterController's default walkSpeed
  runtime.update(1 / 60);
  assert.equal(weightOf(runtime, CHARACTER_MODEL_CLIPS.run), 1, "4.5 m/s should read as pure Running");
  runtime.setParam("Speed", 7.5); // CharacterController's default sprintSpeed
  runtime.update(1 / 60);
  assert.equal(weightOf(runtime, CHARACTER_MODEL_CLIPS.run), 1, "7.5 m/s should still read as pure Running");
});

check("between Idle and Running, the blend is linear and sums to 1", () => {
  const { runtime } = makeLocomotionAnimator();
  runtime.setParam("Speed", 2.25); // halfway from 0 to the 4.5 Running threshold
  runtime.update(1 / 60);
  const idle = weightOf(runtime, CHARACTER_MODEL_CLIPS.idle);
  const run = weightOf(runtime, CHARACTER_MODEL_CLIPS.run);
  assert.ok(Math.abs(idle - 0.5) < 1e-6, `idle weight: ${idle}`);
  assert.ok(Math.abs(run - 0.5) < 1e-6, `run weight: ${run}`);
  assert.ok(Math.abs(idle + run - 1) < 1e-9, "must sum to 1 or the pose partially snaps to bind");
});

check("leaving the ground enters JumpUp and PAUSES there — never auto-plays JumpDown mid-air", () => {
  // The regression this guards, reported verbatim: "it repeats jump down
  // animation throughout the whole jump." An earlier version tried to time
  // JumpUp/JumpDown to vertical velocity crossing zero (a rise/fall split)
  // and looped both so a long flight didn't freeze — which meant a LANDING
  // clip played on repeat while still airborne. There is no clip in this
  // pack for "falling", so the fix is to not try: JumpUp holds its last
  // frame for the ENTIRE flight, rise and fall alike, and JumpDown is never
  // entered until Grounded actually says so. 120 ticks (2s, far past
  // JumpUp's own 0.25s test duration and any realistic hangtime) with
  // nothing but Grounded=false the whole time must never reach JumpDown.
  const { runtime } = makeLocomotionAnimator();
  runtime.setParam("Grounded", false);
  for (let i = 0; i < 120; i++) {
    runtime.update(1 / 60);
    assert.equal(runtime.currentState?.name, "JumpUp", `still airborne at tick ${i}, should not have left JumpUp`);
  }
});

check("touching down hands off from JumpUp to JumpDown", () => {
  const { runtime } = makeLocomotionAnimator();
  runtime.setParam("Grounded", false);
  for (let i = 0; i < 30; i++) runtime.update(1 / 60); // well into the paused hold
  runtime.setParam("Grounded", true);
  for (let i = 0; i < 10; i++) runtime.update(1 / 60);
  assert.equal(runtime.currentState?.name, "JumpDown", "landing must play the impact clip");
});

check("JumpDown plays through on its own and blends back to Locomotion — no condition needed", () => {
  // t-recover has an EMPTY conditions list — it fires purely once JumpDown's
  // own clip finishes (see characterModelData.js's docs on the exitTime
  // default). Landing height, fall speed, whatever — Grounded is already
  // true the instant we entered JumpDown and never has to change again for
  // this transition to fire.
  const { runtime } = makeLocomotionAnimator();
  runtime.setParam("Grounded", false);
  for (let i = 0; i < 10; i++) runtime.update(1 / 60);
  runtime.setParam("Grounded", true);
  for (let i = 0; i < 60; i++) runtime.update(1 / 60); // past JumpDown's 0.35s test duration
  assert.equal(runtime.currentState?.name, "Locomotion", "JumpDown must hand itself back once it finishes");
});

check("landing while still moving blends into Running, not Idle", () => {
  // "blending with further running" — the recovery has to land on whatever
  // Locomotion is actually doing, not always settle to a stop.
  const { runtime } = makeLocomotionAnimator();
  runtime.setParam("Speed", 6); // held through the whole jump, same as a running jump would
  runtime.setParam("Grounded", false);
  for (let i = 0; i < 10; i++) runtime.update(1 / 60);
  runtime.setParam("Grounded", true);
  for (let i = 0; i < 60; i++) runtime.update(1 / 60);
  assert.equal(runtime.currentState?.name, "Locomotion");
  assert.equal(weightOf(runtime, CHARACTER_MODEL_CLIPS.run), 1, "still moving on landing should resume Running, not Idle");
});

check("re-jumping mid-recovery cuts back to JumpUp immediately, not after JumpDown finishes", () => {
  // t-launch is `from: "__any__"`, deliberately not `"state-locomotion"` —
  // a jump landed on and instantly re-triggered (bunny-hopping) should not
  // have to wait out JumpDown's crossfade first.
  const { runtime } = makeLocomotionAnimator();
  runtime.setParam("Grounded", false);
  for (let i = 0; i < 10; i++) runtime.update(1 / 60);
  runtime.setParam("Grounded", true);
  // Past t-land's own transition lock (0.08s ≈ 5 ticks — MIN_TRANSITION_LOCK
  // guards against flicker right at the transition itself) but well short of
  // JumpDown's 0.35s test duration — this has to be "not immediately", not
  // "not for the anti-thrash window", to isolate the thing being tested.
  for (let i = 0; i < 10; i++) runtime.update(1 / 60);
  assert.equal(runtime.currentState?.name, "JumpDown");
  runtime.setParam("Grounded", false); // jumped again, mid-recovery
  for (let i = 0; i < 10; i++) runtime.update(1 / 60);
  assert.equal(runtime.currentState?.name, "JumpUp", "a re-jump mid-recovery must cut to JumpUp, not wait");
});

check("the graph names exactly the clips the shipped GLB has, and nothing else", () => {
  // `Animator: clip "X" not found` is a console.warn, not a thrown error — a
  // renamed clip in a future re-export of the model would otherwise degrade
  // to a silently-missing pose instead of a failing test.
  const names = new Set(Object.values(CHARACTER_MODEL_CLIPS));
  for (const layer of CHARACTER_LOCOMOTION_ANIM.layers) {
    for (const state of layer.states) {
      const clips = state.kind === "clip" ? [state.clip] : (state.children ?? []).map((c) => c.clip);
      for (const clip of clips) assert.ok(names.has(clip), `"${clip}" is not one of CHARACTER_MODEL_CLIPS`);
    }
  }
});

check("the model's native height is a real, sane measurement", () => {
  // Guards against a stale/typo'd constant silently producing a comically
  // tiny or gigantic default body — this can only be RE-measured against the
  // actual GLB (see characterModel.js's docs), not derived, so the bar here
  // is "plausible for a human", not "exact".
  assert.ok(CHARACTER_MODEL_HEIGHT > 1 && CHARACTER_MODEL_HEIGHT < 20, CHARACTER_MODEL_HEIGHT);
});

check("JumpUp and JumpDown are one-shot — looping either replays a landing/launch pose pointlessly", () => {
  // The OPPOSITE of an earlier version of this check. That one asserted
  // `loop: true` on both, chasing a fix for "it falls down in idle after
  // jump" by trying to cover a variable-length FALL with a looping clip —
  // which produced the next bug this file's tests are named after ("it
  // repeats jump down animation throughout the whole jump"). The actual fix
  // was a topology change (JumpUp pauses through the whole flight, JumpDown
  // plays only once at the landing instant — see the class doc above
  // CHARACTER_LOCOMOTION_ANIM), which made `loop: true` wrong again: with
  // JumpDown entered only right as Grounded flips true, it only ever needs
  // to cover its own fixed clip length, and looping it would replay the
  // landing impact for no reason.
  for (const layer of CHARACTER_LOCOMOTION_ANIM.layers) {
    for (const state of layer.states) {
      if (state.id === "state-jumpup" || state.id === "state-jumpdown") {
        assert.equal(state.loop, false, `${state.name} should be one-shot, not looping`);
      }
    }
  }
});

check("re-entering JumpUp is not scoped to leaving Locomotion — a re-jump must interrupt JumpDown too", () => {
  const jumpup = CHARACTER_LOCOMOTION_ANIM.layers[0].transitions.find((t) => t.to === "state-jumpup");
  assert.equal(jumpup.from, "__any__", "scoping this to state-locomotion would block bunny-hopping out of JumpDown");
});

/* -------------------------------------------------------------------------- */
console.log("module registration");

check("the module ships exactly the three level components", () => {
  assert.deepEqual(
    levelDesignModule.components.map((component) => component.type).sort(),
    ["blockout", "level", "levelfloor"],
  );
  assert.equal(levelDesignModule.id, "level-design");
  // No setup(): a blockout is authored data, and a module with a per-engine
  // runtime would cost every shipping project a frame it doesn't need.
  assert.equal(levelDesignModule.setup, undefined);
});

/* -------------------------------------------------------------------------- */
/* A live engine: the pieces as components, and the level as something you can  */
/* actually stand on.                                                           */
/* -------------------------------------------------------------------------- */
console.log("live engine");

const { Engine, registerBuiltInComponents, applyEngineModules } = await import("../src/engine/index.js");
await import("../src/modules/index.js"); // registers the module catalog
registerBuiltInComponents();

const asyncCheck = async (name, fn) => {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${error.message}`);
  }
};

/** An engine with the level module (and optionally physics) enabled. */
async function makeEngine({ physics = false } = {}) {
  const engine = new Engine();
  const modules = physics ? ["physics-rapier", "level-design"] : ["level-design"];
  await applyEngineModules(engine, modules);
  if (physics) await engine.modules.get("physics-rapier")?.ready;
  return engine;
}

await asyncCheck("a Blockout with no Mesh component adds one and draws through it", async () => {
  const engine = await makeEngine();
  const entity = engine.createEntity({ name: "Wall" });
  entity.addComponent("blockout", { shape: "wall", size: [4, 3, 0.2] });
  const mesh = entity.getComponent("mesh");
  assert.ok(mesh, "a blockout must never be an entity that renders nothing");
  // The merging pass collects by `entity.components.get("mesh")` — a piece
  // drawing through a private mesh would be invisible to it.
  assert.ok(entity.components.get("mesh"), "the piece must be a merge candidate");
  const box = mesh.mesh.geometry.boundingBox;
  assert.ok(box, "the piece's geometry never reached the mesh");
  assert.ok(Math.abs(box.max.x - 2) < 1e-5 && Math.abs(box.max.y - 3) < 1e-5, `got ${box.max.toArray()}`);
});

await asyncCheck("resizing a piece rebuilds what is drawn", async () => {
  const engine = await makeEngine();
  const entity = engine.createEntity({ name: "Wall" });
  const piece = entity.addComponent("blockout", { shape: "wall", size: [4, 3, 0.2] });
  piece.setProp("size", [8, 3, 0.2]);
  const box = entity.getComponent("mesh").mesh.geometry.boundingBox;
  assert.ok(Math.abs(box.max.x - 4) < 1e-5, `the mesh still shows the old length (${box.max.x})`);
});

await asyncCheck("adding a door to a wall cuts a hole in the drawn geometry", async () => {
  const engine = await makeEngine();
  const entity = engine.createEntity({ name: "Wall" });
  const piece = entity.addComponent("blockout", { shape: "wall", size: [4, 3, 0.2] });
  const before = entity.getComponent("mesh").mesh.geometry.getAttribute("position").count;
  assert.equal(piece.addOpening({ offset: 0, width: 1, height: 2.1, sill: 0 }), 0);
  const after = entity.getComponent("mesh").mesh.geometry.getAttribute("position").count;
  assert.ok(after > before, "a wall with a door is more boxes than a solid one");
  assert.equal(piece.parts().length, 3);
});

await asyncCheck("shape can be converted in place, keeping the entity and its size", async () => {
  const engine = await makeEngine();
  const entity = engine.createEntity({ name: "Piece" });
  const piece = entity.addComponent("blockout", { shape: "wall", size: [4, 3, 0.2] });
  piece.setProp("shape", "floor");
  assert.deepEqual(piece.props.size, [4, 3, 0.2], "converting must not reset the dimensions");
  const box = entity.getComponent("mesh").mesh.geometry.boundingBox;
  assert.ok(box.max.y <= 1e-6, "a floor hangs below its origin, whatever it used to be");
});

await asyncCheck("the Level's Preview switch reaches every piece under it", async () => {
  const engine = await makeEngine();
  const root = engine.createEntity({ name: "Level" });
  const level = root.addComponent("level", {});
  const floor = engine.createEntity({ name: "Floor 0.00m", parent: root });
  floor.addComponent("levelfloor", {});
  const wall = engine.createEntity({ name: "Wall", parent: floor });
  wall.addComponent("blockout", { shape: "wall" });

  assert.equal(level.pieces().length, 1);
  assert.equal(level.floors().length, 1);
  const greybox = wall.getComponent("mesh").mesh.material;
  assert.match(greybox.name ?? "", /^Blockout /, "a piece starts on the greybox palette");
  level.setProp("preview", true);
  assert.notEqual(wall.getComponent("mesh").mesh.material, greybox, "Preview must swap the material");
  level.setProp("preview", false);
  assert.match(wall.getComponent("mesh").mesh.material.name ?? "", /^Blockout /);
});

await asyncCheck("two pieces of the same colour share one material instance", async () => {
  const engine = await makeEngine();
  const materials = ["A", "B"].map((name) => {
    const entity = engine.createEntity({ name });
    entity.addComponent("blockout", { shape: "wall" });
    return entity.getComponent("mesh").mesh.material;
  });
  // Sharing the INSTANCE is the condition same-material merging keys on; two
  // byte-identical-but-separate materials would cost a draw call each.
  assert.equal(materials[0], materials[1]);
});

await asyncCheck("a storey knows its elevation from its transform, not a prop", async () => {
  const engine = await makeEngine();
  const root = engine.createEntity({ name: "Level" });
  const level = root.addComponent("level", { storeyHeight: 3 });
  for (const y of [0, 3, 6]) {
    const floor = engine.createEntity({ name: `Floor ${y}`, parent: root });
    floor.object3D.position.y = y;
    floor.addComponent("levelfloor", {});
  }
  assert.deepEqual(level.floors().map((f) => f.object3D.position.y), [0, 3, 6], "floors sort lowest first");
  assert.equal(level.floorAt(3.4)?.name, "Floor 3");
  assert.equal(level.floors()[1].getComponent("levelfloor").storeyHeight, 3, "a floor inherits the level's height");
});

await asyncCheck("a character stands on a blockout floor instead of falling through it", async () => {
  const engine = await makeEngine({ physics: true });

  // The level: one 8×8 slab whose walkable surface is y = 0.
  const slab = engine.createEntity({ name: "Floor" });
  slab.addComponent("blockout", { shape: "floor", size: [8, 0.4, 8] });
  slab.addComponent("collider", { shape: "mesh", friction: 0.6 });

  // The character, dropped from 2 m with its feet at the origin (the rig's
  // convention — see characterRigSpec).
  const player = engine.createEntity({ name: "Player" });
  player.object3D.position.set(0, 2, 0);
  const cc = player.addComponent("charactercontroller", {
    height: 1,
    radius: 0.3,
    offset: [0, 0.8, 0],
    snapToGround: true,
  });

  engine.setPlaying(true);
  for (let i = 0; i < 120; i++) engine.physics.update(1 / 60);

  const y = player.object3D.position.y;
  assert.ok(cc.isGrounded(), "the character never found the floor");
  assert.ok(Math.abs(y) < 0.1, `expected to land at y ≈ 0, got ${y.toFixed(3)}`);

  // And it can walk: drive it toward the slab's edge and it must move.
  const startX = player.object3D.position.x;
  for (let i = 0; i < 60; i++) {
    cc.move([2, 0, 0]);
    engine.physics.update(1 / 60);
  }
  assert.ok(player.object3D.position.x - startX > 1, "the character did not move when told to");
  assert.ok(Math.abs(player.object3D.position.y) < 0.1, "it should still be on the slab");
  engine.setPlaying(false);
});

await asyncCheck("a character climbs a blockout staircase", async () => {
  const engine = await makeEngine({ physics: true });

  const slab = engine.createEntity({ name: "Floor" });
  slab.addComponent("blockout", { shape: "floor", size: [12, 0.4, 12] });
  slab.addComponent("collider", { shape: "mesh" });

  // A 1.2 m rise over 3 m of run, climbing along +Z from z = 0.5.
  const stair = engine.createEntity({ name: "Stair" });
  stair.object3D.position.set(0, 0, 2);
  stair.addComponent("blockout", { shape: "stair", size: [2, 1.2, 3], steps: 8 });
  stair.addComponent("collider", { shape: "mesh" });

  const player = engine.createEntity({ name: "Player" });
  player.object3D.position.set(0, 0.1, -0.5);
  const cc = player.addComponent("charactercontroller", {
    height: 1,
    radius: 0.3,
    offset: [0, 0.8, 0],
    snapToGround: true,
    autostep: true,
    autostepHeight: 0.35,
    slopeClimbAngle: 50,
  });

  engine.setPlaying(true);
  for (let i = 0; i < 30; i++) engine.physics.update(1 / 60); // settle
  assert.ok(cc.isGrounded(), "the character did not start on the slab");
  // The high-water mark, not the final position: keep walking past the top and
  // the character crosses the slab and steps off its far edge, which would
  // read as "never climbed" while actually being "climbed, then fell off the
  // end of the test's geometry".
  let highest = player.object3D.position.y;
  for (let i = 0; i < 200; i++) {
    cc.move([0, 0, 2]);
    engine.physics.update(1 / 60);
    highest = Math.max(highest, player.object3D.position.y);
  }
  // 8 steps of 0.15 m: the autostep default clears each one.
  assert.ok(highest > 1, `the character stalled at y = ${highest.toFixed(3)} instead of climbing`);
  engine.setPlaying(false);
});

await asyncCheck("a wall's doorway is a hole you can walk through", async () => {
  const engine = await makeEngine({ physics: true });

  const slab = engine.createEntity({ name: "Floor" });
  slab.addComponent("blockout", { shape: "floor", size: [12, 0.4, 12] });
  slab.addComponent("collider", { shape: "mesh" });

  const wall = engine.createEntity({ name: "Wall" });
  wall.object3D.position.set(0, 0, 1.5);
  const piece = wall.addComponent("blockout", {
    shape: "wall",
    size: [8, 3, 0.3],
    openings: [{ offset: 0, width: 1.4, height: 2.2, sill: 0 }],
  });
  wall.addComponent("collider", { shape: "mesh" });

  const player = engine.createEntity({ name: "Player" });
  player.object3D.position.set(0, 0.1, -1);
  const cc = player.addComponent("charactercontroller", {
    height: 1, radius: 0.3, offset: [0, 0.8, 0], snapToGround: true,
  });

  engine.setPlaying(true);
  for (let i = 0; i < 240; i++) {
    cc.move([0, 0, 2]);
    engine.physics.update(1 / 60);
  }
  assert.ok(piece.parts().length >= 3, "the wall was not actually cut");
  assert.ok(
    player.object3D.position.z > 2,
    `the character was stopped at z = ${player.object3D.position.z.toFixed(2)} — the doorway is solid`,
  );
  engine.setPlaying(false);
});

if (failures) {
  console.error(`\n${failures} level-design check(s) failed`);
  process.exit(1);
}
console.log("\nlevel design: all checks passed");
