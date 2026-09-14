import test from "node:test";
import assert from "node:assert/strict";
import { featureRandom, resolveFeatureEdits, stableFeatureId } from "../src/engine/world/featureEdits.js";

const feature = (id, props = {}, position = [0, 0, 0]) => ({
  id, kind: "tree", name: "Oak", position, props: { tint: "green", height: 8, ...props },
});
const edit = (kind, target, values = {}) => ({ id: `${kind}-${target}`, kind, target, ...values });
const override = (target, property, value, id = `override-${target}`) => edit("override", target, { id, property, value });
const byId = (features) => Object.fromEntries(features.map((value) => [value.id, value]));
const freeze = (value) => {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};

test("generation changes preserve hand edits without freezing inherited properties", () => {
  const operations = [
    override("roof-a", "material.tint", "red"),
    edit("transform", "oak-a", { position: [4, 2, -8], rotation: [0, Math.PI / 2, 0], scale: [2, 2, 2], space: "world" }),
    edit("suppress", "oak-b"),
    { id: "place-rock", kind: "add", feature: feature("authored-rock", { tint: "gray" }, [8, 0, 4]) },
  ];
  const initial = [feature("roof-a", { material: { tint: "brown", roughness: 0.8 } }), feature("oak-a"), feature("oak-b")];
  const regenerated = [feature("oak-b"), feature("new-oak"), feature("roof-a", { material: { tint: "blue", roughness: 0.4 } }), feature("oak-a", { height: 11 }, [10, 0, 10])];
  const first = byId(resolveFeatureEdits(initial, operations).features);
  const result = resolveFeatureEdits(regenerated, operations);
  const after = byId(result.features);
  assert.equal(first["roof-a"].props.material.tint, "red");
  assert.deepEqual(after["roof-a"].props.material, { tint: "red", roughness: 0.4 });
  assert.deepEqual(after["oak-a"].position, [4, 2, -8]);
  assert.deepEqual(after["oak-a"].scale, [2, 2, 2]);
  assert.equal(after["oak-a"].props.height, 11);
  assert.equal(after["oak-b"], undefined);
  assert.deepEqual(after["authored-rock"], first["authored-rock"]);
  assert.deepEqual(result.orphanEdits, []);
});

test("same-name features cannot steal edits when generation is reordered", () => {
  const source = [feature("oak-a"), feature("oak-b"), feature("oak-c")];
  const edits = [override("oak-b", "tint", "gold")];
  const expected = byId(resolveFeatureEdits(source, edits).features);
  const reordered = [feature("new-oak"), source[2], source[0], source[1]];
  const actual = byId(resolveFeatureEdits(reordered, edits).features);
  for (const value of source) assert.deepEqual(actual[value.id], expected[value.id]);
  assert.equal(actual["new-oak"].props.tint, "green");

  // Negative controls model the two historical failure modes: rebuilding the
  // generated branch and remembering the selected object's array index.
  const survived = (values) => byId(values)["oak-b"].props.tint === "gold";
  const oldBranchReplacement = structuredClone(reordered);
  const oldIndexOverride = structuredClone(reordered);
  oldIndexOverride[1].props.tint = "gold";
  assert.equal(survived(oldBranchReplacement), false);
  assert.equal(survived(oldIndexOverride), false);
  assert.equal(survived(Object.values(actual)), true);
});

test("missing targets retain overrides, transforms and tombstones until they return", () => {
  const operations = [override("gone-roof", "tint", "red"), edit("transform", "gone-tree", { position: [4, 0, 0] }), edit("suppress", "gone-rock")];
  const nearby = [feature("replacement-roof"), feature("replacement-tree")];
  const absent = resolveFeatureEdits(nearby, operations);
  assert.deepEqual(absent.features, nearby);
  assert.deepEqual(absent.orphanEdits, operations);
  const returned = resolveFeatureEdits([feature("gone-roof"), feature("gone-tree"), feature("gone-rock")], JSON.parse(JSON.stringify(operations)));
  assert.equal(byId(returned.features)["gone-roof"].props.tint, "red");
  assert.deepEqual(byId(returned.features)["gone-tree"].position, [4, 0, 0]);
  assert.equal(byId(returned.features)["gone-rock"], undefined);
  assert.deepEqual(returned.orphanEdits, []);
});

