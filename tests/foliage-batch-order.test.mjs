import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import Attributes from 'three/src/renderers/common/Attributes.js';
import { AttributeType } from 'three/src/renderers/common/Constants.js';
import { Entity } from '../src/engine/Entity.js';
import { EventEmitter } from '../src/engine/EventEmitter.js';
import { FOLIAGE_TIER_SLACK, FoliageComponent } from '../src/modules/foliage/FoliageComponent.js';

function fixture(props = {}, parentTransform = null) {
  const engine = new EventEmitter();
  Object.assign(engine, { scene: new THREE.Scene(), entities: new Map(), rootEntities: [], camera: new THREE.PerspectiveCamera(), playing: false, deltaTime: .016, viewOnlyComponents: new Set() });
  engine.getEntity = id => engine.entities.get(id); engine.onPreRender = fn => engine.on('preRender', fn);
  engine.camera.position.set(0, 2, 65); engine.camera.lookAt(0, 2, 0);
  const parent = new Entity(engine, { id: 'parent' }); engine.entities.set(parent.id, parent); parent.setParent(null);
  if (parentTransform) parent.setTransform(parentTransform);
  const entity = new Entity(engine, { id: 'plants' }); engine.entities.set(entity.id, entity); entity.setParent(parent);
  const placements = [];
  for (const z of [-48, -24, 0, 24, 48]) for (const x of [-8, 8]) placements.push({ id: `${x}/${z}`, position: [x, 0, z], rotation: [0, .15 * placements.length, 0], scale: .8 + placements.length * .03 });
  const component = entity.addComponent(new FoliageComponent({ species: 'grass', drawnGrass: false, distribution: 'placements', placements,
    height: .6, width: .5, chunkSize: 6, lodNear: 10000, lodFar: 20000, maxDistance: 30000, runInEditor: true, ...props }));
  let commits = 0, uploads = 0;
  const commit = component._commitBatches;
  component._commitBatches = function () { commits++; return commit.call(this); };
  const attributes = new Attributes({ createAttribute() {}, updateAttribute() { uploads++; } }, { createAttribute() {} });
  const submit = () => component.renderMeshes.forEach(mesh => {
    if (mesh.instanceMatrix) attributes.update(mesh.instanceMatrix, AttributeType.VERTEX);
    else for (const name of ['aCenter', 'aSize', 'aAxisX', 'aAxisY']) attributes.update(mesh.geometry.attributes[name], AttributeType.VERTEX);
  });
  const step = () => { component.update(); submit(); };
  submit();
  return { engine, parent, entity, component, placements, step, submit, counters: () => ({ commits, uploads }), cleanup: () => entity.removeComponent('foliage') };
}

function matrices(component, lod = 0) {
  const mesh = component.renderMeshes[lod], matrix = new THREE.Matrix4(), result = [];
  for (let i = 0; i < mesh.count; i++) { mesh.getMatrixAt(i, matrix); result.push([...matrix.elements]); }
  return result;
}
const canonical = c => c.chunks.filter(chunk => chunk.level === 0).flatMap(chunk => chunk.instances.map(instance => instance.matrix.elements.map(Math.fround)));
const membership = rows => rows.map(row => JSON.stringify(row)).sort();
function yaw(camera, degrees) { camera.rotation.set(0, THREE.MathUtils.degToRad(degrees), 0); }

