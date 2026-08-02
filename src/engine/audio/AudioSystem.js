import * as THREE from "three/webgpu";
import { worldForward, worldPosition, worldUp, safeNormalize } from "./Spatial.js";
import { raycastOcclusion } from "./occlusion.js";
import {
  FALLOFF_DISTANCE_MODELS,
  SPATIAL_PRESETS,
} from "./defaults.js";

/**
 * Engine-owned runtime for audio. Constructed by the Engine and shared by
 * every SoundComponent / ListenerComponent.
 *
 * Lifecycle:
 *   1. The AudioContext is created lazily — modern browsers require a user
 *      gesture to instantiate it, so we wait for either `engine.start()` or
 *      the first `pointerdown` in the page.
 *   2. SoundComponents `register` themselves in `onAttach`; the system
 *      caches the registration and keeps an `instances` array mirroring it.
 *      Detach calls `unregister` and the slot is reused.
 *   3. `update(dt)` runs once per frame from the engine tick. It pushes the
 *      listener pose into the shared `AudioListener`, then walks every
 *      sound and applies gain + panner + occlusion.
 *
 * The system holds zero Three.js state of its own — all scene data is
 * pulled live from the entities, so it survives entity tree reorders and
 * undo/redo for free.
 */
export class AudioSystem {
  constructor(engine) {
    this.engine = engine;
    this.context = null;
    this.masterGain = null;
    this.sounds = new Map(); // entityId -> SoundComponent
    this.instances = []; // active entries per-frame (decimated down as sounds disable)
    this.listenerEntity = null;
    // Fallback used when no ListenerComponent is attached. Mirrors the
    // active camera so a scene without an explicit listener still hears
    // spatial audio.
    this._fallbackListener = { entity: null };
    this.masterVolume = 1;
    this._gestureUnsub = null;
    this._contextLogOnce = false;
  }

  /** True once the AudioContext is alive and usable. */
  get ready() {
    return !!this.context;
  }

  /**
   * Ensures `this.context` exists. Called on play start and on the first
   * user pointerdown so we get past the autoplay gate.
   */
  async ensureContext() {
    if (this.context) return this.context;
    if (typeof window === "undefined" || typeof window.AudioContext === "undefined") {
      // Some envs (SSR tests, headless shells) may lack it; emit once.
      if (!this._contextLogOnce) {
        console.warn("AudioSystem: AudioContext not available in this environment");
        this._contextLogOnce = true;
      }
      return null;
    }
    const Ctor = window.AudioContext ?? window.webkitAudioContext;
    if (!Ctor) return null;
    try {
      this.context = new Ctor();
    } catch (err) {
      if (!this._contextLogOnce) {
        console.warn(`AudioSystem: AudioContext init failed (${err.message})`);
        this._contextLogOnce = true;
      }
      return null;
    }
    this.masterGain = this.context.createGain();
    this.masterGain.gain.value = this.masterVolume;
    this.masterGain.connect(this.context.destination);

    // Listen for tab visibility to suspend/resume the context.
    if (typeof document !== "undefined" && document.addEventListener) {
      document.addEventListener("visibilitychange", this.#onVisibility);
    }
    return this.context;
  }

  /** Resumes the AudioContext (called on every user gesture). */
  async resumeIfNeeded() {
    if (this.context?.state === "suspended") {
      try {
        await this.context.resume();
      } catch {
        // Browser auto-unlocks on the next gesture; nothing to do.
      }
    }
  }

  /**
   * Installs a one-shot pointer listener that resumes the context. Hooked up
   * lazily on `register()` so consumers don't pay for it when audio is
   * never used.
   */
  #installGestureUnlock() {
    if (this._gestureUnsub || typeof window === "undefined") return;
    const handler = () => {
      // Creation itself must happen inside the gesture callback. Creating the
      // context during engine.start() and only resuming it here still triggers
      // Chromium's autoplay warning and can leave early sounds muted.
      this.ensureContext().then(() => this.resumeIfNeeded());
      window.removeEventListener("pointerdown", handler, true);
      window.removeEventListener("keydown", handler, true);
      this._gestureUnsub = null;
    };
    window.addEventListener("pointerdown", handler, true);
    window.addEventListener("keydown", handler, true);
    this._gestureUnsub = handler;
  }

