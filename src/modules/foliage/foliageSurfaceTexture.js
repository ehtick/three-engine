import * as THREE from "three/webgpu";

// Fixed per-species textures, shared by every seed, LOD and atlas capture.
// R = albedo multiplier, GB = tangent normal XY, A = actual leaf coverage.
// Leaves and bark are separate textures so mip filtering never blends them.
const cached = new Map();
const SIZE = 256;
const MIN_LEAF_MIP_TILE_SIZE = 8;
// Existing UVs select a tile; no per-leaf attributes or shader bindings.
// This 2x2/4-variant grid is the ORIGINAL shape and stays exact for `oak`,
// `birch` and `pine` — a runtime test deep-equals it and reads their atlas at
// this literal size. `foliageLeafVariantCount` below is the one every OTHER
// species (P1-A's added six plus the two paper broadleaves) actually reads,
// and gives them 8 tiles (2 columns x 4 rows) instead of 4.
export const FOLIAGE_LEAF_ATLAS = Object.freeze({ columns: 2, rows: 2, tileSize: SIZE, variants: 4 });
const LEGACY_LEAF_VARIANTS = Object.freeze({ oak: 4, birch: 4, pine: 4 });
export function foliageLeafVariantCount(species) { return LEGACY_LEAF_VARIANTS[species] ?? 8; }
// A card is a small connected branch system, not one oversized leaf. Keeping
// the physical contract beside the silhouettes prevents geometry and atlas
// changes from silently changing individual leaf scale. Kept exactly as
// shipped (a runtime test reads these two numerically) — see
// `FOLIAGE_LEAF_CARDS` below for the superset every species is read from.
export const FOLIAGE_BROADLEAF_CARDS = Object.freeze({
  oak: Object.freeze({ length: .84, width: .70, leaves: 42, leafLength: .105, leafWidth: .058, outline: "lobed" }),
  birch: Object.freeze({ length: .70, width: .58, leaves: 42, leafLength: .078, leafWidth: .052, outline: "ovate" }),
});
// P1-A's added species: four paper broadleaves reuse `oak`/`birch`'s ids, so
// only the six authored ones plus the two remaining paper trees are new here.
// `oak`/`birch` above are LOCKED (a runtime test reads their exact card and
// leaf-cluster numbers): fixing "leaves render as large flat single-colour
// blobs" for these six instead shrinks the CARD itself to a real twig-cluster
// footprint (0.25-0.4m — the size a live viewer actually reads as "a few
// leaves", not a canopy panel) and cuts the cluster to a handful of leaves
// (`leaves`, 6-8) that `makeSparseBroadleafVariant` below actually reads,
// rather than the six-shoot/42-leaf structure hardcoded for oak/birch.
const NEW_BROADLEAF_CARDS = Object.freeze({
  // Width is capped near .30: `leafSize`'s own ceiling (1.5) times
  // `CARD_RENDER_SCALE` (1.22, `foliageGeometry.js`) puts a card at
  // `width*1.83` in the worst case, and the brief's own ceiling is "never
  // above 0.55m" — .30*1.83 = .549, right at that limit. Pushed to (not past)
  // that ceiling, plus a 9-leaf cluster and more sites (`MAX_SITES` above),
  // is as much per-card and per-tree coverage as the 0.25-0.4m card-width
  // bound allows within the existing triangle budget.
  "black-tupelo": Object.freeze({ length: .38, width: .30, leaves: 9, leafLength: .10, leafWidth: .055, outline: "elliptic" }),
  "weeping-willow": Object.freeze({ length: .52, width: .26, leaves: 8, leafLength: .12, leafWidth: .028, outline: "lanceolate" }),
  maple: Object.freeze({ length: .30, width: .30, leaves: 9, leafLength: .105, leafWidth: .095, outline: "palmate" }),
  poplar: Object.freeze({ length: .35, width: .30, leaves: 9, leafLength: .072, leafWidth: .063, outline: "deltoid" }),
  shrub: Object.freeze({ length: .26, width: .23, leaves: 7, leafLength: .05, leafWidth: .032, outline: "ovate" }),
  hawthorn: Object.freeze({ length: .27, width: .25, leaves: 8, leafLength: .052, leafWidth: .036, outline: "lobed" }),
});
const NEEDLE_CARDS = Object.freeze({
  pine: Object.freeze({ length: .34, width: .32, leaves: 256, leafLength: .13 }),
  spruce: Object.freeze({ length: .24, width: .22, leaves: 300, leafLength: .075 }),
});
/** Every species' leaf/needle CARD physical template, in metres — the
 * superset `foliageGeometry.js` reads instead of `FOLIAGE_BROADLEAF_CARDS`
 * directly, so `oak`/`birch`'s locked numbers stay untouched while every
 * other species gets its own. */
