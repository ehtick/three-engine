#!/usr/bin/env node
/**
 * Headless look receipt for `src/engine/terrain/landscapeGenerator.js` and the
 * stone that `src/engine/rocks/rockPlacement.js` puts on it.
 *
 *   node scripts/landscape-receipt.mjs [--styles a,b] [--seed 7] [--extent 1024]
 *     [--res 384] [--out dir] [--set levels=.8,wildness=.6] [--view wide|low] [--rocks 1]
 *
 * Writes one PNG per style: a perspective CPU ray-march of the heightfield
 * (sun + shadow + sky, slope/cliff/snow colouring, aerial fog) — with
 * `--rocks 1`, the placed rock library rasterized into it against the terrain
 * depth — beside a top-down hillshade. No GPU, no editor: judge the LANDFORM
 * and the STONE, not the final materials.
 */
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { createLandscape, fillLandscapeGrid, LANDSCAPE_STYLE_IDS } from '../src/engine/terrain/landscapeGenerator.js';
import { buildRockLibrary, instanceScale } from '../src/engine/rocks/rockLibrary.js';
import { placeRocks, rockKindsFor } from '../src/engine/rocks/rockPlacement.js';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, i, all) => {
  if (arg.startsWith('--')) pairs.push([arg.slice(2), all[i + 1]]);
  return pairs;
}, []));
const styles = (args.styles ?? LANDSCAPE_STYLE_IDS.join(',')).split(',');
const seed = Number(args.seed ?? 7);
const res = Number(args.res ?? 384);
const outDir = args.out ?? 'scratch';
const view = args.view ?? 'wide';
const withRocks = Number(args.rocks ?? 0) > 0;
const overrides = Object.fromEntries((args.set ?? '').split(',').filter(Boolean).map(kv => { const [k, v] = kv.split('='); return [k, Number(v)]; }));
const disable = (args.disable ?? '').split(',').filter(Boolean);
fs.mkdirSync(outDir, { recursive: true });

const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
const srgbToLinear = c => c.map(v => Math.pow(v, 2.2));
const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); };
const DEFAULT_EXTENT = { meadow: 512, hills: 768, highlands: 1024, alpine: 2048, canyon: 1024, karst: 768, shattered: 1536 };

