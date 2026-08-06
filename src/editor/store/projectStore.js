import { create } from "zustand";
import { vmSingleton } from "../singleton.js";
import { scaffoldProjectTypes } from "../projectTypes.js";

const ROOT_KEY = "engine.projectRoot.v1";

function basename(path) {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * Tracks the open project folder and the directory currently browsed in the
 * Assets panel. The three.js scene has no concept of a "project" beyond
 * asset file paths, so this is purely editor-side bookkeeping.
 */
const RECENT_KEY = "engine.recentProjects.v1";

function loadRecent() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY)) ?? [];
  } catch {
    return [];
  }
}

export const useProjectStore = vmSingleton("projectStore", () => create((set, get) => ({
  rootPath: null,
  currentPath: null,
  entries: [],
  loading: false,
  error: null,
  recent: loadRecent(),
  hubSkipped: false,
  // Monotonic counter bumped every time the project tree's contents change
  // anywhere on disk (delete/rename/move/create inside the project, even on
  // paths the user isn't currently browsing in the grid). The folder tree
  // listens to this so it re-lists cached sub-folders when, e.g., a sibling
  // folder is deleted — otherwise a row for a now-deleted folder can stay
  // visible in the tree until the user navigates and triggers a fresh
  // `list_dir`.
  changeCounter: 0,

  skipHub() {
    set({ hubSkipped: true });
  },

  /**
   * Closes the active project and returns the user to the project hub.
   * The engine + scene-side state are reset, the last-opened path is
   * forgotten so the next launch starts at the hub, and `hubSkipped` is
   * cleared so even a projectless "Skip" session can return to the hub.
   */
  async closeProject() {
    localStorage.removeItem(ROOT_KEY);
    const { resetEditorScene } = await import("../sceneIO.js");
    await resetEditorScene().catch((err) =>
      console.warn(`Couldn't reset editor scene on close project: ${err}`),
    );
    set({ rootPath: null, currentPath: null, projectMeta: {}, hubSkipped: false });
  },

  projectMeta: {}, // contents of <root>/project.json (lastScene, name, …)

  /** Opens a known project folder and records it in the recent list. */
  async openProject(path) {
    const previousRoot = get().rootPath;
    localStorage.setItem(ROOT_KEY, path);
    const recent = [path, ...get().recent.filter((p) => p !== path)].slice(0, 8);
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
    const { invoke } = await import("@tauri-apps/api/core");
    let projectMeta = {};
    try {
      projectMeta = JSON.parse(await invoke("load_scene", { path: `${path}/project.json` }));
    } catch {
      // Not a project created by the hub (or unreadable) — treat as empty meta.
    }
    set({ rootPath: path, recent, projectMeta });

    // Project switch: the engine is a session-level singleton, so without
    // this it would keep entities/components loaded from the previous
    // project. Wipe the scene + reset the boot flag so EditorChrome
    // re-bootstraps from the new project's project.json. The first call
    // (no previous project) is also fine — clearing an empty engine is a
    // no-op beyond resetting `currentPath`/`sceneBooted`.
    if (previousRoot !== path) {
      const { resetEditorScene } = await import("../sceneIO.js");
      await resetEditorScene().catch((err) =>
        console.warn(`Couldn't reset editor scene for new project: ${err}`),
      );
    }
    // Make sure the engine's TS typings are present so the user's IDE
    // provides `this.entity` / `this.engine` autocomplete when they open
    // a script. Idempotent — safe to call on every open.
    scaffoldProjectTypes(path).catch((err) => {
      console.warn(`Could not scaffold engine types into ${path}: ${err}`);
    });
    await get().navigate(path);
    // Watch the folder so files written by anything other than the editor — an
    // agent's own file tools, an IDE, a paint program — appear without a
    // restart. Dynamically imported to keep the import cycle (the watcher reads
    // this store) from existing at module scope, and never fatal: a project
    // without a watcher is the editor as it behaved before, not a broken one.
    import("../projectWatcher.js")
      .then((m) => m.startProjectWatcher(path))
      .catch((err) => console.warn(`Project watcher unavailable: ${err}`));
    // The assistant guide is normally written when an assistant connects — but
    // a connection that is ALREADY up when a project opens would otherwise never
    // trigger it, and switching projects mid-conversation is an ordinary thing
    // to do. Only when connected, so the "never used an assistant" case still
    // gets a clean folder.
    import("../api/mcpBridge.js")
      .then(async ({ useMcpStore }) => {
        if (useMcpStore.getState().status !== "connected") return;
        const { ensureAgentGuide } = await import("../agentGuide.js");
        await ensureAgentGuide(path);
      })
      .catch(() => {});
    return true;
  },

  /** Merges a patch into project.json on disk (source of truth for lastScene etc.). */
  async updateMeta(patch) {
    const { rootPath, projectMeta } = get();
    if (!rootPath) return;
    const next = { ...projectMeta, ...patch };
    set({ projectMeta: next });
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("save_scene", {
      path: `${rootPath}/project.json`,
      contents: JSON.stringify(next, null, 2),
    });
  },

  async openFolder() {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const path = await open({ directory: true });
    if (!path) return false;
    return get().openProject(path);
  },

  /** Picks a folder, writes a project.json marker, and opens it. */
  async createProject() {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const path = await open({ directory: true, title: "Select a folder for the new project" });
    if (!path) return false;
    const { invoke } = await import("@tauri-apps/api/core");
    const marker = JSON.stringify({ name: basename(path), version: 1 }, null, 2);
    await invoke("save_scene", { path: `${path}/project.json`, contents: marker });
    return get().openProject(path);
  },

  async restoreLastFolder() {
    const saved = localStorage.getItem(ROOT_KEY);
    if (!saved) return;
    await get().openProject(saved);
  },

  async navigate(path) {
    set({ loading: true, error: null });
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const entries = await invoke("list_dir", { path });
      set({ currentPath: path, entries, loading: false });
    } catch (err) {
      set({ error: String(err), loading: false });
    }
  },

  async refresh() {
    const { currentPath } = get();
    // Always bump so the tree can re-list its cached children, even when the
    // current grid view is unaffected by the change (deleting a sibling
    // folder while browsing a different folder, etc.).
    set({ changeCounter: get().changeCounter + 1 });
    if (currentPath) await get().navigate(currentPath);
  },

  goUp() {
    const { rootPath, currentPath } = get();
    if (!currentPath || currentPath === rootPath) return;
    const parent = currentPath.replace(/[\\/][^\\/]+$/, "");
    get().navigate(parent || rootPath);
  },

  /**
   * Drops a path from the recent list. This is purely a UI-bookkeeping
   * operation: the project folder on disk is left untouched, so the user
   * can still find it via "Open Project". Used by the Project Hub's
   * remove button on each recent row.
   */
  removeRecent(path) {
    const recent = get().recent.filter((p) => p !== path);
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
    // If the dropped entry is the currently-open project, also clear the
    // "last opened" hint so a future launch doesn't auto-restore it.
    if (localStorage.getItem(ROOT_KEY) === path) {
      localStorage.removeItem(ROOT_KEY);
    }
    set({ recent });
  },
})));

export { basename };
