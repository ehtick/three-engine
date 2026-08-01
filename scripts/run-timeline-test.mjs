/**
 * Timeline / sequencer (roadmap item 10).
 *
 * The property this suite exists to defend is *determinism under scrubbing*: a
 * timeline is dragged backwards as often as it is played forwards, and the one
 * thing an author must be able to rely on is that the frame at t=2.0 looks the
 * same however the playhead got there. Almost every bug a sequencer can have —
 * an evaluator that remembers its last position, an event that re-fires on the
 * way back, an animation clip advanced by dt instead of set to a time — shows up
 * as "it looks different depending on how I got here", which is invisible in a
 * single forward playthrough and infuriating afterwards.
 *
 * The second property is *reversibility*: previewing a timeline in the editor
 * must leave the scene exactly as it found it. A preview that quietly rewrites
 * the light intensities and transforms it animated destroys the author's scene
 * by the act of looking at it.
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

const { Engine, registerBuiltInComponents } = await import("../src/engine/index.js");
const { setSceneLoader } = await import("../src/engine/assetResolver.js");
const {
  createTimeline,
  createTrack,
  createKey,
  createClipItem,
  normalizeTimeline,
  timelineExtent,
  collectTimelineAssets,
  trackLabel,
} = await import("../src/engine/timeline/timelineAsset.js");
const { evaluateKeys, interpolateValue, defaultValueFor } = await import(
  "../src/engine/timeline/curve.js"
);
const { TimelineRuntime } = await import("../src/engine/timeline/TimelineRuntime.js");
const { animatableProperties, readProperty, writeProperty } = await import(
  "../src/engine/timeline/propertyBinding.js"
);

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

/** Runs the engine's update stages without a renderer. */
const tick = (engine, dt) => {
  engine.deltaTime = dt;
  engine.unscaledDeltaTime = dt;
  for (const fn of engine.updateCallbacks) fn(dt);
  for (const entry of [...engine.lateUpdateCallbacks]) entry.fn(dt);
};

const keys = (...pairs) =>
  pairs.map(([t, v, patch]) => createKey(t, v, { interp: "linear", ...(patch ?? {}) }));

// ---------------------------------------------------------------------------

section("curves");

await check("linear keys interpolate and hold outside their range", () => {
  const k = keys([0, 0], [2, 10]);
  near(evaluateKeys(k, 1, "number"), 5, 1e-6, "midpoint");
  near(evaluateKeys(k, -5, "number"), 0, 1e-6, "before the first key holds it");
  near(evaluateKeys(k, 99, "number"), 10, 1e-6, "after the last key holds it");
  assert.equal(evaluateKeys([], 1, "number"), undefined, "no keys means no opinion");
});

await check("step keys hold until the next key", () => {
  const k = keys([0, 0, { interp: "step" }], [1, 1, { interp: "step" }]);
  assert.equal(evaluateKeys(k, 0.999, "number"), 0);
  assert.equal(evaluateKeys(k, 1, "number"), 1);
});

await check("booleans and text are stepped even when keyed as smooth", () => {
  // There is no halfway between true and false; a "smooth" boolean would
  // evaluate to 0.5 and every consumer would read that as true.
  const k = [createKey(0, false), createKey(1, true)];
  const normalized = normalizeTimeline({
    tracks: [{ kind: "property", valueType: "boolean", keys: k }],
  }).tracks[0];
  assert.equal(normalized.keys[0].interp, "step");
  assert.equal(evaluateKeys(normalized.keys, 0.5, "boolean"), false);
  assert.equal(evaluateKeys(normalized.keys, 1, "boolean"), true);
});

await check("smooth tangents are auto-CLAMPED, so a curve never overshoots", () => {
  // The bug this prevents: plain Catmull-Rom through 0 → 1 → 1 bulges past 1 in
  // the middle segment. On a door's "closed" key that means the door passes
  // through the frame before settling — visible, wrong, and unfixable by moving
  // keys around.
  const k = [
    createKey(0, 0, { interp: "smooth" }),
    createKey(1, 1, { interp: "smooth" }),
    createKey(2, 1, { interp: "smooth" }),
  ];
  for (let t = 0; t <= 2; t += 0.05) {
    const v = evaluateKeys(k, t, "number");
    assert.ok(v <= 1 + 1e-9, `overshoot at t=${t.toFixed(2)}: ${v}`);
    assert.ok(v >= -1e-9, `undershoot at t=${t.toFixed(2)}: ${v}`);
  }
  // ...and it is still a curve, not a straight line.
  assert.ok(evaluateKeys(k, 0.5, "number") !== 0.5, "smooth is not linear");
});

