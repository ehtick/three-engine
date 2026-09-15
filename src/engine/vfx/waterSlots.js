import * as THREE from "three/webgpu";
import { Fn, dFdx, dFdy, float, instanceIndex, int, ivec2, refract, select, storageTexture, texture, uniform, uv as uvAttribute, varying, vec2, vec3, vec4 } from "three/tsl";
import { seaDisplacementAt, seaSlopeAt } from "./waterSpectrum.js";
import { waterRimDistanceNode } from "./waterShape.js";

/** The ripple window's sample at a LOCAL point: (height, normal.x, normal.z,
 *  foam), zero outside the window. Shared by the slot kernel and the lens. */
function rippleSampler({ rippleTexture, rippleResolution: w, uniforms: u }) {
  const uv = (local) => vec2(local.x.sub(u.rippleCenter.x).div(u.rippleHalf.x.mul(2)).add(.5), local.z.sub(u.rippleCenter.y).div(u.rippleHalf.y.mul(2)).add(.5));
  const inside = (t) => t.x.greaterThan(.5 / w).and(t.x.lessThan(1 - .5 / w)).and(t.y.greaterThan(.5 / w)).and(t.y.lessThan(1 - .5 / w));
  return {
    at: (local) => { const t = uv(local); return select(inside(t), texture(rippleTexture, t).level(0), vec4(0)); },
    atOffset: (local, dx, dy) => { const t = uv(local).add(vec2(dx / w, dy / w)); return select(inside(t), texture(rippleTexture, t).level(0), vec4(0)); },
  };
}

/**
 * ══ THE WATER SLOT POOL — WHY THE BINDINGS ARE ENGINE-OWNED ════════════════
 *
 * Three consumers need to read a water surface every frame: the underwater
 * medium (`waterMedium.js`, a node on `scene.fogNode`), the raster caustic
 * light, and the GI sun term inside `srcShade.js`. All three are compiled
 * graphs, and in this engine a graph that binds a texture belonging to a
 * COMPONENT is a graph that must be rebuilt whenever that component is — a
 * resolution edit, a detach, a play/stop. For the GI kernels that is a
 * multi-second compile wave; for `scene.fogNode` it is every material in the
 * project.
 *
 * So the textures do not belong to the water. A fixed pool of slots is
 * allocated once per engine and lives for its lifetime; a water surface CLAIMS
 * a slot and renders into it, and every consumer binds the slot. Water can
 * appear, change resolution and vanish without a single graph rebuild — an
 * empty slot simply publishes `active = 0`, which every consumer already reads
 * as "no water here".
 *
 * That is also why the slot textures are a FIXED 128², rather than the solver's
 * own grid: the size is part of the binding. A coarse solver is resampled up
 * (smoothly — the source is linearly filtered), which is the right direction
 * anyway, because a caustic is a lens and its detail should not step with the
 * simulation's cell size.
 */

export const MAX_WATER_SLOTS = 2;
/** The caustic map's world footprint around the camera; see `causticCenter`. */
export const CAUSTIC_WINDOW_METRES = 16;
// The medium's copy of the surface: what the underwater view clips against.
// Same size as the caustic map, because they share one texture array.
const SLOT_RESOLUTION = 1024;
// The reference projects caustics at 1024 for a two-unit pool; the filaments
// are only ever as thin as this map and as the lens feeding it. A 60 m lake
// gets 6 cm texels here, which is about as fine as its lens can focus anyway.
export const CAUSTIC_RESOLUTION = 1024;
/**
 * ⭐ **THE CAUSTIC GRID IS ITS OWN RESOLUTION, NOT THE SOLVER'S.**
 *
 * The refracted grid is rasterized, so the map is filled by construction — but
 * the lens is only as smooth as the grid that samples it. It used to be one
 * vertex per SOLVER cell (capped at 256), and the fine detail that actually
 * makes caustics was then sampled at 4 cm on a 5 m pool and at 47 cm on a 60 m
 * one: octaves below that spacing came back as an unrelated random slope at
 * every vertex, and the rasterizer drew those as a floor full of thin random
 * scratches ("caustics are random now, too low poly and unrealistic", user
 * 2026-09-06). At 60 m the lens had no detail at all and the floor was blank.
 *
 * 512² beams whatever the solver's grid, reading the solver's surface
 * bilinearly and bending by detail band-limited to THIS spacing (see
 * `seaSlopeAt`'s per-cascade mips). A quarter of a million vertices in one
 * draw is nothing; a lens made of aliasing was the whole problem.
 */
