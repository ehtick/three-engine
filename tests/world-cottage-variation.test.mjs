import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createCottageStudy, describeCottageStudy } from '../scripts/lib/worldCottageStudy.js';

function cottage(t, seed, style = 'natural', options = {}) {
  const group = createCottageStudy(THREE, { seed, style, ...options });
  group.updateMatrixWorld(true);
  t.after(() => group.userData.dispose());
  return group;
}

function roofHeight(group, x, z) {
  const roof = group.children.find(mesh => mesh.userData.worldStudyRole === 'roof');
  const hits = new THREE.Raycaster(new THREE.Vector3(x, 20, z), new THREE.Vector3(0, -1, 0)).intersectObject(roof);
  return hits[0]?.point.y ?? null;
}

function openingRay(opening, offset = true) {
  const center = new THREE.Vector3(...opening.center);
  const normal = new THREE.Vector3(...opening.normal);
  if (offset) {
    center.addScaledVector(new THREE.Vector3(normal.z, 0, -normal.x), opening.width * 0.20);
    center.y += opening.height * 0.15;
  }
  return new THREE.Raycaster(center.addScaledVector(normal, 0.45), normal.negate(), 0, 0.76);
}

test('consecutive seeds change constructed roof axes, storeys and footprint topology', t => {
  const classic = cottage(t, 8), farm = cottage(t, 9), tall = cottage(t, 10), wing = cottage(t, 11);
  assert.equal(new Set([classic, farm, tall, wing].map(g => g.userData.study.family)).size, 4);
  assert.equal(new Set([8, 9, 10, 11].map(seed => describeCottageStudy({ seed }).roofColor)).size, 4);

  // Physical raycast comparisons detect the old same-house/different-tint result.
  assert(roofHeight(classic, 0, 0) - roofHeight(classic, 1.5, 0) > 0.55, 'classic roof falls across X');
  assert(Math.abs(roofHeight(classic, 0, 0) - roofHeight(classic, 0, 1.5)) < 0.08, 'classic ridge runs along Z');
  assert(roofHeight(farm, 0, 0) - roofHeight(farm, 0, 1.5) > 0.90, 'farmhouse roof falls across Z');
  assert(Math.abs(roofHeight(farm, 0, 0) - roofHeight(farm, 1.5, 0)) < 0.08, 'farmhouse ridge runs along X');
  const farmDescription = farm.userData.study;
  assert.notEqual(farmDescription.entry.x, 0);
  assert(roofHeight(farm, 3, farmDescription.entry.z + 1.5) > 2.7, 'wide porch has real roofing outside its wall footprint');
  assert.equal(roofHeight(classic, 3, classic.userData.study.entry.z + 1.5), null, 'classic has only a small entry hood');

  assert(roofHeight(tall, 0, 0) > roofHeight(classic, 0, 0) + 2);
  const upperWindows = tall.userData.study.apertures.filter(a => a.kind === 'window' && a.center[1] > 4);
  assert(upperWindows.length >= 8, 'upper floor has actual independent front, rear and side openings');
  const plaster = tall.children.find(mesh => mesh.userData.worldStudyRole === 'plaster');
  const upperWall = new THREE.Raycaster(new THREE.Vector3(0, 5, 6), new THREE.Vector3(0, 0, -1)).intersectObject(plaster);
  assert(upperWall.some(hit => hit.point.z > 3), 'upper storey includes a real wall, not a stretched roof');

  const extension = wing.userData.study.wing;
  assert(roofHeight(wing, extension.x, extension.z) > 3.8, 'side wing has its own lower roof');
  assert(roofHeight(wing, extension.x, extension.z) < roofHeight(wing, -1.8, 0) - 2);
  const rearCorner = new THREE.Raycaster(new THREE.Vector3(extension.x, 20, -2.8), new THREE.Vector3(0, -1, 0)).intersectObjects(wing.children);
  assert.equal(rearCorner.length, 0, 'the L-shaped footprint leaves the rear corner empty');
});