await check("smooth still eases a monotonic ramp", () => {
  const k = [
    createKey(0, 0, { interp: "smooth" }),
    createKey(1, 1, { interp: "smooth" }),
    createKey(2, 2, { interp: "smooth" }),
  ];
  // Evenly spaced monotonic keys → the auto tangent is the segment slope, so
  // this really is linear. What matters is that it is CONTINUOUS.
  near(evaluateKeys(k, 0.5, "number"), 0.5, 1e-6, "midpoint");
  near(evaluateKeys(k, 1.5, "number"), 1.5, 1e-6, "second segment");
});

await check("bezier honours explicit tangents on number tracks", () => {
  const flat = [
    createKey(0, 0, { interp: "bezier", outT: 0 }),
    createKey(1, 1, { interp: "bezier", inT: 0 }),
  ];
  // Zero tangents both ends = a classic ease-in-out: slow, then fast, then slow.
  near(evaluateKeys(flat, 0.5, "number"), 0.5, 1e-6, "symmetric midpoint");
  assert.ok(evaluateKeys(flat, 0.1, "number") < 0.1, "eases in");
  assert.ok(evaluateKeys(flat, 0.9, "number") > 0.9, "eases out");
});

await check("euler tracks take the short way around", () => {
  // 350° → 10° is a 20° turn, not a 340° spin backwards. This is the single
  // most common complaint about hand-keyed rotation.
  const k = keys([0, [0, 350, 0]], [1, [0, 10, 0]]);
  const mid = evaluateKeys(k, 0.5, "euler");
  const y = ((mid[1] % 360) + 360) % 360;
  near(y, 0, 1e-6, "midpoint sits at 0°, not 180°");
});

await check("colours interpolate through their channels", () => {
  const k = keys([0, "#000000"], [1, "#ffffff"]);
  assert.equal(evaluateKeys(k, 0.5, "color"), "#808080");
  assert.equal(interpolateValue("#ff0000", "#00ff00", 0.5, "color"), "#808000");
});

await check("evaluation is a pure function of time", () => {
  // Scrubbing backwards must land on the same value forward playback produced.
  // Any evaluator that caches "where I was last frame" fails this.
  const k = [
    createKey(0, 0, { interp: "smooth" }),
    createKey(1, 5, { interp: "smooth" }),
    createKey(2.5, -3, { interp: "bezier", inT: 2, outT: -1 }),
    createKey(4, 1, { interp: "linear" }),
  ];
  const times = Array.from({ length: 41 }, (_, i) => i * 0.1);
  const forward = times.map((t) => evaluateKeys(k, t, "number"));
  const backward = [...times].reverse().map((t) => evaluateKeys(k, t, "number")).reverse();
  for (let i = 0; i < forward.length; i++) {
    near(backward[i], forward[i], 1e-12, `t=${times[i].toFixed(1)}`);
  }
});

await check("defaults exist for every value type", () => {
  assert.deepEqual(defaultValueFor("vec3"), [0, 0, 0]);
  assert.equal(defaultValueFor("color"), "#ffffff");
  assert.equal(defaultValueFor("boolean"), false);
  assert.equal(defaultValueFor("number"), 0);
});

// ---------------------------------------------------------------------------

section("asset");

await check("normalize fills in defaults and sorts keys by time", () => {
  const t = normalizeTimeline({
    tracks: [{ kind: "property", keys: [{ t: 2, v: 1 }, { t: 0, v: 0 }] }],
  });
  assert.equal(t.version, 1);
  assert.equal(t.frameRate, 30);
  assert.deepEqual(t.tracks[0].keys.map((k) => k.t), [0, 2]);
  assert.equal(t.tracks[0].valueType, "number");
});

await check("duration grows to cover anything past the authored end", () => {
  // A clip dragged past the end must not be silently cut off — and a hand-edited
  // or imported file with a key at 12s and `duration: 5` is a real shape.
  const t = normalizeTimeline({
    duration: 5,
    tracks: [{ kind: "property", keys: [{ t: 12, v: 1 }] }],
  });
  assert.equal(t.duration, 12);
  assert.equal(timelineExtent(t), 12);
});

