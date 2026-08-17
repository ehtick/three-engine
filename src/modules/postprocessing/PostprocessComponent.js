import * as THREE from "three/webgpu";
import * as TSL from "three/tsl";
import { Component } from "../../engine/components/Component.js";
import { ensureGodraysShadowMap, disposeGodraysShadowMap } from "./godraysShadow.js";
import { EDITOR_LAYER, PP_OVERLAY_SEED_LAYER } from "../../engine/editorLayers.js";
import { resolveAssetUrl } from "../../engine/assetResolver.js";
import { DEFAULT_POST_GRAPH, normalizePostAsset, normalizePostGraph } from "./postAsset.js";
import {
  compilePostGraph,
  postGraphSceneNeeds,
  postGraphSignature,
  loadAddonsForGraph,
} from "./postGraph.js";

/**
 * The value a material ACTUALLY SHADES WITH for `metalness` / `roughness`,
 * resolved per material at shader-build time.
 *
 * `TSL.metalness` / `TSL.roughness` are `materialReference(...)` accessors:
 * they read the JS SCALARS `material.metalness` / `material.roughness`. But
 * `MeshStandardNodeMaterial.setupVariants` prefers the NODES whenever they are
 * set — `this.metalnessNode ? float(this.metalnessNode) : materialMetalness` —
 * and the editor's shader-graph compiler sets them on every material it
 * builds, leaving the asset's scalars at whatever they happened to be. So the
 * scalars describe a DIFFERENT material than the one on screen, and writing
 * them into the matParams MRT hands SSR that different material.
 *
 * Not hypothetical, and not subtle in its effect: the mirror cube in the
 * user's Sponza is graph metalness 1 / roughness 0 over asset scalars 0 / 0.7,
 * so it arrived at SSR as a rough dielectric and the addon's `metalness <= 0`
 * discard threw away every one of its pixels (SSRNode.js:911). A perfect
 * mirror rendered PURE BLACK — at every distance, and at every `maxDistance`,
 * which is what makes it read as "SSR has a range limit" rather than "SSR was
 * told this mirror is plaster". GI hit the same disagreement on the same
 * material and resolved it the same way (`giLight.js:1429`).
 *
 * An `Fn` body receives the NodeBuilder, and a shader node's properties are
 * cached per builder, so this re-runs for each material's fragment shader.
 * Materials with no node (anything glTF-loaded) fall through to the scalar,
 * which for them is the value they shade with.
 */
function shadedMaterialParam(nodeKey, scalarAccessor) {
  // ── BISECT HATCH (§12.66): `__ppScalarParams = true` forces the plain
  // scalar accessor, skipping the per-material Fn resolution entirely. Exists
  // because the black-boot forensics ranked "one shared Fn call node collapses
  // to a single material's value under node caching" as the mechanism that
  // turned the SSR composite bug from black-metals into a black FRAME — a
  // boot with this hatch on arbitrates that without an engine rebuild.
  if (globalThis.__ppScalarParams === true) return scalarAccessor.clamp(0, 1);
  return TSL.Fn((builder) => resolveShadedParam(builder.material, nodeKey, scalarAccessor))();
}

/**
 * The precedence rule itself, split out so it is testable without a GPU: node
 * if the material has one, scalar accessor otherwise. Exported for
 * `tests/post-ssr.test.mjs`.
 */
export function resolveShadedParam(material, nodeKey, scalarAccessor) {
  const node = material?.[nodeKey];
  // The MRT attachment is 8-bit UNORM, so out-of-range authored values would
  // wrap rather than saturate.
  return (node != null ? TSL.float(node) : scalarAccessor).clamp(0, 1);
}

/**
 * The scene's environment, IF it is the shape SSRNode's stochastic path can
 * sample: an equirectangular panorama with CPU-side pixels.
 *
 * `SSRNode.setEnvMap` builds importance-sampling CDF tables on the CPU from
 * `image.data`, and says so in its own warning — "PMREM cubemaps and
 * `scene.environment` are not supported". Ours usually IS supported, because
 * `environmentAsset.js` assigns the raw HDRLoader/EXRLoader DataTexture to
 * `scene.environment` and lets three PMREM it internally at render time. A
 * `.cubemap` (six face images) is genuinely the unsupported shape, and returns
 * null here so the SSR node degrades to mirror mode with its warning instead
 * of throwing during the shader build.
 */
function ssrEnvironmentOf(scene) {
  const env = scene?.environment;
  if (!env?.isTexture || env.isCubeTexture) return null;
  if (env.mapping !== THREE.EquirectangularReflectionMapping) return null;
  return ArrayBuffer.isView(env.image?.data) ? env : null;
}

/**
 * The BASE colour a material shades with — same precedence rule as
 * `shadedMaterialParam`, in three channels, for the metal F0 tint written into
 * the matParams MRT. `colorNode` may be a vec3 or a vec4 (a texture straight
 * off a graph output), so it is narrowed to rgb.
 */
function shadedMaterialColor() {
  if (globalThis.__ppScalarParams === true) return TSL.vec3(TSL.materialColor);
  return TSL.Fn((builder) => {
    const node = builder.material?.colorNode;
    return TSL.vec3(node != null ? TSL.vec4(node).rgb : TSL.materialColor).clamp(0, 1);
  })();
}

/**
 * The light god rays raymarch against.
 *
 * ⚠ GOD RAYS ARE A SHADOW-MAP EFFECT, and that is not a preference — three's
 * `GodraysNode` samples `light.shadow.map.depthTexture` at every step of its
 * view-ray march (its own docs: "requires a full shadow setup … the main light
 * must cast shadows"). A light using GI-traced shadows keeps `castShadow` true
 * — three only compiles a shadow branch for shadow-casters, and the GI module's
 * custom `shadowNode` replaces the map LOOKUP inside it — but three then skips
 * rendering the map entirely, so `shadow.map` stays null and building the node
 * against it throws `Cannot read properties of null (reading 'depthTexture')`.
 *
 * So gi-mode lights are skipped here rather than crashing the graph. If that
 * leaves no candidate the effect no-ops, which is the honest outcome: there is
 * no occlusion volume for it to march. Restoring god rays on a gi-shadow scene
 * means keeping one real (small) map alive purely to feed the march — see plan
 * §12.78 — not relaxing this guard.
 */