test('all family/style combinations keep genuine openings aligned with glazing and doors', t => {
  for (const style of ['natural', 'stylized']) for (const seed of [8, 9, 10, 11]) {
    const group = cottage(t, seed, style);
    const plaster = group.children.find(mesh => mesh.userData.worldStudyRole === 'plaster');
    const glass = group.children.find(mesh => mesh.userData.worldStudyRole === 'glass');
    const door = group.children.find(mesh => mesh.userData.worldStudyRole === 'door');
    for (const opening of group.userData.study.apertures) {
      const label = `${style} ${seed} ${opening.volume} ${opening.kind} at ${opening.center}`;
      assert.equal(openingRay(opening).intersectObject(plaster).length, 0, `${label}: plaster blocks its opening`);
      const receiver = opening.kind === 'door' ? door : glass;
      assert(openingRay(opening).intersectObject(receiver).length > 0, `${label}: opening has no aligned inset surface`);
    }
    assert(group.children.length <= 12, 'geometry stays merged per material role');
    for (const mesh of group.children) {
      assert(mesh.castShadow && mesh.receiveShadow);
      for (const attribute of Object.values(mesh.geometry.attributes)) {
        assert(attribute.array.every(Number.isFinite), `${mesh.name}: nonfinite geometry attribute`);
      }
    }
  }
});

test('aperture regression detects an uncut wall at the declared window', t => {
  const group = cottage(t, 8);
  const opening = group.userData.study.apertures.find(a => a.kind === 'window' && a.normal[2] > 0.9);
  const wall = new THREE.Mesh(new THREE.BoxGeometry(opening.width, opening.height, 0.3), new THREE.MeshBasicMaterial());
  wall.position.fromArray(opening.center);
  wall.position.z -= 0.15;
  wall.updateMatrixWorld(true);
  assert(openingRay(opening).intersectObject(wall).length > 0, 'negative control must catch painted-on windows');
  wall.geometry.dispose();
  wall.material.dispose();
});

test('seed determinism includes geometry and palettes; roof paint never rebuilds a different form', t => {
  for (const seed of [8, 9, 10, 11]) {
    const generated = cottage(t, seed), repeated = cottage(t, seed), painted = cottage(t, seed, 'natural', { roofColor: '#324f89' });
    assert.deepEqual(describeCottageStudy({ seed }), describeCottageStudy({ seed }));
    assert.equal(generated.userData.study.roofColor, describeCottageStudy({ seed }).roofColor);
    assert.equal(painted.userData.study.roofColor, '#324f89');
    assert.deepEqual(generated.userData.study.apertures, painted.userData.study.apertures);
    for (let i = 0; i < generated.children.length; i++) {
      const a = generated.children[i], b = repeated.children[i], c = painted.children[i];
      assert.equal(a.name, b.name);
      for (const key of Object.keys(a.geometry.attributes)) assert.deepEqual(a.geometry.attributes[key].array, b.geometry.attributes[key].array);
      assert.deepEqual(a.geometry.attributes.position.array, c.geometry.attributes.position.array);
      assert.deepEqual(a.geometry.attributes.normal.array, c.geometry.attributes.normal.array);
      if (a.userData.worldStudyRole === 'roof') assert.notDeepEqual(a.geometry.attributes.color.array, c.geometry.attributes.color.array);
      else assert.deepEqual(a.geometry.attributes.color.array, c.geometry.attributes.color.array);
    }
  }
});

test('every generated family releases all owned geometry, materials and procedural textures exactly once', () => {
  for (const seed of [8, 9, 10, 11]) {
    const materials = [], textures = [];
    const instrumented = {
      ...THREE,
      MeshStandardMaterial: class extends THREE.MeshStandardMaterial {
        constructor(...args) { super(...args); materials.push(this); }
      },
      DataTexture: class extends THREE.DataTexture {
        constructor(...args) { super(...args); textures.push(this); }
      },
    };
    const group = createCottageStudy(instrumented, { seed });
    const resources = [...group.children.map(mesh => mesh.geometry), ...materials, ...textures];
    const disposed = new Map(resources.map(resource => [resource, 0]));
    for (const resource of resources) resource.addEventListener('dispose', () => disposed.set(resource, disposed.get(resource) + 1));
    group.userData.dispose();
    group.userData.dispose();
    for (const count of disposed.values()) assert.equal(count, 1);
    assert.equal(textures.length, 3);
  }
});