await check("audio assets are collectible for preloading", () => {
  const t = createTimeline({
    tracks: [
      createTrack("audio", {
        clips: [createClipItem(0, 1, { asset: "audio/line.ogg" }), createClipItem(2, 1, { asset: "" })],
      }),
      createTrack("property"),
    ],
  });
  assert.deepEqual(collectTimelineAssets(t), ["audio/line.ogg"]);
});

await check("a property track labels itself from what it drives", () => {
  const track = createTrack("property", { component: "light", property: "intensity" });
  assert.equal(trackLabel(track), "light.intensity");
  assert.equal(trackLabel(createTrack("property", { property: "position" })), "transform.position");
  assert.equal(trackLabel(createTrack("property", { name: "Fade" })), "Fade");
});

await check("animatable properties come from component schemas, not a list", () => {
  const props = animatableProperties("light");
  assert.ok(props.some((p) => p.key === "intensity" && p.valueType === "number"));
  assert.ok(props.some((p) => p.key === "color" && p.valueType === "color"));
  // Asset/entity references are identity, not magnitude — never keyable.
  assert.ok(!animatableProperties("animation").some((p) => p.key === "controller"));
  assert.ok(!animatableProperties("vcam").some((p) => p.key === "follow"));
  const transform = animatableProperties("");
  assert.deepEqual(transform.map((p) => p.key), ["position", "rotation", "scale"]);
  assert.equal(transform.find((p) => p.key === "rotation").valueType, "euler");
});

// ---------------------------------------------------------------------------

section("property tracks");

const sceneWithLight = () => {
  const engine = new Engine();
  const entity = engine.createEntity({ id: "lamp", name: "Lamp" });
  entity.addComponent("light", { type: "point", intensity: 2 });
  return { engine, entity };
};

await check("a property track drives a component prop", () => {
  const { engine, entity } = sceneWithLight();
  const timeline = createTimeline({
    duration: 2,
    tracks: [
      createTrack("property", {
        target: "lamp",
        component: "light",
        property: "intensity",
        keys: keys([0, 0], [2, 10]),
      }),
    ],
  });
  const runtime = new TimelineRuntime(engine, timeline);
  runtime.bind();
  runtime.sample(1);
  near(entity.getComponent("light").props.intensity, 5, 1e-6, "intensity at t=1");
  runtime.sample(2);
  near(entity.getComponent("light").props.intensity, 10, 1e-6, "intensity at the end");
});

await check("unbinding restores every value the timeline touched", () => {
  // The whole reason an editor can preview a cutscene without destroying the
  // scene. Without it, looking at a timeline permanently rewrites it.
  const { engine, entity } = sceneWithLight();
  entity.position = [1, 2, 3];
  const timeline = createTimeline({
    duration: 2,
    tracks: [
      createTrack("property", {
        target: "lamp",
        component: "light",
        property: "intensity",
        keys: keys([0, 0], [2, 10]),
      }),
      createTrack("property", {
        target: "lamp",
        property: "position",
        valueType: "vec3",
        keys: keys([0, [0, 0, 0]], [2, [20, 0, 0]]),
      }),
    ],
  });
  const runtime = new TimelineRuntime(engine, timeline);
  runtime.bind();
  runtime.sample(1);
  near(entity.object3D.position.x, 10, 1e-6, "moved while bound");
  runtime.unbind();
  near(entity.getComponent("light").props.intensity, 2, 1e-6, "intensity restored");
  assert.deepEqual(entity.object3D.position.toArray(), [1, 2, 3], "transform restored");
});

await check("rotation tracks are authored in degrees and applied in radians", () => {
  // Recording degrees and playing radians looks like the animation running 57×
  // too fast, not like a unit mismatch — so both ends go through one accessor.
  const engine = new Engine();
  const entity = engine.createEntity({ id: "door", name: "Door" });
  entity.object3D.rotation.set(0, Math.PI / 2, 0);
  assert.deepEqual(
    readProperty(entity, "", "rotation", "euler").map((v) => Math.round(v)),
    [0, 90, 0],
    "read back as degrees",
  );
  writeProperty(entity, "", "rotation", [0, 180, 0], "euler");
  near(entity.object3D.rotation.y, Math.PI, 1e-6, "written as radians");
});

