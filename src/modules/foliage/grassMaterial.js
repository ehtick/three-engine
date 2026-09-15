import * as THREE from "three/webgpu";
import {
  Fn, abs, attribute, cameraViewMatrix, clamp, cos, cross, dot, float, floor, fract, instanceIndex,
  max, min, mix, normalize, pow, round, select, sin, smoothstep, sqrt, step, texture, uniform, varying, vec2, vec3, vec4,
} from "three/tsl";
import { foliageWindSample } from "./foliageWind.js";
import { GRASS_BLADE_ARCH, GRASS_BLADE_ARCH_PULL, GRASS_BLADE_ARCH_HEIGHT_SCALE } from "./grassField.js";

/**
 * Every blade of a grass field, built in the vertex shader.
 *
 * Nothing about a blade is stored: it belongs to a cell of a world-aligned
 * grid, and its jitter, yaw, height, lean and tint are hashed from that cell's
 * absolute coordinate. Where it may grow at all comes from the packed field
 * texture. The CPU sets a handful of uniforms and issues one draw per ring.
 *
 * ⛔ THE HASH IS KEYED ON THE WORLD CELL, NEVER ON THE INSTANCE INDEX.
 * The first version hashed the instance's position in the current grid. That
 * grid slides as the camera moves, so one step of the origin handed every blade
 * its neighbour's jitter, height and yaw and the whole field appeared to swim
 * across the terrain while orbiting. A blade is identified by where it is in
 * the world, and the grid is only the window currently drawing it.
 *
 * Shape follows the reference this was rebuilt from (SimonDev's grass, section
 * 13): a cubic Bézier bend whose gradient gives the normal, that normal blended
 * toward straight up with distance so a field reads as lit ground rather than
 * as dark noise, and a view-space widening so a blade turned edge-on never
 * thins into nothing.
 */

export function createGrassUniforms() {
  return {
    /** Ring centre in world XZ, snapped as the camera moves. */
    origin: uniform(new THREE.Vector2(0, 0)),
    /** size, columns, cell, hole — the ring this draw covers. */
    ring: uniform(new THREE.Vector4(52, 1, 52, 0)),
    /** ⛔ 09-13 HEX LATTICE FOOTPRINT FIX: the window's row COUNT, separate
     * from `ring.y` (its column count) — a hex lattice's row pitch is shorter
     * than its column spacing, so covering the same physical `size` along z
     * needs MORE rows than columns. Without this the window's z-reach fell
     * short of its x-reach by the pitch ratio (~13%), so a ring's own radial
     * fade never got the chance to run before blades simply ran out along z. */
    rows: uniform(1),
    /** first column, first row, column count — the visible part of the ring's
     * grid this draw covers. The renderer narrows it per camera. */
    window: uniform(new THREE.Vector4(0, 0, 1, 0)),
    /** Field coverage in metres: centre x, centre z, extent, one texel. */
    field: uniform(new THREE.Vector4(0, 0, 128, 1 / 256)),
    /** width, height, lean, height variation. */
    blade: uniform(new THREE.Vector4(.016, .18, .35, .45)),
    density: uniform(1),
    /** How far apart the fan of a tuft ring spreads its blades, in metres —
     * zero for a single-blade ring (ring 0), a small cluster radius for a
     * tuft ring. Every fan member reads the same tuft cell's EXISTENCE and
     * wind (one coin decides if the whole fan grows, one gust moves it); its
     * own colour, height, width and brightness are hashed from its own final
     * position (`bladeXZ` in `createGrassMaterial`), never the fan's centre —
     * 09-13 owner receipt, a residual per-fan grid. */
    tuftSpread: uniform(0),
    /** Ring 0's OWN cell size in metres, pushed to every ring (not just its
     * own) — the ring hand-over lottery hashes `floor(bladeXZ / cell0)` so
     * every ring agrees EXACTLY which physical blade-sized cell owns a given
     * spot, regardless of that ring's own (coarser) lattice. */
    cell0: uniform(.024),
    /** Direction FROM a blade TO the sun. ⛔ 09-13 REFERENCE-MODEL REWRITE: no
     * longer read by the shader — the sun-facing lift and the backlit
     * translucency term that used it were both view/normal-dependent colour
     * terms and are deleted outright. Kept only so `grassRenderer.js`'s
     * `settings.sunDirection` wiring has somewhere to write; nothing reads it
     * back. */
    sun: uniform(new THREE.Vector3(0, 1, 0)),
    /** Where blades start shrinking out, and where they are gone. */
    fade: uniform(new THREE.Vector2(90, 110)),
    /** The camera in the field's own frame. Blades are placed in that frame, so
     * every distance here has to be measured in it too. */
    camera: uniform(new THREE.Vector3(0, 0, 0)),
    /** brightness, occlusion depth, colour variation, sky response. Every one
     * of these is a uniform, so an author can take the sward down to whatever
     * value the scene wants without recompiling a shader.
     * ⛔ 09-13: colour variation dropped .35 → .2 and is now clamped in the
     * shader at ±8% (down from ±10%, tightened again with the "blobs" fix
     * below) — patches carry the variation, never individual blades. */
    tone: uniform(new THREE.Vector4(.65, .7, .2, 1)),
    base: uniform(new THREE.Color("#3f5a24")),
    /** How much of the ground's own colour the blade's base takes, so the
     * sward meets the terrain instead of sitting on it as a separate layer. */
    blend: uniform(.6),
    /** Ring 1 only: how far a tuft's own tip fades toward the ground colour.
     * A tuft fan leaves real air between its members, and without this the
     * ground glimpsed through those gaps is bare soil, not the sward's own
     * tone — a ring of stubble on brown dirt instead of a thinning carpet. */
    tipGround: uniform(0),
    tip: uniform(new THREE.Color("#8fa557")),
    dry: uniform(new THREE.Color("#b9ab63")),
    /** ⛔ 09-13 REFERENCE-MODEL REWRITE: no longer read — it fed the same
     * translucency term `sun` did, now deleted. Kept only for API
     * compatibility with any existing caller. */
    sunColor: uniform(new THREE.Color("#fff2db")),
    /** 09-13: hemisphere ambient so a shadowed or away-facing blade is never
     * literally black — sky above, ground bounce below. */
    skyAmbient: uniform(new THREE.Color("#bcd6ea")),
    groundAmbient: uniform(new THREE.Color("#4a3f2a")),
    /** 09-13 debug only: nonzero outputs the raw patch-noise value as
     * greyscale instead of the real blade colour, so a straight-edged cell
     * artifact in the underlying noise is visible on its own, isolated from
     * every other per-cell term this shader also computes. Never touched by
     * `grassRenderer.js` in ordinary use — 0 always. */
    grassDebugPatch: uniform(0),
  };
}

// ⭐ HASH WITHOUT SINE (Dave Hoskins, hash22/hash13), 09-14. `fract(sin(x)·43758)`
// was only as good as the GPU's `sin` at large arguments: world cells ×127 reach
// millions of radians, where float32 `sin` quantizes (and mobile drivers differ),
// so per-blade randomness banded. These use only fract/dot/mul — float-exact in
// WGSL and the WebGL2 fallback alike (no uint casts, which clamp negative cells
// to 0 in WGSL). CPU mirrors: `grassField.js#grassCellHash2`/`grassClumpHash`.

/** Two values in [0,1) from one world cell. */
const cellHash2 = /*@__PURE__*/ Fn(([cell]) => {
  const q = fract(vec3(cell.x, cell.y, cell.x).mul(vec3(.1031, .1030, .0973))).toVar();
  const r = q.add(dot(q, q.yzx.add(33.33))).toVar();
  return fract(vec2(r.x.add(r.y).mul(r.z), r.x.add(r.z).mul(r.y)));
});

/** One salted value in [0,1) from one world cell. */
const cellHash1 = /*@__PURE__*/ Fn(([cell, salt]) => {
  const q = fract(vec3(cell.x, cell.y, salt).mul(.1031)).toVar();
  const r = q.add(dot(q, q.zyx.add(31.32))).toVar();
  return fract(r.x.add(r.y).mul(r.z));
});

/** A unit gradient direction for one lattice corner, from a fixed set of 8
 * evenly-spaced directions (the standard discrete gradient set simplex noise
 * implementations use) rather than a continuous hashed angle. */
const simplexGradientAt = /*@__PURE__*/ Fn(([cell, salt]) => {
  const index = floor(cellHash1(cell, salt).mul(8));
  const angle = index.mul(Math.PI / 4);
  return vec2(cos(angle), sin(angle));
});

