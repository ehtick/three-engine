/**
 * Animation depth (roadmap item 6): blend trees, layers + avatar masks, root
 * motion and two-bone IK.
 *
 * All of it runs headlessly against the REAL three.js AnimationMixer — the
 * skeletons and clips below are built in code rather than loaded from a GLB, so
 * every expected pose is a number this file can state exactly instead of "looks
 * right". The rigs deliberately sit under a -90° X up-axis correction, because
 * that is what glTF exporters emit and it is the single most common source of
 * "root motion goes into the floor" and "the mask picks the wrong bones".
 */
import assert from "node:assert/strict";

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

const THREE = await import("three/webgpu");
const { blend1D, blend2D, syncTimeScales } = await import("../src/engine/anim/blendTree.js");
const { resolveMaskBones, filterClipToMask, collectBoneNames } = await import("../src/engine/anim/mask.js");
const { solveTwoBoneIK } = await import("../src/engine/anim/ik.js");
const { AnimatorRuntime, normalizeGraph, createLayer, ANY_STATE } = await import("../src/engine/animGraph.js");
const { Engine, registerBuiltInComponents } = await import("../src/engine/index.js");

registerBuiltInComponents();

let failures = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${error.message}`);
  }
};
const near = (actual, expected, tol, what) =>
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${what}: expected ~${expected}, got ${actual} (tolerance ${tol})`,
  );
const section = (title) => console.log(`\n${title}`);

// ---------------------------------------------------------------------------
// rigs and clips
// ---------------------------------------------------------------------------

/**
 * A humanoid-ish rig under a glTF-style up-axis correction.
 *
 *   entity ─ Armature (rot -90° X) ─ Hips ─ Spine ─ ArmL
 *                                        └ Thigh ─ Shin ─ Foot
 */
function makeRig() {
  const entityObject = new THREE.Object3D();
  const armature = new THREE.Object3D();
  armature.name = "Armature";
  armature.rotation.x = -Math.PI / 2;
  entityObject.add(armature);

  const bone = (name, parent, pos = [0, 0, 0]) => {
    const b = new THREE.Bone();
    b.name = name;
    b.position.set(...pos);
    parent.add(b);
    return b;
  };
  const hips = bone("Hips", armature);
  const spine = bone("Spine", hips, [0, 0, 0.5]);
  const armL = bone("ArmL", spine, [0.3, 0, 0.2]);
  const thigh = bone("Thigh", hips, [0.15, 0, -0.1]);
  const shin = bone("Shin", thigh, [0, 0, -1]);
  const foot = bone("Foot", shin, [0, 0, -1]);
  entityObject.updateMatrixWorld(true);
  return { entityObject, armature, hips, spine, armL, thigh, shin, foot };
}

const quatTrack = (node, times, quats) =>
  new THREE.QuaternionKeyframeTrack(
    `${node}.quaternion`,
    times,
    quats.flatMap((q) => [q.x, q.y, q.z, q.w]),
  );
const vecTrack = (node, times, values) =>
  new THREE.VectorKeyframeTrack(`${node}.position`, times, values.flat());
const spin = (axis, angle) => new THREE.Quaternion().setFromAxisAngle(axis, angle);

const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);

// ---------------------------------------------------------------------------

section("blend trees");

await check("1D blend is exact at each threshold", () => {
  const children = [{ threshold: 0 }, { threshold: 2 }, { threshold: 6 }];
  for (let i = 0; i < children.length; i++) {
    const w = blend1D(children, children[i].threshold);
    near(w[i], 1, 1e-9, `weight at threshold ${children[i].threshold}`);
  }
});

await check("1D blend splits the bracketing pair linearly and sums to 1", () => {
  const children = [{ threshold: 0 }, { threshold: 2 }, { threshold: 6 }];
  const w = blend1D(children, 3);
  near(w[0], 0, 1e-9, "idle");
  near(w[1], 0.75, 1e-9, "walk");
  near(w[2], 0.25, 1e-9, "run");
  near(w.reduce((a, b) => a + b, 0), 1, 1e-9, "sum");
});

await check("1D blend clamps instead of extrapolating outside the range", () => {
  const children = [{ threshold: 0 }, { threshold: 2 }];
  near(blend1D(children, -5)[0], 1, 1e-9, "below range");
  near(blend1D(children, 99)[1], 1, 1e-9, "above range");
});

await check("1D blend tolerates unsorted children and stays index-aligned", () => {
  // Authored out of order — the panel lets you type thresholds in any order.
  const children = [{ threshold: 6 }, { threshold: 0 }, { threshold: 2 }];
  const w = blend1D(children, 1);
  near(w[1], 0.5, 1e-9, "threshold 0 child");
  near(w[2], 0.5, 1e-9, "threshold 2 child");
  near(w[0], 0, 1e-9, "threshold 6 child");
});

await check("2D cartesian blend is exact at each sample", () => {
  const children = [
    { px: 0, py: 0 },
    { px: 1, py: 0 },
    { px: 0, py: 1 },
    { px: -1, py: 0 },
  ];
  for (let i = 0; i < children.length; i++) {
    const w = blend2D(children, children[i].px, children[i].py);
    near(w[i], 1, 1e-6, `weight at sample ${i}`);
  }
});

