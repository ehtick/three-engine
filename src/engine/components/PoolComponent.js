import { Component } from "./Component.js";

/**
 * Authored prewarming: "this level fires bullets, have thirty ready".
 *
 * The pool itself is code (`engine.spawn` / `engine.despawn`, see pool.js) and
 * needs no component — this exists so filling it doesn't. Prewarming is a
 * property of the *level*, not of the code that spawns: the same weapon script
 * wants three grenades in a corridor and sixty in an arena, and hard-coding the
 * count in the script makes that a code change.
 *
 * One prefab per component, because `Entity.components` is a Map keyed by type
 * and cannot hold two. A level that pools several prefabs gets one child entity
 * each — which also puts each count where an author can see it in the
 * hierarchy, rather than buried in a list field.
 */
export class PoolComponent extends Component {
  static type = "pool";
  static label = "Prefab Pool";
  static tags = ["play-mode"];
  static defaults = { prefab: "", count: 16 };
  static schema = [
    { key: "prefab", label: "Prefab", type: "prefab" },
    { key: "count", label: "Prewarm", type: "number", min: 0, max: 4096, step: 1 },
  ];

  onAttach() {
    this._unsub = this.entity.engine.on("play-changed", (playing) => {
      if (playing) this.#warm();
    });
    // A component attached mid-play (added from the inspector, or arriving with
    // an additively-loaded scene) has already missed the event.
    if (this.entity.engine.playing) this.#warm();
  }

  onDetach() {
    this._unsub?.();
    this._unsub = null;
  }

  onEnable() {
    if (this.entity.engine.playing) this.#warm();
  }

  #warm() {
    const { prefab, count } = this.props;
    if (!this.enabled || !prefab || !(count > 0)) return;
    // Not awaited: prewarming is spread across frames by the spawn budget, and
    // the level must stay playable while it fills. `prewarm` tops the pool up
    // to `count` rather than adding `count` more, so a second call (an inspector
    // edit, a re-enable) is a no-op instead of doubling the stock.
    this.entity.engine.pool.prewarm(prefab, count);
  }
}
