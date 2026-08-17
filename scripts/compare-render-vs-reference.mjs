// CROSS-RENDERER COLOUR COMPARISON — ours vs a Cycles reference frame.
//
//   node scripts/compare-render-vs-reference.mjs
//   node scripts/compare-render-vs-reference.mjs --annotate    (write patch overlays)
//
// ══ THE PROBLEM WITH COMPARING TWO RENDERERS' PIXELS ════════════════════════
//
// Neither image is radiance. Both have been through a tone curve (AgX or Filmic),
// an exposure, and a display transform, and AgX in particular is a MATRIX plus a
// curve — it mixes channels, so an absolute R/G read off either screenshot is
// partly the curve. Comparing them directly would measure the difference between
// two colour pipelines, which is not the question.
//
// So this measures a RATIO OF RATIOS. Pick one patch that is dominated by DIRECT
// light — sunlit stone, whose appearance is albedo x sunlight and therefore
// nearly independent of the GI solution — and use it as the anchor. Then for
// every other patch report its warmth RELATIVE to that anchor, in each renderer
// separately. Exposure, white balance and the first-order shape of the tone curve
// divide out; what survives is how much warmer the INDIRECT-lit surfaces are than
// the DIRECT-lit reference, which is exactly the colour-bleed question.
//
// ⚠ THE PATCHES MUST LAND ON THE SAME MATERIAL IN BOTH IMAGES, and the two
// framings are not identical, so coordinates are given PER IMAGE rather than as
// shared fractions. `--annotate` writes an overlay of every patch so that
// assumption is checked by eye instead of assumed — a patch that slips onto a
// window frame or a plant produces a confident number about the wrong surface.
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import sharp from "sharp";

const OUT = ".gi-shots/compare";
mkdirSync(OUT, { recursive: true });

const REFERENCE = process.env.REF
  ?? "C:/Users/Khudiiash/OneDrive/Bilder/Screenshots/Знімок екрана 2026-08-17 143242.png";
const OURS = process.env.OURS ?? path.join(OUT, "ours.png");

// Patches as FRACTIONS of each image, so a capture at a different resolution
// still lands in the same place. { x, y } is the centre; { w, h } the size.
// `anchor: true` marks the direct-lit reference.
// ⚠ THE TWO FRAMINGS ARE NOT THE SAME AND CANNOT BE MADE THE SAME. Our capture
// comes out 810x359 (aspect 2.26) because the editor's viewport is a DOCKED PANEL
// inside the window, not the window — the reference is 2341x1389 (1.69). So the
// horizontal field of view differs and shared fractional coordinates land on
// different materials: the first run put `stone_right` on pale pink stone in the
// reference and on a dark red-brick building in ours, then reported a confident
// 1.048 ratio between them. Coordinates below were placed by EYE, per image,
// against `--annotate` output. Re-verify the overlays after any change.
//
// `wall_upper_left` was dropped: in the reference it overlaps Blender's own
// "User Perspective" HUD text, which is not part of the render.
const PATCHES = {
  reference: {
    sunlit_cobbles:  { x: 0.500, y: 0.885, w: 0.070, h: 0.045, anchor: true },
    shade_cobbles:   { x: 0.330, y: 0.700, w: 0.040, h: 0.025 },
    stone_right:     { x: 0.875, y: 0.210, w: 0.045, h: 0.060 },
    fascia_green:    { x: 0.325, y: 0.520, w: 0.030, h: 0.030 },
    awning_red:      { x: 0.500, y: 0.425, w: 0.045, h: 0.020 },
  },
  ours: {
    sunlit_cobbles:  { x: 0.509, y: 0.877, w: 0.055, h: 0.055, anchor: true },
    shade_cobbles:   { x: 0.370, y: 0.682, w: 0.035, h: 0.030 },
    stone_right:     { x: 0.667, y: 0.251, w: 0.035, h: 0.070 },
    fascia_green:    { x: 0.407, y: 0.543, w: 0.030, h: 0.045 },
    awning_red:      { x: 0.469, y: 0.446, w: 0.040, h: 0.025 },
  },
};

/** sRGB -> linear. The IEC transfer function, not a 2.2 power approximation:
 *  the toe matters for the shadowed patches, which is where the answer lives. */
const toLinear = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));

async function load(file) {
  const img = sharp(file).removeAlpha();
  const { width, height } = await img.metadata();
  const data = await img.raw().toBuffer();
  return { data, width, height };
}

