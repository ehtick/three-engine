// 3D Radiance Cascades — deliberately minimal voxel medium.
//
// ONE fixed-resolution grid. The CPU bake (triangle rasterize + direct
// light + exact EDT) lives in bakeCore.js and runs in two contexts:
// synchronously here for the initial build, and inside bakeWorker.js for
// re-bakes — `rebakeAsync()` streams worker results into the same GPU
// buffers with zero main-thread hitching (drag a wall → lighting follows at
// worker cadence while rendering stays at full frame rate). In-flight jobs
// coalesce: while the worker is busy, only the LATEST pending request is
// kept, so continuous edits can't queue up a backlog.
//
// Cell payload (vec4): rgb = OUTGOING radiance (albedo·E/π + emissive),
// w = 1 occupied / 0 empty. The GPU side is a TSL Amanatides-Woo DDA
// (`createSceneTrace`) + an SDF sphere-trace (`createSoftShadowTrace`) over
// a trilinear-filtered Data3DTexture distance field.
import * as THREE from "three/webgpu";
import { Break, If, Loop, float, floor, instancedArray, step, texture3D, vec3, vec4 } from "three/tsl";
import { allocateBakeArrays, bakeMeshSdf, runBake } from "./bakeCore.js";

/**
 * Evaluates a TSL node subtree to a constant RGB if possible, else null.
 * Handles ColorNode/uniform (.value Color), float constants (as grey),
 * constant ×/+ chains (the shader graph's `color × strength` emission), and
 * wrapper nodes (VarNode & co. keep the real expression in `.node` — this
 * three version auto-wraps operator chains in VarNode, which made every
 * graph-authored emissive look unresolvable and bake black).
 */
function constantColorOf(node, depth = 0) {
  if (!node || depth > 8) return null;
  const value = node.value;
  if (value && typeof value === "object" && typeof value.r === "number") return value;
  if (typeof value === "number") return { r: value, g: value, b: value };
  if ((node.op === "*" || node.op === "+") && node.aNode && node.bNode) {
    const a = constantColorOf(node.aNode, depth + 1);
    const b = constantColorOf(node.bNode, depth + 1);
    if (a && b) {
      return node.op === "*"
        ? { r: a.r * b.r, g: a.g * b.g, b: a.b * b.b }
        : { r: a.r + b.r, g: a.g + b.g, b: a.b + b.b };
    }
  }
  if (node.node) return constantColorOf(node.node, depth + 1);
  return null;
}

/**
 * Resolves the bake-relevant surface of a material. Engine material assets
 * carry their real color/emissive in colorNode/emissiveNode (top-level
 * `.color` can sit at stale white, `.emissive` at black) — same reason the
 * editor swatch walks colorNode. Texture-driven nodes resolve to null →
 * fall back to the scalar fields (texture-average bake = future work).
 */
export function resolveMaterialSurface(materialInput, meshName = "") {
  const material = Array.isArray(materialInput) ? materialInput[0] : materialInput;
  const white = { r: 1, g: 1, b: 1 };
  const black = { r: 0, g: 0, b: 0 };
  const color = constantColorOf(material?.colorNode) ?? material?.color ?? white;
  const emissiveResolved = constantColorOf(material?.emissiveNode);
  const emissive = emissiveResolved ?? material?.emissive ?? black;
  const emissiveIntensity = emissiveResolved ? 1 : (material?.emissiveIntensity ?? 1);
  if (material?.emissiveNode && !emissiveResolved) {
    const fallbackDark =
      (emissive.r ?? 0) * emissiveIntensity < 0.01 &&
      (emissive.g ?? 0) * emissiveIntensity < 0.01 &&
      (emissive.b ?? 0) * emissiveIntensity < 0.01;
    if (fallbackDark) {
      console.warn(
        `[gi] "${meshName || "mesh"}": emissiveNode is not a constant color×intensity expression — ` +
          `this emitter bakes BLACK and won't light the GI. Use a flat emissive color/intensity, ` +
          `or report the graph shape so the resolver can learn it.`,
      );
    }
  }
  return { color, emissive, emissiveIntensity };
}

