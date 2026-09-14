import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { normalizeArchitectureModel, getArchitectureFormFootprint, architectureFormBounds } from "../src/modules/architecture/formModel.js";
import { buildArchitectureFormGeometry } from "../src/modules/architecture/formGeometry.js";

const form = (id, position = [0, 0, 0], options = {}) => ({ id, position, size: [3, 3, 3], roof: "hip", windows: false, ...options });
const near = (actual, expected, tolerance = 1e-4) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
function scene(model) {
  const built = buildArchitectureFormGeometry(model), mesh = new THREE.Mesh(built.geometry, material);
  mesh.updateMatrixWorld();
  return { ...built, mesh, hits(origin, direction, far = Infinity) { return new THREE.Raycaster(new THREE.Vector3(...origin), new THREE.Vector3(...direction), 0, far).intersectObject(mesh, false); } };
}
function surfaceArea(built, predicate) {
  const { geometry } = built, p = geometry.attributes.position, index = geometry.index, a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  let sum = 0;
  for (const surface of built.surfaces.filter(predicate)) for (let i = surface.start; i < surface.start + surface.count; i += 3) {
    a.fromBufferAttribute(p, index.getX(i)); b.fromBufferAttribute(p, index.getX(i + 1)); c.fromBufferAttribute(p, index.getX(i + 2));
    sum += b.sub(a).cross(c.sub(a)).length() / 2;
  }
  return sum;
}

test("adjacent forms become a hollow exterior union and deleting the neighbor restores the wall", () => {
  const model = { forms: [form("left"), form("right", [3, 0, 0])] };
  const joined = scene(model);
  near(joined.hits([0, 1, 0], [1, 0, 0])[0].point.x, 4.3);
  assert.equal(joined.hits([0, 1, 0], [1, 0, 0], 2).length, 0, "shared wall blocks the joined room");
  const removed = scene({ forms: [model.forms[0]] });
  near(removed.hits([0, 1, 0], [1, 0, 0])[0].point.x, 1.3);
  assert.ok(joined.stats.vertices < removed.stats.vertices * 2, "joining should eliminate geometry");
  joined.geometry.dispose(); removed.geometry.dispose();
});

test("overlap has one exterior facade with no coplanar duplicate faces or hidden dividing wall", () => {
  const built = scene({ forms: [form("first"), form("overlap", [2, 0, 0])] });
  near(built.hits([0, 1, 0], [1, 0, 0])[0].point.x, 3.3);
  near(surfaceArea(built, surface => surface.kind === "wall" && !surface.interior && surface.normal[2] < -.999), 5 * 3);
  const identical = scene({ forms: [form("first"), form("duplicate")] });
  assert.equal(identical.surfaces.filter(surface => surface.formId === "duplicate").length, 0);
  built.geometry.dispose(); identical.geometry.dispose();
});

test("stacking removes the buried hip roof and the intervening internal floor", () => {
  const built = scene({ forms: [form("lower"), form("upper", [0, 3, 0])] });
  assert.equal(built.surfaces.filter(surface => surface.formId === "lower" && surface.kind === "roof").length, 0);
  assert.equal(built.surfaces.filter(surface => surface.formId === "upper" && surface.kind === "floor").length, 0);
  near(built.hits([0, 10, 0], [0, -1, 0])[0].point.y, 7.2);
  assert.equal(built.hits([0, 2.9, 0], [0, 1, 0], 1).length, 0, "stacked bodies should connect through the old roof");
  assert.equal(built.surfaces.filter(surface => surface.formId === "upper" && surface.kind === "support").length, 0, "posts buried in the lower body must disappear");
  built.geometry.dispose();
});

test("partially covered roofs remain only over the exposed part of the lower body", () => {
  const built = scene({ forms: [form("lower", [0, 0, 0], { size: [8, 3, 6] }), form("upper", [0, 3, 0], { size: [3, 3, 3] })] });
  const p = built.geometry.attributes.position, index = built.geometry.index;
  for (const surface of built.surfaces.filter(s => s.formId === "lower" && s.kind === "roof" && !s.interior)) {
    for (let i = surface.start; i < surface.start + surface.count; i += 3) {
      const center = [0, 0, 0];
      for (let corner = 0; corner < 3; corner++) { const vertex = index.getX(i + corner); center[0] += p.getX(vertex) / 3; center[2] += p.getZ(vertex) / 3; }
      assert.ok(Math.abs(center[0]) >= 1.5 - 1e-4 || Math.abs(center[2]) >= 1.5 - 1e-4, "buried roof triangle survives under the upper volume");
    }
  }
  assert.ok(built.surfaces.some(s => s.formId === "lower" && s.kind === "roof"));
  built.geometry.dispose();
});

