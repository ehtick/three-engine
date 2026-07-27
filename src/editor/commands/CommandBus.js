import { create } from "zustand";
import { engine } from "../engineInstance.js";
import { useSceneStore } from "../store/sceneStore.js";
import { useSelectionStore } from "../store/selectionStore.js";
import { usePrefabStore } from "../store/prefabStore.js";
import { vmSingleton } from "../singleton.js";

const MAX_HISTORY = 100;

/**
 * Every editor mutation goes through here so undo/redo history is reliable.
 * A command is { label, do(), undo() }; do() is called on execute and redo.
 */
class CommandBus {
  constructor() {
    this.undoStack = [];
    this.redoStack = [];
  }

  execute(command) {
    command.do();
    this.undoStack.push(command);
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack.length = 0;
    this.#afterMutation();
  }

  undo() {
    const command = this.undoStack.pop();
    if (!command) return;
    command.undo();
    this.redoStack.push(command);
    this.#afterMutation();
  }

  redo() {
    const command = this.redoStack.pop();
    if (!command) return;
    command.do();
    this.undoStack.push(command);
    this.#afterMutation();
  }

  clearHistory() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.#syncHistoryState();
  }

  #afterMutation() {
    useSceneStore.getState().refresh();
    useSceneStore.getState().markDirty();
    // In Prefab Mode the edit belongs to the staged prefab, not the scene.
    // (No-op when no prefab is staged.)
    usePrefabStore.getState().markStageDirty();
    useSelectionStore.getState().prune(new Set(engine.entities.keys()));
    this.#syncHistoryState();
  }

  #syncHistoryState() {
    useHistoryStore.setState({
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      undoLabel: this.undoStack.at(-1)?.label ?? null,
      redoLabel: this.redoStack.at(-1)?.label ?? null,
    });
  }
}

/** UI-facing mirror of history state (menu enablement). */
export const useHistoryStore = vmSingleton("historyStore", () =>
  create(() => ({
    canUndo: false,
    canRedo: false,
    undoLabel: null,
    redoLabel: null,
  })),
);

/**
 * VM-wide, not merely module-wide. A second CommandBus (from an HMR
 * re-evaluation, or Vite's `?t=` URL duplicate) splits the editor in half: the
 * newer bus mutates the engine and refreshes a store the mounted UI is not
 * watching, so edits land on disk but never on screen. See `singleton.js`.
 */
export const commandBus = vmSingleton("commandBus", () => new CommandBus());
