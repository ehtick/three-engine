import * as TSL from "three/tsl";

// `ssgi` and `ssr` are imported lazily so a project that never wires those
// nodes pays nothing for them AND the whole module catalog still loads when
// the user is on a build that doesn't ship the addons. The first time the
// compiler encounters one of those nodes it dynamically imports the addon and
// memoises the resolved function for the rest of the session; a failed import
// resolves to null and that node compiles to a passthrough.
//
// (An older note here claimed SSRNode's `RNoise` / `SpecularHelpers` deps were
// missing from the npm package. They ship — as `tsl/utils/*`, which is what
// SSRNode's own `../utils/` resolves to from `tsl/display/`.)

/**
 * Node-based post-processing graph for cameras.
 *
 * Shape: { nodes: [{ id, type, props, position }], edges: [{ source, sourceHandle, target, targetHandle }] }
 *
 * Compiles to TSL: the only Output node must be wired into a chain starting
 * from one of the three auto-built Input sockets (color / depth / normal).
 * The compiler resolves the Input socket lazily (per-frame, via the
 * component-provided `beautyNode` / `depthNode` / `normalNode`) so the graph
 * stays portable across cameras.
 *
 * compilePostGraph(graph, ctx) returns
 *   { output, signature, updateParams(newGraph) }
 * where:
 *   - output: a TSL `vec4` (the final post-processed color) that the
 *     component feeds into a fullscreen NodeMaterial quad.
 *   - signature: structure-only fingerprint (string).
 *   - ctx: { camera, beautyNode, depthNode, normalNode } — Input-node bodies
 *     read these by the port's "kind" so the graph compiler doesn't need to
 *     know which camera owns it. The Input node also exposes velocity for
 *     temporal effects such as TRAA.
 *
 * Every param with `kind: "hot"` compiles to a TSL uniform so the editor's
 * slider drags refresh the GPU without rebuilding pipelines; structural
 * edits (wires, booleans, selects, asset paths, sliceCount, etc.) force a
 * rebuild via signature mismatch.
 */

// ---------------------------------------------------------------------------
// Param helpers
// ---------------------------------------------------------------------------

const num = (key, label, def, extra = {}) => ({ kind: "hot", key, label, type: "number", default: def, ...extra });
const sel = (key, label, def, options) => ({ kind: "struct", key, label, type: "select", default: def, options });
const bool = (key, label, def) => ({ kind: "struct", key, label, type: "boolean", default: def });

// Per-effect resolution scale. Structural (not hot) because it resizes the
// addon's offscreen render target — a real pipeline change, not a uniform.
// String options because the select control round-trips strings; builders
// parse with parseFloat. Screen-space GI/reflections/glow are low-frequency
// signals, so half or quarter res is usually indistinguishable after the
// upsample+denoise — and costs 1/4 or 1/16 of the fill.
const resScale = (def = "1") => sel("resolutionScale", "Resolution", def, ["0.25", "0.5", "0.75", "1"]);

// ---------------------------------------------------------------------------
// Node registry
// ---------------------------------------------------------------------------

