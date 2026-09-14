import { engine } from "../engineInstance.js";

/**
 * Commits one full sculpt stroke as a single undo step. `before`/`after` are
 * base64-encoded snapshots of the terrain's height buffer (captured at
 * pointerdown / pointerup) — the stroke itself mutates the live geometry
 * directly for immediate feedback and never touches the command bus.
 *
 * `key` (default `"heights"`) is which prop the snapshots belong to: a
 * procedural terrain (P1-T) sculpts into `heightEdits` instead — its base
 * grid is generated, and a stroke's delta must never land in `heights`,
 * which the component ignores while `procedural` is on.
 */
export class SetTerrainHeightsCommand {
  constructor(entityId, before, after, key = "heights") {
    this.entityId = entityId;
    this.before = before;
    this.after = after;
    this.key = key;
    this.label = "Sculpt Terrain";
  }

  do() {
    engine.getEntity(this.entityId)?.getComponent("terrain")?.setProp(this.key, this.after);
  }

  undo() {
    engine.getEntity(this.entityId)?.getComponent("terrain")?.setProp(this.key, this.before);
  }
}

/** Mirrors SetTerrainHeightsCommand for one texture-paint stroke on the splatmap. */
export class SetTerrainSplatmapCommand {
  constructor(entityId, before, after) {
    this.entityId = entityId;
    this.before = before;
    this.after = after;
    this.label = "Paint Terrain";
  }

  do() {
    engine.getEntity(this.entityId)?.getComponent("terrain")?.setProp("splatmap", this.after);
  }

  undo() {
    engine.getEntity(this.entityId)?.getComponent("terrain")?.setProp("splatmap", this.before);
  }
}

/** One add/remove scatter stroke, stored as compact JSON snapshots. */
export class SetTerrainScatterCommand {
  constructor(entityId, before, after) {
    this.entityId = entityId;
    this.before = before;
    this.after = after;
    this.label = "Scatter on Terrain";
  }

  #apply(snapshot) {
    const component = engine.getEntity(this.entityId)?.getComponent("terrain");
    component?.setProp("scatterLayers", JSON.parse(snapshot));
  }

  do() { this.#apply(this.after); }
  undo() { this.#apply(this.before); }
}