export const FOLIAGE_LEAF_CARDS = Object.freeze({ ...FOLIAGE_BROADLEAF_CARDS, ...NEW_BROADLEAF_CARDS, ...NEEDLE_CARDS });
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const jitter = n => { const value = Math.sin(n * 127.1 + 311.7) * 43758.5453; return value - Math.floor(value); };

// Paired needles emerge together from irregular fascicles around a short
// shoot. These are radial tufts, not opposing rows of broadleaf-like leaflets.
// Young dense pine habit / paired needles are guided by Oregon State's
// Pinus nigra reference; the generated preset is not an exact species model.
function makePineVariant(variant, lengthScale = 1, needleCount = 128) {
const pineNeedles = [];
const shift = variant * 271;
const pineClusters = [{ x: .38, y: .19, scale: .90 }, { x: .61, y: .46, scale: 1 }, { x: .47, y: .74, scale: .84 }]
  .map((cluster, i) => ({ x: cluster.x + (jitter(shift + i + 5) - .5) * .11, y: cluster.y + (jitter(shift + i + 9) - .5) * .06, scale: cluster.scale }));
for (let i = 0; i < needleCount; i++) {
  // Three unequal, offset bud clusters leave short visible shoot sections.
  // Spreading every origin along one axis instead made their overlapping
  // bases look like a single opaque broadleaf blade in close-up views.
  const cluster = pineClusters[i % pineClusters.length];
  const y = cluster.y + (jitter(i + 37) - .5) * .055, x = cluster.x + (jitter(i + 57) - .5) * .045;
  for (let pair = 0; pair < 2; pair++) {
    const angle = i * 2.399963 + variant * .73 + jitter(i + shift + 1) * .45 + pair * (.07 + jitter(i + 2) * .09);
    let dx = Math.sin(angle) * .82, dy = .36 + Math.cos(angle) * .76;
    const length = (.20 + jitter(i * 3 + pair + 8) * .18) * cluster.scale * lengthScale, scale = length / Math.hypot(dx, dy);
    dx *= scale; dy *= scale;
    // Keep the alpha border empty; no cut-off needle becomes a square card.
    dx = Math.max(.025 - x, Math.min(.975 - x, dx));
    dy = Math.max(.025 - y, Math.min(.975 - y, dy));
    const actualLength = Math.hypot(dx, dy);
    pineNeedles.push({ x, y, dx, dy, inverseSquare: 1 / (actualLength * actualLength), inverseLength: 1 / actualLength, bend: (jitter(i + pair + 90) - .5) * .025, tint: jitter(i + 180) });
  }
}
return { needles: pineNeedles, clusters: pineClusters };
}
const pineVariants = Array.from({ length: foliageLeafVariantCount("pine") }, (_, variant) => makePineVariant(variant));
// Spruce: shorter, denser needles than pine, its own (larger) variant count.
const spruceVariants = Array.from({ length: foliageLeafVariantCount("spruce") }, (_, variant) => makePineVariant(variant, .62, 176));
const NEEDLE_VARIANTS = Object.freeze({ pine: pineVariants, spruce: spruceVariants });