await check("2D cartesian blend sums to 1 across the interior", () => {
  const children = [
    { px: 0, py: 1 },
    { px: 1, py: 0 },
    { px: 0, py: -1 },
    { px: -1, py: 0 },
  ];
  for (const [x, y] of [[0, 0], [0.3, 0.3], [-0.7, 0.2], [0.5, -0.5]]) {
    const w = blend2D(children, x, y);
    near(w.reduce((a, b) => a + b, 0), 1, 1e-9, `sum at (${x},${y})`);
    assert.ok(w.every((v) => v >= 0), "no negative weights");
  }
});

await check("2D directional blend keeps opposite directions apart", () => {
  // A strafe set: idle at the origin, forward and back at the same speed.
  // Cartesian distance says (0,-3) is 6 away from (0,3) — but so is a point
  // twice as fast forward. Directional says they are 180° apart.
  const children = [
    { px: 0, py: 0 }, // idle
    { px: 0, py: 3 }, // forward
    { px: 0, py: -3 }, // backward
    { px: 3, py: 0 }, // strafe right
  ];
  const forward = blend2D(children, 0, 3, "directional");
  near(forward[1], 1, 1e-6, "pure forward");
  near(forward[2], 0, 1e-6, "backward must not bleed in");
  const half = blend2D(children, 0, 1.5, "directional");
  assert.ok(half[0] > 0.2 && half[1] > 0.2, "half speed blends idle with forward");
  near(half[2] + half[3], 0, 1e-6, "no backward/strafe at pure forward heading");
});

await check("2D blend falls back to the nearest sample for degenerate input", () => {
  const children = [{ px: 1, py: 1 }, { px: 1, py: 1 }];
  const w = blend2D(children, NaN, NaN);
  near(w.reduce((a, b) => a + b, 0), 1, 1e-9, "sum");
});

await check("cycle sync retimes children to a common duration", () => {
  // Walk 1.0s at 60% weight, run 0.5s at 40% => target cycle 0.8s.
  const scales = syncTimeScales([1.0, 0.5], [0.6, 0.4], [1, 1]);
  near(scales[0], 1 / 0.8, 1e-9, "walk rate");
  near(scales[1], 0.5 / 0.8, 1e-9, "run rate");
  // Both now take the same wall-clock time per cycle — the property that stops
  // the feet drifting apart mid-blend.
  near(1.0 / scales[0], 0.5 / scales[1], 1e-9, "equal cycle length");
});

await check("an authored per-child speed pulls the shared cycle, not that child alone", () => {
  // Sync means every child completes a stride together, so a child's own speed
  // cannot make it outrun its siblings — what it does is shorten the common
  // cycle everyone is retimed to. (Wanting one child genuinely faster than the
  // others means turning sync off; there is no coherent blend otherwise.)
  const plain = syncTimeScales([1.0, 1.0], [0.5, 0.5], [1, 1]);
  near(1.0 / plain[0], 1.0, 1e-9, "unmodified cycle is the clip length");
  const hastened = syncTimeScales([1.0, 1.0], [0.5, 0.5], [1, 2]);
  near(1.0 / hastened[0], 0.75, 1e-9, "one child at 2x drags the average down");
  near(1.0 / hastened[0], 1.0 / hastened[1], 1e-9, "and both still share it");
});

// ---------------------------------------------------------------------------

section("avatar masks");

await check("mask resolves named bones and their descendants", () => {
  const rig = makeRig();
  const allowed = resolveMaskBones(rig.armature, { bones: ["Spine"], includeChildren: true });
  assert.ok(allowed.has("Spine"), "the named bone");
  assert.ok(allowed.has("ArmL"), "its child");
  assert.ok(!allowed.has("Hips"), "not its parent");
  assert.ok(!allowed.has("Thigh"), "not a sibling branch");
});

await check("mask can exclude descendants", () => {
  const rig = makeRig();
  const allowed = resolveMaskBones(rig.armature, { bones: ["Spine"], includeChildren: false });
  assert.ok(allowed.has("Spine") && !allowed.has("ArmL"), "children excluded");
});

await check("inverted mask is the complement", () => {
  const rig = makeRig();
  const allowed = resolveMaskBones(rig.armature, { bones: ["Spine"], includeChildren: true, invert: true });
  assert.ok(allowed.has("Hips") && allowed.has("Thigh"), "everything else is in");
  assert.ok(!allowed.has("Spine") && !allowed.has("ArmL"), "the masked branch is out");
});

await check("mask filtering drops the excluded tracks and keeps the duration", () => {
  const clip = new THREE.AnimationClip("pose", 1, [
    quatTrack("Hips", [0, 1], [spin(X, 0), spin(X, 0.4)]),
    quatTrack("ArmL", [0, 1], [spin(X, 0), spin(X, 0.9)]),
  ]);
  const rig = makeRig();
  const allowed = resolveMaskBones(rig.armature, { bones: ["ArmL"] });
  const filtered = filterClipToMask(clip, allowed);
  assert.equal(filtered.tracks.length, 1, "one track survives");
  assert.ok(filtered.tracks[0].name.startsWith("ArmL"), "the right one");
  assert.equal(filtered.duration, clip.duration, "duration preserved");
  assert.equal(filterClipToMask(clip, allowed), filtered, "result is cached, not rebuilt");
});

