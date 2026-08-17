// PER-PIXEL COMPARISON — ours vs a Cycles render from the SAME camera and sun.
//
//   node scripts/compare-pixelwise.mjs
//   REF=path/to/ref.png OURS=.gi-shots/compare/ours.png node scripts/compare-pixelwise.mjs
//
// This replaces the hand-placed-patch comparison, which failed four times in a
// row and produced a confident wrong number every time: mismatched framings, an
// anchor patch that turned out to be in shadow in one image and sunlight in the
// other, a ratio divided by a four-sample bucket, and a red-surface filter that
// matched every warm-toned material in a warm-toned scene. All four were the same
// underlying mistake — asserting correspondence between two images instead of
// establishing it.
//
// With the cameras matched (position, orientation, vertical FOV) and the sun
// matched, correspondence is CONSTRUCTED rather than assumed, so every pixel can
// be compared to the pixel at the same address. Nothing here needs to know what
// material it is looking at.
//
// ⚠ ALIGNMENT IS STILL A HYPOTHESIS UNTIL IT IS LOOKED AT. The script writes a
// side-by-side and a 50/50 blend; if the blend is not sharp, the cameras do not
// actually agree and every number below is meaningless. Check that first.
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import sharp from "sharp";

const OUT = ".gi-shots/compare";
mkdirSync(OUT, { recursive: true });
const REF = process.env.REF ?? "C:/Users/Khudiiash/Downloads/ref.png";
const OURS = process.env.OURS ?? path.join(OUT, "ours.png");
// Both are resampled to this width. Downsampling averages out the renderers'
// different AA and Cycles' sampling noise, neither of which is the subject.
const W = Number(process.env.W ?? 960);

const toLinear = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const pctile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)))];

async function loadLinear(file, w, h) {
  const buf = await sharp(file).removeAlpha().resize(w, h, { fit: "fill" }).raw().toBuffer();
  const n = w * h;
  const R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    R[i] = toLinear(buf[i * 3] / 255);
    G[i] = toLinear(buf[i * 3 + 1] / 255);
    B[i] = toLinear(buf[i * 3 + 2] / 255);
  }
  return { R, G, B, w, h, n };
}

const refMeta = await sharp(REF).metadata();
const H = Math.round(W / (refMeta.width / refMeta.height));
console.log(`comparing at ${W}x${H}  (reference ${refMeta.width}x${refMeta.height})`);
const a = await loadLinear(REF, W, H);
const b = await loadLinear(OURS, W, H);

// ── ALIGNMENT AIDS, to be looked at before believing anything ───────────────
await sharp({ create: { width: W * 2, height: H, channels: 3, background: "#000" } })
  .composite([
    { input: await sharp(REF).resize(W, H, { fit: "fill" }).toBuffer(), left: 0, top: 0 },
    { input: await sharp(OURS).resize(W, H, { fit: "fill" }).toBuffer(), left: W, top: 0 },
  ]).png().toFile(path.join(OUT, "side-by-side.png"));
await sharp(await sharp(REF).resize(W, H, { fit: "fill" }).toBuffer())
  .composite([{ input: await sharp(OURS).resize(W, H, { fit: "fill" }).toBuffer(), blend: "over", opacity: 0.5 }])
  .png().toFile(path.join(OUT, "blend.png"));
console.log(`wrote ${OUT}/side-by-side.png and ${OUT}/blend.png — CHECK THE BLEND IS SHARP FIRST`);

// ── EXPOSURE, then everything else relative to it ───────────────────────────
let sa = 0, sb = 0;
for (let i = 0; i < a.n; i++) { sa += lum(a.R[i], a.G[i], a.B[i]); sb += lum(b.R[i], b.G[i], b.B[i]); }
const meanA = sa / a.n, meanB = sb / b.n;
console.log(`\nmean linear luminance:  reference ${meanA.toFixed(4)}   ours ${meanB.toFixed(4)}   (ours/ref ${(meanB / meanA).toFixed(3)}×)`);

// CONTRAST. Exposure divides out by normalizing each image by its own mean, so
// what is left is the SHAPE of the luminance distribution — which is where "ours
// looks washed out / flatter" would live if that is what is happening.
const la = new Float32Array(a.n), lb = new Float32Array(b.n);
for (let i = 0; i < a.n; i++) { la[i] = lum(a.R[i], a.G[i], a.B[i]) / meanA; lb[i] = lum(b.R[i], b.G[i], b.B[i]) / meanB; }
const sla = la.slice().sort(), slb = lb.slice().sort();
console.log("\nEXPOSURE-NORMALIZED LUMINANCE (each image divided by its own mean):");
console.log("             p5     p25    p50    p75    p95    p99");
for (const [name, s] of [["reference", sla], ["ours     ", slb]]) {
  console.log(
    `  ${name}  ${pctile(s, 0.05).toFixed(3)}  ${pctile(s, 0.25).toFixed(3)}  ${pctile(s, 0.50).toFixed(3)}  ` +
    `${pctile(s, 0.75).toFixed(3)}  ${pctile(s, 0.95).toFixed(3)}  ${pctile(s, 0.99).toFixed(3)}`,
  );
}
const drA = pctile(sla, 0.95) / Math.max(pctile(sla, 0.05), 1e-6);
const drB = pctile(slb, 0.95) / Math.max(pctile(slb, 0.05), 1e-6);
console.log(`  p95/p5 spread: reference ${drA.toFixed(1)}   ours ${drB.toFixed(1)}   -> ours is ${(drB / drA).toFixed(2)}× the contrast`);

