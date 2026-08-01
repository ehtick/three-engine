/**
 * Gameplay VFX — line renderer, trail renderer, decals (roadmap item 13).
 *
 * The interesting parts are all arithmetic and lifetime, which is exactly what
 * a headless run can pin down: does the strip put its vertices where the ramp
 * says, does a trail's tail retreat smoothly instead of popping a segment at a
 * time, does the clipper actually cut a triangle at the box edge, and does a
 * decal batch stay merged (and bounded) as decals come and go.
 *
 * What it cannot see — that any of it is on screen — is run-vfx-smoke's job.
 */
import assert from "node:assert/strict";

const stubElement = () => ({
  style: {},
  appendChild() {},
  removeChild() {},
  addEventListener() {},
  removeEventListener() {},
  setAttribute() {},
  getContext: () => null,
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
const { RibbonBuffer, buildRibbon, smoothPolyline } = await import("../src/engine/vfx/ribbon.js");
const { projectDecal, collectDecalTargets, decalOrientation } = await import("../src/engine/vfx/decalProjection.js");
const { DecalSystem } = await import("../src/engine/vfx/DecalSystem.js");
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
const near = (a, b, epsilon = 1e-4) => Math.abs(a - b) <= epsilon;

/** A ribbon from an array of `[x,y,z]` points. */
function ribbon(points, options = {}) {
  const flat = new Float32Array(points.flat());
  return buildRibbon(new RibbonBuffer(), flat, points.length, options);
}

// ---------------------------------------------------------------------------

section("ribbon geometry");

await check("two points become one quad", () => {
  const out = ribbon([[0, 0, 0], [0, 0, 1]]);
  assert.equal(out.vertexCount, 4, "two vertices per spine point");
  assert.equal(out.indexCount, 6, "one quad = two triangles");
});

await check("a single point is no geometry, not a degenerate quad", () => {
  const out = ribbon([[0, 0, 0]]);
  assert.equal(out.indexCount, 0);
  assert.equal(out.vertexCount, 0);
});

await check("both vertices of a point sit ON the spine (the shader spreads them)", () => {
  const out = ribbon([[1, 2, 3], [1, 2, 4]]);
  assert.deepEqual([...out.positions.slice(0, 6)], [1, 2, 3, 1, 2, 3]);
  assert.deepEqual([...out.sides.slice(0, 2)], [-1, 1], "opposite sides of the strip");
});

await check("width ramps from start to end along the arc", () => {
  const out = ribbon([[0, 0, 0], [0, 0, 1], [0, 0, 2]], { startWidth: 1, endWidth: 3 });
  assert.ok(near(out.widths[0], 1), `head width ${out.widths[0]}`);
  assert.ok(near(out.widths[2], 2), `middle width ${out.widths[2]}`);
  assert.ok(near(out.widths[4], 3), `tail width ${out.widths[4]}`);
});

await check("the ramp follows DISTANCE, not point index", () => {
  // The middle point is 10% of the way along, so it must read 10% of the ramp.
  // Interpolating by index instead is the classic version of this bug and only
  // shows up on unevenly spaced points — i.e. every real trail.
  const out = ribbon([[0, 0, 0], [0, 0, 1], [0, 0, 10]], { startWidth: 0, endWidth: 10 });
  assert.ok(near(out.widths[2], 1), `expected 1, got ${out.widths[2]}`);
});

await check("params override the arc-length ramp (what a trail needs)", () => {
  const flat = new Float32Array([0, 0, 0, 0, 0, 1, 0, 0, 2]);
  const out = buildRibbon(new RibbonBuffer(), flat, 3, {
    params: new Float32Array([0, 1, 1]),
    startWidth: 0,
    endWidth: 4,
  });
  assert.ok(near(out.widths[2], 4), "the middle point is aged, not halfway");
});

await check("colour ramps in rgba", () => {
  const out = ribbon([[0, 0, 0], [1, 0, 0]], {
    startColor: [1, 0, 0, 1],
    endColor: [0, 0, 1, 0],
  });
  assert.deepEqual([...out.colors.slice(0, 4)], [1, 0, 0, 1]);
  assert.deepEqual([...out.colors.slice(4 * 2, 4 * 3)], [0, 0, 1, 0]);
});

await check("per-point colours win over the ramp", () => {
  const out = ribbon([[0, 0, 0], [1, 0, 0]], {
    startColor: [1, 1, 1, 1],
    endColor: [1, 1, 1, 1],
    pointColors: new Float32Array([0.5, 0, 0, 0.25, 0, 0.5, 0, 0.75]),
  });
  assert.deepEqual([...out.colors.slice(0, 4)], [0.5, 0, 0, 0.25]);
  assert.deepEqual([...out.colors.slice(8, 12)], [0, 0.5, 0, 0.75]);
});

await check("the tangent at a corner is the centred difference", () => {
  const out = ribbon([[0, 0, 0], [1, 0, 0], [1, 0, 1]]);
  const [x, y, z] = out.tangents.slice(6, 9); // middle point, first vertex
  const expected = 1 / Math.SQRT2;
  assert.ok(near(x, expected) && near(y, 0) && near(z, expected), `got ${x},${y},${z}`);
});

await check("a duplicated point reuses the previous tangent instead of a NaN", () => {
  // normalize(0) is NaN, and a NaN in the vertex stage doesn't make the ribbon
  // thin — it makes the whole ribbon vanish.
  const out = ribbon([[0, 0, 0], [0, 0, 1], [0, 0, 1]]);
  for (let i = 0; i < out.vertexCount * 3; i++) {
    assert.ok(Number.isFinite(out.tangents[i]), `tangent ${i} is ${out.tangents[i]}`);
  }
});

await check("a closed loop has one more segment than an open line", () => {
  const points = [[0, 0, 0], [1, 0, 0], [1, 0, 1]];
  assert.equal(ribbon(points).indexCount, 2 * 6);
  assert.equal(ribbon(points, { closed: true }).indexCount, 3 * 6);
});

await check("stretch UVs span 0..1 (× tiling); tile UVs count world units", () => {
  const stretch = ribbon([[0, 0, 0], [0, 0, 4]], { textureMode: "stretch", tiling: 2 });
  assert.ok(near(stretch.uvs[0], 0) && near(stretch.uvs[4], 2), "stretch × tiling");
  const tile = ribbon([[0, 0, 0], [0, 0, 4]], { textureMode: "tile", tiling: 0.5 });
  assert.ok(near(tile.uvs[4], 8), `4m at 0.5m per repeat = 8, got ${tile.uvs[4]}`);
  assert.deepEqual([...tile.uvs.slice(0, 4)], [0, 0, 0, 1], "v crosses the strip");
});

await check("the bounding sphere covers the strip's WIDTH, not just its spine", () => {
  const out = ribbon([[0, 0, 0], [0, 0, 2]], { startWidth: 4, endWidth: 4 });
  assert.ok(near(out.center[2], 1), `centre ${out.center}`);
  assert.ok(out.radius >= 1 + 2, `radius ${out.radius} must include the half-width`);
});

await check("growing past capacity keeps the data and flags a new generation", () => {
  const buffer = new RibbonBuffer();
  const points = [];
  for (let i = 0; i < 300; i++) points.push([i, 0, 0]);
  const flat = new Float32Array(points.flat());
  buildRibbon(buffer, flat, 4);
  const first = buffer.generation;
  buildRibbon(buffer, flat, 300);
  assert.ok(buffer.generation > first, "a reallocation must be visible to the mesh");
  assert.equal(buffer.vertexCount, 600);
  assert.equal(buffer.positions[299 * 6], 299, "last point survived the growth");
});

section("smoothing");

await check("subdivisions of 0 is the identity", () => {
  const source = new Float32Array([0, 0, 0, 1, 0, 0]);
  const { points, count } = smoothPolyline(source, 2, 0);
  assert.equal(count, 2);
  assert.deepEqual([...points.slice(0, 6)], [0, 0, 0, 1, 0, 0]);
});

await check("the smoothed curve passes through its control points", () => {
  const source = new Float32Array([0, 0, 0, 1, 1, 0, 2, 0, 0]);
  const { points, count } = smoothPolyline(source, 3, 3);
  assert.equal(count, 2 * 4 + 1, "2 segments × 4 steps + the closing point");
  // Control point 1 is the start of segment 1, i.e. step 4.
  assert.ok(near(points[4 * 3], 1) && near(points[4 * 3 + 1], 1), "control point 1 is on the curve");
  assert.ok(near(points[8 * 3], 2) && near(points[8 * 3 + 1], 0), "and the last point is the last point");
});

await check("collinear points stay collinear (no invented wiggle)", () => {
  const source = new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0]);
  const { points, count } = smoothPolyline(source, 4, 4);
  for (let i = 0; i < count; i++) {
    assert.ok(near(points[i * 3 + 1], 0, 1e-5), `y drifted to ${points[i * 3 + 1]}`);
  }
});

