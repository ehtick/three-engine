/** A cell is a quality decision as well as a draw group. A 24 m grass cell
 * keeps thousands of blades detailed when just one corner is near the camera. */
export function foliageCellSize(props) {
  const authored = Math.max(1, Number(props.chunkSize) || 24);
  const low = props.species === "grass" || props.species === "wildflowers";
  const height = Math.max(.05, Number(props.height) || 1);
  return Math.min(authored, low ? Math.max(6, Math.min(12, height * 12)) : Math.max(12, Math.min(24, height * 2)));
}

/** ⭐ THE CROSSFADE BAND, in the same units as a threshold: 25% of it, floored
 * at 6 m so the transition is spread over a genuinely unnoticeable distance
 * (the owner's verdict: crossfades were "triggering very close to camera" and
 * had to move out and widen) rather than snapping over a couple of metres.
 * The shader (`foliageMaterial.js`, `impostorMaterial.js`) computes the exact
 * same expression — keep the two in sync by construction, not convention. */
export function foliageLodBand(threshold) {
  return Math.max(Number(threshold) * .25, 6);
}

function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

/** The TSL twin lives in `foliageMaterial.js`/`impostorMaterial.js` as the
 * built-in `smoothstep` node — this is that same Hermite curve on the CPU. */
function smooth(edge0, edge1, x) {
  if (edge1 <= edge0) return x < edge0 ? 0 : 1;
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** ⭐ BAND-OVERLAP ENFORCEMENT: pushes `hi` out from `lo` until the gap
 * exceeds BOTH thresholds' own band widths — the sufficient condition (a bit
 * stronger than the tight `> (bandLo+bandHi)/2` requirement) that makes the
 * near/far crossfade at `lo` and the one at `hi` never touch. Without this, an
 * author-supplied `lodFar` too close to `lodNear` (relative to how wide their
 * 25%-of-threshold bands are) would make the two crossfades bleed into each
 * other, breaking the complementary discard rule's exactness (`foliageTierKeeps`
 * below relies on one side's fade being EXACTLY saturated to 0 or 1 while the
 * other is mid-transition). `bandHi` is a function of `hi` itself, so this
 * iterates the few steps a 0.25-per-step band formula needs to converge. */
function enforceLodGap(lo, hi, bandLo) {
  let value = Math.max(hi, lo + 1);
  for (let i = 0; i < 6; i++) {
    const bandHi = foliageLodBand(value);
    const needed = lo + Math.max(bandLo, bandHi);
    if (value >= needed) break;
    value = needed;
  }
  return value;
}

/** Species-level thresholds, never rescaled by projected pixel size or chunk
 * identity: a plant's own tier is a property of the plant and the camera,
 * not of which draw-group cell it happened to fall in. */
export function foliageLodThresholds(props) {
  const near = Math.max(0, Number(props.lodNear) || 0);
  const bandNear = foliageLodBand(near);
  const far = enforceLodGap(near, Math.max(near + 1, Number(props.lodFar) || near + 1), bandNear);
  const bandFar = foliageLodBand(far);
  const end = enforceLodGap(far, Math.max(far + 1, Number(props.maxDistance) || far + 1), bandFar);
  const bandEnd = foliageLodBand(end);
  return { near, far, end, bandNear, bandFar, bandEnd };
}

/**
 * ⭐⭐ THE CROSSFADE ITSELF — complementary smoothsteps, no discrete switch.
 *
 * `distance` is already `length(instanceWorldPos - camera) / instanceScale`:
 * a bigger plant keeps its detail further out, for free, by shrinking its own
 * distance rather than by widening a threshold per instance.
 *
 * Three bands, back to back: near→mid crosses over `near`, mid→impostor
 * crosses over `far`, and impostor→nothing is the hard fade-out at
 * `maxDistance` (kept as a true cutoff: total coverage is allowed to drop
 * below 1 there, on purpose — a distant plant is meant to vanish, not to be
 * held up by a fourth tier). Everywhere else, as long as the three bands do
 * not overlap (near/far/maxDistance well separated, which any sane author
 * ensures), the three weights sum to 1 by construction:
 *   near + mid·(1) cancels near's complement while `fadeNear` is 0 or 1
 *   outside its own band, and likewise at the far edge.
 */
