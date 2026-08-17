/**
 * Selection, undo history, play mode and scene I/O.
 *
 * These are the ops that answer "what is the user looking at, and what state is
 * the editor in" — the context any automated caller needs before it does
 * anything useful, and the context an in-editor tool script reads to act on the
 * current selection the way a hand-written editor extension would.
 */
import { defineOp } from "../registry.js";
import { engine } from "../../engineInstance.js";
import { commandBus, useHistoryStore } from "../../commands/CommandBus.js";
import { useSelectionStore } from "../../store/selectionStore.js";
import { matchTier, candidateFromLive } from "../../hierarchySearch.js";
import { useSceneStore } from "../../store/sceneStore.js";
import { useProjectStore } from "../../store/projectStore.js";
import { describeEntity } from "./entities.js";
import { stashReopenTarget } from "../../startupReopen.js";

// ---- selection --------------------------------------------------------------

defineOp({
  name: "selection.get",
  readOnly: true,
  description:
    "The current editor selection: entity ids (with descriptions) and any selected asset paths.",
  params: {},
  run() {
    const state = useSelectionStore.getState();
    return {
      entityIds: [...state.ids],
      entities: state.ids.map((id) => engine.getEntity(id)).filter(Boolean).map(describeEntity),
      assetPaths: [...state.assetPaths],
      assetPath: state.assetPath,
    };
  },
});

defineOp({
  name: "selection.set",
  description: "Replace the entity selection. Pass an empty array to clear it.",
  params: {
    ids: { type: "array", required: true, items: { type: "string" } },
  },
  run({ ids }) {
    // Filtering to live ids keeps the selection store's invariant (it holds
    // only existing entities) even when the caller works from a stale listing.
    const valid = ids.filter((id) => engine.getEntity(id));
    if (valid.length) useSelectionStore.getState().select(valid);
    else useSelectionStore.getState().clear();
    return { entityIds: valid };
  },
});

defineOp({
  name: "selection.selectMatching",
  description:
    "Select every entity matching a Hierarchy search query — the agent's version of 'search, then Ctrl+A'. Same ranking as the panel's filter box: entity name first, then component type, then tags; a `tag:` prefix searches tags only. Pair it with component.setProp to change one property on hundreds of entities. Returns ids, not full descriptions, because a scene-wide match can be thousands of entities.",
  params: {
    query: {
      type: "string",
      required: true,
      description:
        "What to match: a name fragment ('crate'), a component type ('mesh', 'light'), or 'tag:enemy' for tags only.",
    },
    mode: {
      type: "string",
      default: "replace",
      enum: ["replace", "add", "remove"],
      description:
        "replace the selection (default), add the matches to it, or remove the matches from it.",
    },
    limit: {
      type: "number",
      description: "Stop after this many matches (best-ranked first). Omit for all of them.",
    },
  },
  run({ query, mode, limit }) {
    const q = query.trim().toLowerCase();
    if (!q) throw new Error("selection.selectMatching: query is empty");

    // Ranked exactly like the panel, then flattened to ids. The tier survives
    // as far as the sort so `limit` keeps the BEST matches rather than
    // whichever ones the entity map happened to yield first.
    const ranked = [];
    for (const entity of engine.entities.values()) {
      const tier = matchTier(candidateFromLive(entity), q);
      if (tier !== Infinity) ranked.push({ id: entity.id, name: entity.name, tier });
    }
    ranked.sort((a, b) => a.tier - b.tier || a.name.localeCompare(b.name));
    const total = ranked.length;
    const ids = (Number.isFinite(limit) ? ranked.slice(0, Math.max(0, limit)) : ranked).map((m) => m.id);

    const selection = useSelectionStore.getState();
    if (mode === "add") selection.add(ids);
    else if (mode === "remove") selection.remove(ids);
    else if (ids.length) selection.select(ids);
    else selection.clear();

    return {
      matched: total,
      truncated: total > ids.length,
      entityIds: [...useSelectionStore.getState().ids],
    };
  },
});

defineOp({
  name: "selection.selectAssets",
  description: "Select one or more assets in the Assets panel by absolute path.",
  params: {
    paths: { type: "array", required: true, items: { type: "string" } },
  },
  run({ paths }) {
    useSelectionStore.getState().selectAssets(paths);
    return { assetPaths: paths };
  },
});

// ---- history ----------------------------------------------------------------