await check("a mask matching no bone makes its layer inert, not full-body", () => {
  // The failure mode this guards: a controller shared between two rigs, or a
  // renamed bone. Returning "no mask" would promote an aim overlay into a
  // whole-body override — far worse than the layer doing nothing.
  const rig = makeRig();
  const warnings = [];
  const original = console.warn;
  console.warn = (m) => warnings.push(String(m));
  try {
    const allowed = resolveMaskBones(rig.armature, { bones: ["mixamorig:Spine"] });
    assert.ok(allowed instanceof Set && allowed.size === 0, "the empty set, not null");
    assert.ok(warnings.some((w) => w.includes("matched no bones")), "it says so");
  } finally {
    console.warn = original;
  }
});

await check("bone listing is hierarchy-ordered with depths for the mask editor", () => {
  const rig = makeRig();
  const bones = collectBoneNames(rig.armature);
  const names = bones.map((b) => b.name);
  assert.deepEqual(names, ["Hips", "Spine", "ArmL", "Thigh", "Shin", "Foot"]);
  assert.equal(bones.find((b) => b.name === "Hips").depth, 0);
  assert.equal(bones.find((b) => b.name === "ArmL").depth, 2);
});

// ---------------------------------------------------------------------------

section("graph format");

await check("a v1 flat graph normalizes into a single base layer", () => {
  const v1 = {
    version: 1,
    parameters: [{ name: "speed", type: "number" }],
    states: [{ id: "s1", name: "Idle", clip: "idle" }],
    startTransitions: [{ to: "s1" }],
    transitions: [{ id: "t1", from: "s1", to: "s1" }],
  };
  const v2 = normalizeGraph(v1);
  assert.equal(v2.version, 2);
  assert.equal(v2.layers.length, 1);
  assert.equal(v2.layers[0].name, "Base Layer");
  assert.equal(v2.layers[0].states[0].kind, "clip", "states get an explicit kind");
  assert.equal(v2.layers[0].transitions.length, 1);
  assert.deepEqual(v1.states[0].kind, undefined, "the input is not mutated");
});

await check("blend-tree states normalize their children", () => {
  const graph = normalizeGraph({
    layers: [{ ...createLayer("Base"), states: [{ id: "s", name: "Move", kind: "blend1d", children: [{ clip: "walk" }] }] }],
  });
  const state = graph.layers[0].states[0];
  assert.equal(state.children[0].threshold, 0);
  assert.equal(state.children[0].speed, 1);
  assert.equal(state.syncTime, true, "cycle sync is on by default");
});

// ---------------------------------------------------------------------------

section("state machine + blend trees at runtime");

/** Builds a live animator over a rig, with the clips the layer tests need. */
function makeAnimator(graph, { rig = makeRig(), rootMotion = null, clips = null } = {}) {
  const mixer = new THREE.AnimationMixer(rig.armature);
  const runtime = new AnimatorRuntime(graph, mixer, clips ?? defaultClips(), {
    root: rig.armature,
    entityObject: rig.entityObject,
    rootMotion,
  });
  return { rig, mixer, runtime };
}

function defaultClips() {
  return [
    new THREE.AnimationClip("idle", 1, [quatTrack("Spine", [0, 1], [spin(X, 0), spin(X, 0)])]),
    new THREE.AnimationClip("walk", 1, [quatTrack("Spine", [0, 1], [spin(X, 0.2), spin(X, 0.2)])]),
    new THREE.AnimationClip("run", 0.5, [quatTrack("Spine", [0, 0.5], [spin(X, 0.6), spin(X, 0.6)])]),
  ];
}

const locomotionGraph = () => ({
  version: 2,
  parameters: [
    { name: "speed", type: "number", default: 0 },
    { name: "jump", type: "trigger" },
  ],
  layers: [
    {
      ...createLayer("Base Layer"),
      states: [
        { id: "idle", name: "Idle", kind: "clip", clip: "idle" },
        {
          id: "move",
          name: "Move",
          kind: "blend1d",
          blendParam: "speed",
          children: [
            { clip: "walk", threshold: 1 },
            { clip: "run", threshold: 5 },
          ],
        },
      ],
      startTransitions: [{ to: "idle" }],
      transitions: [
        { id: "t1", from: "idle", to: "move", duration: 0.2, conditions: [{ param: "speed", op: ">", value: 0.1 }] },
        { id: "t2", from: "move", to: "idle", duration: 0.2, conditions: [{ param: "speed", op: "<=", value: 0.1 }] },
      ],
    },
  ],
});

await check("the entry state is the one the Start node points at", () => {
  const { runtime } = makeAnimator(locomotionGraph());
  assert.equal(runtime.currentState.name, "Idle");
});

await check("a condition transitions the state machine", () => {
  const { runtime } = makeAnimator(locomotionGraph());
  runtime.setParam("speed", 3);
  runtime.update(1 / 60);
  assert.equal(runtime.currentState.name, "Move");
});

await check("crossfading state weights sum to the layer weight throughout", () => {
  const { runtime } = makeAnimator(locomotionGraph());
  runtime.setParam("speed", 3);
  for (let i = 0; i < 10; i++) {
    runtime.update(1 / 60);
    const total = runtime.contributions.reduce((a, c) => a + c.weight, 0);
    near(total, 1, 1e-6, `total action weight at frame ${i}`);
  }
});