await check("unevenly spaced points don't make the curve double back", () => {
  // This is what the centripetal parameterization buys, and why the code pays
  // for the distance terms. Two control points close together next to a long
  // segment make the UNIFORM Catmull-Rom loop back on itself — the curve
  // briefly travels backwards, which on a rope or a rail is a visible kink
  // that no amount of moving the points fixes. Both are computed here, so the
  // claim is the test rather than a comment.
  const control = [[0, 0, 0], [1, 0, 0], [1.02, 0, 0], [2, 1, 0]];
  const { points, count } = smoothPolyline(new Float32Array(control.flat()), 4, 8);
  for (let i = 1; i < count; i++) {
    assert.ok(
      points[i * 3] >= points[(i - 1) * 3] - 1e-5,
      `x went backwards at ${i}: ${points[(i - 1) * 3]} → ${points[i * 3]}`,
    );
  }
  // The same middle segment under the uniform parameterization, for contrast.
  const [p0, p1, p2, p3] = control.map((p) => p[0]);
  let backwards = false;
  for (let step = 0; step <= 8; step++) {
    const t = step / 8;
    const x =
      0.5 *
      (2 * p1 +
        (-p0 + p2) * t +
        (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t +
        (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
    if (x < p1 - 1e-6) backwards = true;
  }
  assert.ok(backwards, "the uniform version really does loop here — if not, this test proves nothing");
});

// ---------------------------------------------------------------------------

section("decal projection");

/** A 4×4 floor at y=0, facing up. */
function floorScene(size = 4) {
  const scene = new THREE.Scene();
  const geometry = new THREE.PlaneGeometry(size, size);
  geometry.rotateX(-Math.PI / 2); // +Y normal
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  scene.add(mesh);
  scene.updateMatrixWorld(true);
  return { scene, mesh };
}

/** A projector above the origin, looking down at the floor. */
function downProjector(y = 0.5, size = 1) {
  const object = new THREE.Object3D();
  object.position.set(0, y, 0);
  object.quaternion.copy(decalOrientation(new THREE.Vector3(0, 1, 0)));
  object.scale.setScalar(1);
  object.updateMatrixWorld(true);
  return { matrix: object.matrixWorld, size: new THREE.Vector3(size, size, size) };
}

await check("a projector aimed at the floor cuts geometry out of it", () => {
  const { scene } = floorScene();
  const { matrix, size } = downProjector();
  const result = projectDecal({ engine: scene, matrix, size });
  assert.ok(result, "expected geometry");
  assert.ok(result.vertexCount >= 6, `got ${result.vertexCount} vertices`);
});

await check("every vertex lands inside the projector box", () => {
  const { scene } = floorScene(10); // much larger than the decal
  const { matrix, size } = downProjector(0.5, 1);
  const result = projectDecal({ engine: scene, matrix, size, offset: 0 });
  const inverse = matrix.clone().invert();
  const v = new THREE.Vector3();
  for (let i = 0; i < result.vertexCount; i++) {
    v.fromArray(result.positions, i * 3).applyMatrix4(inverse);
    assert.ok(Math.abs(v.x) <= 0.5 + 1e-4, `x ${v.x} outside the box`);
    assert.ok(Math.abs(v.y) <= 0.5 + 1e-4, `y ${v.y} outside the box`);
    assert.ok(Math.abs(v.z) <= 0.5 + 1e-4, `z ${v.z} outside the box`);
  }
});

await check("UVs span the box exactly once", () => {
  const { scene } = floorScene(10);
  const { matrix, size } = downProjector(0.5, 1);
  const result = projectDecal({ engine: scene, matrix, size });
  let minU = Infinity, maxU = -Infinity;
  for (let i = 0; i < result.vertexCount; i++) {
    minU = Math.min(minU, result.uvs[i * 2]);
    maxU = Math.max(maxU, result.uvs[i * 2]);
  }
  assert.ok(near(minU, 0, 1e-3) && near(maxU, 1, 1e-3), `u spans ${minU}..${maxU}`);
});

await check("a surface facing AWAY from the projector is not stamped", () => {
  // The far side of a thin wall. Without the facing test the decal appears
  // there too, mirrored — visible from the next room and impossible to explain.
  // (The projector's position within its box is deliberately NOT part of this:
  // the box is the volume, exactly as Unity's decal projector treats it.)
  const { scene } = floorScene();
  const object = new THREE.Object3D();
  object.position.set(0, 0.5, 0);
  object.quaternion.copy(decalOrientation(new THREE.Vector3(0, -1, 0)));
  object.updateMatrixWorld(true);
  const result = projectDecal({ engine: scene, matrix: object.matrixWorld, size: new THREE.Vector3(1, 1, 1) });
  assert.equal(result, null);
});

await check("maxAngle rejects a face beyond the limit", () => {
  const { scene } = floorScene();
  const object = new THREE.Object3D();
  object.position.set(0, 0.5, 0);
  // Aimed 60° off the floor's normal.
  object.quaternion.copy(decalOrientation(new THREE.Vector3(Math.sin(Math.PI / 3), Math.cos(Math.PI / 3), 0)));
  object.updateMatrixWorld(true);
  const wide = projectDecal({ engine: scene, matrix: object.matrixWorld, size: new THREE.Vector3(1, 1, 1), maxAngle: 89 });
  const narrow = projectDecal({ engine: scene, matrix: object.matrixWorld, size: new THREE.Vector3(1, 1, 1), maxAngle: 30 });
  assert.ok(wide, "60° is inside a 89° limit");
  assert.equal(narrow, null, "60° is outside a 30° limit");
});

await check("the clip cuts a triangle at the box edge, keeping it convex", () => {
  // One big triangle spanning far past the projector: the result must be inside
  // the box AND still be a fan of triangles (3 vertices each).
  const scene = new THREE.Scene();
  const geometry = new THREE.BufferGeometry();
  // Wound counter-clockwise seen from above, so its normal points up at the
  // projector — the winding is what the facing test reads.
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([-5, 0, -5, 0, 0, 5, 5, 0, -5], 3));
  geometry.computeVertexNormals();
  scene.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()));
  scene.updateMatrixWorld(true);
  const { matrix, size } = downProjector(0.5, 1);
  const result = projectDecal({ engine: scene, matrix, size, offset: 0 });
  assert.ok(result, "the triangle covers the projector");
  assert.equal(result.vertexCount % 3, 0, "whole triangles only");
  const inverse = matrix.clone().invert();
  const v = new THREE.Vector3();
  for (let i = 0; i < result.vertexCount; i++) {
    v.fromArray(result.positions, i * 3).applyMatrix4(inverse);
    assert.ok(Math.abs(v.x) <= 0.5 + 1e-4 && Math.abs(v.z) <= 0.5 + 1e-4, "clipped to the box");
  }
});

