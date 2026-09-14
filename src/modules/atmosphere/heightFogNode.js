import * as THREE from "three/webgpu";
import { Fn, densityFogFactor, floor, float, fract, fog, hash, max, mix, positionWorld, smoothstep, uniform, vec2, vec3 } from "three/tsl";

/**
 * ⭐ VALLEY MIST — HEIGHT FOG ON `scene.fogNode`, INSTALLED ONCE, DRIVEN BY
 * UNIFORMS FOREVER.
 *
 * `FogExp2` is a uniform haze: the same soup at every altitude, so a valley
 * full of morning mist means a mountaintop full of it too. Real mist POOLS —
 * dense in the hollows, thin a few metres up, torn into banks that drift with
 * the wind. That is a height falloff over world Y times a procedural noise
 * modulation, and it is what the `mist` weather channel feeds.
 *
 * ⛔ WHY THIS REPLICATES `FogExp2` INSTEAD OF COMPOSING WITH IT. The renderer
 * prefers `scene.fogNode` over the node it converts `scene.fog` into — setting
 * one DELETES the other (see `NodeManager.getFogNode`). So this node carries
 * the far field itself: `densityFogFactor` is literally the function three
 * builds for a `FogExp2`, fed the same density and colour, which keeps the
 * legacy path's pixels bit-identical while the mist term is zeroed. The mist
 * combines as `1 − (1−a)(1−b)`, which collapses to `a` exactly when `b` is 0
 * (`fl(1−x)` is exact for x∈[0,1]) — default scenes lose nothing.
 *
 * ⛔ NO TEXTURE, EVER. This node compiles into EVERY material, and the
 * renderer's sampler budget is already spent (foliage + GI sit at the
 * portable 16). The banks are value noise over a hashed lattice — a handful of
 * ALU per pixel, no sampler, no mip, no memory.
 *
 * ⚠ `scene.fogNode` is ONE SLOT and the water medium (`waterMedium.js`) owns
 * it when a Water surface exists — it replicates `scene.fog` the same way this
 * does. The Atmosphere installs only when the slot is free and steps aside if
 * something replaces it; mist and the underwater medium never share a scene.
 */

/** Keeps every lattice seed positive before it is hashed — see `skyNode.js`. */
const NOISE_BIAS = 1048576;

/** One lattice tap: bilinear value noise over a hashed integer grid. */
const valueNoise = /*@__PURE__*/ Fn(([p]) => {
  const cell = floor(p);
  const f = fract(p);
  // Hermite smoothstep weights, so neighbouring cells share zero gradient at
  // the border — a raw lerp reads as a grid of diamonds at this scale.
  const t = f.mul(f).mul(f.mul(-2).add(3));
  const seed = cell.x.mul(157).add(cell.y.mul(4331)).add(NOISE_BIAS);
  const a = hash(seed);
  const b = hash(seed.add(1));          // one cell over in x
  const c = hash(seed.add(4331));       // one cell over in y
  const d = hash(seed.add(4332));       // both
  return mix(mix(a, b, t.x), mix(c, d, t.x), t.y);
});

/** Two octaves — enough for ragged banks, cheap enough for every material. */
const mistNoise = /*@__PURE__*/ Fn(([p]) => {
  const a = valueNoise(p);
  const b = valueNoise(p.mul(2.7).add(vec2(5.2, 1.3)));
  return a.mul(0.65).add(b.mul(0.35));
});

/**
 * The node and its uniforms. Everything the effect ever does is a uniform
 * write: the node itself is assigned to `scene.fogNode` once at attach, so no
 * weather change — fog arriving, mist burning off — ever recompiles a material.
 */
export function createHeightFog() {
  const uniforms = {
    /** The sky's own horizon colour — both terms stand in front of that sky. */
    color: uniform(new THREE.Color(0.5, 0.5, 0.55)),
    /** The far field: exactly `scene.fog`'s `FogExp2` density. */
    exp2Density: uniform(0),
    /** Mist extinction per metre at/below the base level. 0 = no mist. */
    mistDensity: uniform(0),
    /** World-space Y the mist pools under. */
    baseLevel: uniform(0),
    /** Metres over which the mist thins above the base level. */
    falloff: uniform(8),
    /** 0 = a level sheet, 1 = fully carved into drifting banks. */
    noiseStrength: uniform(0.5),
    /** Noise tiles per metre. */
    noiseScale: uniform(1 / 90),
    /** Integrated wind advection, in noise tiles — see `_applyFog`. */
    drift: uniform(new THREE.Vector2()),
  };
  const node = Fn(() => {
    // The far field, bit-identical to three's own `FogExp2` conversion.
    const fExp2 = densityFogFactor(uniforms.exp2Density);
    // Pooled low: full strength at the base level, gone a few falloffs above.
    const heightTerm = uniforms.baseLevel.sub(positionWorld.y).max(0)
      .div(max(uniforms.falloff, 0.01)).negate().exp();
    // Drifting banks: holes in the sheet, advected by the wind's integrated
    // drift rather than speed × time so a turning wind never jumps the field.
    const p = positionWorld.xz.mul(uniforms.noiseScale).add(uniforms.drift);
    const banks = smoothstep(0.3, 0.8, mistNoise(p)).mul(1.25);
    const fMist = densityFogFactor(uniforms.mistDensity)
      .mul(heightTerm)
      .mul(mix(float(1), banks, uniforms.noiseStrength))
      .clamp(0, 1);
    const factor = fExp2.oneMinus().mul(fMist.oneMinus()).oneMinus();
    return fog(vec3(uniforms.color), factor);
  })();
  return { uniforms, node };
}

const finite = (v, fallback, lo, hi) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

/**
 * The one writer. Clamps everything — a NaN here would poison every material
 * in the scene, and props are one bad scene file away from being garbage.
 */
export function updateHeightFog(target, params = {}) {
  const u = target?.uniforms;
  if (!u) return;
  if (params.color) {
    const [r, g, b] = params.color;
    u.color.value.setRGB(finite(r, 0.5, 0, 64), finite(g, 0.5, 0, 64), finite(b, 0.5, 0, 64));
  }
  if (params.exp2Density !== undefined) u.exp2Density.value = finite(params.exp2Density, 0, 0, 1);
  if (params.mistDensity !== undefined) u.mistDensity.value = finite(params.mistDensity, 0, 0, 1);
  if (params.baseLevel !== undefined) u.baseLevel.value = finite(params.baseLevel, 0, -1e5, 1e5);
  if (params.falloff !== undefined) u.falloff.value = finite(params.falloff, 8, 0.05, 1000);
  if (params.noiseStrength !== undefined) u.noiseStrength.value = finite(params.noiseStrength, 0, 0, 1);
  if (params.noiseScale !== undefined) u.noiseScale.value = finite(params.noiseScale, 1 / 90, 1e-5, 1);
  if (params.driftX !== undefined) u.drift.value.x = finite(params.driftX, 0, -1e6, 1e6);
  if (params.driftY !== undefined) u.drift.value.y = finite(params.driftY, 0, -1e6, 1e6);
}
