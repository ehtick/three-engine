import * as THREE from 'three/webgpu';
import { attribute, positionWorld, sin } from 'three/tsl';

/**
 * Ground colour for a procedural Terrain and for World's streamed tiles
 * (09-14). The first live receipt showed the untextured default base
 * (#8a8f7a) blown out to white under the sun: the landform read, the land did
 * not. The World paints its own central ground (worldPlan.js) and owns its
 * terrain's material, so the Terrain uses this only without a shape overlay.
 *
 * Colours come from the grid itself, not from re-sampling the landscape (a
 * 257² re-sample is ~200 ms; this is a few ms):
 *   slope      -> rock on faces steeper than ~45 degrees
 *   concavity  -> soil in hollows and channel floors
 *   elevation  -> snow on the top of the relief for styles that have a snowline
 * with the style's own palette.
 *
 * Seam-free tiling: pass a grid padded by `pad` samples on every side (2 covers
 * the widest stencil), the tile's world origin `x0`/`z0`, and one shared
 * `lo`/`hi` height range, and two neighbouring tiles paint identical colours
 * on their shared border.
 */

const clamp = (v, lo = 0, hi = 1) => v < lo ? lo : v > hi ? hi : v;
const smoothstep = (lo, hi, v) => { const t = clamp((v - lo) / (hi - lo)); return t * t * (3 - 2 * t); };

export function paintLandscapeGround(heights, { resolution, size, palette = {}, pad = 0, x0 = 0, z0 = 0, lo = null, hi = null }) {
  const cols = resolution + 1, padded = cols + 2 * pad, step = size / resolution, count = cols * cols;
  const grass = new THREE.Color(palette.grass ?? '#5f7a3a'), soil = new THREE.Color(palette.soil ?? '#6f624c');
  const rock = new THREE.Color(palette.rock ?? '#77736c'), snow = palette.snow ? new THREE.Color(palette.snow) : null;
  const at = (c, r) => heights[Math.min(padded - 1, Math.max(0, r)) * padded + Math.min(padded - 1, Math.max(0, c))];
  if (lo === null || hi === null || !Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = Infinity; hi = -Infinity;
    for (let r = 0; r < cols; r++) for (let c = 0; c < cols; c++) { const h = at(c + pad, r + pad); if (h < lo) lo = h; if (h > hi) hi = h; }
  }
  const range = Math.max(1, hi - lo);
  const colors = new Float32Array(count * 3), color = new THREE.Color();
  for (let r = 0; r < cols; r++) for (let c = 0; c < cols; c++) {
    const pc = c + pad, pr = r + pad, h = at(pc, pr);
    const gx = (at(pc + 1, pr) - at(pc - 1, pr)) / (2 * step), gz = (at(pc, pr + 1) - at(pc, pr - 1)) / (2 * step);
    const slope = Math.hypot(gx, gz);
    // Laplacian over ~2 cells: positive in a hollow.
    const hollow = ((at(pc - 2, pr) + at(pc + 2, pr) + at(pc, pr - 2) + at(pc, pr + 2)) * .25 - h) / (step * 2);
    color.copy(grass)
      .lerp(soil, smoothstep(.02, .12, hollow) * .7 + smoothstep(.35, .6, slope) * .25)
      .lerp(rock, smoothstep(.75, 1.25, slope));
    if (snow) color.lerp(snow, smoothstep(.72, .86, (h - lo) / range) * (1 - smoothstep(.9, 1.5, slope)));
    // Low-frequency brightness variation in WORLD metres, so tiles agree.
    const x = x0 + c * step, z = z0 + r * step;
    color.multiplyScalar(.9 + .1 * Math.sin(x * .043 + Math.sin(z * .031) * 2) * Math.sin(z * .037));
    color.toArray(colors, (r * cols + c) * 3);
  }
  return colors;
}

/** The style palette with a Terrain's own ground colours over it (09-14,
 * `customColors`). A World sets these from its Ground swatches. */
export function resolveGroundPalette(palette = {}, props = {}) {
  if (!props?.customColors) return palette;
  const out = { ...palette };
  if (props.grassColor) out.grass = props.grassColor;
  if (props.soilColor) out.soil = props.soilColor;
  if (props.rockColor) out.rock = props.rockColor;
  return out;
}

export function createLandscapeGroundMaterial() {
  // ⛔ 09-14: NOT `vertexColors: true` — colorNode below already multiplies the
  // `color` attribute, and three multiplies it AGAIN when the flag is on, so every
  // picked colour rendered squared (a #9bbd28 meadow as dark olive-brown).
  const material = new THREE.MeshStandardNodeMaterial({ roughness: .95, metalness: 0 });
  // A faint metre-scale grain so close ground is not plastic.
  const grain = sin(positionWorld.x.mul(1.7)).mul(sin(positionWorld.z.mul(1.3))).mul(.04).add(1);
  material.colorNode = attribute('color', 'vec3').mul(grain);
  material.name = 'Terrain ground · procedural';
  return material;
}
