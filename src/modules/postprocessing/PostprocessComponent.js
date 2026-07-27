import * as THREE from "three/webgpu";
import * as TSL from "three/tsl";
import { Component } from "../../engine/components/Component.js";
import { EDITOR_LAYER } from "../../engine/editorLayers.js";
import {
  compilePostGraph,
  DEFAULT_POST_GRAPH,
  postGraphSceneNeeds,
  postGraphSignature,
  loadSSGI,
  loadSSR,
  loadDenoise,
  loadTRAA,
  loadBloom,
  loadGodrays,
  loadDepthAwareBlend,
  loadDOF,
  loadChromaticAberration,
  loadFilm,
  loadFXAA,
  loadSMAA,
  loadSoberOperator,
  loadRGBShift,
  loadSharpen,
  loadAfterImage,
  loadSepia,
  loadBleach,
  loadDotScreen,
  loadLut3D,
  loadGaussianBlur,
  loadBilateralBlur,
  loadMotionBlur,
  loadFSR1,
} from "./postGraph.js";

function findGodraysLight(engine) {
  for (const entity of engine?.entities?.values?.() ?? []) {
    const light = entity.getComponent?.("light")?.light;
    if (
      light &&
      (light.isDirectionalLight || light.isPointLight) &&
      light.shadow &&
      light.castShadow &&
      light.visible !== false
    ) {
      return light;
    }
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
 * The graph lives in `props.graph` and round-trips through the component's
 * default JSON serialization (no special onSerialize needed). A fresh
 * component starts with a one-node passthrough so a freshly added
 * PostprocessComponent renders the scene unchanged until the user opens
 * the editor and adds nodes.
 */
export class PostprocessComponent extends Component {
  static type = "postprocess";
  static label = "Post Process";
  static tags = ["rendering", "camera", "screen-space", "graph"];
  static defaults = {
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
  // The node editor (Window → Post Process) is the real UI; nothing
  // schema-relevant to inspect here.
  static schema = [
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
    this.#tryAttach();
    // If the camera component is added AFTER us (typical: postprocess is
    // a follow-up add to an existing camera), the engine emits
    // `hierarchy-changed` whenever the entity tree mutates — including new
    // components. Hook that and try again until we find the camera.
    this.watchHandle?.();
    this.watchHandle = this.entity.engine.on?.("hierarchy-changed", () => this.#tryAttach());
  }

  onDetach() {
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
    // `graph` is the only other mutable prop; force a recompile.
    this.generation++;
    void this.#ensurePipeline();
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
    if (!this.renderCamera) return;
    const engine = this.entity.engine;
    const renderer = engine?.renderer;
    if (!renderer) return;

    const graph = this.props.graph ?? DEFAULT_POST_GRAPH;
    const signature = postGraphSignature(graph);
    // Hot-param-only edits (slider drags) leave the signature identical and
    // don't need a rebuild; structural edits (wires, selects, etc.) do.
    if (signature === this.signature && this.pipeline) return;

    this.generation++;
    const myGen = this.generation;

    // Lazily preload the optional addons. Resolved promises are cached, so
    // the first call downloads the modules and subsequent rebuilds (graph
    // edits) reuse the result. If an addon's bundle is missing from the
    // user's three build, the promise resolves to `null` and the compiler
    // falls back to a passthrough for that node — no crash, just a warning
    // in the console.
    // Load all post-process addons in parallel. They're individually
    // memoized in `postGraph.js` so the second and subsequent compiles
    // hit the warm promise. If an addon path doesn't exist in the user's
    // three build (r185 dropped some TSL helpers into `three/addons/`),
    // the resolver logs a warning and resolves to null; the compile call
    // below treats null as "this effect is a passthrough".
    const [
      ssgi,
      ssr,
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
    ] = await Promise.all([
      loadSSGI(),
      loadSSR(),
      loadDenoise(),
      loadTRAA(),
      loadBloom(),
      loadGodrays(),
      loadDepthAwareBlend(),
      loadDOF(),
      loadChromaticAberration(),
      loadFilm(),
      loadFXAA(),
      loadSMAA(),
      loadSoberOperator(),
      loadRGBShift(),
      loadSharpen(),
      loadAfterImage(),
      loadSepia(),
      loadBleach(),
      loadDotScreen(),
      loadLut3D(),
      loadGaussianBlur(),
      loadBilateralBlur(),
      loadMotionBlur(),
      loadFSR1(),
    ]);
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
      // roughness in G. `metalness`/`roughness` are MaterialNode accessors
      // that resolve to each material's own value during its fragment
      // shader (defaulting to 0 / 1 for materials without the property),
      // so the pass writes a per-pixel material buffer alongside colour.
      // The hybrid SSR path reads it to tell metal from dielectric and to
      // pick the reflection blur mip; without it SSR reflects everything
      // or nothing.
      if (needs.matParams) mrtSlots.matParams = TSL.vec4(TSL.metalness, TSL.roughness, 0, 1);
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
    try {
      if (needs.matParams) {
        const matTex = this.scenePass.getTextureNode("matParams");
        metalnessNode = TSL.sample((uv) => matTex.sample(uv).r);
        roughnessNode = TSL.sample((uv) => matTex.sample(uv).g);
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
        // GI / Reflections
        ssgi,
        ssr,
        denoise,
        traa,
        // Effects / Filters
        bloom,
        godrays,
        depthAwareBlend,
        godraysLight: findGodraysLight(engine),
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
      this.outputNode = compiled.output;
      this.signature = compiled.signature;
    } catch (err) {
      console.error(`Post-process graph failed to compile: ${err.message ?? err}`);
      // Drop to the raw beauty so the camera still renders something.
      this.outputNode = beautyNode;
      this.signature = "__passthrough__";
    }

    if (!this.pipeline) {
      this.pipeline = new THREE.RenderPipeline(renderer, this.outputNode);
    } else {
      this.pipeline.outputNode = this.outputNode;
      this.pipeline.needsUpdate = true;
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
    this._passNeedsKey = null;
    this.postprocessLayers = null;
    this.scene = null;
    this.signature = null;
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
