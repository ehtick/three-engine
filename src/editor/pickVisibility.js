/**
 * Is this object something the user can see — and therefore something a click,
 * a drop or a depth probe may land on?
 *
 * three's Raycaster tests `layers`, never `visible`, so a hidden object stays
 * clickable unless it is filtered out here. But `visible === false` has two
 * meanings in this engine and only one of them is "not on screen":
 *
 *   - THE AUTHOR HID IT — the eye in the Hierarchy, a disabled component, an
 *     LOD level the group didn't pick. Genuinely not drawn, and hiding
 *     something is exactly how you click past it, so it must not be pickable.
 *
 *   - A PROXY CLAIMED IT — `userData.batchedInto` / `userData.mergedInto`.
 *     batching.js and merging.js hide their members, leave them in the scene
 *     graph and draw them through one proxy, and that proxy opts OUT of
 *     raycasting (`raycast = () => {}`) *precisely so* the click resolves
 *     against the real per-entity mesh. See the contract at the top of
 *     engine/batching.js. The member is on screen; only its own draw is gone.
 *
 * Missing the second case makes every batched or merged mesh unclickable: the
 * ray passes through the proxy (no raycast) and through the member (filtered
 * as invisible), so the click lands on nothing and clears the selection
 * instead. `autoBatching` is on by default and `staticMerging` is what an
 * imported environment gets turned on for, so that is most of a real scene.
 *
 * @param {any} object
 */
export function isPickVisible(object) {
  for (let node = object; node; node = node.parent) {
    if (node.visible === false && !isProxyHidden(node)) return false;
  }
  return true;
}

/** True when `object` is invisible only because a batch/merge proxy is drawing
 *  it. `mergedInto` is nulled on teardown, so a stale claim can't linger. */
export function isProxyHidden(object) {
  return !!(object.userData?.batchedInto || object.userData?.mergedInto);
}