// ⛔⛔ 09-13 HEX LATTICE (SEVENTH OWNER RECEIPT). The isotropy target (≤1.15)
// survived simplex noise (≈1.33) because the residual was never the COLOUR
// noise's own lattice — it was `worldCell` itself: a jittered SQUARE instance
// grid, whose per-cell survival lottery makes coverage vary on that square's
// own axes. Replaced with a hexagonal (triangular) lattice: odd rows offset
// by half a cell along x, row pitch `cell·√3/2`, jitter uniform in a DISC
// (isotropic) rather than independently per axis. A triangular lattice's
// Voronoi cells (regular hexagons) have no preferred axis, unlike a square
// grid's. `grassHexPitch`/`grassBladeCell`/`grassHexBladeXZ` (`grassField.js`)
// are the exact CPU mirror.
const HEX_PITCH_RATIO = Math.sqrt(3) / 2;
/** 0 or 1, the half-cell x-offset a row gets — correct for a negative row,
 * where JS/GLSL's own `%` would otherwise return a negative remainder. */
const hexRowParity = row => row.sub(floor(row.div(2)).mul(2));
/** World XZ of one hex lattice point (before jitter), at column spacing
 * `cellSize`. */
const hexCellPoint = (cellSize, col, row) => vec2(
  col.add(hexRowParity(row).mul(.5)).mul(cellSize),
  row.mul(cellSize.mul(HEX_PITCH_RATIO)));
/** The hex lattice cell (col,row) nearest a world XZ point — the Voronoi
 * partition a triangular lattice makes. Checked over the 3×3 neighbourhood of
 * an approximate row/column (unrolled here at shader-build time, never a GPU
 * loop): a triangular lattice's true nearest point is never more than one row
 * away from that approximation. Used only by the shared ring-seam lottery, so
 * every ring hashes the SAME (ring 0, finest) hex lattice rather than a square
 * patch riding on top of it. `grassHexNearestCell` (`grassField.js`) is the
 * exact CPU mirror, gated against a from-scratch reference implementation. */
const hexNearestCell = /*@__PURE__*/ Fn(([cellSize, point]) => {
  const pitch = cellSize.mul(HEX_PITCH_RATIO);
  const rowApprox = round(point.y.div(pitch));
  const best = vec3(0, 0, 1e9).toVar();
  for (let dr = -1; dr <= 1; dr++) {
    const row = rowApprox.add(dr);
    const parity = hexRowParity(row);
    const colApprox = round(point.x.div(cellSize).sub(parity.mul(.5)));
    for (let dc = -1; dc <= 1; dc++) {
      const col = colApprox.add(dc);
      const candidate = hexCellPoint(cellSize, col, row);
      const diff = candidate.sub(point);
      const dist = dot(diff, diff);
      best.assign(select(dist.lessThan(best.z), vec3(col, row, dist), best));
    }
  }
  return best.xy;
});

// ⛔ 09-13 FIFTH OWNER RECEIPT: an isotropy check (axis-aligned vs diagonal
// gradient energy on the debug panel) still read anisotropic even after
// switching value noise to classic (Perlin) gradient noise. A rotation
// trick moved the bias off the world's own X/Z axes but did not remove it —
// classic Perlin's SQUARE lattice carries a faint axis-aligned bias
// regardless of gradients, which is exactly why Ken Perlin later devised
// simplex noise on a TRIANGULAR lattice. Kept as a small extra margin on
// top of simplex's own, much more isotropic lattice.
const ROTATE_COS = Math.cos(.4636), ROTATE_SIN = Math.sin(.4636);

/** One octave of 2D SIMPLEX noise on a metre lattice at world scale `freq`.
 * ⛔⛔⛔ 09-13 SIXTH OWNER RECEIPT: the isotropy ratio (target ≤1.15) was still
 * ≈1.34 with rotated classic Perlin noise — the square lattice's bias
 * survives a global rotation of the SAMPLE POINT because the LATTICE ITSELF
 * is still square and axis-aligned in its own frame; only the noise's
 * large-scale pattern rotates with it, not the lattice's intrinsic symmetry.
 * Simplex noise replaces the square lattice with a TRIANGULAR one (skewed
 * into place by `F2`/unskewed by `G2`, the standard 2D constants), evaluated
 * from the THREE nearest simplex corners rather than four square ones, each
 * weighted by a radially-symmetric `(0.5 − d²)⁴` falloff (never a per-axis
 * one) — there is no preferred axis left in the lattice's own geometry for a
 * global rotation to merely relocate. `grassNoiseOctave` (`grassField.js`)
 * is the exact arithmetic mirror; `test:foliage` gates 500 random points
 * agreeing to 1e-4. */
const SIMPLEX_F2 = (Math.sqrt(3) - 1) / 2, SIMPLEX_G2 = (3 - Math.sqrt(3)) / 6;

const noiseOctave = /*@__PURE__*/ Fn(([point, salt, freq]) => {
  const rotated = vec2(point.x.mul(ROTATE_COS).sub(point.y.mul(ROTATE_SIN)), point.x.mul(ROTATE_SIN).add(point.y.mul(ROTATE_COS)));
  const p = rotated.div(freq);

  // Skew (x,y) into simplex space to find which triangle cell we are in.
  const s = p.x.add(p.y).mul(SIMPLEX_F2);
  const i = floor(p.x.add(s)), j = floor(p.y.add(s));
  const t = i.add(j).mul(SIMPLEX_G2);
  const x0 = p.x.sub(i.sub(t)), y0 = p.y.sub(j.sub(t));

  // Which of the two triangles in this cell's unit square: upper (0,1) when
  // y0 > x0, lower (1,0) otherwise. `step(y0, x0)` is 1 exactly when x0 ≥ y0.
  const i1 = step(y0, x0), j1 = float(1).sub(i1);

  const x1 = x0.sub(i1).add(SIMPLEX_G2), y1 = y0.sub(j1).add(SIMPLEX_G2);
  const x2 = x0.sub(1).add(SIMPLEX_G2 * 2), y2 = y0.sub(1).add(SIMPLEX_G2 * 2);

  const g0 = simplexGradientAt(vec2(i, j), salt);
  const g1 = simplexGradientAt(vec2(i.add(i1), j.add(j1)), salt);
  const g2 = simplexGradientAt(vec2(i.add(1), j.add(1)), salt);

  // Each corner's contribution vanishes past a radius of √0.5 from it — a
  // radially-symmetric kernel, never a per-axis one — so `max(…, 0)` alone
  // (no branch) correctly zeroes a corner too far from the sample point.
  const contribution = (g, x, y) => {
    const fall = max(float(.5).sub(x.mul(x)).sub(y.mul(y)), 0);
    const fall2 = fall.mul(fall);
    return fall2.mul(fall2).mul(dot(g, vec2(x, y)));
  };
  const n = contribution(g0, x0, y0).add(contribution(g1, x1, y1)).add(contribution(g2, x2, y2)).mul(70);
  // 2D simplex noise's practical amplitude is close to, but not exactly,
  // [-1,1] once scaled by 70; remap into [0,1] with a little headroom
  // clamped rather than expecting exact unit range.
  return clamp(n.mul(.7).add(.5), 0, 1);
});

/** Smooth value noise, salted so several independent patches (coverage, tip
 * hue, height, brightness) never read the exact same field. Grass grows in
 * tufts and bare patches; an even carpet is the other way a field reads as
 * artificial. ⛔ 09-13 OWNER RECEIPT: "regular rectangular patches of
 * different colors" — a single lattice octave still traces its own cell
 * boundary once its result is quantised or fed into anything with contrast.
 * Two octaves, 1.5 m and 4 m, weighted and salted apart so neither one's own
 * lattice boundary survives into the sum. `point` is always raw world-space
 * metres now — this owns its own scales, and no caller pre-divides it any
 * more. `grassPatchNoise` (`grassField.js`) is its exact CPU mirror. */
const patchNoise = (point, salt) => noiseOctave(point, salt, 1.5).mul(.55)
  .add(noiseOctave(point, salt.add(19.7), 4).mul(.45));
/** The field's own coverage patchiness — kept as its own name/salt since it
 * feeds density, not colour, and existing tuning depends on this exact salt. */
const clumpNoise = point => patchNoise(point, float(5.71));

/** Rodrigues rotation about a unit axis. */
const rotateAbout = /*@__PURE__*/ Fn(([axis, angle, v]) => {
  const c = cos(angle), s = sin(angle);
  return v.mul(c).add(cross(axis, v).mul(s)).add(axis.mul(dot(axis, v)).mul(float(1).sub(c)));
});

/**
 * Cubic Bézier from an upright root to a leaning tip, with its gradient.
 * P0 = (0,0), P1 = (0,.33), P2 = (0,.66), P3 = (sin lean, cos lean); returns
 * (x, y, dx, dy) in unit blade lengths.
 */
