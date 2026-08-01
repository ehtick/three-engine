/**
 * Apply Transform (Blender's Ctrl+A) and the Instancer's source-transform bake.
 *
 * Both are the same arithmetic pointed at different problems, and both fail the
 * same way: they produce geometry that is perfectly plausible and wrong — a
 * mesh in the right place with inside-out faces, or a fence of posts rotated
 * consistently 90° from the model they were copied off. None of that needs a
 * GPU, a project on disk or a command bus to check.
 */
import assert from "node:assert/strict";
import { inspect } from "node:util";

inspect.defaultOptions.depth = 0;
inspect.defaultOptions.getters = false;

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
const {
  APPLY_MODES,
  applyPlan,
  bakeMatrixIntoGeometry,
  flipWinding,
  isIdentityMatrix,
  relativeMatrix,
} = await import("../src/engine/geometryTransform.js");
const { geometryAssetFromBufferGeometry, encodeGeometryAsset, decodeGeometryAsset, geometryFromAsset } =
  await import("../src/engine/geometryAsset.js");
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
const section = (title) => console.log(`\n${title}`);
const near = (a, b, tol = 1e-4) => Math.abs(a - b) <= tol;
const V = (x, y, z) => new THREE.Vector3(x, y, z);

/** The object matrix a transform describes. */
const matrixOf = (t) =>
  new THREE.Matrix4().compose(
    new THREE.Vector3().fromArray(t.position ?? [0, 0, 0]),
    new THREE.Quaternion().setFromEuler(new THREE.Euler().fromArray(t.rotation ?? [0, 0, 0])),
    new THREE.Vector3().fromArray(t.scale ?? [1, 1, 1]),
  );

/**
 * Where a vertex ends up after applying `mode`: baked through the applied
 * matrix, then through whatever transform is left on the object.
 *
 * This is the whole test for "visually neutral" — the point must not move.
 */
const roundTrip = (transform, mode, point) => {
  const { matrix, next } = applyPlan(transform, mode);
  return point.clone().applyMatrix4(matrix).applyMatrix4(matrixOf(next));
};

const originalWorld = (transform, point) => point.clone().applyMatrix4(matrixOf(transform));

// ---------------------------------------------------------------------------

section("what each mode bakes");

await check("applying everything clears the whole transform", () => {
  const t = { position: [3, 4, 5], rotation: [0, Math.PI / 2, 0], scale: [2, 2, 2] };
  const { next } = applyPlan(t, "all");
  assert.deepEqual(next.position, [0, 0, 0]);
  assert.deepEqual(next.rotation, [0, 0, 0]);
  assert.deepEqual(next.scale, [1, 1, 1]);
});

await check("rotation & scale keeps the position, and only the position", () => {
  const t = { position: [3, 4, 5], rotation: [0, Math.PI / 2, 0], scale: [2, 3, 4] };
  const { next } = applyPlan(t, "rotationScale");
  assert.deepEqual(next.position, [3, 4, 5]);
  assert.deepEqual(next.rotation, [0, 0, 0]);
  assert.deepEqual(next.scale, [1, 1, 1]);
});

await check("scale keeps position AND rotation", () => {
  const t = { position: [1, 2, 3], rotation: [0, Math.PI / 3, 0], scale: [5, 5, 5] };
  const { next } = applyPlan(t, "scale");
  assert.deepEqual(next.position, [1, 2, 3]);
  assert.ok(near(next.rotation[1], Math.PI / 3));
  assert.deepEqual(next.scale, [1, 1, 1]);
});

section("the modes that are exact really are exact");

const CASES = [
  { label: "translated", t: { position: [7, -2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] } },
  { label: "rotated", t: { position: [0, 0, 0], rotation: [0.3, 0.7, -0.2], scale: [1, 1, 1] } },
  { label: "uniformly scaled", t: { position: [1, 1, 1], rotation: [0, 0.5, 0], scale: [3, 3, 3] } },
  { label: "non-uniformly scaled", t: { position: [2, 0, -4], rotation: [0.2, 1.1, 0.4], scale: [2, 0.5, 3] } },
  { label: "mirrored", t: { position: [1, 2, 3], rotation: [0, 0.4, 0], scale: [-1, 1, 1] } },
];

for (const { label, t } of CASES) {
  await check(`all / rotationScale / scale leave a ${label} object exactly where it was`, () => {
    const point = V(0.7, -1.3, 2.1);
    const before = originalWorld(t, point);
    for (const mode of ["all", "rotationScale", "scale"]) {
      const after = roundTrip(t, mode, point);
      assert.ok(after.distanceTo(before) < 1e-9, `${mode}: ${after.toArray()} vs ${before.toArray()}`);
    }
  });
}

