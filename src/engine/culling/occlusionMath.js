import * as THREE from "three/webgpu";

/**
 * Occlusion-culling maths (roadmap item 14).
 *
 * Pure functions and one small data structure: given a depth buffer and an
 * object's bounding sphere, is every pixel the object could cover already
 * covered by something nearer? Everything here is testable without a GPU, which
 * matters more for this feature than for most — the failure mode of occlusion
 * culling is *objects that vanish*, and a screenshot of a scene missing a wall
 * tells you nothing about why.
 *
 * ## Depth is a distance in metres, and 0 means "nothing here"
 *
 * The occluder pass writes view-space distance along the camera axis, not a
 * projected depth value. Two reasons: an object's own near distance is trivial
 * to compute in the same units (centre distance minus radius), and a linear
 * buffer degrades gracefully — a hardware depth buffer spends almost all of its
 * precision in the first few metres, so a max-reduction over one is dominated
 * by noise everywhere it matters.
 *
 * Zero is reserved for "no geometry": the pass clears to zero, and the pyramid
 * turns it into `Infinity`, so empty sky is an occluder that occludes nothing.
 * Relying on a clear COLOUR of "far" instead would put the far plane through
 * whatever colour-space conversion the backend applies to a clear value, which
 * is a quiet way to make the sky occlude everything.
 */

const _center = new THREE.Vector3();
const _corner = new THREE.Vector4();

/**
 * The screen-space box a sphere could cover, plus how near its nearest point
 * is. Returns false when the sphere must not be tested at all: it crosses the
 * near plane (the projection is unbounded, and an object the camera is inside
 * is emphatically visible) or it is behind the camera (which the frustum cull
 * has already handled, and which would project to a mirrored box).
 *
 * The box is derived from the sphere's view-space AABB, projected corner by
 * corner. That is deliberately loose — a box always contains its sphere, so the
 * screen box is at least as large as the true projection. Over-estimating is
 * the SAFE direction here: a larger box samples more of the depth buffer, and
 * any sample that is farther away than the object cancels the cull. Every
 * approximation in this file is chosen to fail towards drawing.
 */
export function projectSphere(center, radius, viewMatrix, projectionMatrix, out) {
  _center.copy(center).applyMatrix4(viewMatrix);
  const nearDist = -_center.z - radius;
  // In view space the camera looks down -z, so -z is the distance in front.
  if (nearDist <= 0) return false;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < 8; i++) {
    _corner.set(
      _center.x + (i & 1 ? radius : -radius),
      _center.y + (i & 2 ? radius : -radius),
      _center.z + (i & 4 ? radius : -radius),
      1,
    );
    _corner.applyMatrix4(projectionMatrix);
    // A corner at or behind the eye makes the divide meaningless. Rather than
    // clip the box (which would be a lot of code for an object that is about to
    // fill the screen anyway), refuse to test it.
    if (_corner.w <= 1e-6) return false;
    const x = _corner.x / _corner.w;
    const y = _corner.y / _corner.w;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  out.minU = Math.max(0, minX * 0.5 + 0.5);
  out.maxU = Math.min(1, maxX * 0.5 + 0.5);
  out.minV = Math.max(0, minY * 0.5 + 0.5);
  out.maxV = Math.min(1, maxY * 0.5 + 0.5);
  out.nearDist = nearDist;
  // Entirely off screen: the frustum cull owns that case, and reporting it as
  // occluded here would hide it for a reason the stats would misattribute.
  return out.maxU > out.minU && out.maxV > out.minV;
}

/**
 * A max-reduced mip chain over the occluder depth buffer — the "Hi-Z pyramid".
 *
 * The point of the pyramid is that a test costs a fixed handful of samples no
 * matter how much of the screen the object covers: pick the level where the
 * object's box spans about two texels, read those, done. Without it, a prop
 * covering a quarter of the frame would mean reading a quarter of the buffer.
 *
 * MAX, not min: the question is "is the FARTHEST occluder in this region still
 * nearer than the object's NEAREST point", and only then is every pixel of the
 * object guaranteed to be behind something. A min-reduction answers a question
 * that is true of most objects most of the time and culls things that are
 * plainly visible.
 *
 * Built on the CPU, from a small readback, for a reason worth stating: three
 * submits draw calls from JavaScript, so a cull decision made on the GPU cannot
 * remove a draw call unless the whole pipeline is indirect. The decision has to
 * come back to the CPU regardless — so the buffer comes back small (a quarter
 * of a megabyte) and the reduction happens here, where it costs microseconds
 * and can be inspected.
 */
