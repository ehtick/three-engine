/**
 * Headless checks over the UI system's pure logic: layout, the SDF glyph
 * pipeline, focus navigation scoring, and tweening.
 *
 * The parts that need a GPU (nine-slice UV remapping, SDF sharpness, world
 * panels) are covered by `npm run smoke:ui`, which reads real pixels back.
 *
 * Usage: npm run test:ui
 */
import {
  computeElementRect,
  computeScreenScale,
  layoutChildren,
  clampScroll,
  intersectRects,
  rectContains,
  applyAnchorPreset,
  ELEMENT_DEFAULTS,
} from "../src/engine/ui/layout.js";
import {
  edt1d,
  coverageToSdf,
  wrapText,
  layoutGlyphs,
  outlineToField,
  SDF_EDGE,
} from "../src/engine/ui/sdfFont.js";
import { pickNeighbour, toDirection } from "../src/engine/ui/uiFocus.js";
import { Tween, TweenSystem, EASINGS } from "../src/engine/tween.js";
import { screenMode } from "../src/engine/ui/UiSystem.js";

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}   ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};
const eq = (name, actual, expected) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}`);
const near = (name, actual, expected, tol = 1e-6) =>
  check(name, Math.abs(actual - expected) <= tol, `got ${actual}, want ${expected}`);

// --- Layout ------------------------------------------------------------------
console.log("\nLayout");
{
  const parent = { x: 0, y: 0, w: 800, h: 600 };
  const spec = (o) => ({ ...ELEMENT_DEFAULTS, ...o });

  eq(
    "a top-left anchored element sits where its pos says",
    computeElementRect(parent, spec({ anchorMin: [0, 0], anchorMax: [0, 0], pivot: [0, 0], pos: [10, 20], size: [100, 50] })),
    { x: 10, y: 20, w: 100, h: 50 },
  );
  eq(
    "a centred element is offset by its pivot",
    computeElementRect(parent, spec({ anchorMin: [0.5, 0.5], anchorMax: [0.5, 0.5], pivot: [0.5, 0.5], pos: [0, 0], size: [100, 50] })),
    { x: 350, y: 275, w: 100, h: 50 },
  );
  eq(
    "a stretched element uses pos/size as insets",
    computeElementRect(parent, spec({ anchorMin: [0, 0], anchorMax: [1, 1], pos: [20, 10], size: [40, 30] })),
    { x: 20, y: 10, w: 740, h: 560 },
  );

  near("fit takes the smaller scale", computeScreenScale("fit", 1280, 720, 1280, 1440), 1);
  near("fill takes the larger scale", computeScreenScale("fill", 1280, 720, 1280, 1440), 2);
  near("width pins the width", computeScreenScale("width", 1280, 720, 640, 999), 0.5);
  near("none never scales", computeScreenScale("none", 1280, 720, 640, 480), 1);

  const row = layoutChildren({ x: 0, y: 0, w: 300, h: 100 }, { direction: "row", gap: 10, padding: 0, justify: "start" }, [[50, 20], [50, 20]]);
  eq("a row lays children out left to right with the gap", [row.rects[0].x, row.rects[1].x], [0, 60]);
  near("and reports its content extent", row.contentMain, 110);
  const padded = layoutChildren({ x: 0, y: 0, w: 300, h: 100 }, { direction: "row", gap: 10, padding: 20 }, [[50, 20]]);
  near("padding insets the first child", padded.rects[0].x, 20);
  const centred = layoutChildren({ x: 0, y: 0, w: 300, h: 100 }, { direction: "row", gap: 0, padding: 0, justify: "center" }, [[100, 20]]);
  near("justify centre centres the run", centred.rects[0].x, 100);

  near("scroll clamps to the content extent", clampScroll(999, 500, 200), 300);
  near("and never goes negative when content fits", clampScroll(-50, 100, 200), 0);
  eq("rect intersection", intersectRects({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }), { x: 5, y: 5, w: 5, h: 5 });
  check("rectContains is inclusive of the top-left edge", rectContains({ x: 0, y: 0, w: 10, h: 10 }, 0, 0));
  check("and exclusive past the far edge", !rectContains({ x: 0, y: 0, w: 10, h: 10 }, 10.1, 5));
  check("an anchor preset produces a usable spec", !!applyAnchorPreset("bottom-right", [100, 40]).anchorMin);
}

// --- SDF generation ----------------------------------------------------------
console.log("\nSDF glyph pipeline");
{
  // Reference case for the 1-D transform: distances from the single zero.
  const f = new Float64Array([1e20, 1e20, 0, 1e20, 1e20]);
  const d = new Float64Array(5);
  edt1d(f, d, new Int16Array(5), new Float64Array(6), 5);
  eq("the 1-D distance transform is exact", [...d], [4, 1, 0, 1, 4]);

  // A 5×5 block with a filled centre: the field must fall off monotonically.
  const w = 5;
  const cov = new Float64Array(w * w);
  cov[2 * w + 2] = 1;
  const sdf = coverageToSdf(cov, w, w, { radius: 2, cutoff: 0.25 });
  const at = (x, y) => sdf[y * w + x];
  check("the field peaks inside the glyph", at(2, 2) === 255, String(at(2, 2)));
  check("and falls off outward", at(2, 2) > at(2, 1) && at(2, 1) > at(2, 0), `${at(2, 2)} ${at(2, 1)} ${at(2, 0)}`);
  check("symmetrically", at(1, 2) === at(3, 2) && at(2, 1) === at(2, 3));

  // The edge constant is load-bearing: get it wrong and every glyph in the
  // engine comes out uniformly too fat or too thin.
  const half = new Float64Array(w * w).fill(0);
  for (let y = 0; y < w; y++) for (let x = 0; x < 3; x++) half[y * w + x] = 1;
  const edgeField = coverageToSdf(half, w, w, { radius: 4, cutoff: 0.25 });
  // Column 2 is the last covered one, so the boundary sits between 2 and 3 and
  // the encoded value there should straddle the documented edge.
  const inside = edgeField[2 * w + 2] / 255;
  const outside = edgeField[2 * w + 3] / 255;
  check(
    "the glyph edge lands on SDF_EDGE, not 0.5",
    inside >= SDF_EDGE && outside < SDF_EDGE,
    `inside ${inside.toFixed(3)}, outside ${outside.toFixed(3)}, edge ${SDF_EDGE}`,
  );

  const empty = coverageToSdf(new Float64Array(9), 3, 3, { radius: 2 });
  check("an empty bitmap is entirely outside", [...empty].every((v) => v < SDF_EDGE * 255));
}

console.log("\nText wrapping");
{
  const measure = (s) => s.length * 10; // 10 px per character
  eq("wraps on spaces", wrapText("aaa bbb ccc", 70, measure), ["aaa bbb", "ccc"]);
  eq("honours explicit newlines", wrapText("a\nb", 1000, measure), ["a", "b"]);
  eq("wrapping off returns the paragraphs untouched", wrapText("aaa bbb", 10, measure, false), ["aaa bbb"]);
  // A single word longer than the line must break, not vanish under the clip.
  eq("breaks a word that cannot fit on any line", wrapText("aaaaaa", 30, measure), ["aaa", "aaa"]);
  eq("empty text is one empty line", wrapText("", 100, measure), [""]);

  // layoutGlyphs against a stub font — the geometry maths, without a canvas.
  const font = {
    ascent: 0.8,
    descent: 0.2,
    advance: () => 0.5, // every glyph is half an em wide
    glyph: (ch) => (ch === " " ? null : { advance: 0.5, x: 0, top: 0.8, w: 0.5, h: 1, u0: 0, v0: 0, u1: 1, v1: 1 }),
  };
  const style = { text: "ab", fontSize: 20, lineHeight: 1, align: "left", valign: "top", wrap: false };
  const left = layoutGlyphs(font, 200, 100, style);
  eq("one quad per inked glyph", left.quads.length, 2);
  near("advances accumulate", left.quads[1].x - left.quads[0].x, 10);
  near("and the measured width matches", left.width, 20);

  const centred = layoutGlyphs(font, 200, 100, { ...style, align: "center" });
  near("centre alignment offsets by half the slack", centred.quads[0].x, 90);
  const right = layoutGlyphs(font, 200, 100, { ...style, align: "right" });
  near("right alignment pushes to the far edge", right.quads[0].x, 180);

  const bottom = layoutGlyphs(font, 200, 100, { ...style, valign: "bottom", text: "a" });
  const top = layoutGlyphs(font, 200, 100, { ...style, valign: "top", text: "a" });
  check("bottom alignment sits below top alignment", bottom.quads[0].y > top.quads[0].y, `${bottom.quads[0].y} vs ${top.quads[0].y}`);

  eq("a space produces no quad but still advances", layoutGlyphs(font, 200, 100, { ...style, text: "a b" }).quads.length, 2);

  // Outline width is authored in UI px but consumed in field units.
  near("no outline is no field", outlineToField(0, 16), 0);
  check("a bigger font needs less field for the same pixels", outlineToField(2, 32) < outlineToField(2, 16));
  check("an absurd outline is clamped rather than saturating to nothing", outlineToField(999, 16) < SDF_EDGE);
}

// --- Focus navigation --------------------------------------------------------
console.log("\nFocus navigation");
{
  const rect = (x, y, w = 100, h = 40) => ({ x, y, w, h });
  const button = (name, r) => ({ button: name, rect: r });
  const from = rect(0, 0);

  const column = [button("b", rect(0, 60)), button("c", rect(0, 120))];
  eq("Down picks the nearest item below", pickNeighbour(from, column, { x: 0, y: 1 })?.button, "b");
  eq("Up from the top finds nothing", pickNeighbour(from, column, { x: 0, y: -1 }), null);

  // The case a plain nearest-distance search gets wrong.
  const grid = [
    button("right", rect(120, 0)),
    button("diagonal", rect(105, 30)), // closer by straight distance
  ];
  eq(
    "Right prefers the item beside you over a nearer diagonal",
    pickNeighbour(from, grid, { x: 1, y: 0 })?.button,
    "right",
  );

  eq("an item exactly beside but behind is excluded", pickNeighbour(rect(200, 0), [button("a", rect(0, 0))], { x: 1, y: 0 }), null);
  eq("no candidates is null, not a throw", pickNeighbour(from, [], { x: 0, y: 1 }), null);

  // Stick → direction, with the y flip between input space and UI space.
  eq("stick up is UI up", toDirection(0, 1), { x: 0, y: -1 });
  eq("stick down is UI down", toDirection(0, -1), { x: 0, y: 1 });
  eq("stick left", toDirection(-1, 0), { x: -1, y: 0 });
  eq("a resting stick is no direction", toDirection(0.1, -0.2), null);
  eq("a diagonal snaps to its dominant axis", toDirection(0.9, 0.6), { x: 1, y: 0 });
}

// --- Render mode -------------------------------------------------------------
console.log("\nScreen render mode");
{
  const screen = (renderMode) => ({ props: { renderMode } });
  // In the player there is no editor, so a screen-space canvas is always the
  // overlay the player sees.
  eq("a world screen is always a panel", screenMode(screen("world"), { playing: false }), "world");
  eq("outside the editor a screen canvas is an overlay", screenMode(screen("screen"), { playing: false }), "overlay");
  eq("while playing it is an overlay", screenMode(screen("screen"), { playing: true }), "overlay");
  eq(
    "the preview toggle forces the overlay",
    screenMode(screen("screen"), { playing: false }, { overlayPreview: true }),
    "overlay",
  );
}

// --- Tweening ----------------------------------------------------------------
console.log("\nTweening");
{
  const run = (tween, steps, dt = 0.1) => {
    for (let i = 0; i < steps; i++) tween.tick(dt);
  };

  const target = { x: 0 };
  const system = new TweenSystem();
  const t = system.add(new Tween(system, target, { x: 10 }, { duration: 1, ease: "linear" }));
  run(t, 5);
  near("linear easing is proportional", target.x, 5, 1e-9);
  run(t, 5);
  near("it lands exactly on the target value", target.x, 10, 1e-9);
  check("and reports itself done", t.done);
  check("and leaves the system", system.tweens.size === 0, String(system.tweens.size));

  // Dotted paths, which is how anything useful gets animated.
  const nested = { object3D: { position: { x: 1, y: 2 } } };
  const t2 = new Tween(null, nested, { "object3D.position.y": 10 }, { duration: 1, ease: "linear" });
  run(t2, 5);
  near("a dotted path animates the nested value", nested.object3D.position.y, 6);
  near("and leaves its siblings alone", nested.object3D.position.x, 1);

  const t3 = new Tween(null, { a: 0 }, { a: 1 }, { duration: 1, delay: 0.5, ease: "linear" });
  run(t3, 5);
  near("a delayed tween has not started", t3.target.a, 0);
  run(t3, 5);
  // 0.5s of the 1s duration has elapsed once the delay is paid off.
  near("and picks up exactly where the delay ended", t3.target.a, 0.5, 1e-9);

  // Start values are captured on the first tick, not at construction.
  const late = { v: 0 };
  const t4 = new Tween(null, late, { v: 10 }, { duration: 1, ease: "linear" });
  late.v = 100;
  t4.tick(0.5);
  near("the start value is whatever the object held when it began", late.v, 55);

  const yoyo = { v: 0 };
  const t5 = new Tween(null, yoyo, { v: 10 }, { duration: 1, ease: "linear", loop: 1, yoyo: true });
  run(t5, 15);
  near("a yoyo comes back", yoyo.v, 5, 1e-9);

  const forever = new TweenSystem();
  const t6 = forever.add(new Tween(forever, { v: 0 }, { v: 1 }, { duration: 0.5, loop: -1 }));
  run(t6, 30);
  check("an infinite loop never completes", !t6.done);

  let completed = 0;
  const t7 = new Tween(null, { v: 0 }, { v: 1 }, { duration: 1, onComplete: () => completed++ });
  t7.complete();
  near("complete() jumps to the end", t7.target.v, 1);
  eq("and fires onComplete once", completed, 1);
  t7.complete();
  eq("calling it again does nothing", completed, 1);

  const t8 = new Tween(null, { v: 0 }, { v: 1 }, { duration: 1 });
  t8.tick(0.5);
  const held = t8.target.v;
  t8.cancel();
  t8.tick(0.5);
  near("a cancelled tween stops where it was", t8.target.v, held);

  // Game time vs wall clock — a pause menu animating its own fade must not
  // freeze halfway through the pause it is announcing.
  const paused = new TweenSystem();
  const scaled = paused.add(new Tween(paused, { v: 0 }, { v: 1 }, { duration: 1, ease: "linear" }));
  const unscaled = paused.add(new Tween(paused, { v: 0 }, { v: 1 }, { duration: 1, ease: "linear", unscaled: true }));
  paused.update(0, 0.5); // game time frozen, wall clock still running
  near("a normal tween is frozen by a pause", scaled.target.v, 0);
  near("an unscaled tween keeps going", unscaled.target.v, 0.5, 1e-9);

  const zero = new Tween(null, { v: 0 }, { v: 7 }, { duration: 0 });
  zero.tick(0.016);
  near("a zero-duration tween is a setter, not a NaN", zero.target.v, 7);

  check("every easing starts at 0 and ends at 1", Object.entries(EASINGS).every(([, fn]) => Math.abs(fn(0)) < 1e-6 && Math.abs(fn(1) - 1) < 1e-6), Object.entries(EASINGS).filter(([, fn]) => Math.abs(fn(0)) > 1e-6 || Math.abs(fn(1) - 1) > 1e-6).map(([n]) => n).join(", "));
  check("backOut overshoots (that is the point)", EASINGS.backOut(0.7) > 1);

  const bulk = new TweenSystem();
  const shared = { v: 0 };
  bulk.add(new Tween(bulk, shared, { v: 1 }, { duration: 1 }));
  bulk.add(new Tween(bulk, shared, { v: 2 }, { duration: 1 }));
  bulk.cancelOf(shared);
  eq("cancelOf drops every tween on a target", bulk.tweens.size, 0);
}

console.log(`\nUI-TEST ${fail ? "FAIL" : "PASS"} — ${pass}/${pass + fail} checks`);
process.exit(fail ? 1 : 0);