/**
 * Serializes a THREE.Mesh into the plain, structured-cloneable record
 * bakeCore consumes (safe to postMessage to the bake worker). Arrays are
 * copied — the live geometry stays untouched.
 */
const geometryCopyCache = new WeakMap(); // geometry -> { version, positions, index }

export function serializeMeshForBake(mesh) {
  const position = mesh.geometry?.attributes?.position;
  if (!position) return null;
  mesh.updateWorldMatrix(true, false);
  const surface = resolveMaterialSurface(mesh.material, mesh.name);
  // Vertex/index copies cached per geometry (big character models cost real
  // milliseconds to slice per request; a drag only changes the matrix).
  let cached = geometryCopyCache.get(mesh.geometry);
  const version = position.version ?? 0;
  if (!cached || cached.version !== version) {
    cached = {
      version,
      positions: position.array.slice(0, position.count * 3),
      index: mesh.geometry.index ? mesh.geometry.index.array.slice() : null,
    };
    geometryCopyCache.set(mesh.geometry, cached);
  }
  return {
    // Identity for the worker's incremental diffing + geometry cache: the
    // key changes when geometry content does, so edits re-ship exactly once.
    id: mesh.id,
    geometryKey: `${mesh.geometry.id}:${version}`,
    positions: cached.positions,
    index: cached.index,
    matrix: [...mesh.matrixWorld.elements],
    color: { r: surface.color.r, g: surface.color.g, b: surface.color.b },
    emissive: { r: surface.emissive.r, g: surface.emissive.g, b: surface.emissive.b },
    emissiveIntensity: surface.emissiveIntensity,
  };
}

const toRecords = (meshesOrRecords) =>
  meshesOrRecords.map((entry) => (entry?.isMesh ? serializeMeshForBake(entry) : entry)).filter(Boolean);

const toPlainLights = (light) => {
  const list = Array.isArray(light) ? light : light ? [light] : [];
  return list.map((entry) => ({
    type: entry.type === "directional" ? "directional" : "point",
    position: entry.position ? { x: entry.position.x, y: entry.position.y, z: entry.position.z } : undefined,
    direction: entry.direction
      ? { x: entry.direction.x, y: entry.direction.y, z: entry.direction.z }
      : undefined,
    color: { r: entry.color.r, g: entry.color.g, b: entry.color.b },
    intensity: entry.intensity,
  }));
};

/**
 * @param {Array} meshes THREE meshes OR pre-serialized bake records
 * @param {{min: THREE.Vector3, max: THREE.Vector3}} bounds
 * @param {{x: number, y: number, z: number}} res grid cells per axis
 * @param {object|Array} light light(s) for the direct bake
 */
