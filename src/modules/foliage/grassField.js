import * as THREE from "three/webgpu";

/**
 * A grass field is drawn, not scattered.
 *
 * The rest of Foliage places prototypes: every plant is a placement in a CPU
 * array, uploaded as instance data, edited and persisted individually. That is
 * the right contract for a tree or a shrub and the wrong one for a lawn — an
 * unbroken sward is hundreds of thousands of blades, which no per-instance list
 * can afford to hold, upload or rebuild.
 *
 * So a field holds no blades. It draws a handful of instanced rings that follow
 * the camera, and every blade's position, size, lean, colour and sway is
 * derived in the vertex shader from the world cell it stands in. Blade count is
 * a uniform; CPU cost is a constant few draw calls. Where the blades may grow,
 * how tall and what colour comes from a sampled field the world supplies.
 *
 * This module is the renderer-independent half: ring layout, budgets, the blade
 * strip and the packed field texture. It builds no materials and needs no GPU.
 */

const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;

/** A hex (triangular) lattice's row pitch relative to its column spacing:
 * rows step by `cell·HEX_ROW_RATIO` along z, columns by `cell` along x. Exact
 * CPU mirror of `grassMaterial.js`'s `HEX_PITCH_RATIO`. */
const HEX_ROW_RATIO = Math.sqrt(3) / 2;

/** Ring 0 is at the camera and carries the detail; the outer rings trade
 * segments and density for reach. Densities are relative, not absolute.
 * `tuft` is how many blades one instance draws (a fan built in the vertex
 * shader from the same cell hash, so a ring can hold its visual density up
 * while its instance count — the thing the budget actually pays for — drops.
 * `widthScale` multiplies the authored blade width for that ring only, so a
 * tuft's members can cover more ground per instance without a wider blade
 * everywhere. `heightScale` multiplies the authored blade height for that
 * ring only, relative to ring 0's own blade height.
 *
 * ⛔ 09-13 MASS REBUILD. The owner's verdict against Tiny Glade references:
 * structure was right (clumps, lean, darker roots) but it still read as
 * individual thin ribbons with hard per-blade contrast, and past ~8 m it went
 * flat with no fuzz. Two changes fund that: ring 0 shrinks to a 5 m radius
 * (its density comes from being SMALL, not from a bigger budget — cheap
 * because it is `cellFloor`-capped regardless of weight) and ring 1's fan
 * instance count is bought back below. Ring 2 becomes a genuinely dense
 * short-tuft fuzz (12-blade fans, a fixed 0.3 m fan width) instead of the old
 * sparse 4-blade stubble, so a hillside silhouette keeps a fibrous edge past
 * 20 m instead of reading as flat green ground. Triangle math
 * (`grassBladeCost`) is exactly `(segments*2-1)*tuft` per instance, so a
 * ring's own segment count matters as much as its tuft: ring 0 drops to 2
 * segments (a gentler, still-curved taper) specifically to buy the headroom
 * ring 1/2's wider fans spend. */
// ⛔ 09-13 FOLLOW-UP OWNER RECEIPT: straight down and three-quarter shots
// still showed dark holes ~0.5-1 m between clumps even after the lean/root
// fixes above — ring 0's own blade width closes the rest of an overhead gap
// directly. `widthScale` 1 → 1.2 (the authored 0.022 m default draws at
// 0.0264 m here) so ring 0's own footprint covers more of the ground a
// straight-down camera actually sees between blades.
// ⛔⛔ 09-13 SEVENTH OWNER RECEIPT: colour and lean are now shared across the
// ring0/ring1 seam (see `grassMaterial.js`'s `rest`/`tipGround` fixes), yet
// the three-quarter shot STILL showed a horizontal tone edge there — because
// the GEOMETRY still differed either side of it: ring 0's blades are a
// 2-segment Bézier bend, ring 1's fan members were a flat 1-segment quad, so
// under a sun behind the camera the two present different normals and
// silhouettes and the dithered hand-over mixes two visibly different tones.
// Ring 1 now bends with the SAME 2 segments as ring 0. Triangle math makes
// this expensive in a way `tuft` cannot buy back: for a FIXED visual density
// `triangles = (segments*2-1) * tuft * instances = (segments*2-1) * (visual
// blade count)` — `tuft` cancels out of that, so going 1→2 segments simply
// TRIPLES a ring's triangle cost at whatever density it draws. Funding it
// purely out of ring 1's own share (leaving ring 2 untouched) cut its visual
// density all the way to ~290/m² and, measured, made the seam WORSE (a wider
// hand-over band alone did not move it) — the density cliff itself, not the
// remaining segment mismatch, was now the dominant term in the row-luminance
// jump across the boundary. Ring 2's own share is cut instead (still a fan,
// `tuft` unchanged at 12, `segments` still 1 — its tips already converge to
// the ground colour by ~20 m so its own density matters far less) to buy
// ring 1 back up to ~450/m² within the same 2.7 M cap; `tuft` trimmed 10→8
// on ring 1 so the same density needs fewer, larger fans rather than more,
// smaller ones. `tests/grass-field.test.mjs` carries the updated floors and
// the triangle-cap regression together.
const RING_PROFILE = Object.freeze([
  // 09-13 Tiny Glade receipt: mid-distance ground showed between tufts. Ring 1's
  // count is pinned by the 2.7 M triangle cap (each fan is 24 triangles), so the
  // extra cover comes from WIDTH (2.4 → 2.8), not from more fans.
  { segments: 2, density: .13, tuft: 1, widthScale: 1.2, heightScale: 1 },
  // ⭐ 09-13 OVERHEAD COVER: ring 1 draws ~450 blades/m², a quarter of ring 0,
  // so from above it covered ~25 % of its ground even with the blade arch —
  // the "dark sward from above / while orbiting" receipt. Coverage is width ×
  // density, and a 5 cm blade at 5-19 m is still ~1 px, so the far rings
  // draw WIDER blades instead of more of them (the SimonDev far-grass trick).
  { segments: 2, density: .0018, tuft: 8, widthScale: 2.8, heightScale: .85 },
  { segments: 1, density: .00006, tuft: 12, widthScale: 3.6, heightScale: .8 },
]);