function pineSpray(u, v, variant, species = "pine") {
  const { needles: pineNeedles, clusters: pineClusters } = NEEDLE_VARIANTS[species][variant];
  let alpha = (1 - smooth(.002, .004, Math.abs(u - .5))) * smooth(.025, .06, v) * (1 - smooth(.78, .83, v));
  for (const cluster of pineClusters) {
    const dx = cluster.x - .5, dy = .12, px = u - .5, py = v - cluster.y + dy;
    const t = (px * dx + py * dy) / (dx * dx + dy * dy);
    if (t > 0 && t < 1) alpha = Math.max(alpha, 1 - smooth(.0018, .0035, Math.abs(px * dy - py * dx) / Math.hypot(dx, dy)));
  }
  let albedo = .67, relief = .025 * alpha;
  for (const needle of pineNeedles) {
    const px = u - needle.x, py = v - needle.y;
    const t = (px * needle.dx + py * needle.dy) * needle.inverseSquare;
    if (t <= 0 || t >= 1) continue;
    const across = (px * needle.dy - py * needle.dx) * needle.inverseLength - needle.bend * 4 * t * (1 - t);
    const width = .0036 * (1 - t * .8), edge = Math.abs(across) / width;
    const coverage = (1 - smooth(width - .0009, width + .0009, Math.abs(across))) * (1 - smooth(.94, 1, t));
    if (coverage <= alpha) continue;
    alpha = coverage;
    albedo = .73 + needle.tint * .14 + t * .10 - Math.min(1, edge) * .09;
    relief = .10 * Math.max(0, 1 - edge * edge);
  }
  return [albedo, relief, alpha];
}

const twigX = (v, variant) => .5 + Math.sin(v * 2.9) * (variant % 2 ? -.065 : .065) + v * (variant - 1.5) * .013;
// A stable per-species seed offset so two species with the same variant index
// never sample the same jitter stream. `oak`/`birch` keep their exact
// original offsets (a locked runtime test reads their generated coverage);
// every added species gets one hashed from its own name.
const LEGACY_SEED_OFFSET = Object.freeze({ oak: 701, birch: 1301 });
const speciesSeedOffset = species => {
  if (LEGACY_SEED_OFFSET[species] != null) return LEGACY_SEED_OFFSET[species];
  let h = 0; for (let i = 0; i < species.length; i++) h = (h * 131 + species.charCodeAt(i)) >>> 0;
  return 1901 + (h % 9973);
};

/** Shared per-blade placement: rotate the shoot-direction vector to this
 * leaf's own angle, size it to the species' `leafLength`, shrink it (`fit`)
 * so it never spills past the tile's own gutter, and record it. Used by both
 * the locked oak/birch template (unchanged output) and the smaller clusters
 * below — extracted so both can share the exact same outline/fit/tint math
 * without duplicating it. */
function placeBlade(leaves, card, x, y, tx, ty, n, side, shoot, attachment) {
  const angle = side * (.64 + jitter(n + 1) * 1.02) + (jitter(n + 2) - .5) * .27;
  let dx = tx * Math.cos(angle) - ty * Math.sin(angle), dy = tx * Math.sin(angle) + ty * Math.cos(angle);
  const length = card.leafLength * (.73 + jitter(n + 3) * .27) / Math.hypot(dx, dy);
  dx *= length; dy *= length;
  // Leave room for the whole blade at the tile boundary. A shortened distal
  // leaf is preferable to a clipped rectangular edge in every tree instance.
  let fit = 1;
  for (const [origin, delta] of [[x, dx / card.width], [y, dy / card.length]]) {
    if (delta > 0) fit = Math.min(fit, (.945 - origin) / delta);
    else if (delta < 0) fit = Math.min(fit, (.055 - origin) / delta);
  }
  fit = Math.max(.45, Math.min(1, fit)); dx *= fit; dy *= fit;
  const actualLength = Math.hypot(dx, dy);
  leaves.push(Object.freeze({ x, y, dx, dy, inverseSquare: 1 / (actualLength * actualLength), inverseLength: 1 / actualLength,
    width: card.leafWidth * .5 * (.78 + jitter(n + 4) * .22) * fit,
    phase: jitter(n + 5), tint: jitter(n + 6), shoot, attachment }));
}