test("hip roofs slope to their eaves and circular bodies have conical roofs and round footprints", () => {
  const hip = scene({ forms: [form("hip")] });
  near(hip.hits([0, 10, 0], [0, -1, 0])[0].point.y, 4.2);
  near(hip.hits([1.2, 10, 0], [0, -1, 0])[0].point.y, 3.24);
  const round = scene({ forms: [form("tower", [0, 0, 0], { shape: "round", size: [6, 5, 6], roofHeight: 2 })] });
  assert.equal(round.hits([2.9, 10, 2.9], [0, -1, 0]).length, 0, "round volume must not retain box corners");
  near(round.hits([0, 10, 0], [0, -1, 0])[0].point.y, 7);
  assert.equal(getArchitectureFormFootprint(normalizeArchitectureModel({ forms: [form("circle", [0, 0, 0], { shape: "round" })] }).forms[0]).length, 24);
  hip.geometry.dispose(); round.geometry.dispose();
});

test("manual windows cut both skins while keeping the far wall and space above and below the hole", () => {
  const built = scene({ forms: [form("house")], openings: [{ id: "window", formId: "house", position: [0, 1.5, -1.5], normal: [0, 0, -1], width: 1, height: 1, kind: "window" }] });
  assert.equal(built.hits([0, 1.5, -3], [0, 0, 1], 2).length, 0);
  near(built.hits([0, 1.5, -3], [0, 0, 1])[0].point.z, 1.3);
  assert.ok(built.hits([0, .7, -3], [0, 0, 1], 2).length);
  assert.ok(built.hits([0, 2.3, -3], [0, 0, 1], 2).length);
  built.geometry.dispose();
});

test("doorways reach the walkable base and arches have an actual curved head", () => {
  for (const kind of ["door", "arch"]) {
    const built = scene({ forms: [form("house")], openings: [{ id: "gate", formId: "house", position: [0, 1.1, -1.5], normal: [0, 0, -1], width: 1.6, height: 2.2, kind }] });
    assert.equal(built.hits([0, .05, -3], [0, 0, 1], 2).length, 0, `${kind} has a threshold blocker`);
    assert.equal(built.hits([0, 2, -3], [0, 0, 1], 2).length, 0);
    if (kind === "arch") assert.ok(built.hits([.7, 2, -3], [0, 0, 1], 2).length, "arch corner should retain its curved masonry");
    else assert.equal(built.hits([.7, 2, -3], [0, 0, 1], 2).length, 0);
    built.geometry.dispose();
  }
});

test("openings follow yawed and round walls using the model-local surface normal", () => {
  const yaw = Math.PI / 4, n = [-Math.sin(yaw), 0, -Math.cos(yaw)], center = n.map(value => value * 1.5); center[1] = 1.4;
  const rotated = scene({ forms: [form("rotated", [0, 0, 0], { rotationY: yaw })], openings: [{ id: "opening", formId: "rotated", position: center, normal: n, width: 1, height: 1, kind: "window" }] });
  assert.equal(rotated.hits(center.map((value, i) => value + n[i] * 1.5), n.map(value => -value), 2).length, 0);
  const round = scene({ forms: [form("round", [0, 0, 0], { shape: "round", size: [6, 4, 6] })], openings: [{ id: "opening", formId: "round", position: [0, 1.5, -3], normal: [0, 0, -1], width: 1.5, height: 1.2, kind: "window" }] });
  assert.equal(round.hits([.5, 1.5, -5], [0, 0, 1], 2.5).length, 0);
  rotated.geometry.dispose(); round.geometry.dispose();
});

test("paths open a continuous passage through both walls and leave the wall beside the route", () => {
  const model = { forms: [form("hall", [0, 0, 0], { size: [6, 4, 6] })], paths: [{ id: "walk", points: [[0, -5], [0, 5]], width: 2, elevation: 0 }] };
  const built = scene(model);
  assert.equal(built.hits([0, 1, -5], [0, 0, 1], 10).length, 0, "path must remove entry and exit walls");
  assert.ok(built.hits([1.5, 1, -5], [0, 0, 1], 3).length);
  assert.ok(built.surfaces.some(s => s.kind === "path" && s.pathId === "walk"));
  const removed = scene({ forms: model.forms });
  assert.ok(removed.hits([0, 1, -5], [0, 0, 1], 3).length, "removing a path should reseal the wall");
  built.geometry.dispose(); removed.geometry.dispose();
});

test("automatic windows are real and adapt after changing the form height", () => {
  const first = scene({ forms: [form("auto", [0, 0, 0], { windows: true })] });
  assert.equal(first.hits([0, 1.65, -3], [0, 0, 1], 2).length, 0);
  assert.ok(first.hits([0, .5, -3], [0, 0, 1], 2).length);
  const tall = scene({ forms: [form("auto", [0, 0, 0], { windows: true, size: [3, 6, 3] })] });
  assert.equal(tall.hits([0, 4.65, -3], [0, 0, 1], 2).length, 0);
  first.geometry.dispose(); tall.geometry.dispose();
});

