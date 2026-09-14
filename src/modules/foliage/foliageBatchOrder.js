import * as THREE from "three/webgpu";

// Opaque cutouts can write depth before the farther plants behind them. A
// coarse view direction keeps that order useful without uploading on every
// pointer move; translating the camera never changes relative view depth.
const yawStep = Math.PI / 4, pitchStep = Math.PI / 6, slack = Math.PI / 36;
const wrap = angle => Math.atan2(Math.sin(angle), Math.cos(angle));

const IMPOSTOR_ATTRS = ["aCenter", "aSize", "aAxisX", "aAxisY"];

/** ⭐ §batch-order-spread (2026-09-13): a 30/45° camera bucket crossing asks
 * every order-capable LOD mesh to rewrite its ENTIRE shared instance buffer
 * from `orderFoliageChunks`'s new front-to-back list — fine for a handful of
 * chunks, but a world-scale scatter can hold hundreds, and copying every one
 * of them synchronously on one frame is the CPU spike a turning camera pays
 * ("`FoliageComponent._updateBatchOrder` rewrites EVERY chunk's instance
 * buffers in one frame at each bucket crossing"). Past
 * `FOLIAGE_ORDER_SPREAD_CHUNKS` chunks, `FoliageComponent._commitBatches`
 * stages the new layout into a scratch job (`createBatchOrderJob`) and steps
 * it (`stepBatchOrderJob`) at most `FOLIAGE_ORDER_CHUNKS_PER_FRAME` chunks a
 * call, continuing on the next `update()`; the live mesh is left showing its
 * last complete layout — correct, just not yet re-sorted — until the whole
 * job finishes and the caller swaps the scratch buffers in. Below the
 * threshold (every scene in `tests/foliage-batch-order.test.mjs`, and any
 * hand-authored preview) `commitBatchChunksFull` is used instead, which is
 * `stepBatchOrderJob`'s one-frame ancestor with no bookkeeping at all. */
export const FOLIAGE_ORDER_CHUNKS_PER_FRAME = 4;
export const FOLIAGE_ORDER_SPREAD_CHUNKS = 48;
/** ⭐ §settle-frames (P1-B follow-up, "the disappearing logs" receipt): a
 * FIXED 4-chunks-per-tier-per-frame budget is fine for the handful of chunks
 * a camera-bucket crossing reorders, but `FoliageComponent._commitBatches`'s
 * `commitMask` snapshot cannot advance again until every tier's job for the
 * CURRENT snapshot has finished (`§starvation-guard` there) — so a fixed,
 * scene-size-independent budget makes a big scatter's own MEMBERSHIP catch-up
 * take as many frames as `matchedChunks / 4`, which for a few hundred chunks
 * is tens of frames, comfortably wider than the ~3–6 m crossfade band a
 * moving camera crosses it in. `foliageCommitBudget` instead scales the
 * budget so a full pass — even the worst case where every chunk in `chunks`
 * matches — finishes within `FOLIAGE_ORDER_SETTLE_FRAMES` frames, while still
 * flooring at `FOLIAGE_ORDER_CHUNKS_PER_FRAME` for small scatters. Only the
 * ARRAY-COPY budget scales; a sparse `chunks` array is still scanned in full
 * either way (skipping a non-matching chunk is already free — see
 * `stepBatchOrderJob` below), so this does not change the existing per-frame
 * scan cost, only how many of the matches found during that scan get copied
 * before the budget runs out. */
export const FOLIAGE_ORDER_SETTLE_FRAMES = 6;
export function foliageCommitBudget(chunkCount) {
  return Math.max(FOLIAGE_ORDER_CHUNKS_PER_FRAME, Math.ceil(chunkCount / FOLIAGE_ORDER_SETTLE_FRAMES));
}

/** ⭐ §superset-membership (P1-B, 09-13): a chunk's `commitMask` (frozen once
 * per commit generation by `FoliageComponent._commitBatches` from its live
 * `tierMask` — see that method's file-level comment) is a BITMASK, not a
 * single tier — a chunk straddling a crossfade band carries the bit for both
 * tiers it overlaps, so its instance data is copied into BOTH shared render
 * meshes, and the per-instance shader weight (`foliageMaterial.js`,
 * `impostorMaterial.js`) decides how much of each actually draws. A chunk
 * fully inside one tier's zone still costs exactly one copy: only chunks
 * whose distance RANGE actually crosses a band get duplicated. */
function chunkInTier(chunk, bit) { return (chunk.commitMask & bit) !== 0; }

/** Refreshes everything a committed tier mesh needs after its `count`
 * changes — visibility, the draw count itself, upload ranges, and the
 * bounding sphere derived from `bounds` (already the mesh's own persistent
 * `boundingBox`/`geometry.boundingBox`, mutated in place by the caller).
 * Shared by the full/spread commit paths and by `appendChunkToTier` below so
 * an incremental append is indistinguishable, from the renderer's side, from
 * a chunk that was part of the original pass. */
