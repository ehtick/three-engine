import * as THREE from "three/webgpu";
import { evaluateKeys } from "./curve.js";
import { normalizeTimeline } from "./timelineAsset.js";
import { readProperty, writeProperty } from "./propertyBinding.js";
import { getAudioBuffer, loadAudioAsset } from "../audio/AudioAsset.js";

/**
 * Evaluates a timeline asset against a live scene.
 *
 * The split that shapes everything here: **state is a pure function of time,
 * triggers are a function of the interval crossed.**
 *
 *   - `sample(t)` writes the world as it should look at `t`. Called every frame
 *     during playback and on every scrub, it never consults where the playhead
 *     was before. Property curves, activation ranges, animation poses and
 *     camera shots all live here, which is what makes dragging the playhead
 *     backwards show exactly the frame that forward playback showed.
 *   - `fireBetween(from, to)` fires the things that *happen* rather than *are*:
 *     event markers. Scrubbing does not call it, so dragging the playhead
 *     across an "explode" marker forty times does not fire it forty times.
 *
 * Audio sits between the two and is handled in `sample` with an explicit
 * `audio` opt-in: a sound is state (a clip is either playing or not, and
 * seeking into the middle of one should resume it at the right offset), but it
 * must be silent while an editor scrubs.
 *
 * Binding captures the pre-timeline value of everything it touches and
 * `unbind()` puts it all back. That is not tidiness — without it, previewing a
 * cutscene in the editor permanently rewrites the light intensities, transforms
 * and enabled flags it animated, and the author's scene is quietly destroyed by
 * the act of looking at it. Same lesson as the camera rig's `Preview Rig`.
 */
export class TimelineRuntime {
  /**
   * @param engine            the Engine instance
   * @param timeline          a timeline asset (normalized on the way in)
   * @param resolveTarget     (track) => Entity|null — how a track's `target`
   *                          becomes an entity. The director passes a resolver
   *                          that applies its binding overrides first.
   */
  constructor(engine, timeline, { resolveTarget = null, name = "timeline" } = {}) {
    this.engine = engine;
    this.name = name;
    this.timeline = normalizeTimeline(timeline);
    this.resolveTarget = resolveTarget ?? ((track) => engine?.getEntity?.(track.target) ?? null);
    this.bindings = new Map(); // track id -> binding record
    this.bound = false;
    this._warned = new Set();
  }

  get duration() {
    return this.timeline.duration;
  }

  get tracks() {
    return this.timeline.tracks;
  }

  /** Swaps in an edited timeline, rebinding if we were bound. */
  setTimeline(timeline) {
    const wasBound = this.bound;
    if (wasBound) this.unbind();
    this.timeline = normalizeTimeline(timeline);
    if (wasBound) this.bind();
  }

