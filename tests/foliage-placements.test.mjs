import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { resolveFoliagePlacements } from '../src/modules/foliage/foliagePlacements.js';
import { MAX_FOLIAGE_INSTANCES } from '../src/modules/foliage/foliageScatter.js';
import { FoliageComponent } from '../src/modules/foliage/FoliageComponent.js';

test('default authored lists are instance-owned while explicit placement props retain their contract', () => {
  const first = new FoliageComponent(), other = new FoliageComponent();
  first.placements.push({ id: 'authored:oak', position: [2, 0, 3] });
  assert.equal(first.toJSON().props.placements.length, 1);
  assert.deepEqual(other.toJSON().props.placements, [], 'an edit cannot become another layer\'s saved data');
  assert.deepEqual(new FoliageComponent().toJSON().props.placements, [], 'later components do not inherit previously authored plants');
  assert.deepEqual(FoliageComponent.defaults.placements, [], 'the class default stays unmodified');

  const explicit = [{ id: 'provided:oak', position: [0, 0, 0] }];
  assert.equal(new FoliageComponent({ placements: explicit }).placements, explicit, 'explicit props keep their existing reference semantics');
  const invalid = new FoliageComponent({ placements: null });
  assert.equal(invalid.placements, null, 'an invalid explicit list is not silently replaced');
  assert.throws(() => resolveFoliagePlacements(invalid.placements, new THREE.Matrix4()), RangeError);
});

test('authored placements keep IDs and exact local-to-world transforms without mutating either input', () => {
  const placements = Object.freeze([
    Object.freeze({ id: 'oak:0', position: Object.freeze([2, 3, -4]), rotation: Object.freeze([.2, .7, -.1]), scale: .8 }),
    Object.freeze({ id: 'birch:7', position: Object.freeze([-1, .5, 6]) }),
  ]);
  const parent = new THREE.Object3D();
  parent.position.set(40, 6, -18); parent.rotation.set(.13, .67, -.2); parent.scale.set(2, 3, .7); parent.updateMatrix();
  const before = parent.matrix.toArray(), result = resolveFoliagePlacements(placements, parent.matrix);
  assert.deepEqual(result.map(plant => plant.id), placements.map(plant => plant.id));
  for (let i = 0; i < placements.length; i++) {
    const source = placements[i], local = new THREE.Object3D();
    local.position.fromArray(source.position); local.rotation.set(...(source.rotation ?? [0, 0, 0])); local.scale.setScalar(source.scale ?? 1);
    parent.add(local); parent.updateMatrixWorld(true);
    assert.deepEqual(result[i].matrix.toArray(), local.matrixWorld.toArray(), 'retain shear from a rotated plant under a nonuniform parent');
    assert.ok(new THREE.Vector3(...result[i].position).distanceTo(local.getWorldPosition(new THREE.Vector3())) < 1e-12);
    assert.ok(result[i].matrix.elements.every(Number.isFinite));
  }
  assert.deepEqual(parent.matrix.toArray(), before);
  result[0].position[0] = 999; result[0].matrix.elements[12] = 999;
  const again = resolveFoliagePlacements(placements, parent.matrix);
  assert.notEqual(again[0].position[0], 999, 'resolved runtime state cannot rewrite persisted anchors');
  assert.deepEqual(resolveFoliagePlacements([], parent.matrix), []);
});

test('authored placement validation rejects duplicate IDs, malformed vectors and unrenderable transforms', () => {
  const identity = new THREE.Matrix4(), valid = { id: 'plant', position: [0, 0, 0] };
  for (const invalid of [null, {}, [null], [{ ...valid, id: '' }], [{ ...valid, id: 2 }], [valid, valid],
    [{ ...valid, position: [0, 0] }], [{ ...valid, position: [0, NaN, 0] }],
    [{ ...valid, rotation: [0, Infinity, 0] }], [{ ...valid, scale: 0 }], [{ ...valid, scale: -1 }],
    [{ ...valid, scale: 1001 }], [{ ...valid, scale: Infinity }],
    new Array(2), [{ ...valid, position: [1e100, 0, 0] }]]) {
    assert.throws(() => resolveFoliagePlacements(invalid, identity), undefined, `invalid authored input: ${JSON.stringify(invalid)}`);
  }
  const overflow = new THREE.Matrix4().makeScale(1e100, 1, 1);
  assert.throws(() => resolveFoliagePlacements([valid], overflow), undefined, 'finite doubles must not become infinite GPU Float32 matrices');
});

test('authored placement cap accepts its boundary and rejects overflow before resolving any plants', () => {
  const list = Array.from({ length: MAX_FOLIAGE_INSTANCES }, (_, i) => ({ id: `plant:${i}`, position: [i % 100, 0, Math.floor(i / 100)] }));
  const result = resolveFoliagePlacements(list, new THREE.Matrix4());
  assert.equal(result.length, MAX_FOLIAGE_INSTANCES);
  assert.equal(result.at(-1).id, list.at(-1).id, 'the last permitted authored ID is never silently dropped');
  let visited = false;
  const overflow = new Array(MAX_FOLIAGE_INSTANCES + 1);
  Object.defineProperty(overflow, 0, { get() { visited = true; return list[0]; } });
  assert.throws(() => resolveFoliagePlacements(overflow, new THREE.Matrix4()), RangeError);
  assert.equal(visited, false, 'oversize input is rejected before allocating resolved matrices');
});
