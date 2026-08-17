// @ts-check

import { ShadowNode } from "three/webgpu";

/**
 * Guards three's `ShadowNode.updateBefore` against its own null `shadowMap`.
 *
 * ## The crash
 *
 *     Uncaught TypeError: Cannot read properties of null (reading 'depthTexture')
 *       at ShadowNode.updateShadow ... at WebGPURenderer.render ... at #tick
 *
 * three r185, `ShadowNode.js`, verbatim:
 *
 *     updateBefore( frame ) {
 *       const { shadow } = this;
 *       let needsUpdate = shadow.needsUpdate || shadow.autoUpdate;   // :855
 *       ...
 *       if ( needsUpdate ) {
 *         this.updateShadow( frame );                                 // :871
 *         if ( this.shadowMap.depthTexture.version === ... )          // :873 UNGUARDED
 *
 *     updateShadow( frame ) {
 *       const { shadowMap, ... } = this;
 *       const depthVersion = shadowMap.depthTexture.version;          // :728 UNGUARDED
 *
 * `shadowMap` starts null (:222) and is only assigned in `setup()` (:584).
 * `_reset()` — reached from `dispose()` — sets it back to null (:820). So any
 * frame where `updateBefore` runs between a dispose and the next `setup()`
 * dereferences null. There is no guard on either line.
 *
 * ## Why the flags are not the fix
 *
 * The gate is an OR, so **`autoUpdate: true` arms it exactly as well as
 * `needsUpdate: true`** — the engine cannot dodge this by choosing the "safe"
 * flag, because there isn't one. The long-standing note that `autoUpdate` is
 * safe (because three "rebuilds through `setup()` first") describes a race that
 * usually resolves the lucky way, not a guarantee: whether `setup()` has re-run
 * by the time the node frame calls `updateBefore` depends on whether anything
 * asked the material to rebuild that frame.
 *
 * The engine legitimately disposes lights while they stay in the scene —
 * `GISystem#syncLightShadowNodes` calls `light.dispose()` on every gi-mode
 * transition specifically to drop `AnalyticLightNode`'s cached shadow branch —
 * so the null window is a normal state here, not a misuse.
 *
 * ## What the guard does
 *
 * Skips the update for the frames where there is no map to update, which is
 * what the missing `if` would have done. The shadow renders on the first frame
 * after `setup()` rebuilds it; nothing else changes, and `needsUpdate` is left
 * alone so three's own "did it actually render" bookkeeping still runs once the
 * map exists.
 *
 * Idempotent, and patched on the PROTOTYPE rather than per instance: the nodes
 * are created inside three's lighting builder, where the engine never sees them.
 * `PointShadowNode`/`CSMShadowNode` extend `ShadowNode` and inherit the fix.
 */
export function installShadowNodeGuard() {
  const proto = ShadowNode?.prototype;
  if (!proto || proto.__engineShadowMapGuard) return false;
  const original = proto.updateBefore;
  if (typeof original !== "function") return false;

  proto.updateBefore = function updateBefore(frame) {
    // `setup()` has not run (or `dispose()` nulled it). three would call
    // `updateShadow` anyway and dereference it.
    if (this.shadowMap === null || this.shadowMap === undefined) return;
    return original.call(this, frame);
  };
  proto.__engineShadowMapGuard = true;
  return true;
}
