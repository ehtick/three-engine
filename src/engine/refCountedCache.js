/**
 * Refcounted, promise-deduplicating cache for decoded assets (parsed GLBs,
 * textures). Pure — no three import — so `node --test` pins the ownership rules.
 *
 * - `acquire(key, ...args)` shares ONE in-flight/settled load per key and takes
 *   a reference; pair every resolved value with one `release(value)`.
 * - The last release schedules disposal after `evictDelayMs` rather than at
 *   once: a component re-attach (detach → attach on a prop change, Play/Stop
 *   restore) releases and re-acquires the same asset within a turn or two, and
 *   re-decoding a GLB for that is the waste this cache exists to remove.
 * - `invalidate(match)` RETIRES entries whose bytes changed on disk: new
 *   acquires load fresh, current holders keep their value and it is disposed
 *   when the last of them lets go — never under a live user.
 * - A failed load is dropped, so a repaired file can load later.
 */
export function createRefCountedCache({ load, dispose, evictDelayMs = 0 }) {
  /** @type {Map<string, any>} key -> live entry */
  const entries = new Map();
  /** @type {Map<any, any>} resolved value -> entry (live or retired) */
  const byValue = new Map();

  const evict = (entry) => {
    if (entry.timer != null) clearTimeout(entry.timer);
    entry.timer = null;
    if (entries.get(entry.key) === entry) entries.delete(entry.key);
    if (entry.disposed) return;
    entry.disposed = true;
    if (entry.value !== undefined) {
      byValue.delete(entry.value);
      try {
        dispose?.(entry.value, entry.key);
      } catch (error) {
        console.warn(`[asset-cache] dispose failed (${entry.key}):`, error?.message ?? error);
      }
    }
  };

  const scheduleEvict = (entry) => {
    if (entry.retired) return evict(entry);
    if (entry.timer != null) return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      if (entry.refs === 0) evict(entry);
    }, Math.max(0, evictDelayMs));
    entry.timer?.unref?.();
  };

  return {
    acquire(key, ...args) {
      let entry = entries.get(key);
      if (!entry) {
        entry = { key, refs: 0, value: undefined, promise: null, timer: null, retired: false, disposed: false };
        const created = entry;
        entries.set(key, created);
        created.promise = Promise.resolve()
          .then(() => load(key, ...args))
          .then(
            (value) => {
              created.value = value;
              byValue.set(value, created);
              // Every acquirer released (or the entry was retired) while the
              // load was in flight.
              if (created.refs === 0) scheduleEvict(created);
              return value;
            },
            (error) => {
              if (entries.get(key) === created) entries.delete(key);
              created.disposed = true;
              throw error;
            },
          );
      }
      entry.refs++;
      if (entry.timer != null) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      return entry.promise;
    },

    /** Returns true when `value` was a cached value this call released. */
    release(value) {
      const entry = byValue.get(value);
      if (!entry || entry.refs <= 0) return false;
      entry.refs--;
      if (entry.refs === 0) {
        if (entry.retired) evict(entry);
        else scheduleEvict(entry);
      }
      return true;
    },

    /** Retires every live entry whose key satisfies `match` (all when omitted). */
    invalidate(match = null) {
      let retired = 0;
      for (const entry of [...entries.values()]) {
        if (match && !match(entry.key)) continue;
        entries.delete(entry.key);
        entry.retired = true;
        retired++;
        if (entry.refs === 0 && entry.value !== undefined) evict(entry);
      }
      return retired;
    },

    /** Disposes every unreferenced entry now instead of after the delay. */
    flush() {
      for (const entry of [...byValue.values()]) {
        if (entry.refs === 0) evict(entry);
      }
    },

    refsOf(value) {
      return byValue.get(value)?.refs ?? 0;
    },

    has(key) {
      return entries.has(key);
    },

    get size() {
      return entries.size;
    },
  };
}

/** Slash-normalised asset key; absolute and project-relative spellings differ. */
export function assetPathKey(path) {
  return String(path ?? "").replaceAll("\\", "/");
}

/**
 * Whether an invalidation for `changed` concerns cache key `key`. The editor
 * invalidates with whichever spelling it wrote (absolute, mixed slashes,
 * different case on Windows), so compare case-insensitively and accept a
 * path-segment suffix match in either direction.
 */
export function assetPathMatches(key, changed) {
  const a = assetPathKey(key).toLowerCase();
  const b = assetPathKey(changed).toLowerCase();
  if (!a || !b) return false;
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}