/** `oak`/`birch` — kept byte-identical (a runtime test in
 * `foliage-surface.test.mjs` reads their exact card size and 42-leaf, six-
 * shoot structure numerically). Six unequal lateral shoots grow from one
 * curved leader; alternate leaves turn independently around each shoot
 * instead of forming parallel fern rows. */
function makeLegacyBroadleafVariant(species, variant) {
  const card = FOLIAGE_LEAF_CARDS[species], leaves = [], shoots = [];
  const seed = variant * 271 + speciesSeedOffset(species);
  const starts = [.13, .24, .36, .47, .59, .70];
  for (let i = 0; i < starts.length; i++) {
    const side = (i + variant) % 2 ? 1 : -1, n = seed + i * 43;
    const y = starts[i] + (jitter(n + 1) - .5) * .045;
    shoots.push({ x: twigX(y, variant), y, dx: side * (.235 + jitter(n + 2) * .065), dy: .105 + jitter(n + 3) * .070 });
  }
  for (let shoot = 0; shoot < shoots.length; shoot++) {
    const branch = shoots[shoot], tx = branch.dx * card.width, ty = branch.dy * card.length;
    for (let i = 0; i < 6; i++) {
      const n = seed + shoot * 71 + i * 17, t = .10 + i * .155 + (jitter(n + 9) - .5) * .035;
      placeBlade(leaves, card, branch.x + branch.dx * t, branch.y + branch.dy * t, tx, ty, n, (i + shoot + variant) % 2 ? 1 : -1, shoot, t);
    }
  }
  for (let i = 0; i < 6; i++) {
    const n = seed + 701 + i * 31, y = .27 + i * .115 + (jitter(n) - .5) * .04;
    placeBlade(leaves, card, twigX(y, variant), y, (twigX(y + .01, variant) - twigX(y, variant)) * card.width,
      .01 * card.length, n, (i + variant) % 2 ? 1 : -1, -1, y);
  }
  return Object.freeze({ leaves: Object.freeze(leaves), shoots: Object.freeze(shoots.map(Object.freeze)) });
}

/** Every other broadleaf species: a genuine small CLUSTER (`card.leaves`, 5-9)
 * instead of the legacy 42-leaf mat — the physical card itself is also much
 * smaller now (`NEW_BROADLEAF_CARDS`, ~0.25-0.4m), so a handful of
 * individually-turned, overlapping blades with real gaps between them reads
 * as "a few leaves at a twig tip" instead of a dense, flat, single-colour
 * silhouette. One short two-shoot spray (rather than six) keeps each blade
 * large enough within the 256px tile to stay visually distinct. */
function makeSparseBroadleafVariant(species, variant) {
  const card = FOLIAGE_LEAF_CARDS[species], leaves = [], shoots = [];
  const seed = variant * 271 + speciesSeedOffset(species);
  const count = Math.max(5, Math.min(9, Math.round(card.leaves)));
  const shootCount = count >= 7 ? 2 : 1;
  for (let s = 0; s < shootCount; s++) {
    const side = (s + variant) % 2 ? 1 : -1, n = seed + s * 97;
    const y = .18 + s * .30 + (jitter(n + 1) - .5) * .05;
    shoots.push({ x: twigX(y, variant), y, dx: side * (.30 + jitter(n + 2) * .08), dy: .16 + jitter(n + 3) * .08 });
  }
  for (let i = 0; i < count; i++) {
    const shoot = i % shootCount, branch = shoots[shoot];
    const n = seed + shoot * 71 + i * 19, t = .16 + (i / count) * .74 + (jitter(n + 9) - .5) * .06;
    const tx = branch.dx * card.width, ty = branch.dy * card.length;
    placeBlade(leaves, card, branch.x + branch.dx * t, branch.y + branch.dy * t, tx, ty, n, (i + shoot + variant) % 2 ? 1 : -1, shoot, t);
  }
  return Object.freeze({ leaves: Object.freeze(leaves), shoots: Object.freeze(shoots.map(Object.freeze)) });
}

