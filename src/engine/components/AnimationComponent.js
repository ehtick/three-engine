import * as THREE from "three/webgpu";
import { Component } from "./Component.js";
import { resolveAssetUrl } from "../assetResolver.js";
import { AnimatorRuntime } from "../animGraph.js";

/**
 * Plays a .anim animation-controller asset against the sibling Model
 * component's clips. The state machine runs while playing (and, if
 * `playInEditor` is set, as an editor preview). Scripts drive it via
 *   entity.getComponent("animation").setNumber/setBool/setTrigger/play(...)
 * and drive layer weights with `setLayerWeight("Aim", 1)`.
 *
 * Root motion is opt-in per component rather than per clip: whether a
 * character is driven by its animation or by code is a property of the
 * character, and having it flip depending on which clip is playing is how you
 * get a player who slides during one attack and not the next.
 */
export class AnimationComponent extends Component {
  static type = "animation";
  static label = "Animation";
  // The state machine's current state/time is runtime state, not props —
  // leaving Play mode rebuilds this component so the next Play starts at the
  // controller's entry state.
  static resetOnStop = true;
  static defaults = {
    controller: "",
    playInEditor: true,
    rootMotion: false,
    rootMotionTarget: "transform",
    rootMotionY: false,
    rootMotionRotation: true,
    rootBone: "",
  };
  static schema = [
    { key: "controller", label: "Controller", type: "asset", exts: ["anim"] },
    { key: "playInEditor", label: "Preview in Editor", type: "boolean" },
    { key: "rootMotion", label: "Root Motion", type: "boolean" },
    // The rest only mean anything with root motion on, and four dead rows under
    // an unchecked box is how a component reads as more complicated than it is.
    {
      key: "rootMotionTarget",
      label: "Apply To",
      type: "select",
      options: ["transform", "script"],
      showIf: (p) => !!p.rootMotion,
    },
    { key: "rootMotionRotation", label: "Root Rotation", type: "boolean", showIf: (p) => !!p.rootMotion },
    { key: "rootMotionY", label: "Root Vertical", type: "boolean", showIf: (p) => !!p.rootMotion },
    { key: "rootBone", label: "Root Bone", type: "text", showIf: (p) => !!p.rootMotion },
  ];

  onAttach() {
    this.generation = (this.generation ?? 0) + 1;
    this.graph = null;
    this.mixer = null;
    this.runtime = null;
    this.unsubUpdate = this.entity.engine.onUpdate((dt) => this.#tick(dt));
    // The model loads async — rebuild once its clips exist.
    this.unsubModel = this.entity.engine.on("model-loaded", (entity) => {
      if (entity === this.entity) this.#rebuild();
    });
    if (this.props.controller) this.#loadController(this.generation);
  }

  onDetach() {
    this.generation = (this.generation ?? 0) + 1;
    this.unsubUpdate?.();
    this.unsubModel?.();
    this.#teardownRuntime();
  }

  onPropChanged(key) {
    if (key === "playInEditor") return;
    // Every other prop feeds the runtime's construction (root motion binds a
    // bone and caches a basis at build time), so they all rebuild it. The
    // controller is only re-fetched when its path changed.
    const reloadController = key === "controller";
    this.#teardownRuntime();
    if (reloadController) {
      this.graph = null;
      if (this.props.controller) this.#loadController(this.generation);
      return;
    }
    this.#rebuild();
  }

  /** Editor hook: run an in-memory graph (live preview of unsaved edits). */
  applyGraph(graph) {
    this.graph = graph;
    this.#rebuild();
  }

  /** Names of the clips available on the sibling model (editor UI). */
  getClipNames() {
    return (this.entity.getComponent("model")?.clips ?? []).map((c) => c.name);
  }

  /** The loaded model root, for the editor's bone pickers. */
  getModelRoot() {
    return this.entity.getComponent("model")?.root ?? null;
  }

  // --- script-facing parameter API -----------------------------------------
  /** Warns once (per component) if a script drives the animator before its
   *  runtime exists — otherwise these calls no-op silently and it looks like
   *  `setBool`/`setTrigger` "don't work". A runtime needs a sibling Model
   *  component on the SAME entity, with a loaded model and a controller. */
  #ensureRuntime(method) {
    if (this.runtime) return true;
    if (!this._warnedNoRuntime) {
      this._warnedNoRuntime = true;
      const hasModel = !!this.entity?.getComponent?.("model");
      console.warn(
        `AnimationComponent.${method}() had no active animator runtime on entity ` +
          `"${this.entity?.name ?? "?"}". ` +
          (hasModel
            ? "The model/controller may still be loading, or the controller has no states."
            : "This entity has no sibling Model component — the Animation component must sit on the SAME entity as the Model it animates."),
      );
    }
    return false;
  }

