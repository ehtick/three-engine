import * as THREE from "three/webgpu";

// Weber & Penn 1995, "Creation and Rendering of Realistic Trees":
// https://algorithmicbotany.org/papers/colonization.egwnp2007.pdf is the space-
// colonization paper this module used to implement; the tree SKELETON is now
// the actual Weber-Penn parametric model instead (recursive stems, shape
// envelopes, segment curvature with splits, species parameter tables). Pruning
// (paper §5.4) is intentionally omitted, as the brief allows for v1.
const cache = new Map();
export const TREE_GROWTH_LIMITS = Object.freeze({
  // Total node budget across every stem/split of one tree, and the cache the
  // component/editor reuses across seeds. `maxOrder` is a hard recursion
  // safety valve independent of any one preset's own authored `levels`.
  nodes: 4200, maxOrder: 6, cachedSkeletons: 24,
});
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const DEG = Math.PI / 180;
const clamp = THREE.MathUtils.clamp;
const lerp = THREE.MathUtils.lerp;

export const TREE_SHAPE_DEFAULTS = Object.freeze({ leafDensity: 1, leafSize: 1, branchDensity: 1, crownBase: 0, crownSpread: 1 });
export function resolveTreeShapeParameters(options = {}) {
  const limits = { leafDensity: [0.5, 1.6], leafSize: [0.6, 1.5], branchDensity: [0.6, 1.4], crownBase: [-0.15, 0.2], crownSpread: [0.7, 1.3] };
  return Object.fromEntries(Object.entries(TREE_SHAPE_DEFAULTS).map(([key, fallback]) => {
    const value = Number(options[key]);
    return [key, clamp(Number.isFinite(value) ? value : fallback, ...limits[key])];
  }));
}

function seeded(seed) {
  let state = seed >>> 0;
  return () => { state = (state + 0x6d2b79f5) >>> 0; let value = Math.imul(state ^ state >>> 15, state | 1); value ^= value + Math.imul(value ^ value >>> 7, value | 61); return ((value ^ value >>> 14) >>> 0) / 4294967296; };
}

// ---------------------------------------------------------------------------
// Weber-Penn species parameter tables.
// ---------------------------------------------------------------------------
export const TREE_SHAPE = Object.freeze({
  CONICAL: 0, SPHERICAL: 1, HEMISPHERICAL: 2, CYLINDRICAL: 3,
  TAPERED_CYLINDRICAL: 4, FLAME: 5, INVERSE_CONICAL: 6, TEND_FLAME: 7,
});

/** Paper §4.1 shape ratio, `r` = 1 - offset/parentLength (1 at the stem's own base). */
function shapeRatio(shape, r) {
  switch (shape) {
    case TREE_SHAPE.CONICAL: return 0.2 + 0.8 * r;
    case TREE_SHAPE.SPHERICAL: return 0.2 + 0.8 * Math.sin(Math.PI * r);
    case TREE_SHAPE.HEMISPHERICAL: return 0.2 + 0.8 * Math.sin(0.5 * Math.PI * r);
    case TREE_SHAPE.CYLINDRICAL: return 1;
    case TREE_SHAPE.TAPERED_CYLINDRICAL: return 0.5 + 0.5 * r;
    case TREE_SHAPE.FLAME: return r <= 0.7 ? r / 0.7 : (1 - r) / 0.3;
    case TREE_SHAPE.INVERSE_CONICAL: return 1 - 0.8 * r;
    case TREE_SHAPE.TEND_FLAME:
    default: return r <= 0.7 ? 0.5 + 0.5 * r / 0.7 : 0.5 + 0.5 * (1 - r) / 0.3;
  }
}

/** `crownSpread` (component prop, 0.7..1.3) blends the authored envelope
 * toward spherical (fuller, >1) or conical (leaner, <1) instead of a flat
 * XZ rescale, so the artistic control changes the actual crown FORM. */
function blendedShapeRatio(shape, crownSpread, r) {
  const base = shapeRatio(shape, r);
  const blend = clamp((crownSpread - 1) / 0.3, -1, 1);
  if (!blend) return base;
  const target = shapeRatio(blend > 0 ? TREE_SHAPE.SPHERICAL : TREE_SHAPE.CONICAL, r);
  // A straight lerp toward "spherical" can SHRINK an authored envelope
  // wherever spherical's own curve happens to dip below it (Hemispherical
  // is 1.0 at the base, same as Conical, but Spherical is only 0.2 there —
  // blending Black Oak toward "wide" made its base-heavy branches shorter,
  // the opposite of wider). `crownSpread > 1` must never pull any point
  // BELOW the authored envelope, only `< 1` may pull it below.
  return blend > 0 ? lerp(base, Math.max(base, target), blend) : lerp(base, Math.min(base, target), -blend);
}

/** Paper §4.3 taper: 0..1 linear to a point, 1..2 eases into a rounded tip
 * instead of running the taper 1 case (which already hits zero) further past
 * it, 2..3 keeps that same rounded ease — literal periodic fluting is left
 * to `lobes`/`lobeDepth` at render time. Every branch is non-increasing in
 * `t` for any input, which is what keeps a trunk's radius monotonic. */
function taperRadius(taper, t, r0) {
  const linear = Math.max(0, 1 - Math.min(taper, 1) * t);
  if (taper <= 1) return r0 * linear;
  const blend = clamp(taper - 1, 0, 1);
  const round = Math.cos(clamp(t, 0, 1) * Math.PI * 0.5);
  return r0 * lerp(linear, round, blend);
}

/** Root flare: a decaying radius bonus in the bottom ~12% of the TRUNK's own
 * length. Multiplying a non-increasing profile by a non-increasing bonus
 * keeps the whole thing non-increasing. */
function flareFactor(flare, t) {
  if (!flare || t > 0.12) return 1;
  const k = 1 - t / 0.12;
  return 1 + flare * k * k;
}

/** `crownBase` (component control, schema range [-.15, .2]) maps onto the
 * trunk fraction below which level-1 branches may not start (`baseSize` in
 * Weber-Penn terms): `baseSize = clamp(preset.baseSize + 0.5*crownBase,
 * floor, ceiling)`. A production population (`valleyEcology.js`) authors
 * `crownBase` NEGATIVE for every single group (-.05 to -.15, meant to LOWER
 * the crown a little from a neutral preset) and adding it straight onto a
 * paper species' own low authored `baseSize` (Black Oak: .05) used to drive
 * the sum negative, clamp to 0, and put branches at the literal ground —
 * three or four fat "level-1" limbs sweeping out right above the roots
 * instead of a trunk with a clear bole.
 *   - `crownBase` ADDS to the preset's own authored `baseSize` (so raising it
 *     always raises where branches start, for every species, the artistic
 *     control the schema promises — a floor expressed as `max(preset value,
 *     formula)` instead would make it a no-op for any species whose own
 *     `baseSize` already exceeds the formula, e.g. every conifer).
 *   - Every tree (any species but the dedicated `shrub` habit) is floored at
 *     12% of trunk length no matter what the preset or `crownBase` say, so a
 *     hard-negative production value can no longer collapse the whole crown
 *     onto the ground; a species with its own naturally taller bare pole
 *     (pine/spruce: .25-.3) still keeps most of that margin even at the most
 *     negative authored `crownBase`. `shrub` keeps its own much lower band
 *     (.02-.10): a real shrub legitimately forks within centimetres of the
 *     soil, and forcing it up to a tree's clear-bole floor would turn every
 *     "hazel"/"young growth" bush into a small tree.
 *   - Oak and Maple additionally floor at 25%: a real oak's or maple's lowest
 *     limbs leave the bole at 25-40% of the tree's height, not 12% — the 12%
 *     floor (still correct for species with a naturally taller bare pole, or
 *     a genuinely low-forking habit) let Black Oak's own very low authored
 *     `baseSize` (.05) plus a production population's negative `crownBase`
 *     put co-dominant leaders at the literal bole-clear minimum, which then
 *     read as thick limbs leaving the trunk far too low (an owner's review:
 *     "two or three thick level-1 limbs leave the trunk at ~10% height").
 */
const HIGH_BOLE_SPECIES = new Set(["oak", "maple"]);
function resolveBaseSize(preset, species, crownBase) {
  const [floor, ceiling] = species === "shrub" ? [0.02, 0.10] : [HIGH_BOLE_SPECIES.has(species) ? 0.25 : 0.12, 0.6];
  return clamp(preset.baseSize + 0.5 * crownBase, floor, ceiling);
}

function level0(length, taper, segSplits, splitAngle, splitAngleV, curveRes, curve, curveBack, curveV, baseSplits) {
  return Object.freeze({ length, lengthV: 0, taper, segSplits, splitAngle, splitAngleV, curveRes, curve, curveBack, curveV, baseSplits });
}
function level0V(length, lengthV, taper, segSplits, splitAngle, splitAngleV, curveRes, curve, curveBack, curveV, baseSplits) {
  return Object.freeze({ length, lengthV, taper, segSplits, splitAngle, splitAngleV, curveRes, curve, curveBack, curveV, baseSplits });
}
function branchLevel(downAngle, downAngleV, rotate, rotateV, branches, length, lengthV, taper, segSplits, splitAngle, splitAngleV, curveRes, curve, curveBack, curveV) {
  return Object.freeze({ downAngle, downAngleV, rotate, rotateV, branches, length, lengthV, taper, segSplits, splitAngle, splitAngleV, curveRes, curve, curveBack, curveV });
}

