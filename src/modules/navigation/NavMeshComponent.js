// @ts-check
import * as THREE from "three/webgpu";
import { Component } from "../../engine/components/Component.js";
import { resolveAssetUrl, saveAssetBinary } from "../../engine/assetResolver.js";
import { DEBUG_LAYER } from "../../engine/editorLayers.js";
import { BAKE_DEFAULTS } from "./NavigationSystem.js";

/**
 * The scene's navmesh: bake settings, the baked asset, and the viewport
 * overlay.
 *
 * One per scene, on an empty entity. Putting the settings on a component
 * rather than in project settings is deliberate — bake parameters are a
 * property of the LEVEL (an indoor level and an open field want different cell
 * sizes), and a project-wide setting would force every level to share one
 * agent profile.
 *
 * The baked result is written to a `.navmesh` asset rather than embedded in the
 * scene file: navmeshes run to hundreds of kilobytes, and base64 in a JSON
 * scene makes every save and every diff carry them.
 */
export class NavMeshComponent extends Component {
  static type = "navmesh";
  static label = "NavMesh";
  static tags = ["navigation"];
  static defaults = {
    data: "",
    ...BAKE_DEFAULTS,
    bakeOnLoad: false,
    showOverlay: true,
    useBounds: false,
    boundsCenter: [0, 0, 0],
    boundsSize: [50, 20, 50],
  };
  static schema = [
    { key: "data", label: "Baked Data", type: "asset", exts: ["navmesh"] },
    { key: "agentRadius", label: "Agent Radius", type: "number", min: 0.05, step: 0.05 },
    { key: "agentHeight", label: "Agent Height", type: "number", min: 0.1, step: 0.1 },
    { key: "agentMaxClimb", label: "Max Step", type: "number", min: 0, step: 0.05 },
    { key: "agentMaxSlope", label: "Max Slope", type: "number", min: 0, max: 89, step: 1 },
    { key: "cellSize", label: "Cell Size", type: "number", min: 0.02, step: 0.02 },
    { key: "cellHeight", label: "Cell Height", type: "number", min: 0.02, step: 0.02 },
    { key: "minRegionArea", label: "Min Region", type: "number", min: 0, step: 1 },
    { key: "tag", label: "Include Tag", type: "text" },
    { key: "useBounds", label: "Limit To Bounds", type: "boolean" },
    { key: "boundsCenter", label: "Bounds Center", type: "vec3", showIf: (p) => p.useBounds },
    { key: "boundsSize", label: "Bounds Size", type: "vec3", showIf: (p) => p.useBounds },
    {
      key: "bakeOnLoad",
      label: "Bake On Load",
      type: "boolean",
    },
    { key: "showOverlay", label: "Show Overlay", type: "boolean" },
  ];

  onAttach() {
    this.generation = (this.generation ?? 0) + 1;
    this.overlay = null;
    this._unsubChanged = this.entity.engine.on("navmesh-changed", () => this.#refreshOverlay());
    this.#initialise(this.generation);
  }

  onDetach() {
    this.generation = (this.generation ?? 0) + 1;
    this._unsubChanged?.();
    this.#clearOverlay();
  }

  onPropChanged(key) {
    if (key === "showOverlay") return this.#refreshOverlay();
    if (key === "data") return this.#initialise(++this.generation);
    // Bake settings don't rebake on their own — recast is not something to run
    // on every keystroke in a number field. Press Bake.
  }

  onDisable() {
    this.#clearOverlay();
  }

  onEnable() {
    this.#refreshOverlay();
  }

  get navigation() {
    return this.entity.engine.navigation ?? null;
  }

  /** Loads the baked asset, or bakes now if asked to and there is nothing to load. */
  async #initialise(generation) {
    const engine = this.entity.engine;
    await engine.modules?.get?.("navigation")?.ready;
    if (generation !== this.generation) return;
    const nav = this.navigation;
    if (!nav) return;
    if (this.props.data) {
      const loaded = await this.#loadAsset(this.props.data);
      if (generation !== this.generation) return;
      if (loaded) return;
    }
    if (this.props.bakeOnLoad) this.bake();
    else this.#refreshOverlay();
  }