export const PP_NODE_TYPES = {
  // --- Sources: the three auto-fed camera inputs ---------------------------
  input: {
    label: "Input",
    category: "source",
    inputs: [],
    outputs: [
      { key: "color", kind: "vec4" },
      { key: "depth", kind: "float" },
      { key: "normal", kind: "vec3" },
      { key: "velocity", kind: "vec4" },
    ],
    params: [],
  },

  // --- GI / Reflections ---------------------------------------------------
  ssgi: {
    label: "SSGI",
    category: "gi",
    inputs: [
      { key: "color", kind: "vec4" },
      { key: "depth", kind: "float" },
      { key: "normal", kind: "vec3" },
    ],
    // Two distinct outputs — the addon's offscreen target holds the AO
    // and GI results in separate texture slices (SSGINode.js:303, 311).
    // We expose each as its own socket so the user can compose them
    // downstream with mul/add nodes exactly like three's example
    // composite (`beauty.rgb * ao + diffuse.rgb * gi.rgb`). Treating
    // each channel as a flat pass-through socket also dodges the
    // red-screen bug we hit when we tried to blend an R8 texture
    // (vec4 with meaningful .r only) against a vec3 color inside a
    // single vertex of TSL — the type-system coercion produced a
    // dominant red output. By leaving blending to the user's
    // arithmetic nodes, the WGSL stays unambiguous.
    outputs: [
      { key: "ao", kind: "float" },
      { key: "gi", kind: "vec3" },
    ],
    // Mirrors the params exposed by three's webgpu_postprocessing_ssgi
    // example (`giPass.sliceCount.value = 2`, `gui.add(giPass.radius, 'value', 1, 25)`).
    // Each entry maps directly onto a UniformNode (or plain boolean) on
    // the SSGINode addon. `useTemporalFiltering` is a JS boolean on the
    // addon (see SSGINode.js:193) rather than a uniform — the build step
    // assigns it directly. Defaults match the addon's own.
    params: [
      // --- Quality / sampling ---
      // Half res by default: SSGI is a low-frequency signal and full-res
      // tracing was the single biggest chunk of the "post doubles my frame
      // time" report. Existing graphs keep whatever they saved.
      resScale("0.5"),
      num("sliceCount", "Slice Count", 2, { min: 1, max: 4, step: 1 }),
      num("stepCount", "Step Count", 8, { min: 1, max: 32, step: 1 }),
      num("radius", "Radius", 12, { min: 1, max: 25, step: 0.5 }),
      num("expFactor", "Exp Factor", 2, { min: 1, max: 3, step: 0.01 }),
      num("thickness", "Thickness", 1, { min: 0.01, max: 10, step: 0.01 }),
      // --- Composition intensities (drive AO/GI multiplier inside the
      // addon's own shader — see SSGINode.js:631, 634) ---
      num("aoIntensity", "AO Intensity", 1, { min: 0, max: 4, step: 0.01 }),
      num("giIntensity", "GI Intensity", 10, { min: 0, max: 100, step: 0.1 }),
      num("backfaceLighting", "Backface Light", 0, { min: 0, max: 1, step: 0.01 }),
      // --- Toggles (boolean params, not numeric) ---
      bool("useLinearThickness", "Linear Thickness", false),
      bool("useScreenSpaceSampling", "Screen-space Sampling", false),
      bool("useTemporalFiltering", "Temporal Filter", true),
    ],
  },
  ssr: {
    label: "SSR",
    category: "gi",
    inputs: [
      { key: "color", kind: "vec4" },
      { key: "depth", kind: "float" },
      { key: "normal", kind: "vec3" },
    ],
    outputs: [{ key: "out", kind: "vec4" }],
    params: [
      // Half res by default — same rationale as SSGI.
      resScale("0.5"),
      bool("stochastic", "Stochastic", false),
      num("intensity", "Intensity", 1.0, { min: 0, max: 4, step: 0.05 }),
      // How far a ray may travel, in WORLD UNITS, before the reflection is
      // abandoned. SSRNode constructs this as `uniform(1)` (SSRNode.js:168)
      // and we never assigned it, so every SSR node in the editor reflected
      // exactly one metre of scene and gave up — the reach has to be set to
      // something scene-sized to be useful. It bounds both the march and the
      // addon's own (1 - d/maxDistance)² falloff, so it is the single knob
      // that decides how far reflections carry.
      num("maxDistance", "Max Distance", 20, { min: 0.1, max: 500, step: 0.1 }),
      // Depth-crossing tolerance in view-space units: how far behind the
      // depth buffer a ray may pass and still count as hitting that surface.
      // Too small and rays tunnel through thin geometry (holes in the
      // reflection); too large and far surfaces smear onto near ones. The
      // addon floors it per-pixel at three texels of view-space width, so
      // this acts as the upper bound.
      num("thickness", "Thickness", 0.1, { min: 0.001, max: 5, step: 0.001 }),
      // March density. In mirror mode this is steps per screen-space texel of
      // ray length, so cost scales with `maxDistance` — a longer reach at the
      // same quality is a longer loop. In stochastic mode it's a fraction of
      // the addon's fixed 64-step budget instead.
      num("quality", "Quality", 0.5, { min: 0.05, max: 1, step: 0.05 }),
      // UV-space width of the fade applied as a hit approaches the screen
      // border. Longer rays reach further off-screen, so without this the
      // reflections of objects leaving the frame pop out at the edge.
      num("screenEdgeFade", "Edge Fade", 0.2, { min: 0, max: 0.5, step: 0.01 }),
      // THE ROUGHNESS GATE (2026-08-15). Mirror mode traces ONE reflection ray
      // and fakes roughness by sampling a mip chain of the reflection buffer at
      // `lod = roughness² × 4` (SSRNode.js:462-466), where each mip is a
      // 5-tap box blur with `separation = mip index`. Past ~0.5 roughness that
      // is a sparse tap pattern over a 1/8–1/16-res buffer, so a small very
      // bright region in the reflection (a sunlit floor, a window slit) comes
      // back as HARD-EDGED BRIGHT RECTANGLES rather than a soft sheen — the
      // user's banner curtains, whose gold thread is metal at roughness
      // 0.76–0.94 in the source ORM. Three's own code treats ≥0.25 as fully
      // non-glossy (`glossiness = 1 - min(r/0.25, 1)`), so there is nothing to
      // recover up there: rough metal wants many samples (`stochastic: true`
      // plus a denoiser) or an env/GI term, not a blurred mirror.
      // Fades out over `[maxRoughness, maxRoughness + 0.15]`, so 1 = never
      // fades = the pre-2026-08-15 behaviour.
      num("maxRoughness", "Max Roughness", 0.6, { min: 0.05, max: 1, step: 0.01 }),
      // The addon's own bright-sample clamp (SSRNode.js:1273-1274) — it
      // normalizes any sample whose luminance exceeds this. Unassigned it sits
      // at 10, which lets a blown sunlit pixel dominate a whole blur footprint.
      num("maxLuminance", "Max Luminance", 10, { min: 0.1, max: 100, step: 0.1 }),
      bool("reflectNonMetals", "Reflect Non-metals", false),
      // Bisects the coarse depth crossing toward the exact intersection.
      // Compile-time constant in the addon, hence structural here. Worth its
      // eight extra depth fetches once rays are long enough that one march
      // step spans several texels — which, at any useful `maxDistance`, is
      // every step.
      bool("binaryRefine", "Refine Hits", true),
    ],
  },
  gtao: {
    label: "AO (GTAO)",
    category: "gi",
    inputs: [
      { key: "color", kind: "vec4" },
      { key: "depth", kind: "float" },
      { key: "normal", kind: "vec3" },
    ],
    // `color` is the finished composite (beauty × AO) so the common case is
    // one wire; `ao` is the bare float term for users who want it inside
    // their own arithmetic (before a GI add, after a fog mix, etc.).
    outputs: [
      { key: "color", kind: "vec4" },
      { key: "ao", kind: "float" },
    ],
    params: [
      // Half res by default: AO is low-frequency, the built-in denoise blurs
      // anyway, and full-res horizon marching is exactly the "post doubles my
      // frame time" cost class. Same rationale as SSGI/SSR.
      resScale("0.5"),
      // ⚠ The addon constructs radius as `uniform(0.25)` — a quarter of a
      // WORLD UNIT, tuned for three's demo scenes (trap #1 in this file's
      // ledger: addon defaults are not scene-scale). 0.5 m reads as contact
      // shading at door/crate scale in a metre-scaled scene.
      num("radius", "Radius", 0.5, { min: 0.05, max: 4, step: 0.05 }),
      // The addon's `scale` uniform — the exponent-ish strength of the
      // occlusion term. Its own default.
      num("scale", "Intensity", 1, { min: 0, max: 4, step: 0.05 }),
      // View-space depth band a sample may sit behind the depth buffer and
      // still occlude — the same knob SSR calls thickness.
      num("thickness", "Thickness", 1, { min: 0.01, max: 10, step: 0.01 }),
      num("distanceExponent", "Distance Exp", 1, { min: 0.5, max: 4, step: 0.1 }),
      num("distanceFallOff", "Distance Falloff", 1, { min: 0, max: 1, step: 0.01 }),
      // ≥30 switches the addon from 3 to 5 horizon directions (GTAONode's
      // DIRECTIONS select) — 16 is its own default.
      num("samples", "Samples", 16, { min: 4, max: 64, step: 1 }),
      // The raw pass shimmers BY CONSTRUCTION — GTAO rotates its sample
      // pattern through 6 temporal frames — so the denoise is on by default
      // and structural (it changes which passes exist).
      bool("denoise", "Denoise", true),
    ],
  },
  denoise: {
    label: "Denoise",
    category: "gi",
    // The addon's `denoise(textureNode, depthNode, normalNode, camera)`
    // signature: `textureNode` is the noisy signal (typically the SSGI
    // composited result or the GI/AO texture itself), `depthNode` /
    // `normalNode` are spatial cues used by the bilateral-like filter.
    // We accept `normal` as optional (caller can leave it unwired); the
    // addon will reconstruct normals from depth when null — same fallback
    // we use for SSGI/SSR.
    inputs: [
      { key: "color", kind: "vec4" },
      { key: "depth", kind: "float" },
      { key: "normal", kind: "vec3" },
    ],
    outputs: [{ key: "out", kind: "vec4" }],
    params: [
      // The four φ values exposed by DenoiseNode (UniformNode<float>).
      // Defaults match three's own defaults; the user can widen any of
      // them to make the filter more permissive (smoother but blurrier)
      // or narrow them for sharper but noisier output.
      num("radius", "Radius", 5, { min: 1, max: 32, step: 0.5 }),
      num("lumaPhi", "Luma φ", 5, { min: 0.1, max: 32, step: 0.1 }),
      num("depthPhi", "Depth φ", 5, { min: 0.1, max: 32, step: 0.1 }),
      num("normalPhi", "Normal φ", 5, { min: 0.1, max: 32, step: 0.1 }),
    ],
  },
  traa: {
    label: "TRAA",
    category: "gi",
    // Temporal reprojection must run after the noisy SSGI composite. Depth
    // and velocity come from the same scene pass so the history reprojection
    // remains aligned with the current color buffer.
    inputs: [
      { key: "color", kind: "vec4" },
      { key: "depth", kind: "float" },
      { key: "velocity", kind: "vec4" },
    ],
    outputs: [{ key: "out", kind: "vec4" }],
    params: [],
  },

  // --- Color grading ------------------------------------------------------
  brightness: {
    label: "Brightness",
    category: "color",
    inputs: [{ key: "color", kind: "vec4" }],
    outputs: [{ key: "out", kind: "vec4" }],
    params: [num("amount", "Amount", 0, { min: -1, max: 1, step: 0.01 })],
  },
  contrast: {
    label: "Contrast",
    category: "color",
    inputs: [{ key: "color", kind: "vec4" }],
    outputs: [{ key: "out", kind: "vec4" }],
    params: [num("amount", "Amount", 1, { min: 0, max: 3, step: 0.01 })],
  },
  saturation: {
    label: "Saturation",
    category: "color",
    inputs: [{ key: "color", kind: "vec4" }],
    outputs: [{ key: "out", kind: "vec4" }],
    params: [num("amount", "Amount", 1, { min: 0, max: 3, step: 0.01 })],
  },
  colorBalance: {
    label: "Color Balance",
    category: "color",
    inputs: [{ key: "color", kind: "vec4" }],
    outputs: [{ key: "out", kind: "vec4" }],
    params: [
      num("red", "Red", 1, { min: 0, max: 2, step: 0.01 }),
      num("green", "Green", 1, { min: 0, max: 2, step: 0.01 }),
      num("blue", "Blue", 1, { min: 0, max: 2, step: 0.01 }),
    ],
  },
  levels: {
    label: "Levels",
    category: "color",
    inputs: [{ key: "color", kind: "vec4" }],
    outputs: [{ key: "out", kind: "vec4" }],
    params: [
      num("black", "Black", 0, { min: 0, max: 1, step: 0.001 }),
      num("white", "White", 1, { min: 0, max: 1, step: 0.001 }),
      num("gamma", "Gamma", 1, { min: 0.1, max: 4, step: 0.01 }),
    ],
  },
  tonemap: {
    label: "Tone Map",
    category: "color",
    inputs: [{ key: "color", kind: "vec4" }],
    outputs: [{ key: "out", kind: "vec4" }],
    params: [
      sel("mode", "Mode", "aces", ["none", "linear", "reinhard", "cineon", "aces", "agx", "neutral"]),
      num("exposure", "Exposure", 1, { min: 0, max: 4, step: 0.01 }),
    ],
  },

  // --- Effects ------------------------------------------------------------
  vignette: {
    label: "Vignette",
    category: "effect",
    inputs: [{ key: "color", kind: "vec4" }],
    outputs: [{ key: "out", kind: "vec4" }],
    params: [
      num("intensity", "Intensity", 0.4, { min: 0, max: 2, step: 0.01 }),
      num("smoothness", "Smoothness", 0.6, { min: 0.01, max: 1, step: 0.01 }),
    ],
  },
  grain: {
    label: "Film Grain",
    category: "effect",
    inputs: [{ key: "color", kind: "vec4" }],
    outputs: [{ key: "out", kind: "vec4" }],
    params: [num("amount", "Amount", 0.05, { min: 0, max: 1, step: 0.005 })],
  },
  pixelate: {
    label: "Pixelate",
    category: "effect",
    inputs: [{ key: "color", kind: "vec4" }],
    outputs: [{ key: "out", kind: "vec4" }],
    params: [num("size", "Pixel Size", 4, { min: 1, max: 32, step: 1 })],
  },

  // --- Blends -------------------------------------------------------------
  mix: {
    label: "Mix",
    category: "blend",
    inputs: [
      { key: "a", kind: "vec4" },
      { key: "b", kind: "vec4" },
      { key: "t", kind: "float" },
    ],
    outputs: [{ key: "out", kind: "vec4" }],
    params: [num("t", "T", 0.5, { min: 0, max: 1, step: 0.01 })],
  },
  add: {
    label: "Add",
    category: "blend",
    inputs: [{ key: "a", kind: "vec4" }, { key: "b", kind: "vec4" }],
    outputs: [{ key: "out", kind: "vec4" }],
    params: [],
  },
  multiply: {
    label: "Multiply",
    category: "blend",
    inputs: [{ key: "a", kind: "vec4" }, { key: "b", kind: "vec4" }],
    outputs: [{ key: "out", kind: "vec4" }],
    params: [],
  },
  // Mixed-type arithmetic — the SSGI node exposes separate `ao` (float)
  // and `gi` (vec3) outputs, and composing `beauty * ao + beauty * gi`
  // needs vec3-by-float and vec3-by-vec3 multiplication that the vec4
  // blend nodes above can't express. These three thin nodes mirror the
  // example's `vec3 * ao + vec3 * gi.rgb` composite. Each is a pure
  // TSL `vec3`-in / `vec3`-out node, so they stay unambiguous in WGSL
  // and don't trigger the vec3-by-vec4 broadcast that produced the
  // red-screen bug when everything was packed into one output.
  vec3MulF: {
    label: "vec3 × float",
    category: "blend",
    inputs: [
      { key: "a", kind: "vec3" },
      { key: "b", kind: "float" },
    ],
    outputs: [{ key: "out", kind: "vec3" }],
    params: [],
  },
  vec3MulV: {
    label: "vec3 × vec3",
    category: "blend",
    inputs: [
      { key: "a", kind: "vec3" },
      { key: "b", kind: "vec3" },
    ],
    outputs: [{ key: "out", kind: "vec3" }],
    params: [],
  },
  vec3Add: {
    label: "vec3 + vec3",
    category: "blend",
    inputs: [
      { key: "a", kind: "vec3" },
      { key: "b", kind: "vec3" },
    ],
    outputs: [{ key: "out", kind: "vec3" }],
    params: [],
  },
  // vec4↔vec3 shape conversions — needed because the SSGI composite
  // reads/writes vec3 but the Input node and most downstream post-fx
  // nodes are vec4. Each is a typed TSL constructor so the WGSL stays
  // unambiguous (no implicit vec4→vec3 broadcasts that lose precision).
  swizzleRGB: {
    label: "Swizzle RGB",
    category: "blend",
    inputs: [{ key: "color", kind: "vec4" }],
    outputs: [{ key: "out", kind: "vec3" }],
    params: [],
  },
  packRGB: {
    label: "Pack RGB→vec4",
    category: "blend",
    inputs: [
      { key: "rgb", kind: "vec3" },
      { key: "a", kind: "float" },
    ],
    outputs: [{ key: "out", kind: "vec4" }],
    params: [],
  },
  screen: {
    label: "Screen",
    category: "blend",
    inputs: [{ key: "a", kind: "vec4" }, { key: "b", kind: "vec4" }],
    outputs: [{ key: "out", kind: "vec4" }],
    params: [],
  },

  // --- Masking ------------------------------------------------------------
  depthMask: {
    label: "Depth Mask",
    category: "mask",
    inputs: [
      { key: "color", kind: "vec4" },
      { key: "depth", kind: "float" },
    ],
    outputs: [{ key: "out", kind: "vec4" }],
    params: [
      num("near", "Near", 0, { min: 0, max: 1, step: 0.001 }),
      num("far", "Far", 1, { min: 0, max: 1, step: 0.001 }),
    ],
  },

  // --- Sink ---------------------------------------------------------------
  output: {
    label: "Output",
    category: "output",
    inputs: [{ key: "color", kind: "vec4" }],
    outputs: [],
    params: [],
  },

  // =========================================================================
  // Post-fx nodes (one per three TSL addon). All are `vec4`->`vec4` pass-
  // throughs so they chain naturally after our SSGI composite (`packRGB`).
  // Each accepts the recommended params from the addon's own API and falls
  // back to a passthrough if the addon fails to load (so a stripped three
  // build doesn't crash the graph).
  // =========================================================================
  bloom: {
    label: "Bloom",
    category: "effect",
    // `bloom(input, strength, radius, threshold)` — three's TSL addon.
    inputs: [{ key: "color", kind: "vec4" }],
    outputs: [{ key: "out", kind: "vec4" }],
    params: [
      // BloomNode's own internal default is 0.5 — the blur chain rarely
      // needs full res since the result is a soft glow by definition.
      resScale("0.5"),
      num("strength", "Strength", 1.0, { min: 0, max: 3, step: 0.01 }),
      num("radius", "Radius", 0.0, { min: 0, max: 1, step: 0.01 }),
      // Three's BloomNode default is 0 (every pixel contributes). A higher
      // editor default keeps ordinary scene colors sharp and blooms only
      // bright/emissive areas.
      num("threshold", "Threshold", 0.8, { min: 0, max: 3, step: 0.005 }),
    ],
  },
  godrays: {
    label: "God Rays",
    category: "effect",
    // `godrays(depthNode, camera, lightSource)`. The light source is a
    // scene Object3D whose screen-space position drives the radial blur.
    // Only `density` is exposed as a uniform on the addon itself (the
    // other classic params — decay, weight, exposure, samples — are
    // hard-coded inside the shader). We surface `density` as the
    // user-facing knob.
    inputs: [
      { key: "color", kind: "vec4" },
      { key: "depth", kind: "float" },
    ],
    outputs: [{ key: "out", kind: "vec4" }],
    params: [
      // GodraysNode's internal default is 0.5; radial blur is even more
      // forgiving of low res than bloom.
      resScale("0.5"),
      num("density", "Density", 0.7, { min: 0, max: 1, step: 0.005 }),
    ],
  },
  depthOfField: {
    label: "Depth of Field",
    category: "effect",
    // `dof(input, viewZ, focusDistance, focalLength, bokehScale)`. We use
    // the post-process depth (.x of the linearised depth texture's .y) as
    // `viewZ`. Focal distance defaults to 5 (world units along the view
    // direction); focal length bokeh scale tunable in the panel.
    inputs: [
      { key: "color", kind: "vec4" },
      { key: "depth", kind: "float" },
    ],
    outputs: [{ key: "out", kind: "vec4" }],
    params: [
      num("focusDistance", "Focus", 5.0, { min: 0.1, max: 200, step: 0.1 }),
      num("focalLength", "Focal Length", 24, { min: 1, max: 200, step: 0.1 }),
      num("bokehScale", "Bokeh Scale", 1, { min: 0, max: 10, step: 0.05 }),
    ],
  },
  chromaticAberration: {
    label: "Chromatic Aberration",
    category: "effect",
    // `chromaticAberration(input, strength, center?, scale?)`. Strength
    // exaggerates the per-channel uv split; scale enlarges the chromatic
    // dispersion radius (1.1 baseline matches three's example).
    inputs: [{ key: "color", kind: "vec4" }],
    outputs: [{ key: "out", kind: "vec4" }],
    params: [
      num("strength", "Strength", 0.005, { min: 0, max: 0.1, step: 0.0005 }),
      num("scale", "Scale", 1.1, { min: 0.5, max: 5, step: 0.01 }),
    ],
  },
  film: {
    label: "Film Grain",
    category: "effect",
    // `film(input)` — adds procedural monochromatic noise. Param-driven
    // uniforms: intensity controls whether and how strongly grain shows.
    inputs: [{ key: "color", kind: "vec4" }],
    outputs: [{ key: "out", kind: "vec4" }],
    params: [
      num("intensity", "Intensity", 0.5, { min: 0, max: 5, step: 0.01 }),
    ],
  },
  fxaa: {
    label: "FXAA",
    category: "effect",
    // `fxaa(input)` — fast approximate anti-aliasing. No params.
    inputs: [{ key: "color", kind: "vec4" }],
    outputs: [{ key: "out", kind: "vec4" }],
    params: [],
  },
  smaa: {
    label: "SMAA",
    category: "effect",
    // `smaa(input)` — subpixel morphological AA. Heavier than FXAA but
    // typically sharper on edges. Pulls in extra edge-detection lookup
    // textures behind the scenes; addon handles it.
    inputs: [{ key: "color", kind: "vec4" }],
    outputs: [{ key: "out", kind: "vec4" }],
    params: [],
  },
  sobel: {
    label: "Sobel Edge",
    category: "effect",
    // `sobel(input)` — runs Sobel edge detection; output is greyscale
    // edges. Compose with the beauty downstream via mul/screen to taste.
    inputs: [{ key: "color", kind: "vec4" }],
    outputs: [{ key: "out", kind: "vec4" }],
    params: [],
  },
  rgbShift: {
    label: "RGB Shift",
    category: "effect",
    // `rgbShift(input, amount, angle)` — radial chromatic offset.
    inputs: [{ key: "color", kind: "vec4" }],
    outputs: [{ key: "out", kind: "vec4" }],
    params: [
      num("amount", "Amount", 0.005, { min: 0, max: 0.1, step: 0.0005 }),
      num("angle", "Angle", 0, { min: -Math.PI, max: Math.PI, step: 0.01 }),
    ],
  },
  sharpen: {
    label: "Sharpen",
    category: "effect",
    // `sharpen(input, sharpness, denoise)` — unsharp-mask style sharpen
    // with an optional auxiliary denoise pass. Keep sharpness < 1 for
    // sane results.
    inputs: [{ key: "color", kind: "vec4" }],
    outputs: [{ key: "out", kind: "vec4" }],
    params: [
      num("sharpness", "Sharpness", 0.5, { min: 0, max: 2, step: 0.01 }),
      num("denoise", "Denoise", 0.0, { min: 0, max: 1, step: 0.01 }),
    ],
  },
  afterImage: {
    label: "After Image",
    category: "effect",
    // `afterImage(input, damp)` — feedback trailing effect. damp in
    // [0, 1): higher = longer trails.
    inputs: [{ key: "color", kind: "vec4" }],
    outputs: [{ key: "out", kind: "vec4" }],
    params: [num("damp", "Damp", 0.96, { min: 0, max: 0.999, step: 0.001 })],
  },
  sepia: {
    label: "Sepia",
    category: "effect",
    // `sepia(color, opacity)` — full sepia tone. Exposed via opacity.
    inputs: [{ key: "color", kind: "vec4" }],
    outputs: [{ key: "out", kind: "vec4" }],
    params: [num("opacity", "Opacity", 1.0, { min: 0, max: 1, step: 0.01 })],
  },
  bleach: {
    label: "Bleach Bypass",
    category: "effect",
    // `bleach(color, opacity)` — silver-bleach look. Slightly desaturates
    // and boosts contrast at the same time. Opacity mixes with input.
    inputs: [{ key: "color", kind: "vec4" }],
    outputs: [{ key: "out", kind: "vec4" }],
    params: [num("opacity", "Opacity", 1.0, { min: 0, max: 1, step: 0.01 })],
  },
  dotScreen: {
    label: "Dot Screen",
    category: "effect",
    // `dotScreen(input, angle, scale)` — half-tone style dot screen.
    inputs: [{ key: "color", kind: "vec4" }],
    outputs: [{ key: "out", kind: "vec4" }],
    params: [
      num("angle", "Angle", 1.57, { min: 0, max: Math.PI * 2, step: 0.01 }),
      num("scale", "Scale", 1, { min: 0.1, max: 5, step: 0.01 }),
    ],
  },
  lut3D: {
    label: "LUT 3D",
    category: "color",
    // `lut3D(input, lutTexture, size, intensity)`. We currently don't
    // expose lut asset picking in the editor — the node compiles but is
    // gated behind the user wiring a Lut3D texture node separately.
    // Intensity mixes the LUT'd output with the source.
    inputs: [{ key: "color", kind: "vec4" }],
    outputs: [{ key: "out", kind: "vec4" }],
    params: [num("intensity", "Intensity", 1.0, { min: 0, max: 1, step: 0.01 })],
  },
  gaussianBlur: {
    label: "Gaussian Blur",
    category: "effect",
    // `gaussianBlur(input, direction, sigma, options?)`. Direction is a
    // vec2 (separate x/y pass). For the user-facing node we bake it to
    // successive horizontal/vertical passes; the editor exposes a single
    // sigma. Heavier than bloom but no threshold gating.
    inputs: [{ key: "color", kind: "vec4" }],
    outputs: [{ key: "out", kind: "vec4" }],
    params: [num("sigma", "Sigma", 2, { min: 0.1, max: 16, step: 0.05 })],
  },
  bilateralBlur: {
    label: "Bilateral Blur",
    category: "effect",
    // `bilateralBlur(input, direction, sigma, sigmaColor)`. Edge-aware;
    // sigmaColor gates by per-pixel luminance difference. Useful as a
    // cheap noise smoother when the SSGI pass leaves visible grain.
    inputs: [
      { key: "color", kind: "vec4" },
      { key: "depth", kind: "float" },
    ],
    outputs: [{ key: "out", kind: "vec4" }],
    params: [
      num("sigma", "Sigma", 1, { min: 0.1, max: 8, step: 0.05 }),
      num("sigmaColor", "Sigma Color", 0.4, { min: 0, max: 1, step: 0.01 }),
    ],
  },
  motionBlur: {
    label: "Motion Blur",
    category: "effect",
    // `motionBlur(input, velocity, numSamples)` uses the auto-fed velocity MRT.
    inputs: [{ key: "color", kind: "vec4" }],
    outputs: [{ key: "out", kind: "vec4" }],
    params: [num("samples", "Samples", 8, { min: 1, max: 64, step: 1 })],
  },
  fsr1: {
    label: "FSR1 Upscale",
    category: "effect",
    // `fsr1(input, sharpness, denoise)` — AMD's FSR 1.0 quality upscale.
    // Use as the last node before `Output.color` to render at half
    // resolution then upscale.
    inputs: [{ key: "color", kind: "vec4" }],
    outputs: [{ key: "out", kind: "vec4" }],
    params: [
      num("sharpness", "Sharpness", 0.2, { min: 0, max: 2, step: 0.01 }),
      num("denoise", "Denoise", 0.0, { min: 0, max: 1, step: 0.01 }),
    ],
  },
};

