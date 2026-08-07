// COLD-BOOT PLACEHOLDER LIGHT — the decision half, kept pure so the one
// property that matters can actually be proven.
//
// WHY THIS IS ITS OWN FILE. In a GI-lit interior GI *is* the ambient, so the
// scene renders black from the first tick until the field's first composite —
// assets, then the shader compile wave, which is tens of seconds on a cold
// boot. A neutral hemisphere covers that window and fades out once GI lands.
// Harmless in principle; the implementation had a state it could not leave.
//
// The fade was gated on `state.statsLogged`. That is NOT a rendering predicate:
// it is the one-shot latch for the occupancy STATS LOG, and #maybeLogStats
// returns early unless the entry list is non-empty AND every entry is resident
// in the atlas. Neither condition has anything to do with whether GI is on
// screen. A scene that composites GI perfectly but has an empty entry list, or
// one entry that never lands in the atlas, kept a 0.6 blue-grey hemisphere over
// it forever — reported as "there is some weird ambient to the GI, even before
// the light itself loaded in ... yet scene does not have any ambient". The
// author was reading the scene graph correctly; the renderer was the liar.
//
// So: gate on `_compositedOnce` (the real signal, and the one #maybeLogStats is
// itself gated on a level up), AND cap the whole thing in ticks. Two exits
// rather than one, because the bug was not "the predicate was slightly wrong",
// it was "there existed exactly one way out and it could fail to arrive".
// `step()` below has no way to return `hold` forever — run-gi-boot-ambient-test
// asserts that over every reachable input, including a field that never
// composites at all.
//
// The light itself lives in GISystem (it needs THREE and the scene); this file
// decides only what should happen to it this tick.

/**
 * Hard ceiling in ticks. NOT a tuning value — it is what makes "the temporary
 * light never leaves" unreachable by construction. ~30s at 60fps is longer than
 * any observed cold boot; overshooting it shows a dark scene, which is at least
 * the truth.
 */
export const GI_BOOT_AMBIENT_MAX_TICKS = 1800;
/** Starting intensity of the hemisphere. */
export const GI_BOOT_AMBIENT_INTENSITY = 0.6;
/** Per-tick multiplier once fading — ~39 ticks from full to cutoff. */
export const GI_BOOT_AMBIENT_FADE = 0.9;
/** Below this the light is zeroed and released. */
export const GI_BOOT_AMBIENT_CUTOFF = 0.01;

/**
 * One tick of the boot-ambient state machine.
 *
 * FADES TO ZERO AND STAYS IN THE SCENE rather than being removed: removing a
 * light changes three's lights hash, which forces a second full material
 * recompile wave — the exact freeze this feature exists to paper over. A
 * zero-intensity hemisphere is a few dead uniforms per material. `"release"`
 * therefore means "zero it and drop our handle", not `scene.remove`.
 *
 * @param {object} s
 * @param {boolean} s.enabled       `props.bootAmbient` (and no kill hatch)
 * @param {boolean} s.hasState      GI has built its state object
 * @param {boolean} s.hasLight      we are currently holding a hemisphere
 * @param {boolean} s.composited    `_compositedOnce` — GI is on screen
 * @param {boolean} s.everComposited  a previous boot already finished its fade
 * @param {number}  s.ticks         ticks this light has been up
 * @param {number}  s.intensity     its current intensity
 * @returns {{action: "create"|"fade"|"release"|"hold"|"none",
 *            intensity: number, ticks: number, expired: boolean}}
 */
export function bootAmbientStep({
  enabled,
  hasState,
  hasLight,
  composited,
  everComposited,
  ticks = 0,
  intensity = 0,
}) {
  // Cold boot only. A rebuild keeps the previous field's light on screen, so
  // `everComposited` must never re-enter here — otherwise every rebuild would
  // flash a hemisphere over an already-lit scene.
  if (!hasLight) {
    if (enabled && !hasState && !everComposited) {
      return {
        action: "create",
        intensity: GI_BOOT_AMBIENT_INTENSITY,
        ticks: 0,
        expired: false,
      };
    }
    return { action: "none", intensity: 0, ticks: 0, expired: false };
  }

  const nextTicks = ticks + 1;
  const expired = nextTicks > GI_BOOT_AMBIENT_MAX_TICKS;
  // Three independent exits. `composited` is the normal one; `!enabled` lets the
  // Inspector toggle work as a live kill switch instead of queuing behind a
  // composite that may not be coming; `expired` is the backstop that makes the
  // reported bug unreachable regardless of what the field does.
  if (composited || !enabled || expired) {
    const next = intensity * GI_BOOT_AMBIENT_FADE;
    if (next < GI_BOOT_AMBIENT_CUTOFF) {
      return { action: "release", intensity: 0, ticks: nextTicks, expired };
    }
    return { action: "fade", intensity: next, ticks: nextTicks, expired };
  }
  return { action: "hold", intensity, ticks: nextTicks, expired };
}