test('⚡ a walking camera re-walks chunk tiers only after moving half the tier slack', () => {
  // 09-14, Complex scene: the per-frame walk flipped some chunk's mask almost
  // every frame, so a commit pass + instance upload ran every frame (~1.4 ms
  // per population). The `__foliageTierSlack = 0` arm is the negative control.
  const run = slack => {
    const previous = globalThis.__foliageTierSlack;
    globalThis.__foliageTierSlack = slack;
    const f = fixture({ lodNear: 20, lodFar: 50, maxDistance: 300 });
    try {
      const c = f.component;
      let walks = 0;
      const current = c._tierMasksCurrent;
      c._tierMasksCurrent = function (...args) { const fresh = current.apply(this, args); if (!fresh) walks++; return fresh; };
      f.step(); f.step();
      walks = 0;
      const before = f.counters();
      for (let i = 0; i < 100; i++) { f.engine.camera.position.z -= .1; f.engine.camera.updateMatrixWorld(); f.step(); }
      const after = f.counters();
      return { walks, commits: after.commits - before.commits, uploads: after.uploads - before.uploads };
    } finally {
      f.cleanup();
      if (previous === undefined) delete globalThis.__foliageTierSlack; else globalThis.__foliageTierSlack = previous;
    }
  };
  const perFrame = run(0), slack = run(FOLIAGE_TIER_SLACK);
  assert.equal(perFrame.walks, 100, 'negative control: without slack every frame re-walks every chunk');
  assert.ok(slack.walks <= 10 / (FOLIAGE_TIER_SLACK / 2) + 1, `a 10 m walk re-walks once per ${FOLIAGE_TIER_SLACK / 2} m (${slack.walks} walks)`);
  assert.ok(slack.commits <= perFrame.commits, `slack never commits more (${slack.commits} vs ${perFrame.commits})`);
  assert.ok(slack.uploads <= perFrame.uploads, `slack never uploads more (${slack.uploads} vs ${perFrame.uploads})`);
});

test('opaque packing orders real world matrices without changing canonical chunks, roots or casters', () => {
  const f = fixture();
  try {
    const c = f.component, chunks = [...c.chunks], source = c.chunks.map(chunk => chunk.meshes[0].instanceMatrix.array.slice());
    const authored = structuredClone(c.props.placements), ids = c.instances.map(instance => instance.id);
    const old = canonical(c), actual = matrices(c);
    assert.notDeepEqual(actual, old, 'the old back-to-front stream is the negative control');
    assert.deepEqual(membership(actual), membership(old), 'every world matrix survives exactly once');
    const depths = actual.map(matrix => -matrix[14]);
    assert.ok(depths.every((depth, i) => i === 0 || depth >= depths[i - 1]), 'actual submitted instances start at the nearest chunks');
    assert.ok(old.some((row, i) => i && -row[14] < -old[i - 1][14]), 'canonical row order fails the same depth check');
    yaw(f.engine.camera, 100); f.step();
    assert.deepEqual(c.chunks, chunks); source.forEach((array, i) => assert.deepEqual(c.chunks[i].meshes[0].instanceMatrix.array, array));
    assert.deepEqual(c.props.placements, authored); assert.deepEqual(c.instances.map(instance => instance.id), ids);
    assert.equal(c.renderMeshes[0].count, f.placements.length);
    assert.ok(c.renderMeshes.every(mesh => mesh.castShadow), 'all native shadow casters remain enabled, including behind the camera');
    assert.deepEqual(membership(matrices(c)), membership(old));
  } finally { f.cleanup(); }
});

test('stationary, translated and within-bin cameras upload nothing; a crossing commits once with hysteresis', () => {
  const f = fixture();
  try {
    for (let i = 0; i < 10; i++) f.step();
    f.engine.camera.position.add(new THREE.Vector3(50, 5, -20)); f.step();
    yaw(f.engine.camera, 20); f.step();
    assert.deepEqual(f.counters(), { commits: 0, uploads: 0 });
    yaw(f.engine.camera, 32); f.step();
    assert.equal(f.counters().commits, 1); assert.ok(f.counters().uploads > 0);
    const crossed = f.counters();
    for (const angle of [24, 22, 21, 23, 25, 45]) { yaw(f.engine.camera, angle); f.step(); }
    assert.deepEqual(f.counters(), crossed, 'crossing back over the geometric boundary does not chatter');
    f.engine.camera.rotation.order = 'YXZ';
    f.engine.camera.rotation.x = THREE.MathUtils.degToRad(14); f.step();
    assert.deepEqual(f.counters(), crossed, 'small pitch changes also retain the existing upload');
    f.engine.camera.rotation.x = THREE.MathUtils.degToRad(24); f.step();
    assert.equal(f.counters().commits, crossed.commits + 1);
    const pitched = f.counters();
    for (const angle of [20, 16, 14, 19]) { f.engine.camera.rotation.x = THREE.MathUtils.degToRad(angle); f.step(); }
    assert.deepEqual(f.counters(), pitched, 'pitch boundaries have the same dead band');
  } finally { f.cleanup(); }
});