for (const style of styles) {
  const extent = Number(args.extent ?? DEFAULT_EXTENT[style] ?? 1024);
  const t0 = performance.now();
  const land = createLandscape({ style, seed, extent, ...overrides, disable });
  const tMacro = performance.now() - t0;
  const cols = res + 1, cell = extent / res, half = extent / 2;
  const masks = new Float32Array(cols * cols * 4);
  const steps = fillLandscapeGrid(land, { x0: -half, z0: -half, size: extent, resolution: res, masks });
  let step = steps.next(); while (!step.done) step = steps.next();
  const H = step.value;
  const tFill = performance.now() - t0 - tMacro;
  let lo = Infinity, hi = -Infinity; for (const v of H) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  // Water surface per vertex (NaN where dry): lakes and rivers from the landscape's hydrology.
  const WL = new Float32Array(cols * cols).fill(NaN);
  if (land.hydrology) {
    const probe = {};
    for (let r = 0; r < cols; r++) for (let c = 0; c < cols; c++) {
      land.sample(-half + c * cell, -half + r * cell, probe);
      if (Number.isFinite(probe.water)) WL[r * cols + c] = probe.water;
    }
  }
  const waterAt = (x, z) => {
    const gx = Math.round((x + half) / cell), gz = Math.round((z + half) / cell);
    if (gx < 0 || gz < 0 || gx > res || gz > res) return NaN;
    return WL[gz * cols + gx];
  };

  const at = (gx, gz) => H[Math.max(0, Math.min(res, gz)) * cols + Math.max(0, Math.min(res, gx))];
  const height = (x, z) => {
    const gx = (x + half) / cell, gz = (z + half) / cell;
    if (gx < 0 || gz < 0 || gx > res || gz > res) return -Infinity;
    const ix = Math.min(res - 1, Math.floor(gx)), iz = Math.min(res - 1, Math.floor(gz)), tx = gx - ix, tz = gz - iz;
    const a = at(ix, iz), b = at(ix + 1, iz), c = at(ix, iz + 1), d = at(ix + 1, iz + 1);
    return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
  };
  const mask = (x, z, ch) => {
    const gx = Math.round((x + half) / cell), gz = Math.round((z + half) / cell);
    return masks[(Math.max(0, Math.min(res, gz)) * cols + Math.max(0, Math.min(res, gx))) * 4 + ch];
  };
  const normal = (x, z) => {
    const e = cell;
    const nx = height(x - e, z) - height(x + e, z), nz = height(x, z - e) - height(x, z + e), ny = 2 * e;
    const l = Math.hypot(nx, ny, nz); return [nx / l, ny / l, nz / l];
  };
  const pal = land.palette;
  const grass = srgbToLinear(hex(pal.grass)), soil = srgbToLinear(hex(pal.soil)), rock = srgbToLinear(hex(pal.rock));
  const snow = pal.snow ? srgbToLinear(hex(pal.snow)) : null;
  const sun = (() => { const v = [-.55, .5, -.35]; const l = Math.hypot(...v); return v.map(c => c / l); })();
  const shadowAt = (x, y, z) => {
    for (let t = cell * 2; t < extent * .6; t += Math.max(cell, t * .02)) {
      const px = x + sun[0] * t, py = y + sun[1] * t + .3, pz = z + sun[2] * t;
      const h = height(px, pz); if (h === -Infinity) break;
      if (h > py) return 0;
    }
    return 1;
  };
  const light = (base, n, x, y, z) => {
    const ndl = Math.max(0, n[0] * sun[0] + n[1] * sun[1] + n[2] * sun[2]);
    const lit = ndl > 0 ? shadowAt(x, y, z) : 0;
    const sky = .32 * (.55 + .45 * n[1]);
    return base.map((c, i) => c * (ndl * lit * [1.25, 1.12, .95][i] * 2.2 + sky * [.75, .85, 1.1][i]));
  };
  const shade = (x, y, z) => {
    const n = normal(x, z), slope = Math.sqrt(1 - n[1] * n[1]) / Math.max(.05, n[1]);
    const cliff = mask(x, z, 0), tower = mask(x, z, 1), flow = mask(x, z, 3);
    const rockAmt = clamp(smooth(.55, 1.1, slope) + cliff * .6 + tower * .5);
    let base = grass.map((g, i) => g + (soil[i] - g) * clamp(flow * .8 + smooth(.3, .6, slope) * .4));
    base = base.map((g, i) => g + (rock[i] - g) * rockAmt);
    if (snow) { const s = smooth(pal.snowline - 20, pal.snowline + 20, y) * (1 - smooth(.9, 1.6, slope)); base = base.map((g, i) => g + (snow[i] - g) * s); }
    return light(base, n, x, y, z);
  };

  // ---- perspective view ----
  const W = 640, Hh = 300;
  const img = Buffer.alloc(W * Hh * 3);
  const range = hi - lo;
  // The low camera clears everything within 60 m (it once spawned inside a tower).
  const groundMax = (x, z, r) => { let m = height(x, z); for (let k = 0; k < 24; k++) { const a = k / 24 * Math.PI * 2; for (const d of [r / 3, r * 2 / 3, r]) m = Math.max(m, height(x + Math.cos(a) * d, z + Math.sin(a) * d)); } return m; };
  const eye = view === 'low'
    ? [half * .55, groundMax(half * .55, half * .55, 60) + range * .06 + 8, half * .55]
    : [half * .98, hi + range * .12 + extent * .025, half * .98];
  const target = view === 'low' ? [-half * .2, lo + range * .45, -half * .2] : [-half * .1, lo + range * .3, -half * .1];
  const fwd = target.map((v, i) => v - eye[i]); { const l = Math.hypot(...fwd); fwd.forEach((v, i) => fwd[i] = v / l); }
  // right = fwd x worldUp, up = right x fwd: a right-handed, upright camera.
  const right = [-fwd[2], 0, fwd[0]]; { const l = Math.hypot(...right); right.forEach((v, i) => right[i] = v / l); }
  const up = [right[1] * fwd[2] - right[2] * fwd[1], right[2] * fwd[0] - right[0] * fwd[2], right[0] * fwd[1] - right[1] * fwd[0]];
  const tanF = Math.tan(50 * Math.PI / 360), aspect = W / Hh, maxT = extent * 2;
  const depthBuf = new Float32Array(W * Hh).fill(Infinity);
  const fogMix = (c, dist) => { const fog = 1 - Math.exp(-dist / (extent * 1.6)); return c.map((ch, i) => Math.pow(clamp(ch), 1 / 2.2) * (1 - fog) + [.62, .7, .8][i] * fog); };
  const put = (px, py, col) => { const o = (py * W + px) * 3; img[o] = clamp(col[0]) * 255; img[o + 1] = clamp(col[1]) * 255; img[o + 2] = clamp(col[2]) * 255; };
  for (let py = 0; py < Hh; py++) for (let px = 0; px < W; px++) {
    const u = ((px + .5) / W * 2 - 1) * tanF * aspect, v = (1 - (py + .5) / Hh * 2) * tanF;
    const dir = [0, 1, 2].map(i => fwd[i] + right[i] * u + up[i] * v); const dl = Math.hypot(...dir); dir.forEach((c, i) => dir[i] = c / dl);
    let t = 1, hit = null, prev = 0, wet = null;
    while (t < maxT) {
      const x = eye[0] + dir[0] * t, y = eye[1] + dir[1] * t, z = eye[2] + dir[2] * t;
      const h = height(x, z);
      const w = waterAt(x, z);
      if (Number.isFinite(w) && w > h && y <= w) { wet = { t, level: w, depth: w - h }; }
      if (wet || (h !== -Infinity && y <= h)) {
        if (wet) { hit = t; break; }
        let a = prev, b = t;
        for (let k = 0; k < 8; k++) { const m = (a + b) / 2; const yy = eye[1] + dir[1] * m; if (yy <= height(eye[0] + dir[0] * m, eye[2] + dir[2] * m)) b = m; else a = m; }
        hit = b; break;
      }
      prev = t;
      t += Math.max(cell * .35, h === -Infinity ? cell * 2 : (y - h) * .35);
    }
    let col = [.55 + .2 * (1 - v), .68 + .15 * (1 - v), .86];
    if (hit !== null) {
      const x = eye[0] + dir[0] * hit, z = eye[2] + dir[2] * hit, y = eye[1] + dir[1] * hit;
      if (wet) {
        const fresnel = .04 + .96 * Math.pow(1 - Math.abs(dir[1]), 5);
        const absorb = 1 - Math.exp(-wet.depth * .5);
        const body = [.16, .28, .27].map((d, i) => [.42, .44, .3][i] * (1 - absorb) + d * absorb);
        const sky = [.62, .72, .86];
        col = fogMix(body.map((b, i) => (b * (1 - fresnel) + sky[i] * fresnel) * .8), hit);
      } else col = fogMix(shade(x, y, z), hit);
      depthBuf[py * W + px] = hit * (dir[0] * fwd[0] + dir[1] * fwd[1] + dir[2] * fwd[2]);
    }
    put(px, py, col);
  }

  // ---- stone ----
  let rockReport = '';
  if (withRocks) {
    const tr = performance.now();
    const kinds = rockKindsFor(land, 3);
    const library = buildRockLibrary({ seed, kinds, columnar: (land.rockMix.columns ?? 0) > .5 ? 1 : 0, budgetScale: .6 });
    const tLib = performance.now() - tr;
    const placements = placeRocks(land, { x0: -half, z0: -half, size: extent, variants: kinds });
    const tPlace = performance.now() - tr - tLib;
    const counts = {};
    let drawnTris = 0;
    const rockAlbedo = rock, mossAlbedo = grass.map(c => c * .85);
    const P = [0, 0, 0];
    for (const placement of placements) {
      counts[placement.kind] = (counts[placement.kind] ?? 0) + 1;
      const variant = library.variants[placement.kind]?.[placement.variant % library.variants[placement.kind].length];
      if (!variant) continue;
      const [sx, sy, sz] = instanceScale(placement, variant), cy = Math.cos(placement.yaw), syaw = Math.sin(placement.yaw);
      const [ox, oy, oz] = placement.position;
      // Bounding-sphere cull.
      const rel0 = [ox - eye[0], oy - eye[1], oz - eye[2]];
      const vz0 = rel0[0] * fwd[0] + rel0[1] * fwd[1] + rel0[2] * fwd[2];
      const bound = Math.max(sx, sy, sz) * Math.max(...variant.bounds.map(Math.abs)) * 1.5;
      if (vz0 < -bound || bound / Math.max(1, vz0) * Hh / (2 * tanF) < .6) continue;
      const count = variant.positions.length / 3;
      const sxp = new Float32Array(count), syp = new Float32Array(count), vzp = new Float32Array(count), wp = new Float32Array(count * 3), wn = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        const lx = variant.positions[i * 3] * sx, ly = variant.positions[i * 3 + 1] * sy, lz = variant.positions[i * 3 + 2] * sz;
        P[0] = ox + lx * cy + lz * syaw; P[1] = oy + ly; P[2] = oz - lx * syaw + lz * cy;
        wp[i * 3] = P[0]; wp[i * 3 + 1] = P[1]; wp[i * 3 + 2] = P[2];
        let nx = variant.normals[i * 3] / sx, ny = variant.normals[i * 3 + 1] / sy, nz = variant.normals[i * 3 + 2] / sz;
        const rx = nx * cy + nz * syaw, rz = -nx * syaw + nz * cy, nl = Math.hypot(rx, ny, rz) || 1;
        wn[i * 3] = rx / nl; wn[i * 3 + 1] = ny / nl; wn[i * 3 + 2] = rz / nl;
        const rx0 = P[0] - eye[0], ry0 = P[1] - eye[1], rz0 = P[2] - eye[2];
        const vz = rx0 * fwd[0] + ry0 * fwd[1] + rz0 * fwd[2];
        vzp[i] = vz;
        sxp[i] = ((rx0 * right[0] + ry0 * right[1] + rz0 * right[2]) / vz / (tanF * aspect) + 1) * W / 2;
        syp[i] = (1 - (rx0 * up[0] + ry0 * up[1] + rz0 * up[2]) / vz / tanF) * Hh / 2;
      }
      const I = variant.indices;
      for (let t = 0; t < I.length; t += 3) {
        const a = I[t], b = I[t + 1], c = I[t + 2];
        if (vzp[a] < .5 || vzp[b] < .5 || vzp[c] < .5) continue;
        const ax = sxp[a], ay = syp[a], bx = sxp[b], by = syp[b], qx = sxp[c], qy = syp[c];
        const area = (bx - ax) * (qy - ay) - (by - ay) * (qx - ax);
        if (area >= 0) continue;
        const minX = Math.max(0, Math.floor(Math.min(ax, bx, qx))), maxX = Math.min(W - 1, Math.ceil(Math.max(ax, bx, qx)));
        const minY = Math.max(0, Math.floor(Math.min(ay, by, qy))), maxY = Math.min(Hh - 1, Math.ceil(Math.max(ay, by, qy)));
        if (minX > maxX || minY > maxY) continue;
        drawnTris++;
        for (let py = minY; py <= maxY; py++) for (let px = minX; px <= maxX; px++) {
          const X = px + .5, Y = py + .5;
          const w0 = ((bx - X) * (qy - Y) - (by - Y) * (qx - X)) / area;
          const w1 = ((qx - X) * (ay - Y) - (qy - Y) * (ax - X)) / area;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          const i0 = w0 / vzp[a], i1 = w1 / vzp[b], i2 = w2 / vzp[c], inv = i0 + i1 + i2;
          const depth = 1 / inv;
          const pi = py * W + px;
          if (depth >= depthBuf[pi] - .02) continue;
          depthBuf[pi] = depth;
          const k0 = i0 / inv, k1 = i1 / inv, k2 = i2 / inv;
          const x = wp[a * 3] * k0 + wp[b * 3] * k1 + wp[c * 3] * k2, y = wp[a * 3 + 1] * k0 + wp[b * 3 + 1] * k1 + wp[c * 3 + 1] * k2, z = wp[a * 3 + 2] * k0 + wp[b * 3 + 2] * k1 + wp[c * 3 + 2] * k2;
          let nx = wn[a * 3] * k0 + wn[b * 3] * k1 + wn[c * 3] * k2, ny = wn[a * 3 + 1] * k0 + wn[b * 3 + 1] * k1 + wn[c * 3 + 1] * k2, nz = wn[a * 3 + 2] * k0 + wn[b * 3 + 2] * k1 + wn[c * 3 + 2] * k2;
          const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
          const ao = variant.occlusion[a] * k0 + variant.occlusion[b] * k1 + variant.occlusion[c] * k2;
          const band = .9 + .1 * Math.sin(y * 1.3 + Math.sin(x * .05) * 2);
          const moss = smooth(.72, .95, ny) * .7;
          const base = rockAlbedo.map((r, i) => (r * band * (1 - moss) + mossAlbedo[i] * moss) * (.35 + .65 * ao));
          const dist = depth / Math.max(.1, (x - eye[0]) / Math.hypot(x - eye[0], y - eye[1], z - eye[2]) * fwd[0] + (y - eye[1]) / Math.hypot(x - eye[0], y - eye[1], z - eye[2]) * fwd[1] + (z - eye[2]) / Math.hypot(x - eye[0], y - eye[1], z - eye[2]) * fwd[2]);
          put(px, py, fogMix(light(base, [nx, ny, nz], x, y, z), dist));
        }
      }
    }
    rockReport = `, rocks ${placements.length} (${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}) library ${tLib.toFixed(0)} ms, place ${tPlace.toFixed(0)} ms, raster ${drawnTris} tris ${(performance.now() - tr - tLib - tPlace).toFixed(0)} ms`;
  }

  // ---- hillshade (top-down) ----
  const S = 300, top = Buffer.alloc(S * S * 3);
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
    const x = -half + (i + .5) / S * extent, z = -half + (j + .5) / S * extent;
    const y = height(x, z), n = normal(x, z);
    const lum = Math.max(0, n[0] * -.6 + n[1] * .55 + n[2] * -.58);
    const e = (y - lo) / (range || 1);
    const cliff = mask(x, z, 0);
    const o = (j * S + i) * 3;
    top[o] = clamp(lum * .9 + e * .15 + cliff * .25) * 255; top[o + 1] = clamp(lum * .9 + e * .15) * 255; top[o + 2] = clamp(lum * .85 + e * .2) * 255;
    const w = waterAt(x, z);
    if (Number.isFinite(w) && w > y + .05) { top[o] = 40; top[o + 1] = 90; top[o + 2] = 160; }
  }
  const file = path.join(outDir, `landscape-${style}-s${seed}${view === 'low' ? '-low' : ''}${withRocks ? '-rocks' : ''}${disable.length ? '-no-' + disable.join('-') : ''}.png`);
  await sharp({ create: { width: W + S, height: Math.max(Hh, S), channels: 3, background: '#000' } })
    .composite([
      { input: await sharp(img, { raw: { width: W, height: Hh, channels: 3 } }).png().toBuffer(), left: 0, top: 0 },
      { input: await sharp(top, { raw: { width: S, height: S, channels: 3 } }).png().toBuffer(), left: W, top: 0 },
    ]).png().toFile(file);
  console.log(`${style}: extent ${extent} m, relief ${lo.toFixed(1)}..${hi.toFixed(1)} m, macro ${tMacro.toFixed(0)} ms, fill ${res + 1}^2 ${tFill.toFixed(0)} ms (${(tFill / (cols * cols) * 1e3).toFixed(2)} us/sample)${rockReport} -> ${file}`);
}