const CAUSTIC_GRID = 512;
// Ceiling on the compression ratio. An exactly focal point divides by zero, and
// a firefly in a LIGHT is a firefly in every bounce that light ever takes.
const MAX_FOCUS = 5;
const IOR = 1 / 1.333;

/**
 * ⭐ **AND IT CARRIES A MIP CHAIN, WHICH IS WHAT MAKES LIGHT SHAFTS SMOOTH.**
 *
 * The floor wants every filament this map can hold. The shafts do not: they are
 * an integral ALONG the beam, estimated from a dozen taps, and a dozen samples
 * of a high-contrast field is a noisy estimate however cleverly the taps are
 * dithered — the dither only decides whether the error looks like banding or
 * like grain. "Can we make the underwater godrays a bit smoother, less
 * dithered? They look too noisy... and probably they are changing way too fast"
 * (user, 2026-09-06) is both symptoms of that one variance.
 *
 * A prefiltered copy fixes it at the source, and a mip chain is a prefiltered
 * copy the hardware already knows how to build — the WebGPU backend generates
 * it after the pass that fills this target. The shafts read a coarse level and
 * the floor reads level 0, from the same texture and the same pass. The blur
 * also slows what they show: the fine structure is what moved fastest.
 */
/**
 * ⚠ THE DRAW TARGET HAS NO MIPS; THE ARRAY IT IS COPIED INTO HAS THEM.
 *
 * Every consumer binds ONE texture array for EVERY slot map — layer `index`
 * is a slot's surface, layer `MAX_WATER_SLOTS + index` its caustic — because
 * the medium (`scene.fogNode`) and the caustic light compile into every
 * material in the project, and the editor's materials were already at the
 * portable limit of sixteen sampled textures with GI's ten, the shadow map
 * and the environment aboard: "The number of sampled textures (17) in the
 * Fragment stage exceeds the maximum per-stage limit (16)" (live editor,
 * 2026-09-06). Four bindings became two became one. The rasterized caustic
 * draw still lands in a plain per-slot target and is copied into its layer;
 * three regenerates the array's mips after the copy, and after the surface
 * kernel's store.
 */
function causticTarget(index) {
  const target = new THREE.RenderTarget(CAUSTIC_RESOLUTION, CAUSTIC_RESOLUTION, {
    type: THREE.HalfFloatType, format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
    depthBuffer: false, stencilBuffer: false,
  });
  target.texture.name = `Water slot ${index} caustic draw`;
  return target;
}
function storageArray(size, layers, { mips = false, name = "" } = {}) {
  const map = new THREE.StorageArrayTexture(size, size, layers);
  map.type = THREE.HalfFloatType;
  map.format = THREE.RGBAFormat;
  map.magFilter = THREE.LinearFilter;
  map.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  map.generateMipmaps = mips;
  map.name = name;
  return map;
}