const bladeCurve = /*@__PURE__*/ Fn(([lean, t]) => {
  // ⛔⛔⛔ 09-13 THE FROM-ABOVE DARKNESS WAS A VERTICAL NEEDLE. With P1/P2 on
  // the y axis and the tip only `lean` (±0.24 rad, ≤14°) off vertical, a
  // blade was a vertical sheet: full cover at grazing eye level, ~2 % of the
  // ground from straight above (magenta-ground receipt, `grass-angles.html
  // ?variant=flat-mg`), so every overhead or orbiting view showed the bare
  // terrain between blades and read as a dark, view-dependent sward. Real
  // grass ARCHES: the tip bends over by `GRASS_BLADE_ARCH` on top of the
  // authored lean, and P2 is pulled toward the tip so the upper half of the
  // blade lies over, presenting a top-facing face from any angle.
  const theta = float(GRASS_BLADE_ARCH).add(lean);
  const tipX = sin(theta), tipY = cos(theta);
  const p1x = float(0), p1y = float(.33), p2x = tipX.mul(GRASS_BLADE_ARCH_PULL), p2y = float(.70);
  const inverse = float(1).sub(t);
  const b1 = inverse.mul(inverse).mul(t).mul(3), b2 = inverse.mul(t).mul(t).mul(3), b3 = t.mul(t).mul(t);
  const x = b1.mul(p1x).add(b2.mul(p2x)).add(b3.mul(tipX));
  const y = b1.mul(p1y).add(b2.mul(p2y)).add(b3.mul(tipY));
  const d1 = inverse.mul(inverse).mul(3), d2 = inverse.mul(t).mul(6), d3 = t.mul(t).mul(3);
  const dx = d1.mul(p1x).add(d2.mul(p2x.sub(p1x))).add(d3.mul(tipX.sub(p2x)));
  const dy = d1.mul(p1y).add(d2.mul(p2y.sub(p1y))).add(d3.mul(tipY.sub(p2y)));
  return vec4(x, y, dx, dy);
});

/**
 * One material per ring of a field. `fieldTexture` is the packed ground —
 * height, density, height scale and dryness. Without one the field is a flat
 * plane at y = 0 at full density, which is what a standalone Grass Field is
 * before a World hands it any ground.
 */