  #onVisibility = () => {
    if (!this.context) return;
    if (document.hidden) this.context.suspend?.();
    else this.context.resume?.();
  };

  // ---------------- registration ----------------

  /**
   * Registers a SoundComponent. The component is responsible for managing
   * its own entry list — this map just tracks *which entities want to make
   * sound*. Returns the SoundInstance slots the system will iterate later.
   */
  register(soundComponent) {
    if (!soundComponent?.entity) return;
    const id = soundComponent.entity.id;
    this.sounds.set(id, soundComponent);
    this.#installGestureUnlock();
    // Pre-create slots for every current entry so per-frame updates never
    // touch the component's array.
    const slots = (soundComponent.props.entries ?? []).map((entry) => createSlot(soundComponent, entry));
    this.instances.push(...slots);
    soundComponent._slots = slots;
  }

  /** Removes a SoundComponent and stops every one of its slots. */
  unregister(soundComponent) {
    if (!soundComponent?.entity) return;
    this.sounds.delete(soundComponent.entity.id);
    for (const slot of soundComponent._slots ?? []) teardownSlot(slot);
    soundComponent._slots = [];
    this.instances = this.instances.filter((s) => s.owner !== soundComponent);
  }

  /**
   * Reconciles the active slot list to match `soundComponent.props.entries`.
   * The component calls this after a prop edit (add/remove/asset change).
   */
  reconcileSlots(soundComponent) {
    if (!soundComponent?._slots) return;
    const want = soundComponent.props.entries ?? [];
    const have = soundComponent._slots;
    // Drop slots for entries that no longer exist (match by entry id).
    const wantIds = new Set(want.map((e) => e.id));
    for (let i = have.length - 1; i >= 0; i--) {
      if (!wantIds.has(have[i].entry.id)) {
        teardownSlot(have[i]);
        have.splice(i, 1);
      }
    }
    // Re-point existing slots at the new entry objects (the inspector
    // produces a fresh entries array on every edit, so old entries become
    // orphans — but the props the slot reads live on the *current* object).
    const byId = new Map(want.map((e) => [e.id, e]));
    for (const slot of have) {
      const next = byId.get(slot.entry.id);
      if (next && next !== slot.entry) {
        slot.entry = next;
        // Asset path changes always warrant a rebuild.
        if (slot.bufferPath !== next.audioAsset) {
          slot.pendingRebuild = true;
          slot.bufferPath = next.audioAsset;
        }
      }
    }
    // Create slots for new entries.
    const haveIds = new Set(have.map((s) => s.entry.id));
    for (const entry of want) {
      if (haveIds.has(entry.id)) continue;
      const slot = createSlot(soundComponent, entry);
      slot.bufferPath = entry.audioAsset;
      have.push(slot);
    }
    // Sync local mirror.
    this.instances = this.instances.filter((s) => s.owner !== soundComponent);
    this.instances.push(...have);
  }

  /** Marks `slot` as needing a source rebuild (e.g. asset buffer swapped). */
  requestSlotRebuild(slot) {
    slot.pendingRebuild = true;
  }

  /** Sets the active ListenerComponent entity (or null to fall back to camera). */
  setListenerEntity(entity) {
    this.listenerEntity = entity;
    this.engine.emit?.("audio-changed");
  }

  /** Resolves the active listener entity, preferring the explicit one. */
  resolveListenerEntity() {
    if (this.listenerEntity && this.engine.getEntity(this.listenerEntity.id)) return this.listenerEntity;
    // Fall back to the active camera entity, then to a free-floating
    // AudioListener pose at world origin (no spatial attenuation).
    const cam = this.engine.camera;
    if (cam?.userData?.entityId) {
      const e = this.engine.getEntity(cam.userData.entityId);
      if (e) return e;
    }
    return null;
  }

  /**
   * Fires a decoded buffer through the master bus and hands back a handle that
   * can stop it. Non-spatial and un-pooled: this is for sound that belongs to
   * the *presentation* rather than to an object in the world — a timeline's
   * dialogue and stings, a UI click — where a SoundComponent on an entity would
   * be an entity invented purely to hold a sound.
   *
   * `offset` starts playback partway in, which is what lets a timeline seek into
   * the middle of a clip and hear the right moment rather than the start.
   */
  playOneShot(buffer, { volume = 1, offset = 0, loop = false, playbackRate = 1 } = {}) {
    if (!buffer || !this.context || !this.masterGain) return null;
    const context = this.context;
    let source;
    try {
      source = context.createBufferSource();
    } catch {
      return null;
    }
    source.buffer = buffer;
    source.loop = !!loop;
    source.playbackRate.value = playbackRate;
    const gain = context.createGain();
    gain.gain.value = Math.max(0, volume);
    source.connect(gain);
    gain.connect(this.masterGain);
    let stopped = false;
    const cleanup = () => {
      if (stopped) return;
      stopped = true;
      try { source.disconnect(); } catch {}
      try { gain.disconnect(); } catch {}
    };
    source.onended = cleanup;
    const start = Math.max(0, offset);
    try {
      source.start(0, loop ? start % buffer.duration : Math.min(start, buffer.duration));
    } catch {
      cleanup();
      return null;
    }
    return {
      source,
      gain,
      stop() {
        if (stopped) return;
        try { source.stop(); } catch {}
        cleanup();
      },
    };
  }

  setMasterVolume(value) {
    this.masterVolume = Math.max(0, Math.min(1, value));
    if (this.masterGain && this.context) {
      this.masterGain.gain.setTargetAtTime(this.masterVolume, this.context.currentTime, 0.05);
    }
  }

  // ---------------- per-frame update ----------------

  update(dt) {
    if (!this.context || !this.masterGain) return;
    const listener = this.resolveListenerEntity();
    this.#writeListener(listener);
    const context = this.context;
    const now = context.currentTime;
    for (let i = 0; i < this.instances.length; i++) {
      const slot = this.instances[i];
      const owner = slot.owner;
      if (!owner || !owner.enabled) continue;
      if (!owner.isInView?.()) {
        // Out-of-frustum sounds: stop their source but keep the slot warm
        // so re-entry is instant.
        if (slot.active) stopSource(slot);
        continue;
      }
      updateSlot(slot, owner, context, now, dt, this.engine, listener);
    }
  }

  #writeListener(listenerEntity) {
    const ctx = this.context;
    const listener = ctx.listener;
    if (!listener) return;
    if (listenerEntity?.object3D) {
      listenerEntity.object3D.updateWorldMatrix(true, false);
      const pos = worldPosition(listenerEntity, _scratchPos);
      const fwd = worldForward(listenerEntity, _scratchFwd);
      const up = worldUp(listenerEntity, _scratchUp);
      setListenerPosition(listener, pos.x, pos.y, pos.z);
      setListenerOrientation(listener, fwd.x, fwd.y, fwd.z, up.x, up.y, up.z);
    } else {
      // No entity — identity pose at world origin.
      setListenerPosition(listener, 0, 0, 0);
      setListenerOrientation(listener, 0, 0, -1, 0, 1, 0);
    }
  }

  /** Tears down the AudioContext. Idempotent. */
  dispose() {
    for (const slot of this.instances) teardownSlot(slot);
    this.instances = [];
    this.sounds.clear();
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.#onVisibility);
    if (this._gestureUnsub) {
      // Best-effort removal; the captured handler closes over itself.
      this._gestureUnsub = null;
    }
    if (this.masterGain) {
      try { this.masterGain.disconnect(); } catch {}
    }
    this.masterGain = null;
    if (this.context) {
      try { this.context.close(); } catch {}
    }
    this.context = null;
  }
}