await check("blend-tree children are weighted by the parameter", () => {
  const { runtime } = makeAnimator(locomotionGraph());
  runtime.setParam("speed", 3); // exactly between thresholds 1 and 5
  for (let i = 0; i < 30; i++) runtime.update(1 / 60); // let the crossfade finish
  const move = runtime.layers[0].states.get("move");
  near(move.weights[0], 0.5, 1e-6, "walk");
  near(move.weights[1], 0.5, 1e-6, "run");
});

await check("blend-tree children are cycle-synced, not played at their own rate", () => {
  const { runtime } = makeAnimator(locomotionGraph());
  runtime.setParam("speed", 3);
  for (let i = 0; i < 30; i++) runtime.update(1 / 60);
  const move = runtime.layers[0].states.get("move");
  const [walk, run] = move.entries;
  // walk is 1.0s, run is 0.5s — synced, run must play at half walk's rate so
  // both complete a stride together.
  near(
    walk.clip.duration / Math.abs(walk.action.timeScale),
    run.clip.duration / Math.abs(run.action.timeScale),
    1e-6,
    "cycle lengths",
  );
});

await check("a trigger fires its transition once and is consumed", () => {
  const graph = locomotionGraph();
  graph.layers[0].states.push({ id: "jump", name: "Jump", kind: "clip", clip: "run", loop: false });
  graph.layers[0].transitions.push({
    id: "t3",
    from: ANY_STATE,
    to: "jump",
    duration: 0,
    conditions: [{ param: "jump" }],
  });
  const { runtime } = makeAnimator(graph);
  runtime.setTrigger("jump");
  runtime.update(1 / 60);
  assert.equal(runtime.currentState.name, "Jump");
  assert.equal(runtime.getParam("jump"), false, "the trigger was consumed");
});

await check("two states sharing one clip get independent playheads", () => {
  // The trap: three caches actions by clip, so without a clone both states
  // would share a single playhead and entering one would yank the other.
  const graph = {
    version: 2,
    parameters: [],
    layers: [
      {
        ...createLayer("Base"),
        states: [
          { id: "a", name: "A", kind: "clip", clip: "walk" },
          { id: "b", name: "B", kind: "clip", clip: "walk" },
        ],
        startTransitions: [{ to: "a" }],
        transitions: [],
      },
    ],
  };
  const { runtime } = makeAnimator(graph);
  const a = runtime.layers[0].states.get("a").entries[0].action;
  const b = runtime.layers[0].states.get("b").entries[0].action;
  assert.notEqual(a, b, "distinct actions");
  runtime.update(0.25);
  assert.ok(a.time > 0, "A advanced");
  assert.equal(b.time, 0, "B was not dragged along");
});

await check("re-entering the current state restarts it instead of blending with itself", () => {
  const { runtime } = makeAnimator(locomotionGraph());
  runtime.update(0.4);
  const layer = runtime.layers[0];
  const idle = layer.states.get("idle");
  assert.ok(idle.entries[0].action.time > 0.3, "it had progressed");
  runtime.play("Idle", 0.2);
  assert.equal(layer.prevId, null, "no self-crossfade");
  runtime.update(1 / 60);
  assert.ok(idle.entries[0].action.time < 0.1, "restarted from the top");
  near(runtime.contributions.reduce((a, c) => a + c.weight, 0), 1, 1e-6, "still full weight");
});

// ---------------------------------------------------------------------------

section("layers");

const armPose = spin(Z, 1.0);
const basePose = spin(Z, 0.2);

function layeredSetup({ blend = "override", weight = 1 } = {}) {
  const clips = [
    new THREE.AnimationClip("base", 1, [
      quatTrack("Hips", [0, 1], [basePose, basePose]),
      quatTrack("ArmL", [0, 1], [basePose, basePose]),
    ]),
    new THREE.AnimationClip("aim", 1, [
      quatTrack("Hips", [0, 1], [spin(Z, -1.4), spin(Z, -1.4)]),
      quatTrack("ArmL", [0, 1], [armPose, armPose]),
    ]),
  ];
  const graph = {
    version: 2,
    parameters: [],
    layers: [
      {
        ...createLayer("Base Layer"),
        states: [{ id: "b", name: "Base", kind: "clip", clip: "base" }],
        startTransitions: [{ to: "b" }],
      },
      {
        ...createLayer("Aim"),
        weight,
        blend,
        mask: { bones: ["ArmL"], includeChildren: true },
        states: [{ id: "a", name: "Aim", kind: "clip", clip: "aim" }],
        startTransitions: [{ to: "a" }],
      },
    ],
  };
  return makeAnimator(graph, { clips });
}

await check("an override layer at full weight replaces the base pose on its mask", () => {
  const { rig, runtime } = layeredSetup({ weight: 1 });
  runtime.update(1 / 60);
  near(rig.armL.quaternion.angleTo(armPose), 0, 2e-3, "ArmL follows the aim layer");
});

await check("...and leaves bones outside the mask entirely to the base layer", () => {
  const { rig, runtime } = layeredSetup({ weight: 1 });
  runtime.update(1 / 60);
  // The aim clip also rotates Hips — masked out, so it must not leak through,
  // not even at the base layer's 1e-4 floor.
  near(rig.hips.quaternion.angleTo(basePose), 0, 1e-6, "Hips is pure base");
});

