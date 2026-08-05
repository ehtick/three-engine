/**
 * Vertex data for a sprite quad — plain, or nine-sliced.
 *
 * Pure arithmetic over typed arrays, no three.js and no GPU, so the part that
 * decides where a sprite's corners land can be checked exactly rather than
 * looked at.
 *
 * ## Two spaces, and the seam between them is here
 *
 * A region's rect is in IMAGE space (top-left origin, Y down) — see
 * `atlasAsset.js` for why that is the only convention the format uses. A
 * texture is sampled in UV space, where V runs bottom-up, because `flipY` is on
 * for every texture the engine loads. `regionUv` converts, once; this file is
 * the only place in the sprite runtime that consumes the result.
 *
 * ## Nine-slice sizes its border in world units derived from pixels
 *
 * The border is authored in texture pixels because it is a property of the
 * artwork. On screen it has to be a fixed *size*, not a fixed fraction, or a
 * panel stretched to twice the width gets twice-as-thick corners — which is the
 * one thing nine-slice exists to prevent. `pixelsPerUnit` is the conversion,
 * and it is the same number that decides how big an unstretched sprite is, so a
 * sprite and its border can never disagree about scale.
 */

/** @typedef {{ u0: number, v0: number, u1: number, v1: number }} UvRect */

/**
 * @param {{ width: number, height: number, uv: UvRect,
 *           pivot?: [number, number], flipX?: boolean, flipY?: boolean }} spec
 * @returns {{ positions: Float32Array, uvs: Float32Array, indices: Uint16Array }}
 */
export function buildSpriteQuad({ width, height, uv, pivot = [0.5, 0.5], flipX = false, flipY = false }) {
  // The pivot is normalised in IMAGE space (Y down) and marks where the
  // entity's origin sits ON the sprite. So pivot y = 1 is the image's BOTTOM
  // row, which must land at y = 0 with the sprite standing above it — a
  // character's feet at its transform. Getting this backwards hangs every
  // sprite below its entity, which looks plausible until something stands on
  // the ground.
  const left = -pivot[0] * width;
  const right = left + width;
  const top = pivot[1] * height;
  const bottom = top - height;

  const positions = new Float32Array([
    left, bottom, 0,
    right, bottom, 0,
    right, top, 0,
    left, top, 0,
  ]);

  const u0 = flipX ? uv.u1 : uv.u0;
  const u1 = flipX ? uv.u0 : uv.u1;
  const v0 = flipY ? uv.v1 : uv.v0;
  const v1 = flipY ? uv.v0 : uv.v1;
  const uvs = new Float32Array([u0, v0, u1, v0, u1, v1, u0, v1]);

  return { positions, uvs, indices: new Uint16Array([0, 1, 2, 0, 2, 3]) };
}

/**
 * Nine-slice grid: 4×4 vertices, 9 quads.
 *
 * Degenerate cells (a zero-width border column) are still emitted rather than
 * skipped. They cost nothing to draw and keep the index layout constant, which
 * means resizing a panel or changing one inset updates buffers in place instead
 * of rebuilding the geometry and reallocating on the GPU — and a panel being
 * dragged is resized every frame.
 *
 * @param {{ width: number, height: number, uv: UvRect,
 *           region: [number, number, number, number], border: [number, number, number, number],
 *           pixelsPerUnit?: number, pivot?: [number, number],
 *           flipX?: boolean, flipY?: boolean, textureSize: [number, number] }} spec
 */
export function buildNineSliceQuad({
  width,
  height,
  uv,
  region,
  border,
  pixelsPerUnit = 100,
  pivot = [0.5, 0.5],
  flipX = false,
  flipY = false,
  textureSize,
}) {
  const [, , regionW, regionH] = region;
  const [bl, br, bt, bb] = border;
  const [texW, texH] = textureSize;

  // Borders in world units. Clamped so the two insets can never exceed the
  // element: a 40px border on a panel scaled down to 30px worth of width would
  // otherwise invert the middle column, which renders as the centre of the
  // sprite sampled backwards — visually inexplicable and easy to author.
  const scale = 1 / Math.max(1e-6, pixelsPerUnit);
  let wl = bl * scale;
  let wr = br * scale;
  const wSum = wl + wr;
  if (wSum > width && wSum > 0) {
    const k = width / wSum;
    wl *= k;
    wr *= k;
  }
  let wt = bt * scale;
  let wb = bb * scale;
  const hSum = wt + wb;
  if (hSum > height && hSum > 0) {
    const k = height / hSum;
    wt *= k;
    wb *= k;
  }

  const left = -pivot[0] * width;
  const top = pivot[1] * height; // see buildSpriteQuad on the pivot's Y sense
  // Columns left→right, rows TOP→bottom in world Y (descending).
  const xs = [left, left + wl, left + width - wr, left + width];
  const ys = [top, top - wt, top - height + wb, top - height];

  // UV columns/rows. The insets are fractions of the REGION, and V is
  // bottom-up — so the "top" inset is measured down from `uv.v1`.
  const uSpan = uv.u1 - uv.u0;
  const vSpan = uv.v1 - uv.v0;
  const fu = (px) => (regionW > 0 ? (px / regionW) * uSpan : 0);
  const fv = (px) => (regionH > 0 ? (px / regionH) * vSpan : 0);
  const us = [uv.u0, uv.u0 + fu(bl), uv.u1 - fu(br), uv.u1];
  const vs = [uv.v1, uv.v1 - fv(bt), uv.v0 + fv(bb), uv.v0];
  void texW;
  void texH;

  const positions = new Float32Array(16 * 3);
  const uvs = new Float32Array(16 * 2);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      const i = row * 4 + col;
      positions[i * 3] = xs[col];
      positions[i * 3 + 1] = ys[row];
      positions[i * 3 + 2] = 0;
      uvs[i * 2] = flipX ? us[3 - col] : us[col];
      uvs[i * 2 + 1] = flipY ? vs[3 - row] : vs[row];
    }
  }

  const indices = new Uint16Array(9 * 6);
  let at = 0;
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const a = row * 4 + col;
      const b = a + 1;
      const c = a + 4;
      const d = c + 1;
      // Wound counter-clockwise seen from +Z, matching the plain quad.
      indices[at++] = c;
      indices[at++] = d;
      indices[at++] = b;
      indices[at++] = c;
      indices[at++] = b;
      indices[at++] = a;
    }
  }

  return { positions, uvs, indices };
}

/**
 * The world size an unstretched sprite should be.
 *
 * A sprite's size comes from its pixels, not from a number someone typed: two
 * frames of one animation with different trims must not change size on screen,
 * and a 64px icon beside a 128px icon should be half as big without anyone
 * maintaining a scale factor per sprite.
 */
export function spriteSize(region, pixelsPerUnit = 100) {
  const ppu = Math.max(1e-6, pixelsPerUnit);
  return [region[2] / ppu, region[3] / ppu];
}