function createSlot(index) {
  return {
    index,
    owner: null,
    // (height, ripple normal x, ripple normal z, ripple height) in the water's
    // local space — layer `index` of the pool's map array, see below.
    surface: null,
    // The caustic lens is layer `MAX_WATER_SLOTS + index` of the same array.
    causticLayer: MAX_WATER_SLOTS + index,
    // The caustic lens at the volume floor: drawn into this target (see
    // `createWaterCausticPass`) and copied into layer `index` of the array.
    // Created lazily on `claim()` — a scene with no water for this slot must
    // not pay for a 1024² half-float target it never renders into — and
    // disposed on `release()`.
    causticTarget: null,
    uniforms: {
      inverse: uniform(new THREE.Matrix4()),
      // (halfX, depth, halfZ), local units.
      half: uniform(new THREE.Vector3(1, 1, 1)),
      // (kind, radius, centerY, height) — see waterShape.js.
      shape: uniform(new THREE.Vector4(0, .5, 0, 1)),
      rise: uniform(1),
      sigma: uniform(new THREE.Vector3()),
      scatter: uniform(new THREE.Color(0, 0, 0)),
      // The refracted sun through a FLAT surface, in local units: what a
      // receiver walks back up to find the cell its light came through.
      flatRay: uniform(new THREE.Vector3(0, -1, 0)),
      toSun: uniform(new THREE.Vector3(0, 1, 0)),
      // The lid's normal in WORLD space (unit), for a ray's incidence on it.
      up: uniform(new THREE.Vector3(0, 1, 0)),
      // Toward the sun as a SUBMERGED receiver sees it — bent toward the
      // vertical by Snell. A caustic is carried by the refracted beam, so this
      // is the direction its cosine belongs to; `toSun` is the dry one.
      toSunRefracted: uniform(new THREE.Vector3(0, 1, 0)),
      // Toward the sun's MIRROR IMAGE, for a receiver above the water: the
      // direction the reflected beam arrives from, which points downward, so a
      // downward-facing surface has a positive cosine with it and everything
      // else has none. This is what lights the underside of a pier.
      toSunMirror: uniform(new THREE.Vector3(0, -1, 0)),
      // ...and the same direction in LOCAL units, for walking back down to the
      // surface. `toSunMirror` is a world direction and is only ever dotted
      // with a world normal; mixing the two spaces on a non-uniformly scaled
      // pool is the bug `flatRay` exists to avoid.
      mirrorRay: uniform(new THREE.Vector3(0, -1, 0)),
      // The surface's Fresnel reflectance at the sun's own incidence — about
      // 2 % overhead, rising steeply as the sun gets low. Small, and it is the
      // ONLY light a downward face over water gets, which is why it reads.
      reflectance: uniform(.02),
      radiance: uniform(new THREE.Color(0, 0, 0)),
      absorption: uniform(.2),
      strength: uniform(0),
      // The god rays' own strength (`godRays`), apart from the caustics'.
      shafts: uniform(1),
      active: uniform(0),
      // ── THE CAUSTIC WINDOW ──────────────────────────────────────────────
      //
      // The map does not cover the whole footprint: it covers a square of
      // `CAUSTIC_WINDOW_METRES` around the camera (or the whole pool, when
      // that is smaller), in LOCAL units, snapped to its own texels so moving
      // the camera never shimmers the pattern. That is what makes the caustics
      // the same at any size of water: a 60 m lake gets the same 3 cm texels
      // and 6 cm beams a pool does, where the eye actually is, instead of one
      // 6 cm texel per 60 m. Consumers fade to a gain of 1 at its edge.
      causticCenter: uniform(new THREE.Vector2(0, 0)),
      // The window's edge fade as a fraction of its half-size: a tenth for a
      // window that IS the pool (caustics up to the walls), half for one cut
      // out of a bigger body, where a hard-edged 16 m square of caustics
      // around the eye read as "a small rect under the camera" (2026-09-07).
      causticFade: uniform(.1),
      // 1 while the eye is UNDER the surface — the real, displaced surface at
      // the eye's own XZ (the component decides it from the sea's CPU copy,
      // with a hysteresis of centimetres), not the rest plane. On a metre of
      // swell the rest plane put an eye in a trough "under water" and one on
      // a crest "in the air": fog over the far surface, total-internal-
      // reflection white on the near slopes ("depth issues under grazing
      // angles", user, 2026-09-07). The lid's medium segment reads this.
      eyeBelow: uniform(0),
      causticHalf: uniform(new THREE.Vector2(1, 1)),
    },
    // Bound once by every consumer; the sampler nodes are shared so a graph
    // that reads two slots still binds two textures, not four.
    nodes: null,
  };
}

/** The engine's pool. Created on the first water surface, kept for the session
 *  — releasing it would recompile everything a second time for nothing. */