await check("an override layer at zero weight is inert", () => {
  const { rig, runtime } = layeredSetup({ weight: 0 });
  runtime.update(1 / 60);
  near(rig.armL.quaternion.angleTo(basePose), 0, 1e-6, "ArmL is pure base");
});

await check("layer weight blends the two poses proportionally", () => {
  const { rig, runtime } = layeredSetup({ weight: 0.5 });
  runtime.update(1 / 60);
  const toBase = rig.armL.quaternion.angleTo(basePose);
  const toAim = rig.armL.quaternion.angleTo(armPose);
  near(toBase, toAim, 5e-3, "halfway between the two poses");
  assert.ok(toBase > 0.1, "and actually moved off the base pose");
});

await check("layer weight is drivable at runtime by name", () => {
  const { rig, runtime } = layeredSetup({ weight: 0 });
  runtime.update(1 / 60);
  near(rig.armL.quaternion.angleTo(basePose), 0, 1e-6, "starts off");
  runtime.setLayerWeight("Aim", 1);
  runtime.update(1 / 60);
  near(rig.armL.quaternion.angleTo(armPose), 0, 2e-3, "now on");
});

await check("the base layer's weight is structural and cannot be turned down", () => {
  const { runtime } = layeredSetup({ weight: 0 });
  runtime.setLayerWeight(0, 0.1);
  assert.equal(runtime.getLayerWeight(0), 1, "base stays at full");
});

await check("an additive layer offsets the base pose rather than replacing it", () => {
  const lean = spin(Z, 0.8);
  const clips = [
    new THREE.AnimationClip("base", 1, [quatTrack("Spine", [0, 1], [basePose, basePose])]),
    // Starts at identity so frame 0 IS the neutral reference the additive
    // conversion subtracts; by t=1 it is a pure `lean` offset.
    new THREE.AnimationClip("lean", 1, [quatTrack("Spine", [0, 1], [spin(Z, 0), lean])]),
  ];
  const graph = {
    version: 2,
    parameters: [],
    layers: [
      {
        ...createLayer("Base Layer"),
        states: [{ id: "b", name: "Base", kind: "clip", clip: "base" }],
        startTransitions: [{ to: "b" }],
      },
      {
        ...createLayer("Lean"),
        weight: 1,
        blend: "additive",
        states: [{ id: "l", name: "Lean", kind: "clip", clip: "lean", loop: false }],
        startTransitions: [{ to: "l" }],
      },
    ],
  };
  const { rig, runtime } = makeAnimator(graph, { clips });
  runtime.update(1); // land on the end of the additive clip
  const expected = basePose.clone().multiply(lean);
  near(rig.spine.quaternion.angleTo(expected), 0, 2e-2, "base ∘ additive offset");
  assert.ok(rig.spine.quaternion.angleTo(basePose) > 0.5, "and it is not just the base pose");
});

await check("disjoint masks don't attenuate each other", () => {
  // Two override layers at full weight over different branches. The naive
  // cascade would have the upper one zero out the lower one everywhere; the
  // mask-overlap test is what keeps a face layer from killing an arm layer.
  const armPoseB = spin(Z, 1.1);
  const legPose = spin(Z, -0.9);
  const clips = [
    new THREE.AnimationClip("base", 1, [
      quatTrack("ArmL", [0, 1], [basePose, basePose]),
      quatTrack("Thigh", [0, 1], [basePose, basePose]),
    ]),
    new THREE.AnimationClip("arm", 1, [quatTrack("ArmL", [0, 1], [armPoseB, armPoseB])]),
    new THREE.AnimationClip("leg", 1, [quatTrack("Thigh", [0, 1], [legPose, legPose])]),
  ];
  const layerFor = (name, clip, boneName) => ({
    ...createLayer(name),
    weight: 1,
    mask: { bones: [boneName], includeChildren: true },
    states: [{ id: `${name}s`, name, kind: "clip", clip }],
    startTransitions: [{ to: `${name}s` }],
  });
  const graph = {
    version: 2,
    parameters: [],
    layers: [
      {
        ...createLayer("Base Layer"),
        states: [{ id: "b", name: "Base", kind: "clip", clip: "base" }],
        startTransitions: [{ to: "b" }],
      },
      layerFor("Arm", "arm", "ArmL"),
      layerFor("Leg", "leg", "Thigh"),
    ],
  };
  const { rig, runtime } = makeAnimator(graph, { clips });
  runtime.update(1 / 60);
  near(rig.armL.quaternion.angleTo(armPoseB), 0, 2e-3, "arm layer survived");
  near(rig.thigh.quaternion.angleTo(legPose), 0, 2e-3, "leg layer survived");
});

// ---------------------------------------------------------------------------

section("root motion");

/**
 * A rig whose Hips translate +2 along the ARMATURE's local +Y over one second.
 * With the -90° X correction that is entity-space -Z — i.e. "forward". Getting
 * this conversion wrong is what sends a walk cycle into the floor.
 */
function walkClips() {
  return [
    new THREE.AnimationClip("stride", 1, [vecTrack("Hips", [0, 1], [[0, 0, 0], [0, 2, 0]])]),
    new THREE.AnimationClip("turn", 1, [
      vecTrack("Hips", [0, 1], [[0, 0, 0], [0, 0, 0]]),
      quatTrack("Hips", [0, 1], [spin(Z, 0), spin(Z, Math.PI / 2)]),
    ]),
  ];
}