function makeBroadleafVariant(species, variant) {
  return species === "oak" || species === "birch"
    ? makeLegacyBroadleafVariant(species, variant) : makeSparseBroadleafVariant(species, variant);
}
const broadleafVariants = Object.fromEntries(Object.keys(FOLIAGE_LEAF_CARDS).filter(species => species !== "pine" && species !== "spruce")
  .map(species => [species, Array.from({ length: foliageLeafVariantCount(species) }, (_, variant) => makeBroadleafVariant(species, variant))]));

/** Read-only physical template used by the actual surface rasterizer. */
export function getFoliageBroadleafTemplate(species, variant = 0) {
  return broadleafVariants[species]?.[variant] ?? null;
}

/** Per-species blade silhouette, in the leaf's own (t: base->tip, across:
 * signed perpendicular) frame. `lobed` (oak/hawthorn) and `ovate`
 * (birch/aspen/shrub) are the original two, unchanged; `elliptic`
 * (black tupelo: smooth, entire margin), `lanceolate` (weeping willow: long
 * and narrow), `deltoid` (poplar: broadly triangular) and `palmate` (maple:
 * angular multi-pointed) are authored approximations at the same small
 * twig-cluster scale, not botanical tracings. */
function leafOutline(kind, t, side, blade) {
  switch (kind) {
    case "ovate":
      return Math.pow(Math.sin(Math.PI * Math.pow(t, .74)), .78) * (1 + .045 * Math.sin(t * 91 + side * .8));
    case "elliptic":
      return Math.pow(Math.sin(Math.PI * t), .55) * (1 + .02 * Math.sin(t * 40 + side * .5));
    case "lanceolate":
      return Math.pow(Math.sin(Math.PI * t), 1.15);
    case "deltoid": {
      const peak = .36;
      return t < peak ? .22 + .78 * (t / peak) : Math.max(0, 1 - (t - peak) / (1 - peak));
    }
    case "palmate": {
      const envelope = Math.sin(Math.PI * t) * .55;
      const teeth = Math.pow(Math.max(0, Math.sin(t * Math.PI * 5 + side * .6)), .3) * .6 * Math.sin(Math.PI * Math.min(1, t * 1.1));
      return Math.max(envelope, teeth);
    }
    case "lobed":
    default: {
      // Union of rounded lobes, rather than a sinusoidal saw-tooth edge that
      // looked like a tiny conifer silhouette when the broadleaf was rotated.
      let outline = .30 * Math.sin(Math.PI * t);
      const centres = [.20, .41, .63, .83], widths = [.63, .91, 1, .70];
      for (let lobe = 0; lobe < centres.length; lobe++) {
        const along = (t - centres[lobe] - side * (.012 + blade.phase * .020)) / .16;
        if (Math.abs(along) < 1) outline = Math.max(outline, widths[lobe] * Math.sqrt(1 - along * along));
      }
      return outline;
    }
  }
}
const OUTLINE_ANTIALIAS = Object.freeze({ ovate: .58, lanceolate: .5, elliptic: .62 });