/** The gi-mode light god rays WOULD use if it had a map to march. */
function findGiShadowLight(engine) {
  for (const entity of engine?.entities?.values?.() ?? []) {
    const light = entity.getComponent?.("light")?.light;
    if (
      light &&
      (light.isDirectionalLight || light.isPointLight) &&
      light.shadow &&
      light.castShadow &&
      light.visible !== false &&
      light.userData?.giShadowMode === "gi"
    ) {
      return light;
    }
  }
  return null;
}

function findGodraysLight(engine) {
  let skippedGi = null;
  for (const entity of engine?.entities?.values?.() ?? []) {
    const light = entity.getComponent?.("light")?.light;
    if (
      light &&
      (light.isDirectionalLight || light.isPointLight) &&
      light.shadow &&
      light.castShadow &&
      light.visible !== false
    ) {
      if (light.userData?.giShadowMode === "gi" || !light.shadow.map?.depthTexture) {
        // `shadow.map` is also null for one frame after a light is created, so
        // this doubles as the not-yet-rendered guard — the graph rebuilds when
        // the map appears and god rays pick it up then.
        skippedGi ??= light;
        continue;
      }
      return light;
    }
  }
  if (skippedGi && !findGodraysLight._warned) {
    findGodraysLight._warned = true;
    console.info(
      "[postprocessing] God rays are disabled: the scene's shadow-casting light has no shadow MAP to " +
        "raymarch. Its Shadow Source is \"gi\" (GI-traced shadows render no map). Switch the light back " +
        "to map shadows for god rays, or keep both by giving it a small real map alongside GI.",
    );
  }
  return null;
}

/**
 * Per-camera post-processing component.
 *
 * The component owns a {@link THREE.RenderPipeline} fed by a compiled TSL
 * graph. When the camera it lives on is the engine's active camera, the
 * pipeline replaces the engine's default `renderer.render(scene, camera)`
 * call.
 *
 * The graph is anchored by an Input pseudo-source that resolves to the
 * four auto-fed sockets of a TSL `pass(scene, camera)` node:
 *
 *   - `color`  → `pass.getTextureNode()` (the beauty render)
 *   - `depth`  → `pass.getTextureNode('depth')` (the depth attachment)
 *   - `normal` → packed view-space normal MRT
 *   - `velocity` → motion-vector MRT for temporal effects such as TRAA
 *
 * The `RenderPipeline` handles ALL the render-target bookkeeping
 * internally: it discovers the `PassNode` inside the compiled TSL graph,
 * allocates a color + depth render target the right size, renders the
 * scene into it through the WebGPU backend's managed target switching
 * (which preserves scissor/viewport state correctly), then runs the
 * post-graph fullscreen quad to the canvas.
 *
 * We never call `renderer.setRenderTarget()` from JS — manual target
 * swapping from outside the renderer's own `render()` desynchronizes
 * the WebGPU backend's cached render area and triggers validation
 * errors like "Scissor rect not contained in the render area dimensions".
 *
 * Disabling the component (or removing it) drops the override and the
 * engine falls back to its normal canvas-direct render. Multiple cameras
 * in a scene each manage their own pipeline independently; only the
 * ACTIVE camera's component participates on any given frame.
 *
 * The graph is a `.post` document named by `props.asset` — one look, authored
 * once, shared by every camera that points at it. `props.graph` is the older
 * inline form and still renders when no asset is assigned, so scenes that
 * predate the document format keep working; `activeGraph()` is where the two
 * are resolved. Either way a fresh component starts with a one-node
 * passthrough, so adding a PostprocessComponent renders the scene unchanged
 * until the user opens the editor and adds nodes.
 */
export class PostprocessComponent extends Component {
  static type = "postprocess";
  static label = "Post Process";
  static tags = ["rendering", "camera", "screen-space", "graph"];
  static defaults = {
    // The `.post` document this camera renders through. When set it WINS over
    // `graph` — the file is the authored artifact and the inline copy is
    // history. See postAsset.js for why the graph became a document.
    asset: "",
    // Legacy inline graph. Scenes authored before `.post` existed keep this
    // and keep working; the panel's "Save As" is what lifts one into a file.
    graph: null,
    // Whether to apply the post-graph at all. When false, the camera
    // renders normally and the compiled pipeline is disposed. Useful for
    // authoring a graph on a duplicate camera without paying for it on the
    // main one.
    enabled: true,
    // Preview this camera's graph through the editor viewport camera while
    // not playing. Play mode always uses the component's owning camera.
    showInEditor: false,
  };
  // The node editor (Window → Post Process) is the real UI; the slot is here
  // so the graph can be swapped from the Inspector, and — the reason it must
  // be a schema `asset` field rather than a plain string — so the scene's
  // asset sweep preloads it and the exporter ships it.
  static schema = [
    { key: "asset", label: "Graph", type: "asset", exts: ["post"], emptyLabel: "Embedded" },
    { key: "enabled", label: "Enabled", type: "boolean" },
    { key: "showInEditor", label: "Show in Editor", type: "boolean" },
  ];