export function waterSlotPool(engine) {
  if (engine.waterSlots) return engine.waterSlots;
  const slots = Array.from({ length: MAX_WATER_SLOTS }, (_, i) => createSlot(i));
  const maps = storageArray(CAUSTIC_RESOLUTION, 2 * MAX_WATER_SLOTS, { mips: true, name: "Water slot maps" });
  // ONE node, shared by every slot and both maps: a consumer binds one
  // texture however many slots it reads, and selects the map as a layer.
  const node = texture(maps);
  const nodes = { surface: node, caustic: node };
  for (const slot of slots) { slot.surface = maps; slot.caustic = maps; slot.nodes = nodes; }
  const liveScratch = [];   // reused by `live()`, cleared every call
  engine.waterSlots = {
    slots,
    claim(owner) {
      const free = slots.find((slot) => slot.owner === null || slot.owner === owner);
      if (free) {
        free.owner = owner;
        // Lazy: a slot claimed for the first time (or reclaimed after its
        // target was disposed on release) gets its caustic target now.
        free.causticTarget ??= causticTarget(free.index);
      }
      return free ?? null;
    },
    release(owner) {
      for (const slot of slots) if (slot.owner === owner) {
        slot.owner = null; slot.uniforms.active.value = 0; slot.uniforms.strength.value = 0;
        slot.causticTarget?.dispose(); slot.causticTarget = null;
      }
    },
    /** Slots a consumer should actually read this frame. Reused array — a
     *  caller must consume it before the next call, never retain it. */
    live() {
      liveScratch.length = 0;
      for (const slot of slots) if (slot.owner && slot.uniforms.active.value > 0) liveScratch.push(slot);
      return liveScratch;
    },
    /** Releases every slot's GPU resources — engine/pool teardown. */
    dispose() {
      for (const slot of slots) { slot.owner = null; slot.causticTarget?.dispose(); slot.causticTarget = null; }
      maps.dispose();
    },
    /**
     * What the per-material nodes (the medium, the caustic light) should be
     * COMPILED for: the slots up to the highest claimed one (at least the
     * first, so a pool appearing later needs no rebuild), and whether any
     * claimed slot is a solid of revolution (the quadric clip is 20 kB per
     * slot in EVERY material — compiled only when a round pool exists).
     */
    compileShape() {
      let count = 1, round = false;
      slots.forEach((slot, i) => { if (!slot.owner) return; count = Math.max(count, i + 1); if (slot.uniforms.shape.value.x > .5) round = true; });
      return { count, round };
    },
  };
  return engine.waterSlots;
}

/**
 * The kernel that fills one slot from one solver, and the only place the two
 * meet. Reads the simulation's own surface texture (linearly filtered, so the
 * resample is smooth) and writes both slot maps.
 *
 * ⚠ **SNELL RUNS IN WORLD SPACE.** A water mesh is routinely non-uniformly
 * scaled — the user's pool is 42.6 × 5.3 × 42.6 — and a non-uniform scale is
 * not a similarity, so refracting a direction that had been pushed through the
 * inverse matrix bends it by the SCALE as well as by the water. The normal goes
 * local→world through the normal matrix, Snell runs there, and only the result
 * comes back for the landing arithmetic.
 */
/**
 * The solver resample: one stable 256^2 copy of the wave surface for the medium
 * to read. The caustic half of the slot is a DRAW, not a dispatch — see below.
 */
/**
 * The medium's surface map, COMPOSED per slot texel over the whole pool: the
 * sea's height from the cascades (at the mip that matches a slot texel) plus
 * the ripple window's height where the texel is inside it, with the ripple
 * normal's x/z and the ripple height beside it for the caustic lens.
 */
export function createWaterSlotKernel({ slot, rippleTexture, rippleResolution, width, height, uniforms, spectrum }) {
  const c = {
    normalMatrix: uniform(new THREE.Matrix3()),
    toLocal: uniform(new THREE.Matrix3()),
    sun: uniform(new THREE.Vector3(0, -1, 0)),
    seaLod: [uniform(0), uniform(0), uniform(0)],
  };
  const ripple = rippleSampler({ rippleTexture, rippleResolution, uniforms });
  const resolve = Fn(() => {
    const i = instanceIndex.toInt().toVar();
    const px = i.mod(SLOT_RESOLUTION).toVar(), py = i.div(SLOT_RESOLUTION).toVar();
    const local = vec3(px.toFloat().add(.5).div(SLOT_RESOLUTION).sub(.5).mul(width), 0, py.toFloat().add(.5).div(SLOT_RESOLUTION).sub(.5).mul(height));
    const world = vec2(local.x.mul(uniforms.waveScale.x), local.z.mul(uniforms.waveScale.z));
    const sea = spectrum ? seaDisplacementAt(spectrum, world, c.seaLod) : vec4(0);
    const r = ripple.at(local);
    storageTexture(slot.surface).depth(int(slot.index)).store(ivec2(px, py), vec4(r.x.add(sea.y.div(uniforms.waveScale.y)), r.y, r.z, r.x));
  })().compute(SLOT_RESOLUTION * SLOT_RESOLUTION);
  resolve.__giPassName = "waterSlotSurface";
  return {
    compute: [resolve], uniforms: c,
    /** Per frame: the mip whose texel is no finer than a slot texel. */
    update() {
      if (!spectrum) return;
      const ws = uniforms.waveScale.value;
      const texel = Math.max(width * ws.x, height * ws.z) / SLOT_RESOLUTION;
      spectrum.cascades.forEach((casc, i) => { c.seaLod[i].value = Math.max(0, Math.log2(Math.max(1, texel / (casc.L / spectrum.size)))); });
    },
  };
}