/**
 * Concentric square rings covering `near` to `far` around the camera.
 *
 * Each ring is a jittered grid: one blade per cell, displaced inside it. A grid
 * is what makes a sward even — pure random placement clumps and leaves holes at
 * exactly the density where a lawn has to look continuous. Cells inside the
 * ring's hole are collapsed by the shader rather than skipped, so the instance
 * count stays a constant the draw call can be built from.
 *
 * `horizon` stretches only the outermost ring's reach beyond its density
 * share (its instance count is unchanged, so the same instances spread over
 * more ground) — a hill's silhouette stays a fuzzy line of thin tufts instead
 * of ending at a hard terrain edge.
 */
export function grassRings({ near = 5, far = 70, blades = 480000, rings = RING_PROFILE.length, cellFloor = .024, horizon = 1.2 } = {}) {
  const innerMost = clamp(finite(near, 5), 2, 400);
  const outerMost = clamp(finite(far, 70), innerMost + 4, 1200);
  const budget = clamp(Math.round(finite(blades, 480000)), 0, 2400000);
  const count = clamp(Math.round(finite(rings, 3)), 1, RING_PROFILE.length);
  const profile = RING_PROFILE.slice(0, count);
  // Ring edges grow geometrically, so each ring covers a similar span in screen
  // terms rather than the outer one covering almost all of the ground.
  const step = Math.pow(outerMost / innerMost, 1 / Math.max(1, count - 1));
  const edges = [innerMost];
  for (let index = 1; index < count; index++) edges.push(edges[index - 1] * step);
  const bounds = profile.map((_, index) => ({ inner: index ? edges[index - 1] : 0, outer: edges[index] }));
  const weights = profile.map((entry, index) => {
    const { inner, outer } = bounds[index];
    return entry.density * ((outer * 2) ** 2 - (inner * 2) ** 2);
  });
  const total = weights.reduce((sum, value) => sum + value, 0) || 1;
  const stretch = clamp(finite(horizon, 1.4), 1, 4);
  return profile.map((entry, index) => {
    const { inner } = bounds[index];
    let { outer } = bounds[index];
    if (index === count - 1 && stretch > 1) outer *= stretch;
    const size = outer * 2;
    // One blade per grid cell. The cell floor is the closest two blades may
    // ever stand, which bounds the vertex count of an absurd density setting.
    const wanted = Math.max(1, Math.round(budget * weights[index] / total));
    const holeCorrection = 1 - (inner / outer) ** 2 || 1;
    // ⛔⛔ 09-13 HEX LATTICE FOOTPRINT BUG. Rows step by the hex row pitch
    // (`cell·√3/2`), shorter than a column's own spacing — a window with
    // COLUMNS rows (the old square-grid assumption) therefore covered LESS
    // ground along z than along x (only ~87% of `size`), so a ring's own
    // radial fade never got the chance to run: blades ran out along z well
    // before the outer-band fade would have zeroed them, which is what an
    // isolated ring-0 render showed as a squarish/elliptical cutoff instead
    // of a soft circle. `rows` is scaled up by 1/(√3/2) so `rows · pitch`
    // covers the SAME `size` `columns · cell` does — the window is a true
    // `size × size` square in world space again, just on a hex lattice.
    // Solving `columns · rows ≈ wanted / holeCorrection` with that constraint
    // gives `columns = √(wanted · HEX_ROW_RATIO / holeCorrection)`.
    //
    // ⛔⛔⛔ A budget-limited ring (columns set by `wanted`) is unaffected —
    // the √HEX_ROW_RATIO factor above already keeps `columns · rows` at the
    // SAME target `wanted / holeCorrection` a square lattice would have cost.
    // A DENSITY-CAPPED ring (ring 0, whose `wanted` exceeds what `cellFloor`
    // allows) is not: capping `columns` at the OLD square-lattice ceiling
    // (`size / cellFloor`) and then deriving `rows` from it pushes
    // `columns · rows` to `(size/cellFloor)² / HEX_ROW_RATIO` — ~15% MORE
    // instances than the same cap ever cost on a square lattice, since a hex
    // lattice needs proportionally more rows to reach the same physical
    // extent at the same minimum blade spacing. The cap itself gets the same
    // `√HEX_ROW_RATIO` correction so a capped ring's total instance count
    // (and triangle cost) lands back where the pre-hex budget tuning
    // (`grassFieldCost` ≤ 2.7 M triangles) already accounted for.
    const columnCap = Math.floor(size / cellFloor * Math.sqrt(HEX_ROW_RATIO));
    const columns = clamp(Math.round(Math.sqrt(wanted * HEX_ROW_RATIO / holeCorrection)), 1, columnCap);
    const rows = Math.max(1, Math.round(columns / HEX_ROW_RATIO));
    return {
      index, inner, outer, size, columns, rows, cell: size / columns,
      segments: entry.segments, tuft: entry.tuft || 1, widthScale: entry.widthScale || 1,
      heightScale: entry.heightScale || 1, instances: columns * rows,
      // What the shader must collapse: cells whose centre falls in the hole.
      hole: inner * 2 / size,
    };
  });
}

/** Vertices and triangles one instance costs at a segment count — `tuft` blades
 * fanned from the same instance, each an independent strip. */
export function grassBladeCost(segments, tuft = 1) {
  const strip = clamp(Math.round(finite(segments, 3)), 1, 8);
  // Ring 2's fuzz fan is 12 blades wide (was capped at 8): the cap is a sanity
  // ceiling on an absurd authored value, not a real limit on how wide a tuft
  // may be.
  const fan = clamp(Math.round(finite(tuft, 1)), 1, 16);
  return { vertices: (strip + 1) * 2 * fan, triangles: (strip * 2 - 1) * fan };
}

/** Total geometry a set of rings will submit if every blade survives its mask. */
export function grassFieldCost(rings) {
  return rings.reduce((total, ring) => {
    const cost = grassBladeCost(ring.segments, ring.tuft);
    total.instances += ring.instances;
    total.vertices += ring.instances * cost.vertices;
    total.triangles += ring.instances * cost.triangles;
    total.draws += 1;
    return total;
  }, { instances: 0, vertices: 0, triangles: 0, draws: 0 });
}

/**
 * One blade, as an instanced strip.
 *
 * `bladeUV.x` is the side (0 left, 1 right) and `bladeUV.y` how far up the
 * blade the vertex sits. The shader rebuilds the whole blade from those two
 * numbers plus its instance index, so `position` here is only a rest pose: it
 * gives the geometry a meaningful bounding box and lets a non-TSL path (an
 * offline test, a depth-only pass without the node material) still see a blade.
 */