defineOp({
  name: "history.get",
  readOnly: true,
  description: "Undo/redo availability and the label of the next step in each direction.",
  params: {},
  run() {
    return { ...useHistoryStore.getState() };
  },
});

defineOp({
  name: "history.undo",
  description:
    "Undo the last editor action, whoever made it — an agent's edits and a person's share one stack. Call history.get first to see what would be undone.",
  params: {},
  run() {
    commandBus.undo();
    return { ...useHistoryStore.getState() };
  },
});

defineOp({
  name: "history.redo",
  description:
    "Redo the action most recently undone. Making any new edit clears the redo stack, exactly as it does for a person.",
  params: {},
  run() {
    commandBus.redo();
    return { ...useHistoryStore.getState() };
  },
});

// ---- play mode --------------------------------------------------------------

defineOp({
  name: "play.get",
  readOnly: true,
  description: "Whether the editor is currently in Play mode.",
  params: {},
  run() {
    return { playing: !!engine.playing };
  },
});

defineOp({
  name: "play.set",
  description:
    "Enter or leave Play mode. Entering snapshots the scene; leaving restores it, so edits made while playing are discarded exactly as they are for a human pressing Stop.",
  params: { playing: { type: "boolean", required: true } },
  async run({ playing }) {
    const mode = await import("../../playMode.js");
    if (playing) await mode.play();
    else await mode.stop();
    return { playing: !!engine.playing };
  },
});

// ---- scene / project --------------------------------------------------------

defineOp({
  name: "scene.get",
  readOnly: true,
  description: "The open scene: name, file path, unsaved-changes flag and root entity ids.",
  params: {},
  run() {
    const scene = useSceneStore.getState();
    return {
      name: scene.sceneName,
      path: scene.scenePath,
      dirty: scene.dirty,
      rootIds: [...scene.rootIds],
      entityCount: engine.entities.size,
    };
  },
});

defineOp({
  name: "scene.save",
  description: "Save the open scene. Prompts for a path if it has never been saved.",
  params: {},
  async run() {
    const { saveScene } = await import("../../sceneIO.js");
    await saveScene();
    return { path: useSceneStore.getState().scenePath };
  },
});

defineOp({
  name: "scene.open",
  description: "Open a .scene file, replacing the current scene. Unsaved changes are lost.",
  params: { path: { type: "string", required: true, description: "Absolute path to a .scene file." } },
  async run({ path }) {
    const { openScenePath } = await import("../../sceneIO.js");
    await openScenePath(path);
    return { path: useSceneStore.getState().scenePath };
  },
});

defineOp({
  name: "project.get",
  readOnly: true,
  description: "The open project: root folder, the folder the Assets panel is browsing, and project.json contents.",
  params: {},
  run() {
    const project = useProjectStore.getState();
    return {
      rootPath: project.rootPath,
      currentPath: project.currentPath,
      meta: { ...(project.projectMeta ?? {}) },
    };
  },
});

defineOp({
  name: "project.getSettings",
  readOnly: true,
  description:
    "The project's own settings (project.json `settings`), as the Project Settings panel shows them: editor behaviour and snapping, hot reload, pixel ratio cap, game title / save namespace, physics layers and the collision matrix. Scene look lives in scene.getSettings instead.",
  params: {},
  async run() {
    const { getProjectSettings } = await import("../../projectSettings.js");
    return { settings: structuredClone(getProjectSettings()) };
  },
});

defineOp({
  name: "project.setSettings",
  description:
    "Patch the project's settings and apply them live. Top-level sections are merged key-by-key, so pass only what you want to change — e.g. { editor: { watchProject: false }, scripts: { hotReload: false } }. Writes project.json; NOT undoable, these are preferences rather than scene edits. Call project.getSettings first to see the current shape.",
  params: {
    patch: {
      type: "object",
      required: true,
      description:
        "Any of: editor{autosaveSeconds,snapTranslate,snapRotateDeg,snapScale,gridSize,gridDivisions,showGrid,watchProject,keybindings}, scripts{hotReload,reloadIntervalMs}, rendering{pixelRatioCap}, game{title,saveId,saveVersion}, physics{layers,matrix}. Sections are merged, so one key does not wipe its siblings.",
    },
  },
  async run({ patch }) {
    const { getProjectSettings, saveProjectSettings } = await import("../../projectSettings.js");
    const current = getProjectSettings();
    const next = { ...current };
    for (const [section, values] of Object.entries(patch ?? {})) {
      if (!(section in current)) throw new Error(`Unknown settings section "${section}"`);
      // Merged rather than replaced: an agent setting one knob must not silently
      // reset the ten it did not mention.
      next[section] =
        values && typeof values === "object" && !Array.isArray(values)
          ? { ...current[section], ...values }
          : values;
    }
    await saveProjectSettings(next);
    return { settings: structuredClone(next) };
  },
});