const _scratchPos = new THREE.Vector3();
const _scratchFwd = new THREE.Vector3();
const _scratchUp = new THREE.Vector3();

function setListenerPosition(listener, x, y, z) {
  if (listener.positionX) {
    listener.positionX.setValueAtTime(x, listener.context?.currentTime ?? 0);
    listener.positionY.setValueAtTime(y, listener.context?.currentTime ?? 0);
    listener.positionZ.setValueAtTime(z, listener.context?.currentTime ?? 0);
  } else if (listener.setPosition) {
    listener.setPosition(x, y, z);
  }
}

function setListenerOrientation(listener, fx, fy, fz, ux, uy, uz) {
  if (listener.forwardX) {
    const t = listener.context?.currentTime ?? 0;
    listener.forwardX.setValueAtTime(fx, t);
    listener.forwardY.setValueAtTime(fy, t);
    listener.forwardZ.setValueAtTime(fz, t);
    listener.upX.setValueAtTime(ux, t);
    listener.upY.setValueAtTime(uy, t);
    listener.upZ.setValueAtTime(uz, t);
  } else if (listener.setOrientation) {
    listener.setOrientation(fx, fy, fz, ux, uy, uz);
  }
}

/* ----------------------- slot lifecycle ----------------------- */

/**
 * A slot owns the per-entry gain/panner/source nodes and remembers enough
 * state to skip rebuilds when only gain/pitch change. Source nodes are
 * mono (Web Audio collapses stereo internally).
 */