test('paused or windless shadow casters retain their last packing across camera turns', () => {
  for (const props of [{ runInEditor: false }, { wind: false }]) {
    const f = fixture(props);
    try { yaw(f.engine.camera, 130); f.step(); assert.deepEqual(f.counters(), { commits: 0, uploads: 0 }); }
    finally { f.cleanup(); }
  }
  const f = fixture();
  try {
    const before = matrices(f.component);
    f.component.setProp('runInEditor', false); yaw(f.engine.camera, 140); f.step();
    assert.deepEqual(f.counters(), { commits: 0, uploads: 0 }); assert.deepEqual(matrices(f.component), before);
    f.component.setProp('runInEditor', true); f.step(); assert.equal(f.counters().commits, 1);
  } finally { f.cleanup(); }
  const ground = fixture({ castShadow: false, runInEditor: false });
  try { yaw(ground.engine.camera, 120); ground.step(); assert.equal(ground.counters().commits, 1, 'non-casters can reorder while editor animation is held'); }
  finally { ground.cleanup(); }
});

test('transparent, non-depth-writing and non-depth-tested materials restore canonical order', () => {
  for (const [key, value] of [['transparent', true], ['depthWrite', false], ['depthTest', false], ['transmission', .5]]) {
    const f = fixture();
    try {
      f.component.material[key] = value; f.step();
      assert.deepEqual(matrices(f.component), canonical(f.component), key);
      const before = f.counters(); yaw(f.engine.camera, 160); f.step(); assert.deepEqual(f.counters(), before, key);
    } finally { f.cleanup(); }
  }
});

test('diagnostic old packing arm restores actual row order and stops orientation uploads', () => {
  const previous = globalThis.__foliageFrontToBack, f = fixture();
  try {
    globalThis.__foliageFrontToBack = false; f.step(); assert.deepEqual(matrices(f.component), canonical(f.component));
    const before = f.counters(); yaw(f.engine.camera, 170); f.step(); assert.deepEqual(f.counters(), before);
    globalThis.__foliageFrontToBack = true; f.step(); assert.equal(f.counters().commits, before.commits + 1);
  } finally { globalThis.__foliageFrontToBack = previous; f.cleanup(); }
});

test('camera parent direction and mirrored, rotated, scaled plant parents use world coordinates exactly once', () => {
  const f = fixture();
  try {
    f.parent.position.set(17, 4, -12); f.parent.rotation.set(.2, .75, -.1); f.parent.scale.set(-1.7, 1.2, .6);
    const cameraParent = new THREE.Group(); cameraParent.rotation.y = Math.PI / 2; cameraParent.add(f.engine.camera);
    f.engine.scene.add(cameraParent); f.component.update(true); f.submit();
    const direction = f.engine.camera.getWorldDirection(new THREE.Vector3());
    const expectedChunks = [...f.component.chunks].sort((a, b) => a.detailBounds.getCenter(new THREE.Vector3()).dot(direction) - b.detailBounds.getCenter(new THREE.Vector3()).dot(direction));
    const expected = expectedChunks.flatMap(chunk => chunk.instances.map(instance => instance.matrix.elements.map(Math.fround)));
    assert.deepEqual(matrices(f.component), expected, 'nested camera direction orders the already-transformed world bounds');
    const transforms = f.placements.map(plant => {
      const object = new THREE.Object3D(); object.position.fromArray(plant.position); object.rotation.set(...plant.rotation); object.scale.setScalar(plant.scale); object.updateMatrix();
      return f.entity.object3D.matrixWorld.clone().multiply(object.matrix).elements.map(Math.fround);
    });
    assert.deepEqual(membership(matrices(f.component)), membership(transforms));
  } finally { f.cleanup(); }
});