await check("a track pointing at a missing entity is inert, not fatal", () => {
  const engine = new Engine();
  const timeline = createTimeline({
    duration: 1,
    tracks: [
      createTrack("property", {
        target: "does-not-exist",
        component: "light",
        property: "intensity",
        keys: keys([0, 0], [1, 1]),
      }),
    ],
  });
  const runtime = new TimelineRuntime(engine, timeline);
  runtime.bind();
  runtime.sample(0.5);
  runtime.unbind();
});

await check("a muted track writes nothing", () => {
  const { engine, entity } = sceneWithLight();
  const timeline = createTimeline({
    duration: 2,
    tracks: [
      createTrack("property", {
        target: "lamp",
        component: "light",
        property: "intensity",
        muted: true,
        keys: keys([0, 0], [2, 10]),
      }),
    ],
  });
  const runtime = new TimelineRuntime(engine, timeline);
  runtime.bind();
  runtime.sample(1);
  near(entity.getComponent("light").props.intensity, 2, 1e-6, "untouched");
});

// ---------------------------------------------------------------------------

section("activation tracks");

await check("an activation range switches the entity on and off", () => {
  const engine = new Engine();
  const entity = engine.createEntity({ id: "ghost", name: "Ghost" });
  const timeline = createTimeline({
    duration: 4,
    tracks: [createTrack("activation", { target: "ghost", clips: [createClipItem(1, 2)] })],
  });
  const runtime = new TimelineRuntime(engine, timeline);
  runtime.bind();
  runtime.sample(0.5);
  assert.equal(entity.enabledInGame, false, "before the range");
  runtime.sample(2);
  assert.equal(entity.enabledInGame, true, "inside it");
  runtime.sample(3);
  assert.equal(entity.enabledInGame, false, "the range is half-open at its end");
  runtime.unbind();
  assert.equal(entity.enabledInGame, true, "restored to how it was authored");
});

// ---------------------------------------------------------------------------

section("animation tracks");

await check("binding hands the rig to the timeline and unbinding gives it back", () => {
  // Two things writing the same bones is how you get a character that twitches
  // between two poses. While an animation track is bound, the state machine
  // stands down — including in the gaps between clips, so an empty stretch of
  // track doesn't play whatever the animator felt like.
  const engine = new Engine();
  const entity = engine.createEntity({ id: "hero", name: "Hero" });
  entity.addComponent("animation", {});
  const animator = entity.getComponent("animation");
  assert.equal(animator.enabled, true);
  const runtime = new TimelineRuntime(
    engine,
    createTimeline({
      duration: 2,
      tracks: [
        createTrack("animation", {
          target: "hero",
          clips: [createClipItem(0, 2, { clip: "Run" })],
        }),
      ],
    }),
  );
  runtime.bind();
  assert.equal(animator.enabled, false, "suspended while the timeline owns the rig");
  runtime.sample(1); // no model loaded — must be a no-op, not a throw
  runtime.unbind();
  assert.equal(animator.enabled, true, "handed back, and the user's own flag is intact");
});

// ---------------------------------------------------------------------------

section("camera shot tracks");

const cameraScene = () => {
  const engine = new Engine();
  const brainEntity = engine.createEntity({ id: "cam", name: "Camera" });
  brainEntity.addComponent("camera", {});
  const wide = engine.createEntity({ id: "wide", name: "Wide" });
  wide.addComponent("vcam", { priority: 100 });
  const close = engine.createEntity({ id: "close", name: "Close" });
  close.addComponent("vcam", { priority: 1 });
  return {
    engine,
    brain: brainEntity.getComponent("camera"),
    wide: wide.getComponent("vcam"),
    close: close.getComponent("vcam"),
  };
};

await check("a shot outranks a higher authored priority while it is under the playhead", () => {
  // A cutscene cutting to a shot is stating what the audience sees. Losing that
  // fight to whichever gameplay camera happens to sit at priority 100 would make
  // shot tracks useless in exactly the scenes they exist for.
  const { engine, brain, wide, close } = cameraScene();
  assert.equal(brain.pickVirtualCamera(engine), wide, "priority wins by default");
  const runtime = new TimelineRuntime(
    engine,
    createTimeline({
      duration: 4,
      tracks: [
        createTrack("camera", {
          clips: [createClipItem(1, 2, { vcam: "close", blend: 0.75 })],
        }),
      ],
    }),
  );
  runtime.bind();
  runtime.sample(0.5);
  assert.equal(brain.pickVirtualCamera(engine), wide, "outside the shot, priority again");
  runtime.sample(2);
  assert.equal(brain.pickVirtualCamera(engine), close, "the shot takes over");
  assert.equal(close.timelineBlend, 0.75, "the cut carries its own blend time");
  runtime.sample(3.5);
  assert.equal(brain.pickVirtualCamera(engine), wide, "and hands control back");
  runtime.unbind();
  assert.equal(close.timelineShot, false, "no shot flag survives the unbind");
});

