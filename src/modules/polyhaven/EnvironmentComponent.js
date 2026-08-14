import * as THREE from "three/webgpu";
import { Component } from "../../engine/components/Component.js";
import { loadEnvironmentAsset } from "../../engine/environmentAsset.js";

/**
 * HDRI environment: image-based lighting + optional skybox background from an
 * equirectangular .hdr/.exr asset (the format PolyHaven ships). Attaching it
 * takes over `scene.environment` (and `scene.background` when enabled);
 * detaching restores whatever the scene settings had before.
 *
 * PREFER SCENE SETTINGS → ENVIRONMENT → SKY, which takes the same .hdr/.exr
 * (see engine/environmentAsset.js). This component predates that and remains
 * for what a scene setting cannot express — a script swapping skies at runtime,
 * an HDRI that travels with a prefab — and for scenes already using it. It
 * still WINS over the scene setting, because it applies after; Scene Settings
 * says so, and offers a one-click move.
 *
 * One environment is active at a time — the last attached component wins.
 * Registered by the `polyhaven` module, but works with any HDR asset.
 */
export class EnvironmentComponent extends Component {
  static type = "environment";
  static label = "Environment (HDRI)";
  static tags = ["rendering", "lighting", "hdri", "skybox"];
  static defaults = {
    hdri: "",
    background: true,
    intensity: 1,
    blur: 0,
    rotation: 0, // degrees around Y
  };
  static schema = [
    { key: "hdri", label: "HDRI", type: "asset", exts: ["hdr", "exr"] },
    { key: "background", label: "Show as Sky", type: "boolean" },
    { key: "intensity", label: "Intensity", type: "number", min: 0, step: 0.1 },
    { key: "blur", label: "Background Blur", type: "number", min: 0, max: 1, step: 0.05 },
    { key: "rotation", label: "Rotation°", type: "number", min: 0, max: 360, step: 1 },
  ];

  #texture = null;
  #generation = 0;
  #prev = null; // { background, environment } captured before we took over

  onAttach() {
    this.#reload();
  }

  onDetach() {
    this.#generation++;
    this.#release();
  }

  onDisable() {
    this.#unapply();
  }

  onEnable() {
    this.#apply();
  }

  onPropChanged(key) {
    if (key === "hdri") this.#reload();
    else this.#apply();
  }

  get #scene() {
    return this.entity?.engine?.scene ?? null;
  }

  async #reload() {
    const generation = ++this.#generation;
    this.#release();
    const path = this.props.hdri;
    if (!path) return;
    // The SHARED decode — the same cached texture the scene's own sky slot
    // uses, so an HDRI referenced from both places is decoded once. It also
    // means the texture is not ours to dispose; see #release.
    const texture = await loadEnvironmentAsset(path);
    // A newer reload/detach happened while we were fetching, or the file could
    // not be read (loadEnvironmentAsset logs and resolves null).
    if (!texture || generation !== this.#generation) return;
    this.#texture = texture;
    this.#apply();
  }

  /** Pushes texture + params onto the scene, capturing prior state once. */
  #apply() {
    const scene = this.#scene;
    if (!scene || !this.#texture || !this._enabled) return;
    if (!this.#prev) {
      this.#prev = { background: scene.background, environment: scene.environment };
    }
    const rad = THREE.MathUtils.degToRad(this.props.rotation ?? 0);
    scene.environment = this.#texture;
    scene.environmentIntensity = this.props.intensity ?? 1;
    scene.environmentRotation.set(0, rad, 0);
    if (this.props.background !== false) {
      scene.background = this.#texture;
      scene.backgroundIntensity = this.props.intensity ?? 1;
      scene.backgroundBlurriness = this.props.blur ?? 0;
      scene.backgroundRotation.set(0, rad, 0);
    } else if (scene.background === this.#texture) {
      scene.background = this.#prev.background;
    }
  }

  /** Undoes #apply — restores only what we set, keeps the loaded texture. */
  #unapply() {
    const scene = this.#scene;
    if (!scene || !this.#prev) return;
    if (scene.environment === this.#texture) scene.environment = this.#prev.environment;
    if (scene.background === this.#texture) {
      scene.background = this.#prev.background;
      scene.backgroundBlurriness = 0;
    }
    this.#prev = null;
  }

  /**
   * Full teardown: restore the scene, drop our reference.
   *
   * The texture is NOT disposed — it belongs to the shared environment cache,
   * and the scene's own sky slot (or another component) may be pointing at the
   * same file. Disposing it here would destroy a GPU texture still assigned to
   * `scene.environment`. `invalidateEnvironmentAsset` is what frees it, and the
   * live-update path is the one caller that means it.
   */
  #release() {
    this.#unapply();
    this.#texture = null;
  }
}
