import test from 'node:test';
import assert from 'node:assert/strict';
import { foliageChunkTierMask, foliageLodBand, foliageLodThresholds, foliageShadowFar } from '../src/modules/foliage/foliageLod.js';

// 09-14 "three bushes, the middle one has no shadow": the mid tier's shadow
// fades out over `shadowFar`, so the impostor mesh must already hold every
// plant from that band on — it used to start at `far − bandFar`, leaving a
// casterless gap between the two. Mirrors the shader's crossfade exactly.
test('every distance has a casting tier that the chunk mask actually commits', () => {
  const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const fade = (edge, x) => { const band = foliageLodBand(edge); return smooth(edge - band / 2, edge + band / 2, x); };
  for (const props of [
    { lodNear: 20, lodFar: 60, maxDistance: 220, shadowFar: 30 }, // World shrubs
    { lodNear: 25, lodFar: 90, maxDistance: 420, shadowFar: 50 }, // World trees
    { lodNear: 45, lodFar: 135, maxDistance: 420 },
  ]) {
    const { near, end, bandEnd } = foliageLodThresholds(props);
    const shadowFar = foliageShadowFar(props);
    for (let d = 0; d < end - bandEnd; d += .5) {
      const nearW = 1 - fade(near, d), midW = fade(near, d) * (1 - fade(shadowFar, d));
      const mask = foliageChunkTierMask(d, d, props);
      const covered = (nearW > 1e-3 && (mask & 1)) || (midW > 1e-3 && (mask & 2)) || (fade(shadowFar, d) > 1e-3 && (mask & 4));
      assert.ok(covered, `props ${JSON.stringify(props)}: nothing casts at ${d} m (mask ${mask})`);
    }
  }
});

// `foliageShadowFar` resolves the SHADOW pass's mid→impostor handoff
// (`props.shadowFar`). Two guarantees must hold for every authored value:
// the handoff never lands past the impostor tier's earliest committed span
// (`far − band(far)` — past it the impostor mesh holds no instances to
// shadow with), and never inside the near band (`enforceLodGap` against
// `near` — the two shadow-side crossfades' dither bands must not touch).
// Unset must resolve to `far` exactly: the shadow pass then replays the
// colour decision bit-for-bit, which is every scene that never authors it.

test('with a clipmap sun the mid mesh holds plants right up to the viewer, without one it does not', () => {
  const props = { lodNear: 20, lodFar: 60, maxDistance: 220 };
  assert.equal(foliageChunkTierMask(0, 5, props, false, true) & 2, 2, 'clipmap: a plant at the viewer has mid geometry for the second level');
  assert.equal(foliageChunkTierMask(0, 5, props, false, true) & 4, 0, 'but no impostor that close');
  assert.equal(foliageChunkTierMask(0, 5, props) & 2, 0, 'no clipmap: colour tiers stay disjoint near the viewer');
});

test('unset / zero / negative resolves to the colour far, unchanged', () => {
  for (const shadowFar of [undefined, 0, -5]) {
    const props = { lodNear: 45, lodFar: 135, maxDistance: 420, shadowFar };
    assert.equal(foliageShadowFar(props), 135);
  }
});

test('a positive value is clamped below the impostor tier\'s earliest span', () => {
  const props = { lodNear: 45, lodFar: 135, maxDistance: 420, shadowFar: 500 };
  const { far, bandFar } = foliageLodThresholds(props);
  const resolved = foliageShadowFar(props);
  // The tier-2 commit span starts at `far − bandFar`; past it the impostor
  // mesh has no instances to hand the shadow to.
  assert.ok(resolved <= far - bandFar, `resolved ${resolved} must be ≤ ${far - bandFar}`);
  assert.equal(resolved, far - bandFar);
});

test('a positive value is pushed out of the near band, never into it', () => {
  // An author shadowFar crammed against lodNear must not make the two
  // shadow-side crossfades' bands overlap — the complementary discard rule
  // needs each fade saturated while the other is live.
  const props = { lodNear: 45, lodFar: 135, maxDistance: 420, shadowFar: 46 };
  const { near, bandNear } = foliageLodThresholds(props);
  const resolved = foliageShadowFar(props);
  const shadowBand = Math.max(resolved * .25, 6);
  assert.ok(resolved - shadowBand / 2 >= near + bandNear / 2,
    `resolved ${resolved} band must clear the near band (${near} ±${bandNear / 2})`);
});

test('resolution matches foliageLodThresholds\' own enforced arithmetic', () => {
  // The value fed to the shader must be resolved through the SAME thresholds
  // helper the colour side uses — a handoff computed from a raw prop would
  // drift from the bands the dither parity is proven against.
  const props = { lodNear: 30, lodFar: 90, maxDistance: 220, shadowFar: 70 };
  const { far, bandFar } = foliageLodThresholds(props);
  assert.equal(foliageShadowFar(props), Math.min(70, far - bandFar));
});