export function voxelizeOnce(meshes, bounds, res, light) {
  const cellCount = res.x * res.y * res.z;
  const size = new THREE.Vector3().subVectors(bounds.max, bounds.min);
  const cell = new THREE.Vector3(size.x / res.x, size.y / res.y, size.z / res.z);
  const plainBounds = {
    min: { x: bounds.min.x, y: bounds.min.y, z: bounds.min.z },
    max: { x: bounds.max.x, y: bounds.max.y, z: bounds.max.z },
  };
  const plainCell = { x: cell.x, y: cell.y, z: cell.z };

  const arrays = allocateBakeArrays(cellCount);
  const stats = { triangles: 0, occupiedCells: 0, litCells: 0, emissiveCells: 0, cellCount };

  // Initial bake: synchronous (startup — nothing to hitch yet).
  Object.assign(
    stats,
    runBake({ records: toRecords(meshes), bounds: plainBounds, res, cell: plainCell, lights: toPlainLights(light), arrays }),
  );

  const { radiance, surface, normals, distance } = arrays;
  // Buffer roles for temporal streaming (flicker-free moving objects):
  //   stagingBuffer  — the LATEST CPU bake, partial-uploaded at worker cadence
  //   baseBuffer     — blended direct+emissive state; the per-frame bounce-
  //                    feedback pass lerps it toward staging (~100ms settle)
  //   radianceBuffer — live field the cascade rays trace (base + bounce)
  // Only staging is written from the CPU during streaming, so a 10-15Hz bake
  // cadence no longer hard-snaps the field the lighting reads.
  const stagingBuffer = instancedArray(radiance, "vec4");
  const radianceBuffer = instancedArray(radiance.slice(), "vec4");
  const baseBuffer = instancedArray(radiance.slice(), "vec4");
  const surfaceBuffer = instancedArray(surface, "vec4");
  const normalBuffer = instancedArray(normals, "vec4");
  // 3D texture (not a storage buffer) ON PURPOSE: hardware trilinear makes
  // the sampled distance CONTINUOUS between cells — nearest-cell sampling
  // quantizes d and the penumbra min(k·d/t) turns each step into a terrace.
  const distanceTexture = new THREE.Data3DTexture(distance, res.x, res.y, res.z);
  distanceTexture.format = THREE.RedFormat;
  distanceTexture.type = THREE.FloatType;
  distanceTexture.minFilter = THREE.LinearFilter;
  distanceTexture.magFilter = THREE.LinearFilter;
  distanceTexture.unpackAlignment = 1;
  distanceTexture.needsUpdate = true;

  const upload = () => {
    // Sync path (initial build / harness rebake): full snap of every buffer —
    // deterministic harnesses want the new state immediately, no blend-in.
    baseBuffer.value?.array?.set(radiance);
    radianceBuffer.value?.array?.set(radiance);
    for (const buffer of [stagingBuffer, radianceBuffer, baseBuffer, surfaceBuffer, normalBuffer]) {
      const attribute = buffer.value;
      if (attribute) {
        // Full upload: clear any stale PARTIAL ranges first or the whole-
        // buffer update gets silently truncated to the old range.
        attribute.clearUpdateRanges?.();
        attribute.needsUpdate = true;
      }
    }
    distanceTexture.needsUpdate = true;
  };

  // ------------------------------------------------------------ bake worker
  let worker = null;
  let workerBroken = false;
  let jobId = 0;
  let inFlight = null; // { id, resolve }
  let pending = null; // latest superseding request { records, lights, resolve }
  // Geometry payloads the worker already caches — ship each (geometry,
  // version) exactly once; drags then send only ids + matrices + colors.
  const shippedGeometry = new Set();

  const ensureWorker = () => {
    if (worker || workerBroken) return worker;
    try {
      shippedGeometry.clear();
      worker = new Worker(new URL("./bakeWorker.js", import.meta.url), { type: "module" });
      console.log("[gi] bake worker active — re-bakes run off the main thread");
      worker.onmessage = (event) => {
        const message = event.data;
        const current = inFlight;
        inFlight = null;
        if (current && message.jobId === current.id) {
          // PARTIAL apply: the worker sends changed-range SLICES (its full
          // arrays never leave the worker). Full re-uploads of every buffer
          // were a 30-60ms main-thread writeBuffer stall per rebake at fine
          // voxel sizes; moving one object touches a tiny fraction of the grid.
          const applyRange = (target, slice, buffer, range) => {
            if (!range || !slice) return;
            target.set(slice, range[0]);
            const attribute = buffer.value;
            if (attribute) {
              attribute.addUpdateRange(range[0], slice.length);
              attribute.needsUpdate = true;
            }
          };
          // Streaming path: only STAGING gets the new radiance — the per-
          // frame feedback pass blends base/radiance toward it (temporal
          // smoothing of incoming bakes; hard swaps were the flicker).
          applyRange(radiance, message.radiance, stagingBuffer, message.ranges.radiance);
          applyRange(surface, message.surface, surfaceBuffer, message.ranges.surface);
          applyRange(normals, message.normals, normalBuffer, message.ranges.normals);
          if (message.ranges.distance && message.distance) {
            distance.set(message.distance, message.ranges.distance[0]);
            // Data3DTexture has no partial-upload path in three — full
            // texture re-upload, but only when the field actually changed.
            distanceTexture.needsUpdate = true;
          }
          if (message.stats) Object.assign(stats, message.stats);
          current.resolve({ stats, elapsed: message.elapsed, mode: message.mode ?? "noop" });
        } else {
          current?.resolve(null);
        }
        if (pending) {
          const next = pending;
          pending = null;
          post(next.records, next.lights, next.resolve);
        }
      };
      worker.onerror = (error) => {
        console.warn("[gi] bake worker failed, falling back to main-thread rebakes:", error.message ?? error);
        workerBroken = true;
        worker?.terminate();
        worker = null;
        const current = inFlight;
        inFlight = null;
        current?.resolve(null);
        if (pending) {
          const next = pending;
          pending = null;
          next.resolve(null);
        }
      };
    } catch (error) {
      console.warn("[gi] no Worker support, rebakes stay on the main thread:", error?.message ?? error);
      workerBroken = true;
    }
    return worker;
  };

  const post = (records, lights, resolve) => {
    jobId++;
    inFlight = { id: jobId, resolve };
    const wire = records.map((r, i) => {
      const hasKey = !!r.geometryKey;
      const key = r.geometryKey ?? `anon:${i}`;
      // Keyless records (non-standard callers) re-ship every job — the
      // cache entry is overwritten in place, so no growth and no staleness.
      const known = hasKey && shippedGeometry.has(key);
      if (hasKey && !known) shippedGeometry.add(key);
      return {
        id: r.id ?? `idx:${i}`,
        geometryKey: key,
        matrix: r.matrix,
        color: r.color,
        emissive: r.emissive,
        emissiveIntensity: r.emissiveIntensity,
        excludeFromDistanceField: r.excludeFromDistanceField === true,
        geometry: known ? null : { positions: r.positions, index: r.index },
      };
    });
    worker.postMessage({ jobId, records: wire, bounds: plainBounds, res, cell: plainCell, lights });
  };

  // ---------------------------------------------------- per-mesh SDF bakes
  // DEDICATED worker: a dense mesh's SDF bake can run seconds, and sharing
  // the scene-bake worker would stall incremental rebakes behind it.
  // Geometry ships inline (requests are rare, one per geometry version).
  let sdfWorker = null;
  let sdfWorkerBroken = false;
  let sdfRequestId = 0;
  const sdfRequests = new Map(); // requestId → { resolve, reject }

  const ensureSdfWorker = () => {
    if (sdfWorker || sdfWorkerBroken) return sdfWorker;
    try {
      sdfWorker = new Worker(new URL("./bakeWorker.js", import.meta.url), { type: "module" });
      sdfWorker.onmessage = (event) => {
        const message = event.data;
        if (message.type !== "meshSdf") return;
        const request = sdfRequests.get(message.requestId);
        sdfRequests.delete(message.requestId);
        if (request) {
          if (message.error) request.reject(new Error(message.error));
          else request.resolve(message.sdf);
        }
      };
      sdfWorker.onerror = (error) => {
        console.warn("[gi] SDF worker failed, mesh SDFs will bake on the main thread:", error.message ?? error);
        for (const request of sdfRequests.values()) request.reject(new Error("SDF worker died"));
        sdfRequests.clear();
        sdfWorkerBroken = true;
        sdfWorker?.terminate();
        sdfWorker = null;
      };
    } catch {
      sdfWorkerBroken = true;
    }
    return sdfWorker;
  };

  /**
   * Bakes a high-res LOCAL-space SDF for one record's geometry in a
   * dedicated worker. Falls back to a synchronous main-thread bake.
   */
  const requestMeshSdf = (record) => {
    if (!ensureSdfWorker()) {
      return Promise.resolve(bakeMeshSdf(record.positions, record.index));
    }
    return new Promise((resolve, reject) => {
      sdfRequestId++;
      sdfRequests.set(sdfRequestId, { resolve, reject });
      sdfWorker.postMessage({
        type: "meshSdf",
        requestId: sdfRequestId,
        geometryKey: record.geometryKey ?? `sdf:${sdfRequestId}`,
        geometry: { positions: record.positions, index: record.index },
      });
    });
  };

  return {
    res,
    bounds,
    cell,
    stats,
    radianceBuffer,
    baseBuffer,
    stagingBuffer,
    surfaceBuffer,
    normalBuffer,
    distanceTexture,

    /** Synchronous full re-bake (harness/back-compat path). */
    rebake(bakeMeshes, bakeLight) {
      Object.assign(
        stats,
        runBake({
          records: toRecords(bakeMeshes),
          bounds: plainBounds,
          res,
          cell: plainCell,
          lights: toPlainLights(bakeLight),
          arrays,
        }),
      );
      upload();
    },

    /**
     * Worker re-bake: resolves { stats, elapsed } when THIS request's result
     * was applied, or null when it was superseded by a newer request (or the
     * worker is unavailable — in which case a sync rebake ran instead).
     * While a job is in flight, only the latest pending request is kept —
     * continuous edits stream at worker cadence with no backlog.
     */
    rebakeAsync(meshesOrRecords, bakeLight) {
      const records = toRecords(meshesOrRecords);
      const lights = toPlainLights(bakeLight);
      if (!ensureWorker()) {
        console.warn("[gi] SYNC rebake on main thread (worker unavailable) — this WILL hitch");
        this.rebake(records, lights);
        return Promise.resolve({ stats, elapsed: 0 });
      }
      return new Promise((resolve) => {
        if (inFlight) {
          // Latest wins; the superseded waiter resolves null.
          pending?.resolve(null);
          pending = { records, lights, resolve };
        } else {
          post(records, lights, resolve);
        }
      });
    },

    dispose() {
      worker?.terminate();
      worker = null;
      sdfWorker?.terminate();
      sdfWorker = null;
    },

    requestMeshSdf,
    createSceneTrace: () => createVoxelSceneTrace(radianceBuffer, bounds, res, cell),
    createSoftShadowTrace: (lift, meshSdf) => createSDFShadowTrace(distanceTexture, bounds, res, cell, lift, meshSdf),
    createRadianceSampler: () => createTrilinearRadianceSampler(radianceBuffer, bounds, res, cell),
  };
}

