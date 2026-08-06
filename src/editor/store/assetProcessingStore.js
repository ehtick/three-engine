import { create } from "zustand";
import { vmSingleton } from "../singleton.js";

/**
 * Tracks long-running asset processing tasks (GLB/FBX unpack, Draco
 * compression, Basis texture compression, OS file imports, library imports
 * from Poly Haven / AmbientCG / Sketchfab). Each entry is a short,
 * user-visible label like "Unpacking lantern.glb" or "Compressing texture".
 *
 * UI components (the menu-bar indicator) subscribe to this so the user gets
 * immediate feedback that work is happening — without it, a 200 MB GLB
 * unpack can look frozen for several seconds with no visual cue.
 */

// VM-wide alongside the store: two copies with private counters would issue the
// same job handle twice, and `end(handle)` would clear the wrong job.
const ids = vmSingleton("assetProcessingIds", () => ({ next: 0 }));

export const useAssetProcessingStore = vmSingleton("assetProcessingStore", () => create((set, get) => ({
  jobs: new Map(),

  /** Number of in-flight jobs. */
  get activeCount() {
    return get().jobs.size;
  },

  /** Snapshot of in-flight jobs as an array, sorted by start time. */
  get activeJobs() {
    return [...get().jobs.values()].sort((a, b) => a.startedAt - b.startedAt);
  },

  /**
   * Registers a job and returns an opaque handle. The caller MUST pass the
   * handle to `end(handle)` when the work finishes (success or failure) so
   * the indicator clears. Wrapping a function via `track(label, fn)` is the
   * recommended path — it ties registration and cleanup to a single promise.
   */
  begin(label) {
    const id = ++ids.next;
    const entry = { id, label, startedAt: performance.now() };
    set((state) => {
      const next = new Map(state.jobs);
      next.set(id, entry);
      return { jobs: next };
    });
    return id;
  },

  end(id) {
    if (id == null) return;
    set((state) => {
      if (!state.jobs.has(id)) return state;
      const next = new Map(state.jobs);
      next.delete(id);
      return { jobs: next };
    });
  },

  /**
   * Runs `fn` while exposing it on the indicator. The label can be a string
   * or a function of the arguments, so callers can include the file name.
   * Errors don't leave a stuck indicator — `end` runs in `finally`.
   */
  async track(label, fn, ...args) {
    const id = get().begin(typeof label === "function" ? label(...args) : label);
    try {
      return await fn(...args);
    } finally {
      get().end(id);
    }
  },
})));