test("raised bodies receive visible posts and changed neighboring bodies invalidate cached supports", () => {
  const upper = form("raised", [0, 4, 0], { size: [4, 3, 4] });
  const open = scene({ forms: [upper] });
  assert.ok(open.surfaces.some(s => s.kind === "support"));
  assert.ok(open.hits([-1.6, 1, -4], [0, 0, 1], 3).length);
  const covered = scene({ forms: [upper, form("base", [0, 0, 0], { size: [4, 2, 4], roof: "none" })] });
  const p = covered.geometry.attributes.position, index = covered.geometry.index;
  for (const surface of covered.surfaces.filter(s => s.kind === "support")) for (let i = surface.start; i < surface.start + surface.count; i++) assert.ok(p.getY(index.getX(i)) >= 2 - 1e-4, "support remains buried in changed neighbor");
  open.geometry.dispose(); covered.geometry.dispose();
});

test("path cuts leave closed support ends rather than hollow open post tubes", () => {
  const built = scene({ forms: [form("raised", [0, 4, 0], { size: [4, 3, 4] })], paths: [{ id: "underpass", points: [[-1.6, -4], [-1.6, 4]], width: 1, elevation: 0 }] });
  const hit = built.hits([-1.6, 1, -1.6], [0, 1, 0])[0];
  near(hit.point.y, 2.4);
  const surface = built.surfaces.find(s => hit.faceIndex * 3 >= s.start && hit.faceIndex * 3 < s.start + s.count);
  assert.equal(surface.kind, "support"); assert.equal(surface.cap, true); assert.ok(surface.normal[1] < -.99);
  built.geometry.dispose();
});

test("surface picking survives material batching, with exact triangle-index coverage and outward normals", () => {
  const built = scene({ forms: [form("red", [-2, 0, 0], { color: "#cc9977" }), form("blue", [2, 0, 0], { color: "#7799bb" })] });
  let cursor = 0;
  for (const surface of built.surfaces) { assert.equal(surface.start, cursor); assert.equal(surface.count % 3, 0); cursor += surface.count; assert.ok(surface.normal.every(Number.isFinite)); }
  assert.equal(cursor, built.geometry.index.count);
  assert.ok(built.geometry.groups.length <= built.materials.length, "one draw call per material");
  assert.equal(built.geometry.userData.architectureSurfaceRanges, built.surfaces);
  for (const x of [-2, 2]) {
    const hit = built.hits([x, 1, -4], [0, 0, 1])[0], triangle = hit.faceIndex * 3;
    const picked = built.surfaces.find(surface => triangle >= surface.start && triangle < surface.start + surface.count);
    assert.equal(picked.formId, x < 0 ? "red" : "blue"); assert.equal(picked.face, "north"); assert.equal(picked.kind, "wall");
  }
  built.geometry.dispose();
});

test("bounded normalization rejects ambiguous IDs, strips orphan apertures, and never mutates inputs", () => {
  const source = { forms: [form("a", [NaN, Infinity, -Infinity], { size: [Infinity, -20, 1e20] })], openings: [{ formId: "missing" }] };
  const before = structuredClone(source), normalized = normalizeArchitectureModel(source);
  assert.deepEqual(source, before); assert.ok(normalized.forms[0].position.every(Number.isFinite)); assert.deepEqual(normalized.forms[0].size, [3, .3, 500]);
  assert.equal(normalized.openings.length, 0);
  assert.throws(() => normalizeArchitectureModel({ forms: Array.from({ length: 257 }, (_, i) => form(String(i))) }), /256/);
  assert.throws(() => normalizeArchitectureModel({ forms: [form("a"), form("a")] }), /unique/);
  assert.throws(() => normalizeArchitectureModel({ paths: [{ id: "path", points: [[0, 0], [1, 1]] }, { id: "path", points: [[0, 0], [2, 2]] }] }), /unique/);
  const empty = scene({}); assert.equal(empty.stats.vertices, 0); assert.ok(empty.geometry.boundingBox.min.toArray().every(Number.isFinite)); empty.geometry.dispose();
});