test('impostor repacks retain center, size and both rotation axes in the same source order', () => {
  const f = fixture();
  try {
    const c = f.component;
    c._atlasEntry = { atlas: { center: new THREE.Vector3(0, .3, 0), radius: .7, dispose() {} }, material: new THREE.MeshStandardNodeMaterial(), refs: 1, cache: new Map(), key: 'order fixture' };
    c._buildImpostors(); c.setProp('lodNear', 1); c.setProp('lodFar', 2); f.step();
    assert.equal(c.renderMeshes[2].geometry.instanceCount, f.placements.length);
    for (const angle of [0, 90, 180, -90]) {
      yaw(f.engine.camera, angle); f.step();
      const chunks = [...c.chunks].sort((a, b) => {
        const pointA = a.detailBounds.getCenter(new THREE.Vector3()), pointB = b.detailBounds.getCenter(new THREE.Vector3()), d = c._orderDirection;
        return (pointA.x - pointB.x) * d.x + (pointA.y - pointB.y) * d.y + (pointA.z - pointB.z) * d.z;
      });
      for (const name of ['aCenter', 'aSize', 'aAxisX', 'aAxisY']) {
        const expected = chunks.flatMap(chunk => [...chunk.meshes[2].geometry.attributes[name].array]);
        // 09-14: batch capacities are stable sizes (instanceCapacity.js), so the
        // attribute arrays carry unused tail capacity past the committed instances.
        const attribute = c.renderMeshes[2].geometry.attributes[name];
        assert.equal(expected.length, c.renderMeshes[2].geometry.instanceCount * attribute.itemSize, name + ": every committed instance is compared");
        assert.deepEqual([...attribute.array.slice(0, expected.length)], expected, name);
      }
      assert.equal(c.renderMeshes[2].castShadow, true);
    }
  } finally { f.cleanup(); }
});

/** ⭐⭐ §batch-order-generation regression (P1-B, 09-13): the reported bug was
 * that a tier's resumable job, once it finished and its `_orderSpread` slot
 * went back to `null`, got unconditionally recreated and re-walked from
 * scratch on the very next `_commitBatches()` call SIMPLY because a SIBLING
 * tier's job was still spread across frames — and because a job's matching
 * test read live per-chunk state, two jobs at different cursor speeds could
 * see the SAME chunk under two DIFFERENT tier assignments (one from before a
 * reassignment, one from after) and BOTH commit it.
 *
 * 46 chunks start far from the camera (tier1) and 24 start close (tier0),
 * arranged so depth-sorted traversal visits the far block first: tier1's job
 * finds a match on every step from the start, while tier0's job must
 * free-skip the whole far block before finding its first match, so after a
 * few `update()`s tier0's cursor sits AHEAD of tier1's (having consumed the
 * free skip) even though both have made the same number of real matches.
 * Moving the camera to sit among the (now former) far block SWAPS which
 * group is tier0 and which is tier1 — a full reassignment, not a trickle —
 * while both jobs are still mid-flight from the pre-move layout. Under the
 * bug this produces a genuine, multi-frame window where a chunk's instances
 * are committed into BOTH render meshes at once (checked at every step
 * below, not just the final one — the old code DOES eventually converge to a
 * correct final state once nothing keeps perturbing it, so only a step that
 * is fully settled and stationary end-to-end, like the checkpoint further
 * below, would miss a transient double-count that self-heals before then).
 *
 * A render mesh's very FIRST commit is always synchronous and full now
 * (`_tierEverCommitted`, "the disappearing logs" follow-up — a resumable
 * job's own debut has no earlier picture to fall back on while it spreads),
 * so the fixture no longer starts "not yet settled" after a few stationary
 * update()s; the swap below is what puts both tiers' jobs into genuine
 * mid-flight for the rest of this test to probe. */
