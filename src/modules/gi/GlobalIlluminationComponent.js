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
  static label = "Global Illumination (RC)";
  static tags = ["rendering", "lighting", "gi", "radiance-cascades"];
  // ZERO-SETUP BY DEFAULT: a freshly added component auto-fits the scene
  // and derives every density from the quality preset — enable and done.
  // (Saved scenes carry their own explicit props, so existing setups are
  // untouched by this default.)
  static defaults = {
    autoFit: true,
    quality: "high",
    sizeX: 40,
    sizeY: 12,
    sizeZ: 40,
    voxelSize: 0.35,
    probeSpacing: 1.25,
    cascadeCount: 5,
    c0DirRes: 4,
    intensity: 1,
    bounce: 1,
    temporalBlend: 0.25,
    reflections: true,
    // Per-triangle BVH reflections are an explicit High/Ultra opt-in. The
    // trace is shared by the half-resolution screen resolve; materials only
    // sample its cached result, so imported scenes no longer pay the old
    // per-material reflection-ray cost.
    exactReflections: false,
    emissiveShadows: true,
    autoRebake: true,
    debugProbes: "off",
  };
  // Every field below except `quality` and `intensity` carries `advanced:
  // true` (rendered in the Inspector's collapsed "Advanced" group — see
  // InspectorPanel's AdvancedFieldsSection) and `flipsToCustom: "quality"`
  // (editing it batches a `quality: "custom"` write into the SAME undo step
  // — see ComponentSection/MultiComponentSection's `renderField`). Selecting
  // a preset from the Quality dropdown itself never touches these values —
  // "custom" just means the preset name no longer implies any of them.
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
    { key: "sizeX", label: "Size X (manual mode)", type: "number", min: 4, max: 200, step: 1, advanced: true, flipsToCustom: "quality" },
    { key: "sizeY", label: "Size Y (manual mode)", type: "number", min: 2, max: 100, step: 1, advanced: true, flipsToCustom: "quality" },
    { key: "sizeZ", label: "Size Z (manual mode)", type: "number", min: 4, max: 200, step: 1, advanced: true, flipsToCustom: "quality" },
    { key: "voxelSize", label: "Voxel Size (manual mode)", type: "number", min: 0.1, max: 2, step: 0.05, advanced: true, flipsToCustom: "quality" },
    { key: "probeSpacing", label: "Probe Spacing (manual mode)", type: "number", min: 0.25, max: 8, step: 0.25, advanced: true, flipsToCustom: "quality" },
    { key: "cascadeCount", label: "Cascades", type: "number", min: 2, max: 6, step: 1, advanced: true, flipsToCustom: "quality" },
    { key: "c0DirRes", label: "C0 Dir Res", type: "select", options: [2, 4], advanced: true, flipsToCustom: "quality" },
    { key: "intensity", label: "Intensity", type: "number", min: 0, max: 10, step: 0.1 },
    // Fraction of secondary energy retained per pass — the pass itself is
    // an infinite-bounce feedback loop; values > 1 would diverge.
    { key: "bounce", label: "Bounce Energy", type: "number", min: 0, max: 1, step: 0.05, advanced: true, flipsToCustom: "quality" },
    // How fast streamed re-bakes blend into the live field. 1 = instant
    // snap (DISABLES the anti-flicker smoothing); 0.2-0.3 is the sweet spot.
    { key: "temporalBlend", label: "Bake Smoothing (1=off)", type: "number", min: 0.02, max: 1, step: 0.01, advanced: true, flipsToCustom: "quality" },
    { key: "reflections", label: "GI Reflections", type: "boolean", advanced: true, flipsToCustom: "quality" },
    { key: "exactReflections", label: "Exact Reflections (High/Ultra)", type: "boolean", advanced: true, flipsToCustom: "quality" },
    { key: "emissiveShadows", label: "Emissive Shadows", type: "boolean", advanced: true, flipsToCustom: "quality" },
    { key: "autoRebake", label: "Auto Re-bake", type: "boolean", advanced: true, flipsToCustom: "quality" },
    { key: "debugProbes", label: "Debug View", type: "select", options: ["off", "raw", "merged", "sdf"], advanced: true, flipsToCustom: "quality" },
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
