import * as THREE from 'three/webgpu';
import { MAX_FOLIAGE_INSTANCES } from './foliageScatter.js';

/** Persisted local-space plant placements, shared by generated and authored
 * populations. IDs belong to the caller; changing shape never rerolls them.
 * Applies transforms, not terrain reseating or topology repair. */
export function resolveFoliagePlacements(placements, worldMatrix) {
  if (!Array.isArray(placements) || placements.length > MAX_FOLIAGE_INSTANCES) throw new RangeError(`Foliage placements must be an array of at most ${MAX_FOLIAGE_INSTANCES} plants`);
  const ids = new Set(), position = new THREE.Vector3(), rotation = new THREE.Euler(), quaternion = new THREE.Quaternion(), scale = new THREE.Vector3();
  const vector = (value, fallback, label) => {
    const result = value ?? fallback;
    if (!Array.isArray(result) || result.length !== 3 || !result.every(Number.isFinite)) throw new TypeError(`Invalid foliage placement ${label}`);
    return result;
  };
  return Array.from(placements, plant => {
    if (!plant || typeof plant.id !== 'string' || !plant.id || ids.has(plant.id)) throw new TypeError('Foliage placements require unique nonempty IDs');
    ids.add(plant.id);
    position.fromArray(vector(plant.position, null, 'position'));
    rotation.set(...vector(plant.rotation, [0, 0, 0], 'rotation'));
    const size = plant.scale ?? 1;
    if (!Number.isFinite(size) || size <= 0 || size > 1000) throw new RangeError('Foliage placement scale must be positive and at most 1000');
    quaternion.setFromEuler(rotation); scale.setScalar(size);
    const matrix = new THREE.Matrix4().compose(position, quaternion, scale).premultiply(worldMatrix);
    if (!matrix.elements.every(value => Number.isFinite(Math.fround(value)))) throw new RangeError('Foliage placement transform must fit finite float32 values');
    matrix.decompose(position, quaternion, scale);
    return { id: plant.id, position: position.toArray(), quaternion: quaternion.toArray(),
      normal: [0, 1, 0], scale: Math.max(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z)), matrix };
  });
}