await check("the offset lifts the decal along the SURFACE normal", () => {
  const { scene } = floorScene();
  const { matrix, size } = downProjector(0.5, 1);
  const result = projectDecal({ engine: scene, matrix, size, offset: 0.25 });
  for (let i = 0; i < result.vertexCount; i++) {
    assert.ok(near(result.positions[i * 3 + 1], 0.25), `y ${result.positions[i * 3 + 1]}`);
  }
});

await check("skinned, instanced, hidden and opted-out meshes are skipped", () => {
  const { scene, mesh } = floorScene();
  const { matrix, size } = downProjector();
  mesh.userData.noDecal = true;
  assert.equal(collectDecalTargets(scene, matrix, size).length, 0, "noDecal");
  mesh.userData.noDecal = false;
  mesh.visible = false;
  assert.equal(collectDecalTargets(scene, matrix, size).length, 0, "hidden");
  // …unless it is hidden BECAUSE it was batched, in which case it is exactly
  // the surface being drawn.
  mesh.userData.batchedInto = {};
  assert.equal(collectDecalTargets(scene, matrix, size).length, 1, "batch member");
  mesh.visible = true;
  mesh.userData.batchedInto = null;
  mesh.isSkinnedMesh = true;
  assert.equal(collectDecalTargets(scene, matrix, size).length, 0, "skinned (bind pose ≠ on screen)");
  mesh.isSkinnedMesh = false;
  mesh.userData.batchProxy = true;
  assert.equal(collectDecalTargets(scene, matrix, size).length, 0, "batch proxy would double every triangle");
});

