import * as THREE from "three/webgpu";

/**
 * LOD selection maths (roadmap item 14).
 *
 * Pure functions, no scene graph: a threshold decision that can only be
 * observed by looking at a rendered frame is a threshold decision nobody can
 * test, and "the trees pop at the wrong distance" is the kind of report that
 * takes an afternoon to reproduce.
 *
 * ## Screen height, not distance
 *
 * The tempting knob is a distance: "swap to LOD1 at 30 metres". It is wrong in
 * three independent ways, and each one only shows up after the level is built:
 *
 *   - **Field of view.** An LOD chain tuned on a 60° camera pops in the middle
 *     of the frame the moment the player aims down a 20° scope, because the
 *     tree is now three times bigger on screen at the same distance.
 *   - **Scale.** Duplicating a rock and scaling it 4× should push its switch
 *     distance out 4×. With a distance threshold it does not, so the big rock
 *     turns to mush while it still fills a quarter of the screen.
 *   - **Resolution and aspect** move it again.
 *
 * All three disappear if the threshold is *how much of the frame the object
 * covers*, which is what the LOD is actually about: the level is a claim about
 * how many pixels the silhouette deserves. This is Unity's screen-relative
 * transition height, and it is the right metric for the same reasons.
 */

const _delta = new THREE.Vector3();

/**
 * The fraction of the viewport's HEIGHT covered by `sphere`, as seen by
 * `camera`. 1 means the object spans the frame top to bottom; 0.01 means it is
 * a hundredth of it.
 *
 * Height rather than width, and rather than area: height is invariant to the
 * aspect ratio, so the same authored numbers hold in a 21:9 ultrawide and in a
 * 9:16 phone build. Area would be the more intuitive "how much of the screen",
 * and is the one that changes meaning when someone resizes the window.
 */
export function screenCoverage(sphere, camera) {
  if (!sphere || !camera) return 1;
  const diameter = sphere.radius * 2;
  if (!(diameter > 0)) return 0;

  if (camera.isOrthographicCamera) {
    // No perspective divide, so distance is irrelevant: an orthographic camera
    // renders a prop the same size from ten metres and from a thousand. Running
    // the perspective formula here would make LOD level a function of how far
    // away the camera happens to have been parked, which on an isometric game
    // means the whole map swapping levels when the camera dollies back.
    const height = Math.abs(camera.top - camera.bottom) / (camera.zoom || 1);
    return height > 0 ? Math.min(diameter / height, 1) : 1;
  }

  // Euclidean distance to the sphere's centre, not depth along the view axis.
  // Depth makes an object's level change as it slides across the frame at a
  // constant distance from the viewer — it gets *further* in a straight line
  // while its z-depth stays put, and the LOD would refine rather than coarsen.
  const distance = _delta.subVectors(sphere.center, camera.position).length();
  // Inside the sphere: it fills the view by definition, and the formula below
  // divides by zero on the way to saying so.
  if (distance <= 1e-6) return 1;
  const fov = ((camera.fov ?? 50) * Math.PI) / 180;
  // three's PerspectiveCamera folds `zoom` into the projection the same way,
  // so a zoomed camera has to count as being nearer or a sniper scope shows
  // the LOD authored for a distant silhouette.
  const frustumHeight = (2 * distance * Math.tan(fov / 2)) / (camera.zoom || 1);
  return frustumHeight > 0 ? Math.min(diameter / frustumHeight, 1) : 1;
}

/**
 * Which level should be showing at `coverage`.
 *
 * `levels[i]` is the MINIMUM screen height at which child `i` is used, so the
 * array descends and its last entry doubles as the cull point: a final `0`
 * means "this level renders all the way out", any other value means the group
 * stops drawing below it. One array, no separate culled knob to keep in sync
 * with a level someone just deleted.
 *
 * Returns the level index, or -1 for culled.
 *
 * ## Hysteresis is not a polish item
 *
 * An object parked exactly on a threshold — which is where an object the player
 * is walking toward spends a moment, and where an object orbiting a fixed
 * camera can sit indefinitely — flips level every frame. That reads as a
 * flicker, and it is worse than it looks: every switch invalidates the static
 * batches the level's props are drawn in (see `batching.js`), so a single
 * shimmering tree can put the whole scene into a batch rebuild every frame.
 *
 * So the CURRENT level's band is widened by `hysteresis` at both ends and the
 * level only changes on leaving the widened band. The dead-band is relative to
 * the threshold rather than absolute, so one setting behaves the same at a
 * coverage of 0.6 and of 0.006.
 */
export function selectLod(coverage, levels, { hysteresis = 0.05, current = null } = {}) {
  if (!Array.isArray(levels) || levels.length === 0) return -1;

  // The band the current level would have to leave. Checked before the raw
  // answer so a level that is merely at its edge stays put.
  if (typeof current === "number" && current >= -1 && current < levels.length) {
    if (current === -1) {
      // Culled. Only un-cull once clearly back above the last threshold.
      if (coverage < levels[levels.length - 1] * (1 + hysteresis)) return -1;
    } else {
      const lower = levels[current] * (1 - hysteresis);
      // Level 0 has no finer level above it, so its band is open at the top.
      const upper = current > 0 ? levels[current - 1] * (1 + hysteresis) : Infinity;
      if (coverage >= lower && coverage < upper) return current;
    }
  }

  let level = 0;
  while (level < levels.length && coverage < levels[level]) level++;
  return level < levels.length ? level : -1;
}

/**
 * Thresholds for `count` levels, keeping whatever the author already set.
 *
 * A new child added to an LOD group has to get *some* threshold, and 0 would
 * mean "never shown until everything else is culled" — a level that silently
 * does nothing, which looks exactly like the feature being broken. Each new
 * level defaults to half the coverage of the one before it, which is the
 * doubling of distance that a well-built LOD chain is usually cut for.
 */
export function fitLevels(levels, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    if (typeof levels?.[i] === "number") {
      out.push(levels[i]);
      continue;
    }
    const previous = out[i - 1] ?? 1;
    out.push(i === count - 1 ? 0 : Number((previous / 2).toFixed(4)));
  }
  // The chain must descend, or a level between two others can never be
  // selected: `selectLod` walks down and stops at the first threshold the
  // coverage clears, so an out-of-order entry is simply unreachable.
  for (let i = 1; i < out.length; i++) {
    if (out[i] > out[i - 1]) out[i] = out[i - 1];
  }
  return out;
}
