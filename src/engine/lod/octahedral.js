/**
 * Octahedral direction mapping — the addressing scheme behind impostors
 * (roadmap item 14).
 *
 * An impostor is a billboard that shows a *pre-rendered view* of an object, so
 * the whole feature reduces to one question: given the direction the camera is
 * looking from, which of the baked views do I show, and where in the atlas is
 * it? That is a mapping between a unit direction and a square — which is what
 * an octahedral map is, and why every modern impostor implementation uses one.
 *
 * ## Why octahedral rather than a latitude/longitude grid
 *
 * The obvious layout is `yaw × pitch`: bake 16 yaws at 8 pitches. It wastes
 * most of its frames — the rows near the poles all show nearly the same view —
 * and its texel density changes with latitude, so a chain tuned to look right
 * at eye level pops when the camera rises. An octahedron unfolds to a square
 * with roughly uniform solid angle per cell, so every baked frame is worth the
 * same amount, and the mapping is a handful of adds and a fold rather than
 * trigonometry (it has to run per fragment).
 *
 * ## Full sphere vs. hemisphere
 *
 * A tree is never seen from below. `hemisphere: true` uses the 45°-rotated
 * hemi-octahedral map, which spends the ENTIRE atlas on the upper half — so at
 * the same frame count each view is twice as detailed. The full-sphere map is
 * there for props that really are seen from any angle (a floating pickup, a
 * rock on a cliff you can walk under).
 *
 * Pure functions, no three.js, no scene graph: this is where the correctness
 * lives (an impostor that samples the wrong frame looks like an object facing
 * slightly the wrong way, which reads as an art bug, not a maths bug), so it
 * has to be testable without a GPU. The shader implements the same formulas in
 * TSL — `impostorMaterial.js` — and the test asserts the two agree.
 */

const sign = (v) => (v >= 0 ? 1 : -1);

/**
 * Unit direction → atlas UV in [0,1]².
 *
 * `direction` points FROM the object TOWARD the camera — the direction you are
 * looking from, not the direction you are looking. That convention is chosen to
 * match `THREE.Object3D.lookAt`, whose local +Z is exactly this vector, so a
 * bake camera can be placed at `centre + direction * distance` with no sign
 * juggling in between (and a sign error here is invisible in code review and
 * obvious on screen: the impostor shows the back of the object).
 */
export function octEncode(x, y, z, hemisphere = true) {
  const l1 = Math.abs(x) + Math.abs(y) + Math.abs(z);
  if (!(l1 > 0)) return [0.5, 0.5];
  let px = x / l1;
  let py = y / l1;
  let pz = z / l1;

  if (hemisphere) {
    // Rotate the |x|+|z| <= 1 diamond (which is all the upper hemisphere
    // occupies) 45° so it fills the unit square instead of half of it.
    // Directions below the horizon fold onto the horizon rather than wrapping
    // to a wrong frame — the impostor flattens as you go under it, which is
    // the correct failure for a mode whose premise is "you never see it from
    // below".
    if (py < 0) {
      const scale = Math.abs(px) + Math.abs(pz);
      if (scale > 0) {
        px /= scale;
        pz /= scale;
      }
    }
    return [(px + pz) * 0.5 + 0.5, (px - pz) * 0.5 + 0.5];
  }

  if (py < 0) {
    const fx = (1 - Math.abs(pz)) * sign(px);
    const fz = (1 - Math.abs(px)) * sign(pz);
    px = fx;
    pz = fz;
  }
  return [px * 0.5 + 0.5, pz * 0.5 + 0.5];
}

/** Atlas UV in [0,1]² → unit direction. The inverse of `octEncode`. */
export function octDecode(u, v, hemisphere = true) {
  let px;
  let py;
  let pz;
  if (hemisphere) {
    const a = u * 2 - 1;
    const b = v * 2 - 1;
    px = (a + b) * 0.5;
    pz = (a - b) * 0.5;
    py = 1 - Math.abs(px) - Math.abs(pz);
  } else {
    px = u * 2 - 1;
    pz = v * 2 - 1;
    py = 1 - Math.abs(px) - Math.abs(pz);
    if (py < 0) {
      const fx = (1 - Math.abs(pz)) * sign(px);
      const fz = (1 - Math.abs(px)) * sign(pz);
      px = fx;
      pz = fz;
    }
  }
  const length = Math.hypot(px, py, pz) || 1;
  return [px / length, py / length, pz / length];
}

