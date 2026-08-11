// GLOBAL ILLUMINATION — THE WHOLE CONFIGURATION, IN ONE TABLE.
//
// The GI component declares exactly ONE authored property: `quality`. Every
// other number the module runs on is here, and this file is the only place any
// of them is written down.
//
// ══ WHY THERE IS ONLY ONE KNOB ═════════════════════════════════════════════
//
// The component used to declare 27 properties — volume size, voxel size, probe
// spacing, cascade count, bounce energy, bleed saturation, two smoothing rates,
// three AO fields, three resolve budgets, four ray-hit switches, sky colour and
// intensity, boot ambient, a debug view. They accumulated one session at a
// time, each defensible on its own, and together they turned every lighting
// question into a search:
//
//   "GI looks wrong" → which of the 27 is it?
//
// That is the wrong shape for this feature. GI is not a look to be dialled in;
// it is either CORRECT or it is BROKEN, and a knob that can make it wrong is a
// bug generator with a label on it. A quality preset is a different kind of
// thing: it trades COST against ACCURACY, and every level of it is supposed to
// be correct. So `quality` survives and nothing else does.
//
// ══ WHAT MOVED RATHER THAN DIED ════════════════════════════════════════════
//
// Two things were not tuning knobs and did not belong here in the first place:
//
// · **Sky light** (`skyColor`/`skyIntensity`) is a LIGHT SOURCE, not a dial.
//   It now comes from the scene's own environment — `scene.environment` and
//   `scene.environmentIntensity`, which is where three.js, the Scene Settings
//   panel and the HDRI Environment component already put image-based lighting.
//   GI reads it instead of owning a second, competing copy. See
//   `sceneSkyRadiance` below.
//
// · **The debug view** was never a lighting parameter — it draws an overlay and
//   has no path to the lit image at all. It is a developer instrument, so it
//   moved to `globalThis.__giDebugView` and out of the authored surface.
//
// ══ WHAT ABOUT SCENES THAT ALREADY SAVED THE OLD PROPS? ════════════════════
//
// They load. An undeclared property is ignored, so the extra keys sit inert
// until the next save drops them. A scene that had `intensity: 2` renders at 1
// afterwards, and that is the intended consequence rather than an accident: the
// point of the collapse is that no stored value can be quietly responsible for
// how the lighting looks.
//
// docs/GI_SRC_REBUILD_PLAN.md §6.

/** The presets, in cost order. The one and only authored choice. */
export const GI_QUALITY_LEVELS = ["low", "medium", "high", "ultra"];
const TIERS = new Set(GI_QUALITY_LEVELS);

/**
 * The tier a stored value selects for.
 *
 * Unrecognised — an old scene's "custom", a typo, an unset field — resolves to
 * "medium", the component's own default. It used to resolve to "high", which
 * made a corrupt value the most expensive setting; with the advanced fields
 * gone there is no "custom" to mean "hand-edited" any more, so the honest
 * fallback is the default rather than the ceiling.
 */
export function giQualityTier(quality) {
  return TIERS.has(quality) ? quality : "medium";
}

/**
 * Values that do NOT vary by preset, at exactly the defaults the 27-property
 * component shipped.
 *
 * Holding them constant is what makes the collapse provably a surface change:
 * the emitter-shadow probe and the GPU smoke must produce identical numbers
 * across it. Any decision to let a tier turn one of these on belongs in its own
 * commit, with the measurement that justifies it.
 *
 * Several are constant because the feature they name is PARKED — the dense
 * radiance cascades were deleted in the SRC rebuild (plan §12.8) and Split
 * Radiance Cascades restores the consumers in Phase 3-5. `bounce`,
 * `bleedSaturation`, `temporalBlend` and `probeSmoothing` are those. They stay
 * wired at their old defaults so the code paths that read them keep compiling
 * and mean the same thing when the transport returns.
 */
