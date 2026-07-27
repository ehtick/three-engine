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
import { useSceneStore } from "../../store/sceneStore.js";
import { useProjectStore } from "../../store/projectStore.js";
import { describeEntity } from "./entities.js";

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
  description: "Undo the last editor action.",
  params: {},
  run() {
    commandBus.undo();
    return { ...useHistoryStore.getState() };
  },
});

defineOp({
  name: "history.redo",
  description: "Redo the last undone editor action.",
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