await check("a mesh out of range is rejected before any clipping", () => {
  const { scene, mesh } = floorScene();
  mesh.position.set(100, 0, 0);
  mesh.updateMatrixWorld(true);
  const { matrix, size } = downProjector();
  assert.equal(collectDecalTargets(scene, matrix, size).length, 0);
});

await check("orientation from a floor normal is finite (lookAt's degenerate case)", () => {
  for (const normal of [[0, 1, 0], [0, -1, 0], [1, 0, 0], [0.3, 0.9, 0.1]]) {
    const q = decalOrientation(new THREE.Vector3(...normal).normalize());
    assert.ok(Number.isFinite(q.x + q.y + q.z + q.w), `NaN quaternion for ${normal}`);
    // +Z must end up along the normal — that is what makes the projector look
    // back down it.
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    assert.ok(near(forward.dot(new THREE.Vector3(...normal).normalize()), 1, 1e-4), `+Z off-normal for ${normal}`);
  }
});

// ---------------------------------------------------------------------------

section("decal system");

function decalEngine() {
  const engine = { scene: new THREE.Scene(), getEntity: () => null };
  const geometry = new THREE.PlaneGeometry(20, 20);
  geometry.rotateX(-Math.PI / 2);
  engine.scene.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()));
  engine.scene.updateMatrixWorld(true);
  return { engine, decals: new DecalSystem(engine) };
}