/** Categories drive both the palette group headers and the panel header order. */
export const PP_CATEGORY_LABELS = {
  source: "Sources",
  gi: "GI / Reflections",
  color: "Color Grading",
  effect: "Effects / Filters",
  blend: "Blends",
  mask: "Masks",
  output: "Output",
};

/** Used by the editor to label the auto-fed Input sockets. */
export const INPUT_PORT_LABELS = {
  color: "Color",
  depth: "Depth",
  normal: "Normal",
  velocity: "Velocity",
};

/** Returns default props for a node type. */
export function nodeDefaults(type) {
  const meta = PP_NODE_TYPES[type];
  return Object.fromEntries(
    (meta?.params ?? []).map((p) => [p.key, Array.isArray(p.default) ? [...p.default] : p.default]),
  );
}

// ---------------------------------------------------------------------------
// Default graph: a one-node passthrough (Color → Output) so a freshly added
// PostProcessComponent renders the scene unchanged until the user adds nodes.
// ---------------------------------------------------------------------------

export const DEFAULT_POST_GRAPH = {
  nodes: [
    { id: "input", type: "input", props: {}, position: { x: 80, y: 160 } },
    { id: "output", type: "output", props: {}, position: { x: 480, y: 180 } },
  ],
  edges: [{ source: "input", sourceHandle: "color", target: "output", targetHandle: "color" }],
};

// ---------------------------------------------------------------------------
// Quality presets — kept in one place so editor + compiler share the values.
// ---------------------------------------------------------------------------

// (sliceCount, stepCount) — the SSGINode's two main knobs. The renderer
// scales per-pixel cost linearly with sliceCount*stepCount*2.
// Optional one-click quality presets. The SSGI registry defaults below
// already mirror `medium`; this table is reserved for a future quality
// dropdown on the SSGI node and intentionally kept around so palette
// actions can flip slice/step counts together.
const SSGI_QUALITY_PRESETS = {
  low: { sliceCount: 1, stepCount: 8 },
  medium: { sliceCount: 2, stepCount: 8 },
  high: { sliceCount: 3, stepCount: 16 },
};

// Lazy addon resolvers. The first node compile triggers the dynamic import;
// subsequent compiles use the cached promise. A failed import (addon not
// bundled in this three build) keeps `null` here forever and the compiler
// falls back to a no-op for that node, so a missing addon never crashes
// the whole graph. We cache once per addon key, keyed by the module's
// installed side effect — every import() here resolves a string keyed off
// the source module path.
//
// The exported `loadXxx()` helpers select the addon key and named export.
const _lazyResolvers = new Map(); // key -> { promise, reject }