function samplePatch(img, p) {
  const cx = Math.round(p.x * img.width);
  const cy = Math.round(p.y * img.height);
  const hw = Math.max(1, Math.round((p.w * img.width) / 2));
  const hh = Math.max(1, Math.round((p.h * img.height) / 2));
  const x0 = Math.max(0, cx - hw), x1 = Math.min(img.width - 1, cx + hw);
  const y0 = Math.max(0, cy - hh), y1 = Math.min(img.height - 1, cy + hh);
  let r = 0, g = 0, b = 0, n = 0, clipped = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * img.width + x) * 3;
      const sr = img.data[i] / 255, sg = img.data[i + 1] / 255, sb = img.data[i + 2] / 255;
      if (sr > 0.99 || sg > 0.99 || sb > 0.99) clipped++;
      r += toLinear(sr); g += toLinear(sg); b += toLinear(sb);
      n++;
    }
  }
  return { r: r / n, g: g / n, b: b / n, n, clippedPct: (100 * clipped) / n, box: [x0, y0, x1 - x0, y1 - y0] };
}

const images = { reference: await load(REFERENCE), ours: await load(OURS) };
console.log(`reference ${images.reference.width}x${images.reference.height}  ours ${images.ours.width}x${images.ours.height}`);

if (process.argv.includes("--annotate")) {
  for (const [which, img] of Object.entries(images)) {
    const rects = Object.entries(PATCHES[which]).map(([name, p], i) => {
      const s = samplePatch(img, p);
      const [x, y, w, h] = s.box;
      const colour = p.anchor ? "#00ff00" : "#ff00ff";
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${colour}" stroke-width="4"/>` +
        `<text x="${x}" y="${Math.max(18, y - 8)}" font-family="sans-serif" font-size="26" fill="${colour}">${i}:${name}</text>`;
    }).join("");
    const svg = `<svg width="${img.width}" height="${img.height}">${rects}</svg>`;
    const file = path.join(OUT, `annotated-${which}.png`);
    await sharp(which === "reference" ? REFERENCE : OURS)
      .removeAlpha()
      .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
      .png()
      .toFile(file);
    console.log(`wrote ${file}`);
  }
}

// ── THE TABLE ──────────────────────────────────────────────────────────────
const rows = [];
const anchors = {};
for (const which of ["reference", "ours"]) {
  for (const [name, p] of Object.entries(PATCHES[which])) {
    if (p.anchor) anchors[which] = samplePatch(images[which], p);
  }
}
/** Warmth: red over blue on linear values. Monotonic in "how warm", and
 *  insensitive to the green channel, which carries most of the luminance and
 *  therefore most of the tone curve's effect. */
const warmth = (s) => s.r / Math.max(s.b, 1e-9);

console.log("\nWARMTH = linear R/B.  RELATIVE = patch warmth / this render's sunlit-stone anchor.");
console.log("(relative is exposure- and white-balance-invariant; absolute warmth is not comparable across renderers)\n");
console.log("patch                REFERENCE (Cycles)          OURS                        ratio");
console.log("                     warmth  relative  clip%     warmth  relative  clip%     ref/ours");
const names = Object.keys(PATCHES.reference);
for (const name of names) {
  const a = samplePatch(images.reference, PATCHES.reference[name]);
  const b = samplePatch(images.ours, PATCHES.ours[name]);
  const ra = warmth(a) / warmth(anchors.reference);
  const rb = warmth(b) / warmth(anchors.ours);
  rows.push({ name, ref: { ...a, warmth: warmth(a), rel: ra }, ours: { ...b, warmth: warmth(b), rel: rb }, ratio: ra / rb });
  console.log(
    `  ${name.padEnd(18)} ${warmth(a).toFixed(3).padStart(6)}  ${ra.toFixed(3).padStart(8)}  ${a.clippedPct.toFixed(0).padStart(4)}%     ` +
    `${warmth(b).toFixed(3).padStart(6)}  ${rb.toFixed(3).padStart(8)}  ${b.clippedPct.toFixed(0).padStart(4)}%     ` +
    `${(ra / rb).toFixed(3).padStart(7)}`,
  );
}