const rootMotionGraph = (clip) => ({
  version: 2,
  parameters: [],
  layers: [
    {
      ...createLayer("Base Layer"),
      states: [{ id: "s", name: "Stride", kind: "clip", clip }],
      startTransitions: [{ to: "s" }],
    },
  ],
});

await check("root translation is reported in entity space, through the up-axis fix", () => {
  const { rig, runtime } = makeAnimator(rootMotionGraph("stride"), {
    clips: walkClips(),
    rootMotion: { enabled: true, applyRotation: true },
  });
  runtime.update(0.5);
  const d = runtime.rootMotion.delta;
  near(d.x, 0, 1e-6, "no sideways drift");
  near(d.y, 0, 1e-6, "vertical is off by default");
  near(d.z, -1, 1e-4, "half the stride, forward");
  near(rig.hips.position.length(), 0, 1e-4, "and the pose stayed in place");
});

await check("root motion accumulates exactly across clip loops", () => {
  const { runtime } = makeAnimator(rootMotionGraph("stride"), {
    clips: walkClips(),
    rootMotion: { enabled: true },
  });
  let travelled = 0;
  for (let i = 0; i < 180; i++) {
    runtime.update(1 / 60);
    travelled += runtime.rootMotion.delta.z;
    assert.ok(runtime.rootMotion.delta.z <= 1e-9, `frame ${i} moved backwards — the loop wrap leaked`);
  }
  // 3 seconds at 2 units/second, forward: no lost motion at the three wraps.
  near(travelled, -6, 5e-3, "total distance");
});

await check("the pose stays in place across loops instead of ratcheting", () => {
  const { rig, runtime } = makeAnimator(rootMotionGraph("stride"), {
    clips: walkClips(),
    rootMotion: { enabled: true },
  });
  let worst = 0;
  for (let i = 0; i < 180; i++) {
    runtime.update(1 / 60);
    worst = Math.max(worst, rig.hips.position.length());
  }
  near(worst, 0, 1e-3, "hips never drift from the origin");
});

await check("vertical root motion is opt-in", () => {
  const clips = [new THREE.AnimationClip("hop", 1, [vecTrack("Hips", [0, 1], [[0, 0, 0], [0, 0, 1.5]])])];
  // Armature-local +Z is entity-space +Y under the -90° X correction.
  const off = makeAnimator(rootMotionGraph("hop"), { clips, rootMotion: { enabled: true, applyY: false } });
  off.runtime.update(0.5);
  near(off.runtime.rootMotion.delta.y, 0, 1e-9, "dropped when off");

  const on = makeAnimator(rootMotionGraph("hop"), { clips, rootMotion: { enabled: true, applyY: true } });
  on.runtime.update(0.5);
  near(on.runtime.rootMotion.delta.y, 0.75, 1e-4, "reported when on");
});

await check("root rotation is reported as an entity-space yaw", () => {
  const { rig, runtime } = makeAnimator(rootMotionGraph("turn"), {
    clips: walkClips(),
    rootMotion: { enabled: true, applyRotation: true },
  });
  let yaw = 0;
  for (let i = 0; i < 60; i++) {
    runtime.update(1 / 60);
    yaw += runtime.rootMotion.deltaYaw;
  }
  near(Math.abs(yaw), Math.PI / 2, 1e-3, "a quarter turn");
  near(rig.hips.quaternion.angleTo(spin(Z, 0)), 0, 5e-3, "and the pose is left unrotated");
});

await check("root rotation can be left in the pose", () => {
  const { rig, runtime } = makeAnimator(rootMotionGraph("turn"), {
    clips: walkClips(),
    rootMotion: { enabled: true, applyRotation: false },
  });
  // Stop at 0.75 of the clip — past the loop point the raw pose is back near
  // identity, which would make this assertion pass for the wrong reason.
  for (let i = 0; i < 45; i++) runtime.update(1 / 60);
  near(runtime.rootMotion.deltaYaw, 0, 1e-9, "nothing handed to the entity");
  assert.ok(rig.hips.quaternion.angleTo(spin(Z, 0)) > 1, "the turn stayed in the animation");
});

await check("applyTo moves the entity and clears the script-facing pending total", () => {
  const { rig, runtime } = makeAnimator(rootMotionGraph("stride"), {
    clips: walkClips(),
    rootMotion: { enabled: true },
  });
  rig.entityObject.rotateY(Math.PI / 2); // face entity-local -Z toward world -X
  runtime.update(0.5);
  runtime.rootMotion.applyTo(rig.entityObject);
  near(rig.entityObject.position.x, -1, 1e-3, "moved along its own facing, not world -Z");
  near(runtime.rootMotion.consume().position.length(), 0, 1e-9, "pending was cleared");
});

await check("consumeRootMotion hands the accumulated motion over exactly once", () => {
  const { runtime } = makeAnimator(rootMotionGraph("stride"), {
    clips: walkClips(),
    rootMotion: { enabled: true },
  });
  runtime.update(0.25);
  runtime.update(0.25);
  const first = runtime.rootMotion.consume();
  near(first.position.z, -1, 1e-4, "both frames' motion");
  near(runtime.rootMotion.consume().position.length(), 0, 1e-9, "and nothing left over");
});