function createSlot(owner, entry) {
  return {
    owner,
    entry,
    source: null,
    panner: null,
    gain: null,
    fadeGain: null,
    started: false,
    active: false,
    pendingRebuild: true,
    buffer: null,
    startedAt: 0,
    lastSourceNode: null,
    scheduledDuration: 0,
    randomOffset: 0,
  };
}

function teardownSlot(slot) {
  stopSource(slot);
  if (slot.source && !slot.source._teardown) {
    try { slot.source.disconnect(); } catch {}
  }
  if (slot.panner) {
    try { slot.panner.disconnect(); } catch {}
  }
  if (slot.gain) {
    try { slot.gain.disconnect(); } catch {}
  }
  if (slot.fadeGain) {
    try { slot.fadeGain.disconnect(); } catch {}
  }
  slot.source = null;
  slot.panner = null;
  slot.gain = null;
  slot.fadeGain = null;
  slot.active = false;
}

function stopSource(slot) {
  if (slot.source && typeof slot.source.stop === "function") {
    try { slot.source.stop(); } catch {}
  }
  if (slot.source) {
    try { slot.source.disconnect(); } catch {}
  }
  slot.lastSourceNode = slot.source;
  slot.source = null;
  slot.active = false;
}

/**
 * Per-frame slot update. Reading the entry every frame would re-allocate
 * the structuredClone; we instead keep references and react to the entry's
 * current props via the AudioAsset subscription.
 */