// ── CONTRAST, WHICH TURNED OUT TO MATTER MORE THAN WARMTH ──────────────────
//
// The warmth table above came back essentially NULL on the one patch pair whose
// placement is trustworthy in both framings (shaded pavement: 0.976 vs 0.951
// relative, a 2.6% difference). The eyeball impression that "the reference is
// warmer" is not supported there — so the difference the eye is reacting to is
// somewhere else, and the obvious candidate is that our shadows are too BRIGHT.
//
// That is what an over-strong uniform ambient does: it lifts every shadow, which
// flattens contrast AND desaturates by washing surface colour toward the ambient's
// own neutral. It would read as "less realistic" without any chroma being wrong,
// and it is exactly what a probe field whose hemisphere is 60% neutral sky at
// 1.00/1.00/1.00 would produce.
//
// SHADE / SUN is the ratio to look at. Both patches are the same material —
// cobblestone — one lit, one shadowed, so the ratio is the depth of the shadow and
// it divides out exposure entirely.
const lum = (s) => 0.2126 * s.r + 0.7152 * s.g + 0.0722 * s.b;
{
  const names2 = Object.keys(PATCHES.reference);
  console.log("\nLUMINANCE, relative to each render's own sunlit-stone anchor (exposure divides out):\n");
  console.log("patch                REFERENCE   OURS      ours/ref");
  for (const name of names2) {
    const a = lum(samplePatch(images.reference, PATCHES.reference[name]));
    const b = lum(samplePatch(images.ours, PATCHES.ours[name]));
    const ra = a / lum(anchors.reference);
    const rb = b / lum(anchors.ours);
    console.log(
      `  ${name.padEnd(18)} ${ra.toFixed(4).padStart(9)}   ${rb.toFixed(4).padStart(7)}   ${(rb / ra).toFixed(3).padStart(7)}`,
    );
  }
  const sa = lum(samplePatch(images.reference, PATCHES.reference.shade_cobbles)) / lum(anchors.reference);
  const sb = lum(samplePatch(images.ours, PATCHES.ours.shade_cobbles)) / lum(anchors.ours);
  console.log(
    `\nSHADOW DEPTH on the same material (shaded cobbles / sunlit cobbles):\n` +
    `  Cycles ${sa.toFixed(4)}   ours ${sb.toFixed(4)}   ->  our shadows are ${(sb / sa).toFixed(2)}× as bright\n` +
    (sb / sa > 1.3
      ? "  ⚑ OUR SHADOWS ARE TOO BRIGHT. That is the difference the eye is reading as\n" +
        "  'less realistic', not a chroma deficit — an over-strong neutral ambient lifts\n" +
        "  every shadow, which flattens contrast and washes surface colour toward grey.\n" +
        "  The lever is the sky/ambient level and the 60% neutral-sky miss rate, and it is\n" +
        "  a far cheaper fix than probe placement or an extra bounce.\n"
      : sb / sa < 0.77
        ? "  Our shadows are DEEPER than Cycles', i.e. we are losing indirect fill rather\n" +
          "  than adding too much. Suspect the bounce count or the sky term being too weak.\n"
        : "  Shadow depth matches within 30%. Neither chroma nor shadow depth explains the\n" +
          "  visual gap at these patches — look at texture/normal detail and the tone curve.\n"),
  );
}

// The verdict: the indirect-dominated patches are the ones that carry the answer.
const indirect = rows.filter((r) => !PATCHES.reference[r.name].anchor && r.name !== "awning_red");
const meanRatio = indirect.reduce((a, r) => a + r.ratio, 0) / Math.max(indirect.length, 1);
const clipWarn = rows.filter((r) => r.ref.clippedPct > 5 || r.ours.clippedPct > 5).map((r) => r.name);
console.log(
  `\nmean ref/ours relative warmth over the ${indirect.length} indirect-lit patches: ${meanRatio.toFixed(3)}×`,
);
if (clipWarn.length) {
  console.log(`⚠ CLIPPED PATCHES (>5% of pixels at 255) — their warmth is a ceiling, not a measurement: ${clipWarn.join(", ")}`);
}
console.log(
  meanRatio > 1.15
    ? `\nCycles' indirect-lit surfaces are ${meanRatio.toFixed(2)}× warmer than ours RELATIVE to the same\n` +
      "sunlit-stone anchor. The gap is real and it is in the indirect term, not in exposure.\n" +
      "That is a shortfall in surface-coloured bounce — each extra bounce multiplies by albedo\n" +
      "again, so chroma compounds, and a field dominated by neutral sky carries albedo^1 where\n" +
      "a path tracer carries albedo^2..3."
    : meanRatio < 0.87
      ? `\nOURS is ${(1 / meanRatio).toFixed(2)}× warmer than Cycles relative to the anchor — the opposite\n` +
        "of the reported symptom. Re-check the patch placement in the annotated overlays before\n" +
        "believing this."
      : "\nNo meaningful difference in relative warmth. If the renders still look different, the\n" +
        "difference is in LUMINANCE distribution or the tone curve, not in indirect chroma —\n" +
        "check the annotated overlays, then compare patch brightness rather than warmth.",
);

const file = path.join(OUT, "comparison.json");
writeFileSync(file, JSON.stringify({ reference: REFERENCE, ours: OURS, rows, meanRatio }, null, 2));
console.log(`\nwrote ${file}`);