export function foliageTierWeights(distance, props, output = {}) {
  const { near, far, end, bandNear, bandFar, bandEnd } = foliageLodThresholds(props);
  const d = Math.max(0, Number(distance) || 0);
  const fadeNear = smooth(near - bandNear / 2, near + bandNear / 2, d);
  const fadeFar = smooth(far - bandFar / 2, far + bandFar / 2, d);
  const fadeEnd = smooth(end - bandEnd / 2, end + bandEnd / 2, d);
  output.near = 1 - fadeNear;
  output.mid = fadeNear * (1 - fadeFar);
  output.impostor = fadeFar * (1 - fadeEnd);
  return output;
}

/**
 * ⭐⭐ THE COMPLEMENTARY DISCARD RULE — the CPU mirror of the exact per-pixel
 * test the shader runs (`foliageMaterial.js`'s dither block, `impostorMaterial.js`'s
 * twin). `foliageTierWeights` above answers "how much of this tier is here";
 * this answers the DIFFERENT question a screen-door dither actually needs:
 * "does THIS pixel's noise value survive in THIS tier", such that summed
 * across every tier an instance's chunk actually carries, EXACTLY ONE keeps
 * any given (distance, noise) pair.
 *
 * ⛔ THE BUG THIS REPLACES: testing `noise < ownWeight` in every tier (the
 * previous shader) is correct in isolation but not jointly — for complementary
 * weights wA (closer tier) and wB = 1 − wA (farther tier) sharing one boundary,
 * `noise < wA` and `noise < wB` together leave `noise` in
 * `[min(wA,wB), max(wA,wB))` kept by NEITHER (a hole — the reported "one mesh
 * disappears into nothing, then a new one appears") and `noise` below that
 * minimum kept by BOTH.
 *
 * THE FIX: the tier on the FAR side of any one boundary keeps the COMPLEMENT,
 * `noise >= 1 − ownWeight`, not `noise < ownWeight`. Per tier:
 *   - near (tier 0): always the close side of the near/mid boundary — keeps
 *     `noise < w`.
 *   - impostor (tier 2): always the far side of its only boundary (mid/far) —
 *     keeps `noise >= 1 − w`. Its own weight already folds in the maxDistance
 *     fade-out (`fadeEnd`), so this same rule thins it to nothing there too,
 *     rather than needing a fourth case.
 *   - mid (tier 1): sits between TWO boundaries, so it plays each role once —
 *     the far side of near/mid while `distance` is below the midpoint of
 *     `lodNear`/`lodFar` (keeps `noise >= 1 − w`), and the close side of
 *     mid/far beyond that midpoint (keeps `noise < w`). The midpoint sits
 *     inside the flat, fully-committed stretch between the two bands (given
 *     `enforceLodGap` above), so which rule mid uses there never matters — its
 *     own weight is already ~1 either way.
 *
 * This is exact (not just approximately non-overlapping) because
 * `enforceLodGap` guarantees the OTHER boundary's fade is saturated to exactly
 * 0 or 1 — never just close to it — everywhere one boundary's transition is
 * live, so a tier's own weight and its neighbour's complementary threshold are
 * bit-identical floating-point values.
 */
export function foliageTierKeeps(tier, distance, noise, thresholds) {
  const { near, far, end, bandNear, bandFar, bandEnd } = thresholds;
  const d = Math.max(0, Number(distance) || 0);
  const n = clamp01(Number(noise) || 0);
  const fadeNear = smooth(near - bandNear / 2, near + bandNear / 2, d);
  const fadeFar = smooth(far - bandFar / 2, far + bandFar / 2, d);
  const fadeEnd = smooth(end - bandEnd / 2, end + bandEnd / 2, d);
  const weights = [1 - fadeNear, fadeNear * (1 - fadeFar), fadeFar * (1 - fadeEnd)];
  const w = weights[tier];
  const keepClose = n < w;
  const keepFar = n >= 1 - w;
  if (tier === 0) return keepClose;
  if (tier === 2) return keepFar;
  // tier === 1 (mid): which boundary it is currently the partner of.
  return d < (near + far) / 2 ? keepFar : keepClose;
}

