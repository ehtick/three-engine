// @ts-check
import { Component } from "./Component.js";
import { resolveAssetUrl } from "../assetResolver.js";
import { TimelineRuntime } from "../timeline/TimelineRuntime.js";
import { WRAP_MODES } from "../timeline/timelineAsset.js";

/**
 * The director: plays a `.timeline` asset against this scene.
 *
 * One component, because a timeline is a *sequence*, not a property of any one
 * object in it — a cutscene moves the camera, opens a door, fades a light and
 * plays a line of dialogue, and hanging that off the door would be arbitrary.
 * Drop the director on an empty entity ("Intro Cutscene") and it drives all of
 * them.
 *
 * Scripts drive it the way you would expect:
 *
 *     const director = this.entity.getComponent("timeline");
 *     director.play();                  // from the start
 *     director.play(2.5);               // from 2.5s
 *     director.pause(); director.resume();
 *     director.stop();                  // reverts what it animated
 *     director.evaluate(1.2);           // pose the scene at 1.2s without playing
 *
 * and listen for its markers with
 *
 *     this.engine.on("timeline-event", ({ method, arg }) => { ... });
 *
 * although an event marker with a method name is also dispatched straight to
 * the target entity's scripts, which is the shorter path for "call `openGate`
 * two seconds in".
 */
export class TimelineComponent extends Component {
  static type = "timeline";
  static label = "Timeline";
  static tags = ["play-mode"];
  // The playhead, the play/pause state and everything the runtime captured to
  // restore are runtime state, not props: the next Play must start from the
  // authored start time with the scene as the author left it.
  static resetOnStop = true;

  static defaults = {
    asset: "",
    playOnStart: true,
    wrapMode: "once",
    speed: 1,
    startTime: 0,
    audio: true,
    updateMode: "game",
    // trackId -> entityId. Overrides the target stored on the track itself, so
    // one timeline asset can drive twelve doors. Empty is the common case.
    bindings: {},
  };

  static schema = [
    { key: "asset", label: "Timeline", type: "asset", exts: ["timeline"] },
    { key: "playOnStart", label: "Play On Start", type: "boolean" },
    {
      key: "wrapMode",
      label: "Wrap Mode",
      type: "select",
      options: WRAP_MODES,
    },
    { key: "speed", label: "Speed", type: "number", step: 0.1 },
    { key: "startTime", label: "Start Time", type: "number", min: 0, step: 0.1 },
    { key: "audio", label: "Play Audio", type: "boolean" },
    // A cutscene that plays over a paused game (a pause-menu camera move, a
    // "time stopped" ability) needs wall-clock time; everything else wants the
    // game clock so bullet time slows the sequence with it.
    {
      key: "updateMode",
      label: "Update",
      type: "select",
      options: ["game", "unscaled"],
    },
    // Rendered by the inspector's Timeline Bindings section, not the generic
    // field list. Declared here anyway so `remapEntityRefs` can find the entity
    // ids inside it when a scene is loaded additively.
    { key: "bindings", label: "Bindings", type: "entityMap", hidden: true },
  ];

  onAttach() {
    this.generation = (this.generation ?? 0) + 1;
    this.runtime = null;
    this.timeline = null;
    this.time = this.props.startTime ?? 0;
    this.state = "stopped"; // stopped | playing | paused
    this._direction = 1;
    this._pendingAutoPlay = false;
    this._firstAdvance = true;
    this.unsubUpdate = this.entity.engine.onUpdate((dt) => this.#tick(dt));
    this.unsubPlay = this.entity.engine.on("play-changed", (playing) => {
      if (playing) {
        if (this.props.playOnStart) this.play(this.props.startTime ?? 0);
      } else {
        this.stop();
      }
    });
    if (this.props.asset) this.#loadAsset(this.generation);
  }

  onDetach() {
    this.generation = (this.generation ?? 0) + 1;
    this.unsubUpdate?.();
    this.unsubPlay?.();
    this.unsubUpdate = null;
    this.unsubPlay = null;
    this.runtime?.dispose();
    this.runtime = null;
  }

  onPropChanged(key) {
    if (key === "asset") {
      this.runtime?.dispose();
      this.runtime = null;
      this.timeline = null;
      this.state = "stopped";
      this.time = this.props.startTime ?? 0;
      if (this.props.asset) this.#loadAsset(this.generation);
      return;
    }
    // Bindings change which entity a track drives, which is exactly what the
    // runtime captured its restore values from — rebind so the old target gets
    // its value back and the new one gets captured.
    if (key === "bindings" && this.runtime) {
      const wasPlaying = this.state;
      this.runtime.unbind();
      this.runtime.bind();
      this.state = wasPlaying;
    }
  }

  onDisable() {
    // A disabled director must not keep holding the scene at a pose.
    this.runtime?.unbind();
    if (this.state === "playing") this.state = "paused";
  }

  // --- script-facing API -----------------------------------------------------

  get duration() {
    return this.runtime?.duration ?? 0;
  }

  get isPlaying() {
    return this.state === "playing";
  }

  get isPaused() {
    return this.state === "paused";
  }

  /** Starts (or restarts) playback. `from` defaults to the authored start. */
  play(from = null) {
    this.time = Number.isFinite(from) ? from : (this.props.startTime ?? 0);
    this._direction = 1;
    this._firstAdvance = true;
    this.state = "playing";
    if (!this.runtime) {
      // The asset is still loading — remember the intent and start the moment
      // it arrives, rather than silently doing nothing because a script called
      // play() on the first frame.
      this._pendingAutoPlay = true;
      return;
    }
    this.runtime.bind();
    this.#sample();
  }

  pause() {
    if (this.state === "playing") this.state = "paused";
  }

  resume() {
    if (this.state === "paused") {
      this.state = "playing";
      this._firstAdvance = true;
    }
  }

  /**
   * Stops and reverts everything the timeline animated. `stop({ hold: true })`
   * leaves the last sampled frame in place instead — what `wrapMode: "hold"`
   * does when the playhead reaches the end.
   */
  stop({ hold = false } = {}) {
    this.state = "stopped";
    this._pendingAutoPlay = false;
    this.time = this.props.startTime ?? 0;
    if (!hold) this.runtime?.unbind();
  }

  /** Moves the playhead without changing play state, and poses the scene. */
  setTime(t) {
    this.time = Math.max(0, Math.min(this.duration, Number(t) || 0));
    this._firstAdvance = true;
    if (this.runtime) {
      this.runtime.bind();
      this.#sample();
    }
  }

  /** Poses the scene at `t` without playing — a script scrubbing by hand. */
  evaluate(t) {
    this.setTime(t);
  }

  // --- internals -------------------------------------------------------------

  async #loadAsset(generation) {
    try {
      const url = await resolveAssetUrl(this.props.asset);
      const json = await (await fetch(url)).json();
      if (generation !== this.generation) return;
      this.applyTimeline(json);
    } catch (err) {
      console.error(`Failed to load timeline "${this.props.asset}": ${err.message}`);
    }
  }