/**
 * TSL DDA over the baked grid: (origin, dir, tMaxWorld) → { rad, t }, t < 0
 * = miss. tMaxWorld is a JS number — it bounds the step count at build time.
 * (Exported for sdfScene.js — the voxel-free medium reuses the exact same
 * cascade-ray DDA and trilinear radiance sampler over its own buffers.)
 *
 * `normalBuffer` (optional) makes hits DIRECTION-AWARE: a cell stores ONE
 * outgoing radiance but a thin wall has two faces — a ray arriving from the
 * cell normal's own side (front) reads the radiance, a ray arriving from
 * behind reads BLACK (the far side's energy is not visible through matter).
 * Without this, single-cell-thin roofs/walls showed the bright interior as
 * blotchy patches when viewed from OUTSIDE.
 */
export function createVoxelSceneTrace(radianceBuffer, bounds, res, cell, normalBuffer = null) {
  const minCell = Math.min(cell.x, cell.y, cell.z);

  return (origin, dir, tMaxWorld) => {
    const maxSteps = Math.min(256, Math.ceil(tMaxWorld / minCell) + 2);

    const rad = vec3(0).toVar();
    const t = float(-1).toVar();

    const gx = origin.x.sub(bounds.min.x).div(cell.x).toVar();
    const gy = origin.y.sub(bounds.min.y).div(cell.y).toVar();
    const gz = origin.z.sub(bounds.min.z).div(cell.z).toVar();
    const ix = floor(gx).toVar();
    const iy = floor(gy).toVar();
    const iz = floor(gz).toVar();

    const stepX = step(0, dir.x).mul(2).sub(1).toVar();
    const stepY = step(0, dir.y).mul(2).sub(1).toVar();
    const stepZ = step(0, dir.z).mul(2).sub(1).toVar();
    // sign() is 0 at 0 — use a step-based sign (0 → +1) to avoid div-by-0.
    const safe = (component) => step(0, component).mul(2).sub(1).mul(component.abs().max(1e-8));
    const tDeltaX = float(cell.x).div(safe(dir.x)).abs().toVar();
    const tDeltaY = float(cell.y).div(safe(dir.y)).abs().toVar();
    const tDeltaZ = float(cell.z).div(safe(dir.z)).abs().toVar();
    const boundOf = (frac, stepSign) => stepSign.mul(0.5).add(0.5).add(stepSign.mul(frac.negate()));
    const tMaxX = boundOf(gx.sub(ix), stepX).mul(tDeltaX).toVar();
    const tMaxY = boundOf(gy.sub(iy), stepY).mul(tDeltaY).toVar();
    const tMaxZ = boundOf(gz.sub(iz), stepZ).mul(tDeltaZ).toVar();
    const travelled = float(0).toVar();

    Loop({ start: 0, end: maxSteps, name: "vox" }, () => {
      If(
        ix.lessThan(0)
          .or(iy.lessThan(0))
          .or(iz.lessThan(0))
          .or(ix.greaterThanEqual(res.x))
          .or(iy.greaterThanEqual(res.y))
          .or(iz.greaterThanEqual(res.z))
          .or(travelled.greaterThan(tMaxWorld)),
        () => {
          Break();
        },
      );

      const cellIdx = iz.mul(res.y).add(iy).mul(res.x).add(ix);
      const voxel = radianceBuffer.element(cellIdx.toInt()).toVar();
      If(voxel.w.greaterThan(0.5), () => {
        if (normalBuffer) {
          // Back-side hit → the cell blocks but emits nothing this way.
          const n = normalBuffer.element(cellIdx.toInt()).xyz;
          rad.assign(voxel.xyz.mul(step(dir.dot(n), 0)));
        } else {
          rad.assign(voxel.xyz);
        }
        t.assign(travelled.max(1e-4));
        Break();
      });

      If(tMaxX.lessThanEqual(tMaxY).and(tMaxX.lessThanEqual(tMaxZ)), () => {
        travelled.assign(tMaxX);
        tMaxX.addAssign(tDeltaX);
        ix.addAssign(stepX);
      })
        .ElseIf(tMaxY.lessThanEqual(tMaxZ), () => {
          travelled.assign(tMaxY);
          tMaxY.addAssign(tDeltaY);
          iy.addAssign(stepY);
        })
        .Else(() => {
          travelled.assign(tMaxZ);
          tMaxZ.addAssign(tDeltaZ);
          iz.addAssign(stepZ);
        });
    });

    return { rad, t };
  };
}