/** ⭐ SHADOW-SIDE HANDOFF (`props.shadowFar`) — where the SHADOW pass swaps a
 * plant's mid-tier geometry for its impostor, independently of where the
 * colour pass does. The colour crossfade has to reach far out (`lodFar` 135 m
 * is a screen-size judgement); a shadow of a tree past ~100 m is a blob, so
 * carrying LOD1 geometry into every shadow map for it is pure vertex cost.
 *
 * Returns the threshold the shadow-side dither nodes compare against, ALWAYS
 * resolved through the same two guarantees the colour tiers get from
 * `enforceLodGap`/`foliageChunkTierMask`:
 *   - Never above `far − band(far)` — the impostor render mesh only commits
 *     chunks whose distance RANGE reaches tier 2's span, which starts exactly
 *     there. A handoff later than that would ask the impostor mesh to cover
 *     instances it has never been given, and the shadow would simply vanish.
 *   - Never inside the near tier's band (`enforceLodGap` against `near`), so
 *     the two shadow-side crossfades' dither bands never touch — the
 *     complementary discard rule stays exact for the same reason it is in the
 *     colour pass.
 *
 * `0`/unset resolves to `far`: the shadow pass replays the colour pass's
 * decision bit-for-bit, which is every scene that never authoring the prop. */
export function foliageShadowFar(props) {
  const { near, far, bandNear, bandFar } = foliageLodThresholds(props);
  const authored = Number(props.shadowFar);
  if (!Number.isFinite(authored) || authored <= 0) return far;
  return enforceLodGap(near, Math.min(authored, far - bandFar), bandNear);
}

/**
 * ⭐ WHERE EACH TIER CAN CAST, IN WORLD METRES FROM THE VIEWER (09-14). The
 * shader compares distance ÷ INSTANCE SCALE against the thresholds and casts a
 * tier's shadow fully wherever its weight is above zero, i.e. out to each
 * crossfade's far edge (`edge + band/2`). A small plant reaches a scaled
 * threshold sooner, a large one later, so the world span is the scaled span
 * times [minScale, maxScale]. While the impostor is still ramping in, the mid
 * tier carries the leftover out to `end`. Consumed by the per-cascade caster
 * filter (`csmShadowNode.js`), which must never drop a live shadow.
 * `thresholds` = the ENFORCED values the shader reads (`foliageLodThresholds`
 * + `foliageShadowFar`).
 */
export function foliageShadowCasterRanges({ near, far, end, shadowFar = far }, minScale = 1, maxScale = 1, ramp = 1) {
  const half = value => foliageLodBand(value) * .5;
  const lo = Math.max(1e-4, Math.min(minScale, maxScale)), hi = Math.max(minScale, maxScale, 1e-4);
  const scaled = [
    [0, near + half(near)],
    [Math.max(0, near - half(near)), ramp < 1 ? end + half(end) : shadowFar + half(shadowFar)],
    [Math.max(0, shadowFar - half(shadowFar)), end + half(end)],
  ];
  return scaled.map(([from, to]) => [from * lo, to * hi]);
}

/** The impostor bake resolves well after the tier maths already wanted an
 * impostor drawn there: without this, the frame the atlas finishes would
 * snap every qualifying instance, scene-wide, from mid to impostor at once.
 * Split the raw impostor weight between the two tiers by the ramp instead;
 * `mid` keeps whatever `impostor` has not yet faded into. Sum is untouched. */
export function foliageApplyImpostorRamp(weights, ramp) {
  const r = clamp01(Number(ramp) || 0);
  const leftover = weights.impostor * (1 - r);
  weights.impostor -= leftover;
  weights.mid += leftover;
  return weights;
}

/** Discrete "best" tier for bookkeeping that only ever wanted one bucket per
 * chunk — stats, raycast dispatch, shadow fallback. No hysteresis: the
 * continuous crossfade above is what keeps the picture from popping, so a
 * plain boundary compare is enough here. */
export function foliageLodLevel(distance, props) {
  const { near, far, end } = foliageLodThresholds(props);
  const d = Math.max(0, Number(distance) || 0);
  return d < near ? 0 : d < far ? 1 : d < end ? 2 : 3;
}