const hit = (x = 0, z = 0, extra = {}) => ({
  position: { x, y: 0, z },
  normal: { x: 0, y: 1, z: 0 },
  size: 0.5,
  ...extra,
});

await check("a spawn returns a handle and puts vertices in a batch", () => {
  const { decals } = decalEngine();
  const handle = decals.spawn(hit());
  assert.ok(handle, "expected a handle");
  assert.ok(handle.vertexCount > 0);
  assert.equal(decals.batches.size, 1);
  assert.equal([...decals.batches.values()][0].vertexCount, handle.vertexCount);
});

await check("decals sharing a look share ONE mesh", () => {
  const { engine, decals } = decalEngine();
  for (let i = 0; i < 12; i++) decals.spawn(hit(i * 0.6, 0));
  assert.equal(decals.decals.length, 12);
  assert.equal(decals.batches.size, 1, "12 decals, one draw call");
  const meshes = [];
  engine.scene.traverse((o) => o.name === "__decalBatch" && meshes.push(o));
  assert.equal(meshes.length, 1);
});

await check("a different look gets its own batch", () => {
  const { decals } = decalEngine();
  decals.spawn(hit(0, 0, { lit: true }));
  decals.spawn(hit(1, 0, { lit: false }));
  decals.spawn(hit(2, 0, { blending: "additive" }));
  assert.equal(decals.batches.size, 3);
});

await check("spawning into thin air returns null rather than an empty draw", () => {
  const { decals } = decalEngine();
  assert.equal(decals.spawn({ position: { x: 0, y: 50, z: 0 }, normal: { x: 0, y: 1, z: 0 }, size: 0.2 }), null);
});

await check("removing a decal compacts the batch and keeps the survivors intact", () => {
  const { decals } = decalEngine();
  const first = decals.spawn(hit(0, 0));
  const second = decals.spawn(hit(2, 0));
  const batch = [...decals.batches.values()][0];
  const total = batch.vertexCount;
  const secondPosition = batch.positions[second.start * 3];
  first.remove();
  assert.equal(batch.vertexCount, total - first.vertexCount);
  assert.equal(second.start, 0, "the survivor moved to the front");
  assert.equal(batch.positions[0], secondPosition, "…with its geometry");
  assert.equal(decals.decals.length, 1);
});

await check("the cap evicts the OLDEST, never the incoming one", () => {
  const { decals } = decalEngine();
  decals.maxDecals = 4;
  const handles = [];
  for (let i = 0; i < 7; i++) handles.push(decals.spawn(hit(i * 0.7, 0)));
  assert.equal(decals.decals.length, 4);
  assert.equal(decals.decals[3], handles[6], "the newest decal is always present");
  assert.ok(!decals.decals.includes(handles[0]), "the oldest went");
});

await check("lifetime expires a decal; 0 means permanent", () => {
  const { decals } = decalEngine();
  const timed = decals.spawn(hit(0, 0, { lifetime: 1 }));
  const forever = decals.spawn(hit(2, 0));
  decals.update(0.5);
  assert.equal(decals.decals.length, 2);
  decals.update(0.6);
  assert.equal(decals.decals.length, 1);
  assert.equal(decals.decals[0], forever);
  assert.ok(timed.batch === null, "an expired decal releases its batch slot");
});