/**
 * == CAUSTICS ARE A RASTERIZED PROJECTION, WHICH IS WHY THEY HAVE EDGES =====
 *
 * Two earlier attempts and why each looked wrong:
 *
 *  1. A per-texel area ratio measured in the SOURCE parameterization, gathered
 *     by walking back up the flat ray. Correct to first order, and it reads as
 *     soft mottling: caustics are bright because many parts of the surface focus
 *     onto the SAME place, and a gather can only report what one of them did.
 *  2. Point-splatting beams into an atomic accumulator. That sums folds, but the
 *     map is only as dense as the beams, so it needs a reconstruction filter,
 *     and the filter is exactly what removes the filaments again.
 *
 * The reference (MIT jeantimex/webgpu-water, itself a port of Evan Wallace's
 * pool) does neither: it DRAWS the refracted grid into the caustic texture. Each
 * vertex is projected to where its beam lands on the volume floor, and the
 * fragment reads the compression straight off the rasterizer as the ratio of the
 * undisturbed footprint to the drawn one — `length(dFdx) * length(dFdy)` of two
 * interpolants. Rasterization fills every texel a triangle covers, so there is
 * no sparsity and no filter; additive blending sums the folds, so a caustic is
 * bright exactly where several parts of the surface aim at one place. That is
 * the whole difference, and it is why this needs a draw call and not a kernel.
 *
 * The user asked for "the same texture the reference uses". It does not have
 * one: `public/` holds `tiles.jpg` and a skybox, and the caustics are computed
 * every frame from the live surface. This is that computation.
 *
 * THE MAP IS IN FLOOR PARAMETERIZATION - a receiver samples where its own beam
 * LANDS, not where it entered. See `waterCausticGainNode`.
 */
