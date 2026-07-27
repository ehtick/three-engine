import * as THREE from "three/webgpu";
import { getEntityBoundingSphere } from "../viewFrustum.js";

const _scratchSphere = new THREE.Sphere();

/**
 * Base class for all components. Subclasses must define:
 *   static type       — unique string id ("mesh", "light", ...)
 *   static label      — display name for the editor
 *   static defaults   — default props object
 *   static schema     — property descriptors used by the inspector:
 *                       [{ key, label, type: "number"|"color"|"select"|"text"|"boolean",
 *                          min?, max?, step?, options? }]
 * and may override onAttach/onDetach/onPropChanged.
 *
 * Subclasses may also set:
 *   static tags       — short string array of free-form editor tags, used by
 *                       the Modules panel to filter / group components
 *                       (e.g. ["physics", "play-mode", "3d"]). Pure metadata;
 *                       never read by the runtime.
 *
 * Every component has two built-in meta-toggles (default true). They are
 * not part of `schema` — the inspector renders them in the section header
 * alongside the existing eye (enabled) and remove buttons.
 *
 *   - `enabled` — when false, the component stops contributing to the
 *     runtime (no rendering, no ticking) without being detached. Data and
 *     three.js objects are preserved so toggling back on restores state.
 *
 *   - `viewOnly` — when true, the component's runtime work pauses while
 *     its entity is outside the camera frustum. Re-enabled the moment
 *     the entity re-enters. Designed to win more performance than it
 *     spends: see `viewFrustum.js` for the per-frame cost analysis.
 *
 * To opt into enabled, subclasses override `onDisable()` / `onEnable()`.
 * To opt into viewOnly, subclasses gate their `#tick` / per-frame work
 * behind `this.isInView()` (or `if (!this.viewOnly || this.isInView())`).
 */
export class Component {
  // Default: no tags. Subclasses override with a string array (e.g.
  // `static tags = ["physics", "play-mode"]`). Pure editor metadata; the
  // runtime never reads this. Defined on the base class so reading
  // `MyComponent.tags` is always safe even for subclasses that don't set it.
  static tags = [];

  // Leaving Play mode restores the scene by diffing the snapshot against the
  // live tree (see serialize.js `reconcileScene`), so components normally
  // survive it untouched — that's what keeps loaded models and the GI bake
  // alive across a stop. Components whose runtime state is NOT in `props` (a
  // playing sound, an animation state machine's position, a script instance's
  // fields) set this to true and get detached + re-attached instead, so the
  // next Play starts from a clean slate.
  static resetOnStop = false;

  constructor(entity, props = {}) {
    this.entity = entity;
    // `enabled` lives outside the subclass `defaults` spread so it's always
    // present even if a subclass forgets to declare it. Subclasses that want
    // to hide it from the inspector schema simply don't add it to `schema`.
    this.props = { enabled: true, ...this.constructor.defaults, ...props };
    // Tracks the current effective state. We compare against `props.enabled`
    // in `setEnabled` so external mutation (loading a saved scene, undo/redo)
    // is reconciled on the next enable/disable call.
    this._enabled = this.props.enabled !== false;
    // Cached "currently visible per frustum" decision. Updated once per
    // frame by `updateViewVisibility` (called from the engine's main loop
    // when this component is `viewOnly`). `null` = not yet decided.
    this._inView = null;
    // Cached viewOnly boolean (resolved against the entity's own flag once
    // per `setProp` cycle). Avoids re-reading the entity every frame.
    this._viewOnlyActive = !!this.props.viewOnly || !!this.entity?.viewOnly;
  }

  /**
   * Whether this component participates in per-frame frustum gating.
   *
   * Backed by an accessor rather than a plain field so that flipping it keeps
   * `engine.viewOnlyComponents` in sync. The engine's main loop iterates that
   * registry instead of walking every entity's component map each frame —
   * view-only components are a small minority, but the walk to find them cost
   * a nested Map iteration over the WHOLE scene every frame, which is exactly
   * the kind of per-frame O(scene) work that makes a 10k-entity scene stutter.
   */
  get _viewOnlyActive() {
    return this.__viewOnlyActive === true;
  }

  set _viewOnlyActive(value) {
    const next = !!value;
    if (next === this.__viewOnlyActive) return;
    this.__viewOnlyActive = next;
    const registry = this.entity?.engine?.viewOnlyComponents;
    if (!registry) return;
    if (next) registry.add(this);
    else registry.delete(this);
  }

  get type() {
    return this.constructor.type;
  }

  /**
   * Effective enabled state: composes the user-facing `props.enabled` with
   * any external override. Override wins when set; null = "no override".
   * Reserved for future transient-control hooks — currently the only
   * path that mutates this externally is `setEnabledOverride`, used in
   * tests and any future system that needs to gate a component without
   * touching its saved props.
   */
  get enabled() {
    if (this._enabledOverride === false) return false;
    if (this._enabledOverride === true) return true;
    return this.props.enabled !== false;
  }

  /**
   * True if this component should pause its runtime work while its entity
   * is outside the camera frustum. Resolves once per `setProp` cycle —
   * the entity-level flag is read here, not per frame, so this stays a
   * cheap boolean check.
   */
  get viewOnly() {
    return this._viewOnlyActive;
  }