export function grassBladeGeometry(segments = 3, { width = .035, height = 1, tuft = 1 } = {}) {
  const strip = clamp(Math.round(finite(segments, 3)), 1, 8);
  const fan = clamp(Math.round(finite(tuft, 1)), 1, 16);
  const geometry = new THREE.InstancedBufferGeometry();
  const perBlade = (strip + 1) * 2;
  const vertices = perBlade * fan;
  const position = new Float32Array(vertices * 3), bladeUV = new Float32Array(vertices * 2);
  // Which member of the fan a vertex belongs to. The vertex shader hashes this
  // together with the instance's world cell to jitter each blade of the fan a
  // little apart while keeping the fan's coverage/colour/wind — everything
  // that must read as one tuft — keyed on the shared cell alone.
  const bladeSlot = new Float32Array(vertices);
  const indices = [];
  for (let slot = 0; slot < fan; slot++) {
    // A rest-pose fan spread only matters for a non-shader bounding box or a
    // depth-only path without the node material; the real placement is
    // entirely the vertex shader's. Fan the rest pose out radially so it is
    // never a degenerate stack of coincident blades.
    const angle = fan > 1 ? (slot / fan) * Math.PI * 2 : 0;
    const offsetX = Math.sin(angle) * width * 1.6, offsetZ = Math.cos(angle) * width * 1.6 - width * 1.6;
    for (let row = 0; row <= strip; row++) {
      // A circle/ellipse profile (exponent .5) rounds the tip instead of
      // pinching it to a sharp point — a mass of grass reads as soft fibre,
      // not individual pointed ribbons. Must match `grassMaterial.js`'s
      // `taper` exactly, since that is what the shader actually draws.
      const t = row / strip, taper = Math.pow(Math.max(1 - t * t, 0), .5);
      for (let side = 0; side < 2; side++) {
        const vertex = slot * perBlade + row * 2 + side;
        position[vertex * 3] = (side - .5) * width * taper + offsetX;
        position[vertex * 3 + 1] = t * height;
        position[vertex * 3 + 2] = offsetZ;
        bladeUV[vertex * 2] = side;
        bladeUV[vertex * 2 + 1] = t;
        bladeSlot[vertex] = slot;
      }
      if (!row) continue;
      const a = slot * perBlade + (row - 1) * 2, b = slot * perBlade + row * 2;
      indices.push(a, a + 1, b);
      if (row < strip) indices.push(a + 1, b + 1, b);
    }
  }
  geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geometry.setAttribute("bladeUV", new THREE.BufferAttribute(bladeUV, 2));
  geometry.setAttribute("bladeSlot", new THREE.BufferAttribute(bladeSlot, 1));
  geometry.setIndex(indices);
  geometry.userData.grass = { segments: strip, tuft: fan, ...grassBladeCost(strip, fan) };
  return geometry;
}

export const GRASS_FIELD_CHANNELS = Object.freeze(["height", "density", "scale", "dryness"]);

/**
 * Pack the ground a field grows on into one RGBA float texture.
 *
 * R is the terrain height in metres, G how much grass belongs here, B its
 * relative height and A how dry it looks. A sample may also return `color`, the
 * ground's own colour at that point, which is packed alongside so a blade's
 * base can take it and the sward meets the terrain instead of sitting on it.
 * `sample(x, z)` is called in the world's own metre frame; the texture covers
 * `extent` centred on `origin`.
 */
export function packGrassField(sample, { extent = 128, resolution = 256, origin = [0, 0] } = {}) {
  const size = clamp(Math.round(finite(resolution, 256)), 8, 1024);
  const span = clamp(finite(extent, 128), 1, 8192);
  if (typeof sample !== "function") throw new TypeError("A grass field needs a sample(x, z) function");
  const data = new Float32Array(size * size * 4);
  const half = span / 2, step = span / (size - 1);
  let ground = null;
  for (let row = 0; row < size; row++) for (let column = 0; column < size; column++) {
    const x = origin[0] - half + column * step, z = origin[1] - half + row * step;
    const value = sample(x, z) ?? {};
    const index = (row * size + column) * 4;
    data[index] = finite(value.height, 0);
    data[index + 1] = clamp(finite(value.density, 0), 0, 1);
    data[index + 2] = clamp(finite(value.scale, 1), 0, 4);
    data[index + 3] = clamp(finite(value.dryness, 0), 0, 1);
    if (!Array.isArray(value.color)) continue;
    ground ??= new Float32Array(size * size * 4);
    for (let channel = 0; channel < 3; channel++) ground[index + channel] = clamp(finite(value.color[channel], 0), 0, 8);
    ground[index + 3] = 1;
  }
  return { data, ground, size, extent: span, origin: [origin[0], origin[1]] };
}