export function finalizeCommittedMesh(mesh, lod, count, bounds) {
  mesh.visible = count > 0;
  if (lod < 2) {
    mesh.count = count;
    mesh.instanceMatrix.clearUpdateRanges();
    if (count) mesh.instanceMatrix.addUpdateRange(0, count * 16);
    mesh.instanceMatrix.needsUpdate = true;
    bounds.getBoundingSphere(mesh.boundingSphere ??= new THREE.Sphere());
  } else {
    mesh.geometry.instanceCount = count;
    for (const key of IMPOSTOR_ATTRS) {
      const attribute = mesh.geometry.attributes[key];
      attribute.clearUpdateRanges();
      if (count) attribute.addUpdateRange(0, count * attribute.itemSize);
      attribute.needsUpdate = true;
    }
    bounds.getBoundingSphere(mesh.geometry.boundingSphere);
  }
}

/**
 * ⭐ §mid-pass-accretion (P1-B follow-up): a resumable job that has already
 * gone `.done` for the current `commitMask` snapshot will not run again
 * until the next full settle — but `FoliageComponent._commitBatches` still
 * lets `commitMask` GROW mid-pass (see its own file comment) so a chunk
 * whose job hasn't reached it yet keeps picking up fresh bits. For a chunk
 * the DONE job already skipped, that growth has nowhere to land on its own;
 * this appends that one chunk's data to the tail of the already-settled
 * buffer instead of waiting out a whole extra pass for it. It never touches
 * any instance already written — only grows `count`/`instanceCount` by this
 * one chunk — so it costs exactly one chunk's worth of work, independent of
 * how many other chunks the mesh already carries, and never re-triggers the
 * CPU spike the resumable job exists to bound. Returns the new count, or
 * `null` if this chunk has no geometry for `lod` (nothing to append). */
export function appendChunkToTier(mesh, chunk, lod) {
  const source = chunk.meshes[lod];
  if (!source) return null;
  const bounds = lod === 2 ? (mesh.geometry.boundingBox ??= new THREE.Box3()) : (mesh.boundingBox ??= new THREE.Box3());
  const offset = lod < 2 ? mesh.count : mesh.geometry.instanceCount;
  if (lod < 2) mesh.instanceMatrix.array.set(source.instanceMatrix.array, offset * 16);
  else for (const key of IMPOSTOR_ATTRS) {
    const destination = mesh.geometry.attributes[key];
    destination.array.set(source.geometry.attributes[key].array, offset * destination.itemSize);
  }
  bounds.union(chunk.bounds);
  const count = offset + chunk.instances.length;
  finalizeCommittedMesh(mesh, lod, count, bounds);
  return count;
}

/** Copies every chunk of `chunks` at `lod` into `mesh`'s shared buffer in one
 * pass, filling `bounds` (already `.makeEmpty()`d by the caller if reused
 * across calls). Returns the instance count written. */
export function commitBatchChunksFull(mesh, chunks, lod, bounds) {
  let count = 0;
  const bit = 1 << lod;
  for (const chunk of chunks) {
    if (!chunkInTier(chunk, bit)) continue;
    const source = chunk.meshes[lod];
    if (!source) continue;
    bounds.union(chunk.bounds);
    if (lod < 2) mesh.instanceMatrix.array.set(source.instanceMatrix.array, count * 16);
    else for (const key of IMPOSTOR_ATTRS) {
      const destination = mesh.geometry.attributes[key];
      destination.array.set(source.geometry.attributes[key].array, count * destination.itemSize);
    }
    count += chunk.instances.length;
  }
  return count;
}

/** A resumable staging area for one LOD mesh's spread rewrite — scratch
 * arrays the same size as the live ones, so the finished job can be dropped
 * into the mesh with one `TypedArray.set()` per attribute.
 *
 * Also clears every chunk's `_visitedMask` bit for THIS lod: a chunk marked
 * visited by a previous job for this same lod slot must not be treated as
 * "already passed, safe to append into the live mesh" by the FRESH job that
 * has not looked at it yet (see `stepBatchOrderJob` and
 * `FoliageComponent._commitBatches`'s `§mid-pass-accretion`). */
export function createBatchOrderJob(mesh, lod, chunks) {
  const job = { cursor: 0, count: 0, bounds: new THREE.Box3() };
  const bit = 1 << lod;
  for (const chunk of chunks) if (chunk._visitedMask) chunk._visitedMask &= ~bit;
  if (lod < 2) { job.matrix = new Float32Array(mesh.instanceMatrix.array.length); return job; }
  job.attrs = {};
  for (const key of IMPOSTOR_ATTRS) job.attrs[key] = new Float32Array(mesh.geometry.attributes[key].array.length);
  return job;
}