export function createWaterCausticPass({ slot, rippleTexture = null, rippleResolution = 1, width, height, uniforms = null, spectrum = null }) {
  const n = CAUSTIC_GRID;
  const u = slot.uniforms;
  const ripple = rippleTexture && uniforms ? rippleSampler({ rippleTexture, rippleResolution, uniforms }) : null;
  // ── THE SUN'S SHADOW, IN THE MAP ──────────────────────────────────────
  //
  // A beam that lands in an object's shadow is dropped here, so the floor's
  // caustics and the shafts that read this map both inherit the crate's
  // shadow at no per-material cost ("objects' shadows clip the god rays, as
  // they should", user, 2026-09-06). One compare against the sun's own
  // shadow map at the landing point; a 1×1 placeholder when there is none.
  // Placeholder compare follows the renderer's depth convention (set in `render`).
  const shadowPlaceholder = new THREE.DepthTexture(1, 1); shadowPlaceholder.compareFunction = THREE.LessEqualCompare;
  const shadowDepth = texture(shadowPlaceholder);
  let shadowLogs = -1;
  const c = {
    normalMatrix: uniform(new THREE.Matrix3()),
    toLocal: uniform(new THREE.Matrix3()),
    sun: uniform(new THREE.Vector3(0, -1, 0)),
    shadowOn: uniform(0), shadowMatrix: uniform(new THREE.Matrix4()), toWorld: uniform(new THREE.Matrix4()), shadowBias: uniform(0),
  };
  // One vertex per sample of the surface. PlaneGeometry's `uv` is exactly the
  // [0,1] parameterization this needs, and its own positions are never used -
  // `vertexNode` replaces them outright.
  const geometry = new THREE.PlaneGeometry(1, 1, n - 1, n - 1);
  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true, blending: THREE.AdditiveBlending,
    depthTest: false, depthWrite: false, side: THREE.DoubleSide, fog: false,
  });

  const at = uvAttribute();
  const center = vec2(u.causticCenter), half2 = vec2(u.causticHalf);
  // The beam's rest position in LOCAL units — the caustic window's cell.
  const restXZ = vec3(center.x.add(at.x.sub(.5).mul(half2.x.mul(2))), 0, center.y.add(at.y.sub(.5).mul(half2.y.mul(2))));
  // The ripple window sampled there (zero outside it), with offsets in ripple cells.
  const sampleAt = (dx, dy) => (ripple ? ripple.atOffset(restXZ, dx, dy) : vec4(0));
  const info = sampleAt(0, 0);
  /**
   * ⭐ **THE LENS READS A LOW-PASSED NORMAL, AND THAT IS NOT A CHEAT.**
   *
   * Focus is a SECOND derivative of the surface, so it is dominated by the
   * finest structure the height field carries — which is also the structure
   * that changes fastest and is least trustworthy, sitting at the solver's own
   * Nyquist. Measured on the reported pool: the caustic map turned over 13.9 %
   * of itself every tenth of a second on a gentle swell, i.e. the whole pattern
   * replaced in under a second. "The caustics along with god rays are still
   * quite crazy. Can we update them slower and smoother?" (user, 2026-09-06).
   *
   * There is a physical scale to stop at. An undulation of wavelength λ focuses
   * at a distance that shrinks with λ, so structure much finer than the water
   * is deep has already come to a focus and defocused again long before the
   * floor — it contributes a soft wash, never a filament. Averaging over about
   * a cell and a half is that cutoff, cheaply: five taps, and only the NORMAL
   * is smoothed. The height stays sharp because it positions the beam rather
   * than aiming it.
   */
  const LENS_CELLS = 2.5;
  // The surface map carries the ripple normal's x and z; y is rebuilt.
  const lensXZ = sampleAt(0, 0).yz.mul(2)
    .add(sampleAt(LENS_CELLS, 0).yz).add(sampleAt(-LENS_CELLS, 0).yz)
    .add(sampleAt(0, LENS_CELLS).yz).add(sampleAt(0, -LENS_CELLS).yz)
    .div(6);
  const lensNormal = vec3(lensXZ.x, float(1).sub(lensXZ.dot(lensXZ)).max(0).sqrt(), lensXZ.y);
  const half = vec3(u.half);
  const rest = restXZ;
  // Where this sample's beam lands, and where it WOULD have landed through a
  // flat surface. The ratio of those two footprints is the whole effect.
  // ⭐ BENT BY THE FINE DETAIL TOO, not only by the grid. See
  // `seaSlopeAt`: a lens made of the solver's normals alone cannot
  // focus anything a gentle swell does not already focus, and real caustics are
  // made by exactly the structure the grid cannot hold.
  //
  // ⚠ INSIDE AN `Fn`, and it has to be: `seaSlopeAt` declares variables,
  // and this pass builds its vertex graph at construction time where there is
  // no builder stack — "No stack defined for assign operation". Anything that
  // declares belongs in one of these, which is the second time that has caught
  // me in this file's neighbourhood.
  //
  // ⭐ THE SEA'S SLOPE COMES FROM THE DERIVATIVE CASCADES AT THE BEAM'S OWN
  // MIP. The solver's surface map carries the RIPPLE normal only; the sea is
  // added here from the same derivative textures the shading reads, each
  // cascade at the mip whose texel matches the beam spacing — or the physical
  // floor below, whichever is coarser. Structure of wavelength λ comes to a
  // focus at a distance that shrinks with λ², so the finest ripples focus
  // centimetres under the surface and are a blur again by the time the beam
  // reaches a floor metres down; `0.08·√depth` is that scale (14 cm over a
  // 3 m pool), and without it a floor was a marble of centimetre threads.
  // Real waves through a mip chain: nothing here can alias.
  // ⛔ A CASCADE FINER THAN THE BAND LIMIT IS NOT IN THE LENS. Until
  // 2026-09-07 the sea's mips were never generated, so a cascade read above
  // mip 0 contributed NOTHING — and every caustic and god-ray receipt, and
  // the look the user accepted, was tuned on a lens of the cascades whose
  // texel is no finer than the band limit. With the mips real, the finer
  // cascades' true band-limited slopes doubled the shafts' one-frame change
  // (20 m arm: 6.2 → 12.5 %, gate 4 %). So the rule they implied is kept on
  // purpose: a cascade fades out of the lens as its texel drops under the
  // band limit (weight 1 at mip ≤ ½, 0 at mip ≥ 1½). Their real contribution
  // — ripple-scale shimmer in the caustics — is an open unit that needs a
  // temporal term on the shaft taps first.
  const lens = { lods: [uniform(0), uniform(0), uniform(0)], weights: [uniform(1), uniform(1), uniform(1)] };
  const localNormal = uniforms && spectrum
    ? Fn(() => {
        const world = vec2(rest.x.mul(uniforms.waveScale.x), rest.z.mul(uniforms.waveScale.z));
        const slope = seaSlopeAt(spectrum, world, { lods: lens.lods, weights: lens.weights });
        // World slope → local: the box is anisotropic (see gridSimulation).
        const local = vec2(slope.x.mul(uniforms.waveScale.x).div(uniforms.waveScale.y), slope.y.mul(uniforms.waveScale.z).div(uniforms.waveScale.y));
        const nrm = vec3(lensNormal);
        return vec3(nrm.x.sub(local.x.mul(nrm.y)), nrm.y, nrm.z.sub(local.y.mul(nrm.y))).normalize();
      })()
    : vec3(lensNormal);
  const worldNormal = c.normalMatrix.mul(localNormal).normalize();
  const ray = c.toLocal.mul(refract(c.sun, worldNormal, IOR));
  // ── THE BEAM STARTS ON THE SMOOTH SEA, NOT ON THE BILINEAR MAP ─────────
  //
  // Focus is a second derivative of where beams land. A height read from the
  // solver's surface map is bilinear — continuous, with a kink at every cell
  // edge — and the kinks came through the rasterizer as a floor tiled in
  // solver-cell-sized blocks (visible on a 60 m lake, 12 cm cells). The sea
  // part of the height is sampled from the cascades themselves, at the
  // lens's own mips, and only the ripple height (zero except near a wake)
  // comes from the map.
  const seaHere = uniforms && spectrum
    ? Fn(() => seaDisplacementAt(spectrum, vec2(rest.x.mul(uniforms.waveScale.x), rest.z.mul(uniforms.waveScale.z)), lens.lods))()
    : null;
  const displaced = seaHere
    ? vec3(rest.x.add(seaHere.x.div(uniforms.waveScale.x)), info.w.add(seaHere.y.div(uniforms.waveScale.y)), rest.z.add(seaHere.z.div(uniforms.waveScale.z)))
    : vec3(rest.x, info.x, rest.z);
  const hit = half.y.negate().sub(displaced.y).div(ray.y.min(-.05)).max(0);
  const landed = vec3(displaced.x.add(ray.x.mul(hit)), half.y.negate(), displaced.z.add(ray.z.mul(hit)));
  const flat = vec3(u.flatRay);
  const flatHit = half.y.negate().div(flat.y.min(-.05)).max(0);
  const reference = vec3(rest.x.add(flat.x.mul(flatHit)), half.y.negate(), rest.z.add(flat.z.mul(flatHit)));

  const newPos = varying(landed, "waterCausticNew");
  const oldPos = varying(reference, "waterCausticOld");
  // Draw in the WINDOW's own space: the map covers it exactly, so a landing
  // point maps straight to NDC and a beam landing outside it is clipped.
  // A beam that starts outside the lid's outline (a round pool's corners) is
  // no beam: it leaves the ortho camera's depth range and is clipped.
  const dry = waterRimDistanceNode(vec4(u.shape), half, rest.x, rest.z).lessThan(0);
  material.vertexNode = vec4(landed.x.sub(center.x).div(half2.x), landed.z.sub(center.y).div(half2.y).negate(), select(dry, float(2), float(0)), 1);
  // Zero-parameter Fn: three calls it with the builder (TSLCore `jsFunc(builder)`).
  material.colorNode = Fn((builder) => {
    const oldArea = dFdx(oldPos).length().mul(dFdy(oldPos).length());
    const newArea = dFdx(newPos).length().mul(dFdy(newPos).length());
    const focus = oldArea.div(newArea.max(1e-12)).clamp(0, MAX_FOCUS);
    // The landing point in the sun's shadow map (three's coordinates: y down).
    const world = c.toWorld.mul(vec4(newPos, 1)).xyz;
    const sc = c.shadowMatrix.mul(vec4(world, 1));
    // Bias sign as three's ShadowNode applies it (ShadowNode.js:374): a
    // reversed buffer stores nearer as LARGER depth, so the bias subtracts.
    const reversed = builder?.renderer?.reversedDepthBuffer === true;
    const lit = shadowDepth.sample(vec2(sc.x, float(1).sub(sc.y))).compare(reversed ? sc.z.sub(c.shadowBias) : sc.z.add(c.shadowBias));
    const visibility = select(c.shadowOn.greaterThan(.5), lit, float(1));
    return vec3(focus.mul(visibility));
  })();

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const previousClear = new THREE.Color(), layer = new THREE.Vector3(0, 0, slot.causticLayer);
  return {
    uniforms: c,
    /** One small draw per visible water surface, before the frame's own render. */
    render(renderer, { sun = null, shadowNode = null } = {}) {
      if (!renderer?.isWebGPURenderer) return;
      // The slot's target is claim-scoped (lazy create, dispose on release) —
      // a stray call after release must not render to the screen instead.
      if (!slot.causticTarget) return;
      const placeholderCompare = renderer.reversedDepthBuffer === true ? THREE.GreaterEqualCompare : THREE.LessEqualCompare;
      if (shadowPlaceholder.compareFunction !== placeholderCompare) shadowPlaceholder.compareFunction = placeholderCompare;
      const depth = sun?.castShadow ? (shadowNode?.shadowMap?.depthTexture ?? sun.shadow?.map?.depthTexture ?? null) : null;
      if (depth && depth.compareFunction && sun.shadow.matrix) { c.shadowOn.value = 1; c.shadowMatrix.value.copy(sun.shadow.matrix); shadowDepth.value = depth; c.shadowBias.value = Number(sun.shadow.bias) || -.002; }
      else { c.shadowOn.value = 0; shadowDepth.value = shadowPlaceholder; }
      if (shadowLogs !== c.shadowOn.value) { shadowLogs = c.shadowOn.value; console.log(`[water] caustic beams: sun shadow ${c.shadowOn.value ? 'ON (beams landing in shadow leave the map)' : 'off (no shadow node yet)'}`); }
      c.toWorld.value.copy(u.inverse.value).invert();
      if (uniforms && spectrum) {
        const ws = uniforms.waveScale.value;
        const spacing = Math.max(u.causticHalf.value.x * ws.x, u.causticHalf.value.y * ws.z) * 2 / (n - 1);
        const floorScale = .04 * Math.sqrt(Math.max(.01, u.half.value.y * ws.y));
        // ⚠ FOUR BEAMS PER BAND-LIMIT WAVELENGTH, or the splat jitters. With
        // the sea's mips real (they were empty until 2026-09-07, so the fine
        // cascades never reached the lens), a 16 m window's 3 cm beams
        // sampled a 7 cm band limit 2.3× per wave and the map changed 12 %
        // a frame at the shafts' mip (20 m arm; the 5 m arm's 1 cm beams
        // were fine at 7×). The lens is band-limited to what the beams can
        // sample: the 20 m shafts read 12.5 → under the gate, the 5 m arm
        // unchanged (4 cm < its 7 cm floor scale).
        const coarsest = Math.max(4 * spacing, floorScale);
        spectrum.cascades.forEach((c, i) => {
          const lod = Math.max(0, Math.log2(Math.max(1, coarsest / (c.L / spectrum.size))));
          lens.lods[i].value = lod;
          lens.weights[i].value = Math.max(0, Math.min(1, 1.5 - lod));
        });
      }
      const target = renderer.getRenderTarget();
      const alpha = renderer.getClearAlpha();
      renderer.getClearColor(previousClear);
      renderer.setRenderTarget(slot.causticTarget);
      // ⚠ BLACK. The beams ADD onto this: a texel's value is the sum of the
      // compression of every beam landing on it, so a cell between filaments
      // reads below 1 (its beams diverged) and a filament above (they
      // converged) — a mean of one, energy conserved. A white clear, tried
      // for the border, lifted the whole map by one: no cell could go dark
      // and the floor read as a flat sun with faint lines on it ("caustics
      // are way too dim", user, 2026-09-06). The border is the receiver's
      // business: a beam that entered outside the lid gets gain 1
      // (`waterCausticGainLocalNode`'s origin test), and the window reaches
      // past the rim by the beams' lateral travel so wall beams are recorded.
      renderer.setClearColor(0x000000, 1);
      renderer.render(scene, camera);
      renderer.setClearColor(previousClear, alpha);
      renderer.setRenderTarget(target);
      // Into the slot's layer of the shared array; the mips follow.
      renderer.copyTextureToTexture(slot.causticTarget.texture, slot.caustic, null, layer);
    },
    dispose() { geometry.dispose(); material.dispose(); scene.remove(mesh); },
  };
}
