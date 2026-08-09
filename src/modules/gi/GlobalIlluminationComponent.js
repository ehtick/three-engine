import { Component } from "../../engine/components/Component.js";

/**
 * Global Illumination via 3D Radiance Cascades.
 *
 * The entity's world position is the volume center; size props define the
 * world-space AABB the GI covers. One component is active at a time (last
 * attached wins — same convention as Environment).
 *
 * Structural props (size, voxel size, probe spacing, cascade shape) rebuild
 * the GPU pipeline; `intensity` and `debugProbes` apply live. Scene changes
 * (moved meshes, edited materials, moved lights) re-bake the voxel grid
 * automatically (debounced) when `autoRebake` is on — lighting itself
 * re-traces every frame regardless, so it reacts within a frame of the
 * voxels updating.
 */
export class GlobalIlluminationComponent extends Component {
  static type = "global-illumination";
  static label = "Global Illumination";
  static tags = ["rendering", "lighting", "gi", "radiance-cascades"];
  // ZERO-SETUP BY DEFAULT: a freshly added component auto-fits the scene
  // and derives every density from the quality preset — enable and done.
  // (Saved scenes carry their own explicit props, so existing setups are
  // untouched by this default.)
  static defaults = {
    autoFit: true,
    quality: "medium",
    sizeX: 40,
    sizeY: 12,
    sizeZ: 40,
    voxelSize: 0.35,
    probeSpacing: 1.25,
    cascadeCount: 5,
    c0DirRes: 4,
    intensity: 1,
    // Sky light — the radiance a GI ray brings back when it escapes the
    // volume without hitting anything (see cascadeMerge's `sky`). Intensity 0
    // is the historical behaviour (escapes contribute black); it stays the
    // default so no existing scene changes until this is dialled up.
    skyColor: "#ffffff",
    skyIntensity: 0,
    bounce: 1,
    // Chroma of bounced light (1 = physical). Bounce color comes from each
    // mesh's MEAN albedo, which oversaturates patterned surfaces (a banner's
    // mean is pure red; its real weave bounces duller light) — dialling this
    // down desaturates the bleed toward its own luminance, energy preserved,
    // so colored bleed drops and neutral fill rises in the same move.
    bleedSaturation: 1,
    temporalBlend: 0.25,
    // Per-probe temporal smoothing of the gathered irradiance (1 = off). The
    // scene's geometry never moves, so a settled image is bit-identical at any
    // setting — this only damps the frame-to-frame wobble of the field under a
    // moving light. Lower = steadier but laggier.
    //
    // 0.02 — THE USER'S OWN FINDING (2026-08-02), on their Sponza, after the
    // discrete cliffs were removed from the feedback trace: bounce 1 +
    // smoothing 0.02 = "no flicker". That is a ~50-frame EMA, i.e. DDGI's
    // standard ~0.98 hysteresis — the industry answer to exactly this
    // problem. It could not work earlier because an EMA damps smooth jitter,
    // not binary square-waves; with the cliffs gone it is the right tool.
    // Cost: indirect light trails a fast-moving light by up to ~1s. Direct
    // light and shadows are three's own and stay instant.
    probeSmoothing: 0.02,
    // PEAK SPLIT — alternate the two halves of the awake pipeline (field
    // feedback on even frames, cascade transport on odd) instead of running
    // both every frame. Measured on Sponza/ultra: 6.3ms of GPU compute per
    // awake frame becomes a 3.9ms peak, which is the difference between
    // holding and missing a 120Hz frame budget while a light moves. The halves
    // are a ping-pong (each reads the other's output, never its own), so this
    // converges to the same answer at half the rate per half; `fieldSmoothing`
    // is rate-compensated so light response is unchanged. Turn OFF for the
    // absolute fastest GI RESPONSE at double the awake cost.
    peakSplit: true,
    reflections: true,
    // Per-triangle BVH reflections are an explicit High/Ultra opt-in. The
    // trace is shared by the half-resolution screen resolve; materials only
    // sample its cached result, so imported scenes no longer pay the old
    // per-material reflection-ray cost.
    exactReflections: false,
    // SPARSE FINE FIELD. The composited field is one cell per ~voxelSize, which
    // on a building-sized volume is decimetres — wider than the columns and
    // walls it has to occlude, so indirect light walks through them. This adds
    // a fp16 brick per surface-adjacent cell, giving traces sub-cell occlusion
    // for one extra texture fetch. Costs VRAM (the pool scales with quality),
    // which is why it is opt-in rather than always on.
    // TRACING BACKEND. "occupancy" hit-tests a conservative triangle-occupancy
    // pyramid with a hierarchical DDA (occupancyField.js); "sdf-legacy" sphere-
    // traces the composited per-mesh SDF field.
    //
    // OCCUPANCY IS THE DEFAULT because it is the one that does not leak: the
    // composited field is ~0.33m on a building-sized volume, so a 0.5m column
    // is one and a half cells wide and diffuse transport walks through it,
    // while occupancy is rasterized straight from triangles.
    //
    // "sdf-legacy" IS KEPT ON PURPOSE, and this is the honest reason: occupancy
    // costs a voxelization dispatch on every geometry change and a longer DDA
    // on every transport ray, and on a large real scene that has been enough to
    // hang a GPU outright (DXGI_ERROR_DEVICE_HUNG). It was deleted once, on the
    // grounds that one transport path is better than two — which is true right
    // up until the one path is the expensive one and there is nothing to fall
    // back to. Delete it again when occupancy has been measured on a
    // building-sized scene at every quality tier, not before.
    backend: "occupancy",
    // Stable ray-hit switch. All hybrid phases are implemented (brick-box →
    // exact-complex). "auto" follows the quality preset — the ladder's trade is
    // memory/cost vs hit precision, which is exactly what the presets already
    // arbitrate. Scenes with an explicit saved mode keep it.
    //
    // THE MAPPING, verbatim from rayHit/RayHitConfig.js AUTO_MODE_BY_QUALITY —
    // it is only TWO modes, not four:
    //     low    → hybrid-plane
    //     medium → hybrid-plane
    //     high   → hybrid-exact-complex
    //     ultra  → hybrid-exact-complex
    //     anything else (incl. "custom") → hybrid-exact-complex
    // The last line is `resolveAutoRayHitMode`'s `?? HybridExactComplex`
    // fallback, so an unrecognised QUALITY lands on the most precise mode, not
    // on plane-coverage.
    //
    // This comment used to document the commit-b5961d7 ladder — low→brick-box,
    // medium→plane, high→plane-coverage, ultra→exact-complex,
    // custom→plane-coverage. Commits 66d7ace and 7c6c605 replaced it: low left
    // brick-box (box hits quantize every silhouette to whole voxels, and low's
    // voxels are the biggest) and high was promoted to exact-complex (edge cells
    // fail the simple-plane fit, so without a triangle pool every rotated
    // caster's silhouette went back to full-voxel shadows). HybridBrickBox and
    // HybridPlaneCoverage are still implemented and still selectable BY NAME;
    // "auto" simply no longer picks either.
    //
    // UNKNOWN VALUES ARE NOT "auto" — `normalizeRayHitMode` (RayHitConfig.js)
    // ends in `?? RayHitMode.OccupancyLegacy`, so a stale or misspelled saved
    // mode string resolves to LEGACY, deliberately, so an experimental mode can
    // never silently turn GI off. Only the literal string "auto" reaches the
    // preset ladder above.
    rayHitMode: "auto",
    rayHitProfiling: false,
    // Phase-5 A/B kill switch for the hybrid traces' coarse pyramid ride.
    // Default ON — off exists to measure, not to ship.
    rayHitSkipDistance: true,
    // (`killSdf` lived here 2026-08-01 → 2026-08-02. SDF-free won on
    // measurement — the baked-SDF path put 207% of a lit frame's indirect into
    // a frame with NO direct light (the under-floor glow; the "colour bleed"
    // was the leak's own chroma) while SDF-free measured 0% at 86% of the
    // legitimate indirect (scripts/run-gi-sponza.mjs). The whole bake pipeline
    // — bakeCore.js, bakeWorker.js, the Library/gi-sdf cache, export
    // packaging, runtime browser bakes — is deleted; there is no SDF mode to
    // toggle back to. Saved scenes carrying the old prop are ignored.)
    sparseField: false,
    emissiveShadows: false,
    // AMBIENT OCCLUSION ON INDIRECT LIGHT (world-space, from the occupancy
    // pyramid's distance oracle — see giScreen's obscurance ladder). The
    // probe lattice is ~1m, so without this indirect light has no contact
    // darkening under props, corners or crevices. Applied to the gathered
    // irradiance only — emitter/analytic direct keep their traced shadows.
    // DEFAULT OFF: it is a look choice that only ever removes light, and it
    // shipped default-on in the same change that darkened the whole module
    // (see the vis³ note in cascadeGather) — which made it impossible to
    // tell the two apart. Opt in per scene.
    ao: false,
    aoStrength: 0.6,
    aoRadius: 0.6,
    // Screen-resolve resolution as a fraction of the drawing buffer. 0.5 is
    // the cost sweet spot; the GI-TRACED LIGHT SHADOWS and AO are computed
    // at this resolution, so their edges blend across silhouettes when
    // upsampled — "bad corners" under a bright sun. 1.0 removes that at
    // roughly 4× the resolve cost (still small next to the render).
    resolveScale: 0.5,
    // TOTAL-PIXEL CEILINGS on the two screen-space GI passes, and the reason
    // `resolveScale` alone is not enough: the resolve is sized from the
    // DRAWING BUFFER (canvas CSS size × devicePixelRatio), so a maximized
    // 4K/150% viewport quadruples the traced pixel count at an unchanged
    // scale — probe-measured 9ms → 22ms GPU, which is the "larger screen -
    // more ms, up to 70ms" report. A pixel BUDGET turns that into a flat cost
    // ceiling: past it the resolve shrinks isotropically and the
    // position-validated bilateral upsample reconstructs the full-res edges
    // anyway. Both were read by GISystem (#screenResolveSize /
    // #lightShadowSize) but declared NOWHERE until 2026-08-07, which made
    // them invisible to the Inspector and unsettable from MCP; these values
    // are the fallbacks that code already used, so nothing changes.
    resolveMaxPixels: 1_600_000,
    // The shadow channel's own ceiling, derived from (and never exceeding)
    // the resolve's. Its trace is the most expensive per-pixel work in the
    // module (~5-7ns/px measured) and every tap is re-validated against the
    // full-res gbuffer position by the material-side bilateral, so its pixel
    // count is a nearly-free cost knob.
    lightShadowMaxPixels: 1_900_000,
    autoRebake: true,
    // TEMPORARY LIGHT DURING COLD BOOT. In a GI-lit interior GI *is* the
    // ambient, so the scene renders black from the first tick until the field's
    // first composite — assets, then the shader compile wave, which can be tens
    // of seconds. This puts a neutral hemisphere up for that window and fades it
    // out the moment GI composites.
    // DEFAULT OFF, and it is off because it shipped on and was reported as a
    // bug: it adds a light the scene does not contain, with no outliner row and
    // no control, so the only honest default is one the author opts into. Turn
    // it on if you would rather see a flat-lit scene than a black one while the
    // field builds. See the boot-ambient block in GISystem#update.
    bootAmbient: false,
    debugProbes: "off",
  };
  // Every field below except `quality` and `intensity` carries `advanced:
  // true` (rendered in the Inspector's collapsed "Advanced" group — see
  // InspectorPanel's AdvancedFieldsSection) and `flipsToCustom: "quality"`
  // (editing it batches a `quality: "custom"` write into the SAME undo step
  // — see ComponentSection/MultiComponentSection's `renderField`). Selecting
  // a preset from the Quality dropdown itself never touches these values —
  // "custom" just means the preset name no longer implies any of them.
  // ── INERT WHILE THE DIFFUSE TRANSPORT IS ABSENT ──────────────────────────
  // The dense radiance cascades were deleted with the SRC rebuild's §12.8 unit
  // and Split Radiance Cascades replaces them in Phase 1-3 (see
  // `docs/GI_SRC_REBUILD_PLAN.md`). These keys have no consumer until then:
  // `cascadeCount`, `c0DirRes`, `bounce`, `bleedSaturation`, `temporalBlend`,
  // `probeSmoothing`, `peakSplit`, `skyColor`/`skyIntensity`.
  //
  // `sparseField` is a DIFFERENT and older case, found while making this cut and
  // worth stating plainly: it has been inert since 2026-08-02, not since §12.8.
  // Its gate in GISystem required `!killSdfEnabled()`, and that method has
  // returned an unconditional `true` ever since the SDF bake pipeline was
  // deleted — so this checkbox has done nothing for a week of sessions while
  // reading as a live quality knob. Left in place for scene compatibility only.
  // They are KEPT rather than removed because they are serialized into saved
  // scenes, because #applyLiveProps still routes them to live uniforms, and
  // because Phase 1-3 consumes every one of them unchanged — deleting them
  // would silently rewrite the user's authored values on the next save. The
  // module logs the absence at build (see GISystem's header); nothing here is
  // relabelled, because with NO diffuse indirect at all the inertness of an
  // individual bounce knob is not the thing a person would be confused by.
  // `probeSpacing` is the exception and stays live: it sizes the probe lattice
  // an auto-fit refit snaps to, whether or not anything traces it.
  static schema = [
    // ZERO-SETUP MODE: Auto Fit derives the volume from THIS component's
    // entity — a mesh entity uses its own bounding box (×1.05, so probes
    // sit just behind the walls); an empty entity uses the union of its
    // children's boxes (childless → the parent's). The Quality preset
    // derives ALL densities. When Auto Fit is on, the manual size/voxel/
    // probe fields below are ignored entirely.
    { key: "autoFit", label: "Auto Fit (entity bounds)", type: "boolean", advanced: true, flipsToCustom: "quality" },
    // "custom" is a real, selectable preset name: it never implies any
    // values of its own (the engine treats it as the "high" tier for
    // budgets/cadence — see GISystem's `qualityTierOf`), it just means the
    // advanced fields below were hand-edited and no longer match a preset.
    { key: "quality", label: "Quality", type: "select", options: ["low", "medium", "high", "ultra", "custom"] },
    { key: "sizeX", label: "Size X", type: "number", min: 4, max: 200, step: 1, advanced: true, flipsToCustom: "quality" },
    { key: "sizeY", label: "Size Y", type: "number", min: 2, max: 100, step: 1, advanced: true, flipsToCustom: "quality" },
    { key: "sizeZ", label: "Size Z", type: "number", min: 4, max: 200, step: 1, advanced: true, flipsToCustom: "quality" },
    { key: "voxelSize", label: "Voxel Size", type: "number", min: 0.1, max: 2, step: 0.05, advanced: true, flipsToCustom: "quality" },
    { key: "probeSpacing", label: "Probe Spacing", type: "number", min: 0.25, max: 8, step: 0.25, advanced: true, flipsToCustom: "quality" },
    { key: "cascadeCount", label: "Cascades", type: "number", min: 2, max: 6, step: 1, advanced: true, flipsToCustom: "quality" },
    { key: "c0DirRes", label: "C0 Dir Res", type: "select", options: [2, 4], advanced: true, flipsToCustom: "quality" },
    { key: "intensity", label: "Intensity", type: "number", min: 0, max: 10, step: 0.1 },
    // Deliberately NOT `advanced`/`flipsToCustom`: sky light is a LOOK control
    // like Intensity, not a quality/performance one, and in an open scene it
    // is usually the largest single contributor to how the shadows read —
    // burying it in Advanced is how you end up with a courtyard whose shadows
    // are black because nothing told you a sky existed to turn on.
    { key: "skyIntensity", label: "Sky Light", type: "number", min: 0, max: 20, step: 0.1 },
    { key: "skyColor", label: "Sky Color", type: "color" },
    // A LOOK control like Sky Light (deliberately not advanced): live
    // uniform, drag it while watching the scene. 1 = physical.
    { key: "bleedSaturation", label: "Bleed Saturation", type: "number", min: 0, max: 1, step: 0.05 },
    // Fraction of secondary energy retained per pass — the pass itself is
    // an infinite-bounce feedback loop; values > 1 would diverge.
    { key: "bounce", label: "Bounce Energy", type: "number", min: 0, max: 1, step: 0.05, advanced: true, flipsToCustom: "quality" },
    // How fast streamed re-bakes blend into the live field. 1 = instant
    // snap (DISABLES the anti-flicker smoothing); 0.2-0.3 is the sweet spot.
    { key: "temporalBlend", label: "Bake Smoothing (1=off)", type: "number", min: 0.02, max: 1, step: 0.01, advanced: true, flipsToCustom: "quality" },

    { key: "reflections", label: "GI Reflections", type: "boolean", advanced: true, flipsToCustom: "quality" },
    { key: "exactReflections", label: "Exact Reflections", type: "boolean", advanced: true, flipsToCustom: "quality" },
    { key: "backend", label: "Tracing Backend", type: "select", options: ["occupancy", "sdf-legacy"], advanced: true, flipsToCustom: "quality" },
    // A LOOK control like Sky Light, deliberately not advanced/flipsToCustom:
    // contact darkening is the single most visible realism knob after
    // intensity, and it costs a few bitset fetches at half res.
    { key: "ao", label: "Ambient Occlusion", type: "boolean" },
    { key: "aoStrength", label: "AO Strength", type: "number", min: 0, max: 1, step: 0.05, advanced: true },
    { key: "aoRadius", label: "AO Radius (m)", type: "number", min: 0.1, max: 3, step: 0.1, advanced: true },
    // Live (a resize rebuilds only the resolve compute): raise to 1.0 when
    // GI light shadows / AO fringe at silhouettes ("bad corners").
    { key: "resolveScale", label: "Resolve Scale", type: "number", min: 0.25, max: 1, step: 0.05, advanced: true },
    // Cost CEILINGS, not quality levels — deliberately not `flipsToCustom`,
    // for the same reason `resolveScale` and `probeSmoothing` are not: they
    // are what the machine can afford, and switching preset must not silently
    // reset them. The floor is 100k px (≈ 420×240 — below that the bilateral
    // has nothing left to reconstruct from); the ceiling is 8M px, past which
    // even a 4K drawing buffer at resolveScale 1.0 is never clamped, i.e.
    // "off". A budget of 0 reads as "unset" and falls back to the default —
    // use `resolveScale` to go smaller, not a zero budget.
    { key: "resolveMaxPixels", label: "Resolve Pixel Budget", type: "number", min: 100_000, max: 8_000_000, step: 100_000, advanced: true },
    { key: "lightShadowMaxPixels", label: "Shadow Pixel Budget", type: "number", min: 100_000, max: 8_000_000, step: 100_000, advanced: true },
    { key: "autoRebake", label: "Auto Re-bake", type: "boolean", advanced: true, flipsToCustom: "quality" },
    // Deliberately NOT `flipsToCustom`: whether you want a placeholder light
    // while the field builds is a preference about startup, not a quality tier,
    // and switching preset must not silently put a light back in the scene.
    { key: "bootAmbient", label: "Boot Ambient (until GI loads)", type: "boolean", advanced: true },
    // "occupancy" marches the pyramid with the SAME hierarchical DDA the
    // transport rays use, so it is the instrument for "is this column
    // actually in the field". "sdf" shows the distance oracle the shadow and
    // mirror traces read.
    // "raw" and "merged" (the per-probe cascade gizmos) were REMOVED, not left
    // inert: unlike the parked props above they sit inside a control whose
    // other options still work, so keeping them would mean two of five menu
    // entries silently doing nothing while the other two respond — the exact
    // dead-knob confusion this module keeps paying for. Phase 1-3 re-adds them
    // alongside the probes they visualize.
    { key: "debugProbes", label: "Debug View", type: "select", options: ["off", "sdf", "occupancy"], advanced: true, flipsToCustom: "quality" },

    // Deliberately NOT `flipsToCustom` — it is a stability knob, not a quality
    // level, and switching preset must not silently reset it.
    { key: "probeSmoothing", label: "Light Smoothing (1=off)", type: "number", min: 0.02, max: 1, step: 0.01, advanced: true },
    { key: "peakSplit", label: "Peak Split", type: "boolean", advanced: true },
    { key: "rayHitMode", label: "Ray Hit Mode", type: "select", options: ["auto", "occupancy-legacy", "hybrid-brick-box", "hybrid-plane", "hybrid-plane-coverage", "hybrid-exact-complex"], advanced: true },
    { key: "rayHitProfiling", label: "Ray Hit Profiling", type: "boolean", advanced: true },
    { key: "rayHitSkipDistance", label: "Ray Hit Empty-Space Skip", type: "boolean", advanced: true },
    { key: "sparseField", label: "Sparse Fine Field", type: "boolean", advanced: true, flipsToCustom: "quality" },
    { key: "emissiveShadows", label: "Emissive Shadows", type: "boolean", advanced: true, flipsToCustom: "quality" },
  ];

  get #system() {
    return this.entity?.engine?.modules?.get("gi")?.system ?? null;
  }

  onAttach() {
    this.#system?.attach(this);
  }

  onDetach() {
    this.#system?.detach(this);
  }

  onEnable() {
    this.#system?.attach(this);
  }

  onDisable() {
    // Keep attachment but drop runtime output; system checks `enabled` per
    // tick, and a disabled component's light should not linger.
    this.#system?.detach(this);
  }

  onPropChanged(key) {
    this.#system?.onComponentProp(this, key);
  }
}