function leafSpray(u, v, species, variant) {
  if (species === "pine" || species === "spruce") return pineSpray(u, v, variant, species);
  const card = FOLIAGE_LEAF_CARDS[species], template = broadleafVariants[species][variant], kind = card.outline;
  let alpha = (1 - smooth(.0018, .0038, Math.abs(u - twigX(v, variant)))) * smooth(.018, .045, v) * (1 - smooth(.89, .92, v));
  for (const shoot of template.shoots) {
    const dx = shoot.dx * card.width, dy = shoot.dy * card.length, px = (u - shoot.x) * card.width, py = (v - shoot.y) * card.length;
    const t = (px * dx + py * dy) / (dx * dx + dy * dy);
    if (t > 0 && t < 1) alpha = Math.max(alpha, 1 - smooth(.00065, .0018, Math.abs(px * dy - py * dx) / Math.hypot(dx, dy)));
  }
  let relief = .015 * alpha, albedo = .74;
  for (const blade of template.leaves) {
    const px = (u - blade.x) * card.width, py = (v - blade.y) * card.length;
    const t = (px * blade.dx + py * blade.dy) * blade.inverseSquare;
    if (t <= 0 || t >= 1) continue;
    const across = (px * blade.dy - py * blade.dx) * blade.inverseLength;
    const side = across < 0 ? -1 : 1;
    const outline = leafOutline(kind, t, side, blade);
    const width = blade.width * outline * (side < 0 ? .92 : 1);
    const antialias = (OUTLINE_ANTIALIAS[kind] ?? .70) / SIZE * .48;
    const coverage = 1 - smooth(width - antialias, width + antialias, Math.abs(across));
    if (coverage <= alpha) continue;
    alpha = coverage;
    const edge = clamp01(Math.abs(across) / Math.max(.001, width));
    const vein = Math.exp(-Math.abs(across) * 1800);
    const fineVein = Math.pow(Math.max(0, Math.cos((t - Math.abs(across) * 14) * Math.PI * (kind === "ovate" ? 16 : 10))), 18);
    albedo = .82 + blade.tint * .10 + t * .04 + vein * .018 + fineVein * .012 - edge * .022;
    relief = .09 * (1 - edge * edge) + vein * .007 + fineVein * .003;
  }
  // Clear gutters keep an atlas tile from exposing its rectangular bounds.
  alpha *= smooth(.015, .026, u) * (1 - smooth(.974, .985, u)) * smooth(.012, .022, v) * (1 - smooth(.974, .985, v));
  return [albedo, relief, alpha];
}

/** `variant` picks between two bark patterns per species (a second growth
 * habit / bark age), not a second species; `variant: 0` is byte-identical to
 * the original single pattern. */
function bark(u, v, species, variant = 0) {
  const shift = variant * 3.7, freqShift = variant * 6, fineShift = variant * 10;
  const wave = Math.sin(u * Math.PI * (24 + freqShift) + Math.sin(v * Math.PI * 2 + shift) * .6);
  const fine = Math.sin(u * Math.PI * (90 - fineShift) + Math.sin(v * Math.PI * 6 + shift) * 1.5);
  if (species === "birch") {
    const marks = Math.pow(Math.max(0, Math.sin(v * Math.PI * (28 - freqShift) + Math.sin(u * Math.PI * 2 + shift) * 1.7)), 18)
      * Math.pow(Math.max(0, Math.sin(u * Math.PI * (10 + freqShift * .5) + Math.sin(v * Math.PI * 4 + shift))), 2);
    return [.9 - marks * .63 + fine * .015, fine * .012 - marks * .025, 1];
  }
  const groove = Math.pow(.5 + wave * .5, 5);
  return [.66 + wave * .1 + fine * .045 - groove * .16, wave * .055 + fine * .017 - groove * .045, 1];
}

function coverage(data, width, minX = 0, minY = 0, size = width, threshold = 128) {
  let hits = 0;
  for (let y = minY; y < minY + size; y++) for (let x = minX; x < minX + size; x++) {
    if (data[(y * width + x) * 4 + 3] >= threshold) hits++;
  }
  return hits / (size * size);
}

/** Preserve alpha-test coverage while minifying; averaging alone erases
 * needles. `tileColumns`/`tileRows` need not be equal — an 8-variant leaf
 * atlas is 2 columns x 4 rows, not square — but every tile itself is, and
 * both axes shrink together, so the whole image stays proportional. */