const CONSTANT = {
  // The volume always fits the scene. Manual size/voxel/spacing fields are
  // gone: auto-fit derives all three from the quality budget (GISystem's
  // QUALITY_BUDGETS), and a hand-set volume is exactly the kind of stored
  // value that silently stops matching the scene it was authored against.
  autoFit: true,

  // Artistic gain on indirect light, OUTSIDE the bounce loop. 1 = physical,
  // and physical is the only setting a correctness-shaped feature should have.
  intensity: 1,

  // Parked with the dense transport (plan §12.8). Kept at their defaults.
  bounce: 1,
  bleedSaturation: 1,
  temporalBlend: 0.25,
  probeSmoothing: 0.02,

  // Deferred screen-space reflections are always on; they cost one shared
  // trace that the resolve already runs.
  reflections: true,

  // "auto" follows the preset through RayHitConfig's AUTO_MODE_BY_QUALITY —
  // low/medium → hybrid-plane, high/ultra → hybrid-exact-complex. The named
  // modes are still implemented and still reachable from a harness; they are
  // simply not an authored choice, because "which intersection test does my
  // lighting use" is not a question a scene should have an opinion about.
  rayHitMode: "auto",
  rayHitProfiling: false,
  rayHitSkipDistance: true,

  // The emitter SYSTEM — despite the name, this gates far more than shadow
  // rays: the MAX_EMITTERS uniform slots, the per-frame promotion of emissive
  // meshes into them, the analytic receiver-direct term, and the slots SRC's
  // hit shader samples with NEE (`useNee = emitters.length > 0` is a
  // BUILD-time decision in srcShade.js).
  //
  // ON, and under SRC it cannot be otherwise: the promotion set is the NEE set
  // AND the analytic-direct set (R5, plan §12.29 — bake-time zeroing hands an
  // emitter's energy to exactly these two consumers), so with the slots absent
  // an emissive mesh's light is deleted from BOTH paths. That was the shipped
  // state this line fixes: "emissives do not work" (user, 2026-08-11) — SRC
  // compiled with `emitters: []` and the boot line read "4 lights, 0 emitters".
  //
  // What OFF used to buy is still bought elsewhere: with zero PROMOTED
  // emitters the warm-up skips the emitter-shadow chain outright and the
  // per-frame skips drop the trace and its bilateral (the "CAPABILITY IS NOT
  // USE" checks in GISystem) — so a scene with no emissive meshes pays
  // uniforms, not passes. Session 38's frame-cost concern was the cost of
  // emitters that EXIST, which is the feature working, not overhead.
  // `__giConfigOverride = { emissiveShadows: false }` remains the hatch.
  emissiveShadows: true,

  // Indirect-only ambient occlusion from the occupancy pyramid. OFF, unchanged
  // — it only ever removes light, and it shipped default-on once in the same
  // change that darkened the whole module, which made the two indistinguishable.
  // Note that SRC's own c0 resolve is already occlusion-shaped (transmittance
  // with no hit radiance IS ambient occlusion), so this is a second, older
  // mechanism rather than the only source of contact darkening.
  ao: false,
  aoStrength: 0.6,
  aoRadius: 0.6,

  // Cost CEILINGS in total pixels, not quality levels — what the machine can
  // afford. The resolve is sized from the drawing buffer, so a maximized 4K
  // viewport would otherwise quadruple the traced pixel count at an unchanged
  // scale (measured 9ms → 22ms GPU). Past the budget the resolve shrinks
  // isotropically and the position-validated bilateral reconstructs the edges.
  resolveMaxPixels: 1_600_000,
  lightShadowMaxPixels: 1_900_000,

  // A placeholder hemisphere while the field builds. OFF: it adds a light the
  // scene does not contain, with no outliner row, so the only honest default is
  // one nobody gets by surprise.
  bootAmbient: false,
};

/**
 * What each preset actually buys. Two entries — and the shortness is the point.
 *
 * Everything else a preset controls is already keyed on the tier NAME further
 * down (GISystem's `QUALITY_BUDGETS` for cells/probes/probe-axis, its trace
 * step ladder, `RayHitConfig`'s AUTO_MODE_BY_QUALITY, `SRC_QUALITY` for s₀,
 * rays-per-pixel and w₀). Duplicating those here would be a second definition
 * of the same ladder, which is how this module got 27 properties in the first
 * place.
 */
const BY_TIER = {
  // Half-res resolve. GI-traced light shadows and AO are computed at this
  // resolution, so their edges blend across silhouettes when upsampled — "bad
  // corners" under a bright sun. Ultra pays ~4× the resolve to remove it.
  low: { resolveScale: 0.5, exactReflections: false },
  medium: { resolveScale: 0.5, exactReflections: false },
  high: { resolveScale: 0.5, exactReflections: false },
  // Per-triangle BVH reflections. Previously an opt-in checkbox gated to
  // high/ultra and defaulting OFF, which meant it was reachable only by hand
  // and therefore almost never used. As a tier property it is reachable by
  // choosing the tier that is defined as "spend whatever it costs" — and it
  // stays off everywhere else, which is the protection the old gate existed
  // for (a stale flag turning a Medium scene into a 100-200ms/frame workload).
  ultra: { resolveScale: 1, exactReflections: true },
};