// ---- the editor process itself ----------------------------------------------

/**
 * One-shot handoff across `editor.reload`: the project to reopen once the page
 * comes back. sessionStorage, not localStorage — this must NOT survive the
 * person closing the window, or a deliberate "close project" would be undone
 * by the next launch.
 */
/**
 * Reloading the page is the ONLY way to pick up an engine source change that
 * HMR cannot apply, and there are several: an op's `run` body (defineOp
 * fingerprints on description + params, so an identical fingerprint is treated
 * as a harmless re-evaluation and the OLD implementation is kept), anything
 * installed once behind a `backend.__*` guard, and any module that hangs state
 * off a `Symbol.for` singleton. Without this op the loop is "ask the person to
 * press Ctrl+R and wait", which for iterating on an instrument is most of the
 * wall clock.
 *
 * ⚠ IT DROPS THE MCP CONNECTION. The bridge is a WebSocket owned by the page,
 * so the reload closes it and the editor re-dials with backoff (1s → 15s). The
 * op answers BEFORE reloading — a reply written after `location.reload()` has
 * nowhere to go — so a caller sees success and must then wait for
 * `editor.status` to report connected again rather than assuming the next tool
 * call will land.
 */
defineOp({
  name: "editor.reload",
  description:
    "Reload the editor page, the same as pressing Ctrl+R. Needed to pick up engine source changes that hot reload cannot apply — an op's implementation body, anything installed once per renderer backend, or module state behind a VM singleton. Reopens the SAME project and the SAME scene afterwards (reported as reopeningProject/reopeningScene), so you resume exactly where you were rather than on whatever project.json's lastScene happens to name. The scene is reloaded from disk, so SAVE FIRST: unsaved edits are lost exactly as they would be on a manual reload. Drops the MCP connection for a few seconds while the page re-dials; poll editor.status until it reports connected before making further calls.",
  params: {
    delayMs: {
      type: "number",
      default: 150,
      description:
        "How long to wait before reloading, in ms. The default gives this op's own reply time to reach the caller; raising it is only useful if something else still has to flush.",
    },
  },
  run({ delayMs = 150 }) {
    const wait = Math.max(0, Math.min(5000, Math.round(delayMs)));
    const scene = useSceneStore.getState();
    // A reload now reopens the last project on its own (`startupReopen.js`),
    // so the stash below is not what rescues this op from the project hub any
    // more — it is what makes the reload land on the EXACT scene rather than on
    // whatever `project.json.lastScene` names.
    //
    // The consuming hook lives in `startupReopen.js`, imported by `main.jsx`,
    // NOT in this file. It used to be here, beside the writer, which reads well
    // and could never work: this module is only reached through
    // `installEditorApi()`, which `engineInstance.js` imports from inside
    // `loadEngine()` — so on a boot with no project open, the module holding
    // the reopen hook was never imported at all. That is the only boot the hook
    // is ever needed on.
    const root = useProjectStore.getState().rootPath;
    // The SCENE too. `project.json.lastScene` is only whatever was open when
    // the project was last opened, so without this a reload quietly relocates
    // the session.
    const scenePath = scene.scenePath ?? null;
    stashReopenTarget(root, scenePath);
    // Reported rather than auto-saved: silently writing a user's scene because
    // an agent wanted a reload is a bigger surprise than losing the edits they
    // can see are unsaved, and the caller can save first if it matters.
    const dirty = !!scene.dirty;
    setTimeout(() => {
      globalThis.location?.reload?.();
    }, wait);
    return {
      reloading: true,
      inMs: wait,
      hadUnsavedChanges: dirty,
      reopeningProject: root ?? null,
      reopeningScene: scenePath,
      note: dirty
        ? "The scene had UNSAVED changes and they are being discarded — call scene.save before editor.reload if that was not intended."
        : "Poll editor.status until it reports connected; the page reopens this project AND this scene, so you resume where you left off.",
    };
  },
});
