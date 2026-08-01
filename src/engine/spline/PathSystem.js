/**
 * Ticks everything that rides a path (roadmap item 16).
 *
 * A system rather than each follower registering its own `onUpdate` callback,
 * for one reason that only shows up in a real level: **a moving platform must
 * move before physics steps.** Physics is a module, so it registers its update
 * callback whenever the module is enabled — after the engine is constructed and
 * usually after the scene's components attach. A follower that subscribed with
 * `engine.onUpdate` would land wherever insertion order put it, so a platform
 * would sometimes be carried correctly and sometimes lag its riders by a frame,
 * varying with load order. Driven explicitly from the engine's tick, ahead of
 * the update callbacks, it is always first.
 *
 * The same ordering is what lets a script read `follower.position` and get this
 * frame's value rather than the previous one.
 */
export class PathSystem {
  constructor(engine) {
    this.engine = engine;
    this.followers = new Set();
  }

  register(follower) {
    this.followers.add(follower);
  }

  unregister(follower) {
    this.followers.delete(follower);
  }

  update(dt) {
    if (!this.followers.size) return;
    for (const follower of this.followers) {
      if (!follower.enabled) continue;
      try {
        follower.tick(dt);
      } catch (error) {
        console.error("Spline follower failed:", error);
      }
    }
  }

  dispose() {
    this.followers.clear();
  }
}
