import * as THREE from "three/webgpu";
import { createRng } from "./rng.js";
import { SURFACE_KINDS } from "./catalog.js";

/**
 * Procedural wall/roof surfaces for the style decorators. Canvas-generated
 * like `src/modules/foliage/foliageSurfaceTexture.js`: cached by every input
 * that changes the pixels, and a no-op (`null`) wherever there is no
 * `document` to draw into (a headless test, a build worker) so the caller
 * falls back to a flat material colour instead of throwing.
 */

// World-metre size of one tile, used by the caller as `material.map.repeat`
// after dividing by however many metres the mesh's UV already spans.
const TILE_METRES = Object.freeze({
  plaster: [2, 2], brick: [1, 0.5], stone: [1.6, 1.6], plank: [0.3, 2.4], log: [2.2, 0.45],
  tiles: [1, 1], slate: [1, 1], shingles: [0.6, 0.6], thatch: [1, 1.3], metal: [1.2, 1.2],
  glass: [1, 1], timber: [1, 1], concrete: [2.4, 2.4], adobe: [2.2, 2.2], cobble: [1.4, 1.4],
});
const KINDS = Object.freeze(Object.keys(TILE_METRES));

// P1-H3 (World production plan §2/3): a scene with N styled houses of the same
// style/seed range must not mint N texture sets — every seed collapses onto one
// of this many variants before anything is painted or cached, so a whole world
// of styled buildings holds at most `SURFACE_VARIANTS` texture sets per kind.
export const SURFACE_VARIANTS = 1;

/** `seed % SURFACE_VARIANTS`, folded into `[0, SURFACE_VARIANTS)`. Exported so
 * `formGeometry.js` and `ArchitectureComponent.js` share this one fold instead
 * of each keeping their own copy. */
export function surfaceVariantOf(seed) {
  const s = Number.isFinite(seed) ? Math.trunc(seed) : 0;
  return ((s % SURFACE_VARIANTS) + SURFACE_VARIANTS) % SURFACE_VARIANTS;
}

/** The world-metre tile size for `kind` (`TILE_METRES`, above), or a 1x1
 * fallback for an unknown kind. `formGeometry.js` uses this to bake the
 * repeat straight into a styled vertex's UV at build time (World production
 * plan §3, item 3) — one shared array texture cannot carry a per-material
 * `texture.repeat`, so the division happens once per vertex instead. */
export function styleTileMetres(kind) {
  const tile = TILE_METRES[kind];
  return tile ? [tile[0], tile[1]] : [1, 1];
}

// Default tile-map resolution per kind: the "big" wall/roof course kinds (tiled
// over a whole facet or slope) keep 512²; the smaller decorative kinds (trim,
// timber, plank, log courses, metal seams, glass panes) drop to 256² since they
// cover far less screen area per instance and never need the extra detail.
const DEFAULT_SIZE = Object.freeze({
  plaster: 512, brick: 512, stone: 512, tiles: 512, slate: 512, shingles: 512, thatch: 512,
  plank: 256, log: 256, metal: 256, glass: 256, timber: 256, concrete: 512, adobe: 512, cobble: 512,
});

// P1 (owner verdict "unnatural textures"): a base palette of 2-3 CLOSE tones per kind —
// picked per element (per brick, per stone block, per plank, ...) — plus a small bounded
// per-element HSL jitter on top (`TONE_VARIATION`, below). The old per-channel RGB jitter
// moved each of R/G/B independently, which is a HUE shift, not a lightness one — that is
// what painted a running-bond wall as a mosaic of random green/pink/orange/yellow blocks.
// Working in HSL and only ever touching L (±lightnessJitterPct) and H (±hueJitterDeg) keeps
// every element a close relative of its kind's own palette, never a different colour.
export const SURFACE_PALETTE = Object.freeze({
  plaster: ["#e8e0cc", "#e2d7bf", "#ddd2b8"],
  brick: ["#a8583c", "#9c4f34", "#b3684a"],
  stone: ["#9a9184", "#8f8676", "#a49b8a"],
  plank: ["#8a6a48", "#7e6040", "#93714f"],
  log: ["#89693f", "#7c5f3a", "#93744a"],
  tiles: ["#b5623a", "#a8582f", "#c06c44"],
  slate: ["#4a5058", "#434952", "#515761"],
  shingles: ["#7a6a56", "#6f6049", "#836f56"],
  thatch: ["#c2a15a", "#b8934e", "#cba968"],
  metal: ["#8a8d90", "#818488", "#929598"],
  glass: ["#cfe0e6"],
  timber: ["#7a5c3e", "#6e5136", "#846247"],
  concrete: ["#a9a8a2", "#b3b2ac", "#9f9e98"],
  adobe: ["#c49a70", "#b98f65", "#cda47a"],
  cobble: ["#8d887e", "#7f7a70", "#99948a"],
});
// A single representative tone per kind — used by the `flat:true` stylized variant, which
// keeps ONE tone with only a soft normal (no per-element palette pick, no grime).
const BASE_COLOR = Object.freeze(Object.fromEntries(Object.entries(SURFACE_PALETTE).map(([k, v]) => [k, v[0]])));
const BASE_ROUGHNESS = Object.freeze({
  plaster: 0.85, brick: 0.8, stone: 0.85, plank: 0.7, log: 0.75,
  tiles: 0.55, slate: 0.4, shingles: 0.65, thatch: 0.9, metal: 0.35, glass: 0.08, timber: 0.6,
  concrete: 0.8, adobe: 0.92, cobble: 0.85,
});
// The bound every per-element tint (`varyTone`) is mathematically clamped to: no brick,
// stone, plank, tile, shingle or shingle-neighbour can drift more than this from the
// palette tone it was picked from.
export const TONE_VARIATION = Object.freeze({ hueJitterDeg: 3, lightnessJitterPct: 0.06 });

const cache = new Map();

function hashSeed(kind, seed) {
  let h = 0x811c9dc5;
  for (let i = 0; i < kind.length; i++) { h ^= kind.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h ^ Math.floor(Number.isFinite(seed) ? seed : 0)) >>> 0;
}