/**
 * Occupancy-weighted trilinear sample of the live radiance field:
 * (p) → { rad: vec3, coverage: float }. Used to shade MIRROR ray hits —
 * the DDA's single-cell radiance paints flat voxel-sized patches; sampling
 * the 8 surrounding occupied cells makes reflected surfaces shade smoothly
 * (the reference's mirrors read its continuous probe field the same way).
 * Empty cells carry no radiance and are excluded by weight; `coverage` → 0
 * means the neighborhood is degenerate and the caller should fall back.
 */
export function createTrilinearRadianceSampler(radianceBuffer, bounds, res, cell, normalBuffer = null) {
  return (p, sideNormal = null) => {
    const fx = p.x.sub(bounds.min.x).div(cell.x).sub(0.5).toVar();
    const fy = p.y.sub(bounds.min.y).div(cell.y).sub(0.5).toVar();
    const fz = p.z.sub(bounds.min.z).div(cell.z).sub(0.5).toVar();
    const bx = floor(fx).toVar();
    const by = floor(fy).toVar();
    const bz = floor(fz).toVar();
    const wx = fx.sub(bx);
    const wy = fy.sub(by);
    const wz = fz.sub(bz);
    const acc = vec3(0).toVar();
    const weightAcc = float(0).toVar();
    Loop({ start: 0, end: 8, name: "radTri" }, ({ radTri }) => {
      const cf = radTri.toFloat();
      const cx = cf.mod(2);
      const cy = floor(cf.div(2)).mod(2);
      const cz = floor(cf.div(4));
      const ix = bx.add(cx).clamp(0, res.x - 1);
      const iy = by.add(cy).clamp(0, res.y - 1);
      const iz = bz.add(cz).clamp(0, res.z - 1);
      const w = cx
        .mul(wx)
        .add(cx.oneMinus().mul(wx.oneMinus()))
        .mul(cy.mul(wy).add(cy.oneMinus().mul(wy.oneMinus())))
        .mul(cz.mul(wz).add(cz.oneMinus().mul(wz.oneMinus())));
      const cellIdx = iz.mul(res.y).add(iy).mul(res.x).add(ix);
      const voxel = radianceBuffer.element(cellIdx.toInt()).toVar();
      If(voxel.w.greaterThan(0.5), () => {
        // SIDE-AWARE weighting: a sub-cell-thick wall keeps one shell
        // layer per side, each carrying its own side's radiance. A plain
        // trilinear at a hit on side A averages in side B's (possibly
        // brightly lit) cells — light "shines through" thin partitions in
        // the transport. Cells whose stored normal opposes the hit side
        // are the OTHER face: weight them out.
        const side =
          normalBuffer && sideNormal
            ? normalBuffer.element(cellIdx.toInt()).xyz.dot(sideNormal).max(0)
            : float(1);
        acc.addAssign(voxel.xyz.mul(w).mul(side));
        weightAcc.addAssign(w.mul(side));
      });
    });
    return { rad: acc.div(weightAcc.max(1e-4)), coverage: weightAcc };
  };
}