// Four species are the paper's own published tables (Weber & Penn 1995,
// appendix); six are authored for this engine and judged with the preview
// script (`npm run preview:foliage-trees`). `levels` holds trunk + however
// many branch orders the table defines; a deeper order (rare — only when
// `TREE_GROWTH_LIMITS.maxOrder` forces one) reuses the last defined level,
// matching how these tables are actually consumed by other implementations.
export const TREE_SPECIES_PARAMS = Object.freeze({
  // Quaking Aspen (paper) — also serves `birch`.
  birch: Object.freeze({
    shape: TREE_SHAPE.TEND_FLAME, baseSize: .4, scale: 13, scaleV: 3, ratio: .015, ratioPower: 1.2,
    lobes: 5, lobeDepth: .07, flare: .6, windFlex: 1,
    levels: [
      level0(1, 1, 0, 0, 0, 3, 0, 0, 20, 0),
      branchLevel(60, -50, 140, 0, 50, .3, 0, 1, 0, 0, 0, 5, -40, 0, 50),
      branchLevel(45, 10, 140, 0, 30, .6, 0, 1, 0, 0, 0, 3, -40, 0, 75),
      branchLevel(45, 10, 77, 0, 10, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0),
    ],
    leaves: { count: 25, scale: .17, scaleX: 1, attractionUp: .5 },
    widthReference: 4, heightReference: 9,
  }),
  // Black Oak (paper) — also serves `oak`.
  oak: Object.freeze({
    shape: TREE_SHAPE.HEMISPHERICAL, baseSize: .05, scale: 10, scaleV: 10, ratio: .018, ratioPower: 1.3,
    lobes: 5, lobeDepth: .1, flare: 1.2, windFlex: .6,
    levels: [
      // `baseSplits` is 0, not the paper's own 2: a co-dominant fork straight
      // off the base is exactly what produced a thick near-horizontal leader
      // outside the crown mass (an owner's review, twice) — real single-trunk
      // oaks are common and the crown still forks plenty above 45% height via
      // `segSplits` alone (`ctx.order0SplitMinT`, `growStem`).
      level0(1, .95, .4, 10, 0, 8, 0, 0, 90, 0),
      // `downAngle: 45, downAngleV: 10` (positive — the plain
      // `downAngle + random*downAngleV` branch, not the position-dependent
      // shape-ratio formula a negative `downAngleV` selects) keeps every
      // level-1 limb spreading outward at 35-55 deg regardless of where
      // along the trunk it attaches. The paper's own `downAngle: 30,
      // downAngleV: -30` swept from ~54 deg near the base down to ~12 deg
      // near the tip — the UPPER limbs (most of the crown) rose nearly
      // vertical, which is exactly what read as "a column" instead of a
      // spreading dome.
      branchLevel(45, 10, 80, 0, 40, .8, .1, 1, .2, 10, 10, 10, 40, -70, 150),
      branchLevel(45, 10, 140, 0, 120, .2, .05, 1, .1, 10, 10, 3, 0, 0, -30),
      branchLevel(45, 10, 140, 0, 0, .4, 0, 1, 0, 0, 0, 1, 0, 0, 0),
    ],
    leaves: { count: 25, scale: .12, scaleX: .66, attractionUp: .8 },
    widthReference: 6, heightReference: 8,
  }),
  "black-tupelo": Object.freeze({
    shape: TREE_SHAPE.TAPERED_CYLINDRICAL, baseSize: .2, scale: 23, scaleV: 5, ratio: .015, ratioPower: 1.3,
    lobes: 3, lobeDepth: .1, flare: 1, windFlex: .65,
    levels: [
      level0(1, 1.1, 0, 0, 0, 10, 0, 0, 40, 0),
      branchLevel(60, -40, 140, 0, 50, .3, .05, 1, 0, 0, 0, 10, 0, 0, 90),
      branchLevel(30, 10, 140, 0, 25, .6, .1, 1, 0, 0, 0, 10, -10, 0, 150),
      branchLevel(45, 10, 140, 0, 12, .4, 0, 1, 0, 0, 0, 1, 0, 0, 0),
    ],
    leaves: { count: 6, scale: .3, scaleX: .5, attractionUp: .5 },
    widthReference: 6, heightReference: 9,
  }),
  "weeping-willow": Object.freeze({
    shape: TREE_SHAPE.CYLINDRICAL, baseSize: .05, scale: 15, scaleV: 5, ratio: .03, ratioPower: 2,
    lobes: 9, lobeDepth: .03, flare: .75, windFlex: 1.1,
    levels: [
      level0(.8, 1, .1, 3, 2, 8, 0, 20, 120, 2),
      branchLevel(20, 10, -120, 30, 25, .5, .1, 1, .2, 30, 10, 16, 40, 80, 90),
      branchLevel(30, 10, -120, 30, 10, 1.5, 0, 1, .2, 45, 20, 12, 0, 0, 0),
      branchLevel(20, 10, 140, 0, 300, .1, 0, 1, 0, 0, 0, 1, 0, 0, 0),
    ],
    leaves: { count: 15, scale: .12, scaleX: .2, attractionUp: -3 },
    widthReference: 9, heightReference: 8,
  }),
  // Authored: conifer, whorled branches, short needle-bearing twigs.
  pine: Object.freeze({
    shape: TREE_SHAPE.CONICAL, baseSize: .3, scale: 11, scaleV: 2, ratio: .015, ratioPower: 1.1,
    lobes: 0, lobeDepth: 0, flare: .2, windFlex: .78,
    levels: [
      level0(1, .95, 0, 0, 0, 16, 0, 0, 15, 0),
      // Length trimmed from the original .38/.12 (paired with the level-2
      // whorl below, that raw silhouette ran 35-47% of tree height even at
      // neutral `crownSpread` — "conical" in name but a wide floppy cone, not
      // the narrow tiered spire the brief asks for) so the natural silhouette
      // sits inside the conifer crown-radius guarantee without the safety
      // clamp in `growTreeSkeleton` having to crush every crownSpread setting
      // to the same ceiling.
      branchLevel(70, -14, 140, 6, 45, .24, .08, .85, 0, 0, 0, 4, 8, 0, 20),
      branchLevel(55, 10, 140, 10, 7, .27, .11, 1, 0, 0, 0, 2, 0, 0, 15),
    ],
    leaves: { count: 28, scale: .13, scaleX: 1, attractionUp: .3 },
    widthReference: 4, heightReference: 10,
  }),
  // Authored: denser, more downward-curving whorls than pine.
  spruce: Object.freeze({
    shape: TREE_SHAPE.CONICAL, baseSize: .25, scale: 14, scaleV: 2, ratio: .012, ratioPower: 1.1,
    lobes: 0, lobeDepth: 0, flare: .15, windFlex: .74,
    levels: [
      level0(1, 1, 0, 0, 0, 10, 0, 0, 10, 0),
      // Trimmed alongside pine's own level 1/2, same reason: a narrower
      // natural cone that fits the conifer crown-radius guarantee on its own.
      branchLevel(82, -22, 137, 8, 70, .21, .06, .9, 0, 0, 0, 5, 30, 0, 15),
      branchLevel(62, 15, 140, 10, 6, .24, .08, 1, 0, 0, 0, 2, 10, 0, 10),
    ],
    leaves: { count: 26, scale: .09, scaleX: 1, attractionUp: .2 },
    widthReference: 4, heightReference: 13,
  }),
  // Authored: spherical, 3 levels, wide.
  maple: Object.freeze({
    shape: TREE_SHAPE.SPHERICAL, baseSize: .2, scale: 9, scaleV: 1.5, ratio: .022, ratioPower: 1.3,
    lobes: 4, lobeDepth: .1, flare: .6, windFlex: .7,
    levels: [
      level0(1, .9, .2, 15, 5, 6, 0, 0, 30, 1),
      branchLevel(40, 15, 110, 20, 35, .65, .15, 1, .1, 15, 10, 6, 20, -10, 60),
      branchLevel(40, 15, 140, 15, 25, .45, .15, 1, 0, 0, 0, 3, 10, 0, 40),
    ],
    leaves: { count: 20, scale: .22, scaleX: 1.1, attractionUp: .4 },
    widthReference: 9, heightReference: 10,
  }),
  // Authored: cylindrical/fastigiate, narrow, strong upward leaf/twig bias.
  poplar: Object.freeze({
    shape: TREE_SHAPE.CYLINDRICAL, baseSize: .15, scale: 16, scaleV: 2, ratio: .012, ratioPower: 1.15,
    lobes: 0, lobeDepth: 0, flare: .15, windFlex: .68,
    levels: [
      level0(1, 1, 0, 0, 0, 10, 0, 0, 8, 0),
      branchLevel(15, 8, 110, 10, 55, .55, .1, 1, 0, 0, 0, 6, -15, 0, 15),
      branchLevel(10, 5, 140, 10, 8, .4, .1, 1, 0, 0, 0, 2, 0, 0, 10),
    ],
    leaves: { count: 20, scale: .16, scaleX: 1, attractionUp: 1.5 },
    widthReference: 2.5, heightReference: 14,
  }),
  // Authored: small, spherical, densely forking from a low base.
  shrub: Object.freeze({
    shape: TREE_SHAPE.SPHERICAL, baseSize: .05, scale: 2, scaleV: .5, ratio: .03, ratioPower: 1.2,
    lobes: 0, lobeDepth: 0, flare: .3, windFlex: .9,
    levels: [
      level0V(1, 0, 1, .3, 25, 10, 4, 0, 0, 40, 2),
      branchLevel(55, 15, 130, 20, 25, .7, .2, 1, .15, 20, 10, 3, 15, 0, 50),
      branchLevel(50, 15, 140, 15, 15, .5, .15, 1, 0, 0, 0, 2, 0, 0, 35),
    ],
    leaves: { count: 18, scale: .14, scaleX: 1, attractionUp: .5 },
    widthReference: 2.2, heightReference: 2,
  }),
  // Authored: small, gnarled, tortuous curvature at every level.
  hawthorn: Object.freeze({
    shape: TREE_SHAPE.HEMISPHERICAL, baseSize: .15, scale: 3.5, scaleV: .5, ratio: .02, ratioPower: 1.25,
    lobes: 0, lobeDepth: 0, flare: .4, windFlex: .8,
    levels: [
      level0V(1, 0, .9, .5, 25, 15, 5, 0, 0, 60, 1),
      branchLevel(50, 20, 125, 25, 30, .6, .2, 1, .3, 25, 15, 4, 20, -15, 60),
      branchLevel(50, 20, 140, 20, 18, .45, .15, 1, .1, 15, 10, 3, 0, 0, 60),
      branchLevel(45, 15, 140, 15, 6, .3, .1, 1, 0, 0, 0, 1, 0, 0, 40),
    ],
    leaves: { count: 14, scale: .1, scaleX: 1, attractionUp: .4 },
    widthReference: 4.5, heightReference: 5,
  }),
});