  /** Called after the component is added to its entity. Build three.js objects here. */
  onAttach() {}

  /** Called before removal. Tear down three.js objects here. */
  onDetach() {}

  /**
   * Called when `enabled` flips false. Override to hide or pause the
   * component's runtime side-effects. The default is a no-op — components
   * with no side-effects (data-only) don't need to override this.
   */
  onDisable() {}

  /** Called when `enabled` flips true. The mirror of `onDisable`. */
  onEnable() {}

  /** Called after a prop changes. Default: rebuild by detach/attach. */
  onPropChanged() {
    this.onDetach();
    this.onAttach();
  }

  /**
   * Reconciles the effective enabled state (composed from `props.enabled`
   * and any external override) with the cached `_enabled` and dispatches
   * onEnable/onDisable when it actually changes. Cheap; called every
   * frame from gated components to pick up override changes without
   * bookkeeping from the caller.
   */
  reconcileEnabled() {
    const effective = this.enabled;
    if (effective === this._enabled) return false;
    this._enabled = effective;
    if (effective) this.onEnable();
    else this.onDisable();
    return true;
  }

  /**
   * Persisted setter for the runtime state. Writes to `props.enabled`
   * so the decision survives save/load and the inspector reflects it.
   * Most callers (the eye toggle, undo/redo) should use this. External
   * consumers that want a transient override should use
   * `setEnabledOverride` instead.
   */
  setEnabled(value) {
    const next = value !== false;
    if (next === (this.props.enabled !== false)) return false;
    this.props.enabled = next;
    return this.reconcileEnabled();
  }

  /**
   * Sets a transient override on the effective enabled state. Unlike
   * `setEnabled` this does NOT touch `props.enabled` — the user's stored
   * preference is preserved. Pass `null` to clear the override.
   *
   * Effective state = props.enabled && (override ?? true).
   */
  setEnabledOverride(value) {
    const next = value === null ? null : value !== false;
    if (next === this._enabledOverride) return false;
    this._enabledOverride = next;
    return this.reconcileEnabled();
  }

  setProp(key, value) {
    if (key === "enabled") {
      // Routing through setEnabled so the onEnable/onDisable hooks fire
      // and `_enabled` stays in sync. Skip the generic onPropChanged
      // (which would detach/reattach and tear down three.js state).
      const changed = this.setEnabled(value);
      if (changed) {
        const engine = this.entity?.engine;
        engine?.emit?.("component-changed", {
          entityId: this.entity?.id,
          componentType: this.type,
          key,
        });
        engine?.emit?.("hierarchy-changed");
      }
      return;
    }
    if (key === "viewOnly") {
      // Meta-toggle: never triggers detach/attach. Refresh the resolved
      // boolean (component flag OR entity flag) so `this.viewOnly` reads
      // stay O(1) per frame, and reset the cached view-decision so the
      // first per-frame test after a change picks up the new state.
      this.props.viewOnly = !!value;
      this._viewOnlyActive = !!this.props.viewOnly || !!this.entity?.viewOnly;
      this._inView = null;
      const engine = this.entity?.engine;
      engine?.emit?.("component-changed", {
        entityId: this.entity?.id,
        componentType: this.type,
        key,
      });
      return;
    }
    this.props[key] = value;
    this.onPropChanged(key, value);
    // Two events, both for editor consumers:
    //   - "component-changed" is a precise signal — the camera follow
    //     section uses it to know exactly which entity/component changed
    //     and skip noise from other entities.
    //   - "hierarchy-changed" piggy-backs the existing sceneStore refresh
    //     so the React mirror re-reads the entity's props and controlled
    //     inputs (camera's follow checkboxes, show-preview toggle, …)
    //     reflect the latest value instead of going stale.
    const engine = this.entity?.engine;
    engine?.emit?.("component-changed", {
      entityId: this.entity?.id,
      componentType: this.type,
      key,
    });
    engine?.emit?.("hierarchy-changed");
  }

  toJSON() {
    return { type: this.type, props: { ...this.props } };
  }

  /**
   * True when this component's entity is currently inside the active
   * camera's frustum. Components that opt into `viewOnly` should consult
   * this once per frame and skip per-frame work when it returns false.
   *
   * Components that aren't viewOnly never get their visibility tested;
   * the getter returns true by default so existing code that doesn't
   * know about viewOnly keeps behaving correctly.
   */
  isInView() {
    return this._inView !== false;
  }

  /**
   * Per-frame decision point. Called by the engine once per frame for
   * every component whose `viewOnly` flag (component or entity) is true.
   * Tests the entity's world bounding sphere against the shared frustum
   * and caches the result on `_inView` for the rest of the frame.
   *
   * The sphere is recomputed only when the entity (or an ancestor) moves,
   * so this is one frustum-sphere test in the steady state.
   */
  updateViewVisibility(viewFrustum) {
    if (!viewFrustum?.isReady()) {
      this._inView = true;
      return;
    }
    const sphere = _scratchSphere;
    const ok = getEntityBoundingSphere(this.entity, sphere);
    if (!ok) {
      this._inView = true;
      return;
    }
    this._inView = viewFrustum.frustum.intersectsSphere(sphere);
  }
}