function hexToRgb(hex) {
  const n = parseInt(hex.replace("#", "").length === 3 ? hex.replace("#", "").split("").map(c => c + c).join("") : hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const clampByte = v => Math.max(0, Math.min(255, Math.round(v)));
const clamp01 = v => Math.max(0, Math.min(1, v));

/** hex -> [hue 0..360, saturation 0..1, lightness 0..1]. */
export function hexToHsl(hex) {
  const [r, g, b] = hexToRgb(hex).map(v => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (d < 1e-9) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60; if (h < 0) h += 360;
  return [h, s, l];
}

/** [hue, saturation, lightness] -> "rgb(r,g,b)". */
export function hslToRgbString(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = l - c / 2;
  return `rgb(${clampByte((r1 + m) * 255)},${clampByte((g1 + m) * 255)},${clampByte((b1 + m) * 255)})`;
}

/** One painted element's tone: `hex` (normally one entry of `SURFACE_PALETTE[kind]`)
 * shifted by at most `TONE_VARIATION`'s bounds — hue ±hueJitterDeg, lightness
 * ±lightnessJitterPct — plus an optional deliberate `lightnessScale` (an occasional
 * darker brick header, a shaded wood-grain band) applied to L *before* the jitter so
 * the jitter's own bound still holds around whatever tone results. Pure function of
 * `hex` and `rng.next()` — no canvas, so a Node test can assert its bounds directly. */
export function varyTone(hex, rng, { hueJitterDeg = TONE_VARIATION.hueJitterDeg, lightnessJitterPct = TONE_VARIATION.lightnessJitterPct, lightnessScale = 1 } = {}) {
  const [h, s, l] = hexToHsl(hex);
  const hh = h + (rng.next() * 2 - 1) * hueJitterDeg;
  const ll = clamp01(l * lightnessScale + (rng.next() * 2 - 1) * lightnessJitterPct);
  return hslToRgbString(hh, s, ll);
}

function tryCanvas(size) {
  if (typeof document === "undefined" || typeof document.createElement !== "function") return null;
  const canvas = document.createElement("canvas");
  if (typeof canvas?.getContext !== "function") return null;
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  return { canvas, ctx };
}

function fillRect(ctx, size, color) { ctx.fillStyle = color; ctx.fillRect(0, 0, size, size); }

/** A near-uniform albedo with only a soft normal — the stylized-family look
 * (§2.3): "flat:true gives a near-uniform albedo with only a soft normal." */
function paintFlat(kind, actx, nctx, rctx, size, rng) {
  // §2.3: "flat:true gives a near-uniform albedo with only a soft normal" — ONE tone,
  // no per-element palette pick, no blotches on the albedo itself.
  fillRect(actx, size, BASE_COLOR[kind]);
  fillRect(nctx, size, "rgb(128,128,255)");
  for (let i = 0; i < 8; i++) {
    nctx.globalAlpha = 0.05;
    nctx.fillStyle = rng.chance(0.5) ? "rgb(146,146,255)" : "rgb(110,110,255)";
    nctx.beginPath(); nctx.arc(rng.next() * size, rng.next() * size, size * (0.15 + rng.next() * 0.2), 0, Math.PI * 2); nctx.fill();
  }
  nctx.globalAlpha = 1;
  const g = clampByte(BASE_ROUGHNESS[kind] * 255);
  fillRect(rctx, size, `rgb(${g},${g},${g})`);
}

/** Soft noise dabs (plaster grain, general mottling), reused by several kinds. */
function noise(actx, size, rng, { count, color, alpha }) {
  for (let i = 0; i < count; i++) {
    actx.globalAlpha = alpha[0] + rng.next() * (alpha[1] - alpha[0]);
    actx.fillStyle = color();
    actx.beginPath(); actx.arc(rng.next() * size, rng.next() * size, size * (0.01 + rng.next() * 0.025), 0, Math.PI * 2); actx.fill();
  }
  actx.globalAlpha = 1;
}

/** A jagged hairline crack (plaster) or grain stroke (wood). */
function jaggedLine(ctx, size, rng, { color, alpha, width, steps, spread, start }) {
  ctx.globalAlpha = alpha; ctx.strokeStyle = color; ctx.lineWidth = width;
  let [x, y] = start();
  ctx.beginPath(); ctx.moveTo(x, y);
  for (let s = 0; s < steps; s++) { x += (rng.next() - 0.5) * size * spread; y += (rng.next() - 0.5) * size * spread; ctx.lineTo(x, y); }
  ctx.stroke(); ctx.globalAlpha = 1;
}

/** Low-frequency grime/weathering: a handful of large soft dark blotches sized
 * 0.5-2 m in WORLD space — `tileMetres` (a kind's own `TILE_METRES` entry) converts
 * that world radius to the (possibly non-square) pixel radii this canvas needs.
 * Distinct from the fine per-pixel grain below: this is the coarse dirt/weather
 * patchiness that reads at a distance. */
function paintGrime(actx, size, rng, tileMetres) {
  const [mx, my] = tileMetres;
  const blotches = rng.int(4, 7);
  for (let i = 0; i < blotches; i++) {
    const worldRadius = rng.range(0.25, 1);
    const rx = Math.max(2, (worldRadius / mx) * size), ry = Math.max(2, (worldRadius / my) * size);
    actx.globalAlpha = 0.03 + rng.next() * 0.05;
    actx.fillStyle = rng.chance(0.6) ? "#2b271f" : "#000000";
    actx.beginPath();
    actx.ellipse(rng.next() * size, rng.next() * size, rx, ry, rng.next() * Math.PI, 0, Math.PI * 2);
    actx.fill();
  }
  actx.globalAlpha = 1;
}

/** Fine per-pixel-scale grain shared by every natural kind — brick dust, stone
 * speckle, wood pore, metal brushing — a single-pixel dab noise independent of
 * (and much subtler than) the coarser per-element palette variation above. */
function paintFineGrain(actx, size, rng, count = Math.round(size * 0.9)) {
  for (let i = 0; i < count; i++) {
    actx.globalAlpha = 0.02 + rng.next() * 0.03;
    actx.fillStyle = rng.chance(0.5) ? "#ffffff" : "#000000";
    actx.fillRect(rng.next() * size, rng.next() * size, 1, 1);
  }
  actx.globalAlpha = 1;
}

/** The normal-map half of "grain as fine noise": tiny blue-channel dabs so the
 * fine grain above also reads as a very shallow height variation, not just an
 * albedo speckle. */
function paintNormalGrain(nctx, size, rng, count = Math.round(size * 0.6)) {
  for (let i = 0; i < count; i++) {
    nctx.globalAlpha = 0.03 + rng.next() * 0.04;
    nctx.fillStyle = rng.chance(0.5) ? "rgb(138,138,255)" : "rgb(118,118,255)";
    nctx.fillRect(rng.next() * size, rng.next() * size, 1, 1);
  }
  nctx.globalAlpha = 1;
}

/** Grime + fine grain (albedo) + grain (normal) in one call — every natural,
 * weathered kind (everything but glass) ends its painter with this. */
function weather(actx, nctx, size, rng, tileMetres) {
  paintGrime(actx, size, rng, tileMetres);
  paintFineGrain(actx, size, rng);
  paintNormalGrain(nctx, size, rng);
}

/** Rows of units (brick running-bond, tiles, slate, shingles, log, planks): regular
 * cells with a mortar/gap colour between, and a simple top-light / bottom-shade bevel
 * baked into the normal map. Each unit independently picks one of `palette`'s 2-3
 * close tones and jitters it (`varyTone`, bounded by `TONE_VARIATION`) — never a bare
 * per-channel jitter, which is what used to turn a wall into a colour mosaic.
 * `headerChance` (brick only) occasionally darkens a unit further, like a real
 * header course. */
function courses(actx, nctx, rctx, size, rng, { unitW, unitH, gap, stagger, palette, gapColor, roughUnit, roughGap, headerChance = 0 }) {
  fillRect(rctx, size, `rgb(${clampByte(roughGap * 255)},${clampByte(roughGap * 255)},${clampByte(roughGap * 255)})`);
  fillRect(nctx, size, "rgb(128,128,255)");
  fillRect(actx, size, gapColor);
  const step = unitW + gap, rows = Math.ceil(size / (unitH + gap)) + 1;
  for (let row = -1; row <= rows; row++) {
    const y = row * (unitH + gap), offset = stagger && (((row % 2) + 2) % 2) ? step / 2 : 0;
    if (y > size) continue;
    const cols = Math.ceil((size + step) / step) + 1;
    for (let col = -1; col <= cols; col++) {
      const x = col * step + offset;
      if (x > size || x + unitW < 0 || y + unitH < 0) continue;
      const isHeader = headerChance > 0 && rng.chance(headerChance);
      actx.fillStyle = varyTone(rng.pick(palette), rng, isHeader ? { lightnessScale: 0.72 } : undefined);
      actx.fillRect(x + gap * 0.5, y + gap * 0.5, unitW - gap, unitH - gap);
      const g = clampByte((roughUnit + (rng.next() - 0.5) * 0.06) * 255);
      rctx.fillStyle = `rgb(${g},${g},${g})`;
      rctx.fillRect(x + gap * 0.5, y + gap * 0.5, unitW - gap, unitH - gap);
      nctx.fillStyle = "rgb(140,140,255)"; nctx.fillRect(x + gap * 0.5, y + gap * 0.5, Math.max(0, unitW - gap), 1.5);
      nctx.fillStyle = "rgb(116,116,255)"; nctx.fillRect(x + gap * 0.5, y + unitH - gap * 0.5 - 1.5, Math.max(0, unitW - gap), 1.5);
    }
  }
}

function roundedRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath(); ctx.moveTo(x + rr, y); ctx.lineTo(x + w - rr, y); ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr); ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h); ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr); ctx.lineTo(x, y + rr); ctx.quadraticCurveTo(x, y, x + rr, y); ctx.closePath();
}