  constructor(entity, props = {}) {
    super(entity, props);
    this.camera = null;
    // Camera for which scenePass/outputNode are currently compiled. This is
    // normally `camera`, but may be the editor orbit camera for preview.
    this.renderCamera = null;
    // TSL `vec4` produced by the compiled graph (the input to RenderPipeline).
    this.outputNode = null;
    this.pipeline = null;
    // The TSL `pass(scene, camera)` node that drives the beauty render.
    // Owned by the component (one per PostprocessComponent). The
    // RenderPipeline discovers it via the output graph and renders the
    // scene through it before sampling it in the post-graph quad.
    this.scenePass = null;
    this.postprocessLayers = null;
    // The engine scene reference is needed for pass(scene, camera).
    this.scene = null;
    // TSL temp nodes that must stay alive across rebuilds — primarily
    // the SSGI node, whose PassTextureNode outputs sample from an
    // offscreen render target. Three's render-graph reference tracker
    // can drop a TempNode pass whose only consumers are `.r` / `.rgb`
    // swizzles (the swizzles can be folded into the output shader
    // without materializing the PassTextureNode as its own vertex of
    // the graph). We register the SSGI node here on each compile, and
    // keep the Set reference alive across rebuilds so the pass stays
    // scheduled even when the rest of the graph changes. Cleared on
    // `#disposePipeline()`.
    this.keepaliveTemps = new Set();
    // Last compiled signature so we can skip recompiles when the graph
    // hasn't structurally changed (only hot params moved).
    this.signature = null;
    // Last `compilePostGraph` result; kept for its `updateParams`, which
    // pushes hot-param edits into the compiled addons without a rebuild.
    this.compiled = null;
    // The graph parsed out of `props.asset` (or pushed in by the editor for a
    // live preview of unsaved edits). Null until the document loads, which is
    // why `activeGraph()` falls back rather than rendering nothing.
    this.assetGraph = null;
    // Bumped per load request so a slow fetch for a graph the user has since
    // swapped away from cannot overwrite the current one when it lands.
    this.assetGeneration = 0;
    this.generation = 0;
    // Unsubscribe handle for the late-camera-arrival watcher. Cleared
    // once the camera is resolved.
    this.watchHandle = null;
    // RenderPipeline captures its renderer in the constructor, so renderer
    // recreation (MSAA/alpha changes) must rebuild the pipeline.
    this.rendererRebuildHandle = null;
    this.playChangedHandle = null;
  }

  onAttach() {
    this.rendererRebuildHandle?.();
    this.rendererRebuildHandle = this.entity.engine.on?.("renderer-rebuilt", () => {
      this.generation++;
      this.#disposePipeline();
      void this.#ensurePipeline();
    });
    this.playChangedHandle?.();
    this.playChangedHandle = this.entity.engine.on?.("play-changed", () => this.#syncRenderCamera());
    if (this.props.asset) void this.#loadAsset(++this.assetGeneration);
    this.#tryAttach();
    // If the camera component is added AFTER us (typical: postprocess is
    // a follow-up add to an existing camera), the engine emits
    // `hierarchy-changed` whenever the entity tree mutates — including new
    // components. Hook that and try again until we find the camera.
    this.watchHandle?.();
    this.watchHandle = this.entity.engine.on?.("hierarchy-changed", () => this.#tryAttach());
  }

  onDetach() {
    // Before anything else: this owns a render target AND a per-frame pass, and
    // a pass that outlives its component renders into a disposed scene.
    this.#releaseGodraysShadow();
    this.rendererRebuildHandle?.();
    this.rendererRebuildHandle = null;
    this.playChangedHandle?.();
    this.playChangedHandle = null;
    this.watchHandle?.();
    this.watchHandle = null;
    const engine = this.entity.engine;
    if (engine?.unregisterRenderOverride) {
      engine.unregisterRenderOverride(this);
    }
    this.#disposePipeline();
    this.camera = null;
    this.renderCamera = null;
    this.outputNode = null;
  }

  onDisable() {
    const engine = this.entity.engine;
    if (engine?.unregisterRenderOverride) engine.unregisterRenderOverride(this);
  }

  onEnable() {
    const engine = this.entity.engine;
    if (engine?.registerRenderOverride) engine.registerRenderOverride(this);
  }

  onPropChanged(key) {
    if (key === "enabled") {
      if (this.props.enabled) this.onEnable();
      else this.onDisable();
      return;
    }
    if (key === "showInEditor") {
      this.#syncRenderCamera();
      return;
    }
    if (key === "asset") {
      // Drop the old document immediately rather than on the new one's
      // arrival: clearing the slot has to fall back to the inline graph now,
      // and swapping must not keep rendering the previous look while the next
      // file is in flight.
      this.assetGraph = null;
      this.assetGeneration++;
      if (this.props.asset) {
        void this.#loadAsset(this.assetGeneration);
        return;
      }
    }
    // `graph` is the only other mutable prop; force a recompile.
    this.generation++;
    void this.#ensurePipeline();
  }

  /**
   * The graph this camera actually renders: the loaded `.post` document, else
   * the inline legacy graph, else a passthrough. One accessor so "which graph
   * wins" is answered in exactly one place.
   */
  activeGraph() {
    return this.assetGraph ?? this.props.graph ?? DEFAULT_POST_GRAPH;
  }

  /**
   * Editor hook: render an in-memory graph (a live preview of edits that are
   * not on disk yet, and the way the panel pushes a save into running
   * components — `resolveAssetUrl` hands back a cached blob: URL for a path
   * that was just overwritten, so re-reading the file would show the version
   * from before the save). Pass null to go back to what the props say.
   */
  applyGraph(graph) {
    // Claim the load generation so an in-flight fetch cannot land on top of
    // the preview the user is looking at.
    this.assetGeneration++;
    this.assetGraph = graph ? normalizePostGraph(graph) : null;
    this.generation++;
    void this.#ensurePipeline();
  }

  /** Re-read the assigned `.post` from disk (an external edit changed it). */
  reloadAsset() {
    if (!this.props.asset) return;
    void this.#loadAsset(++this.assetGeneration);
  }

  async #loadAsset(generation) {
    const path = this.props.asset;
    try {
      const url = await resolveAssetUrl(path);
      const json = await (await fetch(url)).json();
      if (generation !== this.assetGeneration) return;
      this.assetGraph = normalizePostAsset(json).graph;
      this.generation++;
      void this.#ensurePipeline();
    } catch (err) {
      if (generation !== this.assetGeneration) return;
      console.error(`Failed to load post-process graph "${path}": ${err?.message ?? err}`);
    }
  }

  /** Attempts to resolve the camera and bring the pipeline up. Idempotent. */
  #tryAttach() {
    if (this.camera) return;
    const cam = this.entity.getComponent("camera")?.camera;
    if (!cam) return;
    this.camera = cam;
    this.#syncRenderCamera();
    const engine = this.entity.engine;
    if (engine?.registerRenderOverride) {
      engine.registerRenderOverride(this);
    }
    // Once attached, we no longer need the watcher.
    this.watchHandle?.();
    this.watchHandle = null;
  }