/**
 * SDF sphere-traced soft shadow: (origin, dir, maxT, k, cosRayNormal) →
 * float penumbra in [0, 1]. Tracks the closest approach via the trilinear
 * distance field: penumbra = min(k·d/t) — smooth area shadows, zero noise.
 * Estimator notes: plain min(d/t) only (iq's refinement is unsafe on a
 * non-smooth field), 0.85 safety factor, step clamp ≤ 8 voxels, and
 * plane-aware self-exclusion (samples whose distance ≈ the ray's height
 * above the RECEIVER'S OWN plane are the receiver surface, not a blocker —
 * without this, grazing rays paint terraced false-shadow rings).
 *
 * The field carries EXACT sub-voxel distances near surfaces (bakeCore's
 * narrow band), so around thin geometry the d < contact region can be as
 * thin as the geometry itself — the minimum step (0.35·voxel) is what
 * guarantees a crossing ray still samples inside it (worst case a steep
 * crossing samples d ≤ step/2 ≈ 0.18·voxel < the 0.25·voxel contact cut).
 *
 * `lift` = the caller's ray-origin normal offset in world units. The
 * self-exclusion needs it exactly: with an exact field the receiver's own
 * plane reports dRaw == lift + t·cos, so "occluder" is dRaw meaningfully
 * BELOW that height. (The old version guessed the lift as 2·minCell and
 * compared the 0.85-scaled d — with exact distances that made every
 * receiver's own plane an "occluder" past t·cos ≈ 1.5 voxels → false
 * radial shadow rings across open floors/ceilings.)
 *
 * `meshSdf` (optional) = a MeshSdfAtlas: per-mesh high-res local distance
 * fields min()ed against the scene field each step. Promoted meshes are
 * excluded from the scene field's seeds, so near them the crisp local data
 * is the only (and correct) contributor — this is what turns a thin-winged
 * character's blocky voxel shadow into a clean one.
 */