test("missing property paths become orphaned instead of inventing generator schema", () => {
  const operation = override("oak", "material.tint", "red");
  const original = feature("oak");
  assert.deepEqual(resolveFeatureEdits([original], [operation]), { features: [original], orphanEdits: [operation] });
  const compatible = feature("oak", { material: { tint: "green" } });
  assert.equal(resolveFeatureEdits([compatible], [operation]).features[0].props.material.tint, "red");
});

test("pin snapshots freeze selected aspects and remain visible when topology disappears", () => {
  const snapshot = feature("oak", { material: { tint: "gold", roughness: 0.7 }, height: 7 }, [3, 1, 4]);
  const operation = edit("pin", "oak", { snapshot, aspects: ["placement", "props.material"] });
  const regenerated = feature("oak", { material: { tint: "green", roughness: 0.3 }, height: 12 }, [-2, 0, -8]);
  regenerated.space = "attachment";
  regenerated.attachment = { target: "new-terrain", offset: 2 };
  const actual = resolveFeatureEdits([regenerated], [operation]);
  assert.deepEqual(actual.features[0].position, snapshot.position);
  assert.deepEqual(actual.features[0].props.material, snapshot.props.material);
  assert.equal(actual.features[0].props.height, 12);
  assert.equal(Object.hasOwn(actual.features[0], "space"), false);
  assert.equal(Object.hasOwn(actual.features[0], "attachment"), false);
  assert.deepEqual(actual.orphanEdits, []);
  const absent = resolveFeatureEdits([], [operation]);
  assert.deepEqual(absent.features, [snapshot]);
  assert.deepEqual(absent.orphanEdits, [operation]);
  assert.deepEqual(resolveFeatureEdits([regenerated], [edit("pin", "oak", { snapshot, aspects: ["complete"] })]).features, [snapshot]);
});

test("pin path conflicts are atomic and cannot cross feature kinds", () => {
  const snapshot = feature("oak", { material: { tint: "gold" } }, [3, 0, 0]);
  const operation = edit("pin", "oak", { snapshot, aspects: ["placement", "props.material"] });
  const current = feature("oak", {}, [8, 0, 0]);
  assert.deepEqual(resolveFeatureEdits([current], [operation]), { features: [current], orphanEdits: [operation] });
  const changedKind = { ...snapshot, kind: "building", position: [9, 0, 0] };
  assert.deepEqual(resolveFeatureEdits([changedKind], [operation]), { features: [changedKind], orphanEdits: [operation] });
});

test("ordered edits, reset, undo, redo and JSON reload have identical results", () => {
  const source = [feature("oak")];
  const lower = override("oak", "tint", "red", "base-pass");
  const upper = override("oak", "tint", "gold", "art-pass");
  const move = edit("transform", "oak", { position: [3, 2, 1] });
  const resolved = resolveFeatureEdits(source, [lower, upper, move]);
  assert.equal(resolved.features[0].props.tint, "gold");
  const resetUpper = resolveFeatureEdits(source, [lower, move]);
  assert.equal(resetUpper.features[0].props.tint, "red");
  assert.deepEqual(resetUpper.features[0].position, [3, 2, 1]);
  assert.deepEqual(resolveFeatureEdits(source, [lower, upper, move]), resolved);
  const restored = JSON.parse(JSON.stringify({ source, operations: [lower, upper, move] }));
  assert.deepEqual(resolveFeatureEdits(restored.source, restored.operations), resolved);
  assert.deepEqual(resolveFeatureEdits(source, []).features, source);
  assert.deepEqual(resolveFeatureEdits(source, [lower, edit("suppress", "oak")]).features, []);
});

test("authored additions can be edited without modifying their stored baseline", () => {
  const authored = feature("hand-oak");
  const addition = { id: "place", kind: "add", feature: authored };
  const actual = resolveFeatureEdits([], [addition, override("hand-oak", "tint", "gold")]);
  assert.equal(actual.features[0].props.tint, "gold");
  assert.equal(authored.props.tint, "green");
  assert.deepEqual(resolveFeatureEdits([], [addition]).features, [authored]);
});