/** The GPU texture for a packed field, or null when there is no field. */
export function grassFieldTexture(packed, channel = "data") {
  if (!packed?.[channel]) return null;
  const texture = new THREE.DataTexture(packed[channel], packed.size, packed.size, THREE.RGBAFormat, THREE.FloatType);
  texture.name = channel === "ground" ? "Grass field · ground colour"
    : "Grass field · height, density, scale, dryness";
  // Read at level 0 with an explicit bilinear reconstruction in the shader:
  // float32 filtering is an optional device feature and this must stay portable.
  texture.minFilter = texture.magFilter = THREE.NearestFilter;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

/** CPU mirror of the shader's field read, for tests and for placement queries.
 * Bilinear, clamped, and identical to the reconstruction the vertex node does. */
export function sampleGrassField(packed, x, z) {
  if (!packed) return null;
  const { data, size, extent, origin } = packed;
  const half = extent / 2;
  const u = clamp((x - origin[0] + half) / extent, 0, 1) * (size - 1);
  const v = clamp((z - origin[1] + half) / extent, 0, 1) * (size - 1);
  const column = Math.min(size - 2, Math.floor(u)), row = Math.min(size - 2, Math.floor(v));
  const fx = u - column, fz = v - row;
  const out = {};
  for (let channel = 0; channel < 4; channel++) {
    const at = (r, c) => data[(r * size + c) * 4 + channel];
    const lower = at(row, column) * (1 - fx) + at(row, column + 1) * fx;
    const upper = at(row + 1, column) * (1 - fx) + at(row + 1, column + 1) * fx;
    out[GRASS_FIELD_CHANNELS[channel]] = lower * (1 - fz) + upper * fz;
  }
  return out;
}

/**
 * The world cell a blade of one ring stands in, given the ring's snapped
 * origin. This is the CPU mirror of the shader's derivation, and the reason the
 * field does not slide: every per-blade value is hashed from THIS, the cell's
 * absolute coordinate, never from the instance's position in the current grid.
 *
 * ⛔⛔ 09-13 HEX LATTICE. Columns still step by the ring's own `cell`, but rows
 * now step by the hex row pitch (`cell·√3/2`) — a hexagonal lattice's two
 * axes are not the same spacing, unlike the square grid this replaces. The
 * returned (col, row) pair is the hex lattice's own id, exactly what
 * `grassMaterial.js`'s `worldCell` is — every hash (lottery, clump, colour,
 * wind) keys on it unchanged; only the mapping to a physical position
 * (`grassHexCellPoint`/`grassHexBladeXZ`, below) is new.
 */
export function grassBladeCell(ring, origin, instance, view = null) {
  // `view` is the visible window a draw was narrowed to (`grassFrustumWindow`):
  // instance 0 is its first slot, not the ring's.
  const span = view?.columns ?? ring.columns;
  const column = instance % span + (view?.column ?? 0), row = Math.floor(instance / span) + (view?.row ?? 0);
  const pitch = grassHexPitch(ring.cell);
  const originCell = [Math.round(origin[0] / ring.cell), Math.round(origin[1] / pitch)];
  // ⛔ Columns and rows are no longer the same count (`ring.rows` covers the
  // same physical `size` as `ring.columns` does, at the row pitch's own
  // spacing) — each axis centres on its OWN count, not a shared one.
  const centreCol = Math.floor(ring.columns / 2), centreRow = Math.floor((ring.rows ?? ring.columns) / 2);
  return [column + originCell[0] - centreCol, row + originCell[1] - centreRow];
}

const frac = value => value - Math.floor(value);

/** Row pitch of a hex lattice with column spacing `cell`: odd rows offset by
 * half a cell along x, so rows step by cell·√3/2 along z — the standard
 * hexagonal (triangular) lattice. Exact CPU mirror of `grassMaterial.js`'s
 * `HEX_PITCH_RATIO`. */
export function grassHexPitch(cell) { return cell * HEX_ROW_RATIO; }

/** A ring's whole grid as a window: what a draw issues when nothing narrows it. */
export function grassFullWindow(ring) {
  return { column: 0, row: 0, columns: ring.columns, rows: ring.rows ?? ring.columns };
}

/** Lowest and highest terrain height a packed field holds, in its own frame,
 * and the largest blade height scale it asks for: [low, high, scale]. */
export function grassFieldExtremes(packed) {
  if (!packed?.data?.length) return null;
  let low = Infinity, high = -Infinity, scale = 0;
  for (let index = 0; index < packed.data.length; index += 4) {
    const height = packed.data[index];
    if (height < low) low = height;
    if (height > high) high = height;
    if (packed.data[index + 2] > scale) scale = packed.data[index + 2];
  }
  return Number.isFinite(low) ? [low, high, scale] : null;
}

const NDC_CORNERS = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
// Near quad 0-3 and far quad 4-7 share a winding, so these are the twelve
// edges of the view volume.
const VIEW_EDGES = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
const _corners = Array.from({ length: 8 }, () => new THREE.Vector3());
const _nearPoint = new THREE.Vector3(), _midPoint = new THREE.Vector3(), _viewToLocal = new THREE.Matrix4();

/**
 * The eight corners of a camera's view volume, cut off at `reach` metres of
 * depth and moved into a field's frame by `toLocal`.
 *
 * Each corner ray is found by unprojecting two NDC depths on it and then
 * walking it to a view depth, so neither the projection's depth convention
 * (WebGL −1..1, WebGPU 0..1, reversed) nor perspective versus orthographic
 * matters. Returns a shared array, overwritten by the next call, or null for
 * a projection with no usable depth axis.
 */
export function grassViewCorners(camera, toLocal, reach = Infinity) {
  const inverse = camera?.projectionMatrixInverse;
  if (!inverse) return null;
  const near = finite(camera.near, 0), far = Math.min(finite(camera.far, 1e6), finite(reach, 1e6));
  if (!(far > near)) return null;
  _viewToLocal.multiplyMatrices(toLocal, camera.matrixWorld);
  let corner = 0;
  for (const depth of [near, far]) for (const [x, y] of NDC_CORNERS) {
    _nearPoint.set(x, y, 0).applyMatrix4(inverse);
    _midPoint.set(x, y, .5).applyMatrix4(inverse);
    const dz = _midPoint.z - _nearPoint.z;
    if (!(Math.abs(dz) > 1e-12)) return null;
    const t = (-depth - _nearPoint.z) / dz;
    _corners[corner++].set(_nearPoint.x + (_midPoint.x - _nearPoint.x) * t, _nearPoint.y + (_midPoint.y - _nearPoint.y) * t, -depth)
      .applyMatrix4(_viewToLocal);
  }
  return _corners;
}

/**
 * The part of a ring's grid a camera can see, as a window of whole slots.
 *
 * The rings are squares centred on the camera, so without this every blade
 * behind the lens still ran the full vertex shader only to be clipped. A draw
 * narrowed to this window issues `columns × rows` instances starting at
 * (`column`, `row`), and the shader offsets its instance index by the same
 * corner, so each blade still keys on the same world cell.
 *
 * `corners` is the view volume from `grassViewCorners`. It is clipped to the
 * slab the blades can occupy (`minY`..`maxY`) before being projected onto the
 * ground, so a camera looking down pays for the ground under it rather than
 * for the pyramid's whole footprint. `margin` pads for everything that moves a
 * blade off its lattice point: jitter, fan spread, lean and wind.
 * Conservative by construction: the XZ bounds of a convex volume's slab
 * section are spanned by its vertices inside the slab plus its edges'
 * crossings of the slab planes.
 */
export function grassFrustumWindow(ring, origin, corners, { minY = -Infinity, maxY = Infinity, margin = 0 } = {}) {
  let xmin = Infinity, xmax = -Infinity, zmin = Infinity, zmax = -Infinity;
  const include = (x, z) => {
    if (x < xmin) xmin = x; if (x > xmax) xmax = x;
    if (z < zmin) zmin = z; if (z > zmax) zmax = z;
  };
  for (const point of corners) if (point.y >= minY && point.y <= maxY) include(point.x, point.z);
  for (const [a, b] of VIEW_EDGES) {
    const p = corners[a], q = corners[b];
    for (const plane of [minY, maxY]) {
      if (!Number.isFinite(plane) || (p.y - plane) * (q.y - plane) >= 0) continue;
      const t = (plane - p.y) / (q.y - p.y);
      include(p.x + (q.x - p.x) * t, p.z + (q.z - p.z) * t);
    }
  }
  const empty = { column: 0, row: 0, columns: 0, rows: 0 };
  if (!(xmax >= xmin) || !(zmax >= zmin)) return [xmin, xmax, zmin, zmax].some(Number.isNaN) ? grassFullWindow(ring) : empty;
  const rows = ring.rows ?? ring.columns, pitch = grassHexPitch(ring.cell);
  const originCol = Math.round(origin[0] / ring.cell), originRow = Math.round(origin[1] / pitch);
  const centreCol = Math.floor(ring.columns / 2), centreRow = Math.floor(rows / 2);
  // A cell's lattice point is at ((col + parity/2)·cell, row·pitch): one extra
  // column on the low side covers the odd rows' half-cell shift.
  const column0 = Math.max(0, Math.floor((xmin - margin) / ring.cell) - 1 - originCol + centreCol);
  const column1 = Math.min(ring.columns - 1, Math.ceil((xmax + margin) / ring.cell) - originCol + centreCol);
  const row0 = Math.max(0, Math.floor((zmin - margin) / pitch) - originRow + centreRow);
  const row1 = Math.min(rows - 1, Math.ceil((zmax + margin) / pitch) - originRow + centreRow);
  if (column1 < column0 || row1 < row0) return empty;
  return { column: column0, row: row0, columns: column1 - column0 + 1, rows: row1 - row0 + 1 };
}

/** 0 or 1, correct for a negative row (JS's `%` can return a negative
 * remainder, which a plain `row & 1` would get wrong for a row like -3). */
const hexRowParity = row => ((row % 2) + 2) % 2;

/** World XZ of one hex lattice point (before jitter), at column spacing
 * `cell`. Exact CPU mirror of `grassMaterial.js`'s `hexCellPoint`. */
export function grassHexCellPoint(cell, colRow) {
  const [col, row] = colRow;
  return [(col + .5 * hexRowParity(row)) * cell, row * grassHexPitch(cell)];
}

/** CPU mirror of `grassMaterial.js`'s `cellHash2`: two independent values in
 * [0,1) from one cell, exact same constants. */
export function grassCellHash2(cell) {
  return [
    frac(Math.sin(cell[0] * 127.1 + cell[1] * 311.7) * 43758.5453),
    frac(Math.sin(cell[0] * 269.5 + cell[1] * 183.3) * 24634.6345),
  ];
}

/** The hex lattice cell (col, row) nearest a world XZ point — the Voronoi
 * partition a triangular lattice makes. Checked over the 3×3 neighbourhood of
 * an approximate row/column: a triangular lattice's true nearest point is
 * never more than one row away from that approximation. Exact CPU mirror of
 * `grassMaterial.js`'s `hexNearestCell` (there, unrolled at shader-build
 * time; here, a plain loop). Used by the ring-seam lottery so the shared
 * hand-over between two rings partitions the ground by ring 0's own hex
 * lattice, not a square patch riding on top of it. */
export function grassHexNearestCell(cell, x, z) {
  const pitch = grassHexPitch(cell);
  const rowApprox = Math.round(z / pitch);
  let best = null, bestDist = Infinity;
  for (let dr = -1; dr <= 1; dr++) {
    const row = rowApprox + dr;
    const parity = hexRowParity(row);
    const colApprox = Math.round(x / cell - .5 * parity);
    for (let dc = -1; dc <= 1; dc++) {
      const col = colApprox + dc;
      const [cx, cz] = grassHexCellPoint(cell, [col, row]);
      const dist = (cx - x) ** 2 + (cz - z) ** 2;
      if (dist < bestDist) { bestDist = dist; best = [col, row]; }
    }
  }
  return best;
}

/** A blade's jitter offset within its hex cell: uniform in a DISC of radius
 * 0.45 of a cell, from the cell's own hash — isotropic, unlike a square
 * jitter range sized independently per axis. Exact CPU mirror of the jitter
 * terms in `grassMaterial.js`'s blade-position derivation. */
export function grassHexJitter(cell, colRow) {
  const [u1, u2] = grassCellHash2(colRow);
  const radius = Math.sqrt(u1) * cell * .45, angle = u2 * Math.PI * 2;
  return [Math.cos(angle) * radius, Math.sin(angle) * radius];
}

/** A blade's final world XZ (its hex cell's lattice point plus its own
 * isotropic jitter) — the exact CPU mirror of `grassMaterial.js`'s `world`,
 * before any tuft-fan offset. */
export function grassHexBladeXZ(cell, colRow) {
  const [x0, z0] = grassHexCellPoint(cell, colRow);
  const [jx, jz] = grassHexJitter(cell, colRow);
  return [x0 + jx, z0 + jz];
}

/** CPU mirror of `grassMaterial.js`'s `cellHash1`: one salted value in [0,1)
 * from a cell. Exact same constants, so a test can assert the shader and the
 * CPU agree on where a clump/patch boundary falls. */
export function grassClumpHash(cell, salt = 0) {
  return frac(Math.sin(cell[0] * 113.5 + cell[1] * 271.9 + salt * 74.7) * 31251.1234);
}

/** CPU mirror of `grassMaterial.js`'s shared ring-boundary hash: one value
 * per a fixed, small (0.3 m) world-space partition, independent of either
 * ring's own blade lattice — so two neighbouring rings agree EXACTLY which
 * physical patch belongs to which ring through a crossfade band. */
export function grassBoundaryLottery(x, z, salt = 211.7, cellSize = .3) {
  return grassClumpHash([Math.floor(x / cellSize), Math.floor(z / cellSize)], salt);
}

/** CPU mirror of `grassMaterial.js`'s `seamWeight`: the near (smaller-radius)
 * side's own keep-probability at a shared seam — 1 well inside it, 0 well
 * outside, smoothstepped across a `band`-wide margin either side. */
export function grassSeamWeight(radius, boundaryRadius, band = 3) {
  const t = clamp((radius - (boundaryRadius - band)) / (2 * band), 0, 1);
  return 1 - t * t * (3 - 2 * t);
}

/** The clump a blade's rest-pose lean/yaw is shared with — coarser than a
 * blade's own cell at ring 0's density, so several neighbouring blades fan
 * out from one shared rest pose instead of every blade combing the same
 * direction (`grassMaterial.js`'s `clumpCell`).
 *
 * ⛔⛔⛔ 09-13 OWNER RECEIPT: axis-aligned light/dark rectangles at eye level,
 * still present after the blade lattice, field bilinear read and ring window
 * were all fixed and verified — isolating the sun-facing term alone showed
 * the exact same rectangles. This was a plain SQUARE `floor(x/clumpSize)`
 * partition sharing one rest-pose YAW per cell; a directional sun lights a
 * fixed yaw very differently depending which of many hashed angles a square
 * block landed on. Now the same hex (triangular) Voronoi partition the
 * ring-seam lottery already uses (`grassHexNearestCell`), at the same scale —
 * no preferred axis for a directional light to expose. */
export function grassClumpCell(x, z, clumpSize = .35) {
  return grassHexNearestCell(clumpSize, x, z);
}

/** A unit gradient direction for one lattice corner, from the same fixed set
 * of 8 evenly-spaced directions as `grassMaterial.js`'s `simplexGradientAt`. */
function grassSimplexGradientAt(cell, salt) {
  const index = Math.floor(grassClumpHash(cell, salt) * 8);
  const angle = index * (Math.PI / 4);
  return [Math.cos(angle), Math.sin(angle)];
}

// Exact CPU mirror of `grassMaterial.js`'s rotation — a small extra margin
// on top of simplex's own, much more isotropic triangular lattice.
const ROTATE_COS = Math.cos(.4636), ROTATE_SIN = Math.sin(.4636);
const SIMPLEX_F2 = (Math.sqrt(3) - 1) / 2, SIMPLEX_G2 = (3 - Math.sqrt(3)) / 6;

/** One octave of 2D SIMPLEX noise, at world scale `freq` metres — exact
 * arithmetic mirror of `grassMaterial.js`'s `noiseOctave`. ⛔⛔⛔ 09-13 SIXTH
 * OWNER RECEIPT: an isotropy check (axis-aligned vs diagonal gradient energy
 * on the top-down debug panel) still read ≈1.34 (target ≤1.15) with rotated
 * classic (Perlin) gradient noise — rotating the SAMPLE POINT moves the
 * noise's large-scale pattern, but the square LATTICE underneath is still
 * square and axis-aligned in its own frame, so the bias survives. Simplex
 * noise replaces the square lattice with a triangular one (skewed into
 * place by `SIMPLEX_F2`, unskewed by `SIMPLEX_G2` — the standard 2D
 * constants), evaluated from the three nearest simplex corners rather than
 * four square ones, each weighted by a radially-symmetric `(0.5 − d²)⁴`
 * falloff instead of a separable per-axis one: there is no preferred axis
 * left in the lattice's own geometry. `test:foliage` gates 500 random
 * points agreeing with the shader's TSL arithmetic to 1e-4. */
function grassNoiseOctave(x, z, freq, salt) {
  const rx = x * ROTATE_COS - z * ROTATE_SIN, rz = x * ROTATE_SIN + z * ROTATE_COS;
  const px = rx / freq, pz = rz / freq;

  const s = (px + pz) * SIMPLEX_F2;
  const i = Math.floor(px + s), j = Math.floor(pz + s);
  const t = (i + j) * SIMPLEX_G2;
  const x0 = px - (i - t), y0 = pz - (j - t);

  // Which of the two triangles in this cell's unit square: upper (0,1) when
  // y0 > x0, lower (1,0) otherwise — `x0 >= y0` mirrors the shader's
  // `step(y0, x0)` (1 exactly when x0 >= y0) bit for bit.
  const i1 = x0 >= y0 ? 1 : 0, j1 = 1 - i1;

  const x1 = x0 - i1 + SIMPLEX_G2, y1 = y0 - j1 + SIMPLEX_G2;
  const x2 = x0 - 1 + SIMPLEX_G2 * 2, y2 = y0 - 1 + SIMPLEX_G2 * 2;

  const g0 = grassSimplexGradientAt([i, j], salt);
  const g1 = grassSimplexGradientAt([i + i1, j + j1], salt);
  const g2 = grassSimplexGradientAt([i + 1, j + 1], salt);

  const contribution = (g, x, y) => {
    const fall = Math.max(.5 - x * x - y * y, 0);
    const fall2 = fall * fall;
    return fall2 * fall2 * (g[0] * x + g[1] * y);
  };
  const n = (contribution(g0, x0, y0) + contribution(g1, x1, y1) + contribution(g2, x2, y2)) * 70;
  return Math.min(1, Math.max(0, n * .7 + .5));
}

/** CPU mirror of `grassMaterial.js`'s `patchNoise`: smooth gradient noise,
 * salted so coverage, tip hue, height and brightness read independent
 * patches rather than one shared noise field. Two octaves (1.5 m and 4 m),
 * salted apart from each other, own their scales outright — `x, z` are
 * always raw world-space metres, and no caller pre-divides them any more. */
export function grassPatchNoise(x, z, salt = 0) {
  return grassNoiseOctave(x, z, 1.5, salt) * .55 + grassNoiseOctave(x, z, 4, salt + 19.7) * .45;
}

/**
 * A blade's ROOT colour, derived from its TIP colour alone. The World only
 * authors leaf/dry TIP tones; the root always follows from this, so a
 * root/tip gradient exists even when nobody paints a separate root colour,
 * and it can never drift out of sync with whatever tip an author picks.
 *
 * Not a true HSL hue rotation — that needs branches this has to run
 * identically on the CPU (`worldPlanData.js`'s ground-colour match) and in
 * the TSL vertex stage (`grassMaterial.js`, via `grassRenderer.js`'s uniform
 * push) — but boosting green relative to red/blue before darkening reads the
 * same way: greener and darker than the tip it comes from.
 */
/**
 * The three blade tones exactly as `grassRenderer.js` uploads them (09-14): the
 * authored tip held to saturation .6 / lightness .48 and the dry tone to
 * saturation .5 / tip lightness + .06 — both in the PICKER's sRGB space — and
 * the root derived from the clamped tip. Everything that paints ground to meet
 * the sward (region palette, streamed palette, grass window) reads these, so
 * the ground under and beyond the grass is the colour the blades really are.
 */
export function grassSwardTones(tipColor = "#7c9448", dryColor = "#a89b5c") {
  const tip = new THREE.Color(tipColor || "#7c9448");
  const tipHSL = { h: 0, s: 0, l: 0 };
  tip.getHSL(tipHSL, THREE.SRGBColorSpace);
  tip.setHSL(tipHSL.h, Math.min(tipHSL.s, .6), Math.min(tipHSL.l, .48), THREE.SRGBColorSpace);
  const base = new THREE.Color(...deriveGrassBaseColor(tip.toArray()));
  const dry = new THREE.Color(dryColor || "#a89b5c");
  const dryHSL = { h: 0, s: 0, l: 0 };
  dry.getHSL(dryHSL, THREE.SRGBColorSpace);
  dry.setHSL(dryHSL.h, Math.min(dryHSL.s, .5), Math.min(dryHSL.l, Math.min(tipHSL.l, .48) + .06), THREE.SRGBColorSpace);
  return { tip, base, dry };
}

export function deriveGrassBaseColor([r, g, b]) {
  // A little extra desaturation toward the tip's own average, on top of the
  // green boost below: a fully saturated root read as its own separate hue
  // rather than a shaded-down version of the tip it grows from.
  const average = (r + g + b) / 3, desaturate = .18;
  const dr = r + (average - r) * desaturate, dg = g + (average - g) * desaturate, db = b + (average - b) * desaturate;
  // ⛔ 09-13: root darkening 0.45 → 0.62 — an overhead/three-quarter camera
  // read a near-black root against its lit tip as a dark hole; a shallower
  // darkening still reads as root, greener and darker than the tip, without
  // going as close to black.
  // 09-13 TINY GLADE RECEIPT: the reference sward is a DARK olive base under
  // bright tips; 0.62 read as a flat, pale ribbon. 0.48 keeps the root readable
  // (never black) while the tip carries the light.
  return [dr * .90 * .48, Math.min(1, dg * 1.10) * .48, db * .88 * .48];
}

// ⛔⛔ 09-13 REFERENCE-MODEL REWRITE: the owner's final verdict across ten
// shading passes on the OLD per-blade-normal model was that it was still
// "view-dependently f***ed" — a three-quarter view washed pale, straight down
// went near-black with radial streaks centred on the camera, and a high angle
// showed pale ground with dark blobs. Every one of those symptoms traces to
// the same root cause: a blade's own normal (facing lift, translucency, the
// old up-blend) is a function of the CAMERA, not the light, so the picture
// changes with where the viewer stands. The fix is the model, not another
// constant: every blade now shades with the TERRAIN normal at its root
// (`groundNormal` in `grassMaterial.js`), and colour carries only the ramp,
// the AO/depth/patch multiplier below, the hemisphere ambient and the
// far-field convergence — nothing that reads a view or per-blade-normal
// direction. `GRASS_FACING_AMPLITUDE`/`grassFacingFactor`/the old
// `grassBladeLuminance` translucency term are deleted outright, not floored
// again.
const GRASS_AO_FLOOR = .65;
const GRASS_DEPTH_FLOOR = .75; // ⛔ 09-13: raised from .5 — see grassMaterial.js
const GRASS_PATCH_AMPLITUDE = .16; // ⛔ 09-13: ±8% (was ±10%)

/** CPU mirror of `grassMaterial.js`'s `occlusion` (the root→tip AO ramp). */
export function grassOcclusion(along) { return GRASS_AO_FLOOR + (1 - GRASS_AO_FLOOR) * along; }

// ⭐ 09-13 OVERHEAD COVERAGE. From directly above, `facing` (a blade's normal
// dotted with the view direction) is exactly 0 for every blade, always — the
// view-space widening (`grassMaterial.js`'s `thicken`/`widened`) is therefore
// saturated to its own maximum, `width * GRASS_WIDEN_FACTOR` across the
// blade. The blade's own reach ALONG the ground is its rest lean projected
// onto the horizontal plane (`height * sin(lean)`, the Bézier tip's own `x`
// component before any yaw rotation). One blade per hex lattice cell
// (`grassRings`' own `cellFloor`), so the fraction of a cell's own ground a
// blade's widened top-down footprint leaves uncovered is what a straight-down
// camera actually sees as bare ground between blades — the regression gate
// for ring 0's own "12% bare from above" bound.
const GRASS_WIDEN_FACTOR = 1.4; // exact CPU mirror of grassMaterial.js's widening scale

/** A blade's own top-down footprint area, widened exactly as a straight-down
 * camera forces the shader's own view-space widening to its maximum. */
/** The blade arch (09-13): every blade's tip bends over by this many radians
 * on top of its authored lean, with the Bézier's P2 pulled toward the tip by
 * `GRASS_BLADE_ARCH_PULL`, so a blade presents a top-facing face from above
 * instead of a vertical needle (2 % ground cover straight down). The curve is
 * scaled by `GRASS_BLADE_ARCH_HEIGHT_SCALE` (≈ 1/cos arch) so the authored
 * height stays the sward's standing height. Mirrored by `grassMaterial.js`. */
export const GRASS_BLADE_ARCH = .6;
export const GRASS_BLADE_ARCH_PULL = .4;
export const GRASS_BLADE_ARCH_HEIGHT_SCALE = 1 / Math.cos(GRASS_BLADE_ARCH);

export function grassOverheadFootprintArea(width, height, lean) {
  const effectiveWidth = width * GRASS_WIDEN_FACTOR;
  // Horizontal reach of the arched tip: the curve's x(1) = sin(arch + lean).
  const reach = height * GRASS_BLADE_ARCH_HEIGHT_SCALE * Math.sin(Math.min(Math.PI / 2, GRASS_BLADE_ARCH + Math.abs(lean)));
  const effectiveLength = Math.max(width, reach);
  return effectiveWidth * effectiveLength;
}

/** Fraction of ring 0's own ground a straight-down camera sees as bare —
 * one blade's widened footprint against the hex cell it stands in. */
export function grassOverheadGapFraction({ cell = .024, width = .022 * 1.2, height = .18, lean = .24 } = {}) {
  const cellArea = cell * grassHexPitch(cell);
  const footprint = grassOverheadFootprintArea(width, height, lean);
  const coverage = Math.min(1, footprint / cellArea);
  return Math.max(0, 1 - coverage);
}

/** CPU mirror of `grassMaterial.js`'s `depthShade` (a tuft's own dark
 * interior), floored at 0.75 rather than 0.5. */
export function grassDepthShade(depthField, depthJitter) {
  return Math.min(1, Math.max(GRASS_DEPTH_FLOOR,
    GRASS_DEPTH_FLOOR + (1 - GRASS_DEPTH_FLOOR) * depthField + (depthJitter * .2 - .1)));
}

/** CPU mirror of `grassMaterial.js`'s `patch` (the smooth per-patch
 * hue/brightness noise), at ±8% amplitude. */
export function grassPatchFactor(patchValue) { return 1 + (patchValue * GRASS_PATCH_AMPLITUDE - GRASS_PATCH_AMPLITUDE / 2); }

/**
 * CPU mirror of `grassMaterial.js`'s `combinedMultiplier`: AO × depth ×
 * patch, clamped as one thing to [0.55, 1.0] — the guarantee that closes the
 * "blobs" verdict. Every input is a hash of a deterministic per-blade
 * `sample` index, never `Math.random()`, so a test result never flickers
 * between runs. ⛔ 09-13 REFERENCE-MODEL REWRITE: no facing term any more —
 * a blade's own normal no longer reaches colour at all.
 */
export function grassBladeShadingMultiplier(sample) {
  const along = grassClumpHash([sample, 0], 1.1);
  const patchValue = grassClumpHash([sample, 1], 2.2);
  const depthField = grassClumpHash([sample, 2], 3.3);
  const depthJitter = grassClumpHash([sample, 3], 4.4);
  const occlusion = grassOcclusion(along);
  const depthShade = grassDepthShade(depthField, depthJitter);
  const patch = grassPatchFactor(patchValue);
  return clamp(occlusion * depthShade * patch, .55, 1);
}

/**
 * CPU mirror of `grassMaterial.js`'s per-blade shading (09-13 reference-model
 * rewrite): ramp × the combined AO/depth/patch multiplier × brightness, plus
 * the flat hemisphere-ambient floor. `sample` is a deterministic per-blade
 * index; every random input is a hash of it, never `Math.random()`, so a
 * test result never flickers between runs.
 *
 * Deliberately takes NO view direction, camera position or ring index — the
 * whole point of the rewrite is that none of those may reach a blade's
 * colour any more. `viewDir` is accepted and ignored so a test can call this
 * with several different "camera" directions and assert byte-identical
 * output, the structural proof that the model has no view dependence left.
 */
export function grassBladeLuminance(sample, { viewDir = [0, 1, 0] } = {}) {
  void viewDir; // intentionally unused: colour must not depend on it
  const brightness = .65;
  const multiplier = grassBladeShadingMultiplier(sample);
  let surface = multiplier * brightness;
  // Hemisphere ambient: sky 0.6 / ground 0.4, a flat 0.5 grayscale proxy for
  // either colour, weighted the same 0.15 the shader adds.
  surface += .5 * .15;
  return surface;
}

/** CPU mirror of `grassMaterial.js`'s `rest` (a blade's lean/rest-pose
 * amount). ⛔ 09-13 FIFTH OWNER RECEIPT: `rest` used to hash PURELY from
 * `clumpCell` (0.35 m hex Voronoi), no per-blade term at all — every blade in
 * one clump shared the exact same lean and normal-tendency, so a directional
 * light lit each clump as one flat unit: round ~0.4 m spots straight down,
 * matching the clump scale almost exactly. Now the smooth ≥1.5 m patch-noise
 * field (`grassPatchNoise`) carries the large-scale drift and a small
 * per-blade hash (±8% of the [0,1] range, salted by the fan slot) rides on
 * top for grain — the same treatment every other shape/colour term already
 * has (`vary`/`widthVary`/`heightPatch`/`depthField`). Only YAW and the
 * density lottery still read the clump/tuft id directly. */
export function grassRestLean(leanMagnitude, bladeXZ, worldCell, fanSlot = 0) {
  const [x, z] = bladeXZ;
  const jitter = grassClumpHash([worldCell[0], worldCell[1]], fanSlot * 41.7 + 37.9) * .16 - .08;
  const restPatch = clamp(grassPatchNoise(x, z, 37.9) + jitter, 0, 1);
  return leanMagnitude * (restPatch * 2 - 1);
}

/** CPU mirror of `grassMaterial.js`'s `tuftGapRamp`: the ground-through-gaps
 * blend a fan ring's tip fades toward starts at EXACTLY ZERO at the ring's
 * own inner seam (`innerRadius`) and ramps up over `2*band` metres into the
 * ring's own interior — never a hard per-ring-index switch. `hole` is the
 * ring's own inner-hole fraction (0 for a ring with no hole, e.g. ring 0).
 * ⛔ 09-13 SIXTH OWNER RECEIPT: this is the regression gate for the sharp
 * horizontal tone line at the ring0/ring1 hand-over — the ramp must read
 * exactly 0 at `radial === innerRadius` for every ring that has one, so two
 * rings sharing a seam agree on this term exactly where a boundary would
 * otherwise show. */
export function grassTuftGapRamp(radial, innerRadius, hole, band = 3) {
  if (hole < .0001) return 0;
  const t = clamp((radial - innerRadius) / (2 * band), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Mean luminance over `count` deterministic blade samples, from several
 * different nominal "camera" directions. ⛔ 09-13 REFERENCE-MODEL REWRITE:
 * every entry of the returned array must be identical — that IS the
 * regression gate, replacing the old front-lit/backlit ratio check the
 * deleted translucency term needed. */
export function grassLuminanceMeans(count = 1000, viewDirs = [[0, 1, 0], [1, 0, 0], [0, 0, 1]]) {
  return viewDirs.map(viewDir => {
    let sum = 0;
    for (let sample = 0; sample < count; sample++) sum += grassBladeLuminance(sample, { viewDir });
    return sum / count;
  });
}