test('a resumable spread job never shows the same chunk in two tiers while a sibling job still catches up', () => {
  const engine = new EventEmitter();
  Object.assign(engine, { scene: new THREE.Scene(), entities: new Map(), rootEntities: [], camera: new THREE.PerspectiveCamera(), playing: false, deltaTime: .016, viewOnlyComponents: new Set() });
  engine.getEntity = id => engine.entities.get(id); engine.onPreRender = fn => engine.on('preRender', fn);
  engine.camera.position.set(0, 2, 0);
  const entity = new Entity(engine, { id: 'spread reassign' }); engine.entities.set(entity.id, entity); entity.setParent(null);
  const placements = [];
  // Far block: clustered around z≈522 so that, once the camera moves there,
  // every one of these 46 becomes a tier0 match.
  for (let i = 0; i < 46; i++) placements.push({ id: `far${i}`, position: [0, 0, 500 + i], rotation: [0, 0, 0], scale: 1 });
  // Near block: right next to the camera's STARTING position, so it starts
  // as the tier0 group, then becomes solidly tier1 (>>lodFar away) once the
  // camera moves to the far block.
  for (let i = 0; i < 24; i++) placements.push({ id: `near${i}`, position: [0, 0, i], rotation: [0, 0, 0], scale: 1 });
  const component = entity.addComponent(new FoliageComponent({ species: 'grass', drawnGrass: false, distribution: 'placements', placements,
    height: .6, width: .5, chunkSize: 1, lodNear: 60, lodFar: 120, maxDistance: 2e6, runInEditor: true, castShadow: false }));
  try {
    assert.ok(component.chunks.length > 48, 'exceeds the spread threshold (FOLIAGE_ORDER_SPREAD_CHUNKS)');
    const total = component.instances.length;
    assert.equal(total, 70);
    // The very first update() already fully settles both tiers' debut commit.
    component.update();
    assert.equal(component.renderMeshes[0].count, 24, 'near block settles into tier0 on the first, synchronous commit');
    assert.equal(component.renderMeshes[1].count, 46, 'far block — forced off the not-yet-baked impostor tier — settles into tier1 on the first commit');
    // A full swap: the group that was tier0 becomes tier1 and vice versa,
    // while both jobs are still mid-flight from the pre-move assignment.
    //
    // ⭐ P1-B follow-up ("the disappearing logs" receipt, item 1): a
    // resumable job's own debut aside, a chunk's `commitMask` is now allowed
    // to GROW mid-pass (`§mid-pass-accretion` in `FoliageComponent.js`) so a
    // newly-needed bit is never left waiting a whole extra pass — the
    // deliberate trade-off is that a chunk mid-transition may briefly sit in
    // BOTH the tier it is leaving and the tier it is entering (an over-bright
    // dither for a couple of frames, item 2d) rather than in NEITHER (the far
    // worse failure this whole receipt exists to close). This teleport — an
    // instantaneous, no-crossfade reassignment of the WHOLE scatter, not a
    // gradual walk — is exactly the scenario that trade-off trades against,
    // so a BRIEF overlap right after the jump is expected; what must not
    // happen is a PERMANENT one that never resolves.
    engine.camera.position.set(0, 2, 522);
    let sawOverlap = false, settledSinceOverlap = false;
    for (let i = 0; i < 60; i++) {
      component.update();
      const near = membership(matrices(component, 0)), mid = membership(matrices(component, 1));
      const overlap = near.filter(row => mid.includes(row));
      if (overlap.length) {
        assert.ok(!settledSinceOverlap, `step ${i}: chunk(s) committed into both tier0 and tier1 again after already clearing — not a brief, self-healing transient`);
        sawOverlap = true;
      } else if (sawOverlap) settledSinceOverlap = true;
      assert.ok(near.length + mid.length <= total, `step ${i}: ${near.length + mid.length} committed instances exceeds the ${total} that exist`);
    }
    assert.ok(settledSinceOverlap, 'the swap must actually exercise a transient overlap that then clears, or this receipt never touches the accretion path it claims to');
    // And it actually finishes somewhere correct, not just "no overlap while
    // stuck at zero": every instance is accounted for exactly once, split
    // between the two tiers by the FINAL, settled camera position.
    assert.equal(component.renderMeshes[0].count, 46, 'the (now close) former far block settles into tier0');
    assert.equal(component.renderMeshes[1].count, 24, 'the (now far) former near block settles into tier1');
  } finally { entity.removeComponent('foliage'); }
});