await check("a bound shot track previews in the editor, and stops previewing after", () => {
  const { engine, brain } = cameraScene();
  assert.ok(!brain.timelinePreview, "off to begin with");
  const runtime = new TimelineRuntime(
    engine,
    createTimeline({
      tracks: [createTrack("camera", { clips: [createClipItem(0, 1, { vcam: "close" })] })],
    }),
  );
  runtime.bind();
  assert.equal(brain.timelinePreview, true, "the brain runs so the shot is visible");
  runtime.unbind();
  assert.equal(brain.timelinePreview, false, "and is put back — a preview must not persist");
});

// ---------------------------------------------------------------------------

section("event markers");

const eventScene = () => {
  const engine = new Engine();
  const entity = engine.createEntity({ id: "fx", name: "FX" });
  const fired = [];
  engine.on("timeline-event", (e) => fired.push({ method: e.method, time: e.time }));
  const timeline = createTimeline({
    duration: 4,
    tracks: [
      createTrack("event", {
        target: "fx",
        keys: [
          { id: "m0", t: 0, method: "onStartMarker", arg: "" },
          { id: "m1", t: 1, method: "boom", arg: "big" },
          { id: "m2", t: 3, method: "flash", arg: "" },
        ],
      }),
    ],
  });
  const runtime = new TimelineRuntime(engine, timeline);
  runtime.bind();
  return { engine, entity, runtime, fired };
};

await check("markers fire once, when the playhead crosses them", () => {
  const { runtime, fired } = eventScene();
  runtime.fireBetween(0, 0.5, { includeStart: true });
  assert.deepEqual(fired.map((f) => f.method), ["onStartMarker"], "a marker at 0 is reachable");
  runtime.fireBetween(0.5, 1.5);
  assert.deepEqual(fired.map((f) => f.method), ["onStartMarker", "boom"]);
  runtime.fireBetween(1.5, 2.5);
  assert.equal(fired.length, 2, "nothing new in an empty stretch");
});

await check("scrubbing backwards fires nothing", () => {
  // The playhead going back over 'explode' forty times must not detonate forty
  // times — which is what a naive "did we pass it?" test does.
  const { runtime, fired } = eventScene();
  runtime.fireBetween(0, 3.5, { includeStart: true });
  const count = fired.length;
  runtime.fireBetween(3.5, 0);
  assert.equal(fired.length, count, "a backwards interval is not an interval");
});

await check("a loop wrap fires the tail and then the head, in order", () => {
  // Firing the wrap as one (from, to] interval skips every marker after `from` —
  // the end of the loop, which is exactly where they usually are.
  const { runtime, fired } = eventScene();
  runtime.fireBetween(2.5, 4);
  runtime.fireBetween(0, 0.2, { includeStart: true });
  assert.deepEqual(fired.map((f) => f.method), ["flash", "onStartMarker"]);
});

await check("markers reach the target entity's scripts", () => {
  const { engine, entity, runtime, fired } = eventScene();
  const seen = [];
  entity.addComponent("script", {});
  // Stand in for a loaded script module: `dispatch` walks live instances.
  const script = entity.getComponent("script");
  script.dispatch = (hook, ...args) => seen.push([hook, ...args]);
  runtime.fireBetween(0.5, 1.5);
  assert.deepEqual(seen, [["boom", "big"]], "dispatched with its argument");
  assert.equal(fired.length, 1, "and still announced on the engine bus");
});

// ---------------------------------------------------------------------------

section("director");

const directorScene = ({ props = {}, timeline } = {}) => {
  const engine = new Engine();
  const lamp = engine.createEntity({ id: "lamp", name: "Lamp" });
  lamp.addComponent("light", { type: "point", intensity: 2 });
  const host = engine.createEntity({ id: "host", name: "Director" });
  host.addComponent("timeline", { asset: "", playOnStart: true, ...props });
  const director = host.getComponent("timeline");
  director.applyTimeline(
    timeline ??
      createTimeline({
        duration: 2,
        tracks: [
          createTrack("property", {
            target: "lamp",
            component: "light",
            property: "intensity",
            keys: keys([0, 0], [2, 10]),
          }),
        ],
      }),
  );
  return { engine, lamp, host, director };
};

