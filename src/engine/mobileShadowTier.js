// @ts-check
/**
 * ⭐ THE MOBILE DIRECTIONAL-SHADOW TIER: fewer cascades, same resolution.
 *
 * Every cascade (or clipmap level) is one more full shadow render of the
 * scene's casters. A phone keeps the authored map size — the 1024² cap was
 * rejected as "extremely awful" (sceneSettings' MOBILE_SHADOW_MAP_MAX) — and
 * instead renders 2 cascades where a desktop renders 4.
 *
 * This is an ENGINE DEFAULT, not a prop write: the authored `csmCascades` /
 * `clipmapLevels` stay what `toJSON` saves, and an authored `variants.mobile`
 * (or portrait/landscape) value for the key wins outright. The reduction is
 * applied only when the platform layers include "mobile" and no active layer
 * names the key. Pure: the LightComponent and the tests share it.
 */
import { resolveVariantOverrides } from "./componentVariants.js";

/** CSM cascades a phone renders unless a variant says otherwise. */
export const MOBILE_CSM_CASCADES = 2;
/** Clipmap levels a phone renders unless a variant says otherwise. */
export const MOBILE_CLIPMAP_LEVELS = 2;

/**
 * @param {{
 *   key: string,                       // "csmCascades" | "clipmapLevels"
 *   value: unknown,                    // props[key] — already variant-applied
 *   variants?: Record<string, Record<string, unknown>> | null,
 *   layers?: readonly string[] | null, // engine.platformLayers
 *   fallback: number, min: number, max: number,
 *   mobile: number,
 * }} options
 * @returns {{ count: number, authored: number, reduced: boolean }}
 */
export function resolveShadowLevelCount({ key, value, variants, layers, fallback, min, max, mobile }) {
  const n = Number(value);
  const authored = Math.min(max, Math.max(min, Math.round(Number.isFinite(n) ? n : fallback)));
  const onMobile = Array.isArray(layers) && layers.includes("mobile");
  if (!onMobile) return { count: authored, authored, reduced: false };
  const overrides = resolveVariantOverrides(variants ?? null, layers ?? []);
  if (Object.prototype.hasOwnProperty.call(overrides, key)) return { count: authored, authored, reduced: false };
  const count = Math.min(authored, Math.max(min, mobile));
  return { count, authored, reduced: count < authored };
}

/**
 * Practical CSM breaks (fractions of maxFar, last = 1) for `cascades`, the
 * engine's λ-blend of uniform and logarithmic splits.
 * @param {number} cascades
 * @param {number} near
 * @param {number} far
 * @param {number} lambda 0…1
 * @returns {number[]}
 */
export function practicalBreaks(cascades, near, far, lambda) {
  const out = [];
  const l = Math.min(1, Math.max(0, lambda));
  for (let i = 1; i <= cascades; i++) {
    const p = i / cascades;
    const uniform = (near + (far - near) * p) / far;
    const logarithmic = (near * (far / near) ** p) / far;
    out.push(uniform + (logarithmic - uniform) * l);
  }
  return out;
}

/**
 * Breaks for a tier REDUCED from `authored` to `count` cascades: the authored
 * layout's first `count - 1` splits, then the far end. The near cascades keep
 * exactly the desktop texel density (λ=0.9, 4→2 keeps a ~26 m first cascade
 * instead of the ~59 m a native 2-cascade split would give) and the last
 * cascade still reaches maxFar; only the mid range is coarser.
 * @param {number} count
 * @param {number} authored
 * @param {number} near
 * @param {number} far
 * @param {number} lambda
 */
export function reducedPracticalBreaks(count, authored, near, far, lambda) {
  const full = practicalBreaks(Math.max(count, authored), near, far, lambda);
  return [...full.slice(0, Math.max(0, count - 1)), 1];
}

/**
 * The level scale that keeps a clipmap's OUTERMOST coverage when it drops
 * from `authored` to `count` levels: nearSize·scale^(authored-1) is unchanged.
 * @param {number} scale
 * @param {number} authored
 * @param {number} count
 */
export function coveragePreservingClipmapScale(scale, authored, count) {
  if (count >= authored || count < 2) return scale;
  return scale ** ((authored - 1) / (count - 1));
}
