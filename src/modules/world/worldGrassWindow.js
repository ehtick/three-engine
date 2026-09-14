import * as THREE from 'three/webgpu';
import { sampleGrassField, grassSwardTones } from '../foliage/grassField.js';

/**
 * The drawn sward for a streamed World (09-14, T6). The grass renderer draws
 * three rings around the camera from ONE packed field texture; the World's own
 * field covers only its authored region. This keeps a camera-centred window
 * field instead: inside the region it copies the region's field (exact, the
 * same banks and paths), outside it grows from the streamed landscape — the
 * same density terms, sampled from the landscape and its hydrology.
 *
 * The window re-centres (snapped) once the camera has moved a quarter of it,
 * packing sliced on a clock and handing over a complete field in one go; the
 * renderer rewrites its textures in place (same channels), never a new material.
 * Memory: one window, `size² × 4 × 2` float32 bytes (data + ground colour).
 */
export class GrassWindow {
  constructor({ fieldAt, region = null, regionHalf = 0, span = 256, size = 257, grass = {}, palette = {} }) {
    this.fieldAt = fieldAt;
    this.region = region; this.regionHalf = regionHalf;
    this.span = span; this.size = size;
    this.snap = span / 4;
    this.centre = null; this.job = null; this.field = null;
    // The blade tones as the renderer really draws them (tip/dry clamps included).
    const tones = grassSwardTones(grass.color, grass.dryColor);
    this.root = tones.base; this.tip = tones.tip; this.dry = tones.dry;
    this.ground = new THREE.Color(palette.grass ?? '#5f7a3a');
    this.work = { root: new THREE.Color(), tipTone: new THREE.Color(), mean: new THREE.Color() };
  }

  /** A new terrain grass colour: re-pack around the same centre. */
  setGround(colour) {
    if (!colour) return;
    this.ground.set(colour);
    this.job = null;
    if (this.centre) this.job = { centre: this.centre, steps: this.#packSteps(this.centre) };
  }

  /** A new region field (a World commit): re-pack around the same centre. */
  setRegion(field, regionHalf = this.regionHalf) {
    this.region = field; this.regionHalf = regionHalf;
    this.job = null;
    if (this.centre) this.job = { centre: this.centre, steps: this.#packSteps(this.centre) };
  }

  get bytes() { return this.field ? this.field.data.byteLength + (this.field.ground?.byteLength ?? 0) : 0; }

  /** Once per frame; returns a finished field when one is ready to hand to the meadow. */
  update(x, z, clock) {
    const cx = Math.round(x / this.snap) * this.snap, cz = Math.round(z / this.snap) * this.snap;
    const target = this.job?.centre ?? this.centre;
    if (!target || target[0] !== cx || target[1] !== cz) this.job = { centre: [cx, cz], steps: this.#packSteps([cx, cz]) };
    while (this.job && !clock.due()) {
      const result = this.job.steps.next();
      if (!result.done) continue;
      this.centre = this.job.centre; this.field = result.value; this.job = null;
      return this.field;
    }
    return null;
  }

  *#packSteps([cx, cz]) {
    const { size, span } = this, half = span / 2, step = span / (size - 1);
    const data = new Float32Array(size * size * 4), ground = new Float32Array(size * size * 4);
    const region = this.region, edge = this.regionHalf - step;
    const { root, tipTone, mean } = this.work;
    for (let row = 0; row < size; row++) {
      yield 'grass';
      const z = cz - half + row * step;
      for (let column = 0; column < size; column++) {
        const x = cx - half + column * step, index = (row * size + column) * 4;
        if (region && Math.abs(x) <= edge && Math.abs(z) <= edge) {
          const value = sampleGrassField(region, x, z);
          data[index] = value.height; data[index + 1] = value.density; data[index + 2] = value.scale; data[index + 3] = value.dryness;
          if (region.ground) {
            const colour = sampleGround(region, x, z);
            ground[index] = colour[0]; ground[index + 1] = colour[1]; ground[index + 2] = colour[2];
          }
          ground[index + 3] = 1;
          continue;
        }
        const f = this.fieldAt(x, z);
        // The World field's own density terms (worldPlanData.js packGrassField call).
        const dry = THREE.MathUtils.smoothstep(f.shore, 1, 3.4);
        const density = dry * (1 - f.rock) * (1 - f.forest * .3) * (.6 + f.moisture * .45) * (1 - Math.max(f.path ?? 0, f.pad ?? 0));
        const dryness = Math.max(0, 1 - f.moisture * 1.5);
        data[index] = f.height; data[index + 1] = density; data[index + 2] = .72 + f.moisture * .62; data[index + 3] = dryness;
        // 09-14: the ground under the streamed sward is the terrain's own colour
        // (the streamed tiles' grass role) — the blades converge onto it.
        ground[index] = this.ground.r; ground[index + 1] = this.ground.g; ground[index + 2] = this.ground.b; ground[index + 3] = 1;
      }
    }
    return { data, ground, size, extent: span, origin: [cx, cz] };
  }
}

function sampleGround(packed, x, z) {
  const { ground, size, extent, origin } = packed, half = extent / 2;
  const u = Math.max(0, Math.min(1, (x - origin[0] + half) / extent)) * (size - 1);
  const v = Math.max(0, Math.min(1, (z - origin[1] + half) / extent)) * (size - 1);
  const column = Math.min(size - 2, Math.floor(u)), row = Math.min(size - 2, Math.floor(v)), fx = u - column, fz = v - row;
  const out = [0, 0, 0];
  for (let channel = 0; channel < 3; channel++) {
    const at = (r, c) => ground[(r * size + c) * 4 + channel];
    out[channel] = (at(row, column) * (1 - fx) + at(row, column + 1) * fx) * (1 - fz) + (at(row + 1, column) * (1 - fx) + at(row + 1, column + 1) * fx) * fz;
  }
  return out;
}