await check("play on start runs the sequence and advances with the frame", () => {
  const { engine, lamp, director } = directorScene();
  engine.setPlaying(true);
  assert.equal(director.isPlaying, true);
  tick(engine, 1);
  near(director.time, 1, 1e-6, "playhead");
  near(lamp.getComponent("light").props.intensity, 5, 1e-6, "and the scene follows it");
});

await check("speed scales the playhead", () => {
  const { engine, director } = directorScene({ props: { speed: 2 } });
  engine.setPlaying(true);
  tick(engine, 0.5);
  near(director.time, 1, 1e-6, "half a second at 2× is one second of timeline");
});

await check("wrapMode 'once' reverts what it animated; 'hold' keeps the last frame", () => {
  // A door that swings open wants hold. A camera-shake overlay wants its
  // transform back. Same asset, different director.
  const once = directorScene({ props: { wrapMode: "once" } });
  once.engine.setPlaying(true);
  tick(once.engine, 3);
  assert.equal(once.director.isPlaying, false, "finished");
  near(once.lamp.getComponent("light").props.intensity, 2, 1e-6, "reverted to the authored value");

  const hold = directorScene({ props: { wrapMode: "hold" } });
  hold.engine.setPlaying(true);
  tick(hold.engine, 3);
  assert.equal(hold.director.isPlaying, false, "also finished");
  near(hold.lamp.getComponent("light").props.intensity, 10, 1e-6, "left at the final frame");
});

await check("wrapMode 'loop' wraps the playhead and keeps going", () => {
  const { engine, director } = directorScene({ props: { wrapMode: "loop" } });
  engine.setPlaying(true);
  tick(engine, 1.5);
  tick(engine, 1);
  near(director.time, 0.5, 1e-6, "2.5s into a 2s timeline is 0.5s");
  assert.equal(director.isPlaying, true, "still running");
});

await check("wrapMode 'pingPong' turns around at both ends", () => {
  const { engine, director } = directorScene({ props: { wrapMode: "pingPong" } });
  engine.setPlaying(true);
  tick(engine, 1.5);
  tick(engine, 1);
  near(director.time, 1.5, 1e-6, "bounced off the end");
  tick(engine, 1);
  near(director.time, 0.5, 1e-6, "still travelling back");
  tick(engine, 1);
  near(director.time, 0.5, 1e-6, "bounced off the start");
});

await check("finishing announces itself", () => {
  const { engine, director } = directorScene();
  let finished = 0;
  engine.on("timeline-finished", () => finished++);
  engine.setPlaying(true);
  tick(engine, 3);
  assert.equal(finished, 1);
  tick(engine, 3);
  assert.equal(finished, 1, "and only once");
  assert.equal(director.time, 2, "the playhead rests at the end it reached");
  director.play();
  assert.equal(director.time, 0, "and play() rewinds it");
});

await check("stopping the game reverts the scene", () => {
  const { engine, lamp } = directorScene();
  engine.setPlaying(true);
  tick(engine, 1);
  near(lamp.getComponent("light").props.intensity, 5, 1e-6, "animated");
  engine.setPlaying(false);
  near(lamp.getComponent("light").props.intensity, 2, 1e-6, "and back to how the author left it");
});

await check("pause freezes the playhead, resume carries on", () => {
  const { engine, director } = directorScene();
  engine.setPlaying(true);
  tick(engine, 0.5);
  director.pause();
  tick(engine, 1);
  near(director.time, 0.5, 1e-6, "frozen");
  director.resume();
  tick(engine, 0.5);
  near(director.time, 1, 1e-6, "resumed from where it was");
});

await check("a script can scrub the director by hand", () => {
  const { lamp, director } = directorScene({ props: { playOnStart: false } });
  director.evaluate(1.5);
  near(lamp.getComponent("light").props.intensity, 7.5, 1e-6, "posed without playing");
  assert.equal(director.isPlaying, false);
  director.stop();
  near(lamp.getComponent("light").props.intensity, 2, 1e-6, "stop reverts");
});