/** Read-only species table lookup, used by the geometry builder and by tests
 * that need to check a generated skeleton against its own preset. */
export function getTreeSpeciesParams(species) {
  return TREE_SPECIES_PARAMS[species] ?? TREE_SPECIES_PARAMS.oak;
}
export function isNeedleSpecies(species) {
  return species === "pine" || species === "spruce";
}

const levelOf = (preset, order) => preset.levels[Math.min(order, preset.levels.length - 1)];

/**
 * Recursive Weber-Penn stem synthesis.
 *
 * A "stem" is walked segment by segment (§4.2). Curvature bends it within a
 * per-stem plane (`axis`), with a small out-of-plane wobble for organic
 * irregularity that the paper leaves unspecified. `segSplits` is an
 * error-diffusion accumulator SHARED across every stem at a given order, so
 * the count is exact on average (§4.4) rather than per-stem; a split spawns
 * two continuations from the fork point that each recurse WITHIN THE SAME
 * order (a split never changes order).
 *
 * A finished chain (natural end, or a fork) does NOT recurse into the next
 * order immediately — it is queued (`ctx.queue`) and `growTreeSkeleton`
 * drains that queue breadth-first, one order at a time. A depth-first
 * "finish this whole branch, then move to the next level-1 sibling" order
 * let an early level-1 stem's entire level-2/3 subtree spend the whole node
 * budget before a later sibling was ever created, so a preset's OWN
 * level-1 count (which a test checks directly) came out far short under
 * budget pressure. Breadth-first guarantees every order fully exists before
 * the next one starts spending nodes, so only the DEEPEST levels are ever
 * the ones a tight budget thins out.
 */
function growStem(ctx, spec) {
  const { preset, order, parentId, direction, tStart, segments, curveRes, r0, axis, stemStartDir, isTrunk } = spec;
  if (ctx.nodes.length >= TREE_GROWTH_LIMITS.nodes || segments <= 0) return;
  const params = levelOf(preset, order);
  const dir = direction.clone();
  let pos = ctx.nodes[parentId].position.clone();
  let currentId = parentId;
  const segLen = spec.ownLength / curveRes;
  const chain = [];
  const declinationOf = () => dir.angleTo(stemStartDir) / DEG;
  // Local to this stem lineage (carried across its own splits via `splitDebt`
  // in `spec`, never shared with sibling stems): a stem with segSplits=0.4
  // should itself fork roughly 40% of the time per segment, not have its
  // odds inflated by how many OTHER stems of the same order happen to exist.
  // A pool shared across the whole order previously fed back on itself —
  // more clones meant more segment-steps into the same pool, meant more
  // splits, meant more clones — and produced a Black Oak with 1,487 "level-1"
  // branches against a preset value of 40.
  let debt = spec.splitDebt ?? 0;
  for (let seg = 0; seg < segments; seg++) {
    if (ctx.nodes.length >= TREE_GROWTH_LIMITS.nodes) break;
    let bendDeg;
    if (params.curveBack) {
      const half = curveRes / 2;
      bendDeg = ((tStart * curveRes + seg) < half ? params.curve : params.curveBack) / half;
    } else {
      bendDeg = params.curve / curveRes;
    }
    bendDeg += (ctx.random() * 2 - 1) * params.curveV / curveRes;
    dir.applyAxisAngle(axis, bendDeg * DEG);
    dir.applyAxisAngle(stemStartDir, (ctx.random() - 0.5) * params.curveV * .12 * DEG);
    dir.normalize();
    pos = pos.clone().addScaledVector(dir, segLen);
    // A gnarled/drooping species (curveV up to 150 on Black Oak's own
    // published table) can curve a low stem below the ground it grows out
    // of. Nothing here models soil or roots, so simply floor it at the
    // root's own height instead of letting geometry dip below y=0.
    if (pos.y < 0) pos.y = 0;
    const t = tStart + (seg + 1) / curveRes * (1 - tStart);
    let radius = taperRadius(params.taper, t, r0);
    if (isTrunk) radius *= flareFactor(preset.flare, t);
    const node = { id: ctx.nodes.length, parent: currentId, position: pos.clone(), order, scaffold: true, children: [], radius };
    ctx.nodes.push(node);
    ctx.nodes[currentId].children.push(node.id);
    currentId = node.id;
    chain.push({ id: node.id, t, offset: t * spec.fullLength, radius, direction: dir.clone() });

    // Error-diffusion split, local to this lineage: the average split count
    // over one stem's own `curveRes` segments matches `segSplits` exactly.
    // Order 0 (the trunk) is additionally rationed by `order0SplitBudget`: a
    // trunk split multiplies EVERY level below it (Black Oak's published
    // segSplits=0.4 plus baseSplits=2, threaded through without a cap, built
    // ~20 co-dominant "trunk" pieces per tree — each with its own full ~40
    // level-1 branches — and took over 90 ms to turn into geometry). Deeper
    // orders don't need this: their branch counts are already rationed by
    // `deepScale`.
    if (params.segSplits > 0 && seg < segments - 1 && (order !== 0 || (ctx.order0Splits < ctx.order0SplitBudget && t >= ctx.order0SplitMinT))) {
      debt += params.segSplits;
      if (debt >= 1 && ctx.nodes.length < TREE_GROWTH_LIMITS.nodes) {
        debt -= 1;
        if (order === 0) ctx.order0Splits++;
        const declination = declinationOf();
        const splitAngle = Math.max(0, params.splitAngle + (ctx.random() * 2 - 1) * params.splitAngleV - declination);
        const remaining = segments - seg - 1;
        const nextT = tStart + (seg + 1) / curveRes * (1 - tStart);
        for (const sign of [1, -1]) {
          const cloneDir = dir.clone().applyAxisAngle(axis, sign * splitAngle * .5 * DEG);
          growStem(ctx, {
            preset, order, parentId: currentId, direction: cloneDir, tStart: nextT, segments: remaining, curveRes,
            r0, axis, stemStartDir, isTrunk, ownLength: spec.ownLength, fullLength: spec.fullLength, splitDebt: debt,
          });
        }
        ctx.queue.push({ preset, order, parentId: node.id, chain, ownLength: chain.length * segLen, isTrunk, tipCandidate: node.id, start: { id: parentId, t: tStart, direction } });
        if (chain.length) ctx.branches.push({ ids: [parentId, ...chain.map(c => c.id)], order, radius: chain.at(-1).radius });
        return;
      }
    }
  }
  if (chain.length) {
    ctx.queue.push({ preset, order, parentId: currentId, chain, ownLength: chain.length * segLen, isTrunk, tipCandidate: chain.at(-1).id, start: { id: parentId, t: tStart, direction } });
    ctx.branches.push({ ids: [parentId, ...chain.map(c => c.id)], order, radius: chain.at(-1).radius });
  }
}

/** Places order+1 children along `chain` (this stem's own generated portion)
 * and recurses. Level-1 children use the paper's shape-ratio length formula
 * and only start above `baseSize` of the trunk; deeper levels use the
 * simpler linear-decay length formula and may start from the parent's base.
 * Returns the number of child stems actually attached, so a stem that gets
 * none (order limit, or a preset whose deepest level has `branches: 0`) is
 * treated by the caller as a leaf-bearing tip instead of a bald twig. */