// Keep these imports as literal specifiers. Vite can rewrite/package a
// literal dynamic import, but `/* @vite-ignore */ import(modulePath)` leaves
// the bare `three/addons/...` string for the browser, where it is not a valid
// URL and produces "Failed to resolve module specifier".
const _addonLoaders = {
  ssgi: () => import("three/addons/tsl/display/SSGINode.js"),
  ssr: () => import("three/addons/tsl/display/SSRNode.js"),
  gtao: () => import("three/addons/tsl/display/GTAONode.js"),
  denoise: () => import("three/addons/tsl/display/DenoiseNode.js"),
  traa: () => import("three/addons/tsl/display/TRAANode.js"),
  bloom: () => import("three/addons/tsl/display/BloomNode.js"),
  godrays: () => import("three/addons/tsl/display/GodraysNode.js"),
  depthAwareBlend: () => import("three/addons/tsl/display/depthAwareBlend.js"),
  dof: () => import("three/addons/tsl/display/DepthOfFieldNode.js"),
  chromaticAberration: () => import("three/addons/tsl/display/ChromaticAberrationNode.js"),
  film: () => import("three/addons/tsl/display/FilmNode.js"),
  fxaa: () => import("three/addons/tsl/display/FXAANode.js"),
  smaa: () => import("three/addons/tsl/display/SMAANode.js"),
  sobel: () => import("three/addons/tsl/display/SobelOperatorNode.js"),
  rgbShift: () => import("three/addons/tsl/display/RGBShiftNode.js"),
  sharpen: () => import("three/addons/tsl/display/SharpenNode.js"),
  afterImage: () => import("three/addons/tsl/display/AfterImageNode.js"),
  sepia: () => import("three/addons/tsl/display/Sepia.js"),
  bleach: () => import("three/addons/tsl/display/BleachBypass.js"),
  dotScreen: () => import("three/addons/tsl/display/DotScreenNode.js"),
  lut3D: () => import("three/addons/tsl/display/Lut3DNode.js"),
  gaussianBlur: () => import("three/addons/tsl/display/GaussianBlurNode.js"),
  bilateralBlur: () => import("three/addons/tsl/display/BilateralBlurNode.js"),
  motionBlur: () => import("three/addons/tsl/display/MotionBlur.js"),
  fsr1: () => import("three/addons/tsl/display/FSR1Node.js"),
};

function lazyLoad(key, exportName) {
  let entry = _lazyResolvers.get(key);
  if (!entry) {
    // `/* @vite-ignore */` tells Vite to skip its dynamic-import
    // analyzer for this call. The analyzer couldn't statically resolve
    // `modulePath` (it's a parameter, not a string literal) and was
    // emitting the same warning every compile:
    //
    //   The above dynamic import cannot be analyzed by Vite.
    //   ...
    //
    // With the comment, Vite leaves the import expression untouched so
    // the string survives into the browser bundle. The browser then
    // resolves the literal `"three/addons/..."` against Vite's runtime
    // resolver — which we've configured in `vite.config.js` with a
    // `resolve.alias` that maps `three/addons` → `three/examples/jsm`.
    // That alias runs at the resolution step and rewrites the
    // specifier before any module-graph dispatch, so the addons load
    // even though Rollup's optimizer never saw them.
    const promise = (_addonLoaders[key] ? _addonLoaders[key]() : Promise.resolve(null))
      .then((m) => m[exportName] ?? null)
      .catch((err) => {
        console.warn(`Post-process addon "${key}" not available: ${err.message ?? err}`);
        return null;
      });
    entry = { promise, resolved: false };
    _lazyResolvers.set(key, entry);
  }
  return entry.promise;
}

/** Drops every memoised factory. Used by the engine when the renderer is rebuilt. */
export function resetLazyPostAddons() {
  for (const key of _lazyResolvers.keys()) _lazyResolvers.delete(key);
}

export function loadSSGI() {
  return lazyLoad("ssgi", "ssgi");
}
export function loadSSR() {
  return lazyLoad("ssr", "ssr");
}
export function loadGTAO() {
  return lazyLoad("gtao", "ao");
}
// Poisson-Gaussian denoise (Khademi et al. WACV 2021). Bundled in r185
// alongside the optional SSGI/SSR addons; only depends on the SimplexNoise
// utility (also bundled).
export function loadDenoise() {
  return lazyLoad("denoise", "denoise");
}
export function loadTRAA() {
  return lazyLoad("traa", "traa");
}
export function loadBloom() {
  return lazyLoad("bloom", "bloom");
}
export function loadGodrays() {
  return lazyLoad("godrays", "godrays");
}
export function loadDepthAwareBlend() {
  return lazyLoad("depthAwareBlend", "depthAwareBlend");
}
export function loadDOF() {
  return lazyLoad("dof", "dof");
}
export function loadChromaticAberration() {
  return lazyLoad("chromaticAberration", "chromaticAberration");
}
export function loadFilm() {
  return lazyLoad("film", "film");
}
export function loadFXAA() {
  return lazyLoad("fxaa", "fxaa");
}
export function loadSMAA() {
  return lazyLoad("smaa", "smaa");
}
export function loadSoberOperator() {
  return lazyLoad("sobel", "sobel");
}
export function loadRGBShift() {
  return lazyLoad("rgbShift", "rgbShift");
}
export function loadSharpen() {
  return lazyLoad("sharpen", "sharpen");
}
export function loadAfterImage() {
  return lazyLoad("afterImage", "afterImage");
}
export function loadSepia() {
  return lazyLoad("sepia", "sepia");
}
export function loadBleach() {
  return lazyLoad("bleach", "bleach");
}
export function loadDotScreen() {
  return lazyLoad("dotScreen", "dotScreen");
}
export function loadLut3D() {
  return lazyLoad("lut3D", "lut3D");
}
export function loadGaussianBlur() {
  return lazyLoad("gaussianBlur", "gaussianBlur");
}
export function loadBilateralBlur() {
  return lazyLoad("bilateralBlur", "bilateralBlur");
}
export function loadMotionBlur() {
  return lazyLoad("motionBlur", "motionBlur");
}
export function loadFSR1() {
  return lazyLoad("fsr1", "fsr1");
}

// ---------------------------------------------------------------------------
// TSL node builders
// ---------------------------------------------------------------------------

/**
 * Build the TSL node for a graph node. `ins` is a Map of wired-up input
 * sockets. `ctx` is the per-compile context (camera + scene textures).
 *
 * Returns the node's primary output value (every node has at most one main
 * output today; multi-output would extend this to return a Map). Returns
 * null for the input pseudo-source — its outputs are resolved by the
 * compiler from `ctx` directly.
 */