await check("unscaled update mode keeps a cutscene running through a pause", () => {
  // A pause-menu camera move or a "time stopped" ability: the game clock is
  // zero, the sequence still has to play.
  const scaled = directorScene();
  const unscaled = directorScene({ props: { updateMode: "unscaled" } });
  for (const s of [scaled, unscaled]) s.engine.setPlaying(true);
  // Paused: the engine hands update callbacks dt = 0 but leaves
  // unscaledDeltaTime alone.
  scaled.engine.deltaTime = 0;
  scaled.engine.unscaledDeltaTime = 0.5;
  for (const fn of scaled.engine.updateCallbacks) fn(0);
  unscaled.engine.deltaTime = 0;
  unscaled.engine.unscaledDeltaTime = 0.5;
  for (const fn of unscaled.engine.updateCallbacks) fn(0);
  near(scaled.director.time, 0, 1e-6, "game time froze the sequence");
  near(unscaled.director.time, 0.5, 1e-6, "wall clock did not");
});

await check("track targets resolve override → track → the director's own entity", () => {
  const engine = new Engine();
  const a = engine.createEntity({ id: "a", name: "A" });
  const b = engine.createEntity({ id: "b", name: "B" });
  const host = engine.createEntity({ id: "host", name: "Director" });
  host.addComponent("timeline", { bindings: { "track-1": "b" } });
  const director = host.getComponent("timeline");
  assert.equal(director.resolveTrackTarget({ id: "track-1", target: "a" }), b, "override wins");
  assert.equal(director.resolveTrackTarget({ id: "track-2", target: "a" }), a, "then the track");
  assert.equal(
    director.resolveTrackTarget({ id: "track-3", target: "" }),
    host,
    "and a track with no target drives the director's own entity",
  );
});

await check("bindings make one asset drive two objects", () => {
  // The reuse case: the same "open" sequence on twelve doors, without twelve
  // copies of the file.
  const engine = new Engine();
  for (const id of ["doorA", "doorB"]) {
    const door = engine.createEntity({ id, name: id });
    door.addComponent("light", { type: "point", intensity: 0 });
  }
  const timeline = createTimeline({
    duration: 2,
    tracks: [
      createTrack("property", {
        id: "t1",
        target: "doorA",
        component: "light",
        property: "intensity",
        keys: keys([0, 0], [2, 10]),
      }),
    ],
  });
  const hostB = engine.createEntity({ id: "hb", name: "B Director" });
  hostB.addComponent("timeline", { bindings: { t1: "doorB" } });
  hostB.getComponent("timeline").applyTimeline(timeline);
  hostB.getComponent("timeline").evaluate(2);
  near(engine.getEntity("doorB").getComponent("light").props.intensity, 10, 1e-6, "bound copy moved");
  near(engine.getEntity("doorA").getComponent("light").props.intensity, 0, 1e-6, "the original did not");
});

// ---------------------------------------------------------------------------

section("scene integration");

setSceneLoader(async () => ({
  version: 1,
  name: "Cutscene",
  entities: [
    {
      id: "host",
      name: "Director",
      components: [{ type: "timeline", props: { asset: "", bindings: { t1: "lamp" } } }],
      children: [
        { id: "lamp", name: "Lamp", components: [{ type: "light", props: { type: "point" } }] },
      ],
    },
  ],
}));

await check("an additive load rewires binding maps to its own copy", () => {
  // The entity-reference remap already covers plain `type: "entity"` props. A
  // binding table is the same problem one level down, and its failure mode is
  // the worst kind: the second copy of a cutscene animates the FIRST copy's
  // objects, so the scene you are looking at does nothing.
  const engine = new Engine();
  return engine
    .loadScene("scenes/Cutscene.scene")
    .then(() => engine.loadScene("scenes/Cutscene.scene", { mode: "additive" }))
    .then(() => {
      const directors = [...engine.entities.values()]
        .filter((e) => e.getComponent("timeline"))
        .map((e) => e.getComponent("timeline"));
      assert.equal(directors.length, 2, "both directors exist");
      for (const director of directors) {
        const bound = director.props.bindings.t1;
        assert.equal(
          director.entity.children[0].id,
          bound,
          "each director is bound to its OWN lamp",
        );
      }
      assert.notEqual(
        directors[0].props.bindings.t1,
        directors[1].props.bindings.t1,
        "and the two don't share one",
      );
    });
});

// ---------------------------------------------------------------------------

console.log(`\n${failures === 0 ? "all timeline checks passed" : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