await check("applying rotation alone is exact under uniform scale", () => {
  const t = { position: [1, 2, 3], rotation: [0.4, 0.9, -0.3], scale: [4, 4, 4] };
  const point = V(1, -2, 0.5);
  const after = roundTrip(t, "rotation", point);
  assert.ok(after.distanceTo(originalWorld(t, point)) < 1e-9, `${after.toArray()}`);
  assert.equal(applyPlan(t, "rotation").warning, null);
});

await check("…and is NOT under non-uniform scale — which it says out loud", () => {
  const t = { position: [0, 0, 0], rotation: [0, Math.PI / 2, 0], scale: [3, 1, 1] };
  const point = V(1, 0, 0);
  const after = roundTrip(t, "rotation", point);
  assert.ok(after.distanceTo(originalWorld(t, point)) > 0.5, "this case is supposed to move");
  assert.match(applyPlan(t, "rotation").warning ?? "", /Non-uniform scale/);
});

await check("applying location alone is exact on an unrotated, unscaled object", () => {
  const t = { position: [5, -1, 2], rotation: [0, 0, 0], scale: [1, 1, 1] };
  const point = V(0.5, 0.5, 0.5);
  assert.ok(roundTrip(t, "position", point).distanceTo(originalWorld(t, point)) < 1e-9);
  assert.equal(applyPlan(t, "position").warning, null);
});

await check("…and warns the moment there is a rotation to reorder it with", () => {
  const t = { position: [10, 0, 0], rotation: [0, Math.PI / 2, 0], scale: [1, 1, 1] };
  assert.match(applyPlan(t, "position").warning ?? "", /moves the object/);
});

await check("an identity transform bakes an identity matrix — nothing to apply", () => {
  const t = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
  for (const mode of APPLY_MODES) {
    assert.equal(isIdentityMatrix(applyPlan(t, mode).matrix), true, mode);
  }
  const moved = { position: [0, 1, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
  assert.equal(isIdentityMatrix(applyPlan(moved, "scale").matrix), true, "scale of 1 is still nothing");
  assert.equal(isIdentityMatrix(applyPlan(moved, "position").matrix), false);
});

section("baking into geometry");

const boxGeometry = () => new THREE.BoxGeometry(1, 1, 1).toNonIndexed().clone();
const indexedBox = () => new THREE.BoxGeometry(1, 1, 1);

await check("baking moves the vertices and leaves the source alone", () => {
  const source = indexedBox();
  const before = source.getAttribute("position").getX(0);
  const baked = bakeMatrixIntoGeometry(source, new THREE.Matrix4().makeTranslation(10, 0, 0));
  assert.ok(near(baked.getAttribute("position").getX(0), before + 10), `${baked.getAttribute("position").getX(0)}`);
  assert.ok(near(source.getAttribute("position").getX(0), before), "the source must not be mutated");
});

await check("normals come through the inverse-transpose, so a squashed box keeps unit normals", () => {
  const baked = bakeMatrixIntoGeometry(indexedBox(), new THREE.Matrix4().makeScale(4, 0.25, 1));
  const normal = baked.getAttribute("normal");
  for (let i = 0; i < normal.count; i++) {
    const length = Math.hypot(normal.getX(i), normal.getY(i), normal.getZ(i));
    assert.ok(near(length, 1, 1e-4), `normal ${i} was ${length}`);
  }
});

await check("a MIRRORED bake flips the winding — otherwise the mesh is inside-out", () => {
  // The failure this guards is the nastiest kind: the normals are right, the
  // positions are right, and every face is back-facing.
  const source = indexedBox();
  const mirror = new THREE.Matrix4().makeScale(-1, 1, 1);
  const baked = bakeMatrixIntoGeometry(source, mirror);
  const faceNormal = (geometry, tri) => {
    const index = geometry.getIndex();
    const p = geometry.getAttribute("position");
    const a = new THREE.Vector3().fromBufferAttribute(p, index.getX(tri * 3));
    const b = new THREE.Vector3().fromBufferAttribute(p, index.getX(tri * 3 + 1));
    const c = new THREE.Vector3().fromBufferAttribute(p, index.getX(tri * 3 + 2));
    return b.sub(a).cross(c.sub(a)).normalize();
  };
  const vertexNormal = (geometry, tri) => {
    const index = geometry.getIndex();
    const n = geometry.getAttribute("normal");
    return new THREE.Vector3().fromBufferAttribute(n, index.getX(tri * 3));
  };
  for (let tri = 0; tri < 4; tri++) {
    assert.ok(
      faceNormal(baked, tri).dot(vertexNormal(baked, tri)) > 0.9,
      `triangle ${tri} winds against its own normal`,
    );
  }
});

await check("flipping twice is the identity", () => {
  const geometry = indexedBox();
  const original = [...geometry.getIndex().array];
  flipWinding(flipWinding(geometry));
  assert.deepEqual([...geometry.getIndex().array], original);
});

await check("a non-indexed geometry survives a mirrored bake without throwing", () => {
  const baked = bakeMatrixIntoGeometry(boxGeometry(), new THREE.Matrix4().makeScale(1, -1, 1));
  assert.ok(baked.getAttribute("position").count > 0);
});

await check("the bake is exactly invertible — which is what makes undo work", () => {
  const matrix = new THREE.Matrix4().compose(
    V(3, -1, 2),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0.4, 1.2, -0.7)),
    V(2, 0.5, 3),
  );
  const source = indexedBox();
  const baked = bakeMatrixIntoGeometry(source, matrix);
  const restored = bakeMatrixIntoGeometry(baked, matrix.clone().invert());
  const a = source.getAttribute("position");
  const b = restored.getAttribute("position");
  for (let i = 0; i < a.count; i++) {
    assert.ok(Math.abs(a.getX(i) - b.getX(i)) < 1e-4, `vertex ${i} drifted`);
    assert.ok(Math.abs(a.getY(i) - b.getY(i)) < 1e-4, `vertex ${i} drifted`);
    assert.ok(Math.abs(a.getZ(i) - b.getZ(i)) < 1e-4, `vertex ${i} drifted`);
  }
  assert.deepEqual([...source.getIndex().array], [...restored.getIndex().array]);
});

