// @ts-check

/**
 * Evicts a GI build's compute nodes from the RENDERER's caches.
 *
 * ## Why `#dispose()` was not enough
 *
 * `GISystem#dispose` closes with:
 *
 *     // Compute nodes / storage buffers are released with GC once nothing
 *     // references them; three's storage attributes hold no scene-graph refs.
 *
 * True of the scene graph, false of the renderer. Every dispatched compute node
 * gets an entry in `renderer._pipelines` and `renderer._bindings`, and a BIND
 * GROUP holds strong references to every buffer and texture it binds. So the
 * old build's `bits` allocation (449 MB on Bistro), its occupancy field
 * (360 MB) and its SRC store (142 MB) stay reachable from the renderer after
 * `state.volume.dispose()` has run — `dispose()` frees the objects it knows
 * about and the renderer quietly keeps the memory.
 *
 * The tell is in the boot log: **516 pipelines compiled for 68 kernels**, about
 * 7.6 generations' worth. Every rebuild mints fresh compute nodes and three
 * keys pipelines on node id, so a rebuild is a guaranteed cache miss — the old
 * generation is never evicted, just orphaned in a cache that never shrinks.
 *
 * Measured symptom (user, 2026-08-17): "each time I change gi settings, it
 * rebuilds and memory heap is still climbing, currently having 6GB" — ~2 GB per
 * rebuild, flat while idle. At 13.4 GB the WebGPU device died outright
 * ("Instance dropped in popErrorScope").
 *
 * ## What this does
 *
 * `Bindings.deleteForCompute` destroys the bind groups (the thing actually
 * holding the buffers) and drops the node's cache entry; `Pipelines.delete`
 * drops the compiled pipeline. Both are three's own per-object eviction paths —
 * the same ones it calls when a compute node is disposed through channels GI
 * does not use.
 *
 * ⚠ ONLY EVER CALL THIS ON A NODE THE CALLER IS THROWING AWAY. Evicting a node
 * that is still dispatched costs a full recompile of that kernel — on this
 * project's SRC kernels that is 16-27 seconds, not a hitch.
 *
 * Defensive throughout: these are three's underscore-private caches (the same
 * ones `outputDither.js` already reaches into), so a three upgrade that renames
 * them must degrade to "leaks as before", never to a crash mid-rebuild.
 *
 * @param {any} renderer
 * @param {Iterable<any>} nodes
 * @returns {number} how many nodes were evicted
 */
export function releaseComputeNodes(renderer, nodes) {
  if (!renderer || !nodes) return 0;
  const bindings = renderer._bindings;
  const pipelines = renderer._pipelines;
  // `renderer._nodes` is a `NodeManager extends DataMap` holding each compute
  // node's BUILDER STATE — which references the bindings, which reference the
  // buffers. Evicting bindings + pipelines without it still leaked ~1.4 GB per
  // GI rebuild on Bistro (measured 2026-08-17: heap 3223 → 4625 MB across one
  // quality change with only the first two caches cleared).
  const nodeCache = renderer._nodes;
  if (!bindings && !pipelines && !nodeCache) return 0;
  let released = 0;
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    try {
      // Bindings first: it reads `nodes.getForCompute(node)` to find the bind
      // groups when its own cache entry is already gone, so evicting the
      // pipeline first would leave the bind groups — and the buffers — alive.
      bindings?.deleteForCompute?.(node);
      pipelines?.delete?.(node);
      // LAST, and that is not cosmetic: `deleteForCompute` above falls back to
      // `nodes.getForCompute(node)` to find the bind groups when its own entry
      // has already gone. Dropping the builder state first would make that
      // lookup rebuild the very state we are trying to discard.
      nodeCache?.delete?.(node);
      released++;
    } catch {
      // A node that was never dispatched has no cache entry to delete. That is
      // the common case for a build torn down during its compile wave, and it
      // must not abort the rest of the sweep.
    }
  }
  return released;
}

/**
 * Purges three's MATERIAL node-builder cache.
 *
 * The compute-node eviction above did not stop the heap climbing (measured
 * 2026-08-17: an identical `high` config read 1992 MB on its first build and
 * 6394 MB two rebuilds later, with GPU texture memory returning to exactly
 * 118 MB both times — so the GPU side is clean and this is pure JS heap).
 *
 * The compute kernels were never the bulk. A GI rebuild re-injects GI's nodes
 * into EVERY material, and on this project each material's fragment shader is
 * 180-250 kB of WGSL over a node graph many times that size in JS objects —
 * 116 materials of it. `NodeManager.nodeBuilderCache` is a plain `Map` keyed by
 * a material CACHE KEY, so a rebuild does not overwrite the old entries, it
 * adds new ones beside them under new keys. Nothing prunes them: the per-object
 * `delete()` path only runs for objects three is told about, and a GI rebuild
 * tells it about nothing.
 *
 * `NodeManager.dispose()` is three's own reset for this (`this.nodeBuilderCache
 * = new Map()`), and calling it costs a rebuild of the node states — which is
 * exactly what the GI rebuild that follows is about to do anyway, so the work
 * is not additional, only the eviction is.
 *
 * ⚠ GLOBAL, NOT GI-SCOPED. This drops cached node state for post-processing and
 * every other material too. That is safe (three rebuilds lazily on next use)
 * but it is not free, so it belongs ONLY on a teardown that is already followed
 * by a full recompile. `__giPurgeNodeCache = false` disables it.
 *
 * @param {any} renderer
 * @returns {boolean} whether the cache was purged
 */
export function purgeNodeBuilderCache(renderer) {
  if (globalThis.__giPurgeNodeCache === false) return false;
  const nodeCache = renderer?._nodes;
  if (typeof nodeCache?.dispose !== "function") return false;
  try {
    nodeCache.dispose();
    return true;
  } catch {
    return false;
  }
}

/**
 * Every compute node a GI `state` owns, de-duplicated.
 *
 * Deliberately a SCAN rather than a hand-written field list: the chain is
 * assembled across a dozen sites (`queue.push(...)`, `srcProbes.passes.push`),
 * and a list that has to be updated whenever a pass is added would silently
 * stop covering the newest kernels — which is the failure mode that produced
 * this leak in the first place. `isComputeNode` is three's own marker.
 *
 * @param {any} state
 * @returns {any[]}
 */
export function collectStateComputeNodes(state) {
  const found = new Set();
  if (!state) return [];
  const seen = new Set();
  const visit = (value, depth) => {
    if (!value || depth > 4 || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1);
      return;
    }
    // three marks compute nodes with `isComputeNode`; `.compute` is the wrapper
    // shape GI stores for its screen passes (`screen.resolve.compute`).
    if (value.isComputeNode === true) {
      found.add(value);
      return;
    }
    // ⚠ A KEY ALLOWLIST IS NOT ENOUGH — the first version of this used one and
    // silently missed `screen.resolve.compute`, because the wrapper is reached
    // through `resolve`, a name no list would have predicted. Every screen pass
    // has that shape (`screen.<passName>.compute`), so the walk has to be
    // general or it under-collects exactly the newest passes.
    //
    // Bounded instead by depth + the `seen` set, plus these bail-outs: `state`
    // holds `state.light`, a real Object3D, and walking into it would climb
    // `parent` into the whole scene graph. Nothing below any of these is ever a
    // compute node.
    if (
      value.isObject3D === true || value.isTexture === true ||
      value.isMaterial === true || value.isRenderTarget === true ||
      value.isBufferGeometry === true || value.isRenderer === true
    ) return;
    for (const key of Object.keys(value)) visit(value[key], depth + 1);
  };
  visit(state, 0);
  return [...found];
}