// ── SATURATION AND WARMTH, per pixel ───────────────────────────────────────
// Saturation is scale-free, so exposure does not enter it at all — this is the
// cleanest cross-renderer chroma statistic available from tone-mapped images.
const satA = new Float32Array(a.n), satB = new Float32Array(b.n);
const wA = [], wB = [];
for (let i = 0; i < a.n; i++) {
  for (const [img, sat, warm] of [[a, satA, wA], [b, satB, wB]]) {
    const r = img.R[i], g = img.G[i], bl = img.B[i];
    const mx = Math.max(r, g, bl), mn = Math.min(r, g, bl);
    sat[i] = mx > 1e-6 ? (mx - mn) / mx : 0;
    // Warmth only where there is enough signal to have a colour at all;
    // near-black pixels have a ratio dominated by quantization.
    if (lum(r, g, bl) > 0.01) warm.push(r / Math.max(bl, 1e-6));
  }
}
const ssa = satA.slice().sort(), ssb = satB.slice().sort();
const swa = wA.sort((x, y) => x - y), swb = wB.sort((x, y) => x - y);
console.log("\nSATURATION (max-min)/max, per pixel — exposure-invariant:");
console.log(`  reference  p50 ${pctile(ssa, 0.5).toFixed(4)}  p90 ${pctile(ssa, 0.9).toFixed(4)}  mean ${(ssa.reduce((x, y) => x + y, 0) / ssa.length).toFixed(4)}`);
console.log(`  ours       p50 ${pctile(ssb, 0.5).toFixed(4)}  p90 ${pctile(ssb, 0.9).toFixed(4)}  mean ${(ssb.reduce((x, y) => x + y, 0) / ssb.length).toFixed(4)}`);
console.log("\nWARMTH linear R/B, pixels above 1% luminance:");
console.log(`  reference  p50 ${pctile(swa, 0.5).toFixed(4)}  p10 ${pctile(swa, 0.1).toFixed(4)}  p90 ${pctile(swa, 0.9).toFixed(4)}  (n=${swa.length})`);
console.log(`  ours       p50 ${pctile(swb, 0.5).toFixed(4)}  p10 ${pctile(swb, 0.1).toFixed(4)}  p90 ${pctile(swb, 0.9).toFixed(4)}  (n=${swb.length})`);

// ── WHERE WE ARE DARKEST RELATIVE TO THE REFERENCE ─────────────────────────
// One false-colour map: red where ours is darker than the reference (after
// exposure normalization), blue where brighter. If the indirect fill is the
// problem it shows up as red concentrated in the shadowed regions rather than
// spread evenly, which a single ratio cannot tell you.
const vis = Buffer.alloc(a.n * 3);
let darker = 0, brighter = 0;
for (let i = 0; i < a.n; i++) {
  const ratio = (lb[i] + 1e-4) / (la[i] + 1e-4);
  const t = Math.max(-1, Math.min(1, Math.log2(ratio)));
  if (t < -0.2) darker++; else if (t > 0.2) brighter++;
  const grey = Math.round(255 * Math.min(1, Math.pow(la[i] * 0.25, 1 / 2.2)));
  vis[i * 3] = t < 0 ? Math.round(255 * -t) : grey >> 1;
  vis[i * 3 + 1] = grey >> 1;
  vis[i * 3 + 2] = t > 0 ? Math.round(255 * t) : grey >> 1;
}
await sharp(vis, { raw: { width: W, height: H, channels: 3 } })
  .png().toFile(path.join(OUT, "luminance-diff.png"));
console.log(
  `\nwrote ${OUT}/luminance-diff.png — RED where ours is darker than the reference, BLUE where brighter\n` +
  `  ${((100 * darker) / a.n).toFixed(1)}% of pixels >15% darker, ${((100 * brighter) / a.n).toFixed(1)}% >15% brighter (exposure-normalized)`,
);

writeFileSync(path.join(OUT, "pixelwise.json"), JSON.stringify({
  ref: REF, ours: OURS, size: [W, H],
  meanLuminance: { ref: meanA, ours: meanB },
  contrast: { refP95overP5: drA, oursP95overP5: drB },
  saturation: { refP50: pctile(ssa, 0.5), oursP50: pctile(ssb, 0.5) },
  warmth: { refP50: pctile(swa, 0.5), oursP50: pctile(swb, 0.5) },
}, null, 2));