test("resolver accepts frozen inputs and returns fully independent data", () => {
  const source = freeze([feature("oak", { material: { tint: "green" } })]);
  const operations = freeze([override("oak", "material", { tint: "gold" }), override("absent", "tint", { nested: [1, 2] })]);
  const sourceReceipt = JSON.stringify(source);
  const editsReceipt = JSON.stringify(operations);
  const first = resolveFeatureEdits(source, operations);
  first.features[0].props.material.tint = "blue";
  first.features[0].position[0] = 100;
  first.orphanEdits[0].value.nested[0] = 100;
  assert.equal(JSON.stringify(source), sourceReceipt);
  assert.equal(JSON.stringify(operations), editsReceipt);
  assert.equal(resolveFeatureEdits(source, operations).features[0].props.material.tint, "gold");
});

test("explicit anchoring retains relative edits and can return to world space", () => {
  const source = feature("oak");
  const attach = edit("transform", "oak", { id: "attach", space: "attachment", attachment: { target: "terrain-a", offset: 1.5 }, position: [2, 0, 3] });
  const move = edit("transform", "oak", { id: "move", position: [5, 0, 3] });
  const relative = resolveFeatureEdits([source], [attach, move]).features[0];
  assert.equal(relative.space, "attachment");
  assert.deepEqual(relative.attachment, attach.attachment);
  assert.deepEqual(relative.position, move.position);
  const world = resolveFeatureEdits([relative], [edit("transform", "oak", { space: "world", position: [9, 2, 8] })]).features[0];
  assert.equal(world.space, "world");
  assert.equal(Object.hasOwn(world, "attachment"), false);
  assert.throws(() => resolveFeatureEdits([source], [edit("transform", "oak", { space: "attachment" })]), /requires an attachment/);
});

test("retargeting an attachment always declares its coordinate space", () => {
  const world = feature("oak");
  const attached = { ...world, space: "attachment", attachment: { target: "old-ground" } };
  const implicit = edit("transform", "oak", { attachment: { target: "new-ground" } });
  for (const source of [[], [world], [attached]]) {
    assert.throws(() => resolveFeatureEdits(source, [implicit]), /requires explicit attachment space/);
  }
  const explicit = { ...implicit, space: "attachment" };
  for (const source of [world, attached]) {
    const result = resolveFeatureEdits([source], [explicit]);
    assert.equal(result.features[0].space, "attachment");
    assert.deepEqual(result.features[0].attachment, { target: "new-ground" });
    assert.deepEqual(result.orphanEdits, []);
  }
  assert.deepEqual(resolveFeatureEdits([], [explicit]).orphanEdits, [explicit]);
});

test("duplicate IDs fail even if an earlier suppression would hide a collision", () => {
  assert.throws(() => resolveFeatureEdits([feature("oak"), feature("oak")], []), /Duplicate feature ID/);
  const same = override("oak", "tint", "red");
  assert.throws(() => resolveFeatureEdits([feature("oak")], [same, same]), /Duplicate operation ID/);
  assert.throws(() => resolveFeatureEdits([feature("oak")], [edit("suppress", "oak"), { id: "add", kind: "add", feature: feature("oak") }]), /Duplicate feature ID/);
  assert.throws(() => resolveFeatureEdits([], [{ id: "a", kind: "add", feature: feature("oak") }, { id: "b", kind: "add", feature: feature("oak") }]), /Duplicate feature ID/);
});