function createSDFShadowTrace(distanceTexture, bounds, res, cell, lift, meshSdf = null) {
  const minCell = Math.min(cell.x, cell.y, cell.z);
  const liftWorld = typeof lift === "number" ? lift : minCell * 2;
  const slotSize = meshSdf ? meshSdf.texture.image.width : 0;
  const atlasDepth = meshSdf ? meshSdf.texture.image.depth : 1;
  const sizeX = bounds.max.x - bounds.min.x;
  const sizeY = bounds.max.y - bounds.min.y;
  const sizeZ = bounds.max.z - bounds.min.z;

  return (origin, dir, maxT, k, cosRayNormal) => {
    const penumbra = float(1).toVar();
    const t = float(minCell * 2).toVar();

    Loop({ start: 0, end: 56, name: "sdfShadow" }, () => {
      If(t.greaterThanEqual(maxT), () => {
        Break();
      });
      const p = origin.add(dir.mul(t));
      const uvw = vec3(
        p.x.sub(bounds.min.x).div(sizeX),
        p.y.sub(bounds.min.y).div(sizeY),
        p.z.sub(bounds.min.z).div(sizeZ),
      ).toVar();
      If(
        uvw.x.lessThan(0)
          .or(uvw.y.lessThan(0))
          .or(uvw.z.lessThan(0))
          .or(uvw.x.greaterThan(1))
          .or(uvw.y.greaterThan(1))
          .or(uvw.z.greaterThan(1)),
        () => {
          Break();
        },
      );
      // Hardware trilinear; explicit level — implicit-derivative sampling
      // inside loops is illegal WGSL. RAW distance for classification and
      // the penumbra estimate (the field is exact near surfaces now); the
      // 0.85 safety factor applies to STEPPING only.
      const dRaw = texture3D(distanceTexture, uvw).level(0).r.mul(minCell).toVar();
      // Per-mesh SDFs: min() the crisp local fields in. Clamped sampling +
      // distance-to-slot-box keeps the value a valid lower bound everywhere,
      // and slots that can't improve dRaw skip their texture fetch.
      if (meshSdf) {
        for (let s = 0; s < meshSdf.slots.length; s++) {
          const slot = meshSdf.slots[s];
          If(slot.active.greaterThan(0.5), () => {
            const local = slot.worldToLocal.mul(vec4(p, 1)).xyz.toVar();
            const cellF = local.sub(slot.boundsMin).mul(slot.cellsPerLocal).toVar();
            const clamped = cellF.clamp(vec3(0.5), vec3(slot.dims).sub(0.5)).toVar();
            const outsideWorld = cellF
              .sub(clamped)
              .div(slot.cellsPerLocal)
              .length()
              .mul(slot.localToWorldScale)
              .toVar();
            If(outsideWorld.lessThan(dRaw), () => {
              const atlasUvw = vec3(
                clamped.x.div(slotSize),
                clamped.y.div(slotSize),
                clamped.z.add(s * slotSize).div(atlasDepth),
              );
              const dLocal = texture3D(meshSdf.texture, atlasUvw).level(0).r.mul(slot.distScale);
              dRaw.assign(dRaw.min(dLocal.add(outsideWorld)));
            });
          });
        }
      }
      const planeHeight = float(liftWorld).add(t.mul(cosRayNormal));
      const isRealOccluder = dRaw.lessThan(planeHeight.sub(minCell * 0.75));
      // Contact cut kept small (0.25·voxel) and only as an early-exit — the
      // graded part of the transition comes entirely from min(k·d/t) over the
      // exact near field. The old 0.6·voxel binary cut painted a hard inner
      // edge straight through every penumbra.
      If(isRealOccluder.and(dRaw.lessThan(minCell * 0.25)), () => {
        penumbra.assign(0);
        Break();
      });
      If(isRealOccluder, () => {
        penumbra.assign(penumbra.min(dRaw.mul(k).div(t)));
      });
      t.addAssign(dRaw.mul(0.85).clamp(minCell * 0.35, minCell * 8));
    });

    // Plain clamp — the estimator's own ramp is the penumbra. The previous
    // extra smoothstep(0,1,·) steepened every transition a second time.
    return penumbra.clamp(0, 1);
  };
}
