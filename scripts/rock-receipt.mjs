#!/usr/bin/env node
/**
 * Contact sheet for `src/engine/rocks/rockSdf.js`: meshes every kind with
 * `meshSignedDistance` and software-rasterizes the MESH (not the field), so the
 * receipt shows exactly what would ship — surface-nets topology, SDF normals,
 * cavity occlusion — under a sun + sky.
 *
 *   node scripts/rock-receipt.mjs [--seed 3] [--out dir] [--voxel 1]  (voxel = multiplier on each kind's default)
 */
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { createRockSdf } from '../src/engine/rocks/rockSdf.js';
import { meshSignedDistance } from '../src/engine/rocks/surfaceNets.js';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, i, all) => { if (arg.startsWith('--')) pairs.push([arg.slice(2), all[i + 1]]); return pairs; }, []));
const seed = Number(args.seed ?? 3), outDir = args.out ?? 'scratch', voxelScale = Number(args.voxel ?? 1);
fs.mkdirSync(outDir, { recursive: true });

const SPECS = [
  ['boulder', { size: 2.6 }], ['slab', { size: 5 }], ['ledge', { size: 10, height: 5 }], ['spire', { height: 26, radius: 4.5 }],
  ['columns', { width: 12, depth: 7, height: 14 }], ['arch', { span: 18, height: 11, thickness: 3.6 }],
  ['wall', { length: 18, height: 12, thickness: 5 }], ['wall', { length: 18, height: 15, thickness: 6, columnar: true }],
];
const T = 300, COLS = 4, ROWS = Math.ceil(SPECS.length / COLS);
const sheet = Buffer.alloc(T * COLS * T * ROWS * 3);
const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const sun = (() => { const v = [.55, .75, .4]; const l = Math.hypot(...v); return v.map(c => c / l); })();

for (let s = 0; s < SPECS.length; s++) {
  const [kind, params] = SPECS[s];
  const t0 = performance.now();
  const field = createRockSdf(kind, { ...params, seed: seed + s * 101 });
  const mesh = meshSignedDistance(field, field.voxel * voxelScale);
  const ms = performance.now() - t0;
  const { positions: P, normals: N, occlusion: O, indices: I } = mesh;

  // Orthographic 3/4 view fitted to the bounds.
  const [x0, y0, z0, x1, y1, z1] = field.bounds;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2, radius = Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2;
  const dir = (() => { const v = [.8, .5, 1]; const l = Math.hypot(...v); return v.map(c => c / l); })();   // toward camera
  const right = [dir[2], 0, -dir[0]]; { const l = Math.hypot(...right); right.forEach((c, i) => right[i] = c / l); }
  const up = [dir[1] * right[2] - dir[2] * right[1], dir[2] * right[0] - dir[0] * right[2], dir[0] * right[1] - dir[1] * right[0]];
  const scale = T * .46 / radius;
  const project = (i) => {
    const x = P[i * 3] - cx, y = P[i * 3 + 1] - cy, z = P[i * 3 + 2] - cz;
    return [T / 2 + (x * right[0] + y * right[1] + z * right[2]) * scale, T / 2 - (x * up[0] + y * up[1] + z * up[2]) * scale, x * dir[0] + y * dir[1] + z * dir[2]];
  };
  const tile = new Float32Array(T * T * 3), depth = new Float32Array(T * T).fill(-Infinity);
  for (let p = 0; p < T * T; p++) { const v = p / T / T; tile[p * 3] = .62 + .1 * v; tile[p * 3 + 1] = .7 + .08 * v; tile[p * 3 + 2] = .8; }
  const proj = new Float32Array((P.length / 3) * 3);
  for (let v = 0; v < P.length / 3; v++) { const q = project(v); proj[v * 3] = q[0]; proj[v * 3 + 1] = q[1]; proj[v * 3 + 2] = q[2]; }
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t], b = I[t + 1], c = I[t + 2];
    const ax = proj[a * 3], ay = proj[a * 3 + 1], bx = proj[b * 3], by = proj[b * 3 + 1], qx = proj[c * 3], qy = proj[c * 3 + 1];
    const area = (bx - ax) * (qy - ay) - (by - ay) * (qx - ax);
    if (area >= 0) continue; // back face (screen y is down)
    const minX = Math.max(0, Math.floor(Math.min(ax, bx, qx))), maxX = Math.min(T - 1, Math.ceil(Math.max(ax, bx, qx)));
    const minY = Math.max(0, Math.floor(Math.min(ay, by, qy))), maxY = Math.min(T - 1, Math.ceil(Math.max(ay, by, qy)));
    for (let py = minY; py <= maxY; py++) for (let px = minX; px <= maxX; px++) {
      const sx = px + .5, sy = py + .5;
      const w0 = ((bx - sx) * (qy - sy) - (by - sy) * (qx - sx)) / area;
      const w1 = ((qx - sx) * (ay - sy) - (qy - sy) * (ax - sx)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      const z = w0 * proj[a * 3 + 2] + w1 * proj[b * 3 + 2] + w2 * proj[c * 3 + 2];
      const pi = py * T + px;
      if (z <= depth[pi]) continue;
      depth[pi] = z;
      let nx = w0 * N[a * 3] + w1 * N[b * 3] + w2 * N[c * 3], ny = w0 * N[a * 3 + 1] + w1 * N[b * 3 + 1] + w2 * N[c * 3 + 1], nz = w0 * N[a * 3 + 2] + w1 * N[b * 3 + 2] + w2 * N[c * 3 + 2];
      const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
      const ao = w0 * O[a] + w1 * O[b] + w2 * O[c];
      const wy = w0 * P[a * 3 + 1] + w1 * P[b * 3 + 1] + w2 * P[c * 3 + 1];
      const band = .95 + .05 * Math.sin(wy * 2.1);
      const albedo = [.3 * band, .29 * band, .27 * band];
      const ndl = Math.max(0, nx * sun[0] + ny * sun[1] + nz * sun[2]);
      const sky = (.22 + .12 * ny) * ao;
      for (let k = 0; k < 3; k++) tile[pi * 3 + k] = albedo[k] * (ndl * [1.25, 1.12, .95][k] * (.45 + .55 * ao) * 2.6 + sky * [.8, .9, 1.15][k]);
    }
  }
  const col = s % COLS, row = Math.floor(s / COLS);
  for (let py = 0; py < T; py++) for (let px = 0; px < T; px++) {
    const o = ((row * T + py) * T * COLS + col * T + px) * 3, i = (py * T + px) * 3;
    for (let k = 0; k < 3; k++) sheet[o + k] = Math.round(Math.pow(clamp(tile[i + k]), 1 / 2.2) * 255);
  }
  console.log(`${kind}${params.columnar ? '(columnar)' : ''}: voxel ${(field.voxel * voxelScale).toFixed(3)} m, ${mesh.samples} samples (${mesh.evaluated} evaluated), ${I.length / 3} tris, ${ms.toFixed(0)} ms`);
}
const file = path.join(outDir, `rocks-s${seed}.png`);
await sharp(sheet, { raw: { width: T * COLS, height: T * ROWS, channels: 3 } }).png().toFile(file);
console.log(file);