/**
 * The UV a frame sits at in the direction map.
 *
 * Frames are placed on the CLOSED grid — `i / (frames - 1)`, so the first and
 * last land exactly on the edges of the square. An open grid (`(i + 0.5) /
 * frames`) would leave the map's border unrepresented, and the border of an
 * octahedral map is the horizon: the one place a ground-based camera actually
 * spends its time.
 */
export function frameUv(col, row, frames) {
  const n = Math.max(2, frames | 0) - 1;
  return [col / n, row / n];
}

/** The direction frame (col,row) was baked from. */
export function frameDirection(col, row, frames, hemisphere = true) {
  const [u, v] = frameUv(col, row, frames);
  return octDecode(u, v, hemisphere);
}

/**
 * The three frames that surround `direction`, with barycentric weights that
 * sum to 1.
 *
 * Blending three neighbours rather than snapping to the nearest one is what
 * removes the pop. Snapping means the whole billboard switches to a different
 * rendering of the object between one frame and the next — a ~15° jump in
 * apparent orientation, which on a row of trees looks like the scenery
 * twitching as you walk. The cost is 3× the texture fetches and a bit of
 * ghosting where the two views disagree, which at impostor distances is the
 * cheaper artefact by a wide margin.
 *
 * The grid cell is split along its anti-diagonal, so the three corners are
 * always a triangle of the same size, and a direction on the seam gets the same
 * answer from either side.
 */
export function frameWeights(direction, frames, hemisphere = true) {
  const n = Math.max(2, frames | 0) - 1;
  const [u, v] = octEncode(direction[0], direction[1], direction[2], hemisphere);
  const gx = Math.min(Math.max(u, 0), 1) * n;
  const gy = Math.min(Math.max(v, 0), 1) * n;
  // The floor is clamped to n-1 so a direction exactly on the far edge lands in
  // the last cell with fraction 1 rather than in a cell that does not exist.
  const cx = Math.min(Math.floor(gx), n - 1);
  const cy = Math.min(Math.floor(gy), n - 1);
  const fx = gx - cx;
  const fy = gy - cy;

  if (fx + fy < 1) {
    return [
      { col: cx, row: cy, weight: 1 - fx - fy },
      { col: cx + 1, row: cy, weight: fx },
      { col: cx, row: cy + 1, weight: fy },
    ];
  }
  return [
    { col: cx + 1, row: cy + 1, weight: fx + fy - 1 },
    { col: cx + 1, row: cy, weight: 1 - fy },
    { col: cx, row: cy + 1, weight: 1 - fx },
  ];
}

/**
 * The orthonormal basis a frame was baked with: `right` and `up` spanning the
 * billboard plane for a camera looking from `direction`.
 *
 * This has to agree EXACTLY with what the bake camera used, because the runtime
 * projects each fragment's position onto this basis to find its texel. Rather
 * than trust `Object3D.lookAt`'s behaviour at the poles (where `cross(up, dir)`
 * is degenerate and three nudges the matrix by an epsilon in a direction the
 * shader cannot know about), the rule is written here once and the bake camera
 * is handed the `reference` vector that reproduces it.
 */
export function frameBasis(direction) {
  const [dx, dy, dz] = direction;
  // Straight up or straight down: any perpendicular pair is as good as another,
  // but the choice must be the same on both sides. +Z is picked because it is
  // the axis the Y-up convention leaves free.
  const referenceY = Math.abs(dy) > 0.999 ? 0 : 1;
  const referenceZ = Math.abs(dy) > 0.999 ? 1 : 0;
  // right = normalize(cross(reference, direction))
  let rx = referenceY * dz - referenceZ * dy;
  let ry = referenceZ * dx - 0 * dz;
  let rz = 0 * dy - referenceY * dx;
  const rl = Math.hypot(rx, ry, rz) || 1;
  rx /= rl;
  ry /= rl;
  rz /= rl;
  // up = cross(direction, right)
  const ux = dy * rz - dz * ry;
  const uy = dz * rx - dx * rz;
  const uz = dx * ry - dy * rx;
  return {
    right: [rx, ry, rz],
    up: [ux, uy, uz],
    reference: [0, referenceY, referenceZ],
  };
}

/**
 * Where a frame's tile starts in the atlas, in UV.
 *
 * Tiles are laid out on the OPEN grid (`i / frames`) — unlike the direction
 * grid above, which is closed. They are two different things that both happen
 * to be indexed by (col,row): a tile is an area, a direction is a point.
 * Conflating them puts every sample half a tile off, which looks like the
 * object being subtly the wrong shape rather than like an addressing bug.
 */
export function tileOrigin(col, row, frames) {
  const n = Math.max(1, frames | 0);
  return [col / n, row / n];
}
