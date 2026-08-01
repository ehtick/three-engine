/**
 * `engine.lod` — drives every LOD group once per frame (roadmap item 14).
 *
 * A registry rather than a walk over every entity, for the same reason
 * `viewOnlyComponents` is one: LOD groups are a small minority of a scene, and
 * finding them by scanning every entity's component map each frame costs more
 * than the work itself on scenes that use none.
 *
 * ## Why this owns the batch invalidation
 *
 * Static batching draws its members through an `InstancedMesh` proxy and only
 * consults `visible` when it REBUILDS. So hiding LOD0 and showing LOD1 without
 * telling the batch system leaves LOD0 still drawing — through the proxy — on
 * top of LOD1. Both levels on screen at once, at full cost, and the symptom is
 * "the LODs don't do anything" rather than anything that points at batching.
 *
 * The flip side is that invalidating per switch would be its own problem: a
 * hillside of five hundred props crossing thresholds at slightly different
 * moments would rebuild the grouping on nearly every frame. So the whole pass
 * runs first and raises at most ONE invalidation for the frame, which the batch
 * system already coalesces into a single rebuild in its own `sync()`.
 */
export class LodSystem {
  constructor(engine) {
    this.engine = engine;
    this.groups = new Set();
    this.enabled = true;
    /** Level switches since the last frame — surfaced in the stats overlay,
     *  because a number that never settles is the tell for a hysteresis value
     *  set too low for the scene. */
    this.switchesLastFrame = 0;
  }

  add(group) {
    this.groups.add(group);
  }

  remove(group) {
    this.groups.delete(group);
  }

  update() {
    this.switchesLastFrame = 0;
    if (!this.enabled || this.groups.size === 0) return;
    const camera = this.engine.camera;
    if (!camera) return;
    let switches = 0;
    for (const group of this.groups) {
      if (group.updateLevel(camera)) switches++;
    }
    this.switchesLastFrame = switches;
    if (switches) this.engine.batching?.invalidate();
  }

  /**
   * Turning the system off must put every level back on screen, not freeze
   * whatever happened to be showing — a scene left mid-LOD with the feature
   * disabled is a scene missing most of its geometry with no way to tell why.
   */
  setEnabled(value) {
    const next = !!value;
    if (next === this.enabled) return;
    this.enabled = next;
    if (!next) {
      for (const group of this.groups) group.releaseLevels();
    }
  }

  get stats() {
    let culled = 0;
    for (const group of this.groups) {
      if (group.activeLevel === -1) culled++;
    }
    return { groups: this.groups.size, culled, switches: this.switchesLastFrame };
  }

  dispose() {
    for (const group of this.groups) group.releaseLevels();
    this.groups.clear();
  }
}