  setNumber(name, value) {
    if (this.#ensureRuntime("setNumber")) this.runtime.setParam(name, value);
  }

  setBool(name, value) {
    if (this.#ensureRuntime("setBool")) this.runtime.setParam(name, !!value);
  }

  setTrigger(name) {
    if (this.#ensureRuntime("setTrigger")) this.runtime.setTrigger(name);
  }

  getParam(name) {
    return this.runtime?.getParam(name);
  }

  play(stateName, fade = 0.2, layer = 0) {
    this.runtime?.play(stateName, fade, layer);
  }

  /** Blend an override/additive layer in or out. Layer 0 is always full. */
  setLayerWeight(layer, weight) {
    if (this.#ensureRuntime("setLayerWeight")) this.runtime.setLayerWeight(layer, weight);
  }

  getLayerWeight(layer) {
    return this.runtime?.getLayerWeight(layer) ?? 0;
  }

  get currentState() {
    return this.runtime?.currentState?.name ?? null;
  }

  /** Current state name per layer — `[ "Run", "Aim" ]`. */
  getLayerStates() {
    return this.runtime?.layerStates ?? [];
  }

  /**
   * Root motion accumulated since the last call: `{ position, yaw }`, in the
   * entity's local space. For `rootMotionTarget: "script"`, where the character
   * controller consumes the motion instead of the transform being written
   * directly. Returns zero when root motion is off.
   */
  consumeRootMotion() {
    if (!this.runtime?.rootMotion) return { position: new THREE.Vector3(), yaw: 0 };
    return this.runtime.rootMotion.consume();
  }

  /** This frame's root motion, without consuming it. */
  get rootMotionDelta() {
    return this.runtime?.rootMotion?.delta ?? null;
  }
  // --------------------------------------------------------------------------

  async #loadController(generation) {
    try {
      const url = await resolveAssetUrl(this.props.controller);
      const graph = await (await fetch(url)).json();
      if (generation !== this.generation) return;
      this.graph = graph;
      this.#rebuild();
    } catch (err) {
      console.error(`Failed to load animator "${this.props.controller}": ${err.message}`);
    }
  }

  #rebuild() {
    this.#teardownRuntime();
    const model = this.entity.getComponent("model");
    if (!this.graph || !model?.root || !model.clips?.length) return;
    this.mixer = new THREE.AnimationMixer(model.root);
    this.runtime = new AnimatorRuntime(this.graph, this.mixer, model.clips, {
      root: model.root,
      entityObject: this.entity.object3D,
      rootMotion: {
        enabled: !!this.props.rootMotion,
        applyY: !!this.props.rootMotionY,
        applyRotation: this.props.rootMotionRotation !== false,
        bone: this.props.rootBone ?? "",
      },
    });
    this._warnedNoRuntime = false; // runtime is live again; allow a fresh warning later
  }

  #teardownRuntime() {
    this.runtime?.dispose();
    if (this.mixer) {
      const root = this.mixer.getRoot();
      this.mixer.stopAllAction();
      // `uncacheRoot` unbinds every action, and unbinding restores each
      // animated property to the value it held before the mixer touched it
      // (PropertyMixer.restoreOriginalState) — i.e. the bind pose. We must NOT
      // additionally call `Skeleton.pose()`: it assumes each root bone's parent
      // sits at the world origin, but glTF/Sketchfab rigs place the armature
      // under an up-axis correction (e.g. ∓90° X). pose() would bake those
      // bones' bind *world* matrices into their *local* transforms; since the
      // clip only re-drives the deeper bones, the untouched root bones stay
      // corrupted and the whole model tips 90° on X (and looks frozen).
      this.mixer.uncacheRoot(root);
    }
    this.mixer = null;
    this.runtime = null;
  }

  #tick(dt) {
    if (!this.enabled) return;
    if (!this.isInView()) return;
    if (!this.runtime) return;
    const playing = this.entity.engine.playing;
    if (!playing && !this.props.playInEditor) return;
    this.runtime.update(dt);
    // The extractor always runs (it is what keeps the pose in place), but the
    // entity only MOVES while playing. Otherwise scrubbing a walk cycle in the
    // editor would quietly walk the entity across the level and save it there.
    if (playing && this.props.rootMotionTarget !== "script") {
      this.runtime.rootMotion?.applyTo(this.entity.object3D);
    }
  }
}
