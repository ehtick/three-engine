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
    // Per-hit direct lighting inside reflections (Lumen-style). OPT-IN:
    // roughly doubles the shader compile wave and adds several ms of GPU
    // at editor resolutions, for a subtle reflection sharpening.
    hitLighting: false,
    emissiveShadows: true,
    autoRebake: true,
    debugProbes: "off",
  };
  static schema = [
    // ZERO-SETUP MODE: Auto Fit derives the volume from THIS component's
    // entity — a mesh entity uses its own bounding box (×1.05, so probes
    // sit just behind the walls); an empty entity uses the union of its
    // children's boxes (childless → the parent's). The Quality preset
    // derives ALL densities. When Auto Fit is on, the manual size/voxel/
    // probe fields below are ignored entirely.
    { key: "autoFit", label: "Auto Fit (entity bounds)", type: "boolean" },
    { key: "quality", label: "Quality", type: "select", options: ["low", "medium", "high", "ultra"] },
    { key: "sizeX", label: "Size X (manual mode)", type: "number", min: 4, max: 200, step: 1 },
    { key: "sizeY", label: "Size Y (manual mode)", type: "number", min: 2, max: 100, step: 1 },
    { key: "sizeZ", label: "Size Z (manual mode)", type: "number", min: 4, max: 200, step: 1 },
    { key: "voxelSize", label: "Voxel Size (manual mode)", type: "number", min: 0.1, max: 2, step: 0.05 },
    { key: "probeSpacing", label: "Probe Spacing (manual mode)", type: "number", min: 0.25, max: 8, step: 0.25 },
    { key: "cascadeCount", label: "Cascades", type: "number", min: 2, max: 6, step: 1 },
    { key: "c0DirRes", label: "C0 Dir Res", type: "select", options: [2, 4] },
    { key: "intensity", label: "Intensity", type: "number", min: 0, max: 10, step: 0.1 },
    // Fraction of secondary energy retained per pass — the pass itself is
    // an infinite-bounce feedback loop; values > 1 would diverge.
    { key: "bounce", label: "Bounce Energy", type: "number", min: 0, max: 1, step: 0.05 },
    // How fast streamed re-bakes blend into the live field. 1 = instant
    // snap (DISABLES the anti-flicker smoothing); 0.2-0.3 is the sweet spot.
    { key: "temporalBlend", label: "Bake Smoothing (1=off)", type: "number", min: 0.02, max: 1, step: 0.01 },
    { key: "reflections", label: "GI Reflections", type: "boolean" },
    { key: "hitLighting", label: "Reflection Hit Lighting (slow)", type: "boolean" },
    { key: "emissiveShadows", label: "Emissive Shadows", type: "boolean" },
    { key: "autoRebake", label: "Auto Re-bake", type: "boolean" },
    { key: "debugProbes", label: "Debug View", type: "select", options: ["off", "raw", "merged", "sdf"] },
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