/** Advances `job` through `chunks` by at most `budget` chunks THAT MATCH
 * `lod` (chunks at another tier are skipped for free — they cost nothing to
 * pass over). Returns true once every chunk in `chunks` has been visited, at
 * which point the caller copies `job.matrix`/`job.attrs` into the live mesh
 * and finalizes bounds/count exactly as `commitBatchChunksFull` would.
 *
 * Every chunk the cursor passes — matched or not — is marked visited for
 * this lod in `chunk._visitedMask`, whether or not it matched: once passed,
 * this job will never look at it again this pass, which is exactly the
 * condition `appendChunkToJob`/`appendChunkToTier` need to know whether a
 * bit that shows up AFTER the fact has anywhere left to land on its own. */
export function stepBatchOrderJob(job, chunks, lod, budget = FOLIAGE_ORDER_CHUNKS_PER_FRAME) {
  const bit = 1 << lod;
  while (job.cursor < chunks.length && budget > 0) {
    const chunk = chunks[job.cursor++];
    chunk._visitedMask = (chunk._visitedMask ?? 0) | bit;
    if (!chunkInTier(chunk, bit)) continue;
    const source = chunk.meshes[lod];
    if (source) {
      job.bounds.union(chunk.bounds);
      if (lod < 2) job.matrix.set(source.instanceMatrix.array, job.count * 16);
      else for (const key of IMPOSTOR_ATTRS) {
        const destination = source.geometry.attributes[key];
        job.attrs[key].set(destination.array, job.count * destination.itemSize);
      }
      job.count += chunk.instances.length;
    }
    budget--;
  }
  return job.cursor >= chunks.length;
}

/**
 * The `!job.done` twin of `appendChunkToTier`: a chunk whose bit for `lod`
 * arrives AFTER that job's cursor already passed it, but before the job as a
 * WHOLE finishes, cannot be patched into the live mesh — the job's own
 * eventual `mesh.instanceMatrix.array.set(job.matrix)` swap-in (in
 * `FoliageComponent._commitBatches`) would silently overwrite that patch
 * with its own, chunk-less scratch content the moment it completes. Instead
 * this appends the chunk into the JOB'S OWN scratch (`job.matrix`/
 * `job.attrs`, growing `job.count`/`job.bounds`), so the eventual swap-in
 * carries it through intact — indistinguishable, once the job finishes, from
 * a chunk the job's own cursor found on time. */
export function appendChunkToJob(job, chunk, lod) {
  const source = chunk.meshes[lod];
  if (!source) return null;
  if (lod < 2) job.matrix.set(source.instanceMatrix.array, job.count * 16);
  else for (const key of IMPOSTOR_ATTRS) {
    const destination = source.geometry.attributes[key];
    job.attrs[key].set(destination.array, job.count * destination.itemSize);
  }
  job.bounds.union(chunk.bounds);
  job.count += chunk.instances.length;
  return job.count;
}

export function foliageOrderDirection(direction, previous = null) {
  if (!direction || ![direction.x, direction.y, direction.z].every(Number.isFinite)) return previous;
  const length = Math.hypot(direction.x, direction.y, direction.z);
  if (length < 1e-8) return previous;
  const yaw = Math.atan2(direction.x, direction.z);
  const pitch = Math.asin(Math.max(-1, Math.min(1, direction.y / length)));
  let y = Math.round(yaw / yawStep), p = Math.round(pitch / pitchStep);
  if (previous && Math.abs(pitch - previous.pitch * pitchStep) <= pitchStep / 2 + slack) p = previous.pitch;
  if (Math.abs(p) === 3) y = 0; // Looking vertically has no meaningful yaw.
  else if (previous && Math.abs(previous.pitch) !== 3 && Math.abs(wrap(yaw - previous.yaw * yawStep)) <= yawStep / 2 + slack) y = previous.yaw;
  y = (y % 8 + 8) % 8;
  const key = y + 8 * (p + 3);
  if (previous?.key === key) return previous;
  const cosine = Math.cos(p * pitchStep);
  return { key, yaw: y, pitch: p, x: Math.sin(y * yawStep) * cosine, y: Math.sin(p * pitchStep), z: Math.cos(y * yawStep) * cosine };
}

export function foliageCanOrderMaterial(material) {
  return !!material && !Array.isArray(material) && material.transparent !== true &&
    material.depthWrite !== false && material.depthTest !== false && !(material.transmission > 0) && !material.transmissionNode;
}

/** Bounds and instance matrices already contain full world transforms. Do not
 * apply the owning entity's transform again, including for mirrored parents. */
export function orderFoliageChunks(chunks, direction) {
  return chunks.map((chunk, index) => {
    const { min, max } = chunk.detailBounds;
    return { chunk, index, depth: ((min.x + max.x) * direction.x + (min.y + max.y) * direction.y + (min.z + max.z) * direction.z) * .5 };
  }).sort((a, b) => a.depth - b.depth || a.index - b.index).map(entry => entry.chunk);
}