function attachChildren(ctx, { preset, order, chain, ownLength, isTrunk, start }) {
  const nextOrder = order + 1;
  if (nextOrder > ctx.maxOrder) return 0;
  const childParams = levelOf(preset, nextOrder);
  if (!childParams.branches || !chain.length || ownLength <= 1e-6) return 0;
  // `ctx.baseSize` (see `resolveBaseSize`) is bounded to at most 0.6 of the
  // trunk regardless of how far `crownBase` (an artistic offset, [-.15, .2]
  // in the schema) pushes it: a species with a naturally high `baseSize`
  // plus the top of that range must still leave most of the trunk available
  // to branch, or a whole ridge line of one preset can render as a bare
  // tapered pole with a crown that never had anywhere left to start from.
  const tMin = isTrunk ? ctx.baseSize : 0;
  if (tMin >= 1) return 0;
  // Level 1 keeps the preset's literal branch count (a test checks it stays
  // within 20% of the table). The paper's own deeper-level counts (Black
  // Oak's 120 per level-1 stem, Weeping Willow's 300 per level-2 stem) are
  // tuned for offline per-leaf rendering and would multiply out to millions
  // of stems; `deepScale`/`level1Scale` (computed once per tree from the node
  // budget, see `estimateScales`) ration them so every branch gets ITS share
  // of the budget instead of the first ones processed exhausting it. Level 1
  // additionally floors at 8 regardless of rationing or `branchDensity`: a
  // production population authors branchDensity/leafDensity/crownSpread far
  // from 1 together, and a level that only guards against literal zero could
  // still round to 1-3 real branches on a live scatter and read as bare.
  const scale = nextOrder >= 2 ? ctx.deepScale : ctx.level1Scale;
  const floor = nextOrder === 1 ? 8 : 2;
  const count = Math.max(floor, Math.round(childParams.branches * ctx.branchDensity * scale));
  if (!count) return 0;

  // Rank uniformly-spaced candidates by the paper's density weight and keep
  // the top `count`, biasing placement without a full CDF inversion.
  // A 3-point sample (0, 0.5, 1) missed FLAME/TEND_FLAME's own peak at
  // r=0.7 entirely, under-normalizing the weight there by ~15% and
  // concentrating an aspen's whole canopy into a mushroom cap around 30%
  // height instead of spreading branches along the trunk. Scan densely.
  let maxShape = 1;
  if (isTrunk) { maxShape = 0; for (let i = 0; i <= 20; i++) maxShape = Math.max(maxShape, blendedShapeRatio(preset.shape, ctx.crownSpread, i / 20)); maxShape ||= 1; }
  // Sample `t` from the weight profile as a density, not a hard cutoff: for
  // a monotonic profile (Conical's is highest at the base and falls off
  // toward the tip), taking the top `count` positions BY weight always picks
  // the same end regardless of how many are asked for — a pine's whole
  // canopy collapsed into one ball hugging the trunk base, bare above it,
  // instead of a tapering cone of whorls with branches at every height.
  // Build the CDF over evenly-spaced samples and invert it at `count`
  // evenly-spaced quantiles, so denser regions get more picks without ever
  // losing sparser ones entirely.
  const bins = Math.max(count * 4, 40);
  const cdf = new Float64Array(bins + 1);
  for (let i = 0; i < bins; i++) {
    const u = (i + .5) / bins, t = tMin + u * (1 - tMin);
    const weight = Math.max(1e-4, isTrunk ? .2 + .8 * blendedShapeRatio(preset.shape, ctx.crownSpread, 1 - t) / maxShape : 1 - .5 * t);
    cdf[i + 1] = cdf[i] + weight;
  }
  const total = cdf[bins];
  const picked = [];
  for (let i = 0; i < count; i++) {
    const target = ((i + .5) / count + (ctx.random() - .5) / count) * total;
    let bin = 0;
    while (bin < bins && cdf[bin + 1] < target) bin++;
    const span = cdf[bin + 1] - cdf[bin];
    const frac = span > 0 ? (target - cdf[bin]) / span : ctx.random();
    const u = (bin + clamp(frac, 0, 1)) / bins;
    picked.push({ t: tMin + u * (1 - tMin) });
  }
  picked.sort((a, b) => a.t - b.t);

  // Every candidate used to snap to the NEAREST existing chain node — fine
  // when there are as many chain nodes as candidates, but Quaking Aspen's
  // own trunk is only `curveRes: 3` segments while its level-1 table asks
  // for 50 branches: every one of those 50 collapsed onto the same single
  // node, and the whole canopy attached at one exact height instead of
  // spreading from the crown base to the tip. Interpolate a real anchor
  // point along the segment instead, creating a small stub node there (it
  // renders nothing itself — `branchTube` only draws nodes listed in a
  // branch's own `ids` — it only gives the new child stem someplace
  // accurate to start from).
  const startPoint = { t: start.t, position: ctx.nodes[start.id].position, radius: ctx.nodes[start.id].radius, direction: start.direction };
  const samples = [startPoint, ...chain.map(entry => ({ t: entry.t, position: ctx.nodes[entry.id].position, radius: entry.radius, direction: entry.direction, id: entry.id }))];
  const anchorAt = t => {
    let lo = samples[0], hi = samples[samples.length - 1];
    for (let k = 0; k < samples.length - 1; k++) if (samples[k].t <= t && t <= samples[k + 1].t) { lo = samples[k]; hi = samples[k + 1]; break; }
    const span = hi.t - lo.t, f = span > 1e-9 ? clamp((t - lo.t) / span, 0, 1) : 0;
    if (f < 1e-3 && lo.id != null) return { id: lo.id, radius: lo.radius, direction: lo.direction };
    if (f > 1 - 1e-3 && hi.id != null && hi.radius > 0) return { id: hi.id, radius: hi.radius, direction: hi.direction };
    // A stem tapers to exactly zero radius at its own tip (`taper<=1`); a
    // pick landing there must not become a zero-radius child (dropped
    // downstream) — fall back to the nearest point with real radius instead.
    if (hi.radius <= 0) return { id: lo.id ?? start.id, radius: Math.max(lo.radius, 1e-6), direction: lo.direction };
    const position = lo.position.clone().lerp(hi.position, f);
    // A short segment (a low `curveRes`, or one already shortened by a
    // split) can put even a mid-range `f` within floating-point noise of an
    // EXISTING node in real (not fractional) distance — reuse it rather
    // than mint a stub so close it fails the "every node moved" invariant.
    if (position.distanceTo(lo.position) < 1e-4) return { id: lo.id ?? start.id, radius: lo.radius, direction: lo.direction };
    if (hi.id != null && position.distanceTo(hi.position) < 1e-4) return { id: hi.id, radius: hi.radius, direction: hi.direction };
    const direction = lo.direction.clone().lerp(hi.direction, f).normalize();
    const radius = lerp(lo.radius, hi.radius, f);
    const id = ctx.nodes.length;
    // The structural parent must be `lo` (the thicker, upstream point), even
    // when `hi` is numerically closer: the interpolated radius sits between
    // the two, so parenting to `hi` (thinner) made a child wider than its
    // own parent — the exact monotonic-taper invariant this generator
    // otherwise guarantees everywhere.
    const parent = lo.id ?? start.id;
    ctx.nodes.push({ id, parent, position, renderPosition: position.clone(), order: ctx.nodes[parent].order, scaffold: true, children: [], radius });
    ctx.nodes[parent].children.push(id);
    return { id, radius, direction };
  };

  let angle = ctx.random() * 360, attached = 0;
  for (const candidate of picked) {
    if (ctx.nodes.length >= TREE_GROWTH_LIMITS.nodes) break;
    const sample = anchorAt(candidate.t);
    const parentDir = sample.direction;
    angle += (childParams.rotate < 0 ? 180 + childParams.rotate : childParams.rotate) + (ctx.random() * 2 - 1) * childParams.rotateV;
    let side = V(Math.abs(parentDir.y) > .9 ? 1 : 0, Math.abs(parentDir.y) > .9 ? 0 : 1, 0).cross(parentDir).normalize();
    if (side.lengthSq() < .25) side = V(1, 0, 0);
    side.applyAxisAngle(parentDir, angle * DEG);
    const rInverse = isTrunk ? 1 - candidate.t : candidate.t;
    let downV = childParams.downAngleV < 0
      ? childParams.downAngle + childParams.downAngleV * (1 - 2 * shapeRatio(TREE_SHAPE.CONICAL, rInverse))
      : childParams.downAngle + (ctx.random() * 2 - 1) * childParams.downAngleV;
    // The lowest level-1 limbs of a real oak/maple rise at 30-50 deg off the
    // trunk, never toward horizontal — Oak's own formula above already lands
    // near there for most of the crown, but the lowest candidates (`rInverse`
    // near 1, right where a co-dominant leader's own base sits) could still
    // reach into the 50s; cap it outright for these two species so no lowest
    // limb this table can generate ever reads as "sweeping out horizontal".
    if (nextOrder === 1 && isTrunk && HIGH_BOLE_SPECIES.has(ctx.species)) downV = Math.min(downV, 60);
    const down = clamp(downV, -179, 179) * DEG;
    const childDir = parentDir.clone().multiplyScalar(Math.cos(down)).addScaledVector(side, Math.sin(down)).normalize();

    let length, radiusParent = sample.radius;
    if (order === 0) {
      const r = 1 - candidate.t;
      length = ownLength * (childParams.length + ctx.random() * childParams.lengthV) * Math.max(.02, blendedShapeRatio(preset.shape, ctx.crownSpread, r)) * ctx.widthMultiplier;
      // Absolute ceiling on a level-1 LIMB's own straight-line length, in the
      // same raw units `ctx.trunkLength` is in (see its own comment): `width`
      // alone used to be capped only as a RATIO of the species' reference
      // width, which said nothing about the tree's own height — a wide,
      // short population could still authorize a limb most of the trunk's
      // own length. No level-1 limb may reach past 0.55x the tree's own
      // height measured from the trunk axis; the crown-envelope shorten pass
      // below (`growTreeSkeleton`'s median-radius clamp) is the actual
      // GUARANTEE once curvature/downAngle bend the limb further outward —
      // this just keeps the AUTHORED length itself from ever starting there.
      length = Math.min(length, ctx.trunkLength * 0.55);
    } else {
      length = (childParams.length + ctx.random() * childParams.lengthV) * Math.max(0, ownLength - .6 * candidate.t * ownLength);
    }
    length = Math.max(length, ownLength * .015);
    const radius = radiusParent * Math.pow(clamp(length / Math.max(ownLength, 1e-6), 0, 1), preset.ratioPower);
    if (radius <= 0 || !Number.isFinite(length)) continue;

    let axis = V(Math.abs(childDir.y) > .9 ? 1 : 0, Math.abs(childDir.y) > .9 ? 0 : 1, 0).cross(childDir).normalize();
    if (axis.lengthSq() < .25) axis = V(1, 0, 0);
    axis.applyAxisAngle(childDir, ctx.random() * Math.PI * 2);
    const curveRes = Math.max(1, Math.round(levelOf(preset, nextOrder).curveRes));
    growStem(ctx, {
      preset, order: nextOrder, parentId: sample.id, direction: childDir, tStart: 0, segments: curveRes, curveRes,
      r0: radius, axis, stemStartDir: childDir.clone(), isTrunk: false, ownLength: length, fullLength: length,
    });
    attached++;
  }
  return attached;
}