function buildNode(type, props, ins, ctx) {
  // The Input pseudo-source and the Output sink are pure graph anchors:
  // their outputs are resolved directly by the compiler from `ctx` (input)
  // or from upstream wiring (output). No builder body to execute.
  if (type === "input" || type === "output") return null;

  const P = { ...nodeDefaults(type), ...props };
  // Shared reader for the structural `resolutionScale` select ("0.25"…"1"
  // strings from the panel dropdown). Nodes without the param get 1.
  const resolutionScale = Math.min(1, Math.max(0.1, parseFloat(P.resolutionScale) || 1));
  switch (type) {

    // --- GI / Reflections ---
    case "ssgi": {
      const beauty = ins.get("color") ?? TSL.vec4(0);
      const depth = ins.get("depth") ?? TSL.float(0);
      // Pass `null` (not a placeholder vec3) so the addon's
      // `sampleNormal()` falls back to its in-shader depth-reconstruction
      // path. Passing a non-null non-TextureNode throws
      // "this.normalNode.sample is not a function" in shader compilation.
      const normal = ins.get("normal") ?? null;
      // The addon is loaded lazily by the component and injected via
      // ctx.ssgi — the compiler itself never imports three's addon path.
      // When the addon failed to load (e.g. the user's three build doesn't
      // bundle it), `ctx.ssgi` is null and we fall back to a passthrough
      // so the rest of the graph still runs.
      const fn = ctx.ssgi;
      if (typeof fn !== "function") {
        console.warn("SSGI node: addon not loaded — emitting beauty passthrough");
        return beauty;
      }
      const ssgiNode = fn(beauty, depth, normal, ctx.camera);
      // Apply all exposed params to the addon. UniformNodes (radius,
      // expFactor, thickness, aoIntensity, giIntensity, backfaceLighting,
      // useLinearThickness, useScreenSpaceSampling, sliceCount, stepCount)
      // are mutated via `.value =` to match three's own example pattern
      // (`giPass.sliceCount.value = 2`). `useTemporalFiltering` is a
      // plain JS boolean (SSGINode.js:193) and is assigned directly —
      // setting its `.value` would create a new property and the addon
      // would never see the change.
      const applyHot = (Q) => {
        ssgiNode.sliceCount.value = Q.sliceCount;
        ssgiNode.stepCount.value = Q.stepCount;
        ssgiNode.radius.value = Q.radius;
        ssgiNode.expFactor.value = Q.expFactor;
        ssgiNode.thickness.value = Q.thickness;
        ssgiNode.aoIntensity.value = Q.aoIntensity;
        ssgiNode.giIntensity.value = Q.giIntensity;
        ssgiNode.backfaceLighting.value = Q.backfaceLighting;
        ssgiNode.useLinearThickness.value = Q.useLinearThickness;
        ssgiNode.useScreenSpaceSampling.value = Q.useScreenSpaceSampling;
        ssgiNode.useTemporalFiltering = Q.useTemporalFiltering;
      };
      applyHot(P);
      ctx.registerHot?.(applyHot);
      // SSGINode has no resolutionScale property (unlike SSRNode), but its
      // updateBefore path sizes the GI render target by calling
      // `this.setSize(drawingBufferWidth, drawingBufferHeight)` every
      // frame. Wrapping the instance's setSize scales the offscreen GI/AO
      // targets while the beauty pass stays full res — GI is low-frequency,
      // so half res reads nearly identically after the temporal filter but
      // costs a quarter of the (sliceCount × stepCount) fill. The wrapper
      // is per-instance and rebuilt on every compile, so no global state.
      if (resolutionScale < 1 && typeof ssgiNode.setSize === "function") {
        const baseSetSize = ssgiNode.setSize.bind(ssgiNode);
        ssgiNode.setSize = (w, h) =>
          baseSetSize(
            Math.max(1, Math.round(w * resolutionScale)),
            Math.max(1, Math.round(h * resolutionScale)),
          );
      }
      // SSGINode is a TempNode whose `setup()` runs the GI/AO shaders
      // against an offscreen render target (`_ssgiRenderTarget`) and
      // exposes its results as `getAONode()` (vec4 sampled from the AO
      // buffer, meaningful only on .r) and `getGINode()` (vec4 sampled
      // from the GI buffer, meaningful on .rgb). When the SSGI node is
      // referenced in the output chain (e.g. as `pipeline.outputNode`),
      // RenderPipeline runs the SSGI pass first; subsequent samples on
      // those nodes read the resulting textures.
      //
      // Three's canonical composite (`webgpu_postprocessing_ssgi.html`)
      // computes:
      //   result.rgb = beauty.rgb * ao + diffuse.rgb * gi.rgb
      //   result.a   = beauty.a
      // where `ao` is a vec4 (only .r is meaningful), `gi.rgb` is the
      // indirect light vector, and `diffuse` comes from a separate
      // diffuseColor MRT they wire through the scene pass.
      //
      // We don't have a diffuseColor MRT in the engine yet, so we
      // substitute `beauty.rgb` for both slots — that approximates
      // diffuse-by-surface-color with diffuse-by-rendered-color, which
      // is visually close enough for the editor and matches the
      // "lighting follows what's already on screen" intuition users
      // expect when there's no per-material diffuse buffer.
      //
      // Critical: SSGINode.js:440 reads `this.normalNode.sample(uv)`
      // inside the SSGI shader, so the SSGI node *must* be referenced
      // somewhere downstream — otherwise three's render-graph scheduler
      // can dead-code-eliminate the GI pass and `getAONode()` /
      // `getGINode()` would return black textures that turn the output
      // red. We anchor the temp node by reaching into its internal
      // `_ssgiRenderTarget` references below; tslRenderer's reference
      // checker should keep the pass alive.
      const aoNode = ssgiNode.getAONode?.();
      const giNode = ssgiNode.getGINode?.();
      if (!aoNode || !giNode) {
        console.warn("SSGI node: getAONode()/getGINode() missing — emitting beauty passthrough");
        return beauty;
      }
      // Anchor the SSGI temp node into the component-supplied keepalive
      // set so three's render-graph scheduler doesn't drop the offscreen
      // pass. The PassTextureNode wrappers we return (ao.r, gi.rgb) each
      // sample from the SSGI render target, so the natural reference
      // chain should keep the pass alive — but three's reference tracker
      // strips passes whose `.r` or `.rgb` accesses happen lazily (and
      // a swizzle-then-multiply chain can be folded into the output
      // shader without ever materializing the PassTextureNode as a
      // graph vertex). To be defensive, we always register the SSGI
      // node into `ctx.temps` (a `Set` provided by the component).
      // PostprocessComponent owns the set across rebuilds, so the
      // anchor survives every pipeline.outputNode swap. When the
      // SSGI node IS the natural graph vertex (no downstream swizzle
      // folding), this is a harmless double-reference.
      if (ctx.temps && typeof ctx.temps.add === "function") {
        ctx.temps.add(ssgiNode);
      } else if (ctx.temps && typeof ctx.temps.push === "function") {
        ctx.temps.push(ssgiNode);
      }
      // Return the multi-output map matched to the declared outputs:
      //   ao (float) <- AO texture .r (R8 format, alpha = 1)
      //   gi (vec3)  <- GI texture .rgb (HDR-formatted indirect light)
      // The user composes them downstream with mul/add nodes — e.g.
      //   beauty.rgb * ao + beauty.rgb * gi
      // which is exactly the three.js example composite shape, with
      // `beauty.rgb` standing in for the diffuseColor MRT we don't yet
      // plumb through the post-process pass. Returning typed scalars
      // here sidesteps the vec3-by-vec4 implicit broadcast that drove
      // the previous red-screen bug.
      return {
        ao: aoNode.r ?? TSL.float(1),
        gi: giNode.rgb ?? TSL.vec3(0),
      };
    }
    case "gtao": {
      const beauty = ins.get("color") ?? TSL.vec4(0);
      const depth = ins.get("depth") ?? TSL.float(0);
      // Null lets the addon reconstruct normals from depth in-shader — a
      // placeholder vec3 would throw in sampleNormal (the SSGI note above).
      const normal = ins.get("normal") ?? null;
      const fn = ctx.gtao;
      if (typeof fn !== "function") {
        console.warn("AO node: GTAO addon not loaded — emitting beauty passthrough");
        return { color: beauty, ao: TSL.float(1) };
      }
      const aoPass = fn(depth, normal, ctx.camera);
      // Plain JS property read in the addon's setSize (like SSRNode): the AO
      // target shrinks while the composite samples it back at full res.
      aoPass.resolutionScale = resolutionScale;
      const applyHot = (Q) => {
        aoPass.radius.value = Q.radius;
        aoPass.scale.value = Q.scale;
        aoPass.thickness.value = Q.thickness;
        aoPass.distanceExponent.value = Q.distanceExponent;
        aoPass.distanceFallOff.value = Q.distanceFallOff;
        aoPass.samples.value = Q.samples;
      };
      applyHot(P);
      ctx.registerHot?.(applyHot);
      // Same defensive anchor as SSGI: a swizzle-folded `.r` access can drop
      // the offscreen pass from three's reference walk.
      if (ctx.temps && typeof ctx.temps.add === "function") ctx.temps.add(aoPass);
      let aoTex = aoPass.getTextureNode?.();
      if (!aoTex) {
        console.warn("AO node: getTextureNode() missing — emitting beauty passthrough");
        return { color: beauty, ao: TSL.float(1) };
      }
      // ⚠ THE DENOISE STAGE IS DISABLED — the param is accepted and ignored.
      // GTAO's sample pattern rotates through 6 temporal frames, so the raw
      // texture shimmers mildly; the addon library's example denoises before
      // compositing and this builder tried twice to do the same:
      //   1. INLINE (`ctx.denoise(aoTex, depth, normal, camera)`): the chain
      //      lands inside the editor-overlay conditional and three hoists the
      //      addon's in-Loop textureSample out of the loop — WGSL that
      //      references the loop var outside it ("unresolved value 'i'").
      //   2. RTT-WRAPPED (`convertToTexture(...)`): the chain shares depth/
      //      normal nodes with the main composite, and compiling the same
      //      subgraph under a second NodeBuilder mis-resolves a shared node —
      //      the user's editor threw "cannot index into expression of type
      //      'mat4x4<f32>'" with `cameraProjectionMatrix` sitting where a
      //      TEXEL belongs (fragment_RTT, 2026-08-14).
      // The correct isolation is a REAL internal render-target pass with
      // fresh texture nodes (what GTAONode does for its own AO pass) — filed,
      // not improvised a third time. Raw half-res AO multiplied onto beauty
      // is correct and mildly noisy, which beats broken.
      if (P.denoise && typeof ctx.denoise === "function") {
        console.warn("AO node: denoise stage is temporarily disabled (see builder comment) — raw GTAO output in use");
      }
      const ao = aoTex.r;
      // Multiplying the FINISHED frame darkens direct light and specular too —
      // the standard post-AO approximation. The correct split needs a diffuse
      // MRT this pass doesn't plumb; the ssgi builder documents the same
      // substitution and the same reason.
      return {
        color: TSL.vec4(beauty.rgb.mul(ao), beauty.a),
        ao,
      };
    }
    case "ssr": {
      const beautyIn = ins.get("color") ?? TSL.vec4(0);
      const depth = ins.get("depth") ?? TSL.float(0);
      const normal = ins.get("normal") ?? null;
      const fn = ctx.ssr;
      if (typeof fn !== "function") {
        console.warn("SSR node: addon not loaded — emitting beauty passthrough");
        return beautyIn;
      }
      // SSR SAMPLES its color input at arbitrary hit UVs (`colorNode.sample`),
      // so it needs a texture-backed node. Straight from Input that is the
      // scene pass texture; downstream of an arithmetic node (gtao's
      // composite, a grade chain) it is a computed vec4 and `.sample` throws
      // at build. Wrap only when needed — the RTT pass this buys is exactly
      // the price of sampling a computed image, not a tax on the common case.
      const beauty = typeof beautyIn.sample === "function"
        ? beautyIn
        : TSL.convertToTexture(beautyIn);
      // ── STOCHASTIC IS REAL WHEN THE SCENE HAS AN HDRI ────────────────────
      // Mirror mode traces ONE ray and fakes roughness with a mip chain, so a
      // satin metal is not something it can represent — the user's gold
      // embroidery read as polished chrome against Blender's thread. The GGX
      // path is what represents it, and it needs an environment for two
      // different reasons: its miss branch samples one (no null guard — see
      // the option below), and a corridor's reflection rays mostly DO miss, so
      // without one the metal reflects black where the sky should be.
      // `ssrEnvironment` is the scene's own HDRI when it is the shape
      // `setEnvMap` accepts (PostprocessComponent.ssrEnvironmentOf).
      const stochastic = P.stochastic && !!ctx.ssrEnvironment;
      if (P.stochastic && !stochastic) {
        console.warn(
          "SSR node: Stochastic needs the scene environment to be an equirectangular .hdr/.exr " +
            "(Scene → Environment); a .cubemap has no CPU-side pixels for SSRNode.setEnvMap. " +
            "Falling back to mirror mode — stochastic without an env map throws during the " +
            "shader build. Lower Max Roughness instead to keep mirror mode off rough metals.",
        );
      }
      const ssrNode = fn(beauty, depth, normal, {
        // Without this the addon infers the camera from `colorNode.passNode`
        // and throws "No camera found" outright — which it does the moment
        // anything sits between the Input node and SSR, since only the raw
        // scene-pass texture carries a `passNode`.
        camera: ctx.camera,
        // ⚠ STOCHASTIC NEEDS AN ENVIRONMENT OR IT DOES NOT BUILD. The GGX path
        // defines its miss branch as `this._importanceEnvironment.sample…`
        // (SSRNode.js:954-987) with no null guard, and that field stays null
        // until `setEnvMap()` is handed an EQUIRECTANGULAR HDR WITH CPU-SIDE
        // `image.data` — a PMREM'd `scene.environment` is explicitly rejected
        // (SSRNode.js:708). So flipping this toggle on a normal scene throws
        // `Cannot read properties of null (reading 'sampleEnvironmentBRDF')`
        // during the TSL build and takes the whole post chain with it (seen
        // live 2026-08-15). Until the panel can hand SSR a raw .hdr, the
        // toggle degrades to mirror mode with the reason said out loud.
        stochastic: stochastic,
        reflectNonMetals: P.reflectNonMetals,
        // Compile-time constant in the addon (it re-bakes the fragment Fn),
        // so it travels as a construction option, not a uniform.
        binaryRefine: P.binaryRefine,
        // Per-pixel material params from the scene-pass MRT (null on builds
        // without the slot — the addon then treats surfaces as smooth
        // non-metal). With these wired, SSR reflects metals correctly and
        // picks its blur mip from roughness.
        metalnessNode: ctx.metalnessNode ?? null,
        roughnessNode: ctx.roughnessNode ?? null,
        // Only read on the stochastic path, where the addon calls setEnvMap
        // for it (SSRNode.js:478) and samples it on every miss. Passing it in
        // mirror mode would build the CDF tables for a branch that is baked
        // out, so it travels with `stochastic`.
        environmentNode: stochastic ? ctx.ssrEnvironment : null,
        // The GGX sampler's albedo → its f0, i.e. the metal's own colour: the
        // stochastic path tints the reflection itself rather than needing the
        // composite-side tint below. The matParams chroma is what we have (a
        // full diffuse MRT would be another attachment on a frame that is
        // already per-pixel bound), and for a metal, f0 IS that colour.
        diffuseNode: stochastic ? (ctx.metalTintNode ?? null) : null,
      });
      // SSRNode exposes resolutionScale as a plain JS property read in its
      // setSize (SSRNode.js:652) — the ray-march target shrinks while the
      // composite stays full res.
      ssrNode.resolutionScale = resolutionScale;
      // Ray reach and march tuning. These are all UniformNodes on the addon,
      // so they update in place without a pipeline rebuild — see registerHot.
      // `maxDistance` is the important one: the addon defaults it to ONE
      // WORLD UNIT and we never assigned it, so reflections died a metre out.
      // Our own uniform (not the addon's) — it weights the composite below.
      const maxRoughness = TSL.uniform(P.maxRoughness ?? 1);
      const applyHot = (Q) => {
        ssrNode.maxDistance.value = Q.maxDistance;
        ssrNode.thickness.value = Q.thickness;
        ssrNode.quality.value = Q.quality;
        ssrNode.screenEdgeFade.value = Q.screenEdgeFade;
        ssrNode.intensity.value = Q.intensity;
        ssrNode.maxLuminance.value = Q.maxLuminance;
        maxRoughness.value = Q.maxRoughness;
      };
      applyHot(P);
      ctx.registerHot?.(applyHot);
      // Hybrid composite (SSR on-screen + GI voxel-cone fallback):
      //  - The GI specular cone is already folded into `beauty` (in-material),
      //    so a metallic surface's beauty ≈ its reflection. That is the
      //    off-screen fallback, and everything SSR fails to find must land
      //    back on it.
      //  - The addon hands us a PREMULTIPLIED contribution: in mirror mode
      //    `reflection × metalness × (1 - d/maxDistance)² × fresnel × intensity`
      //    (SSRNode.js:1237-1245). So a hit near the range limit is a *black*
      //    sample, not an absent one.
      //  - That is what made reflections turn black instead of fading: the old
      //    composite mixed `beauty → ssr` on a binary `alpha > 0` hit mask, so
      //    those attenuated-to-zero samples pulled the surface to black over
      //    exactly the band where the fallback should have been taking over.
      //
      // Fix: ADD rather than mix — `ssr.rgb` already carries every factor in
      // `k`, so mixing applies them twice — and ramp `k` down over range so
      // that as the sample fades to zero the weight does too and `beauty`
      // comes back.
      //
      // ── PURE PREMULTIPLIED ADD — NO DISPLACEMENT TERM. (2026-08-14) ──────
      //
      // A previous revision displaced beauty by
      // `k = metalness × intensity × (1 − a/maxDistance)²` before adding the
      // sample, reasoning that the ramp keeps `k` low. That reasoning was
      // wrong ON THE OTHER FACTOR: the addon's returned rgb is ALSO
      // premultiplied by `fresnelCoe = (dot(I,R)+1)/2` (≈0 at normal
      // incidence), its perpendicular-distance attenuation and its luminance
      // clamp — none of which `k` modelled. Wherever those zeroed the sample
      // while the ramp kept `k` high (a near-field self-hit under
      // maxDistance 100 gives a≈0 ⇒ ramp≈1 ⇒ k→metalness), the composite
      // returned `beauty×(1−k) + ~0` — the black hole the old comment said
      // could not happen. On the user's saved Sponza graph this blacked the
      // ENTIRE fresh-boot frame to a ×0.001 ghost (see plan §12.66; the
      // frame-wide reach came from the matParams MRT resolving metalness ≈1
      // everywhere, but any honest metalness still blacks every metal).
      //
      // So: ADD, full stop — the module's own hard-won rule (a premultiplied
      // output must be ADDED, not mixed; the addon's factors already weight
      // the sample, and any second weight applied to BEAUTY displaces energy
      // the sample does not return). Cost, accepted and bounded: a strong
      // metal keeps its raster env/GI reflection UNDER the screen-space one
      // (slightly hot), which is the failure direction that degrades, not the
      // one that destroys. `intensity` rides inside the addon's premultiplied
      // rgb, so 0 still means "SSR off, beauty intact".
      //
      // ── RE-MASK AFTER THE BLUR: the halo around every metal (2026-08-14) ─
      //
      // The addon premultiplies by metalness at MARCH time, then runs its
      // roughness blur mips over the reflection buffer — and that blur is
      // NOT edge-aware, so reflection energy smears past the silhouette onto
      // pixels whose own metalness is 0. User-reported as "blurry edges
      // around all metals, even at full res, from the very beginning". Those
      // halo pixels are non-metal receivers by definition, so multiply the
      // BLURRED output by the receiving pixel's own metalness mask at
      // composite time: the halo dies, any real metal keeps its reflection
      // at full weight (smoothstep, not a bare ×m — the addon already
      // applied metalness once and a second linear factor would dim
      // mid-metal embroidery by m²). Skipped when reflectNonMetals is on —
      // there the dielectric neighbours legitimately receive SSR.
      //
      // Ramp is DELIBERATELY low (0.01→0.06): the first cut used 0.02→0.2
      // and the user's embroidery lost its reflections outright — woven
      // gold-thread metalness maps sit well below 0.2 (thread-vs-cloth
      // antialiasing pulls texels toward zero). The mask only needs to
      // separate "authored metal, however faint" from "true zero-metal
      // receiver catching the blur's spill" — so full weight from 0.06 up,
      // and only the near-zero halo band dies.
      let ssrRgb = ssrNode.rgb;
      if (ctx.metalnessNode && !P.reflectNonMetals) {
        ssrRgb = ssrRgb.mul(TSL.smoothstep(TSL.float(0.01), TSL.float(0.06), ctx.metalnessNode));
      }
      // …and fade the whole term out on rough receivers (see `maxRoughness` in
      // the catalog): past that roughness the addon's mip-blur mirror is a
      // block pattern, not a reflection. The fade rides the RECEIVING pixel's
      // roughness, the same channel the addon picks its blur mip from, so the
      // two agree about which surfaces are rough.
      // …and fade the whole term out on rough receivers (see `maxRoughness` in
      // the catalog): past that roughness the addon's mip-blur mirror is a
      // block pattern, not a reflection. The fade rides the RECEIVING pixel's
      // roughness, the same channel the addon picks its blur mip from, so the
      // two agree about which surfaces are rough.
      //
      // MIRROR MODE ONLY. The gate exists to hide an artifact of the mip-blur
      // approximation; the stochastic path represents rough metal properly
      // (that is what its GGX lobe IS), so gating it there would throw away
      // the exact surfaces the mode was turned on for.
      if (ctx.roughnessNode && !stochastic) {
        ssrRgb = ssrRgb.mul(
          TSL.smoothstep(maxRoughness, maxRoughness.add(0.15), ctx.roughnessNode).oneMinus(),
        );
      }
      // ── AND A METAL REFLECTS THROUGH ITS OWN COLOUR ─────────────────────
      // The addon's mirror path weights the sample by `vec3(metalness)` and
      // nothing else, so every metal reflects like chrome — the user's gold
      // embroidery came back white against Blender's gold. F0 for a metal IS
      // its base colour; the matParams MRT carries it as chroma in B/A
      // (PostprocessComponent). Dielectrics keep an uncoloured reflection,
      // which is also physically right, so the tint rides `metalness`.
      // ⚠ MIRROR MODE ONLY, for the same reason `diffuseNode` is passed only
      // in stochastic mode: there the GGX sampler already built f0 from that
      // colour, and tinting again would square it (gold going orange-brown).
      if (!stochastic && ctx.metalTintNode && ctx.metalnessNode) {
        ssrRgb = ssrRgb.mul(TSL.mix(TSL.vec3(1), ctx.metalTintNode, ctx.metalnessNode));
      }
      return TSL.vec4(beauty.rgb.add(ssrRgb), beauty.a);
    }
    case "denoise": {
      const beauty = ins.get("color") ?? TSL.vec4(0);
      const depth = ins.get("depth") ?? TSL.float(0);
      // Same null-normal convention as SSGI/SSR: when no normal texture
      // is wired, the addon reconstructs normals from depth in-shader.
      // Passing a non-null non-TextureNode throws
      // "this.normalNode.sample is not a function" at shader compile.
      const normal = ins.get("normal") ?? null;
      const fn = ctx.denoise;
      if (typeof fn !== "function") {
        console.warn("Denoise node: addon not loaded — emitting beauty passthrough");
        return beauty;
      }
      // DenoiseNode is a TempNode that internally allocates its own
      // render target (the noise-textured output). Its `setup()` returns
      // a vec4 sampler — i.e. it can be consumed directly in the graph
      // (unlike SSGINode which exposes AO+GI as a struct and needs the
      // .getGINode() accessor). That matches three's docs: "Returns the
      // result of the effect as a texture node".
      const denoiseNode = fn(beauty, depth, normal, ctx.camera);
      // The four user-controlled φ / radius params are UniformNode<float>
      // on the addon. Mutating `.value` (rather than replacing the
      // UniformNode) matches three's documented public API and keeps
      // the addon's internal references intact.
      const applyHot = (Q) => {
        denoiseNode.radius.value = Q.radius;
        denoiseNode.lumaPhi.value = Q.lumaPhi;
        denoiseNode.depthPhi.value = Q.depthPhi;
        denoiseNode.normalPhi.value = Q.normalPhi;
      };
      applyHot(P);
      ctx.registerHot?.(applyHot);
      // Returned INLINE, as it always was. An RTT wrap (`convertToTexture`)
      // was tried here on 2026-08-14 and REVERTED the same day: compiling the
      // chain's shared depth/normal subgraph under a second NodeBuilder
      // mis-resolves shared nodes (the gtao builder's comment carries the
      // exact WGSL failure). Inline it still risks the loop-hoist trap under
      // the editor-overlay conditional — the real fix for both is an internal
      // render-target pass with fresh texture nodes; filed.
      return denoiseNode;
    }
    case "traa": {
      const color = ins.get("color") ?? ctx.beautyNode ?? TSL.vec4(0);
      const depth = ins.get("depth") ?? ctx.depthNode ?? null;
      const velocityNode = ins.get("velocity") ?? ctx.velocityNode ?? null;
      const fn = ctx.traa;
      if (ctx.msaaEnabled) {
        console.warn("TRAA node: disable Scene Settings > Renderer > Antialiasing (MSAA) to enable temporal reprojection");
        return color;
      }
      if (typeof fn !== "function" || !depth || !velocityNode) {
        console.warn("TRAA node: addon, depth, or velocity unavailable — emitting color passthrough");
        return color;
      }
      return fn(color, depth, velocityNode, ctx.camera);
    }

    // --- Color grading ---
    case "brightness": {
      const color = ins.get("color") ?? TSL.vec4(0);
      return TSL.add(color, TSL.vec4(P.amount, P.amount, P.amount, 0));
    }
    case "contrast": {
      const color = ins.get("color") ?? TSL.vec4(0);
      const c = TSL.float(P.amount);
      const center = TSL.float(0.5);
      // s' = (s - 0.5) * c + 0.5
      const rgb = TSL.add(TSL.mul(TSL.sub(color.rgb, center), c), center);
      return TSL.vec4(rgb, color.a);
    }
    case "saturation": {
      const color = ins.get("color") ?? TSL.vec4(0);
      // `luminance()` returns a single float — three's TSL `luminance()` is
      // a `dot()` against Rec.709 weights. We then need a vec3 of that
      // float to mix against the colour rgb; WGSL `vec3()` with one float
      // arg is invalid, so we go through the explicit 3-arg constructor
      // (each arg = the same float node, which WGSL accepts).
      const luma = TSL.luminance(color.rgb);
      const gray = TSL.vec3(luma, luma, luma);
      return TSL.vec4(TSL.mix(gray, color.rgb, TSL.float(P.amount)), color.a);
    }
    case "colorBalance": {
      const color = ins.get("color") ?? TSL.vec4(0);
      return TSL.vec4(
        TSL.mul(color.rgb, TSL.vec3(P.red, P.green, P.blue)),
        color.a,
      );
    }
    case "levels": {
      const color = ins.get("color") ?? TSL.vec4(0);
      const black = TSL.float(P.black);
      const white = TSL.float(P.white);
      const invRange = TSL.float(1).div(TSL.max(TSL.sub(white, black), TSL.float(1e-5)));
      const normed = TSL.mul(TSL.sub(color.rgb, black), invRange);
      const gamma = TSL.float(1).div(TSL.max(TSL.float(P.gamma), TSL.float(1e-3)));
      const graded = TSL.pow(TSL.clamp(normed, TSL.float(0), TSL.float(1)), gamma);
      return TSL.vec4(graded, color.a);
    }
    case "tonemap": {
      const color = ins.get("color") ?? TSL.vec4(0);
      const exposure = TSL.mul(color.rgb, TSL.float(P.exposure));
      const mapped =
        P.mode === "aces"
          ? TSL.acesFilmicToneMapping(exposure)
          : P.mode === "reinhard"
            ? TSL.reinhardToneMapping(exposure)
            : P.mode === "cineon"
              ? TSL.cineonToneMapping(exposure)
              : P.mode === "agx"
                ? TSL.agxToneMapping(exposure)
                : P.mode === "neutral"
                  ? TSL.neutralToneMapping(exposure)
                  : P.mode === "linear"
                    ? TSL.linearToneMapping(exposure)
                    : exposure;
      return TSL.vec4(mapped, color.a);
    }

    // --- Effects ---
    case "vignette": {
      const color = ins.get("color") ?? TSL.vec4(0);
      // Radial falloff centred on the screen. We hand-roll the mask in
      // TSL primitives that all have well-defined WGSL signatures —
      // specifically, every `vec*()` constructor here takes the supported
      // (vec, scalar) or (scalar, scalar, scalar, scalar) shape so the
      // generated WGSL never exceeds `vec4()`'s 4-arg maximum.
      //
      // mask = 1 - smoothstep(inner, outer, length(uv - 0.5)) * intensity
      // final.rgb = mix(color.rgb * (1 - mask), color.rgb, ...)... too
      // convoluted. The simpler model: produce a scalar multiplier `vig`
      // and scale the colour by it.
      //
      //   vec2 - vec2 = vec2 (TSL.sub)
      //   length(vec2) = float (TSL.length)
      //   smoothstep(float, float, float) = float
      //   float * float = float
      //   float - float = float  → vig (float)
      //   vec3 * float = vec3     → dimmed (vec3)
      //   vec4(vec3, float)       → final (vec4) — 2-arg constructor, OK.
      const uvCentered = TSL.sub(TSL.uv(), TSL.vec2(0.5));
      const dist = TSL.length(uvCentered);
      const inner = TSL.float(0.4);
      const outer = TSL.float(1.0);
      // smoothness widens the falloff from inner toward outer — we keep
      // the math linear and explicit, no chained .add().mul() so TSL
      // doesn't accidentally pack anything into a wider vec* constructor.
      const width = TSL.float(P.smoothness);
      const outer2 = TSL.add(inner, TSL.mul(width, TSL.sub(outer, inner)));
      const falloff = TSL.smoothstep(inner, outer2, dist);
      const intensity = TSL.float(P.intensity);
      const one = TSL.float(1);
      const vig = TSL.sub(one, TSL.mul(falloff, intensity));
      const dimmed = TSL.mul(color.rgb, vig);
      return TSL.vec4(dimmed, color.a);
    }
    case "grain": {
      const color = ins.get("color") ?? TSL.vec4(0);
      // Hash-based per-pixel noise quantized to a 60Hz time bucket so the
      // grain looks like film rather than a static dither pattern.
      const n = TSL.hash(TSL.vec3(TSL.uv().mul(TSL.vec2(1024, 1024)), TSL.floor(TSL.time().mul(60))));
      const grain = TSL.sub(n, TSL.float(0.5)).mul(TSL.float(2)).mul(TSL.float(P.amount));
      return TSL.vec4(TSL.add(color.rgb, grain), color.a);
    }
    case "pixelate": {
      const color = ins.get("color") ?? TSL.vec4(0);
      const size = TSL.float(P.size);
      const uv = TSL.uv();
      // Quantize UVs to a grid of `size` pixels (relative to screen coords),
      // then sample the source beauty at the cell center via texture().
      const grid = TSL.vec2(TSL.screenSize.x, TSL.screenSize.y).div(size);
      const cellUv = TSL.vec2(
        TSL.uv().x.mul(grid.x).floor().add(0.5).div(grid.x),
        TSL.uv().y.mul(grid.y).floor().add(0.5).div(grid.y),
      );
      return TSL.texture(ctx.beautyNode, cellUv);
    }

    // --- Blends ---
    case "mix": {
      const a = ins.get("a") ?? TSL.vec4(0);
      const b = ins.get("b") ?? TSL.vec4(0);
      const tIn = ins.get("t");
      const t = tIn ?? TSL.float(P.t);
      return TSL.mix(a, b, t);
    }
    case "add": {
      const a = ins.get("a") ?? TSL.vec4(0);
      const b = ins.get("b") ?? TSL.vec4(0);
      return TSL.add(a, b);
    }
    case "multiply": {
      const a = ins.get("a") ?? TSL.vec4(0);
      const b = ins.get("b") ?? TSL.vec4(0);
      return TSL.mul(a, b);
    }
    case "screen": {
      const a = ins.get("a") ?? TSL.vec4(0);
      const b = ins.get("b") ?? TSL.vec4(0);
      return TSL.sub(TSL.vec4(1), TSL.mul(TSL.sub(TSL.vec4(1), a), TSL.sub(TSL.vec4(1), b)));
    }
    // `vec3 × float` — used by the SSGI composite (`beauty.rgb * ao`).
    // We expose this as a dedicated node so the type signature stays
    // explicit (the result is unambiguously a vec3, not a vec3-shaped
    // truthy out of an opaque mul). Each input defaults to TSL.vec3(0)
    // if unwired so a partially-built graph still compiles — the
    // result is just (0) in that case and the downstream node can
    // short-circuit visually.
    case "vec3MulF": {
      const a = ins.get("a") ?? TSL.vec3(0);
      const b = ins.get("b") ?? TSL.float(1);
      return TSL.mul(a, b);
    }
    case "vec3MulV": {
      const a = ins.get("a") ?? TSL.vec3(0);
      const b = ins.get("b") ?? TSL.vec3(0);
      return TSL.mul(a, b);
    }
    case "vec3Add": {
      const a = ins.get("a") ?? TSL.vec3(0);
      const b = ins.get("b") ?? TSL.vec3(0);
      return TSL.add(a, b);
    }
    case "swizzleRGB": {
      const color = ins.get("color") ?? TSL.vec4(0);
      return color.rgb ?? TSL.vec3(0);
    }
    case "packRGB": {
      const rgb = ins.get("rgb") ?? TSL.vec3(0);
      const alpha = ins.get("a") ?? TSL.float(1);
      return TSL.vec4(rgb, alpha);
    }

    // --- Masking ---
    case "depthMask": {
      const color = ins.get("color") ?? TSL.vec4(0);
      const depth = ins.get("depth") ?? TSL.float(0);
      const mask = TSL.step(TSL.float(P.near), depth).mul(TSL.step(depth, TSL.float(P.far)));
      return TSL.vec4(TSL.mul(color.rgb, mask), color.a);
    }

    // =====================================================================
    // Post-fx addons. Each block:
    //   1. resolves the lazily-loaded factory from `ctx.<name>`
    //   2. emits a passthrough (returns `beauty`) if the addon failed
    //      to load — defensive against stripped three builds
    //   3. invokes the addon with wired inputs + applied params
    //   4. assigns UniformNode `.value` for each param
    //   5. returns the addon's output node (vec4 for all of these)
    //
    // We capture the addon-produced TempNode / effect node into the
    // component's keepalive Set (via `ctx.temps`) wherever the addon
    // requires an offscreen render target (bloom, godrays, depthOfField,
    // afterImage, motionBlur, recurrent denoiser, etc.). Without this
    // three's render-graph reference tracker would strip the temp pass
    // when only a downstream `.r` or swizzle happens to read it.
    // =====================================================================
    case "bloom": {
      const color = ins.get("color") ?? TSL.vec4(0);
      const fn = ctx.bloom;
      if (typeof fn !== "function") return color;
      // Pass numbers so BloomNode creates UniformNodes; passing TSL.float()
      // would bake the values into ConstNodes and make the controls inert.
      const node = fn(color, P.strength, P.radius, P.threshold);
      const applyHot = (Q) => {
        if (node.strength?.value !== undefined) node.strength.value = Q.strength;
        if (node.radius?.value !== undefined) node.radius.value = Q.radius;
        if (node.threshold?.value !== undefined) node.threshold.value = Q.threshold;
      };
      applyHot(P);
      ctx.registerHot?.(applyHot);
      node.setResolutionScale?.(resolutionScale);
      // BloomNode returns only the blurred contribution. Composite it over
      // the original color so the scene remains sharp outside the glow.
      if (ctx.temps?.add) ctx.temps.add(node);
      return TSL.add(color, node);
    }
    case "godrays": {
      const color = ins.get("color") ?? TSL.vec4(0);
      const depth = ins.get("depth");
      const fn = ctx.godrays;
      const light = ctx.godraysLight;
      if (typeof fn !== "function" || !depth || !light) return color;
      // GodraysNode exposes `density` as a `.value` uniform. Its light
      // source is resolved from the scene's enabled shadow-casting lights.
      const node = fn(depth, ctx.camera, light);
      const applyHot = (Q) => {
        if (node.density?.value !== undefined) node.density.value = Q.density;
      };
      applyHot(P);
      ctx.registerHot?.(applyHot);
      // Plain JS property, read by GodraysNode.setSize (GodraysNode.js:258).
      node.resolutionScale = resolutionScale;
      if (ctx.temps?.add) ctx.temps.add(node);
      if (typeof ctx.depthAwareBlend === "function" && typeof color.sample === "function") {
        return ctx.depthAwareBlend(color, node, depth, ctx.camera);
      }
      return TSL.vec4(TSL.add(color.rgb, node.rgb), color.a);
    }
    case "depthOfField": {
      const color = ins.get("color") ?? TSL.vec4(0);
      const depth = ins.get("depth") ?? TSL.float(0);
      const fn = ctx.dof;
      if (typeof fn !== "function") return color;
      // DepthOfFieldNode takes TSL nodes for focusDistance/focalLength/
      // bokehScale (no `.value` uniforms). Pass-through per compile.
      const node = fn(color, depth, P.focusDistance, P.focalLength, P.bokehScale);
      if (ctx.temps?.add) ctx.temps.add(node);
      return node;
    }
    case "chromaticAberration": {
      const color = ins.get("color") ?? TSL.vec4(0);
      const fn = ctx.chromaticAberration;
      if (typeof fn !== "function") return color;
      // ChromaticAberrationNode stores strength/center/scale as TSL
      // nodes (no `.value` uniforms). Pass-through per compile.
      return fn(color, P.strength, null, P.scale);
    }
    case "film": {
      const color = ins.get("color") ?? TSL.vec4(0);
      const fn = ctx.film;
      if (typeof fn !== "function") return color;
      // FilmNode takes `(input, intensityNode)`. The factory wraps a
      // ProxyNode, but the per-instance parameter is an `intensityNode`
      // TSL node, not a `.value` uniform. We pass the user's slider
      // value as a literal; the next compile picks up changes.
      const node = fn(color);
      if (node.intensityNode !== undefined) node.intensityNode = TSL.float(P.intensity);
      return node;
    }
    case "fxaa": {
      const color = ins.get("color") ?? TSL.vec4(0);
      const fn = ctx.fxaa;
      if (typeof fn !== "function") return color;
      return fn(color);
    }
    case "smaa": {
      const color = ins.get("color") ?? TSL.vec4(0);
      const fn = ctx.smaa;
      if (typeof fn !== "function") return color;
      return fn(color);
    }
    case "sobel": {
      const color = ins.get("color") ?? TSL.vec4(0);
      const fn = ctx.sobel;
      if (typeof fn !== "function") return color;
      return fn(color);
    }
    case "rgbShift": {
      const color = ins.get("color") ?? TSL.vec4(0);
      const fn = ctx.rgbShift;
      if (typeof fn !== "function") return color;
      // RGBShiftNode stores amount/angle as `.value` uniforms. Update
      // in place, then return the node (no offscreen pass; can fold
      // into the output shader).
      const node = fn(color, P.amount, P.angle);
      const applyHot = (Q) => {
        if (node.amount?.value !== undefined) node.amount.value = Q.amount;
        if (node.angle?.value !== undefined) node.angle.value = Q.angle;
      };
      applyHot(P);
      ctx.registerHot?.(applyHot);
      return node;
    }
    case "sharpen": {
      const color = ins.get("color") ?? TSL.vec4(0);
      const fn = ctx.sharpen;
      if (typeof fn !== "function") return color;
      // SharpenNode wraps the literals via `nodeObject(...)` (no
      // `.value` uniform). The values flow into the freshly-built
      // shader on each compile, so a static numeric pass-through is
      // correct — the next compile picks up the new P.sharpness /
      // P.denoise into the rebuilt TSL graph.
      return fn(color, P.sharpness, P.denoise);
    }
    case "afterImage": {
      const color = ins.get("color") ?? TSL.vec4(0);
      const fn = ctx.afterImage;
      if (typeof fn !== "function") return color;
      // AfterImageNode stores `damp` as a plain TSL Node on the
      // instance (no `.value` uniform). The factory wraps the damp
      // argument via `nodeObject(damp)`, which converts a literal
      // number into an FloatNode. So updating damp means rebuilding
      // the node — already what happens on every compile.
      const node = fn(color, P.damp);
      if (ctx.temps?.add) ctx.temps.add(node);
      return node;
    }
    case "sepia": {
      const color = ins.get("color") ?? TSL.vec4(0);
      const fn = ctx.sepia;
      if (typeof fn !== "function") return color;
      return fn(color.rgb, TSL.float(P.opacity));
    }
    case "bleach": {
      const color = ins.get("color") ?? TSL.vec4(0);
      const fn = ctx.bleach;
      if (typeof fn !== "function") return color;
      return fn(color.rgb, TSL.float(P.opacity));
    }
    case "dotScreen": {
      const color = ins.get("color") ?? TSL.vec4(0);
      const fn = ctx.dotScreen;
      if (typeof fn !== "function") return color;
      // DotScreenNode stores angle/scale as `.value` uniforms.
      const node = fn(color, P.angle, P.scale);
      const applyHot = (Q) => {
        if (node.angle?.value !== undefined) node.angle.value = Q.angle;
        if (node.scale?.value !== undefined) node.scale.value = Q.scale;
      };
      applyHot(P);
      ctx.registerHot?.(applyHot);
      return node;
    }
    case "lut3D": {
      const color = ins.get("color") ?? TSL.vec4(0);
      const fn = ctx.lut3D;
      const lut = ctx.lut3DTexture;
      if (typeof fn !== "function" || !lut) {
        // Either the addon wasn't bundled or the user hasn't wired a
        // LUT texture into `ctx.lut3DTexture` (PostprocessComponent
        // currently doesn't expose an asset picker for that — future
        // affordance). Either way, fall back to a passthrough rather
        // than producing a broken sample at uv(0,0).
        return color;
      }
      const intensity = TSL.float(P.intensity);
      return fn(color, lut, 16, intensity);
    }
    case "gaussianBlur": {
      const color = ins.get("color") ?? TSL.vec4(0);
      const fn = ctx.gaussianBlur;
      if (typeof fn !== "function") return color;
      // GaussianBlurNode stores `sigma` as a raw node; not a `.value`
      // uniform. Pass-through per compile.
      const dir = TSL.vec2(1, 0);
      return fn(color, dir, P.sigma);
    }
    case "bilateralBlur": {
      const color = ins.get("color") ?? TSL.vec4(0);
      const depth = ins.get("depth") ?? TSL.float(0);
      const fn = ctx.bilateralBlur;
      if (typeof fn !== "function") return color;
      // BilateralBlurNode stores `sigma`/`sigmaColor` as raw nodes.
      const dir = TSL.vec2(1, 0);
      return fn(color, dir, P.sigma, P.sigmaColor);
    }
    case "motionBlur": {
      const color = ins.get("color") ?? TSL.vec4(0);
      const fn = ctx.motionBlur;
      // Return passthrough if the renderer could not expose the velocity MRT.
      if (typeof fn !== "function" || !ctx.velocityNode) return color;
      return fn(color, ctx.velocityNode, TSL.int(P.samples));
    }
    case "fsr1": {
      const color = ins.get("color") ?? TSL.vec4(0);
      const fn = ctx.fsr1;
      if (typeof fn !== "function") return color;
      // FSR1Node uses `nodeObject(...)` for sharpness/denoise (no
      // .value uniforms). Pass-through per compile.
      const node = fn(color, P.sharpness, P.denoise);
      if (ctx.temps?.add) ctx.temps.add(node);
      return node;
    }

    default:
      console.warn(`Post-process node type "${type}" is not implemented`);
      return TSL.vec4(0, 0, 0, 1);
  }
}