section("the .geom round trip a rewrite depends on");

await check("a baked geometry survives serialize → encode → decode → rebuild intact", () => {
  // Apply Transform writes the result to disk. If this round trip is lossy the
  // object is correct on screen until the next scene load, which is the worst
  // possible time to find out.
  const source = indexedBox();
  source.setAttribute("color", new THREE.BufferAttribute(new Float32Array(source.getAttribute("position").count * 3).fill(0.5), 3));
  const baked = bakeMatrixIntoGeometry(source, new THREE.Matrix4().makeTranslation(1, 2, 3));
  // `encodeGeometryAsset` returns the bytes the file gets; the loader hands the
  // decoder what `Response.arrayBuffer()` produced, so slice to match.
  const bytes = encodeGeometryAsset(geometryAssetFromBufferGeometry(baked));
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const restored = geometryFromAsset(decodeGeometryAsset(buffer));
  const a = baked.getAttribute("position");
  const b = restored.getAttribute("position");
  assert.equal(a.count, b.count);
  for (let i = 0; i < a.count; i++) {
    assert.ok(Math.abs(a.getX(i) - b.getX(i)) < 1e-5, `position ${i}`);
  }
  assert.ok(restored.getAttribute("normal"), "normals must survive");
  assert.ok(restored.getAttribute("color"), "custom attributes must survive");
  assert.deepEqual([...baked.getIndex().array], [...restored.getIndex().array]);
});

section("relativeMatrix");

await check("an object already at its ancestor's origin reports null, so nothing is cloned", () => {
  const parent = new THREE.Object3D();
  const child = new THREE.Object3D();
  parent.add(child);
  assert.equal(relativeMatrix(child, parent), null);
});

await check("a nested, rotated child reports the matrix that gets it back into the ancestor's space", () => {
  const parent = new THREE.Object3D();
  parent.position.set(100, 0, 0); // must NOT appear in the result
  const middle = new THREE.Object3D();
  middle.position.set(0, 2, 0);
  const child = new THREE.Object3D();
  child.rotation.y = Math.PI / 2;
  child.scale.setScalar(3);
  parent.add(middle);
  middle.add(child);
  parent.updateMatrixWorld(true);
  const matrix = relativeMatrix(child, parent);
  const point = V(1, 0, 0).applyMatrix4(matrix);
  // +X, rotated 90° about Y and scaled 3, lifted 2 by the middle node.
  assert.ok(point.distanceTo(V(0, 2, -3)) < 1e-4, `${point.toArray()}`);
});

section("Instancer: bakeSourceTransform");

const modelLikeEntity = (engine, { rotation = Math.PI / 2, scale = 2, offset = [0, 3, 0] } = {}) => {
  const entity = engine.createEntity({ name: "Prop" });
  entity.addComponent("mesh", { geometry: "box", width: 1, height: 1, depth: 1 });
  // Stand in for a glTF node: a mesh sitting inside the entity with a transform
  // of its own. The importer's axis conversion alone produces this on most
  // real models.
  const mesh = entity.getComponent("mesh").mesh;
  mesh.position.fromArray(offset);
  mesh.rotation.y = rotation;
  mesh.scale.setScalar(scale);
  engine.scene.updateMatrixWorld(true);
  return entity;
};

