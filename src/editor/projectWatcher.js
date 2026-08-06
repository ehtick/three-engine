// @ts-check
/**
 * Makes changes written to the project by anything other than the editor show
 * up without a restart.
 *
 * ## The gap this closes
 *
 * Everything the editor knows about the project on disk it read once and
 * cached: the Assets panel's directory listing, `assetLoader`'s path -> blob URL
 * map, the engine's decoded geometry / material / atlas / audio caches. None of
 * them can notice that the bytes changed. In-editor edits are fine, because the
 * code that writes also invalidates — but a file written by an AI agent using
 * its own file tools, by an IDE, by a paint program, or by a `git checkout`
 * simply never appeared. Restarting the editor "fixed" it, which is what made
 * this read as a broken feature rather than a missing one.
 *
 * The Rust side (`src-tauri/src/watcher.rs`) does the watching and filters out
 * the editor's own writes, so everything arriving here is genuinely external.
 *
 * ## Two policies, because assets and the open scene are not the same thing
 *
 * An asset on disk is the source of truth — the editor is only ever showing a
 * cached copy of it, so re-reading is always right. The open SCENE is the
 * opposite: the authoritative copy is the one in memory, with the user's
 * unsaved edits in it. Reloading that automatically would delete their work to
 * show them someone else's version. So a changed scene file reloads only when
 * the editor has nothing unsaved; otherwise it says so and leaves the decision
 * to the user.
 */
import { invalidateBlobUrl, extOf, TEXTURE_EXTENSIONS, AUDIO_EXTENSIONS } from "./assetLoader.js";
import { useProjectStore } from "./store/projectStore.js";
import { useSceneStore } from "./store/sceneStore.js";
import { currentScenePath } from "./sceneIO.js";
import { pushToast } from "./toasts.js";
import { vmSingleton } from "./singleton.js";

/**
 * Coalescing window for a burst of changes.
 *
 * A single logical save is several filesystem events (write, rename, `.meta`
 * sidecar) and a tool copying a folder is hundreds. Reacting per event would
 * re-list the project directory once per file; batching turns a 300-file import
 * into one refresh. Kept short enough to feel immediate.
 */
const COALESCE_MS = 180;

const state = vmSingleton("projectWatcher", () => ({
  /** @type {(() => void) | null} */ unlisten: null,
  /** @type {string | null} */ root: null,
  /** @type {ReturnType<typeof setTimeout> | null} */ timer: null,
  /** @type {Set<string>} */ pending: new Set(),
  /** Test seam: set by `__deliverProjectChanges` so a harness can drive the
   *  same handler the Tauri event drives, with no Tauri and no filesystem. */
  started: false,
}));

const norm = (p) => String(p ?? "").replaceAll("\\", "/");

/**
 * Drops every cached copy of `path` and reloads whatever kind of asset it is.
 *
 * Exported because the watcher is not the only source of "these bytes changed
 * behind your back": `asset.write` (the MCP tool an agent uses to author a
 * material or a scene) is a write the editor made *without* going through the
 * code that owns that asset type, so it has exactly the same problem.
 */
export async function refreshAssetFromDisk(path) {
  const ext = extOf(path);
  // Always first: every cache downstream keys on the path, and this is what
  // drops the stale URL *and* notifies the listeners hanging off it (the
  // engine's geometry cache, the Assets panel's thumbnails, and the frame
  // pacer — which is what makes a suspended viewport draw the new bytes).
  invalidateBlobUrl(path);

  try {
    if (ext === "mat") {
      const { reloadMaterialAsset } = await import("../engine/materialAsset.js");
      await reloadMaterialAsset(path);
      return;
    }
    if (TEXTURE_EXTENSIONS.includes(ext) || ext === "ktx2" || ext === "basis") {
      // A texture is not owned by anything on its own — it is reached through
      // the materials that reference it, which have to rebuild their node
      // graphs to pick up a new image.
      const { refreshMaterialsUsingTexture } = await import("../engine/materialAsset.js");
      refreshMaterialsUsingTexture(path);
      return;
    }
    if (ext === "atlas") {
      const { invalidateAtlasAsset } = await import("../engine/sprite/atlasAsset.js");
      invalidateAtlasAsset(path);
      return;
    }
    if (AUDIO_EXTENSIONS.includes(ext)) {
      const { disposeAudioAsset } = await import("../engine/audio/AudioAsset.js");
      disposeAudioAsset(path);
      return;
    }
    // Scripts (.ts/.js) need nothing here: the script runtime polls mtime on
    // its own hot-reload interval and is already the mechanism for this.
  } catch (err) {
    console.warn(`Couldn't reload "${path}" after an external change: ${err?.message ?? err}`);
  }
}