// ---------------------------------------------------------------------------
// Compiler
// ---------------------------------------------------------------------------

/**
 * Compile a post-process graph into a single TSL `vec4` output.
 *
 * @param {Object} graph  { nodes, edges }
 * @param {Object} ctx     { camera, beautyNode, depthNode, normalNode }
 *
 * Throws when no Output node is present.
 */
export function compilePostGraph(graph, ctx) {
  const nodes = graph?.nodes ?? [];
  const outNode = nodes.find((n) => n.type === "output");
  if (!outNode) throw new Error("Post-process graph needs an Output node");

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const edges = graph?.edges ?? [];

  // Build a per-target list of incoming edges: Map<nodeId, Map<handleKey, sourceRef>>.
  const incoming = new Map();
  for (const e of edges) {
    if (!nodeById.has(e.target) || !nodeById.has(e.source)) continue;
    let m = incoming.get(e.target);
    if (!m) incoming.set(e.target, (m = new Map()));
    m.set(e.targetHandle, { id: e.source, handle: e.sourceHandle });
  }

  // Walk upstream from the Output node, building each node once. A shared
  // subtree compiles once even when several paths converge on it.
  const built = new Map(); // nodeId -> Map<outputKey, tslNode>
  const visiting = new Set();

  // Hot params (`kind: "hot"`) are meant to be UniformNodes on the addon
  // instance a builder creates, so that a slider drag can push a new value
  // into the live shader instead of rebuilding the pipeline and every
  // offscreen render target behind it. A builder opts in by handing us an
  // applier; `updateParams` replays the edited graph's props through them.
  // Builders that bake their numbers into constant TSL (the arithmetic and
  // tonemap families, DoF, sharpen…) don't register, and keep needing the
  // signature rebuild they already get.
  const hotAppliers = new Map(); // nodeId -> (props) => void
  let buildingNodeId = null;
  const buildCtx = {
    ...ctx,
    registerHot(apply) {
      if (buildingNodeId != null) hotAppliers.set(buildingNodeId, apply);
    },
  };
  const updateParams = (nextGraph) => {
    for (const n of nextGraph?.nodes ?? []) {
      const apply = hotAppliers.get(n.id);
      if (apply) apply({ ...nodeDefaults(n.type), ...n.props });
    }
  };

  function inputValue(nodeId, handleKey) {
    const edge = incoming.get(nodeId)?.get(handleKey);
    if (!edge) return null;
    return resolveOutput(edge.id, edge.handle);
  }

  function resolveOutput(nodeId, outputKey) {
    if (built.has(nodeId)) return built.get(nodeId).get(outputKey) ?? null;
    if (visiting.has(nodeId)) {
      console.warn(`Post-process graph has a cycle at "${nodeId}"`);
      return null;
    }
    visiting.add(nodeId);
    const node = nodeById.get(nodeId);
    const ins = new Map();
    for (const spec of PP_NODE_TYPES[node.type]?.inputs ?? []) {
      const v = inputValue(nodeId, spec.key);
      if (v != null) ins.set(spec.key, v);
    }
    // `ins` are fully resolved above, so no builder runs re-entrantly here —
    // the id is unambiguous for the duration of this one buildNode call.
    buildingNodeId = nodeId;
    const result = buildNode(node.type, node.props, ins, buildCtx);
    buildingNodeId = null;
    visiting.delete(nodeId);

    let outMap;
    if (node.type === "input") {
      // IMPORTANT: when `ctx.normalNode` is null (the typical case — three.js
      // r185 doesn't expose a viewport normal MRT), the `normal` output of
      // the Input node MUST also resolve to `null` so the downstream SSGI /
      // SSR nodes fall through to their in-shader depth-reconstruction
      // path. Substituting a placeholder `vec3` here would propagate through
      // the graph and crash SSGI's `sampleNormal()` at shader-compile time
      // with "this.normalNode.sample is not a function".
      const out = new Map();
      if (ctx.beautyNode) out.set("color", ctx.beautyNode);
      if (ctx.depthNode) out.set("depth", ctx.depthNode);
      if (ctx.normalNode) out.set("normal", ctx.normalNode);
      if (ctx.velocityNode) out.set("velocity", ctx.velocityNode);
      outMap = out;
    } else if (node.type === "output") {
      // The Output node is a pass-through: whatever's wired into its
      // `color` input IS the result. The compiler queries this from
      // `resolveOutput(outNode.id, "color")` in `compilePostGraph`.
      outMap = new Map([["color", ins.get("color") ?? ctx.beautyNode ?? TSL.vec4(0, 0, 0, 1)]]);
    } else {
      // `result` may be:
      //   (a) a single TSL node — the historical contract. We spread it
      //       into every declared output socket (all sockets return the
      //       same node), which is correct for any node that has only
      //       one meaningful output (most post-fx nodes).
      //   (b) a `{ outputKey: tslNode, ... }` map — the contract for
      //       nodes with multiple distinct outputs (e.g. SSGI exposes
      //       separate `ao` and `gi` sockets backed by separate
      //       PassTextureNodes from the addon's offscreen render
      //       target). The key set must match the declared outputs in
      //       `PP_NODE_TYPES[type].outputs`, and the value type for
      //       each key must match the declared `kind`.
      //
      // We accept null in the map for declared sockets (skips the
      // socket) and ignore unknown keys. Object-shape detection is a
      // duck-typed check — `result?.ao !== undefined` is enough to
      // distinguish (b) from (a) without a formal type registry.
      const declaredOutputs = PP_NODE_TYPES[node.type]?.outputs ?? [];
      outMap = new Map();
      if (result && typeof result === "object" && !Array.isArray(result) && declaredOutputs.some((o) => Object.prototype.hasOwnProperty.call(result, o.key))) {
        // Multi-output node. Fill declared outputs from the map; if a
        // socket wasn't returned, fall back to ctx.beautyNode (so the
        // graph never resolves to `null` and breaks downstream math).
        for (const o of declaredOutputs) {
          const v = result[o.key];
          outMap.set(o.key, v == null ? ctx.beautyNode ?? null : v);
        }
        // Capture any extra keys the builder emitted for forward-compat
        // (e.g. a future add-on outputs both `ao` and `gi` and a
        // debugging `raw`). Only declared outputs are queryable via
        // resolveOutput, but we keep the extras in the closure so we
        // don't lose state.
        for (const k of Object.keys(result)) {
          if (!outMap.has(k)) outMap.set(k, result[k]);
        }
      } else {
        // Single-output node: spread the primary node across all
        // declared sockets.
        for (const o of declaredOutputs) outMap.set(o.key, result ?? ctx.beautyNode ?? null);
      }
    }
    built.set(nodeId, outMap);
    return outMap.get(outputKey) ?? null;
  }

  const result = resolveOutput(outNode.id, "color");
  if (result == null) {
    return {
      output: ctx.beautyNode ?? TSL.vec4(0, 0, 0, 1),
      signature: "__passthrough__",
      updateParams,
    };
  }
  return {
    output: result,
    signature: postGraphSignature(graph),
    updateParams,
  };
}