const PATTERNS = {
  plaster(actx, nctx, rctx, size, rng) {
    fillRect(actx, size, varyTone(rng.pick(SURFACE_PALETTE.plaster), rng));
    noise(actx, size, rng, { count: 160, color: () => (rng.chance(0.5) ? "#ffffff" : "#3a3226"), alpha: [0.02, 0.06] });
    for (let i = 0; i < rng.int(2, 5); i++) {
      jaggedLine(actx, size, rng, { color: "#4a4030", alpha: 0.1 + rng.next() * 0.08, width: 1, steps: rng.int(4, 9), spread: 0.1, start: () => [rng.next() * size, rng.next() * size] });
    }
    fillRect(nctx, size, "rgb(128,128,255)");
    noise(nctx, size, rng, { count: 90, color: () => (rng.chance(0.5) ? "rgb(140,140,255)" : "rgb(118,118,255)"), alpha: [0.03, 0.05] });
    fillRect(rctx, size, `rgb(${clampByte(BASE_ROUGHNESS.plaster * 255)},${clampByte(BASE_ROUGHNESS.plaster * 255)},${clampByte(BASE_ROUGHNESS.plaster * 255)})`);
    weather(actx, nctx, size, rng, TILE_METRES.plaster);
  },
  brick(actx, nctx, rctx, size, rng) {
    courses(actx, nctx, rctx, size, rng, { unitW: size * 0.14, unitH: size * 0.065, gap: size * 0.012, stagger: true, palette: SURFACE_PALETTE.brick, gapColor: "#c9c2b2", roughUnit: BASE_ROUGHNESS.brick, roughGap: 0.92, headerChance: 0.1 });
    weather(actx, nctx, size, rng, TILE_METRES.brick);
  },
  stone(actx, nctx, rctx, size, rng) {
    // Coursed rubble (owner receipt 09-13: the old grid read as bathroom tiles): rows of
    // uneven height, stones of uneven width that straddle their row, rounded corners, a
    // bevel gradient per stone and a normal tilt off every edge into the joint. Low
    // contrast against the mortar — a wall reads as stone from relief and tone drift,
    // not from bright tiles on dark lines.
    fillRect(rctx, size, "rgb(229,229,229)");
    fillRect(nctx, size, "rgb(128,128,255)");
    fillRect(actx, size, "#5f5850");
    const tones = SURFACE_PALETTE.stone, gap = size * 0.012, corner = size * 0.014, edge = Math.max(1.5, size * 0.006);
    let y = -size * 0.04;
    while (y < size * 1.02) {
      const rowH = size * (0.11 + rng.next() * 0.07);
      let x = -size * (0.02 + rng.next() * 0.1);
      while (x < size * 1.02) {
        const w = size * (0.09 + rng.next() * 0.17), h = rowH * (0.8 + rng.next() * 0.4), dy = (rowH - h) * (rng.next() - 0.5);
        const x0 = x + gap / 2, y0 = y + dy + gap / 2, w0 = w - gap, h0 = h - gap;
        if (w0 > 2 && h0 > 2) {
          const [hh, ss, ll] = hexToHsl(rng.pick(tones));
          const hue = hh + (rng.next() * 2 - 1) * TONE_VARIATION.hueJitterDeg, light = clamp01(ll + (rng.next() * 2 - 1) * TONE_VARIATION.lightnessJitterPct);
          const grad = actx.createLinearGradient(x0, y0, x0 + w0 * 0.7, y0 + h0);
          grad.addColorStop(0, hslToRgbString(hue, ss, clamp01(light * 1.07)));
          grad.addColorStop(1, hslToRgbString(hue, ss, clamp01(light * 0.9)));
          actx.fillStyle = grad; roundedRect(actx, x0, y0, w0, h0, corner); actx.fill();
          const g = clampByte((BASE_ROUGHNESS.stone + (rng.next() - 0.5) * 0.08) * 255);
          rctx.fillStyle = `rgb(${g},${g},${g})`; roundedRect(rctx, x0, y0, w0, h0, corner); rctx.fill();
          // Canvas row 0 is the top of the tile (v = 1): the upper edge's normal leans +y.
          nctx.fillStyle = "rgb(128,146,255)"; nctx.fillRect(x0, y0, w0, edge);
          nctx.fillStyle = "rgb(128,110,255)"; nctx.fillRect(x0, y0 + h0 - edge, w0, edge);
          nctx.fillStyle = "rgb(110,128,255)"; nctx.fillRect(x0, y0, edge, h0);
          nctx.fillStyle = "rgb(146,128,255)"; nctx.fillRect(x0 + w0 - edge, y0, edge, h0);
        }
        x += w;
      }
      y += rowH;
    }
    weather(actx, nctx, size, rng, TILE_METRES.stone);
  },
  plank(actx, nctx, rctx, size, rng) {
    courses(actx, nctx, rctx, size, rng, { unitW: size * 0.09, unitH: size * 1.2, gap: size * 0.008, stagger: false, palette: SURFACE_PALETTE.plank, gapColor: "#241d14", roughUnit: BASE_ROUGHNESS.plank, roughGap: 0.85 });
    // Vertical grain and nail dots near each board's top/bottom.
    const boardStep = size * 0.098;
    for (let x = 0; x < size + boardStep; x += boardStep) {
      for (let i = 0; i < 3; i++) jaggedLine(actx, size, rng, { color: "#00000022", alpha: 0.15, width: 1, steps: 10, spread: 0.015, start: () => [x + rng.next() * boardStep * 0.7, 0] });
      for (const ny of [size * 0.06, size * 0.94]) {
        actx.globalAlpha = 0.6; actx.fillStyle = "#241d14";
        actx.beginPath(); actx.arc(x + boardStep * 0.5, ny, size * 0.006, 0, Math.PI * 2); actx.fill();
        actx.globalAlpha = 1;
      }
    }
    weather(actx, nctx, size, rng, TILE_METRES.plank);
  },
  log(actx, nctx, rctx, size, rng) {
    courses(actx, nctx, rctx, size, rng, { unitW: size * 1.2, unitH: size * 0.09, gap: size * 0.01, stagger: false, palette: SURFACE_PALETTE.log, gapColor: "#241d14", roughUnit: BASE_ROUGHNESS.log, roughGap: 0.9 });
    const rowStep = size * 0.1;
    for (let y = 0; y < size + rowStep; y += rowStep) {
      // A half-round highlight band along the log's centre, shaded at the seam.
      nctx.fillStyle = "rgb(128,150,255)"; nctx.fillRect(0, y + rowStep * 0.4, size, rowStep * 0.2);
    }
    weather(actx, nctx, size, rng, TILE_METRES.log);
  },
  tiles(actx, nctx, rctx, size, rng) {
    courses(actx, nctx, rctx, size, rng, { unitW: size * 0.11, unitH: size * 0.16, gap: size * 0.014, stagger: true, palette: SURFACE_PALETTE.tiles, gapColor: "#5a3826", roughUnit: BASE_ROUGHNESS.tiles, roughGap: 0.75 });
    weather(actx, nctx, size, rng, TILE_METRES.tiles);
  },
  slate(actx, nctx, rctx, size, rng) {
    courses(actx, nctx, rctx, size, rng, { unitW: size * 0.14, unitH: size * 0.09, gap: size * 0.01, stagger: true, palette: SURFACE_PALETTE.slate, gapColor: "#20242a", roughUnit: BASE_ROUGHNESS.slate, roughGap: 0.6 });
    weather(actx, nctx, size, rng, TILE_METRES.slate);
  },
  shingles(actx, nctx, rctx, size, rng) {
    courses(actx, nctx, rctx, size, rng, { unitW: size * 0.08, unitH: size * 0.06, gap: size * 0.008, stagger: true, palette: SURFACE_PALETTE.shingles, gapColor: "#2c241a", roughUnit: BASE_ROUGHNESS.shingles, roughGap: 0.8 });
    weather(actx, nctx, size, rng, TILE_METRES.shingles);
  },
  thatch(actx, nctx, rctx, size, rng) {
    fillRect(actx, size, varyTone(rng.pick(SURFACE_PALETTE.thatch), rng, { lightnessScale: 0.9 }));
    fillRect(nctx, size, "rgb(128,128,255)");
    fillRect(rctx, size, `rgb(${clampByte(BASE_ROUGHNESS.thatch * 255)},${clampByte(BASE_ROUGHNESS.thatch * 255)},${clampByte(BASE_ROUGHNESS.thatch * 255)})`);
    const strands = Math.round(size * 0.35);
    for (let i = 0; i < strands; i++) {
      const x = rng.next() * size, len = size * (0.2 + rng.next() * 0.6), shade = varyTone(rng.pick(SURFACE_PALETTE.thatch), rng);
      actx.globalAlpha = 0.5 + rng.next() * 0.4; actx.strokeStyle = shade; actx.lineWidth = 1 + rng.next();
      actx.beginPath(); actx.moveTo(x, rng.next() * size * 0.1); actx.lineTo(x + (rng.next() - 0.5) * size * 0.04, Math.min(size, rng.next() * size * 0.1 + len)); actx.stroke();
      nctx.globalAlpha = 0.35; nctx.strokeStyle = rng.chance(0.5) ? "rgb(150,150,255)" : "rgb(108,108,255)"; nctx.lineWidth = 1.5;
      nctx.beginPath(); nctx.moveTo(x, 0); nctx.lineTo(x, size); nctx.stroke();
    }
    actx.globalAlpha = 1; nctx.globalAlpha = 1;
    // A couple of woven binding lines (ridge rope courses).
    for (const y of [size * 0.22, size * 0.55, size * 0.85]) { actx.globalAlpha = 0.25; actx.strokeStyle = "#5a4426"; actx.lineWidth = 2; actx.beginPath(); actx.moveTo(0, y); actx.lineTo(size, y); actx.stroke(); }
    actx.globalAlpha = 1;
    weather(actx, nctx, size, rng, TILE_METRES.thatch);
  },
  metal(actx, nctx, rctx, size, rng) {
    fillRect(actx, size, varyTone(rng.pick(SURFACE_PALETTE.metal), rng));
    fillRect(nctx, size, "rgb(128,128,255)");
    fillRect(rctx, size, `rgb(${clampByte(BASE_ROUGHNESS.metal * 255)},${clampByte(BASE_ROUGHNESS.metal * 255)},${clampByte(BASE_ROUGHNESS.metal * 255)})`);
    for (let i = 0; i < 220; i++) {
      const y = rng.next() * size;
      actx.globalAlpha = 0.04 + rng.next() * 0.05; actx.strokeStyle = rng.chance(0.5) ? "#ffffff" : "#000000"; actx.lineWidth = 1;
      actx.beginPath(); actx.moveTo(0, y); actx.lineTo(size, y + (rng.next() - 0.5) * 4); actx.stroke();
    }
    actx.globalAlpha = 1;
    const seams = rng.int(2, 3);
    for (let i = 1; i <= seams; i++) {
      const x = (size / (seams + 1)) * i;
      actx.strokeStyle = "#1c1d1f"; actx.lineWidth = size * 0.006; actx.beginPath(); actx.moveTo(x, 0); actx.lineTo(x, size); actx.stroke();
      nctx.strokeStyle = "rgb(96,128,255)"; nctx.lineWidth = size * 0.006; nctx.beginPath(); nctx.moveTo(x, 0); nctx.lineTo(x, size); nctx.stroke();
      rctx.strokeStyle = "rgb(200,200,200)"; rctx.lineWidth = size * 0.006; rctx.beginPath(); rctx.moveTo(x, 0); rctx.lineTo(x, size); rctx.stroke();
    }
    paintGrime(actx, size, rng, TILE_METRES.metal); // rust/dirt streaking, no fine grain (already brushed)
  },
  glass(actx, nctx, rctx, size, rng) {
    fillRect(actx, size, BASE_COLOR.glass);
    for (let i = 0; i < 6; i++) { actx.globalAlpha = 0.02; actx.fillStyle = "#ffffff"; actx.fillRect(0, (size / 6) * i, size, size / 12); }
    actx.globalAlpha = 1;
    fillRect(nctx, size, "rgb(128,128,255)");
    fillRect(rctx, size, `rgb(${clampByte(BASE_ROUGHNESS.glass * 255)},${clampByte(BASE_ROUGHNESS.glass * 255)},${clampByte(BASE_ROUGHNESS.glass * 255)})`);
    // No grime/grain: glazing stays pristine, unlike every other (weathered) kind.
  },
  timber(actx, nctx, rctx, size, rng) {
    fillRect(actx, size, varyTone(rng.pick(SURFACE_PALETTE.timber), rng));
    fillRect(nctx, size, "rgb(128,128,255)");
    fillRect(rctx, size, `rgb(${clampByte(BASE_ROUGHNESS.timber * 255)},${clampByte(BASE_ROUGHNESS.timber * 255)},${clampByte(BASE_ROUGHNESS.timber * 255)})`);
    const bands = 10;
    for (let i = 0; i < bands; i++) {
      const y0 = (size / bands) * i + rng.next() * size * 0.02, amp = size * (0.01 + rng.next() * 0.015);
      actx.globalAlpha = 0.15 + rng.next() * 0.15; actx.strokeStyle = varyTone(rng.pick(SURFACE_PALETTE.timber), rng, { lightnessScale: 0.6 + rng.next() * 0.3 }); actx.lineWidth = 1 + rng.next() * 1.5;
      actx.beginPath(); actx.moveTo(0, y0);
      for (let x = 0; x <= size; x += size / 16) actx.lineTo(x, y0 + Math.sin(x * 0.02 + i) * amp);
      actx.stroke();
      nctx.globalAlpha = 0.1; nctx.strokeStyle = "rgb(112,112,255)"; nctx.lineWidth = 1;
      nctx.beginPath(); nctx.moveTo(0, y0);
      for (let x = 0; x <= size; x += size / 16) nctx.lineTo(x, y0 + Math.sin(x * 0.02 + i) * amp);
      nctx.stroke();
    }
    actx.globalAlpha = 1; nctx.globalAlpha = 1;
    weather(actx, nctx, size, rng, TILE_METRES.timber);
  },
  concrete(actx, nctx, rctx, size, rng) {
    fillRect(actx, size, varyTone(rng.pick(SURFACE_PALETTE.concrete), rng));
    fillRect(nctx, size, "rgb(128,128,255)");
    fillRect(rctx, size, "rgb(204,204,204)");
    noise(actx, size, rng, { count: 260, color: () => (rng.chance(0.5) ? "#ffffff" : "#44423c"), alpha: [0.02, 0.05] });
    for (let i = 1; i < 4; i++) { const y = size * i / 4; actx.globalAlpha = 0.08; actx.fillStyle = "#3c3b36"; actx.fillRect(0, y, size, 1.5); nctx.fillStyle = "rgb(128,112,255)"; nctx.fillRect(0, y, size, 2); }
    actx.globalAlpha = 0.25;
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { actx.fillStyle = "#3a3934"; actx.beginPath(); actx.arc((i + .5) * size / 4, (j + .5) * size / 4, size * .006, 0, Math.PI * 2); actx.fill(); }
    actx.globalAlpha = 1;
    weather(actx, nctx, size, rng, TILE_METRES.concrete);
  },
  adobe(actx, nctx, rctx, size, rng) {
    fillRect(actx, size, varyTone(rng.pick(SURFACE_PALETTE.adobe), rng));
    fillRect(nctx, size, "rgb(128,128,255)");
    fillRect(rctx, size, "rgb(234,234,234)");
    for (let i = 0; i < 26; i++) {
      actx.globalAlpha = 0.05; actx.fillStyle = rng.chance(0.5) ? "#fff4e0" : "#5a3d22";
      actx.beginPath(); actx.ellipse(rng.next() * size, rng.next() * size, size * (.05 + rng.next() * .12), size * (.03 + rng.next() * .08), rng.next() * Math.PI, 0, Math.PI * 2); actx.fill();
      nctx.globalAlpha = 0.08; nctx.fillStyle = rng.chance(0.5) ? "rgb(142,142,255)" : "rgb(114,114,255)";
      nctx.beginPath(); nctx.arc(rng.next() * size, rng.next() * size, size * (.04 + rng.next() * .1), 0, Math.PI * 2); nctx.fill();
    }
    for (let i = 0; i < 180; i++) jaggedLine(actx, size, rng, { color: "#e8cf9a", alpha: 0.18, width: 1, steps: 2, spread: 0.01, start: () => [rng.next() * size, rng.next() * size] });
    actx.globalAlpha = 1; nctx.globalAlpha = 1;
    weather(actx, nctx, size, rng, TILE_METRES.adobe);
  },
  cobble(actx, nctx, rctx, size, rng) {
    fillRect(rctx, size, "rgb(235,235,235)"); fillRect(nctx, size, "rgb(128,128,255)"); fillRect(actx, size, "#4c4841");
    const tones = SURFACE_PALETTE.cobble, gap = size * 0.018, corner = size * 0.03, edge = Math.max(1.5, size * 0.008);
    for (let y = -size * .02; y < size; y += size * .12) {
      let x = -rng.next() * size * .08;
      while (x < size) {
        const w = size * (.09 + rng.next() * .07), h = size * (.1 + rng.next() * .03);
        const [hh, ss, ll] = hexToHsl(rng.pick(tones)), light = clamp01(ll + (rng.next() * 2 - 1) * TONE_VARIATION.lightnessJitterPct);
        actx.fillStyle = hslToRgbString(hh, ss, light); roundedRect(actx, x + gap / 2, y + gap / 2, w - gap, h - gap, corner); actx.fill();
        nctx.fillStyle = "rgb(128,150,255)"; nctx.fillRect(x + gap, y + gap / 2, w - gap * 2, edge);
        nctx.fillStyle = "rgb(128,106,255)"; nctx.fillRect(x + gap, y + h - gap / 2 - edge, w - gap * 2, edge);
        x += w;
      }
    }
    weather(actx, nctx, size, rng, TILE_METRES.cobble);
  },
};