export class DepthPyramid {
  constructor() {
    this.levels = [];
    this.width = 0;
    this.height = 0;
    this.ready = false;
  }

  /**
   * Rebuilds from a base level of view-space distances. `data` is one float per
   * texel, row 0 at the BOTTOM of the frame — the order `v` runs in, since
   * `projectSphere` maps NDC y to `v = y * 0.5 + 0.5` and NDC +y is the top of
   * the screen.
   *
   * That is a REQUIREMENT ON THE CALLER, not a description of what a readback
   * gives you: only WebGL hands rows over bottom-up, and a WebGPU readback
   * arrives top-down and has to be flipped first (`OcclusionSystem`'s
   * `toPyramidRows`). Feeding this the wrong way up mirrors every depth test
   * about the screen centre and culls objects that nothing is in front of.
   */
  build(data, width, height) {
    this.width = width;
    this.height = height;
    this.levels.length = 0;
    const base = new Float32Array(width * height);
    for (let i = 0; i < base.length; i++) {
      // 0 = nothing rendered here. An empty texel must never occlude, so it
      // becomes infinitely far away rather than infinitely near.
      base[i] = data[i] > 0 ? data[i] : Infinity;
    }
    this.levels.push({ data: base, width, height });

    let w = width;
    let h = height;
    let previous = base;
    while (w > 1 || h > 1) {
      const nw = Math.max(1, Math.ceil(w / 2));
      const nh = Math.max(1, Math.ceil(h / 2));
      const next = new Float32Array(nw * nh);
      for (let y = 0; y < nh; y++) {
        for (let x = 0; x < nw; x++) {
          // Odd sizes are clamped rather than skipped: dropping the last column
          // would leave a strip of the frame with no coverage at coarse levels,
          // and objects near the screen edge would be culled against nothing.
          const x0 = Math.min(x * 2, w - 1);
          const x1 = Math.min(x * 2 + 1, w - 1);
          const y0 = Math.min(y * 2, h - 1);
          const y1 = Math.min(y * 2 + 1, h - 1);
          next[y * nw + x] = Math.max(
            previous[y0 * w + x0],
            previous[y0 * w + x1],
            previous[y1 * w + x0],
            previous[y1 * w + x1],
          );
        }
      }
      this.levels.push({ data: next, width: nw, height: nh });
      previous = next;
      w = nw;
      h = nh;
    }
    this.ready = true;
  }

  /** The farthest occluder anywhere in a screen-space box. */
  sampleMax(minU, minV, maxU, maxV) {
    if (!this.ready) return Infinity;
    const spanX = (maxU - minU) * this.width;
    const spanY = (maxV - minV) * this.height;
    const span = Math.max(spanX, spanY);
    // The level where the box is about two texels across. `span <= 2` needs
    // level 0; every doubling past that adds a level.
    const level = Math.max(0, Math.min(this.levels.length - 1, Math.ceil(Math.log2(Math.max(span, 1)))));
    const mip = this.levels[level];
    const x0 = Math.max(0, Math.floor(minU * mip.width));
    const x1 = Math.min(mip.width - 1, Math.floor(maxU * mip.width));
    const y0 = Math.max(0, Math.floor(minV * mip.height));
    const y1 = Math.min(mip.height - 1, Math.floor(maxV * mip.height));
    let farthest = 0;
    for (let y = y0; y <= y1; y++) {
      const row = y * mip.width;
      for (let x = x0; x <= x1; x++) {
        const value = mip.data[row + x];
        if (value > farthest) farthest = value;
        if (farthest === Infinity) return Infinity;
      }
    }
    return farthest;
  }

  clear() {
    this.levels.length = 0;
    this.ready = false;
  }
}

/**
 * The test itself.
 *
 * `bias` is a RELATIVE margin, so the same setting behaves the same for a crate
 * two metres away and a building two hundred metres away — an absolute one
 * either wastes the near field or fails to cover the far field. It exists
 * because the depth buffer this reads is both low resolution and one frame old:
 * a silhouette moves a texel or two between the capture and the test, and
 * without the margin the objects hugging an occluder's edge flicker.
 */
export function isOccluded(pyramid, bounds, bias = 0.02) {
  const farthest = pyramid.sampleMax(bounds.minU, bounds.minV, bounds.maxU, bounds.maxV);
  if (!Number.isFinite(farthest)) return false;
  return bounds.nearDist > farthest * (1 + bias);
}

/** A reusable result object for `projectSphere`. */
export function createBounds() {
  return { minU: 0, minV: 0, maxU: 0, maxV: 0, nearDist: 0 };
}