function updateSlot(slot, owner, context, now, dt, engine, listenerEntity) {
  const entry = slot.entry;
  const sound = slot.owner;

  // Rebuild request (asset buffer changed or new entry).
  if (slot.pendingRebuild) {
    rebuildSlot(slot, owner, context);
    slot.pendingRebuild = false;
    if (!slot.source && !entry.audioAsset) return; // no asset yet
  }

  // While playing: scrub pitch/random offset.
  if (slot.source && entry.loop === "random") {
    const elapsed = (now - slot.startedAt) % (slot.scheduledDuration || 1);
    if (elapsed > slot.scheduledDuration - 0.05) {
      // Jump to a new offset when nearing the loop point.
      try { slot.source.stop(); } catch {}
      try { slot.source.disconnect(); } catch {}
      slot.source = cloneBufferSource(context, slot.buffer, slot.randomOffset);
      slot.source.loop = true;
      slot.source.connect(slot.gain);
      slot.source.start(0, slot.randomOffset);
      slot.startedAt = now;
      slot.randomOffset = Math.random() * Math.max(0, slot.buffer.duration - 0.05);
    }
  }

  // Position + panner update.
  if (slot.panner && sound.entity?.object3D) {
    sound.entity.object3D.updateMatrixWorld();
    const pos = worldPosition(sound.entity, _slotPos);
    slot.panner.positionX.setValueAtTime(pos.x, now);
    slot.panner.positionY.setValueAtTime(pos.y, now);
    slot.panner.positionZ.setValueAtTime(pos.z, now);
    // Set 3D vs 2D position (2D sounds ignore position by leaving the
    // panner at world origin and bypassing rolloff).
    const spatial = entry.spatial !== false;
    if (!spatial) {
      slot.panner.positionX.setValueAtTime(0, now);
      slot.panner.positionY.setValueAtTime(0, now);
      slot.panner.positionZ.setValueAtTime(0, now);
      slot.panner.setOrientation?.(0, -1, 0);
    } else if (slot.panner.orientationX) {
      const fwd = worldForward(sound.entity, _slotFwd);
      slot.panner.orientationX.setValueAtTime(fwd.x, now);
      slot.panner.orientationY.setValueAtTime(fwd.y, now);
      slot.panner.orientationZ.setValueAtTime(fwd.z, now);
    }
  }

  // Volume × occlusion × fade.
  if (slot.gain) {
    const baseVol = computeBaseVolume(entry);
    const fadeVol = computeFadeVolume(slot, entry, now);
    const occ = occlusionFactor(engine, slot, listenerEntity, entry);
    const target = baseVol * fadeVol * occ;
    slot.gain.gain.setTargetAtTime(target, now, 0.05);
  }

  // Pitch smoothing — keep within [0.01, 4] to avoid Web Audio refusing.
  if (slot.source) {
    const next = clampPitch(entry.pitch + slot.randomPitch);
    if (slot.source.playbackRate.value !== next) {
      slot.source.playbackRate.setTargetAtTime(next, now, 0.05);
    }
  }

  // Stop condition: finite duration past the end means we stop the source
  // but keep the slot warm. Active range (start/end times relative to engine
  // uptime) is handled upstream by the SoundComponent.
  if (slot.active && entry.duration != null) {
    const elapsed = now - slot.startedAt;
    if (elapsed >= entry.duration + (entry.fadeOut ?? 0)) {
      if (typeof slot.source.stop === "function") {
        try { slot.source.stop(); } catch {}
      }
      slot.active = false;
      slot.source = null;
    }
  }
}

const _slotPos = new THREE.Vector3();
const _slotFwd = new THREE.Vector3();

function rebuildSlot(slot, owner, context) {
  // Tear down everything.
  if (slot.gain) {
    try { slot.gain.disconnect(); } catch {}
  }
  if (slot.panner) {
    try { slot.panner.disconnect(); } catch {}
  }
  if (slot.source) {
    try { slot.source.stop(); } catch {}
    try { slot.source.disconnect(); } catch {}
  }
  const entry = slot.entry;
  if (!entry.audioAsset) {
    slot.buffer = null;
    slot.source = null;
    slot.active = false;
    return;
  }
  // Buffer comes from the AudioAsset cache (filled by SoundComponent via
  // its subscriber). If it's not ready, defer the rebuild.
  // Import lazily to avoid a cycle (AudioAsset.js itself has no deps on us).
  // The buffer reference is set by the SoundComponent during onAttach /
  // onAssetChange.
  const buffer = slot.buffer ?? null;
  if (!buffer) {
    slot.active = false;
    return;
  }
  slot.buffer = buffer;
  const gain = context.createGain();
  const preset = SPATIAL_PRESETS[owner.props.spatialPreset] ?? SPATIAL_PRESETS.default;
  const panner = context.createPanner();
  configurePanner(panner, entry, preset);
  if (entry.spatial !== false) {
    owner.entity.object3D.updateMatrixWorld();
    const pos = worldPosition(owner.entity, _slotPos);
    if (panner.positionX) {
      panner.positionX.setValueAtTime(pos.x, context.currentTime);
      panner.positionY.setValueAtTime(pos.y, context.currentTime);
      panner.positionZ.setValueAtTime(pos.z, context.currentTime);
    }
  }
  gain.gain.value = computeBaseVolume(entry);
  panner.connect(gain);
  gain.connect(owner.audioSystem?.masterGain ?? gain.context.destination);

  slot.gain = gain;
  slot.panner = panner;

  // Loop mode: random / pingPong are handled by re-creating the source on
  // tick; "yes" uses the native AudioBufferSourceNode loop, "no" plays once.
  const source = cloneBufferSource(context, buffer, 0);
  source.loop = entry.loop === "yes";
  source.connect(panner);
  slot.source = source;
  slot.scheduledDuration = buffer.duration;
  slot.randomOffset = entry.loop === "random" ? Math.random() * Math.max(0, buffer.duration - 0.05) : 0;
  slot.randomPitch = (entry.pitchVariance ?? 0) > 0
    ? (Math.random() * 2 - 1) * (entry.pitchVariance ?? 0)
    : 0;
  source.start(0, slot.randomOffset);
  slot.startedAt = context.currentTime;
  slot.active = true;
}