test("invalid paths, accessors and prototype pollution fail without side effects", () => {
  const source = [feature("oak")];
  for (const path of ["", ".tint", "tint.", "tint..name", "__proto__.polluted", "constructor.prototype.polluted", ["prototype"], ["tint", 0]]) {
    assert.throws(() => resolveFeatureEdits(source, [override("oak", path, true)]), /safe nonempty property path/);
  }
  const malicious = JSON.parse('{"__proto__":{"polluted":true}}');
  assert.throws(() => resolveFeatureEdits(source, [override("oak", "tint", malicious)]), /unsafe property/);
  assert.equal({}.polluted, undefined);
  let invoked = false;
  const accessor = { get tint() { invoked = true; return "blue"; } };
  assert.throws(() => resolveFeatureEdits([feature("oak", { accessor })], []), /data properties/);
  assert.equal(invoked, false);
  const inherited = Object.create({ tint: "blue" });
  assert.throws(() => resolveFeatureEdits([feature("oak", { inherited })], []), /plain JSON/);
});

test("array path segments select literal keys but never mutable array indices", () => {
  const source = feature("oak", { "material.tint": "green", palette: ["green", "brown"] });
  const result = resolveFeatureEdits([source], [override("oak", ["material.tint"], "gold"), override("oak", "palette.0", "red", "bad-index")]);
  assert.equal(result.features[0].props["material.tint"], "gold");
  assert.deepEqual(result.features[0].props.palette, source.props.palette);
  assert.deepEqual(result.orphanEdits.map((value) => value.id), ["bad-index"]);
});

test("invalid and nonserializable data cannot become a different world after reload", () => {
  for (const bad of [NaN, Infinity, -Infinity, undefined, () => 0, 4n, new Date(), new Map()]) {
    assert.throws(() => resolveFeatureEdits([feature("oak", { bad })], []), /JSON/);
  }
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => resolveFeatureEdits([feature("oak", { cyclic })], []), /acyclic JSON/);
  for (const sparse of [new Array(2), [, 1], [1, ,]]) {
    assert.throws(() => resolveFeatureEdits([feature("oak", { sparse })], []), /sparse arrays/);
  }
  for (const position of [[1, 2], [1, 2, 3, 4], [1, "2", 3], [1, Infinity, 3]]) {
    assert.throws(() => resolveFeatureEdits([], [edit("transform", "absent", { position })]), /finite/);
  }
  assert.throws(() => resolveFeatureEdits([], [edit("pin", "oak", { snapshot: feature("different"), aspects: ["placement"] })]), /snapshot ID differs/);
  assert.throws(() => resolveFeatureEdits([], [edit("pin", "oak", { snapshot: feature("oak"), aspects: ["position"] })]), /transforms via placement/);
  assert.throws(() => resolveFeatureEdits([], [edit("pin", "oak", { snapshot: feature("oak"), aspects: ["props.missing"] })]), /snapshot lacks aspect/);
  assert.throws(() => resolveFeatureEdits([], [edit("pin", "oak", { snapshot: feature("oak"), aspects: [] })]), /nonempty array/);
  assert.throws(() => resolveFeatureEdits([], [edit("reset", "oak")]), /unsupported kind/);
});

test("semantic IDs and named randomness survive reordering and unrelated samples", () => {
  const a = stableFeatureId("forest", "cell-3-8", "candidate-72");
  const b = stableFeatureId("forest", "cell-3-8", "candidate-73");
  assert.notEqual(a, b);
  assert.notEqual(stableFeatureId("a", "b/c"), stableFeatureId("a/b", "c"));
  const sample = (ids) => Object.fromEntries(ids.map((id) => [id, featureRandom(1842, id, "placement")]));
  const before = sample([a, b]);
  const after = sample(["unrelated", b, a]);
  assert.equal(after[a], before[a]);
  assert.equal(after[b], before[b]);
  featureRandom(1842, a, "appearance");
  assert.equal(featureRandom(1842, a, "placement"), before[a]);
  assert.notEqual(featureRandom(1842, a, "appearance"), before[a]);
  assert.notEqual(featureRandom(1843, a, "placement"), before[a]);
  assert.notEqual(featureRandom("1842", a, "placement"), before[a]);
  for (let i = 0; i < 1000; i++) {
    const value = featureRandom(i, a, "growth");
    assert.ok(value >= 0 && value < 1);
  }
  assert.throws(() => stableFeatureId("forest"), /persistent key/);
  assert.throws(() => featureRandom(NaN, a, "growth"), /Seed/);
});
