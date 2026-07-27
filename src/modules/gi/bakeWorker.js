// Bake worker: runs the CPU bake (rasterize + direct light + EDT) off the
// main thread, and OWNS the bake state between jobs:
//   - geometry payloads arrive ONCE per (geometry id, version) key and are
//     cached — a drag re-sends only ids + matrices + colors (~100 bytes per
//     mesh instead of megabytes of vertex data per re-bake)
//   - each job is a full description of desired scene state; the worker
//     diffs it against its own record cache and picks INCREMENTAL (region)
//     or FULL bake itself — so latest-wins job coalescing stays correct
//   - results go back as changed-range SLICES (transferred), so the arrays
//     persist here and the main thread applies cheap partial GPU uploads.
import { allocateBakeArrays, bakeMeshSdf, recordWorldAabb, runBake, runIncrementalBake } from "./bakeCore.js";

let arrays = null;
let prev = null; // persistent copy of the last result, diff baseline
let allocatedCellCount = -1;
const geometries = new Map(); // geometryKey → { positions, index, localAabb }
let lastRecords = new Map(); // id → plain record (matrix/colors/worldAabb, no positions)
let lastLightsKey = "";
let hasBake = false;

// [startFloat, endFloatExclusive] of differing elements within [lo, hi), or null.
const diffRange = (current, previous, lo, hi) => {
  let start = lo;
  while (start < hi && current[start] === previous[start]) start++;
  if (start === hi) return null;
  let end = hi - 1;
  while (end > start && current[end] === previous[end]) end--;
  return [start, end + 1];
};

const matricesEqual = (a, b) => {
  for (let i = 0; i < 16; i++) if (a[i] !== b[i]) return false;
  return true;
};
const colorsEqual = (a, b) => a.r === b.r && a.g === b.g && a.b === b.b;
const recordChanged = (old, next) =>
  !old ||
  old.geometryKey !== next.geometryKey ||
  old.emissiveIntensity !== next.emissiveIntensity ||
  old.excludeFromDistanceField !== next.excludeFromDistanceField ||
  !colorsEqual(old.color, next.color) ||
  !colorsEqual(old.emissive, next.emissive) ||
  !matricesEqual(old.matrix, next.matrix);