/**
 * `styleSurface(kind, seed, { size, flat }) -> { map, normalMap, roughnessMap, repeat } | null`
 * (World production plan §2.3). Returns `null` wherever there is no
 * `document` (Node, a build worker) so the caller falls back to a flat
 * material colour; never throws for an unknown `kind` either, for the same
 * reason. `seed` is folded to `seed % SURFACE_VARIANTS` before anything else
 * happens, so at most `SURFACE_VARIANTS` texture sets exist per `(kind, size,
 * flat)` no matter how many distinct seeds the caller has — a scene with 20
 * uniquely-seeded houses of one style shares 2 texture sets per kind rather
 * than minting 20. Cached by `(kind, seed % SURFACE_VARIANTS, size, flat)`.
 */
export function styleSurface(kind, seed, { size = DEFAULT_SIZE[kind] ?? 512, flat = false } = {}) {
  if (!KINDS.includes(kind)) return null;
  const variant = surfaceVariantOf(seed);
  const key = `${kind}|${variant}|${size}|${flat}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const albedo = tryCanvas(size), normal = tryCanvas(size), rough = tryCanvas(size);
  if (!albedo || !normal || !rough) return null;
  const rng = createRng(hashSeed(kind, variant));
  if (flat) paintFlat(kind, albedo.ctx, normal.ctx, rough.ctx, size, rng);
  else PATTERNS[kind](albedo.ctx, normal.ctx, rough.ctx, size, rng);

  const map = new THREE.CanvasTexture(albedo.canvas), normalMap = new THREE.CanvasTexture(normal.canvas), roughnessMap = new THREE.CanvasTexture(rough.canvas);
  map.name = `Style surface · ${kind} albedo`; map.colorSpace = THREE.SRGBColorSpace;
  normalMap.name = `Style surface · ${kind} normal`; normalMap.colorSpace = THREE.NoColorSpace;
  roughnessMap.name = `Style surface · ${kind} roughness`; roughnessMap.colorSpace = THREE.NoColorSpace;
  for (const texture of [map, normalMap, roughnessMap]) {
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.minFilter = THREE.LinearMipmapLinearFilter; texture.magFilter = THREE.LinearFilter;
    texture.anisotropy = 4; texture.generateMipmaps = true; texture.needsUpdate = true;
  }
  const entry = Object.freeze({ map, normalMap, roughnessMap, repeat: [...TILE_METRES[kind]] });
  cache.set(key, entry);
  return entry;
}

export const STYLE_SURFACE_KINDS = KINDS;

// ---------------------------------------------------------------------------------------------
// Style surface ARRAYS (World production plan §3, item 1): one shared `DataArrayTexture` per
// channel (albedo/normal/roughness) for the whole scene, so `ArchitectureComponent` can give
// every role ONE node material instead of one per (style, seed, palette). A layer is a
// `(kind, variant, flat)` combination — the same three inputs `styleSurface` already caches on,
// minus `size` (an array layer is always `ARRAY_TILE_SIZE`).
//
// STATIC LAYOUT (owner verdict, live freeze ledger: 13958 ms of `gpu:writeTexture`, 394 MB
// written in 825 writes over 14.1 s): the old registry grew ONE COMBINATION AT A TIME as
// buildings registered, and every growth replaced and fully re-uploaded all three arrays —
// classic O(n^2) re-upload as a scene's building count climbed. `STATIC_LAYERS`, below, is
// instead derived ONCE from `catalog.js`'s own data: every `(kind, flat)` any of the 7
// catalogue styles can actually reach (mirroring `formGeometry.js`'s `surfaceKindForRole`
// switch for every role a styled building emits), crossed with `SURFACE_VARIANTS`. It changes
// only when `catalog.js` itself gains a style that reaches a new kind/family — never at
// runtime, never because a scene registers a building. `layerIndexFor` is therefore a pure
// lookup into this fixed table (same answer before and after any building registers), and the
// three `DataArrayTexture`s are allocated ONCE, at this table's fixed size, and never rebuilt
// or replaced again. "glass" is excluded — its role hardcodes layer 0 and never samples the
// array (`formGeometry.js`'s `styleVertexInfo`) — and "metal" is excluded — no catalogue style
// ships a metal roof yet, so a request for it folds onto layer 0 exactly like any other
// request outside this static table, rather than reserving space nothing currently uses.
/** One array layer per surface kind in the catalogue's fixed kind list. Stylized styles no longer
 * need flat variants: the material scales texture strength per vertex (styleTint.a). */
export const STATIC_LAYERS = Object.freeze(SURFACE_KINDS.map(kind => Object.freeze({ kind, variant: 0, flat: false })));

export const MAX_ARRAY_LAYERS = STATIC_LAYERS.length;
// A single `DataArrayTexture` requires every layer to share one size, and a role's shared
// material must be able to sample ANY kind that role can resolve to — so every layer paints at
// one uniform resolution rather than the mixed 512/256 `DEFAULT_SIZE` table `styleSurface`'s own
// single-texture path uses. 256² keeps the whole static table's three arrays, mip-mapped, at
// `MAX_ARRAY_LAYERS * 256 * 256 * 16` bytes total (16 = 4 bytes/texel * 4/3 mip overhead * 3
// arrays) — see `architecture-styles.test.mjs` for the measured total.
export const ARRAY_TILE_SIZE = 256;

function layerRegistryKey(kind, variant, flat) { return `${kind}|${variant}|${flat ? 1 : 0}`; }

const STATIC_LAYER_INDEX = new Map(STATIC_LAYERS.map((layer, i) => [layerRegistryKey(layer.kind, layer.variant, layer.flat), i]));

const requestedLayers = []; // insertion-ordered indices actually asked for by a real build
const requestedSet = new Set();
let capWarned = false;

/**
 * The stable layer index for `(kind, variant, flat)` inside the shared style-surface arrays —
 * a PURE lookup into `STATIC_LAYERS`, computed once at module load: calling this before or
 * after any number of other registrations returns the exact same index for the exact same
 * inputs. `variant` is folded (`surfaceVariantOf`-equivalent); an unknown `kind` folds to
 * `"plaster"` rather than throwing, matching `styleSurface`'s own never-throw contract. A
 * `(kind, variant, flat)` the current catalogue never reaches (e.g. a manually authored
 * "metal" combination) folds onto layer 0 with one console warning, the same graceful
 * degradation the old cap used — a wrong look, never a crash or a table growth. Recording the
 * request (for the incremental paint pump below) is a side effect on DEMAND tracking only; it
 * never changes the returned index.
 */
export function layerIndexFor(kind) {
  const resolvedKind = SURFACE_KINDS.includes(kind) ? kind : "plaster";
  const index = STATIC_LAYER_INDEX.get(layerRegistryKey(resolvedKind, 0, false));
  if (!requestedSet.has(index)) { requestedSet.add(index); requestedLayers.push(index); scheduleFramePump(); }
  return index;
}

function hasDocument() { return typeof document !== "undefined" && typeof document.createElement === "function"; }

let arrayState = null; // { map, normalMap, roughnessMap, representativeMap, layers } — allocated ONCE, ever
const paintedFlags = new Uint8Array(MAX_ARRAY_LAYERS); // index -> already painted+uploaded
const cachedBytes = new Map(); // index -> { albedo, normal, rough } prefetched from disk cache, not yet applied
let cacheAdapter = null; // { read(path) -> Promise<Uint8Array|null>, write(path, bytes) -> Promise<void> }

/** Wires an optional disk-cache adapter (the editor's Tauri fs bridge, or the exported player's
 * fetch-based reader/writer — see `src/engine/assetResolver.js`'s `loadAssetBinary`/
 * `saveAssetBinary`). With no adapter configured (Node, a build worker, a host that never calls
 * this), every layer simply paints on canvas every time, exactly like before this cache existed. */
export function configureStyleSurfaceCache(adapter) {
  cacheAdapter = adapter && typeof adapter.read === "function" && typeof adapter.write === "function" ? adapter : null;
}

/** Project-relative cache path for one layer's one channel, PNG-encoded at `ARRAY_TILE_SIZE`. */
export function styleSurfaceCacheRelativePath(kind, variant, flat, channel) {
  return `architecture/style-surfaces/${kind}-v${variant}-${flat ? "flat" : "real"}-${ARRAY_TILE_SIZE}-${channel}.png`;
}

/** Every file the static table can ever address — a build/export step ships whichever of these
 * already exist under the project's derived-data cache; a missing one is a normal, safe miss
 * (the player paints it once at first boot, same as any other cache miss). */
export function styleSurfaceCacheFileList() {
  const files = [];
  for (const { kind, variant, flat } of STATIC_LAYERS) {
    for (const channel of ["albedo", "normal", "rough"]) files.push(styleSurfaceCacheRelativePath(kind, variant, flat, channel));
  }
  return files;
}

/** Browser-native PNG encode/decode via `OffscreenCanvas` — no dependency on any editor-only
 * codec, so this stays safe to import from a shipped player module. `null` wherever
 * `OffscreenCanvas` doesn't exist (Node, a build worker), matching every other no-canvas
 * contract in this file. */
async function encodeChannelPng(bytes, size) {
  if (typeof OffscreenCanvas === "undefined") return null;
  try {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext("2d");
    ctx.putImageData(new ImageData(new Uint8ClampedArray(bytes.slice()), size, size), 0, 0);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    return new Uint8Array(await blob.arrayBuffer());
  } catch { return null; }
}
async function decodeChannelPng(pngBytes, size) {
  if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap === "undefined") return null;
  try {
    const bitmap = await createImageBitmap(new Blob([pngBytes], { type: "image/png" }));
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close?.();
    return new Uint8Array(ctx.getImageData(0, 0, size, size).data.buffer);
  } catch { return null; }
}

/** Best-effort disk-cache write-back for a freshly painted layer — fire-and-forget, never
 * blocks or throws into the caller: a failed cache write costs a future re-paint, not a broken
 * frame. No-op with no adapter configured or no `OffscreenCanvas` (Node/build worker). */
function schedulePersistLayer(kind, variant, flat, data) {
  if (!cacheAdapter) return;
  Promise.all([
    encodeChannelPng(data.albedo, ARRAY_TILE_SIZE),
    encodeChannelPng(data.normal, ARRAY_TILE_SIZE),
    encodeChannelPng(data.rough, ARRAY_TILE_SIZE),
  ]).then(([albedoPng, normalPng, roughPng]) => Promise.all([
    albedoPng && cacheAdapter?.write(styleSurfaceCacheRelativePath(kind, variant, flat, "albedo"), albedoPng),
    normalPng && cacheAdapter?.write(styleSurfaceCacheRelativePath(kind, variant, flat, "normal"), normalPng),
    roughPng && cacheAdapter?.write(styleSurfaceCacheRelativePath(kind, variant, flat, "rough"), roughPng),
  ])).catch(() => {});
}

/** Best-effort disk-cache PREFETCH for one layer, kicked off the moment it is first requested
 * (`layerIndexFor`) — by the time the synchronous paint pump reaches this layer, a fast local
 * read often has already resolved into `cachedBytes`, letting the pump skip its (slower) canvas
 * paint entirely. A cache miss, a slow read that loses the race, or no adapter at all just falls
 * through to painting, same as always. */
function schedulePrefetchLayer(index, kind, variant, flat) {
  if (!cacheAdapter || paintedFlags[index] || cachedBytes.has(index)) return;
  Promise.all([
    cacheAdapter.read(styleSurfaceCacheRelativePath(kind, variant, flat, "albedo")),
    cacheAdapter.read(styleSurfaceCacheRelativePath(kind, variant, flat, "normal")),
    cacheAdapter.read(styleSurfaceCacheRelativePath(kind, variant, flat, "rough")),
  ]).then(async ([albedoPng, normalPng, roughPng]) => {
    if (!albedoPng || !normalPng || !roughPng || paintedFlags[index]) return;
    const [albedo, normal, rough] = await Promise.all([
      decodeChannelPng(albedoPng, ARRAY_TILE_SIZE),
      decodeChannelPng(normalPng, ARRAY_TILE_SIZE),
      decodeChannelPng(roughPng, ARRAY_TILE_SIZE),
    ]);
    if (albedo && normal && rough && !paintedFlags[index]) cachedBytes.set(index, { albedo, normal, rough });
  }).catch(() => {});
}

function placeholderBytes(size, r, g, b) {
  const out = new Uint8Array(size * size * 4);
  for (let i = 0; i < out.length; i += 4) { out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = 255; }
  return out;
}

/** Vertically flips `canvas`'s pixel bytes (top row <-> bottom row): a plain 2D canvas reads
 * top-row-first, matching a `flipY:true` CanvasTexture's convention (`styleSurface`'s own
 * single-texture path), but a `DataArrayTexture` layer is uploaded with `flipY:false` — so the
 * flip that would otherwise happen at upload has to be baked into the bytes here instead
 * (the same trick `src/engine/uberMaterial.js`'s `rasterise` uses for the same reason). */
function flippedBytes(canvas, size) {
  const bytes = new Uint8Array(canvas.getContext("2d").getImageData(0, 0, size, size).data.buffer);
  const row = size * 4, flipped = new Uint8Array(bytes.length);
  for (let y = 0; y < size; y++) flipped.set(bytes.subarray(y * row, y * row + row), (size - 1 - y) * row);
  return flipped;
}

/** Paints (or fetches from `styleSurface`'s own cache) the three canvases for one array layer,
 * always at `ARRAY_TILE_SIZE` regardless of `kind`'s smaller single-texture default — reusing
 * `styleSurface` is "the same canvas painters" the plan calls for, not a second implementation. */
function paintArrayLayer(kind, variant, flat) {
  const surface = styleSurface(kind, variant, { size: ARRAY_TILE_SIZE, flat });
  if (!surface) return null;
  return {
    albedo: normalizeAlbedo(flippedBytes(surface.map.image, ARRAY_TILE_SIZE)),
    normal: flippedBytes(surface.normalMap.image, ARRAY_TILE_SIZE),
    rough: flippedBytes(surface.roughnessMap.image, ARRAY_TILE_SIZE),
    representative: surface.map,
  };
}

/** Luminance-normalised albedo (mean linear luminance ALBEDO_MEAN, 30 % of the painted chroma):
 * the palette tint carries the colour, so a brown texture never darkens a grey stone palette; the
 * material divides by ALBEDO_MEAN so a tint is reproduced exactly on average. */
export const ALBEDO_MEAN = 0.7;
function normalizeAlbedo(bytes) {
  const toByte = v => { const c = Math.max(0, Math.min(1, v)); return Math.round((c <= .0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - .055) * 255); };
  const lut = new Float32Array(256); for (let i = 0; i < 256; i++) { const c = i / 255; lut[i] = c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; }
  let sum = 0; const n = bytes.length / 4;
  for (let i = 0; i < bytes.length; i += 4) sum += .2126 * lut[bytes[i]] + .7152 * lut[bytes[i + 1]] + .0722 * lut[bytes[i + 2]];
  const scale = ALBEDO_MEAN / Math.max(1e-4, sum / n), out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 4) {
    const r = lut[bytes[i]], g = lut[bytes[i + 1]], b = lut[bytes[i + 2]], y = .2126 * r + .7152 * g + .0722 * b;
    out[i] = toByte((y + (r - y) * .3) * scale); out[i + 1] = toByte((y + (g - y) * .3) * scale); out[i + 2] = toByte((y + (b - y) * .3) * scale); out[i + 3] = 255;
  }
  return out;
}

function makeArrayTexture(data, count, colorSpace, name) {
  const tex = new THREE.DataArrayTexture(data, ARRAY_TILE_SIZE, ARRAY_TILE_SIZE, count);
  tex.colorSpace = colorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4; tex.generateMipmaps = true; tex.flipY = false;
  // The whole buffer is a real (placeholder) upload once, at allocation. Every layer painted
  // afterward uploads through `addLayerUpdate` instead — see `writeLayerBytes` below.
  tex.needsUpdate = true;
  tex.name = name;
  return tex;
}

/** Allocates the three shared arrays EXACTLY ONCE, at their final `MAX_ARRAY_LAYERS` size, filled
 * with a neutral placeholder (mid-grey albedo, flat normal, mid roughness) for every layer not
 * yet painted — so an unpainted layer reads as an inert flat surface, never garbage or black.
 * Never called again once `arrayState` exists: no consumer of this module ever sees the texture
 * objects change identity after their first appearance. */
function allocateArrayState() {
  if (arrayState) return arrayState;
  const count = MAX_ARRAY_LAYERS, stride = ARRAY_TILE_SIZE * ARRAY_TILE_SIZE * 4;
  const albedoData = new Uint8Array(stride * count), normalData = new Uint8Array(stride * count), roughData = new Uint8Array(stride * count);
  const placeholderAlbedo = placeholderBytes(ARRAY_TILE_SIZE, 128, 128, 128);
  const placeholderNormal = placeholderBytes(ARRAY_TILE_SIZE, 128, 128, 255);
  const placeholderRough = placeholderBytes(ARRAY_TILE_SIZE, 170, 170, 170);
  for (let i = 0; i < count; i++) {
    albedoData.set(placeholderAlbedo, i * stride);
    normalData.set(placeholderNormal, i * stride);
    roughData.set(placeholderRough, i * stride);
  }
  arrayState = {
    map: makeArrayTexture(albedoData, count, THREE.SRGBColorSpace, "Style surface array · albedo"),
    normalMap: makeArrayTexture(normalData, count, THREE.NoColorSpace, "Style surface array · normal"),
    roughnessMap: makeArrayTexture(roughData, count, THREE.NoColorSpace, "Style surface array · roughness"),
    representativeMap: null, // set once the first real layer paints, below
    layers: count,
  };
  return arrayState;
}

/** Writes one already-painted layer's bytes into the shared arrays' backing buffers and queues a
 * PER-LAYER GPU upload (`addLayerUpdate`) — never a whole-array re-upload, and (guarded by
 * `paintedFlags`) never the same layer twice. This is the fix for the freeze ledger's 825 whole-
 * array `writeTexture` calls: every layer now uploads exactly once, ever. */
function writeLayerBytes(index, albedo, normal, rough) {
  const stride = ARRAY_TILE_SIZE * ARRAY_TILE_SIZE * 4;
  arrayState.map.image.data.set(albedo, index * stride);
  arrayState.normalMap.image.data.set(normal, index * stride);
  arrayState.roughnessMap.image.data.set(rough, index * stride);
  arrayState.map.addLayerUpdate(index);
  arrayState.normalMap.addLayerUpdate(index);
  arrayState.roughnessMap.addLayerUpdate(index);
  arrayState.map.needsUpdate = true;
  arrayState.normalMap.needsUpdate = true;
  arrayState.roughnessMap.needsUpdate = true;
  paintedFlags[index] = 1;
  cachedBytes.delete(index);
}

const PUMP_BUDGET_DEFAULT = 2;
let rafScheduled = false;

/** Keeps the incremental pump running via `requestAnimationFrame` (the real editor/player
 * runtime) until every requested layer has painted, so a scene that registers many buildings in
 * one synchronous burst still spreads its uploads across frames instead of draining the whole
 * queue in one JS turn. A no-op wherever `requestAnimationFrame` doesn't exist (Node, a build
 * worker, most tests) — those callers drive `pumpStyleSurfaceArray` explicitly instead. */
function scheduleFramePump() {
  if (rafScheduled || typeof requestAnimationFrame !== "function" || !hasDocument()) return;
  rafScheduled = true;
  requestAnimationFrame(() => {
    rafScheduled = false;
    const { done } = pumpStyleSurfaceArray(PUMP_BUDGET_DEFAULT);
    if (!done) scheduleFramePump();
  });
}

/**
 * Paints and uploads up to `maxLayers` (default 2) not-yet-painted, already-REQUESTED array
 * layers — a disk-cache hit skips the canvas paint entirely (`cachedBytes`, filled by
 * `schedulePrefetchLayer`); a miss paints on canvas, same as before, and schedules a best-effort
 * write-back (`schedulePersistLayer`). Each layer uploads through exactly one `addLayerUpdate`
 * call per texture, ever — never a whole-array re-upload (`writeLayerBytes`).
 *
 * Returns `{ painted, done }`: `painted` is how many layers this call actually finished (0 in
 * Node/a build worker, or once nothing is left to do); `done` is true once every requested layer
 * has painted. Safe to call every frame, or not at all — nothing here throws or blocks.
 */
export function pumpStyleSurfaceArray(maxLayers = PUMP_BUDGET_DEFAULT) {
  if (!requestedLayers.length || !hasDocument()) return { painted: 0, done: false };
  const state = allocateArrayState();
  let painted = 0;
  for (const index of requestedLayers) {
    if (painted >= maxLayers) break;
    if (paintedFlags[index]) continue;
    const { kind, variant, flat } = STATIC_LAYERS[index];
    const cached = cachedBytes.get(index);
    if (cached) {
      writeLayerBytes(index, cached.albedo, cached.normal, cached.rough);
      painted++;
      continue;
    }
    schedulePrefetchLayer(index, kind, variant, flat);
    const data = paintArrayLayer(kind, variant, flat);
    if (!data) return { painted, done: false }; // no document yet (shouldn't happen past hasDocument(), but never throw)
    writeLayerBytes(index, data.albedo, data.normal, data.rough);
    if (!state.representativeMap) state.representativeMap = data.representative;
    schedulePersistLayer(kind, variant, flat, data);
    painted++;
  }
  return { painted, done: requestedLayers.every((i) => paintedFlags[i]) };
}

/**
 * `styleSurfaceArray(kinds) -> { map, normalMap, roughnessMap, representativeMap, layers } | null`
 * (World production plan §3, item 1). Returns the ONE shared set of three `DataArrayTexture`s
 * (`ARRAY_TILE_SIZE` layers, mip-mapped, `MAX_ARRAY_LAYERS` deep — see `STATIC_LAYERS` above),
 * plus `representativeMap`, a plain 2D texture for whichever combination painted first (used by
 * `ArchitectureComponent` as GI's classic-`map` fallback; World production plan §3, item 4).
 *
 * `kinds`, if given, is an array of kind strings to PRE-register (both variants, both flat
 * states) before building — a convenience for a caller that knows what a scene needs before any
 * geometry exists; every real registration in this codebase happens lazily through
 * `layerIndexFor` instead, so this is optional. Since the layer table is now static, this no
 * longer changes which index anything resolves to — it only nudges the paint pump's order.
 *
 * Returns `null` wherever there is no `document` (Node, a build worker) or nothing has been
 * requested yet, so the caller falls back to a flat tint-only material — same contract as
 * `styleSurface`. The returned object's IDENTITY never changes after the first non-null return:
 * this call (via `pumpStyleSurfaceArray`) only ever fills in MORE of the same three texture
 * objects' layers, never replaces or rebuilds them.
 */
export function styleSurfaceArray(kinds) {
  if (Array.isArray(kinds)) {
    for (const kind of kinds) for (let variant = 0; variant < SURFACE_VARIANTS; variant++) for (const flat of [false, true]) layerIndexFor(kind, variant, flat);
  }
  if (!requestedLayers.length || !hasDocument()) return null;
  pumpStyleSurfaceArray();
  return arrayState;
}

/**
 * Rewrites `geometry`'s existing `uv` attribute in place so every vertex's UV
 * is the METRE coordinate of its own position projected onto its own face
 * plane (World production plan §3): `tangent` is the horizontal direction
 * perpendicular to the face normal (or world +X for a near-vertical normal,
 * i.e. a top/bottom face), `vertical` is `normal × tangent` — the exact same
 * formula `formGeometry.js`'s `emitFace` already uses for the base massing,
 * so a decorator's own geometry (roof strips along the eave/slope, fascia,
 * chimneys, dormers, frames, sills, shutters, door leaves, plinths, quoins,
 * cornices, timber, plank and log courses, ...) tiles a texture exactly the
 * way the wall/roof faces it sits against already do: a 0.07 m brick course
 * is 0.07 m tall everywhere, independent of the mesh's own vertex density.
 *
 * `matrix`, if given, is applied to the geometry first (`applyMatrix4`, which
 * also carries the normal along) — so a caller can fold "place this part in
 * model space" and "give it a metre UV in that space" into one call. Every
 * matrix the style decorators build for a part (wall/roof face bases via
 * `makeBasis` of orthonormal tangent/up/normal vectors) is a rigid rotation +
 * translation, so local metre lengths already equal model-space metre
 * lengths — the UV stays exact regardless of a form's `rotationY`.
 *
 * A no-op (returns `geometry` unchanged) when position/normal/uv aren't all
 * present with matching vertex counts — every primitive the decorators build
 * (BoxGeometry, CylinderGeometry, ShapeGeometry, ExtrudeGeometry) always sets
 * all three, so this only guards against a future primitive that doesn't.
 */
export function metreUvs(geometry, matrix) {
  if (matrix) geometry.applyMatrix4(matrix);
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const uv = geometry.getAttribute("uv");
  if (!position || !normal || !uv || uv.count !== position.count) return geometry;
  for (let i = 0; i < position.count; i++) {
    const nx = normal.getX(i), ny = normal.getY(i), nz = normal.getZ(i);
    const nLen = Math.hypot(nx, ny, nz) || 1;
    const ux = nx / nLen, uy = ny / nLen, uz = nz / nLen;
    let tx, tz;
    if (Math.abs(uy) > 0.9) { tx = 1; tz = 0; }
    else { const tLen = Math.hypot(uz, ux) || 1; tx = uz / tLen; tz = -ux / tLen; }
    // vertical = normal × tangent (tangent has no y component).
    let vx = uy * tz, vy = uz * tx - ux * tz, vz = -uy * tx;
    const vLen = Math.hypot(vx, vy, vz) || 1;
    vx /= vLen; vy /= vLen; vz /= vLen;
    const px = position.getX(i), py = position.getY(i), pz = position.getZ(i);
    uv.setXY(i, px * tx + pz * tz, px * vx + py * vy + pz * vz);
  }
  uv.needsUpdate = true;
  return geometry;
}
