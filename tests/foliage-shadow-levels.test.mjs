import test from "node:test";
import assert from "node:assert/strict";
import { foliageShadowTierRule } from "../src/engine/clipmapShadowCache.js";

// 09-14 owner: shadows everywhere, lower LOD further away, smooth transitions,
// never impostor-only near the viewer ("looks very bad, static, inaccurate").
// Each clipmap level draws a FIXED foliage LOD; the clipmap's own coverage
// blend between levels is the transition.
const table = (levels) => Array.from({ length: levels }, (_, level) =>
  [0, 1, 2].map((tier) => foliageShadowTierRule(tier, level, levels)));

test("four levels: near forced, mid forced, mid+impostor, impostor", () => {
  assert.deepEqual(table(4), [
    ["force", null, null],
    [null, "force", null],
    [null, "natural", "natural"],
    [null, null, "natural"],
  ]);
});

test("three levels: the outermost still hands mid over to impostors", () => {
  assert.deepEqual(table(3), [
    ["force", null, null],
    [null, "force", null],
    [null, "natural", "natural"],
  ]);
});

test("two levels: near in the finest, the rest by per-plant crossfade", () => {
  assert.deepEqual(table(2), [
    ["force", null, null],
    [null, "natural", "natural"],
  ]);
});

test("every level draws at least one foliage tier, and the finest never draws impostors", () => {
  for (const levels of [2, 3, 4]) {
    for (const row of table(levels)) assert.ok(row.some(Boolean), `levels ${levels}: a level with no foliage caster`);
    assert.equal(table(levels)[0][2], null);
  }
});

test("non-foliage casters are always drawn", () => {
  assert.equal(foliageShadowTierRule(undefined, 0, 4), "natural");
});