  /** Editor hook: run an in-memory timeline (live preview of unsaved edits). */
  applyTimeline(json) {
    this.runtime?.dispose();
    this.timeline = json;
    this.runtime = new TimelineRuntime(this.entity.engine, json, {
      name: this.props.asset || this.entity.name,
      resolveTarget: (track) => this.resolveTrackTarget(track),
    });
    if (this._pendingAutoPlay || this.state === "playing") {
      this._pendingAutoPlay = false;
      this.state = "playing";
      this.runtime.bind();
      this.#sample();
    }
  }

  /**
   * The entity a track drives: the director's binding override if it has one,
   * otherwise the target the track itself names, and — for tracks with neither
   * — the director's own entity. That last fallback is what makes a one-entity
   * timeline (a light flicker on the object holding the director) work with no
   * setup at all.
   */
  resolveTrackTarget(track) {
    const override = this.props.bindings?.[track.id];
    const engine = this.entity.engine;
    if (override) return engine.getEntity(override) ?? null;
    if (track.target) return engine.getEntity(track.target) ?? null;
    return this.entity;
  }

  #sample() {
    this.runtime?.sample(this.time, {
      audio: this.props.audio !== false && this.state === "playing",
    });
  }

  #tick(dt) {
    if (!this.enabled || !this.runtime) return;
    if (this.state !== "playing") return;
    const engine = this.entity.engine;
    const step =
      (this.props.updateMode === "unscaled" ? engine.unscaledDeltaTime : dt) *
      (this.props.speed ?? 1) *
      this._direction;
    const duration = this.duration;
    const from = this.time;
    let to = from + step;
    let finished = false;
    let wrapped = false;

    if (duration <= 0) {
      to = 0;
    } else if (to >= duration) {
      switch (this.props.wrapMode) {
        case "loop":
          wrapped = true;
          to = to % duration;
          break;
        case "pingPong":
          this._direction = -1;
          to = Math.max(0, duration - (to - duration));
          break;
        default:
          to = duration;
          finished = true;
          break;
      }
    } else if (to < 0) {
      // Only reachable under pingPong or a negative speed.
      if (this.props.wrapMode === "pingPong") {
        this._direction = 1;
        to = Math.min(duration, -to);
      } else if (this.props.wrapMode === "loop") {
        wrapped = true;
        to = ((to % duration) + duration) % duration;
      } else {
        to = 0;
        finished = true;
      }
    }

    this.time = to;
    this.#sample();
    // Markers fire on the interval crossed, never on the pose. Going forwards
    // only: a ping-pong bounce replaying every explosion backwards is not what
    // "the playhead passed this marker" should mean.
    if (step > 0) {
      const includeStart = this._firstAdvance;
      if (wrapped) {
        // Two intervals, in order: the tail of this pass, then the head of the
        // next. Firing the wrap as one (from, to] interval would skip every
        // marker after `from` — the end of the loop, where they usually are.
        this.runtime.fireBetween(from, duration, { includeStart });
        this.runtime.fireBetween(0, to, { includeStart: true });
      } else {
        this.runtime.fireBetween(from, to, { includeStart });
      }
    }
    this._firstAdvance = false;

    if (finished) {
      // "once" reverts what it animated, "hold" leaves the last frame standing.
      // The distinction matters: a door that swings open wants hold, a camera
      // shake overlay wants its transform back.
      this.state = "stopped";
      if (this.props.wrapMode !== "hold") this.runtime.unbind();
      engine.emit("timeline-finished", { entity: this.entity, name: this.props.asset });
      this.entity.getComponent("script")?.dispatch?.("onTimelineFinished", this.props.asset);
    }
  }
}