await check("without the option, instances ignore the source mesh's own transform", () => {
  const engine = new Engine();
  const entity = modelLikeEntity(engine);
  const instancer = entity.addComponent("instancer", { mode: "array", count: 2, bakeSourceTransform: false });
  // The raw unit box: half-extent 0.5, centred on the entity origin.
  instancer.instancedMesh.geometry.computeBoundingBox();
  const box = instancer.instancedMesh.geometry.boundingBox;
  assert.ok(near(box.max.y, 0.5, 1e-3), `${box.max.y}`);
});

await check("with it, the source mesh's transform is folded into the instanced geometry", () => {
  const engine = new Engine();
  const entity = modelLikeEntity(engine);
  const instancer = entity.addComponent("instancer", { mode: "array", count: 2, bakeSourceTransform: true });
  const box = instancer.instancedMesh.geometry.boundingBox ?? (() => {
    instancer.instancedMesh.geometry.computeBoundingBox();
    return instancer.instancedMesh.geometry.boundingBox;
  })();
  // Scaled 2 (half-extent 1) and lifted 3.
  assert.ok(near(box.max.y, 4, 1e-3), `${box.max.y}`);
  assert.ok(near(box.min.y, 2, 1e-3), `${box.min.y}`);
});

await check("baking clones — the source mesh keeps rendering its own buffer", () => {
  const engine = new Engine();
  const entity = modelLikeEntity(engine);
  const source = entity.getComponent("mesh").mesh.geometry;
  const before = source.getAttribute("position").getY(0);
  const instancer = entity.addComponent("instancer", { mode: "array", count: 2, bakeSourceTransform: true });
  assert.notEqual(instancer.instancedMesh.geometry, source, "it must not instance the source buffer");
  assert.ok(near(source.getAttribute("position").getY(0), before), "baking in place would move the model itself");
});

await check("a source mesh already at the entity's origin is NOT cloned — nothing to bake", () => {
  const engine = new Engine();
  const entity = engine.createEntity({ name: "Plain" });
  entity.addComponent("mesh", { geometry: "box" });
  engine.scene.updateMatrixWorld(true);
  const instancer = entity.addComponent("instancer", { mode: "array", count: 3, bakeSourceTransform: true });
  assert.equal(instancer.instancedMesh.geometry, entity.getComponent("mesh").mesh.geometry);
  assert.equal(instancer._ownsGeometry, false, "a shared buffer must never be marked as owned");
});

await check("the baked copy is owned, so detaching disposes it", () => {
  const engine = new Engine();
  const entity = modelLikeEntity(engine);
  const instancer = entity.addComponent("instancer", { mode: "array", count: 2, bakeSourceTransform: true });
  assert.equal(instancer._ownsGeometry, true);
  const baked = instancer.instancedMesh.geometry;
  let disposed = false;
  baked.addEventListener("dispose", () => (disposed = true));
  entity.removeComponent("instancer");
  assert.equal(disposed, true, "the private copy leaked");
});

await check("toggling the option rebuilds, and toggling back restores the shared buffer", () => {
  const engine = new Engine();
  const entity = modelLikeEntity(engine);
  const instancer = entity.addComponent("instancer", { mode: "array", count: 2, bakeSourceTransform: false });
  const shared = entity.getComponent("mesh").mesh.geometry;
  assert.equal(instancer.instancedMesh.geometry, shared);
  instancer.setProp("bakeSourceTransform", true);
  assert.notEqual(entity.getComponent("instancer").instancedMesh.geometry, shared);
  entity.getComponent("instancer").setProp("bakeSourceTransform", false);
  assert.equal(entity.getComponent("instancer").instancedMesh.geometry, shared);
});

await check("it works in path mode too — a fence of correctly-oriented posts", () => {
  const engine = new Engine();
  const path = engine.createEntity({ name: "Path" });
  path.addComponent("spline", {
    knots: [{ position: [0, 0, 0] }, { position: [10, 0, 0] }],
    type: "linear",
  });
  const host = modelLikeEntity(engine);
  const instancer = host.addComponent("instancer", {
    mode: "path",
    pathEntity: path.id,
    count: 3,
    pathAlign: "none",
    bakeSourceTransform: true,
  });
  assert.equal(instancer.instancedMesh.count, 3);
  instancer.instancedMesh.geometry.computeBoundingBox();
  assert.ok(near(instancer.instancedMesh.geometry.boundingBox.max.y, 4, 1e-3));
});

// ---------------------------------------------------------------------------

console.log(failures ? `\n${failures} check(s) failed` : "\nAll apply-transform checks passed");
process.exit(failures ? 1 : 0);