export function createGrassMaterial(uniforms, windUniforms, { style = "natural", fieldTexture = null, groundTexture = null, outermost = false } = {}) {
  const natural = style === "natural";
  const bladeUV = attribute("bladeUV", "vec2");
  const side = bladeUV.x, along = bladeUV.y;
  const edge = side.sub(.5);

  // ---- which world cell this blade owns ------------------------------------
  const size = uniforms.ring.x, columns = uniforms.ring.y, cell = uniforms.ring.z, hole = uniforms.ring.w;
  // ⛔⛔ 09-13 HEX LATTICE FOOTPRINT BUG: `rows` (the window's own row count)
  // is NOT `columns` — a hex lattice's row pitch (`cell·√3/2`) is shorter
  // than its column spacing, so covering the SAME physical `size` along z
  // needs more rows than columns (`grassRings`, `grassField.js`, solves for
  // both together now). Using `columns` for the row count too (the old
  // square-grid assumption) made the window's z-reach fall short of `size`
  // by the pitch ratio (~13%) — an isolated ring-0 render showed this as a
  // squarish/elliptical cutoff where a soft circular fade was expected: the
  // blades simply ran out along z before the radial fade band got the
  // chance to run.
  const rows = uniforms.rows;
  // A draw only issues the slots its camera can see (`grassFrustumWindow`):
  // instance 0 is the window's corner, and the window's own column count
  // wraps the index, so each blade still lands on the same world cell.
  const index = float(instanceIndex);
  const span = uniforms.window.z;
  const slot = vec2(index.mod(span).add(uniforms.window.x), floor(index.div(span)).add(uniforms.window.y));
  // The grid is a window onto a world-aligned lattice. Rounding the origin into
  // cell units is what anchors the window: the ring only ever shifts by whole
  // columns/rows of its own hex lattice, however finely the camera itself is
  // snapped. Columns step by `cell`; rows step by the hex row pitch, since the
  // two axes are no longer the same spacing.
  const pitch = cell.mul(HEX_PITCH_RATIO);
  const originCol = round(uniforms.origin.x.div(cell));
  const originRow = round(uniforms.origin.y.div(pitch));
  const centreCol = floor(columns.mul(.5));
  const centreRow = floor(rows.mul(.5));
  // ⛔ 09-13 OWNER RECEIPT: a straight-edged checkerboard survived every noise
  // fix, INCLUDING the raw patch-noise value viewed in isolation
  // (`grassDebugPatch`) — proof the bug was never the noise maths (the CPU
  // mirror was, and stayed, provably smooth). `worldCell` is read from many
  // independently-derived expressions below (jitter, the survival lottery,
  // every patch/hue/height/width/depth hash, the boundary lottery, wind…);
  // three's `VaryingNode.generate()` caches its forced vertex rebuild by
  // `(node, builder.currentStack)`, not by node identity alone — reading the
  // SAME node from N different stacks re-triggers N independent rebuilds of
  // its defining expression (the exact "repeated-rebuild leak" already fixed
  // once for `normalLocal`/`pack` in the tree material, `foliageMaterial.js`).
  // Pinning with `.toVar()` right after each is derived makes it a plain
  // cached local instead, so every later reader shares the one already-built
  // value — this is what actually closed the gap between "the CPU mirror is
  // smooth" and "the GPU output is smooth". `worldCell` is now the hex
  // lattice's own (col, row) id — the cell every hash below keys on, lottery,
  // clump, colour and wind alike, unchanged by the switch except for how it
  // maps to a physical position below.
  const worldCell = vec2(slot.x.add(originCol).sub(centreCol), slot.y.add(originRow).sub(centreRow)).toVar();
  // Hex lattice point for this cell (odd rows offset half a cell along x, row
  // pitch cell·√3/2), plus jitter uniform in a DISC of radius 0.45 of a cell —
  // isotropic, unlike a square jitter range independently sized per axis.
  const rowParity = hexRowParity(worldCell.y);
  const latticeX = worldCell.x.add(rowParity.mul(.5)).mul(cell);
  const latticeZ = worldCell.y.mul(pitch);
  const jitter2 = cellHash2(worldCell);
  const jitterRadius = sqrt(jitter2.x).mul(cell).mul(.45);
  const jitterAngle = jitter2.y.mul(Math.PI * 2);
  const world = vec2(latticeX.add(cos(jitterAngle).mul(jitterRadius)), latticeZ.add(sin(jitterAngle).mul(jitterRadius))).toVar();

  // ---- which member of the tuft this vertex belongs to ---------------------
  // A tuft ring's instance is a fan of a few blades, all rooted in the SAME
  // cell — that is what keeps them reading as one clump under one gust with
  // one colour. Only where each fan member stands inside the cell is salted
  // by its own slot; the cell hash everything else reads from is untouched.
  const fanSlot = attribute("bladeSlot", "float");
  const slotAngle = cellHash1(worldCell, fanSlot.mul(23.7).add(121.3)).mul(Math.PI * 2);
  const slotRadius = cellHash1(worldCell, fanSlot.mul(31.1).add(205.7)).mul(uniforms.tuftSpread);
  const slotOffset = vec2(cos(slotAngle), sin(slotAngle)).mul(slotRadius);
  // ⛔ 09-13 THIRD OWNER RECEIPT: light/dark RECTANGLES persisted — this
  // blade's/fan-member's own final ground position, offset by `slotOffset`,
  // never the shared tuft root `world`. Every colour/height/width/brightness
  // hash below reads THIS, so two members of the same fan (rings 1/2) get
  // genuinely different samples instead of one flat value for the whole fan
  // — "per-cell values are allowed only for the density lottery" now holds
  // literally: `worldCell` (the shared tuft cell) still decides whether the
  // WHOLE fan exists and what wind it feels, but nothing else.
  const bladeXZ = vec2(world.x.add(slotOffset.x), world.y.add(slotOffset.y)).toVar();

  // ---- circular, soft ring boundaries ---------------------------------------
  // ⛔ 09-13 OWNER RECEIPT #1: "density gets cut off very soon with a
  // rectangle shape". The old cutout measured Chebyshev distance (max of
  // |x|,|y|) from the ring's own centre — a SQUARE by construction, whatever
  // curve is layered on top of it. Radial (Euclidean) distance from the same
  // centre, faded over a real band rather than tested at one hard radius,
  // removes the shape entirely.
  //
  // ⛔ 09-13 OWNER RECEIPT #2: "a dark annulus at the ring 0 outer edge". The
  // first fix multiplied a continuous fade into `coverage`, checked against
  // each ring's OWN independent per-cell lottery — two independent
  // probabilities near a seam (ring 0 fading 1→0, ring 1 fading 0→1) do not
  // guarantee exactly one of them survives at any one physical spot; through
  // the middle of the band both could keep a blade at once, summing their
  // (very different) native densities into a visibly darker/denser ring. The
  // fix is the same rule the foliage LOD tier dither already uses
  // (`foliageDitherSurvives`): ONE shared coin flip per physical patch,
  // tested against a THRESHOLD rather than folded into a probability, so the
  // two sides are mutually exclusive by construction — never both, never
  // neither.
  const localBlade = bladeXZ.sub(uniforms.origin);
  const radial = localBlade.length();
  const outerRadius = size.mul(.5), innerRadius = hole.mul(outerRadius);
  // ⛔ 09-13 SEVENTH OWNER RECEIPT: 1.5 → 3 (a 3 m → 6 m soft band) — a sharp
  // horizontal tone line still showed at the ring0/ring1 hand-over even once
  // colour and lean were shared and the geometry made to match (ring 1 now
  // bends with ring 0's own 2 segments, below). The per-blade seam LOTTERY
  // itself was still switching sharply enough, over its old 3 m band, to
  // read as an edge; doubling it makes the mix across the boundary more
  // gradual, and `tuftGapRamp` (below) widens along with it automatically
  // since it shares this same `band`.
  const band = 3; // half of a 6 m-wide soft band, centred on each boundary
  // ⛔ 09-13 FOURTH OWNER RECEIPT: whole 0.3 m patches — and, in rings 1/2,
  // whole 1-2 m TUFT cells — still dropped out together, reading as squares
  // and dark holes. A 0.3 m SHARED patch is still coarser than a single
  // blade, and it was hashed from the tuft's shared root, not each fan
  // member's own spot. The key is now `floor(bladeXZ / cell0)` — ring 0's
  // OWN (finest) cell size, shared to every ring's material as `cell0` — so
  // the coin flip is per BLADE (per fan member in rings 1/2, since `bladeXZ`
  // already includes `slotOffset`), never coarser: nothing above a single
  // blade ever switches sides, and both rings compute the IDENTICAL hash for
  // the identical world cell since they read the same absolute position at
  // the same fixed cell size.
  // ⛔ 09-13 HEX LATTICE: `floor(bladeXZ / cell0)` was itself a square
  // partition riding on top of the (now hex) blade lattice — the residual
  // grid the isotropy check kept finding. The seam key is now ring 0's own
  // HEX cell nearest this position, so the shared hand-over partitions the
  // ground the same isotropic way every other per-blade hash already does.
  const boundaryLottery = cellHash1(hexNearestCell(uniforms.cell0, bladeXZ), float(211.7));
  // The near (smaller-radius) side's own keep-probability at a shared seam:
  // 1 well inside it, 0 well outside — evaluated ONCE per physical radius, so
  // both rings either side of a seam read the identical value.
  const seamWeight = radius => float(1).sub(smoothstep(radius.sub(band), radius.add(band), radial));
  // This ring's own inner hole boundary, when it has one: this ring is
  // always the FAR side of that seam, so it keeps the complement of whatever
  // the ring just inside it keeps — never both, from the same coin flip.
  const innerPass = mix(float(1), step(seamWeight(innerRadius), boundaryLottery), step(.0001, hole));
  // This ring's own outer boundary: the NEAR side of a shared seam (tested
  // directly against the same weight), or — for the true outermost ring — a
  // real, still-soft, no longer stochastic cutoff, since there is no ring
  // beyond it to hand off to.
  const outerPass = outermost
    ? float(1).sub(smoothstep(outerRadius.mul(.85), outerRadius, radial))
    : step(boundaryLottery, seamWeight(outerRadius));
  const ringWeight = innerPass.mul(outerPass);

  // ---- what the ground says ------------------------------------------------
  let terrainY = float(0), coverage = float(1), heightScale = float(1), dryness = float(0), soil = null;
  // ⭐ REFERENCE-MODEL REWRITE (09-13): every blade's shading normal is now the
  // TERRAIN normal at its root — identical for every segment of the blade and
  // every ring — never the blade's own (view-sweeping) normal. Computed from
  // the packed field's height channel: a bilinear patch's own gradient from
  // the same four corner taps the height reconstruction already fetches, no
  // extra texture reads. Defaults to world-up when there is no field.
  let groundNormal = vec3(0, 1, 0);
  // ⛔⛔ 09-13 OWNER RECEIPT: eye-level rectangles ~1-2 m and a hard SQUARE in
  // the top-down debug view, at a scale neither the (now hex, isotropic)
  // blade lattice nor the (continuous) patch noise can produce — the one
  // remaining term at that scale is this field texture. `debugGroundTint`/
  // `debugDensitySample` below exist so the top-down debug panel can isolate
  // it from every other per-cell term.
  let debugGroundTint = float(0), debugDensitySample = float(1);
  if (fieldTexture) {
    const fieldUV = world.sub(uniforms.field.xy).div(uniforms.field.z).add(.5);
    const texel = uniforms.field.w;
    // ⛔⛔⛔ 09-13 THE BILINEAR RECONSTRUCTION DID NOT MATCH `sampleGrassField`
    // (`grassField.js`). `packGrassField` lays samples out EDGE-INCLUSIVE —
    // texel 0 sits exactly at the field's near edge, texel (size-1) exactly at
    // its far edge, spacing `extent/(size-1)` — and the CPU mirror reconstructs
    // with `u = normalizedUV * (size-1)`. This shader instead treated the data
    // as PIXEL-CENTRED (`grid = uv*size - .5`, the standard GPU texel-centre
    // convention, correct for a texture whose texel 0 sits half a texel IN from
    // the edge) — a real, silent mismatch between what the CPU says a world
    // point samples and what the GPU actually drew there, worst right where an
    // owner would look: near a texel boundary. `size` here is a genuinely
    // small texture (a World's own field is a few dozen to a few hundred
    // texels over tens of metres), so the discrepancy is texel-scale — the
    // "1-2 m rectangles" scale a field's own texel spacing lands at. Fixed to
    // the exact same `u = uv*(size-1)`, `column = min(size-2, floor(u))`
    // arithmetic the CPU mirror uses; a parity test now runs both formulas
    // against 500 points including exact texel edges.
    const texelCount = float(1).div(texel); // = size
    const gridF = clamp(fieldUV, 0, 1).mul(texelCount.sub(1));
    const corner = min(floor(gridF), texelCount.sub(2));
    const weight = gridF.sub(corner);
    // Each tap still has to land on the GPU's own texel-centre UV
    // (`(index+.5)/size`) to read that raw stored texel back exactly — that
    // part of the old code was already correct and is unchanged.
    const at = (map, dx, dy) => texture(map, corner.add(vec2(dx + .5, dy + .5)).mul(texel)).level(0);
    const bilinear = map => mix(mix(at(map, 0, 0), at(map, 1, 0), weight.x),
      mix(at(map, 0, 1), at(map, 1, 1), weight.x), weight.y);
    const ground = bilinear(fieldTexture);
    // The ground normal from the same four corner taps the height
    // reconstruction already fetched: a bilinear patch's gradient is exactly
    // the average rise over its two edge pairs, divided by the world spacing
    // between texels. `field.z` is the field's extent in metres and `texel`
    // is `1/size`, so their product is that spacing (exact at the pack step's
    // own `extent/(size-1)` to within one part in `size`).
    const h00 = at(fieldTexture, 0, 0).r, h10 = at(fieldTexture, 1, 0).r;
    const h01 = at(fieldTexture, 0, 1).r, h11 = at(fieldTexture, 1, 1).r;
    const cellWorldSize = uniforms.field.z.mul(texel);
    const slopeX = h10.sub(h00).add(h11.sub(h01)).mul(.5).div(cellWorldSize);
    const slopeZ = h01.sub(h00).add(h11.sub(h10)).mul(.5).div(cellWorldSize);
    groundNormal = normalize(vec3(slopeX.negate(), float(1), slopeZ.negate()));
    // Outside its coverage a field grows nothing, rather than clamping the edge
    // texel outward into a stripe of grass across the rest of the world.
    // ⛔ 09-13 OWNER RECEIPT: "density gets cut off very soon with a rectangle
    // shape" — a hard `step` at the packed field's own UV bounds is a real,
    // hard-edged rectangle at whatever radius the field happens to be smaller
    // than the ring's own reach (the field only covers the WORLD's extent;
    // the outermost ring's fuzz deliberately reaches well past a typical
    // grass draw distance for its silhouette). Fading over the last 8% of
    // the field on each axis turns that hard edge into a soft one — softer
    // still combined with the ring 2 fade above, since a field usually runs
    // out before a ring's own outer radius does.
    const edgeFade = axis => smoothstep(0, .08, axis).mul(smoothstep(0, .08, float(1).sub(axis)));
    const within = edgeFade(fieldUV.x).mul(edgeFade(fieldUV.y));
    terrainY = ground.r;
    coverage = ground.g.mul(within);
    heightScale = ground.b;
    dryness = ground.a;
    debugDensitySample = ground.g;
    if (groundTexture) { soil = bilinear(groundTexture).rgb; debugGroundTint = soil.r.add(soil.g).add(soil.b).div(3); }
  }

  // Tufts and thin patches at a metre scale, on top of whatever the ground says.
  const clump = clumpNoise(bladeXZ);
  // 09-13 TINY GLADE RECEIPT: "the sward ends in straight lines". The field's
  // density is a product of hard masks on the terrain grid, so a meadow's border
  // was a bilinear ramp along grid cells — a rectangle. Threshold it through a
  // metre-scale noise so the edge wanders in and out over ~2-3 m instead.
  const edgeNoise = patchNoise(bladeXZ, float(9.7)).sub(.5).mul(.35);
  coverage = smoothstep(.06, .5, coverage.add(edgeNoise)).mul(coverage.step(.001));
  coverage = coverage.mul(clamp(clump.mul(2.05).add(.16), 0, 1.35));
  heightScale = heightScale.mul(mix(float(.68), float(1.3), clump));
  // The radial ring-boundary fade folds into the SAME coverage the lottery
  // below tests, rather than a separate multiplier on the finished blade.
  coverage = coverage.mul(ringWeight);

  // ---- does it survive? ----------------------------------------------------
  const lottery = cellHash1(worldCell, float(17.3));
  const distance = world.sub(uniforms.camera.xz).length();
  // Density falls off continuously with distance, on top of the step each ring
  // already makes: thick underfoot, thin at the horizon, no visible ring seam.
  // The same lottery decides it, so a blade thins out where it stands rather
  // than the whole field flickering as the camera moves.
  const proximity = smoothstep(uniforms.fade.y, uniforms.fade.x.mul(.35), distance);
  // ⛔ A HARD FLOOR UNDER THE LOTTERY. `step(edge, x)` passes on equality, so a
  // cell the field says is bare — the river — still grows a blade wherever the
  // hash lands on zero. Sparse, evenly spread, and exactly the handful of
  // blades left standing in open water. Nothing grows below a real threshold.
  const wanted = step(lottery, coverage.mul(uniforms.density).mul(mix(float(.45), float(1), proximity)))
    .mul(step(.004, coverage));
  const near = smoothstep(uniforms.fade.x, uniforms.fade.y, distance).oneMinus();
  const alive = wanted.mul(near);

  // ---- the blade -----------------------------------------------------------
  // ⛔ 09-13 FOLLOW-UP OWNER RECEIPT: "a checkerboard of straight-edged 1-2 m
  // light/dark squares" survived the patch-noise and depth-shade fixes.
  // `vary` fed the explicit ±(spread) height term below AND the wind
  // stiffness, hashed straight from `worldCell` — for a TUFT ring that cell
  // is the whole fan's own (0.15-0.9 m) cell, so every one of its 10-12
  // blades got the IDENTICAL height multiplier and neighbouring fans jumped
  // to an unrelated one with no interpolation: a hard-edged block of
  // uniformly tall (or short) grass at cell resolution, the same bug already
  // fixed once for depth shade but still live here. Same fix: the smooth
  // `patchNoise` field carries the large-scale variation, a small per-blade
  // hash (salted by `fanSlot` too, so fan members decorrelate from each
  // other) rides on top for grain.
  const vary = clamp(patchNoise(bladeXZ, float(53.1)).add(cellHash1(worldCell, fanSlot.mul(19.3).add(53.1)).mul(.2).sub(.1)), 0, 1);
  // ⭐ A 1-3 m PATCH, NOT JUST THE FIELD'S OWN NOISE. The field's `heightScale`
  // above already varies with the ground (damp/dry), but a whole sward at one
  // scene's moisture still combed flat with no taller or shorter drifts of its
  // own — the owner's "no clumps, no patches" verdict. This is decorrelated
  // from the coverage clump noise (a different salt) so height patches and
  // bare-patch coverage never share the same boundaries.
  const heightPatch = patchNoise(bladeXZ, float(14.7));
  const spread = uniforms.blade.w;
  const height = uniforms.blade.y.mul(heightScale).mul(mix(float(.7), float(1.3), heightPatch))
    .mul(float(1).sub(spread).add(vary.mul(spread).mul(2))).mul(alive);
  // Same fix for blade WIDTH: it used to hash straight from `worldCell` too —
  // a tuft's whole fan sharing one width reads as a denser or sparser block
  // the instant it is viewed from above, exactly the "square" symptom.
  const widthVary = clamp(patchNoise(bladeXZ, float(91.7)).add(cellHash1(worldCell, fanSlot.mul(23.1).add(91.7)).mul(.2).sub(.1)), 0, 1);
  const width = uniforms.blade.x.mul(mix(float(.75), float(1.3), widthVary)).mul(alive);
  // ⭐ CLUMPS, NOT ONE COMBED DIRECTION. A blade's own cell is metres apart at
  // ring 0's density, far finer than a real tuft: hashing lean/yaw from it
  // gave every blade in view an independent, uncorrelated angle that averaged
  // out to "all leaning the same way" once wind was added on top. Sharing one
  // rest pose across a coarser ~0.35 m clump, then jittering each blade's own
  // yaw by up to ±25° around it, is what makes a tuft fan out from its own
  // centre instead of combing.
  // ⛔⛔⛔ 09-13 OWNER RECEIPT: axis-aligned light/dark rectangles at eye level
  // survived the hex-lattice fix to the BLADE lattice, the field-bilinear fix
  // and the ring-window fix — because none of those were the cause. Isolating
  // the sun-facing term alone (`grassDebugPatch` mode 5, unlit) at eye level
  // reproduced the exact same rectangles: `clumpCell` was still a plain
  // SQUARE `floor(world/.35)` partition sharing one rest-pose YAW across
  // every blade in it, and a directional sun lights a fixed yaw very
  // differently depending on which of many discrete hashed angles a clump
  // landed on — a whole square block of blades facing the light (or away
  // from it) identically. Replaced with the same hex (triangular) Voronoi
  // partition the ring-seam lottery already uses, at the same 0.35 m scale —
  // no preferred axis for a directional light to expose.
  const clumpCell = hexNearestCell(float(.35), world);
  const clumpYaw = cellHash1(clumpCell, float(7.9)).mul(Math.PI * 2);
  // ⛔ 09-13 OWNER VERDICT: "large organic blobs of near-white and near-black
  // blades" — within one clump every blade shared the SAME rest yaw (only
  // ±25° of jitter, and shared across a whole tuft fan since the jitter hash
  // read the fan's shared `worldCell`, not `fanSlot`), so a whole clump either
  // caught the sun-facing lift together or turned away into AO+depth darkness
  // together. Two fixes: the jitter is now salted by `fanSlot` too, so every
  // member of a fan gets its OWN yaw instead of one shared value; and the
  // jitter range widens to ±60°, blended against the shared clump yaw at a
  // reduced CLUMP_INFLUENCE weight (0.4) — net per-blade scatter of up to
  // ±60°×(1-0.4) around the clump's own rest direction, well past the old
  // ±25°, so neighbours inside one clump actually face different ways.
  // ⛔ 09-13 FOLLOW-UP OWNER RECEIPT: overhead and three-quarter shots still
  // showed a shared clump lean reading as dark/light swirls and camouflage
  // blobs — a whole clump still leaned mostly one way, exposing its dark
  // roots and the dark ground between blades together. CLUMP_INFLUENCE
  // 0.4 → 0.2 and the jitter range ±60° → ±70° so no clump leans as one; the
  // wind swell applied afterwards is unchanged.
  const CLUMP_INFLUENCE = 0.2;
  const yawJitter = cellHash1(worldCell, fanSlot.mul(97.3).add(53.9)).mul(2).sub(1).mul(70 * Math.PI / 180);
  const yaw = clumpYaw.add(yawJitter.mul(1 - CLUMP_INFLUENCE));
  // ⛔ 09-13 FIFTH OWNER RECEIPT: round ~0.4 m light/dark SPOTS straight down —
  // matching `clumpCell`'s own 0.35 m Voronoi scale almost exactly. `rest`
  // (the blade's lean/rest-pose amount) was the one shape term still hashed
  // PURELY from `clumpCell` with no per-blade component at all: every blade
  // in one clump shared the exact same lean and therefore the exact same
  // normal-tendency, so a directional light lit each clump as one flat unit —
  // the spot IS the clump. `rest` gets the same treatment every other
  // colour/height/width term already has (`vary`, `widthVary`, `heightPatch`,
  // `depthField`…): the smooth ≥1.5 m `patchNoise` field carries the
  // large-scale drift, a small per-blade hash (salted by `fanSlot`, ±8% of
  // the [0,1] range) rides on top for grain. Only YAW and the density lottery
  // still read the clump/tuft id directly.
  const restPatch = clamp(patchNoise(bladeXZ, float(37.9))
    .add(cellHash1(worldCell, fanSlot.mul(41.7).add(37.9)).mul(.16).sub(.08)), 0, 1);
  const rest = uniforms.blade.z.mul(mix(float(-1), float(1), restPatch));

  // The blade's own droop, before any weather. Wind is applied afterwards, in
  // world space, so it cannot be folded into this.
  const curve = bladeCurve(rest, along);
  // A circle/ellipse profile (exponent .5) rounds the tip instead of pinching
  // it to a point — must match `grassField.js`'s CPU rest-pose taper exactly.
  const taper = pow(max(float(1).sub(along.mul(along)), 0), .5);
  const across = edge.mul(width).mul(taper);
  const c = cos(yaw), s = sin(yaw);
  // Blade space: +x runs along the droop, +z across the ribbon.
  // The arch lowers the tip; scale the curve so the authored height is still the sward's standing height.
  const archHeight = height.mul(GRASS_BLADE_ARCH_HEIGHT_SCALE);
  const bentX = curve.x.mul(archHeight), bentY = curve.y.mul(archHeight);
  const rotated = vec3(bentX.mul(c).sub(across.mul(s)), bentY, bentX.mul(s).add(across.mul(c)));

  // ---- wind ----------------------------------------------------------------
  // ⛔ THE WIND BENDS EVERY BLADE THE SAME WAY, IN ONE WORLD DIRECTION.
  // Folding it into the blade's own lean instead — which is what the first
  // version did — makes each blade sway along its own random axis, so gusts
  // never read as gusts and the field never moves as one thing. The shared
  // field already carries a front travelling along the wind heading; all this
  // has to do is rotate the whole blade about the axis across that heading, by
  // an angle that grows up its length.
  //
  // ⛔ AND IT HAS TO BE SIGNED. The shared field's force channel is a positive
  // travelling front: driving the lean straight from it only ever pushes one
  // way, so the field throbs instead of swaying. Grass leans over, comes back
  // through upright and leans the other way. That is a signed swell, which is
  // what the reference gets from a noise in [-1,1].
  const wind = foliageWindSample(windUniforms, vec3(world.x, terrainY, world.y));
  const heading = windUniforms.direction.xz.div(max(windUniforms.direction.xz.length(), .0001));
  // up × heading, the same convention the tree and blade benders use.
  const windAxis = vec3(heading.y, 0, heading.x.negate());
  const clock = windUniforms.time.mul(windUniforms.speed);
  const alongWind = world.dot(heading), acrossWind = world.dot(vec2(heading.y.negate(), heading.x));
  // Two travelling scales: a slow swell and the gust riding on it. Both move
  // along the wind heading, so a wave crosses the whole field as one thing.
  // ⛔ 0.35 OF THE OLD AMPLITUDE. At full strength the wind swept every
  // blade's own clump-fanned rest pose into the same instantaneous lean,
  // which is what read as "combed" as much as the old per-blade hash did —
  // the rest pose above has to still dominate what a still frame looks like.
  const swell = (sin(alongWind.mul(.030).sub(clock.mul(.52)).add(acrossWind.mul(.016))).mul(.44)
    .add(sin(alongWind.mul(.085).sub(clock.mul(1.18)).add(acrossWind.mul(.030)).add(1.7)).mul(.36))).mul(.35);
  // The weather still decides how hard it blows and where the fronts are.
  const front = wind.x.mul(.8).add(.4);
  // A small, faster flutter per blade, so neighbours are never in lockstep.
  const flutter = sin(clock.mul(3.6).add(cellHash1(worldCell, float(41.3)).mul(Math.PI * 2)))
    .mul(.12).mul(abs(wind.y).add(.55));
  const stiffness = mix(float(1.25), float(.62), vary);
  const windAngle = clamp(windUniforms.strength.mul(swell.mul(front).add(flutter)), -1.35, 1.35)
    .mul(along).mul(stiffness);
  const swayed = rotateAbout(windAxis, windAngle, rotated);
  const bladeRoot = vec3(world.x.add(slotOffset.x), terrainY, world.y.add(slotOffset.y));
  const position = bladeRoot.add(swayed);

  // ---- normals -------------------------------------------------------------
  // The face normal is the Bézier gradient turned ninety degrees in the blade's
  // own plane; splaying it toward each edge shades the ribbon as a round stem.
  const tangent = normalize(vec2(curve.z, curve.w));
  const faceX = tangent.y.negate(), faceY = tangent.x;
  const splay = .55, splayCos = Math.cos(splay), splaySin = Math.sin(splay);
  const nx = faceX.mul(splayCos), ny = faceY.mul(splayCos), nz = edge.mul(2 * splaySin);
  const bladeNormal = normalize(rotateAbout(windAxis, windAngle, vec3(nx.mul(c).sub(nz.mul(s)), ny, nx.mul(s).add(nz.mul(c)))));
  // ⛔⛔ 09-13 REFERENCE-MODEL REWRITE: no per-blade normal, no up-blend, no
  // distance term. `bladeNormal` above is kept ONLY for the view-space
  // widening below (a geometry effect); the shading normal every blade uses
  // is `groundNormal` — the terrain normal at the blade's root, computed
  // above from the field's own height gradient, shared by every segment and
  // every ring alike. A ribbon standing in for the ground it grows out of has
  // to be LIT like that ground, not like a thin vertical sliver whose normal
  // sweeps the whole hemisphere as the blade leans, winds or is viewed from a
  // different angle — that per-blade sweep is exactly what read as a
  // view-dependent wash at grazing angles and dark radial streaks looking
  // straight down (the view vector, not the light, drove the old normal).

  // ---- view-space widening -------------------------------------------------
  // A blade edge-on to the camera is a sliver that aliases away. Widen it toward
  // the viewer as it turns, which is what keeps a sparse field looking covered.
  const view = normalize(uniforms.camera.sub(position));
  const facing = clamp(dot(bladeNormal, view), 0, 1);
  // ⛔ 09-13 OWNER RECEIPT: "a checkerboard of straight-edged 1-2 m squares"
  // that survived every noise/hash fix — including a plain linear ramp
  // rendered in place of colour, proving it was never a shading computation
  // at all. Root cause: viewed from directly above, a blade's OWN normal is
  // always perpendicular to `view` (it sweeps the horizontal plane; `view`
  // points straight up) — `facing` is exactly 0 for EVERY blade, always,
  // not just occasionally as it is from a side-on camera. The old
  // `smoothstep(0, .22, facing)` factor was meant to taper widening in
  // smoothly, but it also EXACTLY ZEROES the one value (`facing = 0`) that
  // most needs it — the blade edge-on case the whole mechanism exists for.
  // From the side this rarely lands on exactly 0, so it went unnoticed; from
  // directly above every blade hits it every frame, so NO blade ever widens
  // and the true near-invisible, thread-thin geometry aliases into whatever
  // pixels its raw silhouette happens to cross — a moiré of the jittered
  // grid itself, reproducing under ANY colour function, noise or not.
  // `pow(1-facing, 4)` alone is already monotonically 1 at facing=0 down to
  // 0 at facing=1, matching the stated intent ("widen it toward the viewer
  // as it turns") with no extra gate needed.
  const thicken = pow(float(1).sub(facing), 4);
  // The widening AXIS degenerates the same way: `cross(up, view)` is a
  // near-zero vector precisely when `view` is near-vertical (looking
  // straight down), and normalizing a near-zero vector is numerically
  // unstable — a tiny nudge keeps it well-defined for every view direction
  // without perturbing the ordinary side-on case, where `view` is nowhere
  // near vertical and the nudge is negligible next to it.
  // ⭐ 09-13: widen PERPENDICULAR TO THE BLADE AND THE VIEW, not merely
  // horizontal. `cross(up, view)` is horizontal, so from above it widened a
  // vertical sheet along the one axis that adds no footprint. Crossing the
  // blade's own 3D direction with the view gives the axis that maximises the
  // strip's projected area for every camera: identical to the old axis for an
  // upright blade seen from the side, and across the lean for a blade seen
  // from above. The nudge keeps it finite when the view runs along the blade.
  const bladeDir = rotateAbout(windAxis, windAngle, vec3(tangent.x.mul(c), tangent.y, tangent.x.mul(s)));
  const right = normalize(cross(bladeDir, view).add(vec3(.0001, 0, .0001)));
  const widened = position.add(right.mul(edge.mul(width).mul(thicken).mul(1.4)));

  // ---- colour --------------------------------------------------------------
  // Quantised per-cell brightness makes patches rather than per-blade static.
  // Quantised per-cell brightness, and DARK: an albedo near white blows out
  // under any real sun long before the ground it is supposed to sit in does.
  // The reference halves its blade colour for the same reason.
  // ⛔ 09-13: A SMOOTH PATCH FIELD, NEVER A BLADE'S OWN CELL AND NEVER A HARD
  // QUANTISATION BUCKET. Two separate bugs produced the same "regular
  // rectangular patches of different colors" owner receipt: hashing per
  // blade-cell at ring 0's density gave every neighbouring blade its own
  // independent brightness (the "individual ribbons" verdict), and rounding
  // that hash into four discrete buckets (`floor(hash*4)/4`) traced its own
  // lattice cell as a hard-edged rectangle the moment two adjacent buckets
  // differed — smooth interpolation elsewhere in this shader never covered
  // for a value that was never smooth to begin with. `patchNoise` alone (two
  // octaves of simplex noise, continuous and isotropic) replaces both: one
  // continuous field, shared across many neighbouring blades, capped well
  // below what an author could previously dial in.
  // ⛔⛔ 09-13 REFERENCE-MODEL REWRITE: no sun-facing lift, no view-vector term
  // in colour at all. `facingSun`/`toSun` are gone — a blade's OWN normal no
  // longer decides anything about its albedo; only the terrain normal
  // (`groundNormal`, above) reaches the BRDF, and the BRDF's own N·L already
  // does the sun-facing work correctly and without a view dependency.
  // ⛔ 09-13: ±8% (was ±10%) — part of the tighter blade-to-blade contrast
  // budget the combined multiplier clamp below now enforces as a whole.
  const variation = min(uniforms.tone.z, float(.16));
  const brightnessNoise = patchNoise(bladeXZ, float(3.3));
  const patch = brightnessNoise.mul(variation).sub(variation.mul(.5)).add(1);
  // ⛔ ONE MONOTONIC RAMP, ROOT TO TIP, AND GENTLER. An occlusion that dipped
  // in the lower third and recovered — which is what trying to hand the root
  // the ground's colour produced — banded every blade into a dark middle
  // under a bright top. The reference has exactly one gradient along a blade:
  // ambient occlusion, dark where the sward closes over the litter and open
  // at the tip. ⭐ 09-13: the floor is clamped no darker than .55 (was as low
  // as .3 at the default `grassOcclusion`) and the ramp is linear instead of
  // `pow(along, 1.6)` — a mass of grass has a gentler root-to-tip falloff than
  // a single backlit hero blade, so the per-blade AO no longer reads as the
  // dominant light/dark signal.
  // ⭐ THE ROOT IS DERIVED, NOT AUTHORED. `uniforms.base` already carries the
  // owner's tip colour darkened toward green (`deriveGrassBaseColor`,
  // `grassRenderer.js`) — the World only ever authors leaf/dry TIP tones —
  // so a root/tip gradient exists even when nobody paints a separate root
  // colour, and it can never drift out of sync with whatever tip an author
  // picks.
  // 09-13 Tiny Glade receipt: a steeper root→tip gradient (1.15 → 1.7) keeps the
  // dark base over most of the blade and lets only the top catch the light; the
  // tip end also warms slightly toward the sun's own yellow.
  const tipWarm = uniforms.tip.mul(vec3(1.04, 1, .86));
  const blade = mix(uniforms.base, tipWarm, pow(along, 1.7));
  // ⭐ A 1-3 m PATCH OF ITS OWN, ON TOP OF MOISTURE. The field's `dryness`
  // already yellows a blade where the ground is dry, but one whole scene at
  // one moisture read as flat — a real sward has drifting yellower/greener
  // patches that have nothing to do with the terrain's own wetness map.
  const huePatch = patchNoise(bladeXZ, float(8.13));
  // 09-13: no constant floor — a moist meadow shows NO straw; the patch term only
  // varies where the field says the ground is dry.
  const dryWeight = clamp(dryness.mul(.5).add(huePatch.mul(.3).sub(.15)), 0, 1);
  const tinted = mix(blade, uniforms.dry, pow(along, 3).mul(dryWeight));
  // The whole blade leans toward the ground's own colour, so a sward of them
  // averages to the terrain rather than to a different green standing on it.
  // The root is met from the other side too: `worldPlanData.js` packs the
  // ground's colour under a sward as the SWARD'S OWN MEAN VISIBLE COLOUR
  // (≈0.4 root + 0.6 tip, times the same depth-darkening mean this shader
  // averages to) rather than the root alone — ⛔ 09-13 owner receipt, "does
  // not blend with terrain well". A flat multiplier here used to push the
  // ground brighter than that packed value on top of it; the packed value is
  // now already the target tone, so this reads it straight.
  const groundTone = soil ? soil : tinted;
  // 09-13 Tiny Glade receipt: blades took a third of the TERRAIN colour along
  // their whole length, so over mud the sward went grey-brown. Blend only the
  // root, and only a little; a sward should meet the ground, not become it.
  let grounded = soil ? mix(tinted, groundTone, uniforms.blend.mul(.2).mul(float(1).sub(along))) : tinted;
  // ⛔ A TUFT RING'S OWN GAPS. A tuft fan is several blades sharing one cell
  // with real air between them; without this the ground glimpsed through
  // those gaps is the bare soil colour, not the sward's own, and the ring
  // reads as stubble on brown dirt rather than a thinning carpet. Only the
  // top half of a blade fades — the root already meets the ground its own
  // way, above.
  // ⛔⛔ 09-13 SIXTH OWNER RECEIPT: a sharp horizontal TONE LINE at the
  // ring0→ring1 hand-over — `tipGround` used to switch from a hard 0 (ring 0)
  // to a hard 0.5 (ring 1 only, by `ring.index === 1`) with no transition, so
  // the identical world blade rendered two completely different colours
  // depending only on which ring's draw happened to win the seam lottery
  // right at the boundary. Every ring now ramps this term up from EXACTLY
  // ZERO at its own inner seam (`innerRadius`, which for a ring with a hole
  // equals the ring just inside it's own outer radius — the two already
  // agree on this number by construction) over the same `band` width the
  // seam lottery itself fades over, reaching the ring's authored target only
  // a couple of bands into its own interior. Ring 0 has no inner hole
  // (`hole` = 0) so its ramp is pinned to zero everywhere, unchanged; ring 1
  // and ring 2 both start their own ramp at zero AT the seam they hand over
  // from, so the two sides of any boundary agree exactly where it matters.
  if (soil) {
    const tuftGapRamp = smoothstep(innerRadius, innerRadius.add(band * 2), radial).mul(step(.0001, hole));
    grounded = mix(grounded, groundTone, uniforms.tipGround.mul(tuftGapRamp).mul(smoothstep(.5, 1, along)));
  }
  // ⭐ THE FAR FIELD IS ONE TONE, NOT THREE RINGS. Distance alone — never the
  // ring boundary — converges every ring's own colour toward the same ground
  // tone by 60 m, so there is no silhouette ring where one ring's draw ends
  // and the next begins: only a soft fuzz thinning into the terrain it grows
  // out of, exactly like the reference's far field.
  // ⭐ 09-13: converges by 45 m (was 60 m) — ring 2's fuzz starts around 19 m
  // and is meant to read as one tone with the ground well before its own
  // outer reach, not still visibly its own tinted colour that far out.
  // Far blades converge on the SWARD's own mean half-mixed with the ground, not on
  // the bare terrain colour (which made every distant meadow the colour of mud).
  if (soil) grounded = mix(grounded, mix(mix(uniforms.base, tipWarm, .55), groundTone, .5), smoothstep(float(8), float(45), distance));
  // ⭐ 09-14 THE DRAW DISTANCE IS A TRANSITION, NOT AN EDGE (owner: "even when
  // grass is not drawn at a distance, we merely see a transition"). Over the
  // second half of the way to `fade.x` every blade lands exactly on the packed
  // ground colour — under a sward that IS the sward's own mean visible tone
  // (`worldPlanData.js#paintGroundVertex`, `worldGrassWindow.js`) — and sheds
  // the AO/brightness multipliers the bare terrain never had, so the carpet
  // thins out in the colour the terrain beyond it already wears.
  const farGround = soil ? smoothstep(uniforms.fade.x.mul(.5), uniforms.fade.x, distance) : float(0);
  if (soil) grounded = mix(grounded, groundTone, farGround);
  // The floor of the ambient occlusion, and the overall level of the whole
  // sward. Grass that will not go dark enough for a scene is the commonest
  // complaint about any of this, so both are plain multipliers on the albedo:
  // whatever the lighting does, this is the value it starts from.
  // ⛔ 09-13: AO ramp floor 0.55 → 0.65 — an overhead/three-quarter camera
  // read the root end of a leaning blade as near-black next to its lit tip,
  // reading as dark holes/blobs rather than a soft sward. Exact CPU mirror:
  // `grassField.js`'s `GRASS_AO_FLOOR`.
  const depthFloor = max(float(1).sub(uniforms.tone.y), float(.65));
  const occlusion = mix(depthFloor, float(1), along);
  // ⭐ DEPTH: A TUFT HAS A DARK INTERIOR. A shorter blade sits deeper inside
  // its own clump and catches less light there, so a dark-in-the-middle mass
  // under lighter tips reads better than one flat wash.
  // ⛔ 09-13 OWNER RECEIPT: "a blocky pattern of darker squares ~0.5 m" — two
  // separate bugs. (1) The old version hashed straight from `worldCell`,
  // which for a TUFT ring is the whole fan's own cell (~0.15-0.9 m here):
  // every blade of one fan got the exact identical depth value, and
  // neighbouring fans jumped to an unrelated one with no interpolation
  // between them. Fixed by salting the fine jitter with `fanSlot` too, so
  // each member of a fan reads its OWN small offset instead of sharing one.
  // (2) A follow-up receipt found blockiness STILL visible front-lit even
  // after that — the smooth `patchNoise` field is the dominant term now, and
  // only a small ±10% per-blade/per-fan hash rides on top for grain, never a
  // per-cell constant doing the whole job.
  const depthField = patchNoise(bladeXZ, float(61.3));
  const depthJitter = cellHash1(worldCell, fanSlot.mul(43.1).add(61.3)).mul(.2).sub(.1);
  // ⛔ 09-13: depth-darkening floor raised .5 → .75 — a tuft's dark interior
  // was its own second source of hard per-blade contrast on top of AO, part
  // of what the owner's "blobs" verdict was reading.
  const DEPTH_FLOOR = .75;
  const depthShade = clamp(mix(float(DEPTH_FLOOR), float(1), depthField).add(depthJitter), DEPTH_FLOOR, 1);
  // ⛔ 09-13 FOLLOW-UP OWNER RECEIPT: front-lit read dark and blocky because
  // `occlusion` and `depthShade` are two independent floors MULTIPLIED
  // together — 0.55 × 0.5 can fall to 0.275, well under either one's own
  // floor.
  // ⛔⛔ 09-13 REFERENCE-MODEL REWRITE: no sun-facing term in the product any
  // more — a blade's own normal no longer decides its albedo at all, so
  // there is nothing left here for a "facing" factor to read. The combined
  // multiplier is AO × depth × patch, clamped as one thing to the full
  // authored contrast range, [0.55, 1.0].
  const combinedMultiplier = clamp(occlusion.mul(depthShade).mul(patch), .55, 1);
  let surface = grounded.mul(mix(combinedMultiplier, float(1), farGround)).mul(mix(uniforms.tone.x, float(1), farGround));

  // ---- ambient (09-13) -------------------------------------------------
  // A shadowed or away-from-the-sun blade still sits under open sky and
  // beside lit ground, so it is never actually black — a flat hemisphere
  // term (sky above weighted 0.6, ground bounce below weighted 0.4) floors
  // every blade regardless of its own facing or the direct-light term below.
  const ambient = mix(uniforms.groundAmbient, uniforms.skyAmbient, .6);
  // 09-13: this is an ALBEDO. Adding a grey-blue ambient into it desaturated every
  // tip toward white before the lights even ran; the scene's sky/env lighting is
  // what should lift a shaded blade. A trace of it stays so a dark root never goes black.
  surface = surface.add(ambient.mul(.04));

  // ⛔⛔⛔ 09-13 REFERENCE-MODEL REWRITE: the sun-facing lift and the
  // translucency term are both deleted outright, not just softened again.
  // Both read a per-blade or view-relative direction (`bladeNormal`/`view`)
  // into the ALBEDO, which is exactly what a pale wash at grazing angles and
  // dark radial streaks looking straight down turned out to trace back to —
  // "it is still view-dependently f***ed" was correct: the model itself, not
  // any one constant in it, was the bug. Colour now carries only the ramp,
  // the AO/depth/patch multiplier above, the hemisphere ambient and the
  // far-field convergence below; the sun's direct contribution comes
  // entirely from the BRDF's own N·L against `groundNormal`, which is a
  // property of the ground, never of the camera.

  // ---- debug: isolate one per-cell term as greyscale (09-13, then 09-13
  // follow-up) ---------------------------------------------------------
  // `grassDebugPatch` is a MODE, not a boolean: 1 = raw patch noise, 2 = the
  // field's ground-tint sample, 3 = the field's density sample, 4 = this
  // ring's own window (seam) weight. Isolates one per-cell term from every
  // other this shader computes — `grassRenderer.js` never sets this above 0
  // in ordinary use, only a debug preview does. Modes 2/3 exist specifically
  // to catch a field-texture reconstruction bug the patch-noise-only debug
  // (mode 1) could never show, since patch noise is computed independently
  // of the field texture entirely.
  // ⛔⛔⛔ 09-13 THE DEBUG VIEW WAS NEVER UNLIT. Writing the debug value into
  // `colorNode` (albedo) still sends it through the FULL physical BRDF —
  // direct light integrated against `normalNode` (which blends toward
  // straight-up with distance and rides the wind/clump yaw), ambient, the
  // lot. A perfectly UNIFORM debug value (e.g. mode 3 against a field whose
  // density is a flat constant everywhere) still rendered as a visible
  // checkerboard, because per-blade NORMAL-FACING shading varies with
  // clump/yaw/distance regardless of what the albedo says — every prior
  // "checkerboard survives in the debug view" receipt was reading that
  // shading pattern, not the term it claimed to isolate. Fixed by routing the
  // debug value through `emissiveNode` (unlit, added on top of a albedo
  // forced to black in debug mode) instead of `colorNode`, so the rendered
  // pixel is the raw value with no lighting response at all.
  const debugMode = uniforms.grassDebugPatch;
  const debugActive = step(.5, debugMode);
  const debugBand = target => step(target - .5, debugMode).mul(step(debugMode, target + .5));
  let debugScalar = brightnessNoise; // mode 1 (and the pre-mode default)
  debugScalar = mix(debugScalar, debugGroundTint, debugBand(2));
  debugScalar = mix(debugScalar, debugDensitySample, debugBand(3));
  debugScalar = mix(debugScalar, ringWeight, debugBand(4));
  // Mode 5: the ground normal's own upward component (`groundNormal.y`) —
  // isolates the terrain-gradient term the whole shading model now reads,
  // in place of the retired per-blade sun-facing debug.
  debugScalar = mix(debugScalar, groundNormal.y, debugBand(5));
  surface = surface.mul(float(1).sub(debugActive));
  const debugEmissive = vec3(debugScalar).mul(debugActive);

  // ⛔ PHYSICAL, NOT STANDARD, FOR ONE REASON: `specularIntensity`.
  // A blade is thin and nearly edge-on most of the time, so the dielectric
  // Fresnel rim every standard material carries lights its whole silhouette —
  // that is the glint no amount of darkening the colour could remove, because
  // it is not coming from the colour. Physical lets it go to zero.
  const material = new THREE.MeshPhysicalNodeMaterial({
    roughness: natural ? 1 : .88, metalness: 0, specularIntensity: 0, side: THREE.DoubleSide,
  });
  material.positionNode = widened;
  // ⛔⛔⛔ 09-13 REFERENCE-MODEL REWRITE: NOT flipped by `faceDirection` any
  // more. The old per-blade normal needed that flip because it genuinely
  // pointed a different way on a strip's back face; `groundNormal` points
  // straight out of the terrain regardless of which face of the (double-
  // sided) blade strip a fragment belongs to, so both faces correctly share
  // the one ground normal rather than one of them getting it mirrored.
  // ⛔⛔⛔ 09-13 THE VIEW-DEPENDENT SHADING WAS A SPACE MISMATCH. `groundNormal`
  // is a WORLD-space vector (+y up, slopes from the world-aligned field), but
  // three consumes `normalNode` as `normalView` — VIEW space. Handing it over
  // untransformed made the lighting frame rotate with the camera: from a
  // three-quarter view "up" happens to be roughly screen-up so the sun still
  // landed, from straight above the same sward went black, and every orbit
  // swung the tone. Rotate by the camera's view matrix (rotation only) first.
  const groundNormalView = normalize(cameraViewMatrix.mul(vec4(groundNormal, 0)).xyz);
  material.normalNode = varying(groundNormalView, "vGrassNormal");
  material.colorNode = varying(surface, "vGrassColour");
  // ⭐ 09-13 SUN THROUGH THE BLADE (Tiny Glade receipt: "their tips glow where the
  // sun comes through them"). A thin blade transmits light: when the camera looks
  // toward the sun through a tip, the tip lights up with the sun's colour. This is
  // a physically motivated, smooth function of (view · −sun) — not the old
  // normal/facing tricks — so it cannot pop as the camera orbits; it fades to
  // nothing with the sun below the horizon and lives only in the upper blade.
  const backlight = pow(clamp(dot(view, uniforms.sun.negate()), 0, 1), 4)
    .mul(clamp(uniforms.sun.y.mul(3), 0, 1));
  const translucency = tipWarm.mul(backlight).mul(pow(along, 2)).mul(.45).mul(float(1).sub(debugActive));
  material.emissiveNode = varying(debugEmissive.add(translucency), "vGrassDebugEmissive");
  material.name = `Grass field · ${style}`;
  material.userData.grass = { style, splay, hasField: !!fieldTexture, flatten: [3, 15], outermost, ringBand: band };
  return material;
}