// ---------------------------------------------------------------------------

section("two-bone IK");

/** Thigh → Shin → Foot, one unit each, pre-bent so the solve has a plane. */
function ikChain() {
  const rig = makeRig();
  rig.shin.rotation.x = 0.35;
  rig.entityObject.updateMatrixWorld(true);
  return rig;
}

await check("the tip reaches a target inside the chain's reach", () => {
  const rig = ikChain();
  const origin = rig.thigh.getWorldPosition(new THREE.Vector3());
  const target = origin.clone().add(new THREE.Vector3(0.4, -1.3, 0.3));
  solveTwoBoneIK(rig.thigh, rig.shin, rig.foot, target, null, 1);
  const tip = rig.foot.getWorldPosition(new THREE.Vector3());
  near(tip.distanceTo(target), 0, 1e-3, "tip on target");
});

await check("bone lengths are preserved by the solve", () => {
  const rig = ikChain();
  const origin = rig.thigh.getWorldPosition(new THREE.Vector3());
  const before = [
    rig.thigh.getWorldPosition(new THREE.Vector3()).distanceTo(rig.shin.getWorldPosition(new THREE.Vector3())),
    rig.shin.getWorldPosition(new THREE.Vector3()).distanceTo(rig.foot.getWorldPosition(new THREE.Vector3())),
  ];
  solveTwoBoneIK(rig.thigh, rig.shin, rig.foot, origin.clone().add(new THREE.Vector3(0.9, -1.1, 0)), null, 1);
  const after = [
    rig.thigh.getWorldPosition(new THREE.Vector3()).distanceTo(rig.shin.getWorldPosition(new THREE.Vector3())),
    rig.shin.getWorldPosition(new THREE.Vector3()).distanceTo(rig.foot.getWorldPosition(new THREE.Vector3())),
  ];
  near(after[0], before[0], 1e-6, "upper bone");
  near(after[1], before[1], 1e-6, "lower bone");
});

await check("an out-of-reach target extends the limb toward it without snapping", () => {
  const rig = ikChain();
  const origin = rig.thigh.getWorldPosition(new THREE.Vector3());
  const far = origin.clone().add(new THREE.Vector3(0, -8, 0));
  solveTwoBoneIK(rig.thigh, rig.shin, rig.foot, far, null, 1);
  const tip = rig.foot.getWorldPosition(new THREE.Vector3());
  const reach = tip.distanceTo(origin);
  assert.ok(reach > 1.9 && reach <= 2.0, `nearly straight but not degenerate (got ${reach})`);
  // Pointing AT the target is what matters when you can't touch it.
  const toTip = tip.clone().sub(origin).normalize();
  const toTarget = far.clone().sub(origin).normalize();
  near(toTip.dot(toTarget), 1, 1e-3, "aimed at the target");
});

await check("weight blends between the animated pose and the solved one", () => {
  const target = ikChain().thigh.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0.8, -1.0, 0));

  const full = ikChain();
  solveTwoBoneIK(full.thigh, full.shin, full.foot, target, null, 1);
  const solved = full.foot.getWorldPosition(new THREE.Vector3());

  const rest = ikChain();
  const animated = rest.foot.getWorldPosition(new THREE.Vector3());

  const half = ikChain();
  solveTwoBoneIK(half.thigh, half.shin, half.foot, target, null, 0.5);
  const blended = half.foot.getWorldPosition(new THREE.Vector3());

  assert.ok(blended.distanceTo(animated) > 1e-3, "moved off the animated pose");
  assert.ok(blended.distanceTo(solved) > 1e-3, "but not all the way to the solve");
  const zero = ikChain();
  solveTwoBoneIK(zero.thigh, zero.shin, zero.foot, target, null, 0);
  near(zero.foot.getWorldPosition(new THREE.Vector3()).distanceTo(animated), 0, 1e-9, "weight 0 is a no-op");
});

await check("the pole vector decides which way the joint bends", () => {
  const base = ikChain();
  const origin = base.thigh.getWorldPosition(new THREE.Vector3());
  const target = origin.clone().add(new THREE.Vector3(0, -1.4, 0));

  const knees = [];
  for (const side of [1, -1]) {
    const rig = ikChain();
    const pole = origin.clone().add(new THREE.Vector3(side * 3, -0.7, 0));
    solveTwoBoneIK(rig.thigh, rig.shin, rig.foot, target, pole, 1);
    near(rig.foot.getWorldPosition(new THREE.Vector3()).distanceTo(target), 0, 1e-3, "still on target");
    knees.push(rig.shin.getWorldPosition(new THREE.Vector3()));
  }
  assert.ok(knees[0].x > 0.05, `knee follows the +X pole (got ${knees[0].x})`);
  assert.ok(knees[1].x < -0.05, `knee follows the -X pole (got ${knees[1].x})`);
});

await check("the solve is stable when re-run on its own output", () => {
  const rig = ikChain();
  const origin = rig.thigh.getWorldPosition(new THREE.Vector3());
  const target = origin.clone().add(new THREE.Vector3(0.5, -1.2, 0.2));
  const pole = origin.clone().add(new THREE.Vector3(0, -0.6, 3));
  let previous = null;
  for (let i = 0; i < 30; i++) {
    solveTwoBoneIK(rig.thigh, rig.shin, rig.foot, target, pole, 1);
    const knee = rig.shin.getWorldPosition(new THREE.Vector3());
    if (previous) near(knee.distanceTo(previous), 0, 1e-6, `frame ${i} jitter`);
    previous = knee;
  }
});

