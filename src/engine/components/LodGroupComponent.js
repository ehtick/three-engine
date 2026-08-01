import * as THREE from "three/webgpu";
import { Component } from "./Component.js";
import { getEntityBoundingSphere } from "../viewFrustum.js";
import { screenCoverage, selectLod, fitLevels } from "../lod/lodSelect.js";

const _sphere = new THREE.Sphere();

/**
 * An LOD group — one object authored at several detail levels, with the engine
 * picking which one to draw (roadmap item 14).
 *
 * Virtual geometry already covers the *dense* case: a scanned rock at two
 * million triangles is a cluster DAG and needs no help. It does nothing for the
 * case that actually fills a level — five hundred cheap props, each a few
 * thousand triangles, where the cost is draw submission and vertex work rather
 * than any single mesh being big. That is what this is for: vegetation, fences,
 * barrels, rubble, the same asset repeated across a hillside.
 *
 * ## The children ARE the levels
 *
 * Level *i* is the group's *i*-th child entity, finest first. No list of entity
 * references, which matters more than it sounds: a reference list has to be
 * remapped on every additive scene load and prefab instantiation (the trap that
 * item 6 and item 10 both had to be fixed for), and it can dangle. Child order
 * cannot dangle, survives an additive load with no remap at all, and makes
 * "add a level" the ordinary reparent gesture that an imported `_LOD0/_LOD1`
 * chain already produces.
 *
 * ## It does not write `object3D.visible`
 *
 * The engine resolves every entity's `visible` from the per-mode enabled flags
 * once per frame, so anything else writing that field is overwritten before it
 * is ever drawn. Instead this sets `entity._lodHidden` and the engine's own
 * resolve pass ands it in — one writer, and an entity disabled by the author
 * stays hidden no matter which level the camera asks for.
 */
export class LodGroupComponent extends Component {
  static type = "lod";
  static label = "LOD Group";
  static tags = ["rendering", "3d", "performance"];
  static defaults = {
    // Minimum screen height (fraction of the viewport's height) for each level,
    // finest first. Refitted to the child count whenever it changes.
    levels: [0.5, 0.15, 0],
    hysteresis: 0.05,
    // -1 = automatic. Pinning a level is how you compare two of them without
    // walking backwards, and how a distant set-dressing group is told to never
    // spend the budget on its fine mesh.
    forcedLevel: -1,
  };
  static schema = [
    { key: "hysteresis", label: "Hysteresis", type: "number", min: 0, max: 0.5, step: 0.01 },
    {
      key: "forcedLevel",
      label: "Forced Level",
      type: "number",
      min: -1,
      step: 1,
    },
  ];

  constructor(entity, props) {
    super(entity, props);
    /** Level currently showing; -1 while culled, null before the first decision. */
    this.activeLevel = null;
    /** Screen height measured on the last update — what the inspector reads. */
    this.coverage = 0;
    this._applied = null;
  }

  onAttach() {
    this.entity.engine?.lod?.add(this);
  }

  onDetach() {
    this.entity.engine?.lod?.remove(this);
    // Removing the component must not leave four of five levels invisible with
    // nothing in the UI to explain why.
    this.releaseLevels();
  }

  onDisable() {
    this.releaseLevels();
  }

  onEnable() {
    this.activeLevel = null; // force a fresh decision rather than trusting a stale one
  }

  /** The child entities that are levels, finest first. */
  get levelEntities() {
    return this.entity.children ?? [];
  }

  get levelCount() {
    return this.levelEntities.length;
  }

  /**
   * Thresholds, always as long as the child list. Kept derived rather than
   * written back into props on every read: refitting is a pure function of the
   * two, and persisting it from a getter would dirty the scene just by looking
   * at it in the inspector.
   */
  get thresholds() {
    return fitLevels(this.props.levels, this.levelCount);
  }

  /**
   * Picks and applies a level. Returns true when the level changed, which the
   * LOD system turns into exactly one batch invalidation per frame.
   */
  updateLevel(camera) {
    if (!this.enabled || !camera) return false;
    const count = this.levelCount;
    if (count === 0) return false;

    const forced = this.props.forcedLevel;
    let level;
    if (typeof forced === "number" && forced >= 0) {
      level = Math.min(forced, count - 1);
      this.coverage = 0;
    } else {
      // The sphere spans EVERY level, visible or not, because it is computed
      // from the meshes rather than from what is drawn. That is what stops the
      // obvious feedback loop: measuring only the visible level would shrink
      // the sphere when a coarser level with a tighter bound took over, which
      // lowers the coverage, which selects a coarser level again.
      const ok = getEntityBoundingSphere(this.entity, _sphere);
      if (!ok) return false;
      this.coverage = screenCoverage(_sphere, camera);
      level = selectLod(this.coverage, this.thresholds, {
        hysteresis: this.props.hysteresis ?? 0,
        current: this.activeLevel,
      });
    }

    // Recorded even when unchanged: it is what the hysteresis band is measured
    // against next frame, and what the inspector reads.
    this.activeLevel = level;
    if (level === this._applied) return false;
    this.#apply(level);
    return true;
  }

  #apply(level) {
    const children = this.levelEntities;
    for (let i = 0; i < children.length; i++) {
      children[i]._lodHidden = i !== level;
    }
    this._applied = level;
  }

  /** Hands every level back to the ordinary visibility rules. */
  releaseLevels() {
    for (const child of this.levelEntities) child._lodHidden = false;
    this.activeLevel = null;
    this._applied = null;
  }

  onPropChanged(key) {
    // A threshold edit has to be able to move the level immediately, and the
    // hysteresis band would otherwise hold the old one until the camera moved
    // far enough to leave it — which looks like the edit not working.
    if (key === "levels" || key === "hysteresis" || key === "forcedLevel") {
      this.activeLevel = null;
      this._applied = null;
    }
  }
}