/** Handles one coalesced batch of externally-changed paths. */
async function flush() {
  state.timer = null;
  const paths = [...state.pending];
  state.pending.clear();
  if (!paths.length) return;

  const scenePath = norm(currentScenePath());
  let sceneChanged = false;

  for (const path of paths) {
    if (scenePath && norm(path).toLowerCase() === scenePath.toLowerCase()) {
      sceneChanged = true;
      continue;
    }
    await refreshAssetFromDisk(path);
  }

  // One listing for the whole batch, not one per file.
  await useProjectStore.getState().refresh().catch(() => {});

  if (sceneChanged) await handleSceneFileChanged(scenePath);
}

async function handleSceneFileChanged(scenePath) {
  const name = scenePath.split("/").pop();
  if (useSceneStore.getState().dirty) {
    // Never silently discard unsaved work. Reopening the scene is one click
    // away in the Assets panel and is the user's call, not ours.
    pushToast({
      level: "warn",
      key: "scene-changed-on-disk",
      title: `${name} changed on disk`,
      detail: "You have unsaved edits, so it was not reloaded. Reopen the scene to take the version on disk.",
    });
    return;
  }
  const { openScenePath } = await import("./sceneIO.js");
  await openScenePath(scenePath);
  pushToast({ level: "info", key: "scene-changed-on-disk", title: `Reloaded ${name}`, detail: "It changed on disk." });
}

/** Queues externally-changed paths. Exported for the harnesses. */
export function noteExternalChanges(paths) {
  for (const path of paths) state.pending.add(norm(path));
  if (state.timer) return;
  state.timer = setTimeout(() => {
    flush().catch((err) => console.warn(`Project watcher: ${err?.message ?? err}`));
  }, COALESCE_MS);
}

/**
 * Starts (or re-points) the watcher at the open project. Safe to call on every
 * project open — the Rust side no-ops when the root is unchanged, and the
 * listener is only attached once per VM.
 *
 * Outside Tauri (a browser harness, the exported player) there is nothing to
 * watch, so this resolves to false rather than throwing: the editor still works,
 * it just cannot see changes it did not make.
 */
export async function startProjectWatcher(root = useProjectStore.getState().rootPath) {
  if (!root) return false;
  let invoke;
  let listen;
  try {
    ({ invoke } = await import("@tauri-apps/api/core"));
    ({ listen } = await import("@tauri-apps/api/event"));
  } catch {
    return false;
  }

  if (!state.started) {
    state.started = true;
    // The event carries a batch already (one notify event can name several
    // paths); `noteExternalChanges` coalesces across batches on top of that.
    state.unlisten = await listen("project-files-changed", (event) => {
      const changes = /** @type {Array<{ path: string }>} */ (event.payload ?? []);
      noteExternalChanges(changes.map((change) => change.path));
    });
  }

  try {
    await invoke("watch_project", { path: norm(root) });
    state.root = norm(root);
    return true;
  } catch (err) {
    console.warn(`Couldn't watch the project folder: ${err}`);
    return false;
  }
}

/** Stops watching. The listener stays attached — re-opening a project is the
 *  common case and re-registering it every time would leak handlers. */
export async function stopProjectWatcher() {
  state.root = null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("unwatch_project");
  } catch {
    // No Tauri, or nothing was watching.
  }
}

/** The folder currently being watched, or null. For the API/status surfaces. */
export function watchedProjectRoot() {
  return state.root;
}