  async #loadAsset(path) {
    try {
      const url = await resolveAssetUrl(path);
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const ok = this.navigation?.fromBytes(bytes);
      if (!ok) throw new Error("the file is not a navmesh this build can read");
      this.#refreshOverlay();
      return true;
    } catch (error) {
      console.warn(
        `NavMesh: couldn't load "${path}" (${error.message}). ` +
          "Re-bake to regenerate it — navigation is disabled until then.",
      );
      return false;
    }
  }

  /**
   * Rebuilds the navmesh from the scene. Returns the system's result so the
   * inspector can report what happened rather than leaving the user to guess
   * from an unchanged overlay.
   */
  bake() {
    const nav = this.navigation;
    if (!nav) {
      return { success: false, error: "The Navigation module is still loading." };
    }
    const result = nav.bake({
      ...this.props,
      bounds: this.props.useBounds
        ? {
            center: new THREE.Vector3().fromArray(this.props.boundsCenter ?? [0, 0, 0]),
            size: new THREE.Vector3().fromArray(this.props.boundsSize ?? [50, 20, 50]),
          }
        : null,
    });
    if (result.success) this.#refreshOverlay();
    return result;
  }

  /** Bakes and writes the result to `path`, pointing this component at it. */
  async bakeAndSave(path) {
    const result = this.bake();
    if (!result.success) return result;
    const bytes = this.navigation?.toBytes();
    if (!bytes) return { success: false, error: "The bake produced no data to save." };
    const saved = await saveAssetBinary(path, bytes);
    if (!saved) {
      return {
        success: false,
        error: `Baked, but couldn't write ${path}. The navmesh is live for this session only.`,
      };
    }
    // setProp rather than a direct write so it routes through the normal
    // change events and the inspector's asset field updates.
    if (this.props.data !== path) this.setProp("data", path);
    return { ...result, path };
  }

  // --- overlay --------------------------------------------------------------

  #clearOverlay() {
    if (!this.overlay) return;
    this.entity.engine.scene.remove(this.overlay);
    this.overlay.traverse((child) => {
      /** @type {any} */ (child).geometry?.dispose();
      /** @type {any} */ (child).material?.dispose();
    });
    this.overlay = null;
  }

  /**
   * Draws the baked surface as a translucent skin plus its edges.
   *
   * A navmesh is not the floor — it is inset by the agent radius and it stops
   * at slopes and steps. Seeing exactly where it ISN'T is the entire point of
   * the overlay, and a wireframe alone doesn't read as a surface.
   */
  #refreshOverlay() {
    this.#clearOverlay();
    if (!this.enabled || !this.props.showOverlay) return;
    const geometryData = this.navigation?.debugGeometry?.();
    if (!geometryData?.indices?.length) return;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(Array.from(geometryData.positions), 3));
    geometry.setIndex(Array.from(geometryData.indices));
    geometry.computeVertexNormals();

    const group = new THREE.Group();
    group.name = "__navmeshOverlay";
    const surface = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({
        color: 0x2f9bff,
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    // Lifted a centimetre: the navmesh sits ON the floor it was baked from, and
    // coplanar surfaces z-fight into a shimmering mess that reads as a broken
    // bake rather than a rendering artifact.
    surface.position.y = 0.01;
    group.add(surface);
    group.add(
      new THREE.LineSegments(
        new THREE.WireframeGeometry(geometry),
        new THREE.LineBasicMaterial({ color: 0x8fd0ff, transparent: true, opacity: 0.5 }),
      ),
    );
    group.traverse((child) => {
      child.layers.set(DEBUG_LAYER);
      child.frustumCulled = false;
    });
    group.renderOrder = 990;
    this.overlay = group;
    this.entity.engine.scene.add(group);
  }
}