test("256-form towns stay bounded, deterministic and reuse unchanged geometry during local edits", () => {
  const forms = Array.from({ length: 256 }, (_, i) => form(`town-${i}`, [(i % 16) * 3, 0, Math.floor(i / 16) * 3], { windows: true }));
  const first = buildArchitectureFormGeometry({ forms }), second = buildArchitectureFormGeometry({ forms });
  assert.deepEqual(second.geometry.attributes.position.array, first.geometry.attributes.position.array);
  assert.deepEqual(second.geometry.index.array, first.geometry.index.array);
  assert.deepEqual(second.surfaces, first.surfaces); assert.equal(second.stats.reusedForms, 256);
  assert.ok(first.stats.vertices < 600000);
  forms[128] = { ...forms[128], color: "#aa7744" };
  const edited = buildArchitectureFormGeometry({ forms }); assert.equal(edited.stats.reusedForms, 255);
  first.geometry.dispose(); second.geometry.dispose(); edited.geometry.dispose();
});

test("gable roofs ridge along the resolved axis, close with wall gable ends and take roofColor", () => {
  // Wider than deep, yet the ridge runs along Z: the explicit axis wins over
  // the long-axis heuristic. Eave at size[1], apex at +roofHeight, like hip.
  const barn = scene({ forms: [form("barn", [0, 0, 0], { size: [8, 4, 6], roof: "gable", roofAxis: "z", roofHeight: 2, roofColor: "#7a2f2a", color: "#ddc7a5" })] });
  near(barn.hits([0, 10, 0], [0, -1, 0])[0].point.y, 6, 1e-3);
  near(barn.hits([.01, 10, 2.9], [0, -1, 0])[0].point.y, 5.995, 1e-3);
  near(barn.hits([3.9, 10, 0], [0, -1, 0])[0].point.y, 4.05, 1e-3);
  assert.equal(barn.hits([4.2, 10, 0], [0, -1, 0], 6).length, 0, "no roof beyond the eave");
  // The gable end is a vertical wall-coloured triangle closing the prism.
  const end = barn.hits([0, 5, 10], [0, 0, -1])[0];
  near(end.point.z, 3, 1e-3);
  const surface = barn.surfaces.find(s => end.faceIndex * 3 >= s.start && end.faceIndex * 3 < s.start + s.count);
  assert.equal(surface.kind, "wall"); assert.ok(Math.abs(surface.normal[2]) > .999);
  const roles = Object.fromEntries(barn.materials.map((descriptor, index) => [index, descriptor]));
  const groupAt = s => barn.geometry.groups.find(g => s.start >= g.start && s.start < g.start + g.count);
  assert.equal(roles[groupAt(surface).materialIndex].color, "#ddc7a5", "gable ends take the wall colour");
  assert.equal(roles[groupAt(barn.surfaces.find(s => s.kind === "roof" && !s.interior)).materialIndex].color, "#7a2f2a", "roofColor lands on the slopes");
  // The heuristic still follows the longer horizontal axis when no axis is given.
  const heuristic = scene({ forms: [form("long", [0, 0, 0], { size: [8, 4, 6], roof: "gable", roofHeight: 2 })] });
  near(heuristic.hits([0, 10, 0], [0, -1, 0])[0].point.y, 6, 1e-3);
  near(heuristic.hits([0, 10, 2.9], [0, -1, 0])[0].point.y, 4.0667, 1e-3);
  near(heuristic.hits([-3.9, 5, 0], [-1, 0, 0])[0].point.x, -4, 1e-3, "x-ridge gable ends face ±X");
  // A buried gable roof is clipped away like a buried hip roof.
  const stacked = scene({ forms: [form("lower", [0, 0, 0], { size: [8, 4, 6], roof: "gable", roofAxis: "z", roofHeight: 2 }), form("upper", [0, 4, 0], { size: [8, 3, 6] })] });
  assert.equal(stacked.surfaces.filter(s => s.formId === "lower" && s.kind === "roof").length, 0);
  barn.geometry.dispose(); heuristic.geometry.dispose(); stacked.geometry.dispose();
});

test("gable normalization validates roofAxis and roofColor, and bounds include the rise", () => {
  const model = normalizeArchitectureModel({ forms: [form("cottage", [1, 2, 3], { size: [8, 4, 6], roof: "gable", roofAxis: "z", roofColor: "#7a2f2a", roofHeight: 2 })] });
  assert.equal(model.forms[0].roof, "gable"); assert.equal(model.forms[0].roofAxis, "z"); assert.equal(model.forms[0].roofColor, "#7a2f2a");
  const fallback = normalizeArchitectureModel({ forms: [form("cottage", [0, 0, 0], { roof: "gable", roofAxis: "y", roofColor: "red" })] }).forms[0];
  assert.equal(fallback.roofAxis, null); assert.equal(fallback.roofColor, null);
  assert.deepEqual(architectureFormBounds(model.forms[0]).max, [5, 8, 6], "gable bounds reach the ridge");
  assert.deepEqual(architectureFormBounds(model.forms[0], false).max, [5, 6, 6]);
});