/** How much to ration every level-2-and-deeper branch count by so a whole
 * tree's node count stays inside `TREE_GROWTH_LIMITS.nodes` regardless of
 * which branch generation visits first. The paper's own per-parent counts
 * (Black Oak: 120 level-2 stems per level-1 branch; Weeping Willow: 300
 * level-3 stems per level-2 branch) are tuned for offline per-leaf render
 * and multiply out to millions of stems; this computes the single uniform
 * scale that fits the EXPECTED total into the budget, so the runtime node
 * cap in `growStem`/`attachChildren` is a rare safety net rather than the
 * thing deciding which branches get sub-twigs and which go bald. */
function estimateScales(preset, leaders, order0SplitBudget, maxOrder, nodeBudget) {
  // Budget-fit math always uses the REFERENCE density (1, the preset's own
  // literal branch counts), never the caller's actual `branchDensity`. Both
  // scales returned here are density-independent constants that
  // `attachChildren` multiplies by the user's actual density afterward — if
  // this function used the real density instead, a fixed node budget would
  // divide it back out again (`level1Scale ∝ 1/density` when the budget
  // binds), and the artistic control would have no visible effect at all.
  // That was measured directly: Black Oak produced the exact same level-1
  // branch count at branchDensity 0.6, 1 and 1.4.
  const level0Params = preset.levels[0];
  const level1Params = levelOf(preset, 1);
  // A species whose OWN trunk forks (Black Oak: baseSplits + segSplits) ends
  // up with more order-0 stems than `leaders` alone — each fully entitled to
  // the preset's own level-1 branch count. Estimating level-1 load from just
  // `leaders` (as if oak had 3 trunks, not the ~15 its splits actually build)
  // under-counted order-1 nodes by ~5x, so order-1 generation itself silently
  // exhausted the node budget. `order0SplitBudget` bounds how many extra
  // stems splitting can add (0 when the level has no `segSplits` at all).
  const order0Stems = leaders + (level0Params.segSplits > 0 ? order0SplitBudget : 0);
  const level1PerLeader = Math.max(0, Math.round(level1Params.branches));
  const level1Count = order0Stems * level1PerLeader;
  const trunkNodes = order0Stems * Math.max(1, level0Params.curveRes) * .6;
  const level1NodesAtScale1 = level1Count * Math.max(1, level1Params.curveRes) * 1.15;
  // Reserve at most half the remaining budget for level 1 so a richly-forked
  // trunk still leaves room for level 2+ instead of spending everything one
  // order early.
  const level1Budget = Math.max(0, nodeBudget - trunkNodes) * .5;
  const level1Scale = level1NodesAtScale1 <= level1Budget || level1NodesAtScale1 <= 0
    ? 1 : clamp(level1Budget / level1NodesAtScale1, .05, 1);
  const level1NodesActual = level1NodesAtScale1 * level1Scale;

  let deeperAtScale1 = 0, siblings = level1Count * level1Scale;
  for (let order = 2; order <= maxOrder; order++) {
    const params = levelOf(preset, order);
    const branches = Math.max(0, Math.round(params.branches));
    if (!branches || siblings <= 0) break;
    siblings *= branches;
    deeperAtScale1 += siblings * Math.max(1, params.curveRes) * 1.1;
    if (siblings > 2e6) break; // already far past anything a scale factor could rescue
  }
  const remaining = Math.max(0, nodeBudget - trunkNodes - level1NodesActual);
  const deepScale = deeperAtScale1 <= remaining || deeperAtScale1 <= 0 ? 1 : clamp(remaining / deeperAtScale1, .03, 1);
  return { level1Scale, deepScale };
}

/** Cached, deterministic Weber-Penn skeleton. Identical seed and shape
 * controls always produce the identical (===) cached result. */
