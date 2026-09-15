// @ts-check
/**
 * Directional shadow recentring on a world grid, shared by `LightComponent`
 * and the Atmosphere's fallback sun. The centre is quantized in the shadow
 * camera's own basis — right/up across the map, and along the light — so a
 * camera moving inside one cell leaves the light's matrices bit-identical
 * (ShadowFreeze stays engaged) and a step moves the map by whole cells.
 *
 * The basis matches three's `lookAt` for a shadow camera with world-up (0,1,0):
 * right = travel × up, up' = right × travel.
 */

/**
 * @typedef {{ x: number, y: number, z: number }} Vec3Like
 * @typedef {Vec3Like & {
 *   set(x: number, y: number, z: number): any,
 *   crossVectors(a: Vec3Like, b: Vec3Like): any,
 *   lengthSq(): number, normalize(): any, dot(v: Vec3Like): number,
 *   addScaledVector(v: Vec3Like, s: number): any,
 * }} Vec3
 */

/**
 * Writes the map's lateral axes for a light travelling along `direction`.
 * @param {Vec3Like} direction unit travel direction
 * @param {Vec3} right out
 * @param {Vec3} up out
 * @param {Vec3Like} [worldUp]
 */
export function shadowSnapBasis(direction, right, up, worldUp = { x: 0, y: 1, z: 0 }) {
  right.crossVectors(direction, worldUp);
  if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
  else right.normalize();
  up.crossVectors(right, direction).normalize();
}

/**
 * Snaps `centre` in place: `snapX` along `right`, `snapY` along `up`, `snapZ`
 * along `direction`. A step of 0 (or less) leaves that axis continuous.
 * @param {Vec3} centre
 * @param {Vec3Like} direction unit travel direction
 * @param {Vec3Like} right from `shadowSnapBasis`
 * @param {Vec3Like} up from `shadowSnapBasis`
 * @param {number} snapX
 * @param {number} snapY
 * @param {number} snapZ
 */
export function snapShadowCentre(centre, direction, right, up, snapX, snapY, snapZ) {
  if (snapX > 0) {
    const projected = centre.dot(right);
    centre.addScaledVector(right, Math.round(projected / snapX) * snapX - projected);
  }
  if (snapY > 0) {
    const projected = centre.dot(up);
    centre.addScaledVector(up, Math.round(projected / snapY) * snapY - projected);
  }
  if (snapZ > 0) {
    const projected = centre.dot(direction);
    centre.addScaledVector(direction, Math.round(projected / snapZ) * snapZ - projected);
  }
  return centre;
}

/**
 * The largest step ≤ `metres` that is a WHOLE number of texels (at least one).
 * A centre moving by whole texels translates the rasterized map exactly, so a
 * step shows no sub-texel swim along shadow edges.
 * @param {number} metres
 * @param {number} texel world size of one shadow-map texel
 */
export function wholeTexelStep(metres, texel) {
  if (!(texel > 0)) return Math.max(0, metres);
  return Math.max(1, Math.floor(metres / texel)) * texel;
}
