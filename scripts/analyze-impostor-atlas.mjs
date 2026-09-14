#!/usr/bin/env node
/**
 * Node-runnable analysis of a dumped impostor atlas (roadmap item 14 triage).
 *
 * Reads the `.raw` sidecars `impostorBake.js#debugSaveAtlas` writes next to
 * its `.png`s — a tiny `[width u32le][height u32le][tight top-down RGBA]`
 * header, chosen specifically so this script needs no PNG decoder dependency
 * to run in plain Node. For each octahedral view (tile) in the albedo atlas
 * it reports:
 *
 *   - coverage %      — the fraction of texels with real alpha (>= 32/255).
 *                        A tree view should read ~25-45% (a crown silhouette
 *                        against transparent background), not ~0% (nothing
 *                        baked) or ~100% (a filled "slab").
 *   - mean colour     — the average RGB of the COVERED texels only. Near-black
 *                        (all channels under ~40) on a view with real coverage
 *                        is the "flat dark smudge" symptom.
 *   - top vs bottom   — mean luminance of the tile's top half vs its bottom
 *                        half. A tree view (crown above, trunk/ground below)
 *                        usually reads brighter on top; a view that is
 *                        DARKER on top than bottom, or uniform edge-to-edge,
 *                        is a sign the camera or tile addressing is wrong
 *                        rather than the tree itself being dark.
 *
 * Usage:
 *   node scripts/analyze-impostor-atlas.mjs <dumpDir> [albedo|normal]
 *
 * `<dumpDir>` is whatever `globalThis.__impostorDumpDir` was set to before
 * the bake (see `FoliageComponent.js#acquireAtlas`). Defaults to analysing
 * `impostor-albedo.raw`; pass `normal` to analyse `impostor-normal.raw`
 * instead (coverage/mean-colour still apply — colour there is the packed
 * `(normal*0.5+0.5)` encoding, not a viewable colour).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

const COVERAGE_ALPHA_THRESHOLD = 32; // out of 255

function parseRaw(buffer) {
  const width = buffer.readUInt32LE(0);
  const height = buffer.readUInt32LE(4);
  const data = buffer.subarray(8, 8 + width * height * 4);
  if (data.length !== width * height * 4) {
    throw new Error(`raw atlas truncated: expected ${width * height * 4} bytes, got ${data.length}`);
  }
  return { width, height, data };
}

function analyzeTile(data, fullWidth, x0, y0, tile) {
  let covered = 0;
  let rSum = 0, gSum = 0, bSum = 0;
  let topLum = 0, topCount = 0, bottomLum = 0, bottomCount = 0;
  const half = tile / 2;
  for (let y = 0; y < tile; y++) {
    for (let x = 0; x < tile; x++) {
      const idx = ((y0 + y) * fullWidth + (x0 + x)) * 4;
      const a = data[idx + 3];
      if (a < COVERAGE_ALPHA_THRESHOLD) continue;
      covered++;
      const r = data[idx], g = data[idx + 1], b = data[idx + 2];
      rSum += r; gSum += g; bSum += b;
      const lum = r * 0.2126 + g * 0.7152 + b * 0.0722;
      if (y < half) { topLum += lum; topCount++; } else { bottomLum += lum; bottomCount++; }
    }
  }
  const n = tile * tile;
  return {
    coverage: covered / n,
    meanColor: covered ? [rSum / covered, gSum / covered, bSum / covered] : [0, 0, 0],
    topMeanLum: topCount ? topLum / topCount : 0,
    bottomMeanLum: bottomCount ? bottomLum / bottomCount : 0,
  };
}

export function analyzeAtlas({ width, height, data }, frames, tile) {
  const views = [];
  for (let row = 0; row < frames; row++) {
    for (let col = 0; col < frames; col++) {
      const stats = analyzeTile(data, width, col * tile, row * tile, tile);
      views.push({ row, col, ...stats, topBrighterThanBottom: stats.topMeanLum > stats.bottomMeanLum });
    }
  }
  return views;
}

function formatView(v) {
  const color = v.meanColor.map((c) => c.toFixed(1)).join(",");
  return `view[row=${v.row},col=${v.col}] coverage=${(v.coverage * 100).toFixed(1)}% ` +
    `meanColor=(${color}) topLum=${v.topMeanLum.toFixed(1)} bottomLum=${v.bottomMeanLum.toFixed(1)} ` +
    `topBrighter=${v.topBrighterThanBottom}`;
}

async function main() {
  const dir = process.argv[2];
  const which = process.argv[3] === "normal" ? "normal" : "albedo";
  if (!dir) {
    console.error("usage: node scripts/analyze-impostor-atlas.mjs <dumpDir> [albedo|normal]");
    process.exit(1);
  }
  const meta = JSON.parse(await readFile(path.join(dir, "impostor-meta.json"), "utf8"));
  const raw = await readFile(path.join(dir, `impostor-${which}.raw`));
  const { width, height, data } = parseRaw(raw);
  if (width !== meta.size || height !== meta.size) {
    console.warn(`warning: raw dump is ${width}x${height} but meta says size=${meta.size}`);
  }
  const views = analyzeAtlas({ width, height, data }, meta.frames, meta.tile);

  console.log(`Atlas ${width}x${height} (${which}), ${meta.frames}x${meta.frames} views, tile=${meta.tile}, hemisphere=${meta.hemisphere}`);
  for (const v of views) console.log(formatView(v));

  const withCoverage = views.filter((v) => v.coverage > 0.01);
  const emptyViews = views.length - withCoverage.length;
  const slabViews = views.filter((v) => v.coverage > 0.9).length;
  const darkViews = withCoverage.filter((v) => v.meanColor.every((c) => c < 40)).length;
  const topBrighterCount = withCoverage.filter((v) => v.topBrighterThanBottom).length;

  console.log("---");
  console.log(`${views.length} views total: ${emptyViews} empty (coverage<1%), ${slabViews} "slab" (coverage>90%), ${darkViews} dark (mean colour<40 on every channel).`);
  console.log(`${topBrighterCount}/${withCoverage.length} covered views read brighter on top than bottom.`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("analyze-impostor-atlas.mjs")) {
  main().catch((error) => { console.error(error); process.exit(1); });
}