  #warnOnce(key, message) {
    if (this._warned.has(key)) return;
    this._warned.add(key);
    console.warn(`Timeline "${this.name}": ${message}`);
  }

  // --- binding ---------------------------------------------------------------

  bind() {
    if (this.bound) return;
    this.bound = true;
    for (const track of this.tracks) {
      const entity = this.resolveTarget(track);
      const binding = { track, entity };
      switch (track.kind) {
        case "property":
          binding.restore = readProperty(entity, track.component, track.property, track.valueType);
          if (entity && binding.restore === undefined && track.keys.length) {
            this.#warnOnce(
              track.id,
              `"${track.component || "transform"}.${track.property}" isn't on entity ` +
                `"${entity.name}" — that track does nothing.`,
            );
          }
          break;
        case "activation":
          if (entity) {
            binding.restore = {
              editor: entity.enabledInEditor,
              game: entity.enabledInGame,
            };
          }
          break;
        case "animation":
          binding.actions = new Map();
          binding.mixer = null;
          // A timeline animation track OWNS the target's pose for as long as it
          // is bound — not only while a clip is under the playhead. Handing the
          // rig back to the state machine in the gaps would make an empty
          // stretch of track play whatever the animator felt like, which reads
          // as the timeline randomly losing control.
          binding.animator = entity?.getComponent?.("animation") ?? null;
          binding.animator?.setEnabledOverride(false);
          break;
        case "audio":
          binding.playing = new Map(); // clip id -> { source, gain }
          // Start the fetch now so a cutscene's first line isn't silent for the
          // half second it takes to decode.
          for (const clip of track.clips) {
            if (clip.asset) loadAudioAsset(clip.asset, this.engine?.audio?.context ?? null);
          }
          break;
        case "camera":
          binding.live = null;
          break;
        default:
          break;
      }
      this.bindings.set(track.id, binding);
    }
    // A camera track only means something if some Camera component is running
    // its rig. In Play mode that is automatic; in the editor the brain sits
    // idle unless "Preview Rig" is on, so a shot track would silently do
    // nothing. Switch it on transiently — and restore it in unbind(), because a
    // preview that leaves the flag set is a preview that rewrote the scene.
    if (this.tracks.some((t) => t.kind === "camera" && !t.muted)) {
      this._cameraBrains = this.#findCameraBrains();
      for (const brain of this._cameraBrains) brain.timelinePreview = true;
    }
  }

  unbind() {
    if (!this.bound) return;
    for (const binding of this.bindings.values()) {
      const { track, entity } = binding;
      switch (track.kind) {
        case "property":
          if (binding.restore !== undefined) {
            writeProperty(entity, track.component, track.property, binding.restore, track.valueType);
          }
          break;
        case "activation":
          if (entity && binding.restore) {
            entity.enabledInEditor = binding.restore.editor;
            entity.enabledInGame = binding.restore.game;
          }
          break;
        case "animation":
          this.#teardownMixer(binding);
          binding.animator?.setEnabledOverride(null);
          break;
        case "audio":
          for (const id of [...binding.playing.keys()]) this.#stopAudio(binding, id);
          break;
        case "camera":
          binding.live?.setTimelineShot(false);
          binding.live = null;
          break;
        default:
          break;
      }
    }
    for (const brain of this._cameraBrains ?? []) brain.timelinePreview = false;
    this._cameraBrains = null;
    this.bindings.clear();
    this.bound = false;
    this.engine?.emit?.("hierarchy-changed");
  }

  dispose() {
    this.unbind();
  }

  #findCameraBrains() {
    const out = [];
    for (const entity of this.engine?.entities?.values?.() ?? []) {
      const camera = entity.getComponent?.("camera");
      if (camera) out.push(camera);
    }
    return out;
  }

  // --- deterministic state ---------------------------------------------------

  /**
   * Writes the scene state for time `t`.
   *
   * `audio` gates sound: false while scrubbing (an editor dragging the playhead
   * through a dialogue track must not machine-gun it), true while actually
   * playing.
   */
  sample(t, { audio = false } = {}) {
    if (!this.bound) this.bind();
    const time = Number.isFinite(t) ? t : 0;
    for (const binding of this.bindings.values()) {
      const track = binding.track;
      if (track.muted) {
        if (track.kind === "audio" && binding.playing.size) {
          for (const id of [...binding.playing.keys()]) this.#stopAudio(binding, id);
        }
        continue;
      }
      switch (track.kind) {
        case "property":
          this.#sampleProperty(binding, time);
          break;
        case "activation":
          this.#sampleActivation(binding, time);
          break;
        case "animation":
          this.#sampleAnimation(binding, time);
          break;
        case "camera":
          this.#sampleCamera(binding, time);
          break;
        case "audio":
          this.#sampleAudio(binding, time, audio);
          break;
        default:
          break;
      }
    }
  }

  #sampleProperty(binding, t) {
    const { track, entity } = binding;
    if (!entity) return;
    const value = evaluateKeys(track.keys, t, track.valueType);
    if (value === undefined) return;
    writeProperty(entity, track.component, track.property, value, track.valueType);
  }

  #sampleActivation(binding, t) {
    const { track, entity } = binding;
    if (!entity) return;
    const active = track.clips.some((c) => t >= c.start && t < c.start + c.duration);
    // Written straight to the fields rather than through setEnabledIn*, whose
    // "hierarchy-changed" emit would rebuild the editor's whole scene mirror on
    // every frame the flag flips.
    entity.enabledInEditor = active;
    entity.enabledInGame = active;
  }

  // --- animation tracks ------------------------------------------------------

  #ensureMixer(binding) {
    if (binding.mixer) return binding.mixer;
    const model = binding.entity?.getComponent?.("model");
    // The model loads asynchronously; a null here just means "not yet", so we
    // retry every frame rather than warn.
    if (!model?.root || !model.clips?.length) return null;
    binding.mixer = new THREE.AnimationMixer(model.root);
    binding.clips = model.clips;
    return binding.mixer;
  }

  #teardownMixer(binding) {
    if (!binding.mixer) return;
    const root = binding.mixer.getRoot();
    binding.mixer.stopAllAction();
    // uncacheRoot unbinds every action, and unbinding restores each animated
    // property to the value it held before the mixer touched it. See the long
    // note in AnimationComponent: do NOT also call Skeleton.pose() here.
    binding.mixer.uncacheRoot(root);
    binding.mixer = null;
    binding.actions.clear();
  }

  #actionFor(binding, clipName) {
    if (binding.actions.has(clipName)) return binding.actions.get(clipName);
    const clip = binding.clips?.find((c) => c.name === clipName);
    if (!clip) {
      this.#warnOnce(
        `${binding.track.id}:${clipName}`,
        `clip "${clipName}" isn't on entity "${binding.entity?.name ?? "?"}".`,
      );
      binding.actions.set(clipName, null);
      return null;
    }
    const action = binding.mixer.clipAction(clip);
    action.play();
    action.enabled = true;
    action.setEffectiveWeight(0);
    binding.actions.set(clipName, action);
    return action;
  }

  #sampleAnimation(binding, t) {
    const mixer = this.#ensureMixer(binding);
    if (!mixer) return;
    // Zero every cached action first, then raise the ones under the playhead.
    // three normalises each track by the cumulative weight of its contributors,
    // so leaving a stale weight behind doesn't merely add a little of the old
    // clip — it changes the normalisation of the new one.
    for (const action of binding.actions.values()) {
      if (action) action.setEffectiveWeight(0);
    }
    for (const clip of binding.track.clips) {
      const local = t - clip.start;
      if (local < 0 || local >= clip.duration) continue;
      const action = this.#actionFor(binding, clip.clip);
      if (!action) continue;
      const clipLength = action.getClip().duration;
      let clipTime = clip.clipOffset + local * (clip.speed ?? 1);
      if (clip.loopClip && clipLength > 0) {
        clipTime = ((clipTime % clipLength) + clipLength) % clipLength;
      } else {
        clipTime = Math.min(Math.max(clipTime, 0), Math.max(0, clipLength - 1e-4));
      }
      action.time = clipTime;
      action.enabled = true;
      action.paused = false;
      action.setEffectiveWeight(this.#clipWeight(clip, local));
    }
    // Zero delta: the pose comes entirely from the times we just wrote, so the
    // frame rate can't drift the animation and a scrub lands on the same pose
    // playback did.
    mixer.update(0);
  }

  #clipWeight(clip, local) {
    let weight = 1;
    if (clip.blendIn > 0 && local < clip.blendIn) weight = local / clip.blendIn;
    const outStart = clip.duration - clip.blendOut;
    if (clip.blendOut > 0 && local > outStart) {
      weight = Math.min(weight, (clip.duration - local) / clip.blendOut);
    }
    return Math.max(0, Math.min(1, weight));
  }

  // --- camera shot tracks ----------------------------------------------------

  #sampleCamera(binding, t) {
    const shot = binding.track.clips.find((c) => t >= c.start && t < c.start + c.duration);
    const entity = shot?.vcam ? this.engine?.getEntity?.(shot.vcam) : null;
    const vcam = entity?.getComponent?.("vcam") ?? null;
    if (vcam === binding.live) return;
    binding.live?.setTimelineShot(false);
    vcam?.setTimelineShot(true, shot?.blend ?? -1);
    binding.live = vcam;
  }

  // --- audio tracks ----------------------------------------------------------

  #sampleAudio(binding, t, audible) {
    const active = new Map();
    if (audible) {
      for (const clip of binding.track.clips) {
        if (t >= clip.start && t < clip.start + clip.duration) active.set(clip.id, clip);
      }
    }
    for (const id of [...binding.playing.keys()]) {
      if (!active.has(id)) this.#stopAudio(binding, id);
    }
    for (const [id, clip] of active) {
      if (binding.playing.has(id)) continue;
      this.#startAudio(binding, clip, t - clip.start);
    }
  }

  #startAudio(binding, clip, offset) {
    if (!clip.asset) return;
    const buffer = getAudioBuffer(clip.asset);
    const audio = this.engine?.audio;
    if (!buffer || !audio?.ready) {
      // Not decoded yet (or no AudioContext — a headless run). Mark it playing
      // anyway so we don't retry sixty times a second; the next pass through
      // the clip will catch it.
      binding.playing.set(clip.id, null);
      return;
    }
    const handle = audio.playOneShot(buffer, {
      volume: clip.volume,
      offset,
      loop: clip.loop,
    });
    binding.playing.set(clip.id, handle);
  }

  #stopAudio(binding, id) {
    const handle = binding.playing.get(id);
    handle?.stop?.();
    binding.playing.delete(id);
  }

  // --- directional triggers --------------------------------------------------

  /**
   * Fires event markers in `(from, to]`. Called only while the timeline is
   * actually running — never on a scrub, and never backwards.
   *
   * `includeStart` widens it to `[from, to]` for the first advance after a
   * play/seek, so a marker sitting exactly at the start of a clip fires when
   * the clip starts. Without it, a marker at t=0 is unreachable — the one
   * position an author is most likely to use.
   */
  fireBetween(from, to, { includeStart = false } = {}) {
    if (!this.bound || to < from) return;
    for (const binding of this.bindings.values()) {
      const track = binding.track;
      if (track.kind !== "event" || track.muted) continue;
      for (const marker of track.keys) {
        const after = includeStart ? marker.t >= from : marker.t > from;
        if (!after || marker.t > to) continue;
        this.#dispatchEvent(binding, marker);
      }
    }
  }

  #dispatchEvent(binding, marker) {
    const entity = binding.entity;
    if (marker.method) {
      const script = entity?.getComponent?.("script");
      if (script) script.dispatch(marker.method, marker.arg);
      else if (entity) {
        this.#warnOnce(
          `${binding.track.id}:${marker.method}`,
          `event "${marker.method}" has no Script component on "${entity.name}" to receive it.`,
        );
      }
    }
    this.engine?.emit?.("timeline-event", {
      timeline: this,
      name: this.name,
      track: binding.track.id,
      entity,
      method: marker.method,
      arg: marker.arg,
      time: marker.t,
    });
  }
}
