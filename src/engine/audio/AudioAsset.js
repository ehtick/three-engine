import { vmState } from "../vmState.js";
import { resolveAssetUrl } from "../assetResolver.js";

/**
 * Audio asset cache + sidecar loader.
 *
 * Each `.audio` is a JSON sidecar (matching the .mat pattern) describing the
 * path of the actual audio file plus import-time options. The cache holds
 * the decoded `AudioBuffer` — loaded once, reused by every SoundComponent
 * entry that points at the same path. Subscribers re-receive the buffer
 * when the underlying file changes (e.g. the user edits a sound in their DAW
 * and the editor hot-reloads it).
 *
 * Decoding requires an `AudioContext`; the caller (AudioSystem) passes it
 * lazily. Decoded buffers are non-trivial (~MB) and live on the heap — we
 * keep a Map keyed by path so a long-running game can monitor memory and
 * evict when needed (the `dispose()` helper is here for that).
 */

export const AUDIO_ASSET_DEFAULTS = {
  path: "",
  // Optional knobs that designers might tweak at import time. The engine
  // honors them as inputs to the source node; designers can still override
  // per-entry on the SoundComponent (volume variance, loop, etc.).
  normalize: false,
  loop: false,
};

const cache = vmState("audioCache", () => new Map()); // path -> { path, def, buffer, generation, loading }
const subscribers = vmState("audioSubscribers", () => new Map()); // path -> Set<({buffer}) => void>

/** Subscribes to changes for a single asset; returns an unsubscribe fn. */
export function subscribeAudioAsset(path, cb) {
  if (!path) return () => {};
  let set = subscribers.get(path);
  if (!set) subscribers.set(path, (set = new Set()));
  set.add(cb);
  return () => set.delete(cb);
}

function notify(path, entry) {
  const set = path && subscribers.get(path);
  if (!set) return;
  for (const cb of set) {
    try {
      cb({ path, buffer: entry?.buffer ?? null, def: entry?.def ?? null });
    } catch (err) {
      console.error(`AudioAsset subscriber for "${path}": ${err.message}`);
    }
  }
}

/** True when this entry currently holds a decoded buffer. */
export function isAudioAssetReady(path) {
  const entry = cache.get(path);
  return !!(entry && entry.buffer);
}

/** Returns the cached `AudioBuffer`, or null if not loaded yet. */
export function getAudioBuffer(path) {
  return cache.get(path)?.buffer ?? null;
}

/** Returns the JSON sidecar (e.g. for inspector preview). */
export function getAudioAssetDef(path) {
  return cache.get(path)?.def ?? null;
}

/**
 * Fetches the `.audio` sidecar JSON, then resolves + fetches the raw audio
 * file pointed at by `def.path` and decodes it. Re-invocations on the same
 * path reuse the in-flight or settled entry.
 *
 * `context` is the AudioContext used to decode. May be null while the engine
 * is still booting; the loader will retry on the next call once a context
 * is supplied.
 */
export async function loadAudioAsset(path, context = null) {
  let entry = cache.get(path);
  if (entry?.buffer) return entry.buffer;
  if (entry?.loading) return entry.loading;

  if (!path) return null;
  if (!context) {
    // Defer until the AudioSystem has a context. The SoundComponent
    // re-invokes loadAudioAsset on context-ready.
    entry = { path, def: null, buffer: null, generation: (entry?.generation ?? 0) + 1, loading: null };
    cache.set(path, entry);
    return null;
  }

  const sidecarUrl = await resolveAssetUrl(path);
  let def;
  try {
    const sidecarRes = await fetch(sidecarUrl);
    def = sidecarRes.ok ? await sidecarRes.json() : null;
  } catch (err) {
    console.warn(`AudioAsset "${path}": sidecar fetch failed (${err.message}) — falling back to defaults`);
    def = null;
  }
  // The sidecar is optional — when `.audio` is missing the path itself is
  // treated as the raw audio file (extension hints at format). This matches
  // how .mat works when no .meta exists.
  const rawPath = def?.path ?? stripSidecarExt(path);
  const generation = (entry?.generation ?? 0) + 1;
  entry = {
    path,
    def: { ...AUDIO_ASSET_DEFAULTS, ...(def ?? {}), path: rawPath },
    buffer: null,
    generation,
    loading: null,
  };
  cache.set(path, entry);

  const loading = (async () => {
    try {
      const rawUrl = await resolveAssetUrl(rawPath);
      const res = await fetch(rawUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const arrayBuffer = await res.arrayBuffer();
      const decoded = await context.decodeAudioData(arrayBuffer);
      if (entry.generation !== generation) return decoded; // stale
      entry.buffer = decoded;
      notify(path, entry);
      return decoded;
    } catch (err) {
      console.error(`AudioAsset "${path}": decode failed (${err.message})`);
      return null;
    } finally {
      entry.loading = null;
    }
  })();
  entry.loading = loading;
  return loading;
}

/** Strip a trailing `.audio` so we can use the same path as a raw file. */
function stripSidecarExt(path) {
  return path.replace(/\.audio$/i, "");
}

/**
 * Re-runs the sidecar + decode path for `path`. Used by the editor when the
 * underlying file changes on disk. Existing subscribers receive the new
 * buffer (or null on failure).
 */
export async function refreshAudioAsset(path, context) {
  const entry = cache.get(path);
  if (entry) {
    entry.generation += 1;
    entry.buffer = null;
    notify(path, entry);
  }
  return loadAudioAsset(path, context);
}

/** Frees the cache entry. Currently unused — kept for future LRU work. */
export function disposeAudioAsset(path) {
  const entry = cache.get(path);
  if (!entry) return;
  // AudioBuffer holds onto an underlying heap allocation; nulling the
  // reference is enough for the GC to reclaim it.
  entry.buffer = null;
  cache.delete(path);
  notify(path, null);
}