await check("fading writes the alpha into the vertex colours, not a uniform", () => {
  const { decals } = decalEngine();
  const handle = decals.spawn(hit(0, 0, { lifetime: 2, fadeTime: 1, opacity: 1 }));
  const batch = [...decals.batches.values()][0];
  assert.equal(batch.colors[3], 1, "starts opaque");
  decals.update(1.5); // 0.5s of a 1s fade remains
  assert.ok(near(batch.colors[3], 0.5, 0.02), `alpha ${batch.colors[3]}`);
  assert.ok(handle.fade < 1);
});

await check("clear() empties every batch", () => {
  const { decals } = decalEngine();
  decals.spawn(hit(0, 0));
  decals.spawn(hit(1, 0, { lit: false }));
  decals.clear();
  assert.equal(decals.decals.length, 0);
  for (const batch of decals.batches.values()) {
    assert.equal(batch.vertexCount, 0);
    assert.equal(batch.mesh.visible, false);
  }
});

await check("the batch mesh is invisible to batching, decals and picking", () => {
  const { decals } = decalEngine();
  decals.spawn(hit());
  const batch = [...decals.batches.values()][0];
  assert.ok(batch.mesh.userData.noDecal, "a decal on a decal accumulates forever");
  assert.ok(batch.mesh.userData.noBatch);
  assert.equal(batch.mesh.matrixAutoUpdate, false, "geometry is already world-space");
});

// ---------------------------------------------------------------------------

section("line renderer");

function lineEntity(props = {}) {
  const engine = new Engine();
  const entity = engine.createEntity({ name: "Line" });
  const line = entity.addComponent("line", props);
  return { engine, entity, line };
}

await check("the strip is parented to the entity in local space", () => {
  const { entity, line } = lineEntity();
  assert.equal(line.ribbon.mesh.parent, entity.object3D);
  assert.equal(line.ribbon.buffer.indexCount, 6, "the default two points draw a quad");
});

await check("world space parents it to the scene root instead", () => {
  const { engine, entity, line } = lineEntity({ space: "world" });
  assert.equal(line.ribbon.mesh.parent, engine.scene);
  assert.notEqual(line.ribbon.mesh.parent, entity.object3D);
  assert.equal(line.ribbon.mesh.matrixAutoUpdate, false);
});

await check("setPoints rebuilds the strip", () => {
  const { line } = lineEntity();
  line.setPoints([[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0]]);
  assert.equal(line.pointCount, 4);
  assert.equal(line.ribbon.buffer.indexCount, 3 * 6);
  assert.equal(line.getPoint(2).x, 2);
});

await check("setPoints accepts Vector3s and {x,y,z} alike", () => {
  const { line } = lineEntity();
  line.setPoints([new THREE.Vector3(1, 2, 3), { x: 4, y: 5, z: 6 }]);
  assert.deepEqual(line.props.points, [[1, 2, 3], [4, 5, 6]]);
});

await check("smoothing subdivides without moving the endpoints", () => {
  const { line } = lineEntity({ points: [[0, 0, 0], [1, 1, 0], [2, 0, 0]], smoothing: 4 });
  const before = line.ribbon.buffer.indexCount;
  assert.ok(before > 2 * 6, "more segments than control points");
  assert.equal(line.ribbon.buffer.positions[0], 0, "still starts at the first point");
});

await check("loop closes the strip", () => {
  const points = [[0, 0, 0], [1, 0, 0], [1, 0, 1]];
  const open = lineEntity({ points }).line.ribbon.buffer.indexCount;
  const closed = lineEntity({ points, loop: true }).line.ribbon.buffer.indexCount;
  assert.equal(closed, open + 6);
});

await check("an empty point list draws nothing at all", () => {
  const { line } = lineEntity();
  line.clearPoints();
  assert.equal(line.ribbon.buffer.indexCount, 0);
  assert.equal(line.ribbon.mesh.visible, false);
});

await check("disabling hides it without losing the points", () => {
  const { line } = lineEntity();
  line.setEnabled(false);
  assert.equal(line.ribbon.mesh.visible, false);
  assert.equal(line.pointCount, 2);
  line.setEnabled(true);
  assert.equal(line.ribbon.mesh.visible, true);
});

// ---------------------------------------------------------------------------

section("trail renderer");

function trailEntity(props = {}) {
  const engine = new Engine();
  const entity = engine.createEntity({ name: "Trail" });
  const trail = entity.addComponent("trail", { minVertexDistance: 1, time: 2, ...props });
  return { engine, entity, trail };
}
/** Move the entity and run one trail tick at `time` (game seconds). */
function move(engine, entity, trail, x, time) {
  entity.object3D.position.set(x, 0, 0);
  engine.elapsedTime = time;
  trail.tick();
}

