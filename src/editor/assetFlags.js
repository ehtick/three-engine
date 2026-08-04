import { create } from "zustand";
import { invoke } from "./assetOps.js";
import { readAssetMeta } from "./assetLoader.js";
import { assetCatalog } from "../engine/assets/catalog.js";

/**
 * Per-asset build flags, stored in the asset's existing `.meta` sidecar under
 * a `build` key so they travel with the file through renames and moves (which
 * already carry `.meta` along).
 *
 *   exclude — keep the file in the project, but never ship it in a game build.
 *             Work-in-progress art, reference images, source .psd-alikes.
 *   preload — load during the boot/preload phase so the asset is resident
 *             before the first frame instead of streaming in mid-play.
 *
 * The two are mutually exclusive: an excluded asset isn't in the build at all,
 * so there is nothing to preload. Setting one clears the other.
 *
 * Anything neither excluded nor preloaded is loaded on demand, when the scene
 * first references it. That's the default and the right choice for most assets.
 */

export const ASSET_FLAG_DEFAULTS = { preload: false, exclude: false, tags: [] };

/**
 * Reactive mirror of the flags for the assets currently on screen. Tiles read
 * from here (synchronously, during render) while the actual `.meta` reads and
 * writes happen through the async helpers below.
 */
export const useAssetFlagsStore = create((set) => ({
  flags: {}, // path -> { preload, exclude }
  merge: (entries) =>
    set((state) => {
      // Every flags read/write (a project-wide scan, an Inspector tag edit)
      // funnels through here — the one place that keeps `engine.assets`'
      // name/tag catalog in step with `.meta`, without a separate scan pass.
      for (const [path, flags] of Object.entries(entries)) {
        assetCatalog.register({ path, tags: flags.tags });
      }
      return { flags: { ...state.flags, ...entries } };
    }),
}));

export function getAssetFlags(path) {
  return useAssetFlagsStore.getState().flags[path] ?? ASSET_FLAG_DEFAULTS;
}

/** True when this asset carries any non-default build flag. */
export function hasAssetFlags(path) {
  const flags = getAssetFlags(path);
  return !!(flags.preload || flags.exclude);
}

/** Every distinct asset tag currently loaded — powers editor autocomplete. */
export function allAssetTags() {
  const tags = new Set();
  for (const entry of Object.values(useAssetFlagsStore.getState().flags)) {
    for (const tag of entry.tags ?? []) tags.add(tag);
  }
  return [...tags].sort();
}

const normalizeFlags = (meta) => ({
  preload: meta?.build?.preload === true,
  exclude: meta?.build?.exclude === true,
  // Tags sit at the top level of the sidecar, not under `build` — they
  // describe the asset, not how it ships.
  tags: Array.isArray(meta?.tags) ? [...meta.tags] : [],
});

/**
 * Populates the store from a directory listing.
 *
 * `entries` must be the RAW listing, sidecars included — the `.meta` files in
 * it are what tells us which assets are worth reading. Only those get an IPC
 * round-trip; a folder of 300 untouched textures costs zero reads instead of
 * 300 to learn that every one of them is on defaults. Pass a listing that has
 * already had `.meta` filtered out and nothing will ever be read.
 */
export async function loadAssetFlags(entries) {
  const metaNames = new Set(
    entries.filter((entry) => entry.name.endsWith(".meta")).map((entry) => entry.name),
  );
  const assets = entries.filter((entry) => !entry.is_dir && !entry.name.endsWith(".meta"));
  const patch = {};
  // Assets we can see have no sidecar are known to be on defaults. Recording
  // that (rather than leaving them absent) is what lets a flag *removal* show
  // up in the UI — the sidecar may have been deleted since we last looked.
  for (const entry of assets) {
    if (!metaNames.has(`${entry.name}.meta`)) patch[entry.path] = ASSET_FLAG_DEFAULTS;
  }
  await Promise.all(
    assets
      .filter((entry) => metaNames.has(`${entry.name}.meta`))
      .map(async (entry) => {
        patch[entry.path] = normalizeFlags(await readAssetMeta(`${entry.path}.meta`));
      }),
  );
  if (Object.keys(patch).length) useAssetFlagsStore.getState().merge(patch);
}

/**
 * Writes `patch` into each path's `.meta`, creating the sidecar when absent.
 * `preload` / `exclude` land in the `build` block; `tags` at the top level.
 * Returns the number of assets actually changed.
 */
export async function setAssetFlags(paths, patch) {
  const updates = {};
  let changed = 0;
  for (const path of paths) {
    const meta = (await readAssetMeta(`${path}.meta`)) ?? {};
    const current = normalizeFlags(meta);
    const build = {
      preload: patch.preload ?? current.preload,
      exclude: patch.exclude ?? current.exclude,
    };
    // Mutually exclusive — the flag the user just set wins.
    if (patch.exclude === true) build.preload = false;
    if (patch.preload === true) build.exclude = false;
    const tags = patch.tags ? [...new Set(patch.tags)].sort() : current.tags;
    const next = { ...meta, build };
    if (tags.length) next.tags = tags;
    else delete next.tags;
    try {
      await invoke("save_scene", { path: `${path}.meta`, contents: JSON.stringify(next, null, 2) });
      updates[path] = { ...build, tags };
      changed++;
    } catch (err) {
      console.error(`Couldn't update asset settings for ${path}: ${err}`);
    }
  }
  if (changed) {
    useAssetFlagsStore.getState().merge(updates);
    // A new `.meta` may have appeared — keep the folder listing honest so the
    // next flag read finds the sidecar it just wrote.
    const { useProjectStore } = await import("./store/projectStore.js");
    await useProjectStore.getState().refresh();
  }
  return changed;
}

/** One-off read for code paths outside the store (the exporter). */
export async function readAssetFlags(path) {
  return normalizeFlags(await readAssetMeta(`${path}.meta`));
}