function makeMipmaps(base, preserveCoverage, tileColumns = 1, tileRows = tileColumns, preserveFilteredCore = false) {
  const mipmaps = [base];
  const targets = Array.from({ length: tileColumns * tileRows }, (_, tile) => coverage(base.data, base.width,
    tile % tileColumns * base.width / tileColumns, Math.floor(tile / tileColumns) * base.height / tileRows, base.width / tileColumns));
  let source = base;
  // A single texel cannot represent a twig's sparse alpha-test silhouette:
  // rounding ~20% occupancy to zero erased every leaf during 64px tree bakes.
  // Keep a small cutout as the terminal mip instead of choosing transparent
  // or completely opaque tiles. Three allocates only this explicit mip chain,
  // so ordinary sampler LOD clamping also covers extreme minification.
  const minimumWidth = preserveCoverage ? tileColumns * MIN_LEAF_MIP_TILE_SIZE : 1;
  while (source.width > minimumWidth) {
    const width = source.width / 2, height = source.height / 2, data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < 4; c++) {
      const a = ((y * 2) * source.width + x * 2) * 4 + c;
      data[(y * width + x) * 4 + c] = Math.round((source.data[a] + source.data[a + 4] + source.data[a + source.width * 4] + source.data[a + source.width * 4 + 4]) / 4);
    }
    if (preserveCoverage && width >= tileColumns) {
      // Find a threshold with the closest representable pixel coverage, then
      // scale around it. A 1x1 mip cannot encode partial cutout occupancy.
      // Correct each variant independently. A dense tile must not steal a
      // sparse tile's alpha coverage as the atlas minifies.
      const size = width / tileColumns;
      for (let tile = 0; tile < tileColumns * tileRows; tile++) {
        const minX = tile % tileColumns * size, minY = Math.floor(tile / tileColumns) * size, alphas = [];
        // The coarsest surviving tiles still need a transparent gutter;
        // atlas filtering must not invent rectangular opaque card borders.
        for (let edge = 0; edge < size; edge++) {
          for (const [x, y] of [[minX + edge, minY], [minX + edge, minY + size - 1],
            [minX, minY + edge], [minX + size - 1, minY + edge]]) data[(y * width + x) * 4 + 3] = 0;
        }
        for (let y = minY; y < minY + size; y++) for (let x = minX; x < minX + size; x++) alphas.push(data[(y * width + x) * 4 + 3]);
        alphas.sort((a, b) => b - a);
        const wanted = Math.round(targets[tile] * alphas.length);
        const threshold = Math.max(1, ((alphas[wanted - 1] ?? 255) + (alphas[wanted] ?? 0)) * .5);
        const scale = wanted > 0 ? 128 / threshold : 0;
        for (let y = minY; y < minY + size; y++) for (let x = minX; x < minX + size; x++) {
          const index = (y * width + x) * 4 + 3;
          data[index] = Math.min(255, Math.round(data[index] * scale));
          // Dense small-leaf clusters distribute coverage over many texels
          // close to the cutout threshold. Preserve opaque cores at the final
          // two levels so bilinear sampling cannot erase an otherwise valid
          // point-sampled silhouette. Its occupied texels and gutters stay put.
          if (preserveFilteredCore && size <= 16 && data[index] >= 128) {
            data[index] = Math.round(192 + (data[index] - 128) * 63 / 127);
          }
        }
      }
    }
    source = { data, width, height };
    mipmaps.push(source);
  }
  return mipmaps;
}

/** Extend albedo/normal into transparent pixels inside EACH tile, without
 * changing coverage. Filtering a thin cutout against dark empty RGB creates
 * dark outlines and dull impostor captures even when alpha itself is correct. */