await check("the recorded points are world-space, at the scene root", () => {
  const { engine, trail } = trailEntity();
  assert.equal(trail.ribbon.mesh.parent, engine.scene);
  assert.equal(trail.ribbon.mesh.matrixAutoUpdate, false);
});

await check("the first sample seeds two points, so one frame is already a ribbon", () => {
  const { engine, entity, trail } = trailEntity();
  move(engine, entity, trail, 0, 0);
  assert.equal(trail.pointCount, 2);
});

await check("a point is committed only after minVertexDistance", () => {
  const { engine, entity, trail } = trailEntity({ minVertexDistance: 1 });
  move(engine, entity, trail, 0, 0);
  move(engine, entity, trail, 0.5, 0.1);
  assert.equal(trail.pointCount, 2, "half a metre is not a new vertex");
  move(engine, entity, trail, 1.5, 0.2);
  assert.equal(trail.pointCount, 3);
});

await check("the head follows the object between commits (no lag behind it)", () => {
  const { engine, entity, trail } = trailEntity({ minVertexDistance: 10 });
  move(engine, entity, trail, 0, 0);
  move(engine, entity, trail, 3, 0.1);
  const head = trail.points[trail.points.length - 1];
  assert.equal(head.x, 3, "the head is at the object, not at the last commit");
});

await check("points age out by `time`", () => {
  const { engine, entity, trail } = trailEntity({ time: 1, minVertexDistance: 0.5 });
  for (let i = 0; i <= 4; i++) move(engine, entity, trail, i, i * 0.3);
  const before = trail.pointCount;
  move(engine, entity, trail, 4, 3);
  assert.ok(trail.pointCount < before, `${before} → ${trail.pointCount}`);
});

await check("the tail is interpolated to the exact lifetime boundary, not popped", () => {
  const { engine, entity, trail } = trailEntity({ time: 1, minVertexDistance: 0.5 });
  move(engine, entity, trail, 0, 0);
  move(engine, entity, trail, 1, 0.5);
  move(engine, entity, trail, 2, 1);
  // At t=1.25 the oldest point (born at 0) is 0.25s past its 1s life; the next
  // one (born at 0.5) is 0.75s old. The tail should sit a quarter of the way
  // from the first toward the second.
  move(engine, entity, trail, 2, 1.25);
  const buffer = trail.ribbon.buffer;
  const tailIndex = buffer.vertexCount / 2 - 1;
  const tailX = buffer.positions[tailIndex * 6];
  assert.ok(tailX > 0 && tailX < 1, `tail x ${tailX} should be part-way along the last segment`);
  assert.ok(near(buffer.colors[tailIndex * 8 + 3], 0, 0.05), "and be fully faded there");
});

await check("emitting = false stops recording but lets the trail age away", () => {
  const { engine, entity, trail } = trailEntity({ time: 1, minVertexDistance: 0.5 });
  move(engine, entity, trail, 0, 0);
  move(engine, entity, trail, 1, 0.2);
  trail.props.emitting = false;
  move(engine, entity, trail, 5, 0.3);
  assert.equal(trail.pointCount, 3, "no new point while off (the head is unchanged)");
  move(engine, entity, trail, 5, 5);
  assert.equal(trail.pointCount, 0, "and it eventually clears itself");
});

await check("clear() drops the history immediately — what a teleport needs", () => {
  const { engine, entity, trail } = trailEntity({ minVertexDistance: 0.5 });
  for (let i = 0; i < 5; i++) move(engine, entity, trail, i, i * 0.1);
  trail.clear();
  assert.equal(trail.pointCount, 0);
  assert.equal(trail.ribbon.buffer.indexCount, 0);
});

await check("the ramp runs from the OBJECT outward", () => {
  const { engine, entity, trail } = trailEntity({
    time: 10,
    minVertexDistance: 0.5,
    startWidth: 1,
    endWidth: 0,
  });
  move(engine, entity, trail, 0, 0);
  move(engine, entity, trail, 1, 1);
  move(engine, entity, trail, 2, 2);
  const buffer = trail.ribbon.buffer;
  assert.ok(near(buffer.widths[0], 1), "widest at the head");
  assert.ok(buffer.widths[buffer.vertexCount - 1] < buffer.widths[0], "narrowing toward the tail");
  assert.equal(buffer.positions[0], 2, "…and the head is where the object is");
});