// ---------------------------------------------------------------------------

section("engine wiring");

await check("late-update callbacks run after update, in ascending order", () => {
  const engine = new Engine();
  const order = [];
  engine.onLateUpdate(() => order.push("attach"), 100);
  engine.onUpdate(() => order.push("update"));
  engine.onLateUpdate(() => order.push("ik"), 0);
  for (const fn of engine.updateCallbacks) fn(0.016);
  for (const entry of engine.lateUpdateCallbacks) entry.fn(0.016);
  assert.deepEqual(order, ["update", "ik", "attach"]);
});

await check("unsubscribing a late callback removes exactly it", () => {
  const engine = new Engine();
  const order = [];
  engine.onLateUpdate(() => order.push("a"), 0);
  const off = engine.onLateUpdate(() => order.push("b"), 0);
  engine.onLateUpdate(() => order.push("c"), 0);
  off();
  for (const entry of engine.lateUpdateCallbacks) entry.fn(0.016);
  assert.deepEqual(order, ["a", "c"], "ties keep insertion order too");
});

/** An entity carrying a fake-loaded model, so the components behave as if a GLB landed. */
function riggedEntity(engine, clips) {
  const entity = engine.createEntity({ name: "Character" });
  const rig = makeRig();
  const model = entity.addComponent("model", { path: "" });
  model.root = rig.armature;
  model.clips = clips;
  entity.object3D.add(rig.armature);
  return { entity, rig, model };
}

const tick = (engine, dt) => {
  for (const fn of engine.updateCallbacks) fn(dt);
  for (const entry of [...engine.lateUpdateCallbacks]) entry.fn(dt);
};

await check("the Animation component moves the entity while playing", () => {
  const engine = new Engine();
  const { entity } = riggedEntity(engine, walkClips());
  const anim = entity.addComponent("animation", { rootMotion: true, playInEditor: true });
  anim.applyGraph(rootMotionGraph("stride"));
  engine.playing = true;
  for (let i = 0; i < 30; i++) tick(engine, 1 / 60);
  near(entity.object3D.position.z, -1, 5e-3, "walked forward half a stride");
});

await check("...but never while merely previewing in the editor", () => {
  const engine = new Engine();
  const { entity, rig } = riggedEntity(engine, walkClips());
  const anim = entity.addComponent("animation", { rootMotion: true, playInEditor: true });
  anim.applyGraph(rootMotionGraph("stride"));
  engine.playing = false;
  for (let i = 0; i < 30; i++) tick(engine, 1 / 60);
  near(entity.object3D.position.length(), 0, 1e-9, "the entity stayed put");
  near(rig.hips.position.length(), 0, 1e-3, "and the preview still played in place");
});

await check("script-target root motion leaves the transform alone and hands over the delta", () => {
  const engine = new Engine();
  const { entity } = riggedEntity(engine, walkClips());
  const anim = entity.addComponent("animation", {
    rootMotion: true,
    rootMotionTarget: "script",
    playInEditor: true,
  });
  anim.applyGraph(rootMotionGraph("stride"));
  engine.playing = true;
  for (let i = 0; i < 30; i++) tick(engine, 1 / 60);
  near(entity.object3D.position.length(), 0, 1e-9, "transform untouched");
  near(anim.consumeRootMotion().position.z, -1, 5e-3, "the script gets it instead");
});

await check("the IK component corrects the pose after the animator, in the same frame", () => {
  const engine = new Engine();
  const rest = spin(X, 0);
  const clips = [new THREE.AnimationClip("stand", 1, [quatTrack("Thigh", [0, 1], [rest, rest])])];
  const { entity, rig } = riggedEntity(engine, clips);
  const anim = entity.addComponent("animation", { playInEditor: true });
  anim.applyGraph(rootMotionGraph("stand"));

  const targetEntity = engine.createEntity({ name: "FootTarget" });
  const animatedFoot = rig.foot.getWorldPosition(new THREE.Vector3());
  targetEntity.object3D.position.copy(animatedFoot).add(new THREE.Vector3(0.5, 0.3, 0));
  targetEntity.object3D.updateMatrixWorld(true);

  entity.addComponent("ik", { tipBone: "Foot", target: targetEntity.id, weight: 1 });
  tick(engine, 1 / 60);
  const solved = rig.foot.getWorldPosition(new THREE.Vector3());
  near(solved.distanceTo(targetEntity.object3D.position), 0, 1e-3, "foot reached the target");
});

await check("IK naming a bone without two parents above it warns instead of guessing", () => {
  const engine = new Engine();
  const { entity } = riggedEntity(engine, defaultClips());
  const warnings = [];
  const original = console.warn;
  console.warn = (m) => warnings.push(String(m));
  try {
    entity.addComponent("ik", { tipBone: "Hips", target: "", weight: 1 });
    tick(engine, 1 / 60);
    assert.ok(warnings.some((w) => w.includes("two bones above it")), "it says what's wrong");
  } finally {
    console.warn = original;
  }
});

console.log(failures ? `\n${failures} check(s) failed` : "\nall animation checks passed");
process.exit(failures ? 1 : 0);
