import { Component } from "./Component.js";
import {
  SOUND_COMPONENT_DEFAULTS,
  makeDefaultEntry,
} from "../audio/defaults.js";
import {
  loadAudioAsset,
  subscribeAudioAsset,
  getAudioBuffer,
  AUDIO_ASSET_DEFAULTS,
} from "../audio/AudioAsset.js";

/**
 * Sound component.
 *
 * Each component owns a list of `entries`, where every entry refers to one
 * `.audio` (or raw `.ogg` / `.wav` / `.mp3`) file plus its per-slot params:
 *   - volume (+ variance), pitch (+ variance), loop mode
 *   - 2D vs 3D playback, falloff model, ref/max distance
 *   - start delay, duration, fade in/out
 *   - active range (start/end seconds since the entity was enabled)
 *
 * Per-entry playback is driven by `engine.audio` (an AudioSystem instance).
 * The component is data + lifecycle — the actual source nodes live in
 * slots owned by the system. Components opt into `viewOnly` so distant
 * sounds can be paused without a full teardown.
 */
export class SoundComponent extends Component {
  static type = "sound";
  static label = "Sound";
  // A sound a script started during Play would otherwise keep playing after
  // the user pressed Stop — onDetach is what silences live sources.
  static resetOnStop = true;
  static defaults = SOUND_COMPONENT_DEFAULTS;
  static schema = [
    { key: "occlusionEnabled", label: "Occlusion", type: "boolean", section: "Sound" },
    { key: "occlusionAttenuation", label: "Occlusion Amount", type: "number", min: 0, max: 1, step: 0.05, section: "Sound" },
    { key: "spatialPreset", label: "Spatial Preset", type: "select", options: ["default", "ambient", "music", "voice", "effect"], section: "Sound" },
  ];

  onAttach() {
    this.audioSystem = this.entity?.engine?.audio;
    // The component can opt out of being registered entirely while its
    // entity is disabled — keep `_slots` reserved either way so updates
    // don't NPE during a deferred re-enable.
    this._slots = [];
    this._bufferUnsubs = new Map(); // audioAsset path -> unsubscribe fn
    this._activeRange = { startedAt: this.entity?.engine?.playing ? performance.now() : 0, endAt: null };
    if (this.audioSystem) this.audioSystem.register(this);
    for (const entry of this.props.entries ?? []) this.#subscribeEntry(entry);
  }

  onDetach() {
    for (const unsub of this._bufferUnsubs.values()) unsub();
    this._bufferUnsubs.clear();
    if (this.audioSystem) this.audioSystem.unregister(this);
    this.audioSystem = null;
  }

  onEnable() {
    this._activeRange.startedAt = performance.now();
    this._activeRange.endAt = null;
    if (this.audioSystem) this.audioSystem.reconcileSlots(this);
  }

  onDisable() {
    // Stop active sources but keep the slots so re-enable restarts them.
    for (const slot of this._slots ?? []) {
      if (slot.source?.stop) {
        try { slot.source.stop(); } catch {}
      }
      slot.active = false;
    }
  }

  /**
   * Reconciles slot list, audio subscriptions, and assets. The Inspector
   * mutates `entries` via `setProp` and we react here.
   */
  onPropChanged(key) {
    if (key === "entries") {
      // Diff the subs against the new list: subscribe to new ones, drop
      // orphans. Build a fresh slot list and ask the system to reconcile.
      this.#diffSubscriptions(this.props.entries ?? []);
      if (this.audioSystem) this.audioSystem.reconcileSlots(this);
    } else if (this.audioSystem) {
      // Volume / pitch / falloff tweaks are hot-edits; the slot reads them
      // per frame, so we don't need to rebuild — but a spatialPreset
      // change requires the panner to be reconfigured.
      if (key === "spatialPreset" || key === "occlusionAttenuation") {
        for (const slot of this._slots) slot.pendingRebuild = true;
      }
    }
  }

  /**
   * Forces a play of a single entry (used by the inspector's "Preview"
   * button). The returned handle has a `stop()` that releases the temporary
   * source. Null when the system is not ready or the entry has no asset.
   */
  previewEntry(entryId) {
    if (!this.audioSystem?.ready) return null;
    const slot = (this._slots ?? []).find((s) => s.entry.id === entryId);
    if (!slot) return null;
    // Forcing a fresh source every time keeps previews self-contained and
    // independent of the existing playback state.
    if (slot.source?.stop) {
      try { slot.source.stop(); } catch {}
    }
    this.audioSystem.requestSlotRebuild(slot);
    return {
      stop: () => {
        if (slot.source?.stop) {
          try { slot.source.stop(); } catch {}
        }
        slot.active = false;
      },
    };
  }

  /** Returns the slot list (read-only) for inspector previews. */
  getSlots() {
    return this._slots ?? [];
  }

  // -------------------- subscription wiring --------------------

  #subscribeEntry(entry) {
    const path = entry.audioAsset;
    if (!path) return;
    if (this._bufferUnsubs.has(path)) return;
    const unsub = subscribeAudioAsset(path, ({ buffer }) => {
      // Fill every slot that points at this path (mirroring across the
      // subs avoids losing updates when reconcile slots later).
      for (const slot of this._slots ?? []) {
        if (slot.entry.audioAsset !== path) continue;
        slot.buffer = buffer;
        this.audioSystem?.requestSlotRebuild(slot);
      }
    });
    this._bufferUnsubs.set(path, unsub);
    // Kick the load (lazily; the AudioSystem may already have a context).
    if (this.audioSystem?.ready) {
      loadAudioAsset(path, this.audioSystem.context).then((buffer) => {
        for (const slot of this._slots ?? []) {
          if (slot.entry.audioAsset !== path) continue;
          slot.buffer = buffer ?? getAudioBuffer(path);
          this.audioSystem?.requestSlotRebuild(slot);
        }
      });
    }
  }

  #diffSubscriptions(entries) {
    const wanted = new Map();
    for (const e of entries) if (e.audioAsset) wanted.set(e.audioAsset, e);
    for (const [path, unsub] of this._bufferUnsubs) {
      if (!wanted.has(path)) {
        unsub();
        this._bufferUnsubs.delete(path);
      }
    }
    for (const [path, entry] of wanted) this.#subscribeEntry(entry);
  }
}