await check("it runs on game time: a frozen clock ages nothing", () => {
  const { engine, entity, trail } = trailEntity({ time: 1, minVertexDistance: 0.5 });
  move(engine, entity, trail, 0, 0);
  move(engine, entity, trail, 1, 0.5);
  const count = trail.pointCount;
  // A paused game leaves elapsedTime alone; ticking again must not expire
  // anything, however long the player stares at the pause menu.
  for (let i = 0; i < 10; i++) trail.tick();
  assert.equal(trail.pointCount, count);
});

await check("history is runtime state, so it resets on Stop", () => {
  const { trail } = trailEntity();
  assert.equal(trail.constructor.resetOnStop, true);
});

// ---------------------------------------------------------------------------

section("engine integration");

await check("a frozen frame ages no decal — the engine feeds this GAME time", () => {
  const { decals } = decalEngine();
  const handle = decals.spawn(hit(0, 0, { lifetime: 1, fadeTime: 1 }));
  // What a paused game (or timeScale 0) hands it every frame.
  for (let i = 0; i < 100; i++) decals.update(0);
  assert.equal(decals.decals.length, 1, "a pause menu must not burn through decals");
  assert.equal(handle.fade, 1, "…or fade them");
});

await check("the engine owns a decal system", () => {
  const engine = new Engine();
  assert.ok(engine.decals, "engine.decals");
  assert.equal(typeof engine.decals.spawn, "function");
});

await check("Stop clears decals — a bullet hole must not survive into the editor", () => {
  const engine = new Engine();
  const geometry = new THREE.PlaneGeometry(10, 10);
  geometry.rotateX(-Math.PI / 2);
  engine.scene.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()));
  engine.scene.updateMatrixWorld(true);
  engine.setPlaying(true);
  assert.ok(engine.decals.spawn(hit()), "spawned during play");
  engine.setPlaying(false);
  assert.equal(engine.decals.decals.length, 0);
});

await check("loading another scene does not inherit the last one's decals", () => {
  const engine = new Engine();
  const geometry = new THREE.PlaneGeometry(10, 10);
  geometry.rotateX(-Math.PI / 2);
  engine.scene.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()));
  engine.scene.updateMatrixWorld(true);
  engine.decals.spawn(hit());
  engine.clear({ resetSettings: false });
  assert.equal(engine.decals.decals.length, 0);
});

await check("an authored decal projects onto scene geometry and reports its size", () => {
  const engine = new Engine();
  const floor = engine.createEntity({ name: "Floor" });
  const geometry = new THREE.PlaneGeometry(10, 10);
  geometry.rotateX(-Math.PI / 2);
  floor.object3D.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()));
  engine.scene.updateMatrixWorld(true);

  const projector = engine.createEntity({ name: "Decal" });
  projector.object3D.position.set(0, 0.3, 0);
  projector.object3D.quaternion.copy(decalOrientation(new THREE.Vector3(0, 1, 0)));
  projector.object3D.updateMatrixWorld(true);
  const decal = projector.addComponent("decal", { size: [1, 1, 1] });
  decal.project();
  assert.ok(decal.triangleCount > 0, "expected the floor under it");
  decal.setEnabled(false);
  assert.equal(decal.triangleCount, 0, "disabling takes it off the wall");
});

await check("moving an authored decal re-projects it", () => {
  const engine = new Engine();
  const floor = engine.createEntity({ name: "Floor" });
  const geometry = new THREE.PlaneGeometry(4, 4);
  geometry.rotateX(-Math.PI / 2);
  floor.object3D.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()));
  engine.scene.updateMatrixWorld(true);

  const projector = engine.createEntity({ name: "Decal" });
  projector.object3D.position.set(0, 0.3, 0);
  projector.object3D.quaternion.copy(decalOrientation(new THREE.Vector3(0, 1, 0)));
  const decal = projector.addComponent("decal", { size: [1, 1, 1] });
  for (const fn of engine.preRenderCallbacks) fn();
  assert.ok(decal.triangleCount > 0);
  // Off the edge of the floor: the bake must follow the gizmo, not stay where
  // it was first placed.
  projector.object3D.position.set(50, 0.3, 0);
  for (const fn of engine.preRenderCallbacks) fn();
  assert.equal(decal.triangleCount, 0);
});

console.log(failures ? `\n${failures} check(s) failed` : "\nall VFX checks passed");
process.exit(failures ? 1 : 0);
