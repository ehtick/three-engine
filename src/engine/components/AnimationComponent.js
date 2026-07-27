import * as THREE from "three/webgpu";
import { Component } from "./Component.js";
import { resolveAssetUrl } from "../assetResolver.js";
import { AnimatorRuntime } from "../animGraph.js";

/**
 * Plays a .anim animation-controller asset against the sibling Model
 * component's clips. The state machine runs while playing (and, if
 * `playInEditor` is set, as an editor preview). Scripts drive it via
 *   entity.getComponent("animation").setNumber/setBool/setTrigger/play(...)
 */
export class AnimationComponent extends Component {
  static type = "animation";
  static label = "Animation";
  // The state machine's current state/time is runtime state, not props —
  // leaving Play mode rebuilds this component so the next Play starts at the
  // controller's entry state.
  static resetOnStop = true;
  static defaults = { controller: "", playInEditor: true };
  static schema = [
    { key: "controller", label: "Controller", type: "asset", exts: ["anim"] },
    { key: "playInEditor", label: "Preview in Editor", type: "boolean" },
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
    this.#teardownRuntime();
    this.graph = null;
    if (this.props.controller) this.#loadController(this.generation);
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

  play(stateName, fade = 0.2) {
    this.runtime?.play(stateName, fade);
  }

  get currentState() {
    return this.runtime?.currentState?.name ?? null;
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
    this.runtime = new AnimatorRuntime(this.graph, this.mixer, model.clips);
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
    if (this.entity.engine.playing || this.props.playInEditor) this.runtime.update(dt);
  }
}
