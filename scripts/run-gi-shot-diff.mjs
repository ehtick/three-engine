// SHOT DIFF — what changed between two captures, bucketed by brightness.
//
// Usage:  node scripts/run-gi-shot-diff.mjs before.png after.png
//         npm run gi:shot-diff -- before.png after.png
//
// WHY BUCKETS AND NOT A MEAN. This exists because a scalar mean actively lied
// on 2026-08-07. Testing `c0DirRes` 2 -> 4 on the user's Sponza, the mean linear
// luminance went DOWN 11%, which reads as "that made it darker, discard it". The
// bucketed view showed the opposite and the truth:
//
//     lum 0.0-0.1   65% of frame   0.0246 -> 0.0424   +73%
//     lum 0.1-0.4   10% of frame                      -53% .. -74%
//
// The change lifted the indirect-only pixels — the curtains and foliage the user
// was complaining were black — by three quarters, while pulling the blown-out
// midtones back down. That is a REDISTRIBUTION, and it is exactly what "too dark
// and contrasty" needs. A single mean cannot represent it, because the two
// effects have opposite signs and cancel.
//
// So: bucket by the BASELINE's luminance, and report each bucket's own change.
// The dark buckets are the pixels lit only by indirect, which is the thing GI
// work is usually trying to move; the bright buckets are direct-lit and mostly
// tell you whether you have started clipping.
//
// GAMMA. Screenshots are sRGB-encoded. Averaging them raw compares gamma-encoded
// values and understates changes in the dark end — precisely the end that
// matters here — so every sample is linearised before it is summed.
//
// This is a comparison instrument, not a pass/fail test: it has no thresholds
// and always exits 0. Read the numbers.

import sharp from "sharp";

const [a, b] = process.argv.slice(2);
if (!a || !b) {
  console.error("usage: node scripts/run-gi-shot-diff.mjs <before.png> <after.png>");
  process.exit(2);
}

const load = async (p) => {
  const { data, info } = await sharp(p).raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height, ch: info.channels };
};

const A = await load(a);
const B = await load(b);
if (A.w !== B.w || A.h !== B.h) {
  console.error(`size mismatch: ${A.w}x${A.h} vs ${B.w}x${B.h} — these are not the same view`);
  process.exit(2);
}

const srgbToLin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const lumAt = (img, i) =>
  srgbToLin(img.data[i] / 255) * 0.2126 +
  srgbToLin(img.data[i + 1] / 255) * 0.7152 +
  srgbToLin(img.data[i + 2] / 255) * 0.0722;

const BUCKETS = 5;
const BUCKET_W = 0.1; // baseline luminance per bucket; the last one is open-ended
const buckets = Array.from({ length: BUCKETS }, () => ({ a: 0, b: 0, n: 0 }));
let sumA = 0;
let sumB = 0;
let n = 0;
let changed = 0;
let maxD = 0;

for (let i = 0; i < A.data.length; i += A.ch) {
  const la = lumAt(A, i);
  const lb = lumAt(B, i);
  sumA += la;
  sumB += lb;
  n++;
  const d =
    Math.abs(A.data[i] - B.data[i]) +
    Math.abs(A.data[i + 1] - B.data[i + 1]) +
    Math.abs(A.data[i + 2] - B.data[i + 2]);
  if (d > 2) changed++; // >2/765 — above PNG/dither noise
  if (d > maxD) maxD = d;
  const k = Math.min(BUCKETS - 1, Math.floor(la / BUCKET_W));
  buckets[k].a += la;
  buckets[k].b += lb;
  buckets[k].n++;
}

const pct = (x, y) => `${((y / x - 1) * 100).toFixed(1)}%`;
console.log(`${a}\n  -> ${b}`);
console.log(
  `pixels ${n}  changed(>2/765) ${((100 * changed) / n).toFixed(2)}%  maxAbsDiff ${maxD}/765`,
);
console.log(`mean linear luminance ${(sumA / n).toFixed(5)} -> ${(sumB / n).toFixed(5)}  (${pct(sumA, sumB)})`);
if (changed === 0) {
  console.log("NOTHING CHANGED — identical frames. If you expected a change: the viewport");
  console.log("  may be frozen (the toolbar snowflake / freeze-when-unfocused), in which case");
  console.log("  the capture is stale rather than the render being unchanged.");
}
console.log("by BASELINE brightness — the dark buckets are the indirect-only pixels:");
buckets.forEach((q, k) => {
  if (!q.n) return;
  const hi = k === BUCKETS - 1 ? "+" : `-${((k + 1) * BUCKET_W).toFixed(1)}`;
  console.log(
    `  lum ${(k * BUCKET_W).toFixed(1)}${hi}`.padEnd(14) +
      `n=${String(q.n).padStart(8)} (${((100 * q.n) / n).toFixed(0).padStart(3)}%)  ` +
      `${(q.a / q.n).toFixed(5)} -> ${(q.b / q.n).toFixed(5)}  ${pct(q.a, q.b).padStart(8)}`,
  );
});