function padLeafTile(data, width, minX, minY) {
  const seen = new Uint8Array(SIZE * SIZE), queue = new Uint32Array(SIZE * SIZE);
  let head = 0, tail = 0;
  const indexOf = p => ((minY + Math.floor(p / SIZE)) * width + minX + p % SIZE) * 4;
  for (let p = 0; p < seen.length; p++) if (data[indexOf(p) + 3] >= 128) { seen[p] = 1; queue[tail++] = p; }
  while (head < tail) {
    const p = queue[head++], x = p % SIZE, y = Math.floor(p / SIZE), from = indexOf(p);
    for (const next of [x > 0 ? p - 1 : -1, x + 1 < SIZE ? p + 1 : -1, y > 0 ? p - SIZE : -1, y + 1 < SIZE ? p + SIZE : -1]) {
      if (next < 0 || seen[next]) continue;
      seen[next] = 1; queue[tail++] = next;
      const to = indexOf(next);
      data[to] = data[from]; data[to + 1] = data[from + 1]; data[to + 2] = data[from + 2];
    }
  }
}

function makeTexture(species, isBark, barkVariant = 0) {
  const columns = isBark ? 1 : FOLIAGE_LEAF_ATLAS.columns;
  const rows = isBark ? 1 : foliageLeafVariantCount(species) / columns;
  const width = SIZE * columns, height = SIZE * rows;
  const data = new Uint8Array(width * height * 4), relief = new Float32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = y * width + x;
    const sample = isBark ? bark((x + .5) / SIZE, (y + .5) / SIZE, species, barkVariant)
      : leafSpray((x % SIZE + .5) / SIZE, (y % SIZE + .5) / SIZE, species, Math.floor(y / SIZE) * columns + Math.floor(x / SIZE));
    data[index * 4] = Math.round(clamp01(sample[0]) * 255);
    data[index * 4 + 3] = Math.round(clamp01(sample[2]) * 255);
    relief[index] = sample[1];
  }
  const at = (x, y) => ((y + height) % height) * width + ((x + width) % width);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = (y * width + x) * 4;
    // Small perturbations keep broadleaf cards softly folded instead of
    // turning the alpha boundary into a raised, bevelled plastic badge.
    const adjacent = [at(x - 1, y), at(x + 1, y), at(x, y - 1), at(x, y + 1)];
    const inside = isBark || data[index + 3] >= 240 && adjacent.every(p => data[p * 4 + 3] >= 240);
    const strength = isBark ? 2.8 : 5;
    const dx = inside ? (relief[adjacent[0]] - relief[adjacent[1]]) * strength : 0;
    const dy = inside ? (relief[adjacent[2]] - relief[adjacent[3]]) * strength : 0;
    data[index + 1] = Math.round(clamp01(.5 + dx) * 255);
    data[index + 2] = Math.round(clamp01(.5 + dy) * 255);
  }
  if (!isBark) for (let row = 0; row < rows; row++) for (let col = 0; col < columns; col++) padLeafTile(data, width, col * SIZE, row * SIZE);
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
  texture.name = `Foliage ${species} ${isBark ? `bark${barkVariant ? " b" : ""}` : "twig variants"}`;
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = texture.wrapT = isBark ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.mipmaps = makeMipmaps({ data, width, height }, !isBark, columns, rows, !isBark && species !== "pine" && species !== "spruce");
  texture.needsUpdate = true;
  return texture;
}

const SUPPORTED_SPECIES = new Set(["oak", "birch", "pine", ...Object.keys(FOLIAGE_LEAF_CARDS)]);

/** `barkVariant` (0 or 1) picks between two bark patterns for the same
 * species — a second growth habit, not a second species — so a scatter of
 * the same tree does not read as visually identical bark everywhere.
 * `leaves` is unaffected by it and shared by both variants. */
export function getFoliageSurfaceTextures(species, barkVariant = 0) {
  if (!SUPPORTED_SPECIES.has(species)) return null;
  let entry = cached.get(species);
  if (!entry) {
    entry = { leaves: makeTexture(species, false), barks: [] };
    cached.set(species, entry);
  }
  const variant = barkVariant ? 1 : 0;
  entry.barks[variant] ??= makeTexture(species, true, variant);
  return { leaves: entry.leaves, bark: entry.barks[variant] };
}