/** ⭐ P1-B item 2d: a duplicate — the same instance committed twice into ONE
 * tier's buffer — reads as a brighter dither at that spot, not a coverage
 * gap: two identical, opaque, alpha-tested draws of the same silhouette from
 * the same screen-door mask both survive at full opacity where a single draw
 * would only survive at its fractional weight. This walks the camera in
 * small, continuous 0.5 m steps (never a single big jump, unlike the
 * reassignment test above) across a >48-chunk scatter so `_batchVersion`
 * keeps bumping while jobs are still mid-flight, and checks every tier's
 * committed buffer for a repeated row on every single step. */
test('a continuously moving camera never commits the same instance twice within one tier across the >48-chunk spread path', () => {
  const engine = new EventEmitter();
  Object.assign(engine, { scene: new THREE.Scene(), entities: new Map(), rootEntities: [], camera: new THREE.PerspectiveCamera(), playing: false, deltaTime: .016, viewOnlyComponents: new Set() });
  engine.getEntity = id => engine.entities.get(id); engine.onPreRender = fn => engine.on('preRender', fn);
  const entity = new Entity(engine, { id: 'dup-guard' }); engine.entities.set(entity.id, entity); entity.setParent(null);
  const placements = [];
  for (let i = 0; i < 90; i++) placements.push({ id: `p${i}`, position: [(i % 6) - 3, 0, i * 3], rotation: [0, 0, 0], scale: .6 + (i % 5) * .3 });
  const component = entity.addComponent(new FoliageComponent({ species: 'grass', drawnGrass: false, distribution: 'placements', placements,
    height: .6, width: .5, chunkSize: 3, lodNear: 30, lodFar: 80, maxDistance: 400, runInEditor: true, castShadow: false }));
  try {
    assert.ok(component.chunks.length > 48, 'exceeds the spread threshold');
    component._atlasEntry = { atlas: { center: new THREE.Vector3(0, .3, 0), radius: .7, dispose() {} }, material: new THREE.MeshStandardNodeMaterial(), refs: 1, cache: new Map(), key: 'dup guard' };
    component._buildImpostors();
    engine.camera.position.set(0, 2, 0);
    const matrix = new THREE.Matrix4();
    for (let z = 0; z <= 270; z += .5) {
      engine.camera.position.set(0, 2, z);
      component.update();
      for (let lod = 0; lod < 2; lod++) {
        const mesh = component.renderMeshes[lod], rows = [];
        for (let i = 0; i < mesh.count; i++) { mesh.getMatrixAt(i, matrix); rows.push(matrix.elements.map(Math.fround).join(',')); }
        assert.equal(new Set(rows).size, rows.length, `z=${z}: tier ${lod} committed a duplicate instance in one buffer`);
      }
      const impostor = component.renderMeshes[2];
      if (impostor) {
        const attr = impostor.geometry.attributes.aCenter, keys = [];
        for (let i = 0; i < impostor.geometry.instanceCount; i++) keys.push(`${attr.getX(i)},${attr.getY(i)},${attr.getZ(i)}`);
        assert.equal(new Set(keys).size, keys.length, `z=${z}: impostor tier committed a duplicate instance`);
      }
    }
  } finally { entity.removeComponent('foliage'); }
});