/**
 * The settled configuration for a component's props.
 *
 * Returns a PROPS-SHAPED object on purpose: every existing consumer
 * (`qualityTierOf`, `resolveRayHitConfig`, `#structuralSignature`,
 * `createSrcProbeSystem`) already reads these key names, so the collapse swaps
 * WHICH object they read rather than rewriting what they do with it.
 *
 * Frozen, because the entire premise is that nothing downstream gets to have an
 * opinion — a consumer that wants a different value has to come here and say so
 * where everyone can see it.
 */
export function resolveGiConfig(props, runtime = globalThis) {
  const quality = giQualityTier(props?.quality);
  const settled = { quality, ...CONSTANT, ...BY_TIER[quality] };
  // ── THE MEASUREMENT HATCH, AND WHY IT IS NOT A KNOB SURFACE ──────────────
  //
  // `globalThis.__giConfigOverride = { emissiveShadows: true }` forces any of
  // the values above. Probes need it: the emitter-shadow probe measures a
  // feature no preset turns on, and without a way to force it the probe reads
  // back a render target that was never built.
  //
  // This is the same category as the fifteen `__gi*` flags this module already
  // carries (`__giRayHitMode`, `__giNoBvhReflections`, `__giSrcProbes`, …) and
  // deliberately NOT the category the collapse removed: it is not authored, not
  // serialized, not in the Inspector, and not reachable from a scene. A stored
  // property is a value someone set months ago and forgot; a global set two
  // lines above the measurement that needs it is a different thing entirely.
  //
  // ONE hatch rather than one global per field, so the list cannot quietly grow
  // back into a parameter surface — anything a probe forces is visible at the
  // probe's own call site as a named object.
  const override = runtime?.__giConfigOverride;
  if (override && typeof override === "object") Object.assign(settled, override);
  return Object.freeze(settled);
}

/**
 * SKY RADIANCE FROM THE SCENE'S OWN ENVIRONMENT — what a GI ray brings back
 * when it escapes without hitting anything.
 *
 * `scene.environment` is three.js's image-based light and `environmentIntensity`
 * scales it; the Scene Settings panel writes both, and so does the HDRI
 * Environment component. Reading them is what lets GI drop its own sky
 * properties without dropping the sky.
 *
 * NO ENVIRONMENT MEANS NO SKY, exactly. That is not a fallback chosen for
 * tidiness — it is what keeps this change behaviour-identical: `skyIntensity`
 * defaulted to 0, so every existing scene had no sky term, and every existing
 * scene still has none until someone gives it an environment.
 *
 * `scene.background` is deliberately NOT consulted. A background is a backdrop
 * and three itself distinguishes the two — treating the editor's default dark
 * grey as a light source would put a dim ambient into every scene ever made and
 * would break the "sky = 0 asserts exactly 0 lit pixels" gate, which exists
 * because light from nothing is the failure signature this module has shipped
 * three times.
 *
 * OPEN, AND STATED RATHER THAN HIDDEN: the sky's CHROMA is not read. An
 * environment map's average colour needs a 1×1 downsample of the cube map (a
 * GPU readback, or an average computed when the image decodes), so a sunset
 * HDRI currently contributes NEUTRAL sky at the right brightness. Colour
 * belongs with Phase 5's hit shading, which is where the environment has to be
 * sampled per-direction anyway.
 *
 * @param {THREE.Scene} scene
 * @param {THREE.Color} out  written in place — this runs per frame
 */
export function sceneSkyRadiance(scene, out) {
  const environment = scene?.environment;
  if (!environment) return out.setRGB(0, 0, 0);
  const intensity = Math.max(0, scene.environmentIntensity ?? 1);
  return out.setRGB(intensity, intensity, intensity);
}

/**
 * The debug overlay, as a developer switch rather than an authored property.
 *
 * "off" | "sdf" | "occupancy" | "src-probes". Set `globalThis.__giDebugView`
 * from the console or a harness. Polled rather than pushed — every reader is
 * already in a per-frame path, and a string compare per frame is cheaper than
 * the change notification would be.
 */
export function giDebugView() {
  const view = globalThis.__giDebugView;
  return typeof view === "string" ? view : "off";
}