/**
 * ⭐ SUPERSET CHUNK MEMBERSHIP — tier assignment for a draw-group, not for a
 * plant. A chunk belongs to tier k if ANY point in its authored distance
 * range `[minDistance, maxDistance]` could carry nonzero weight for k, i.e.
 * its range overlaps tier k's active span extended by that tier's own FULL
 * band (not just the half-band that bounds the crossfade's own nonzero
 * weight — `foliageTierWeights`'s twin range). Membership has to lead the
 * weight, not just match it: `FoliageComponent._commitBatches` commits a
 * chunk into a tier's shared render mesh over several real frames on a
 * large scatter (`§batch-order-spread`), so a mask that only starts
 * flagging a tier at the exact instant that tier's weight leaves zero gives
 * the resumable commit no lead time to actually finish before the shader
 * needs a nonzero draw — a real, observed gap ("bake arriving: instance …
 * had only 0.947 of its weight in an actually-committed tier"), not a
 * hypothetical one. A full extra band's worth of margin gives that commit a
 * whole band-width of camera travel to catch up before it matters. Coarser
 * than the weight's own zero point, on purpose: membership only decides
 * which shared render mesh receives the chunk's instance data, never what
 * is actually drawn — that is still the per-instance shader weight plus its
 * screen-door dither, which stay exact.
 *
 * `extendMidToImpostor` folds tier 2's span into tier 1's: while the bake is
 * not ready (or its arrival ramp has not finished), some or all of the
 * "impostor" weight is actually being drawn by the mid mesh (see
 * `foliageApplyImpostorRamp`), so the mid mesh must hold that chunk's data
 * too or the substituted weight has nothing to render.
 */
export function foliageChunkTierMask(minDistance, maxDistance, props, extendMidToImpostor = false, midFromViewer = false) {
  const { near, far, end, bandNear, bandFar, bandEnd } = foliageLodThresholds(props);
  const lo = Math.max(0, Number(minDistance) || 0);
  const hi = Math.max(lo, Number(maxDistance) || 0);
  // ⛔ THE SHADOW HANDOFF NEEDS IMPOSTOR MEMBERSHIP TOO (09-14). The mid mesh's
  // shadow fades out over `shadowFar`'s band, but the impostor mesh used to
  // hold only chunks from `far − bandFar` on — with shadowFar 30 / far 60 every
  // plant between ~34 m and ~52 m cast no shadow at all ("three bushes, the
  // middle one has none"; shadows popping as the camera moved). Its colour
  // weight is still 0 below `far`'s band, so the extra members only cast.
  const shadowFar = foliageShadowFar(props);
  const impostorFrom = Math.min(far - bandFar, shadowFar - foliageLodBand(shadowFar));
  // ⭐ MID FROM THE VIEWER (09-14), only while a clipmap shadow is active: its
  // second level draws mid geometry for EVERY plant it covers, near ones
  // included (`foliageShadowTierRule`), so the mid mesh then holds chunks from
  // 0 m. Their colour weight is 0 there, so the colour pass collapses them.
  const ranges = [
    [0, near + bandNear],
    [midFromViewer ? 0 : near - bandNear, extendMidToImpostor ? end + bandEnd : far + bandFar],
    [impostorFrom, end + bandEnd],
  ];
  let mask = 0;
  for (let tier = 0; tier < 3; tier++) {
    const [tierMin, tierMax] = ranges[tier];
    if (hi >= tierMin && lo <= tierMax) mask |= 1 << tier;
  }
  return mask;
}

export function partitionFoliage(instances, chunkSize = 24, maxChunkInstances = 1024) {
  const size = Math.max(1, Number(chunkSize) || 24);
  const cells = new Map();
  for (const instance of instances) {
    const p = instance.position;
    const key = `${Math.floor(p[0] / size)},${Math.floor(p[1] / size)},${Math.floor(p[2] / size)}`;
    let cell = cells.get(key);
    if (!cell) cells.set(key, cell = []);
    cell.push(instance);
  }
  const chunks = [];
  const limit = Math.max(1, Math.floor(Number(maxChunkInstances) || 1024));
  const split = (key, cell) => {
    if (cell.length <= limit) { chunks.push({ key, instances: cell }); return; }
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const instance of cell) for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], instance.position[axis]);
      max[axis] = Math.max(max[axis], instance.position[axis]);
    }
    const extent = max.map((value, axis) => value - min[axis]);
    const axis = extent[1] > extent[0] && extent[1] >= extent[2] ? 1 : extent[2] > extent[0] ? 2 : 0;
    cell.sort((a, b) => a.position[axis] - b.position[axis]);
    const half = Math.ceil(cell.length / 2);
    split(`${key}a`, cell.slice(0, half)); split(`${key}b`, cell.slice(half));
  };
  for (const [key, cell] of cells) {
    // Consecutive slices of randomly scattered points all span the SAME cell.
    // Median splitting makes a dense child genuinely smaller for LOD/culling.
    split(`${key}:0`, cell);
  }
  return chunks;
}
