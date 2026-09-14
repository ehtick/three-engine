import { erodeHeightfield } from '../src/engine/terrain/terrainErosion.js';
import { createTerrainShape } from '../src/engine/terrain/proceduralTerrain.js';

function bake(shape, extent, resolution) {
  const cols = resolution + 1, half = extent / 2, step = extent / resolution;
  const heights = new Float32Array(cols * cols);
  const work = {};
  for (let r = 0; r < cols; r++) {
    const z = -half + r * step;
    for (let c = 0; c < cols; c++) { shape.evaluate(c * step - half, z, work); heights[r * cols + c] = work.height; }
  }
  return heights;
}
function laplacian(heights, cols, i) {
  const mean = (heights[i - 1] + heights[i + 1] + heights[i - cols] + heights[i + cols]) * .25;
  return heights[i] - mean;
}
function boxBlur3(heights, cols) {
  const out = new Float32Array(heights.length);
  for (let z = 0; z < cols; z++) for (let x = 0; x < cols; x++) {
    let sum = 0, n = 0;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const nz = z + dz, nx = x + dx;
      if (nz < 0 || nz >= cols || nx < 0 || nx >= cols) continue;
      sum += heights[nz * cols + nx]; n++;
    }
    out[z * cols + x] = sum / n;
  }
  return out;
}
function hfEnergy(heights, cols) {
  const blurred = boxBlur3(heights, cols);
  let sum = 0;
  for (let i = 0; i < heights.length; i++) sum += Math.abs(heights[i] - blurred[i]);
  return sum / heights.length;
}
function sum(h) { let s = 0; for (const v of h) s += v; return s; }

const extent = 256, resolution = 384, step = extent / resolution;
const shape = createTerrainShape({ seed: 41, extent, terrain: { macroShape: 'highland', ridged: 1, warp: 1, roughness: 1.4 }, relief: 1.3 });
const raw = bake(shape, extent, resolution), cols = resolution + 1;

const eroded = raw.slice();
const t0 = performance.now();
erodeHeightfield(eroded, resolution, { seed: 3, strength: .6, cellSize: step });
console.log('ms', (performance.now() - t0).toFixed(1));
console.log('volume delta%', (100 * Math.abs(sum(eroded) - sum(raw)) / Math.abs(sum(raw))).toFixed(3));

// crease metric: 99th percentile threshold on raw, fraction above it
const lapsRaw = [];
for (let z = 1; z < cols - 1; z++) for (let x = 1; x < cols - 1; x++) lapsRaw.push(Math.abs(laplacian(raw, cols, z * cols + x)));
lapsRaw.sort((a, b) => a - b);
const threshold = lapsRaw[Math.floor(lapsRaw.length * .99)];
let aboveRaw = 0, aboveEroded = 0, total = 0;
for (let z = 1; z < cols - 1; z++) for (let x = 1; x < cols - 1; x++) {
  const i = z * cols + x; total++;
  if (Math.abs(laplacian(raw, cols, i)) > threshold) aboveRaw++;
  if (Math.abs(laplacian(eroded, cols, i)) > threshold) aboveEroded++;
}
console.log('crease frac raw', (aboveRaw / total).toFixed(4), 'eroded', (aboveEroded / total).toFixed(4), 'drop%', (100 * (1 - aboveEroded / aboveRaw)).toFixed(1));

console.log('hf energy raw', hfEnergy(raw, cols).toFixed(4), 'eroded', hfEnergy(eroded, cols).toFixed(4));

// timing at default valley too
const shape2 = createTerrainShape({ seed: 894, extent, terrain: { macroShape: 'valley' }, relief: 1 });
const raw2 = bake(shape2, extent, resolution);
const eroded2 = raw2.slice();
const t1 = performance.now();
erodeHeightfield(eroded2, resolution, { seed: 1, strength: .6, cellSize: step });
console.log('ms(valley)', (performance.now() - t1).toFixed(1));