  /**
   * The light god rays raymarch against — and, when the only candidate uses
   * GI shadows, the small map that makes it usable.
   *
   * three renders no shadow map for a gi-mode light (its custom `shadowNode`
   * short-circuits the path that owns the map), and `GodraysNode` dereferences
   * `light.shadow.map.depthTexture` unconditionally. So rather than losing the
   * effect on every GI scene, we render one ourselves — see `godraysShadow.js`
   * for why that is safe and why 1024² is the right size for fog.
   *
   * ONLY when the graph actually contains a godrays node: this costs a depth
   * pass per frame, and paying it for an effect nobody enabled is exactly the
   * kind of invisible cost this module has had to hunt down before.
   */
  #resolveGodraysLight(engine, graph) {
    const direct = findGodraysLight(engine);
    const wanted = (graph?.nodes ?? []).some((n) => n.type === "godrays");
    if (direct || !wanted) {
      this.#releaseGodraysShadow();
      return direct;
    }
    const gi = findGiShadowLight(engine);
    if (!gi) {
      this.#releaseGodraysShadow();
      return null;
    }
    // Re-attaching to the same light reuses the cached target, so the frequent
    // graph rebuilds (every parameter edit recompiles) do not churn textures.
    const render = ensureGodraysShadowMap(engine, gi);
    if (!render) {
      this.#releaseGodraysShadow();
      return null;
    }
    if (this._godraysShadowLight !== gi) this.#releaseGodraysShadow();
    this._godraysShadowLight = gi;
    this.unsubGodraysShadow ??= engine.onPreRender(render);
    return gi;
  }

  /** Drops the effect-only map and its per-frame pass. */
  #releaseGodraysShadow() {
    this.unsubGodraysShadow?.();
    this.unsubGodraysShadow = null;
    if (this._godraysShadowLight) {
      disposeGodraysShadowMap(this._godraysShadowLight);
      this._godraysShadowLight = null;
    }
  }

  #desiredRenderCamera(engine = this.entity.engine) {
    if (!engine?.playing && this.props.showInEditor && engine.camera) return engine.camera;
    return this.camera;
  }

  /** Recompile camera-dependent pass/depth nodes when entering/leaving Play
   * or when the editor swaps its perspective/orthographic camera. */
  #syncRenderCamera() {
    if (!this.camera) return;
    const next = this.#desiredRenderCamera();
    if (!next) return;
    if (next === this.renderCamera) {
      if (!this.pipeline) void this.#ensurePipeline();
      return;
    }
    this.renderCamera = next;
    this.generation++;
    this.#disposePipeline();
    void this.#ensurePipeline();
  }

  /**
   * Returns true when this component's camera is the engine's currently
   * active camera AND the post-process is enabled — only then does it
   * intercept the engine's render.
   */
  ownsCamera(engine) {
    // §12.66 BISECT HATCH: `__ppForceDisabled = true` (set before boot) makes
    // every postprocess component inert — no pipeline ownership, and
    // #ensurePipeline below refuses to build. Exists because "remove the
    // component after boot" is NOT a valid PP bisect: the boot-time compile
    // wave is where a PP-armed context can poison cached pipelines (the
    // empty-fragment-struct class), and only a boot with PP never armed
    // separates "PP present at compile time" from "PP running now".
    if (globalThis.__ppForceDisabled === true) return false;
    if (this.props.enabled === false) return false;
    const desired = this.#desiredRenderCamera(engine);
    if (desired !== this.renderCamera) {
      this.#syncRenderCamera();
      return false;
    }
    const allowed = engine.playing
      ? engine.camera === this.camera
      : !!this.props.showInEditor && engine.camera === this.renderCamera;
    return allowed && !!this.pipeline;
  }

  /**
   * Runs the RenderPipeline for one frame. The pipeline internally:
   *   1. Walks the output TSL graph, finds `this.scenePass`, and renders
   *      the scene to its color + depth render target (via the WebGPU
   *      backend's managed target switching).
   *   2. Runs the compiled post-graph quad to the current target (the
   *      canvas by default).
   *   3. Applies tone mapping + sRGB conversion via outputColorTransform.
   *
   * We deliberately do NOT call `renderer.render(scene, camera)` here —
   * that would double-render. And we never call `renderer.setRenderTarget`
   * manually; doing so outside the renderer's own `render()` corrupts
   * the WebGPU backend's cached viewport/scissor state.
   */
  render(engine) {
    if (!this.pipeline || !this.outputNode) return;
    // Refresh the output node + scene/camera references every frame so the
    // pipeline always sees the latest graph output (post-edit recompiles
    // change this.outputNode). The pass(scene, camera) identity is stable
    // across frames — we keep a single PassNode and rebind its refs when
    // the entity's transform changes the camera — so we only need to
    // refresh when the camera entity swaps (rare).
    // PassNode temporarily applies this mask only while it renders its MRT,
    // then restores the camera mask. Mirror the camera's current layer
    // selection every frame but always remove editor gizmos from the beauty,
    // depth, normal, velocity and material buffers consumed by effects.
    if (this.postprocessLayers && this.renderCamera) {
      this.postprocessLayers.mask = this.renderCamera.layers.mask;
      this.postprocessLayers.disable(EDITOR_LAYER);
    }
    this.pipeline.outputNode = this.outputNode;
    this.pipeline.render();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  async #ensurePipeline() {
    if (globalThis.__ppForceDisabled === true) return; // §12.66 bisect hatch — see ownsCamera
    if (!this.renderCamera) return;
    const engine = this.entity.engine;
    const renderer = engine?.renderer;
    if (!renderer) return;

    const graph = this.activeGraph();
    const signature = postGraphSignature(graph);
    // ── THE SSR ENVIRONMENT IS STRUCTURAL ───────────────────────────────────
    // SSRNode's stochastic path bakes `sampleEnvReflection` into its fragment
    // Fn and dereferences the importance-sampled environment with no null
    // guard, so whether an env map exists decides which shader gets built —
    // not a uniform. Swapping the scene's HDRI therefore has to rebuild, and a
    // scene that gains its first HDRI is what turns Stochastic from "warns and
    // degrades" into the real path. Identity, not equality: the same texture
    // re-applied by a settings re-apply must not churn pipelines.
    const ssrEnvironment = ssrEnvironmentOf(engine.scene);
    const envKey = ssrEnvironment?.uuid ?? "";
    // Hot-param-only edits (slider drags) leave the signature identical and
    // don't need a rebuild; structural edits (wires, selects, etc.) do. The
    // new values still have to reach the GPU though — `updateParams` writes
    // them into the addons' live uniforms, which is the whole reason those
    // params are declared `kind: "hot"`. Returning without it (what this did
    // before) meant a slider moved nothing until some structural edit
    // happened to force a recompile.
    if (signature === this.signature && envKey === this._ssrEnvKey && this.pipeline) {
      try {
        this.compiled?.updateParams?.(graph);
      } catch (err) {
        // An applier writes into addon uniforms; a three upgrade that renames
        // one would otherwise throw out of this async method as an unhandled
        // rejection. The pipeline itself is still valid — just stale by one
        // edit — so warn and keep rendering.
        console.warn(`Post-process hot params failed to apply: ${err?.message ?? err}`);
      }
      return;
    }

    this.generation++;
    const myGen = this.generation;

    // Load only addons reachable from Output. Eagerly Promise.all-ing every
    // three/addons TSL display module (~25 Vite deps) tripped Chrome's
    // net::ERR_INSUFFICIENT_RESOURCES and also starved the HDRI loader.
    // loadAddonsForGraph caps concurrency and retries transient fetch aborts.
    const {
      ssgi,
      ssr,
      gtao,
      denoise,
      traa,
      bloom,
      godrays,
      depthAwareBlend,
      dof,
      chromaticAberration,
      film,
      fxaa,
      smaa,
      sobel,
      rgbShift,
      sharpen,
      afterImage,
      sepia,
      bleach,
      dotScreen,
      lut3D,
      gaussianBlur,
      bilateralBlur,
      motionBlur,
      fsr1,
    } = await loadAddonsForGraph(graph);
    if (myGen !== this.generation) return;

    // Only attach the MRT slots the graph actually consumes. Every extra
    // attachment is written by EVERY material in the scene pass, and
    // `velocity` additionally makes three track previous-frame matrices
    // per object — a passthrough graph with the full 4-target MRT measured
    // ~2× total frame time vs the plain canvas render ("post-processing
    // doubles the lag"). The attachment set is structural: changing it
    // needs a fresh PassNode (and new material variants for its context).
    const needs = postGraphSceneNeeds(graph);
    const needsKey = `${needs.normal}|${needs.velocity}|${needs.matParams}`;
    if (this.scenePass && this._passNeedsKey !== needsKey) {
      try {
        this.scenePass.dispose();
      } catch (err) {
        console.warn(`PostprocessComponent: PassNode dispose failed: ${err?.message ?? err}`);
      }
      this.scenePass = null;
    }

    // Build the PassNode once. PassNode owns its color + depth render
    // targets and renders the scene through them when the RenderPipeline
    // walks the output graph. Rebuild on camera/scene swap — otherwise
    // graph edits reuse the same pass.
    if (!this.scenePass || this.scene !== engine.scene || this._passCamera !== this.renderCamera) {
      this.scene = engine.scene;
      this._passCamera = this.renderCamera;
      // 'color' scope renders the full color pass with a depth attachment;
      // that's what SSGI/SSR need to read.
      //
      // Force `samples: 1` so the PassNode's render target is NOT
      // multisampled. WebGPURenderer defaults to samples=4 (MSAA 4x) for
      // scene-wide antialiasing, and PassNode inherits that count unless
      // overridden here. A multisampled depth attachment surfaces to TSL
      // as `texture_depth_multisampled_2d`, and WGSL's `textureDimensions()`
      // overload set for that type rejects the `, level` second argument
      // — producing "no matching call to textureDimensions(texture_depth_*
      // _multisampled_2d, abstract-int)" at WGSL compile time when SSGI
      // tries to read its dimensions. Single-sampling the post-process
      // pass keeps the editor's MSAA intact (the editor / non-postprocess
      // cameras still go through the renderer's default path) and produces
      // a standard `texture_depth_2d` that SSGINode's shader expects.
      this.scenePass = TSL.pass(engine.scene, this.renderCamera, { samples: 1 });
      this._passNeedsKey = needsKey;
      this.postprocessLayers = new THREE.Layers();
      this.postprocessLayers.mask = this.renderCamera.layers.mask;
      this.postprocessLayers.disable(EDITOR_LAYER);
      this.scenePass.setLayers(this.postprocessLayers);
      // Attach a per-fragment view-space normal MRT to the scene pass.
      // SSGI consumes the normal via `getTextureNode('normal')` (an RGB
      // texture where each pixel's RGB encodes a view-space normal). The
      // `packNormalToRGB(normalView)` line tells three's per-material
      // TSL pipeline to write that packed normal to a second render
      // target *alongside* the colour pass — effectively a multi-render-
      // target. Without this, SSGI falls back to reconstructing the
      // normal from depth in-shader, which is noisy at low tessellation
      // and slow at high tessellation.
      //
      // Keep diffuseColor out for now because the graph still approximates
      // diffuse albedo with beauty.rgb.
      const mrtSlots = { output: TSL.output };
      // Packed view-space normal — SSGI/SSR/denoise read it instead of
      // reconstructing normals from depth in-shader.
      if (needs.normal) mrtSlots.normal = TSL.packNormalToRGB(TSL.normalView);
      // Motion vectors consumed by TRAA/motion blur. Must be produced by the
      // same scene pass as color/depth so temporal reprojection aligns.
      if (needs.velocity) mrtSlots.velocity = TSL.velocity;
      // Material params for screen-space reflections: metalness in R,
      // roughness in G. The hybrid SSR path reads it to tell metal from
      // dielectric and to pick the reflection blur mip.
      if (needs.matParams) {
        // ── B/A CARRY THE METAL'S F0 TINT, AS CHROMA (2026-08-15) ──────────
        //
        // A metal reflects through its own base colour — that is the whole
        // difference between gold and chrome — but SSRNode's mirror path
        // weights its sample by `vec3(metalness)` and nothing else
        // (SSRNode.js:930-932; only the STOCHASTIC branch builds an f0 from
        // albedo). So gold thread came back WHITE: the user's banner
        // embroidery read as polished chrome next to Blender's gold.
        //
        // The tint rides the two spare channels of the attachment that is
        // already here, rather than a `diffuse` MRT: an extra full-screen
        // attachment is written by every material in the scene pass, and this
        // frame is already per-pixel bound. Chroma is scale-invariant
        // (`r/(r+g+b)`), so reconstructing with `rgb / max(rgb)` returns the
        // ORIGINAL ratios exactly for any colour whose brightest channel is 1
        // — true of gold, copper and brass F0. Darker metals brighten a
        // little; the alternative was a wrong hue on all of them.
        //
        // ⚠ NOT `diffuseColor`: after `setupVariants` that is already
        // multiplied by (1 − metalness), i.e. BLACK for exactly the pixels
        // this is for. The base colour before the split is what F0 is.
        const base = shadedMaterialColor();
        const sum = base.r.add(base.g).add(base.b).max(1e-4);
        mrtSlots.matParams = TSL.vec4(
          shadedMaterialParam("metalnessNode", TSL.metalness),
          shadedMaterialParam("roughnessNode", TSL.roughness),
          base.r.div(sum),
          base.g.div(sum),
        );
      }
      // A graph that consumes only color/depth gets NO MRT at all — the
      // pass renders exactly like the plain canvas path, single attachment.
      this.scenePass.setMRT(Object.keys(mrtSlots).length > 1 ? TSL.mrt(mrtSlots) : null);
      // Narrow the normal texture to UnsignedByteType (8-bit/channel RGBA)
      // for bandwidth. Per three's example, the default HalfFloatType is
      // overkill for a packed unit-length normal — the bits of precision
      // lost at 8-bit aren't visible at typical screen-space raytracing
      // step counts.
      const normalTexture = needs.normal ? this.scenePass.getTexture("normal") : null;
      if (normalTexture) normalTexture.type = THREE.UnsignedByteType;
      // metalness/roughness are 0..1 scalars — 8-bit is plenty.
      const matTexture = needs.matParams ? this.scenePass.getTexture("matParams") : null;
      if (matTexture) matTexture.type = THREE.UnsignedByteType;
      // ── EDITOR HELPER OVERLAY PASS (editor viewport only) ───────────────
      // The scene pass strips EDITOR_LAYER so effects never see the grid or
      // gizmos — which, before this pass existed, meant a PP-owned editor
      // frame had NO editor aids at all ("no gizmos appear except the
      // outline", 2026-08-13). They cannot be drawn after pipeline.render()
      // (this file's header rule), so they render INSIDE the pipeline: a
      // second scene pass over EDITOR_LAYER only, composited by
      // #applyEditorHelpers with a per-pixel depth test against the scene
      // pass. Gated on the editor's overlay registration — game builds never
      // register one, so shipped pipelines stay byte-identical.
      this.#disposeEditorOverlayPass();
      if (typeof engine.viewportOverlayNode === "function") {
        const overlayPass = TSL.pass(engine.scene, this.renderCamera, { samples: 1 });
        const overlayLayers = new THREE.Layers();
        overlayLayers.set(EDITOR_LAYER);
        overlayLayers.enable(PP_OVERLAY_SEED_LAYER);
        overlayPass.setLayers(overlayLayers);
        // DEPTH SEED. On direct frames, helpers occlude by depth-TESTING the
        // shared buffer — and many (collider wireframes) never WRITE depth,
        // so no composite-side comparison can reconstruct their occlusion
        // ("gizmos have no depth", the first live report). Instead, a
        // fullscreen quad on a private layer renders FIRST in this pass
        // (renderOrder −1e9) and writes the scene pass's depth into the
        // overlay's depth attachment via depthNode; every helper material
        // then depth-tests inside the pass exactly as it does on direct
        // frames — depthTest:false gizmos stay always-on-top, everything
        // else occludes per fragment. No composite heuristics.
        const seedMat = new THREE.MeshBasicNodeMaterial();
        seedMat.colorWrite = false;
        seedMat.depthTest = false;
        seedMat.depthWrite = true;
        seedMat.vertexNode = TSL.vec4(TSL.positionGeometry.xy, 0, 1);
        seedMat.depthNode = TSL.float(TSL.texture(this.scenePass.renderTarget.depthTexture));
        const seedQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), seedMat);
        seedQuad.name = "__ppOverlayDepthSeed";
        seedQuad.frustumCulled = false;
        seedQuad.renderOrder = -1e9;
        seedQuad.layers.set(PP_OVERLAY_SEED_LAYER);
        engine.scene.add(seedQuad);
        this._overlaySeedQuad = seedQuad;
        // Editor helpers must NEVER reach play mode ("gizmos appear in play
        // mode", the second live report): PassNode overrides camera.layers
        // with the pass's own set, so the game camera would see EDITOR_LAYER
        // regardless of its mask. Gate with a live uniform (composite → 0)
        // AND skip the render entirely while playing.
        this._overlayLiveU = TSL.uniform(1);
        // PassNode draws scene.background as a fullscreen pass that IGNORES
        // camera layers (the occlusion-culling depth trap, same class) and
        // hard-codes autoClear — patch the instance to hide the background
        // and clear to alpha 0 so the composite can read helper coverage.
        // Instance patch, not subclass: TSL.pass is the sanctioned
        // constructor and this is the only pass with these needs.
        const originalUpdateBefore = overlayPass.updateBefore.bind(overlayPass);
        const clearColor = new THREE.Color();
        overlayPass.updateBefore = (frame) => {
          const playing = !!engine.playing;
          if (this._overlayLiveU) this._overlayLiveU.value = playing ? 0 : 1;
          if (playing) return;
          const scene = engine.scene;
          const renderer = engine.renderer;
          const bg = scene.background;
          const alpha = renderer.getClearAlpha();
          renderer.getClearColor(clearColor);
          const r = clearColor.r, g = clearColor.g, b = clearColor.b;
          scene.background = null;
          // Clear to (0,0,0,0), not just alpha 0: helpers alpha-blend onto
          // the clear COLOR, so a white scene background would whiten every
          // partial-alpha helper pixel in the premultiplied composite.
          renderer.setClearColor(0x000000, 0);
          // Liveness counter for harness probes: "is this pass actually
          // rendering every frame" is otherwise unanswerable from outside.
          globalThis.__ppOverlayTicks = (globalThis.__ppOverlayTicks ?? 0) + 1;
          try {
            originalUpdateBefore(frame);
          } finally {
            scene.background = bg;
            clearColor.setRGB(r, g, b);
            renderer.setClearColor(clearColor, alpha);
          }
        };
        this.editorOverlayPass = overlayPass;
        if (globalThis.__ppOverlayDebug) console.warn(`[pp] editorOverlayPass created (camera=${this.renderCamera?.type})`);
      }
    }

    // Pull the auto-fed input sockets from the pass.
    const beautyNode = this.scenePass.getTextureNode();
    // PassNode attaches a depth texture (see constructor); expose it as
    // a TextureNode via `getTextureNode('depth')` which lazily allocates
    // the wrapper. (See PassNode.getTextureNode docs.)
    const depthNode = this.scenePass.getTextureNode("depth");
    // Build a sample-uv interpolating view-space normal node from the
    // MRT we configured above. `unpackRGBToNormal` decodes each pixel
    // back to a vec3 in [-1,1]^3 — the same space SSGI expects when it
    // builds its TBN matrices. Without this, SSGI's sampleNormal() falls
    // back to its in-shader depth reconstruction path; with it, SSGI
    // traces against smooth interpolated normals instead.
    let normalNode = null;
    try {
      if (needs.normal) {
        const normalTex = this.scenePass.getTextureNode("normal");
        normalNode = TSL.sample((uv) => TSL.unpackRGBToNormal(normalTex.sample(uv)));
      }
    } catch (err) {
      // If the engine's three build doesn't expose the 'normal' MRT
      // slot, we degrade to null (depth reconstruction). This makes the
      // postprocess component robust against future three builds where
      // packNormalToRGB / MRT slot enumeration changes.
      console.warn(
        `PostprocessComponent: could not wire normal MRT (${err?.message ?? err}) — falling back to depth-reconstructed normals.`,
      );
      normalNode = null;
    }

    // TRAA consumes the raw velocity texture because it performs texel loads
    // and reads the XY motion vector itself.
    let velocityNode = null;
    try {
      if (needs.velocity) velocityNode = this.scenePass.getTextureNode("velocity");
    } catch (err) {
      console.warn(
        `PostprocessComponent: could not wire velocity MRT (${err?.message ?? err}) — TRAA will be a passthrough.`,
      );
      velocityNode = null;
    }

    // Per-pixel metalness (R) / roughness (G) for the hybrid SSR path. Null
    // when the MRT slot isn't available (older three builds) — the SSR node
    // then treats surfaces with its own null-node defaults.
    let metalnessNode = null;
    let roughnessNode = null;
    let metalTintNode = null;
    try {
      if (needs.matParams) {
        const matTex = this.scenePass.getTextureNode("matParams");
        metalnessNode = TSL.sample((uv) => matTex.sample(uv).r);
        roughnessNode = TSL.sample((uv) => matTex.sample(uv).g);
        // B/A hold the base colour's chroma (see the MRT slot above). Rebuild
        // the third component and renormalize by the brightest channel — that
        // inverts the projection exactly for an F0 whose max channel is 1.
        metalTintNode = TSL.sample((uv) => {
          const s = matTex.sample(uv);
          const b = s.b.add(s.a).oneMinus().max(0);
          const rgb = TSL.vec3(s.b, s.a, b);
          return rgb.div(rgb.r.max(rgb.g).max(rgb.b).max(1e-3));
        });
      }
    } catch (err) {
      console.warn(
        `PostprocessComponent: could not wire material-params MRT (${err?.message ?? err}) — SSR will treat surfaces as non-metallic.`,
      );
      metalnessNode = null;
      roughnessNode = null;
    }

    try {
      // Reset the keepalive set per compile. SSGI nodes from a previous
      // compile are stale — the SSGI's render target is bound to a
      // specific scene pass, and once we rebuild that pass the old SSGI
      // nodes would point at orphaned textures. Wipe and let the new
      // compile re-register whatever it needs.
      this.keepaliveTemps.clear();
      const compiled = compilePostGraph(graph, {
        camera: this.renderCamera,
        beautyNode,
        depthNode,
        normalNode,
        velocityNode,
        msaaEnabled:
          engine.settings?.renderer?.antialias !== false &&
          (engine.settings?.renderer?.samples ?? 4) > 1,
        metalnessNode,
        roughnessNode,
        metalTintNode,
        ssrEnvironment,
        // GI / Reflections
        ssgi,
        ssr,
        gtao,
        denoise,
        traa,
        // Effects / Filters
        bloom,
        godrays,
        depthAwareBlend,
        godraysLight: this.#resolveGodraysLight(engine, graph),
        dof,
        chromaticAberration,
        film,
        fxaa,
        smaa,
        sobel,
        rgbShift,
        sharpen,
        afterImage,
        sepia,
        bleach,
        dotScreen,
        // Color grading
        lut3D,
        // Blurs
        gaussianBlur,
        bilateralBlur,
        // Other
        motionBlur,
        fsr1,
        // Keepalive set for off-screen temp passes (SSGI, bloom, etc.)
        temps: this.keepaliveTemps,
      });
      if (myGen !== this.generation) return;
      this.outputNode = this.#applyViewportOverlay(this.#applyEditorHelpers(compiled.output));
      this.signature = compiled.signature;
      // Paired with the signature: the env decides which SSR shader was built.
      this._ssrEnvKey = envKey;
      // Retained for the hot-param path in #ensurePipeline: it owns the
      // closures that write straight into the addons' live uniforms.
      this.compiled = compiled;
    } catch (err) {
      console.error(`Post-process graph failed to compile: ${err.message ?? err}`);
      // Drop to the raw beauty so the camera still renders something.
      this.outputNode = this.#applyViewportOverlay(this.#applyEditorHelpers(beautyNode));
      this.signature = "__passthrough__";
      this.compiled = null;
    }

    if (!this.pipeline) {
      this.pipeline = new THREE.RenderPipeline(renderer, this.outputNode);
    } else {
      this.pipeline.outputNode = this.outputNode;
      this.pipeline.needsUpdate = true;
    }
  }

  /**
   * Composites the editor's viewport overlay (the selection outline ring)
   * INSIDE the pipeline's output, when the host app registered one.
   *
   * This exists because the overlay must not draw AFTER `pipeline.render()`
   * — a manual target swap outside the pipeline's managed frame silently
   * corrupts the WebGPU backend's cached render state (this file's header
   * rule; the selection outline reproduced it as a broken viewport on the
   * first selection). The editor sets `engine.viewportOverlayNode` once at
   * boot to `applySelectionOutlineOverlay` (src/editor/selectionOutline.js);
   * the wrapper's node graph is STABLE across selection changes — only its
   * mask textures' contents change — so this costs one compile per pipeline
   * build and zero rebuilds afterwards. Game builds never register one, so
   * shipped pipelines are byte-identical to before.
   */
  #applyViewportOverlay(node) {
    const overlay = this.entity?.engine?.viewportOverlayNode;
    if (typeof overlay !== "function") return node;
    try {
      return overlay(node) ?? node;
    } catch (err) {
      console.warn(`Viewport overlay failed to attach to the post pipeline: ${err?.message ?? err}`);
      return node;
    }
  }

  /**
   * Composites the editor helper pass (grid, gizmos, light helpers — the
   * EDITOR_LAYER content the scene pass strips) over the post output, inside
   * the pipeline. Occlusion rules, per pixel:
   *   - a helper that WROTE depth (grid, collider wireframes) is hidden
   *     where the scene is nearer — the same look the direct-frame shared
   *     depth buffer gives;
   *   - a helper that wrote NO depth (the transform gizmo's depthTest:false
   *     materials) always shows, exactly as on direct frames.
   * The overlay target clears to (0,0,0,0) and helpers blend onto it, so its
   * RGB is PREMULTIPLIED — composite with base·(1−a) + rgb, never mix()
   * (the postprocessing black-band trap). Helper colors ride through the
   * chain's tonemap, so they read slightly dimmer than direct frames — the
   * same accepted trade as the selection ring.
   */
  #applyEditorHelpers(node) {
    const pass = this.editorOverlayPass;
    if (globalThis.__ppOverlayDebug) {
      console.warn(`[pp] applyEditorHelpers: pass=${!!pass} scenePass=${!!this.scenePass} mode=${globalThis.__ppOverlayDebug}`);
    }
    if (!pass || !this.scenePass) return node;
    try {
      const helper = pass.getTextureNode();
      const base = TSL.vec4(node);
      // Compile-time debug taps (set the global BEFORE the pipeline builds):
      // "raw" shows the overlay target itself, "alpha" its coverage — the
      // one-run discriminator between "pass renders nothing" and "composite
      // math hides it".
      if (globalThis.__ppOverlayDebug === "raw") return TSL.vec4(helper.rgb, TSL.float(1));
      if (globalThis.__ppOverlayDebug === "alpha") return TSL.vec4(helper.a, helper.a, helper.a, TSL.float(1));
      // Occlusion happened INSIDE the pass (the depth-seed quad presents real
      // scene depth for every helper material to test against — see the pass
      // creation block), so the composite is a plain premultiplied-over, gated
      // by the play-mode uniform. TSL naming trap for whoever edits this:
      // comparisons are GLSL-style (`lessThanEqual`), NOT `lessThanOrEqual` —
      // the wrong name THROWS here and the catch downgrades it to a warn.
      const live = this._overlayLiveU ?? TSL.float(1);
      const a = helper.a.mul(live);
      const rgb = base.rgb.mul(TSL.float(1).sub(a)).add(helper.rgb.mul(live));
      return TSL.vec4(rgb, base.a);
    } catch (err) {
      console.warn(`Editor helper overlay failed to attach: ${err?.message ?? err}`);
      return node;
    }
  }

  #disposeEditorOverlayPass() {
    if (this.editorOverlayPass && typeof this.editorOverlayPass.dispose === "function") {
      try {
        this.editorOverlayPass.dispose();
      } catch (err) {
        console.warn(`PostprocessComponent: overlay pass dispose failed: ${err?.message ?? err}`);
      }
    }
    this.editorOverlayPass = null;
    if (this._overlaySeedQuad) {
      this._overlaySeedQuad.removeFromParent();
      this._overlaySeedQuad.geometry?.dispose?.();
      this._overlaySeedQuad.material?.dispose?.();
      this._overlaySeedQuad = null;
    }
  }

  #disposePipeline() {
    if (this.pipeline) {
      this.pipeline.dispose();
      this.pipeline = null;
    }
    // PassNode owns its render targets (color + depth). Dropping the
    // reference alone would leak those WebGPU textures — the backend keeps
    // them alive and on the next play (which allocates fresh targets of the
    // same dimensions) they collide in the device's resource cache and the
    // SSGI RenderPipeline comes up invalid. PassNode.dispose() releases the
    // render target explicitly (three r185, nodes/display/PassNode.js:989).
    if (this.scenePass && typeof this.scenePass.dispose === "function") {
      try {
        this.scenePass.dispose();
      } catch (err) {
        console.warn(`PostprocessComponent: PassNode dispose failed: ${err?.message ?? err}`);
      }
    }
    this.scenePass = null;
    this.#disposeEditorOverlayPass();
    this._passNeedsKey = null;
    this.postprocessLayers = null;
    this.scene = null;
    this.signature = null;
    this._ssrEnvKey = null;
    // Its appliers close over addon instances whose render targets are gone.
    this.compiled = null;
    this.outputNode = null;
    if (this.keepaliveTemps) this.keepaliveTemps.clear();
  }

  /**
   * Called by the engine on resize. The PassNode tracks the renderer's
   * drawing buffer size internally (via its updateBefore path), so we
   * don't need to resize anything ourselves. We just mark the pipeline
   * dirty so any cached display-size uniforms get re-pushed.
   */
  handleResize(width, height) {
    if (this.pipeline) this.pipeline.needsUpdate = true;
  }
}