function cloneBufferSource(context, buffer, offset) {
  const src = context.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = 1;
  return src;
}

function configurePanner(panner, entry, preset) {
  if (panner.panningModel !== undefined) panner.panningModel = "HRTF";
  if (panner.distanceModel !== undefined) panner.distanceModel = FALLOFF_DISTANCE_MODELS[entry.falloff] ?? FALLOFF_DISTANCE_MODELS.inverse;
  if (panner.refDistance !== undefined) panner.refDistance = Math.max(0, entry.refDistance ?? 1);
  if (panner.maxDistance !== undefined) panner.maxDistance = Math.max(0.01, entry.maxDistance ?? 100);
  if (panner.rolloffFactor !== undefined) panner.rolloffFactor = entry.rolloffFactor ?? preset.rolloffFactor;
  // Orient the cone forward (-Z in three) so PannerNode cone math works.
  if (panner.setOrientation) panner.setOrientation(0, 0, -1);
  // 2D sources bypass positional math; updateSlot rewrites position to 0.
}

function computeBaseVolume(entry) {
  let vol = entry.volume ?? 1;
  const variance = entry.volumeVariance ?? 0;
  if (variance > 0) vol = vol * (1 + (Math.random() * 2 - 1) * variance);
  return Math.max(0, Math.min(1, vol));
}

function clampPitch(p) {
  return Math.max(0.01, Math.min(4, p));
}

function computeFadeVolume(slot, entry, now) {
  const elapsed = now - slot.startedAt;
  const fadeIn = Math.max(0, entry.fadeIn ?? 0);
  const fadeOut = Math.max(0, entry.fadeOut ?? 0);
  if (elapsed < fadeIn && fadeIn > 0) return elapsed / fadeIn;
  if (fadeOut > 0 && entry.duration != null) {
    const remaining = entry.duration + (entry.fadeOut ?? 0) - elapsed;
    if (remaining < fadeOut) return Math.max(0, remaining / fadeOut);
  }
  return 1;
}

/**
 * Multiplies gain by an attenuation-from-1 whenever the sound-to-listener
 * path is occluded. Caller multiplies this into the gain node.
 */
function occlusionFactor(engine, slot, listenerEntity, entry) {
  if (!entry.spatial) return 1;
  if (!slot.owner.props.occlusionEnabled) return 1;
  if (!listenerEntity?.object3D) return 1;
  if (!slot.owner.entity?.object3D) return 1;
  const soundPos = worldPosition(slot.owner.entity, _occPos);
  const listenerPos = worldPosition(listenerEntity, _occPos2);
  const dist = soundPos.distanceTo(listenerPos);
  if (dist < 0.001) return 1;
  const occludedFraction = raycastOcclusionFraction(
    engine,
    soundPos.x, soundPos.y, soundPos.z,
    listenerPos.x, listenerPos.y, listenerPos.z,
  );
  if (occludedFraction <= 0) return 1;
  const attenuation = Math.max(0, Math.min(1, slot.owner.props.occlusionAttenuation ?? 1));
  return 1 - attenuation * occludedFraction;
}

const _occPos = new THREE.Vector3();
const _occPos2 = new THREE.Vector3();

function raycastOcclusionFraction(engine, ox, oy, oz, tx, ty, tz) {
  const hit = raycastOcclusion(engine, ox, oy, oz, tx, ty, tz);
  return hit ? hit.fractionOccluded : 0;
}