self.onmessage = (event) => {
  // Per-mesh SDF bake requests share the worker (and its geometry cache).
  if (event.data.type === "meshSdf") {
    const { requestId, geometryKey, geometry, maxAxisRes } = event.data;
    if (geometry) {
      geometries.set(geometryKey, { positions: geometry.positions, index: geometry.index, localAabb: null });
    }
    const cached = geometries.get(geometryKey);
    if (!cached) {
      self.postMessage({ type: "meshSdf", requestId, error: `unknown geometry ${geometryKey}` });
      return;
    }
    const started = performance.now();
    const sdf = bakeMeshSdf(cached.positions, cached.index, maxAxisRes || undefined);
    self.postMessage(
      { type: "meshSdf", requestId, geometryKey, sdf, elapsed: performance.now() - started },
      [sdf.data.buffer],
    );
    return;
  }

  const { jobId, records: wire, bounds, res, cell, lights } = event.data;
  const cellCount = res.x * res.y * res.z;
  if (cellCount !== allocatedCellCount) {
    arrays = allocateBakeArrays(cellCount);
    prev = {
      radiance: new Float32Array(cellCount * 4),
      surface: new Float32Array(cellCount * 4),
      normals: new Float32Array(cellCount * 4),
      distance: new Float32Array(cellCount),
    };
    allocatedCellCount = cellCount;
    lastRecords = new Map();
    hasBake = false;
  }
  const started = performance.now();

  // Resolve geometry refs (payloads are cached across jobs).
  const records = [];
  for (const w of wire) {
    if (w.geometry) {
      geometries.set(w.geometryKey, { positions: w.geometry.positions, index: w.geometry.index, localAabb: null });
    }
    const geometry = geometries.get(w.geometryKey);
    if (!geometry) continue; // protocol violation — skip rather than crash
    records.push({
      id: w.id,
      geometryKey: w.geometryKey,
      matrix: w.matrix,
      color: w.color,
      emissive: w.emissive,
      emissiveIntensity: w.emissiveIntensity,
      positions: geometry.positions,
      index: geometry.index,
      geometry,
    });
  }
  const lightsKey = JSON.stringify(lights);

  let stats = null;
  let touched = null; // region whose flat z-slab bounds the diff scan
  if (hasBake && lightsKey === lastLightsKey) {
    const dirtyAabbs = [];
    const seenIds = new Set();
    let changed = 0;
    for (const record of records) {
      seenIds.add(record.id);
      const old = lastRecords.get(record.id);
      if (recordChanged(old, record)) {
        changed++;
        if (old?.worldAabb) dirtyAabbs.push(old.worldAabb);
        record.worldAabb = recordWorldAabb(record, record.geometry);
        dirtyAabbs.push(record.worldAabb);
      } else {
        record.worldAabb = old.worldAabb;
      }
    }
    for (const [id, old] of lastRecords) {
      if (!seenIds.has(id)) {
        changed++;
        if (old.worldAabb) dirtyAabbs.push(old.worldAabb);
      }
    }
    if (changed === 0) {
      // Nothing actually differs (fingerprint noise) — no bake, no upload.
      self.postMessage({
        jobId,
        stats: null,
        elapsed: performance.now() - started,
        ranges: { radiance: null, surface: null, normals: null, distance: null },
      });
      return;
    }
    const result = runIncrementalBake({ records, dirtyAabbs, bounds, res, cell, lights, arrays });
    if (result) {
      stats = result;
      touched = result.touched ?? null;
    }
  }
  if (!stats) {
    for (const record of records) {
      if (!record.worldAabb) record.worldAabb = recordWorldAabb(record, record.geometry);
    }
    stats = runBake({ records, bounds, res, cell, lights, arrays });
  }
  lastRecords = new Map(
    records.map((r) => [
      r.id,
      {
        id: r.id,
        geometryKey: r.geometryKey,
        matrix: r.matrix,
        color: r.color,
        emissive: r.emissive,
        emissiveIntensity: r.emissiveIntensity,
        worldAabb: r.worldAabb,
      },
    ]),
  );
  lastLightsKey = lightsKey;
  hasBake = true;

  // Diff → changed-range slices; prev is patched per range so the arrays
  // stay here as the next job's baseline. `touched` (incremental) bounds
  // the scan to the z-slab the bake could have written.
  const cellLo = touched ? touched.z0 * res.y * res.x : 0;
  const cellHi = touched ? (touched.z1 + 1) * res.y * res.x : cellCount;
  const makeSlice = (current, previous, stride) => {
    const range = diffRange(current, previous, cellLo * stride, cellHi * stride);
    if (!range) return { range: null, slice: null };
    const slice = current.slice(range[0], range[1]);
    previous.set(slice, range[0]);
    return { range, slice };
  };
  const rad = makeSlice(arrays.radiance, prev.radiance, 4);
  const sur = makeSlice(arrays.surface, prev.surface, 4);
  const nor = makeSlice(arrays.normals, prev.normals, 4);
  const dis = makeSlice(arrays.distance, prev.distance, 1);
  const transfers = [rad, sur, nor, dis].filter((x) => x.slice).map((x) => x.slice.buffer);
  self.postMessage(
    {
      jobId,
      stats,
      mode: touched ? "incremental" : "full",
      elapsed: performance.now() - started,
      ranges: { radiance: rad.range, surface: sur.range, normals: nor.range, distance: dis.range },
      radiance: rad.slice,
      surface: sur.slice,
      normals: nor.slice,
      distance: dis.slice,
    },
    transfers,
  );
};