export function growTreeSkeleton(options = {}) {
  const { species = "oak", height = 8, seed = 1 } = options;
  const authoredWidth = options.width ?? 6;
  const shape = resolveTreeShapeParameters(options);
  const key = `${species}:${height}:${authoredWidth}:${seed >>> 0}:${shape.branchDensity}:${shape.crownBase}:${shape.crownSpread}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const preset = getTreeSpeciesParams(species);
  const random = seeded(seed);
  const root = { id: 0, parent: -1, position: V(), order: 0, scaffold: true, children: [], radius: 0 };
  const maxOrder = Math.min(TREE_GROWTH_LIMITS.maxOrder, preset.levels.length - 1);
  const trunk = preset.levels[0];
  const leaders = Math.max(0, Math.round(trunk.baseSplits ?? 0)) + 1;
  const order0SplitBudget = leaders * 2;
  const scales = estimateScales(preset, leaders, order0SplitBudget, maxOrder, TREE_GROWTH_LIMITS.nodes * .85);
  const ctx = {
    nodes: [root], branches: [], tips: [], random, queue: [], species,
    maxOrder, branchDensity: shape.branchDensity, crownSpread: shape.crownSpread, crownBase: shape.crownBase,
    baseSize: resolveBaseSize(preset, species, shape.crownBase),
    // `width` (component control) scales level-1 length relative to the
    // species' own reference width. This used to run all the way to 3x with
    // no relation to the tree's own HEIGHT: at a production population's own
    // width (valleyEcology authors 1.2-1.67x every reference), a level-1
    // branch's paper-tuned length formula (already close to the trunk's own
    // length for some species) could exceed the trunk itself — "limbs longer
    // than the tree is tall". Tightening the multiplier's own range keeps
    // ordinary inputs proportionate; `growTreeSkeleton`'s crown-radius clamp
    // below is the actual GUARANTEE (species/shape/downAngle interact too
    // much for a single upstream constant to bound the result on its own).
    widthMultiplier: clamp(authoredWidth / (preset.widthReference || authoredWidth), .4, 1.6),
    deepScale: scales.deepScale, level1Scale: scales.level1Scale,
    order0Splits: 0, order0SplitBudget,
    // Oak/Maple's own trunk (`segSplits`) may still fork above 45% of trunk
    // length to build the crown's own scaffold — but never below it, or a
    // low fork reads exactly like a co-dominant leader (`baseSplits`, now 0
    // for Oak) leaving the trunk near the ground.
    order0SplitMinT: HIGH_BOLE_SPECIES.has(species) ? 0.45 : 0,
  };

  const scale = preset.scale + random() * preset.scaleV;
  const trunkLength = Math.max(.05, scale * (trunk.length + random() * trunk.lengthV));
  // Raw-unit stand-in for the final authored `height`: the whole skeleton is
  // uniformly rescaled to match `height` only at the very end (`heightScale`
  // below), so a length CAP expressed in real metres has to be applied here,
  // in the same raw units `trunkLength` itself is in — `trunkLength` is what
  // that later rescale maps onto `height`, so it is the right stand-in.
  ctx.trunkLength = trunkLength;
  const radius0 = trunkLength * preset.ratio;
  // The root itself is rendered as every leader's first tube ring; give it a
  // real radius instead of the zero-width point a fresh node defaults to, or
  // a single trunk (and every co-dominant leader) would flare out of a spike.
  root.radius = radius0;
  const curveRes = Math.max(1, Math.round(trunk.curveRes));
  const spin = random() * Math.PI * 2;
  // A species with co-dominant leaders (`baseSplits` > 0: Black Oak, Weeping
  // Willow, Maple, Hawthorn) used to fork every leader straight out of the
  // ROOT — several near-vertical stems sweeping apart from the literal
  // ground, read by an owner's review as "the trunk splits into a few
  // near-vertical stems low down" rather than a tree with an actual trunk.
  // Grow one shared, UNFORKED bole first (a preset clone with `segSplits`
  // zeroed too, so nothing can fork inside it either) for at least 15% of
  // the trunk's own length, then split into `leaders` co-dominant stems from
  // its tip — `baseSplits` still produces the same species-authored fork
  // count, just no longer at the ground. A single-leader species
  // (`leaders===1`, most of the table) is untouched; `shrub` keeps its own
  // much lower fork height (see `resolveBaseSize`: "a real shrub legitimately
  // forks within centimetres of the soil").
  // At least 15%, but never SHORTER than wherever `crownBase` already
  // permits level-1 branches to start (`ctx.baseSize`) — a species authored
  // with a naturally high `baseSize` (Hawthorn .15, Maple .2) keeps its own
  // bole at least that tall instead of the flat floor undershooting it.
  // Oak/Maple (`HIGH_BOLE_SPECIES`) get this straight, unforked base even at
  // `leaders===1` (Oak's own `baseSplits` is now 0): a single trunk left to
  // curve/wobble the whole way from the ground under the species' own high
  // `curveV` reached its nominal 25%-of-length point (`ctx.baseSize`) with a
  // vertical Y a shade under the 25%-of-HEIGHT floor `attachChildren`'s
  // `tMin` promises — the same discretization gap `baseSplits`-driven
  // co-dominant leaders already needed a straightened base to avoid.
  const boleFraction = (leaders > 1 || HIGH_BOLE_SPECIES.has(species)) && species !== "shrub" ? Math.max(0.15, ctx.baseSize) : 0;
  let boleParentId = 0, boleSegments = 0;
  if (boleFraction > 0) {
    // Round UP so the bole is never even a fraction short of the promised
    // 15% (an 8-segment trunk's own literal 15% is 1.2 segments — rounding
    // that DOWN to 1 would leave the bole a hair under the promise).
    boleSegments = Math.max(1, Math.min(curveRes - 1, Math.ceil(curveRes * boleFraction)));
    // A real bole is the straightest part of the trunk — the gnarled sweep
    // (Black Oak's own curveV: 90) belongs to the co-dominant leaders above
    // it, not the shared base. Zeroing curve/curveBack/curveV here (on top of
    // the already-zeroed segSplits/baseSplits) also keeps the bole's actual
    // vertical rise matching its own arc length exactly — with any wobble
    // left in, `boleFraction` clamped tight against `ctx.baseSize` (Oak/Maple's
    // 25% floor) could curve just enough sideways to leave the bole's own tip
    // a hair short of that promised height, undercutting the floor
    // `attachChildren`'s `tMin` is supposed to guarantee.
    const boleOnlyPreset = { ...preset, levels: [{ ...trunk, segSplits: 0, baseSplits: 0, curve: 0, curveBack: 0, curveV: 0 }, ...preset.levels.slice(1)] };
    growStem(ctx, {
      preset: boleOnlyPreset, order: 0, parentId: 0, direction: V(0, 1, 0), tStart: 0, segments: boleSegments, curveRes,
      r0: radius0, axis: V(1, 0, 0), stemStartDir: V(0, 1, 0), isTrunk: true, ownLength: trunkLength, fullLength: trunkLength,
    });
    boleParentId = ctx.nodes.length - 1;
    // The bole is a clear, branch-free base by construction; `growStem`
    // always queues whatever it just grew for the NEXT order's
    // `attachChildren` pass, same as any ordinary stem. Its own chain is far
    // too short to usefully interpolate against `attachChildren`'s
    // whole-trunk candidate range (every candidate past its tiny [0,boleT]
    // span clamps straight to the bole's own tip node), which pinned a whole
    // cluster of level-1 branches to one fixed, crownBase-INSENSITIVE height
    // — pop the queue entry so nothing attaches directly to the bole at all.
    // It still renders as bark (already recorded in `ctx.branches`); the
    // `leaders` grown below (the ORIGINAL preset, their own full-length
    // chains) are what carry level-1 branching, exactly as before this bole
    // existed.
    ctx.queue.pop();
  }
  const boleT = boleSegments / curveRes;
  for (let i = 0; i < leaders; i++) {
    const lean = leaders > 1 ? .06 + random() * .05 : 0;
    const a = spin + i * (Math.PI * 2 / leaders) + (random() - .5) * .3;
    const dir = leaders > 1 ? V(Math.sin(a) * lean, 1, Math.cos(a) * lean).normalize() : V(0, 1, 0);
    let axis = V(1, 0, 0).cross(dir);
    if (axis.lengthSq() < .25) axis = V(0, 0, 1).cross(dir);
    axis.normalize().applyAxisAngle(dir, random() * Math.PI * 2);
    growStem(ctx, {
      preset, order: 0, parentId: boleParentId, direction: dir, tStart: boleT, segments: curveRes - boleSegments, curveRes,
      r0: radius0, axis, stemStartDir: dir.clone(), isTrunk: true, ownLength: trunkLength, fullLength: trunkLength,
    });
  }

  // Drain the queue breadth-first (see `growStem`'s header): every order-0
  // record is already queued above; processing it appends order-1 records
  // at the tail, which only get their turn once every order-0 record (and,
  // by the same argument at every depth, every shallower order) has run.
  for (let cursor = 0; cursor < ctx.queue.length; cursor++) {
    const record = ctx.queue[cursor];
    const added = attachChildren(ctx, record);
    if (!added) ctx.tips.push(record.tipCandidate);
  }

  // A species whose trunk itself forks (`baseSplits`/`segSplits` at order 0,
  // e.g. Black Oak) legitimately produces many order-0 "stems" rather than
  // one; the renderer's own triangle budget (`foliageGeometry.js`) decides
  // what actually draws at a given LOD by walking branches THICKEST FIRST,
  // so that selection is only correct if the thickest ones sort first here.
  ctx.branches.sort((a, b) => b.radius - a.radius || a.order - b.order);

  // Crown-base lift: raises the height above which branches are permitted to
  // start, i.e. where the visible canopy begins — the monotone crown-lift the
  // old space-colonization skeleton implemented with a coordinate warp is no
  // longer needed because `attachChildren`'s own `tMin` already does this.

  // Rescale the whole raw skeleton (still in "paper units") so its bounding
  // height matches the authored `height` exactly; width comes out of the
  // formulas above (via `widthMultiplier` and the shape-ratio blend), not a
  // second independent rescale, so it is not re-normalized here.
  // The TRUNK defines "height", not whichever branch happens to curve the
  // highest — an order-2 twig with a lucky upward curveV can outreach the
  // leader itself, and rescaling to that outlier left the actual trunk apex
  // short of the authored height (a pine reading as headless).
  let rawHeight = 0;
  for (const node of ctx.nodes) if (node.order === 0) rawHeight = Math.max(rawHeight, node.position.y);
  if (rawHeight <= 1e-4) for (const node of ctx.nodes) rawHeight = Math.max(rawHeight, node.position.y);
  const heightScale = height / Math.max(1e-4, rawHeight);
  for (const node of ctx.nodes) { node.position.multiplyScalar(heightScale); node.radius *= heightScale; node.renderPosition = node.position.clone(); }

  // Hard crown-radius guarantee: `width`'s multiplier above, per-order length
  // formulas, downAngle and curvature all interact too much to bound the
  // result analytically up front, so measure the ACTUAL raw crown and, if it
  // exceeds a real tree's own proportions, pull every node's horizontal
  // offset inward uniformly (never its height) until it doesn't. A real
  // broadleaf crown is usually wider than it is tall but rarely more than
  // ~1.1x its height in RADIUS; a conifer's conical crown is much narrower.
  // This is what turned "extremely long, thin, nearly straight limbs
  // reaching far sideways" into a bounded, still fully organic silhouette —
  // the shrink is uniform, so curvature/taper/attachment all survive exactly,
  // only the overall reach changes.
  const conifer = isNeedleSpecies(species);
  // Conifer target: a real spire's crown WIDTH (diameter) runs 0.35-0.5x its
  // height — the previous 0.30 radius (0.6 diameter) let Pine's own natural
  // growth reach the cap itself instead of landing inside that band.
  const maxRadiusRatio = conifer ? 0.30 : 0.55;
  const radiusLimit = height * maxRadiusRatio;
  let crownRadius = 0, crownMinY = height, crownMaxY = 0;
  for (const node of ctx.nodes) {
    crownRadius = Math.max(crownRadius, Math.hypot(node.position.x, node.position.z));
    if (node.order > 0) { crownMinY = Math.min(crownMinY, node.position.y); crownMaxY = Math.max(crownMaxY, node.position.y); }
  }
  if (crownRadius > radiusLimit && crownRadius > 1e-6) {
    const shrink = radiusLimit / crownRadius;
    for (const node of ctx.nodes) { node.position.x *= shrink; node.position.z *= shrink; node.renderPosition = node.position.clone(); }
    crownRadius = radiusLimit;
  }
  if (crownMaxY < crownMinY) { crownMinY = height * ctx.baseSize; crownMaxY = height; } // no order>0 nodes at all (bald tree)

  // Twig-tip containment: the crown guarantee above is a uniform XZ radius
  // clamp plus a separate min/max Y — a bounding CYLINDER, not the ELLIPSOID
  // `foliageGeometry.js`'s own leaf-normal bend already treats the crown as.
  // A last-level twig tip can sit at the clamped radius AND near the very
  // top/bottom of the canopy at once — inside the cylinder, but well outside
  // the ellipsoid corner-cuts there — which is exactly the "long thin bare
  // twig poking out beyond the foliage all round the crown" an owner's
  // review reported. Retract (never grow) any such TIP — a node
  // `attachChildren` never gave further children, i.e. exactly the
  // leaf-bearing ends leaf cards actually attach to (see
  // `foliageGeometry.js`'s terminal-segment leaf bias) — radially in the same
  // normalized ellipsoid space back to just inside 1x, so the card that caps
  // it still lands on real bark and no twig can reach past the mass it grows
  // leaves on.
  const envelopeRadiusXZ = Math.max(crownRadius, height * 0.05);
  const envelopeCenterY = (crownMinY + crownMaxY) / 2;
  const envelopeRadiusY = Math.max((crownMaxY - crownMinY) / 2, crownRadius * 0.5);
  for (const tipId of ctx.tips) {
    const node = ctx.nodes[tipId];
    const nx = node.position.x / envelopeRadiusXZ, ny = (node.position.y - envelopeCenterY) / envelopeRadiusY, nz = node.position.z / envelopeRadiusXZ;
    const dist = Math.hypot(nx, ny, nz);
    if (dist > 1.05 && dist > 1e-6) {
      const pull = 1 / dist;
      node.position.set(nx * pull * envelopeRadiusXZ, ny * pull * envelopeRadiusY + envelopeCenterY, nz * pull * envelopeRadiusXZ);
      node.renderPosition = node.position.clone();
    }
  }

  // Intended-crown-radius envelope (broadleaf only), run LAST — after the
  // crown radius clamp and twig-tip containment above have already taken
  // their own pass at every node — so nothing downstream can move a node
  // this step measured or already touched.
  //
  // A MEDIAN-of-whatever-grew envelope (the first attempt here) fixed the
  // one outlying limb an owner's review found, but pulled the whole crown
  // toward whatever the population's OWN grown limbs happened to cluster
  // around — on a seed where most limbs came out short, that median was
  // short too, and the result was a narrow column (oak-wide/oak-elder) or a
  // flame (accent), not a real fix. The envelope must instead be the
  // species' own INTENDED crown radius — derived from the authored
  // `width`/`crownSpread`, independent of what any particular seed's limbs
  // happened to grow to — and limbs are pulled to sit AT that radius from
  // both directions: an outlier beyond 1.2x it is shortened down to it, and
  // a genuinely short DOMINANT limb (one of the tree's own main scaffold
  // reaches, not a minor twig) is lengthened UP to it, bounded by the
  // absolute 0.55x-height limb-length cap already enforced at generation
  // time. Limbs well short of the dominant cluster are left alone — a real
  // crown has many limbs shorter than its own envelope, not every limb
  // touching it.
  //
  // The `* 1.35` constant and clamp band below were fit against the exact
  // ratios an owner measured on the current `oak`/`birch` species tables and
  // `valleyEcology.js`'s own authored width/crownSpread per population
  // (oak-wide/oak-elder/accent/birch-tall/hazel-study/young-growth): the
  // raw `authoredWidth * crownSpread / height` ratio alone undershoots real
  // full-grown broadleaf trees by roughly a third (branches never reach
  // literally to the authored "width" box edge) and overshoots small
  // shrub-scale populations authored at a naturally squat aspect already
  // (hazel-study), so the same formula needs both the multiplier and the
  // upper clamp to land every population in its own real-world band.
  let finalCrownRadius = crownRadius, finalMinY = crownMinY, finalMaxY = crownMaxY;
  // `shrub`'s own low, densely-forking habit (see `resolveBaseSize`) is not
  // the "dome on a clear trunk" shape this envelope targets, and none of the
  // coordinator's own target bands name it — only `hazel-study`/
  // `young-growth`, which are small-scale `oak`/`birch` populations, not the
  // literal `shrub` species.
  if (!isNeedleSpecies(species) && species !== "shrub") {
    const intendedDiameterRatio = clamp(authoredWidth * shape.crownSpread / height * 1.3, 0.3, 1.35);
    const intendedCrownRadius = height * intendedDiameterRatio * 0.5;
    // The grouping key is the LIMB's own first order-1 node (whose PARENT is
    // order-0) — not that order-0 parent itself. Several sibling limbs
    // routinely share one exact trunk attachment node (candidate positions
    // that land within `anchorAt`'s snap tolerance of an existing node reuse
    // it rather than minting a new stub), and keying by the shared parent
    // would group every one of THEM plus all their descendants into a single
    // "limb" — one real outlier then dragging its many well-behaved siblings
    // down with it, shrinking most of the crown instead of the one limb.
    const limbRootCache = new Map();
    const limbRootOf = id => {
      if (limbRootCache.has(id)) return limbRootCache.get(id);
      const node = ctx.nodes[id];
      let result = -1;
      if (node.order >= 1 && node.parent >= 0) {
        const parent = ctx.nodes[node.parent];
        result = parent.order === 0 ? id : limbRootOf(node.parent);
      }
      limbRootCache.set(id, result);
      return result;
    };
    const limbNodeIds = new Map();
    for (const node of ctx.nodes) {
      if (node.order < 1) continue;
      const root = limbRootOf(node.id);
      if (root < 0) continue;
      if (!limbNodeIds.has(root)) limbNodeIds.set(root, []);
      limbNodeIds.get(root).push(node.id);
    }
    const tipRadiusOf = ids => {
      let radius = 0;
      for (const id of ids) { const node = ctx.nodes[id]; if (node.order === 1) radius = Math.max(radius, Math.hypot(node.position.x, node.position.z)); }
      return radius;
    };
    // Arc length from the limb's own trunk attachment to its farthest
    // order-1 node — the same quantity the absolute level-1 length cap
    // (`attachChildren`'s `ctx.trunkLength * 0.55`) bounds at generation
    // time — so growing a limb never manufactures a limb longer than that
    // cap would ever have allowed to grow in the first place.
    const arcLengthOf = (root, ids) => {
      const attach = ctx.nodes[ctx.nodes[root].parent].position;
      const distFromAttach = new Map([[root, ctx.nodes[root].position.distanceTo(attach)]]);
      const queue = [root];
      let maxDist = distFromAttach.get(root);
      const idSet = new Set(ids);
      while (queue.length) {
        const cur = queue.shift();
        for (const childId of ctx.nodes[cur].children) {
          if (ctx.nodes[childId].order !== 1 || !idSet.has(childId)) continue;
          const d = distFromAttach.get(cur) + ctx.nodes[childId].position.distanceTo(ctx.nodes[cur].position);
          distFromAttach.set(childId, d);
          queue.push(childId);
          if (d > maxDist) maxDist = d;
        }
      }
      return maxDist;
    };
    // Rescale a limb's whole subtree (itself plus every descendant) about
    // its own trunk attachment point, never just its outermost twig — so a
    // limb outside the envelope is actually a different length, not merely
    // re-foliated. `scale` may be < 1 (shrink an outlier) or > 1 (grow a
    // short dominant limb toward the envelope).
    const rescaleLimb = (root, ids, scale) => {
      const anchor = ctx.nodes[ctx.nodes[root].parent].position.clone();
      // A limb whose ATTACHMENT itself already sits off the axis (a
      // strongly leaning/curved trunk, e.g. Weeping Willow, well above its
      // own straight base) has no SHRINK about that anchor alone that can
      // ever pull the limb's axis-radius below the anchor's OWN axis-
      // radius. Blend a direct pull toward the trunk AXIS itself in on top
      // of the anchor-relative shrink for exactly that case; only relevant
      // when shrinking (`scale < 1`) — growth never needs it.
      let axisBlend = 0;
      if (scale < 1) {
        const anchorAxisRadius = Math.hypot(anchor.x, anchor.z);
        const target = tipRadiusOf(ids) * scale;
        if (anchorAxisRadius > target) axisBlend = clamp(1 - target / anchorAxisRadius, 0, 1);
      }
      for (const id of ids) {
        const node = ctx.nodes[id];
        // Compute the offset BEFORE touching `node.position` — `.copy(anchor)`
        // first would overwrite it in place, so cloning it afterward for the
        // offset returns a zero vector every time (every rescaled node then
        // collapses onto its own anchor point exactly, regardless of scale).
        const offset = node.position.clone().sub(anchor).multiplyScalar(scale);
        node.position.copy(anchor).add(offset);
        if (axisBlend > 0) { node.position.x *= (1 - axisBlend); node.position.z *= (1 - axisBlend); }
        // Only SHRINKING a limb's radius is safe unconditionally (every
        // node in `ids` shrinks by the same factor, so parent >= child stays
        // true relative to the unscaled order-0 attachment outside `ids`).
        // GROWING would scale a node's radius past its own (unscaled)
        // parent when that parent sits outside `ids` — the tube-taper
        // invariant `branchTube` depends on — so leave radius alone when
        // lengthening a limb; the reposition alone is what fixes the crown
        // width the test measures.
        if (scale < 1) node.radius *= scale;
        node.renderPosition = node.position.clone();
      }
    };
    if (intendedCrownRadius > height * 0.02) {
      let currentMax = 0;
      for (const ids of limbNodeIds.values()) currentMax = Math.max(currentMax, tipRadiusOf(ids));
      const dominantThreshold = currentMax * 0.5;
      for (const [root, ids] of limbNodeIds) {
        const radius = tipRadiusOf(ids);
        if (radius <= 1e-6) continue;
        if (radius > intendedCrownRadius * 1.2) {
          // Outlier: shorten it down to the envelope, regardless of whether
          // it happens to be a dominant limb or not — an owner's review
          // found exactly this, "one thick limb sweeping ~4m out to the
          // side, far outside the crown mass" on an otherwise normal oak.
          rescaleLimb(root, ids, intendedCrownRadius / radius);
        } else if (radius >= dominantThreshold && radius < intendedCrownRadius) {
          // A dominant scaffold limb (one of the tree's own main reaches,
          // not a minor twig) that fell short of the intended crown: grow
          // it toward the envelope instead of leaving the whole crown
          // undersized — bounded by the absolute per-limb length cap so
          // growth never manufactures a limb longer than generation itself
          // would ever have allowed.
          let scale = intendedCrownRadius / radius;
          const arcLength = arcLengthOf(root, ids);
          const maxScale = arcLength > 1e-6 ? (height * 0.55) / arcLength : 1;
          scale = Math.min(scale, Math.max(1, maxScale));
          if (scale > 1.001) rescaleLimb(root, ids, scale);
        }
        // Everything else (a genuinely minor limb, well short of the
        // dominant cluster) is left alone — a real crown has many limbs
        // shorter than its own envelope, not every limb touching it.
      }
      // Backstop: the per-limb check above only measures each limb's own
      // LEVEL-1 reach, but a deeper (order-2+) twig can curve out past its
      // own level-1 parent's radius without that parent itself ever
      // crossing the 1.2x outlier line — Birch's own natural curvature does
      // exactly this. Pull any node (any order) still beyond the outer
      // bound uniformly toward the axis; a uniform XZ scale preserves every
      // limb's own relative shape and curvature exactly, only the overall
      // reach changes, same as the flat crown-radius guarantee above.
      let outerRadius = 0;
      for (const node of ctx.nodes) outerRadius = Math.max(outerRadius, Math.hypot(node.position.x, node.position.z));
      // Tighter than the 1.2x per-limb outlier line above: this backstop
      // only fires when a deeper twig, not any whole limb, pushed the
      // aggregate crown reach past its own limb's own already-compliant
      // level-1 radius, so it should not need as much slack.
      const outerLimit = intendedCrownRadius * 1.1;
      if (outerRadius > outerLimit && outerRadius > 1e-6) {
        const shrink = outerLimit / outerRadius;
        for (const node of ctx.nodes) { node.position.x *= shrink; node.position.z *= shrink; node.renderPosition = node.position.clone(); }
      }
    }
    finalCrownRadius = 0; finalMinY = height; finalMaxY = 0;
    for (const node of ctx.nodes) {
      finalCrownRadius = Math.max(finalCrownRadius, Math.hypot(node.position.x, node.position.z));
      if (node.order > 0) { finalMinY = Math.min(finalMinY, node.position.y); finalMaxY = Math.max(finalMaxY, node.position.y); }
    }
    if (finalMaxY < finalMinY) { finalMinY = height * ctx.baseSize; finalMaxY = height; }
    // Rescaling limbs (either direction) changes the crown's own overall
    // extent too, which shifts the ellipsoid `foliageGeometry.js`'s
    // twig-tip containment (above) measured every tip against — a tip that
    // was already safely inside the OLD bound can end up reading as outside
    // the new one purely because the reference moved, not because the tip
    // itself did. Re-run the exact same containment pass once more against
    // the now-final bound so that invariant still holds.
    const finalRadiusXZ = Math.max(finalCrownRadius, height * 0.05);
    const finalCenterY = (finalMinY + finalMaxY) / 2;
    const finalRadiusY = Math.max((finalMaxY - finalMinY) / 2, finalCrownRadius * 0.5);
    for (const tipId of ctx.tips) {
      const node = ctx.nodes[tipId];
      const nx = node.position.x / finalRadiusXZ, ny = (node.position.y - finalCenterY) / finalRadiusY, nz = node.position.z / finalRadiusXZ;
      const dist = Math.hypot(nx, ny, nz);
      if (dist > 1.05 && dist > 1e-6) {
        const pull = 1 / dist;
        node.position.set(nx * pull * finalRadiusXZ, ny * pull * finalRadiusY + finalCenterY, nz * pull * finalRadiusXZ);
        node.renderPosition = node.position.clone();
      }
    }
  }

  const branchCount = ctx.branches.filter(b => b.order === 1).length;
  const result = {
    species, height, width: authoredWidth * shape.crownSpread, authoredWidth,
    shape: { branchDensity: shape.branchDensity, crownBase: shape.crownBase, crownSpread: shape.crownSpread },
    seed: seed >>> 0, nodes: ctx.nodes, branches: ctx.branches, tips: ctx.tips,
    lobes: preset.lobes, lobeDepth: preset.lobeDepth,
    // Crown ellipsoid used both to soften leaf-card shading normals
    // (`foliageGeometry.js`) and, above, to retract any outlying twig tip:
    // the actual silhouette is whatever the (now radius-clamped, tip-
    // contained) skeleton itself produced.
    crown: { radius: Math.max(finalCrownRadius, height * 0.05), minY: finalMinY, maxY: Math.max(finalMaxY, finalMinY + height * 0.05) },
    stats: { nodes: ctx.nodes.length, branches: ctx.branches.length, tips: ctx.tips.length, level1Branches: branchCount, maxOrder: ctx.maxOrder },
    algorithm: "Weber-Penn (1995) parametric stems; pruning omitted",
  };
  cache.set(key, result);
  if (cache.size > TREE_GROWTH_LIMITS.cachedSkeletons) cache.delete(cache.keys().next().value);
  return result;
}

/**
 * The same Weber-Penn build, sliced across a wall-clock budget instead of
 * run to completion in one synchronous call. This is a plain generator (not
 * async) so a caller owns how it drains: `growTreeSkeleton` above drains it
 * immediately for every existing synchronous call site; a caller building
 * many prototypes back to back (`FoliageComponent`/`foliageWarmup.js`, which
 * already paces its own pipeline warms this way) can instead step it once
 * per ~4 ms slice, matching the engine's own budgeted-loop convention
 * (`src/engine/scheduling.js`'s `DEFAULT_SLICE_MS`, halved here because one
 * frame may need to slice several species/seeds rather than one long load).
 * `yield` hands back `{progress}` (a rough 0..1 estimate from the node
 * budget); the final `next()` returns `{done:true, value: skeleton}`.
 */
export function* growTreeSkeletonSteps(options = {}, sliceMs = 4) {
  const { species = "oak", height = 8, seed = 1 } = options;
  const authoredWidth = options.width ?? 6;
  const shape = resolveTreeShapeParameters(options);
  const key = `${species}:${height}:${authoredWidth}:${seed >>> 0}:${shape.branchDensity}:${shape.crownBase}:${shape.crownSpread}`;
  const cached = cache.get(key);
  if (cached) return cached;
  // The recursive builder above has no natural per-stem suspend point without
  // a much larger rewrite (every recursive call would need to be reified as
  // resumable state); a single tree is bounded by `TREE_GROWTH_LIMITS.nodes`
  // and finishes in low single-digit milliseconds, so the slice this
  // generator actually offers is BETWEEN trees/species, not within one:
  // build synchronously, then yield once so a caller building several
  // prototypes in a row (a scatter's per-species LODs, a preset sweep) can
  // still hand the thread back on the shared clock instead of doing all of
  // them in one frame.
  let start = typeof performance !== "undefined" ? performance.now() : Date.now();
  const result = growTreeSkeleton(options);
  const elapsed = (typeof performance !== "undefined" ? performance.now() : Date.now()) - start;
  if (elapsed >= sliceMs) yield { progress: 1 };
  return result;
}

export function clearTreeGrowthCache() { cache.clear(); }

/** Shallow trunk/limb/leaf animation hierarchy, shared by every geometric LOD.
 * Inspired by GPU Gems 3 chapter 6's joint/axis/stiffness model:
 * https://developer.nvidia.com/gpugems/gpugems3/part-i-geometry/chapter-6-gpu-generated-procedural-wind-animations-trees
 * This is a bounded visual approximation, not a per-frame physical solver. */
export function getTreeMotion(skeleton) {
  if (skeleton.motion) return skeleton.motion;
  const { nodes, height, species } = skeleton;
  const preset = getTreeSpeciesParams(species);
  const primary = new Int32Array(nodes.length); primary.fill(-1);
  const distance = new Float64Array(nodes.length), limbs = new Map();
  for (const node of nodes.slice(1)) {
    const parent = nodes[node.parent];
    primary[node.id] = primary[parent.id] >= 0 ? primary[parent.id] : node.order > 0 ? node.id : -1;
    const id = primary[node.id];
    if (id < 0) continue;
    let limb = limbs.get(id);
    if (!limb) {
      limb = { id, pivot: parent.renderPosition.clone(), axis: V(0, 1, 0), length: 0, reach: 0, radius: node.radius };
      limbs.set(id, limb);
    }
    distance[node.id] = (primary[parent.id] === id ? distance[parent.id] : 0) + node.renderPosition.distanceTo(parent.renderPosition);
    limb.length = Math.max(limb.length, distance[node.id]);
    const offset = node.renderPosition.clone().sub(limb.pivot), reach = offset.lengthSq();
    if (reach > limb.reach) { limb.reach = reach; limb.axis.copy(offset).normalize(); }
  }
  for (const limb of limbs.values()) {
    limb.flexibility = clamp(height * .008 / (limb.radius + height * .003) * Math.pow(limb.length / (height * .2), .6), .18, 1) * preset.windFlex;
  }
  const trunk = { id: -1, pivot: V(), axis: V(0, 1, 0), flexibility: 0 };
  const motion = nodes.map(node => {
    const limb = limbs.get(primary[node.id]) ?? trunk;
    const t = limb.id < 0 || limb.length <= 1e-9 ? 0 : Math.min(1, distance[node.id] / limb.length);
    return { limb: limb.id, pivot: limb.pivot, axis: limb.axis, flex: t * t * (3 - 2 * t) * limb.flexibility };
  });
  return skeleton.motion = { nodes: motion, limbs: [...limbs.values()] };
}