/**
 * Which auxiliary scene-pass MRT attachments a graph actually consumes.
 * Every extra attachment is written by EVERY material's fragment shader,
 * and `velocity` additionally forces per-object previous-frame matrix
 * tracking — an Input→Output passthrough carrying the full 4-target MRT
 * measured ~2× total frame time vs the plain canvas render. Only nodes
 * REACHABLE from the Output node count (orphans never compile).
 */
export function postGraphSceneNeeds(graph) {
  const nodes = graph?.nodes ?? [];
  const edges = graph?.edges ?? [];
  const needs = { normal: false, velocity: false, matParams: false };
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const out = nodes.find((n) => n.type === "output");
  if (!out) return needs;
  const incoming = new Map();
  for (const e of edges) {
    if (!incoming.has(e.target)) incoming.set(e.target, []);
    incoming.get(e.target).push(e);
  }
  const seen = new Set([out.id]);
  const stack = [out.id];
  while (stack.length) {
    const node = nodeById.get(stack.pop());
    if (!node) continue;
    if (node.type === "ssgi" || node.type === "denoise") needs.normal = true;
    if (node.type === "ssr") {
      needs.normal = true;
      needs.matParams = true;
    }
    if (node.type === "traa" || node.type === "motionBlur") needs.velocity = true;
    for (const e of incoming.get(node.id) ?? []) {
      // Manual wires off the Input node's aux sockets count too.
      if (nodeById.get(e.source)?.type === "input") {
        if (e.sourceHandle === "normal") needs.normal = true;
        if (e.sourceHandle === "velocity") needs.velocity = true;
      }
      if (!seen.has(e.source)) {
        seen.add(e.source);
        stack.push(e.source);
      }
    }
  }
  return needs;
}

/**
 * Structure-only fingerprint: two graphs with equal signatures are guaranteed
 * to compile to identical TSL/pipelines. Used by the editor to surface a
 * "live-update" affordance when only numeric params changed.
 */
export function postGraphSignature(graph) {
  const nodes = (graph?.nodes ?? []).map((n) => ({
    id: n.id,
    type: n.type,
    p: (PP_NODE_TYPES[n.type]?.params ?? [])
      .filter((p) => p.kind !== "hot")
      .map((p) => `${p.key}=${stringify(n.props?.[p.key] ?? p.default)}`)
      .join("|"),
  }));
  const edges = (graph?.edges ?? []).map((e) => `${e.source}.${e.sourceHandle}->${e.target}.${e.targetHandle}`).sort();
  return JSON.stringify({ nodes, edges });
}

function stringify(v) {
  if (v == null) return "null";
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "string") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
