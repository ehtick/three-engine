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

  /**
   * Marks a point on the undo stack, to later collapse everything pushed
   * since it into one labelled entry with {@link collapseFrom}. Call this
   * before starting a multi-step operation whose individual steps each push
   * their own command (they still should — a partial failure must still be
   * a real, undoable prefix of what happened).
   */
  markGroup() {
    return this.undoStack.length;
  }

  /**
   * Replaces every entry pushed since `mark` with one entry that does/undoes
   * them as a group, newest-first on undo. Two callers: the `batch` op
   * (`ops/batch.js`, many ops in one MCP round trip) and an AI workflow run
   * (`store/aiStore.js`, many tool calls across a multi-turn agent session) —
   * both want "many mutations, one Ctrl+Z, one label in the Edit menu"
   * instead of making the user press undo once per step or guess when to
   * stop. No-ops (keeps the single inner entry's own label, which is more
   * specific than a group label would be) when zero or one entries were
   * pushed — a run that made one change, or none, has nothing to collapse.
   * Returns how many entries were collapsed.
   */
  collapseFrom(mark, label) {
    const taken = this.undoStack.splice(mark, this.undoStack.length - mark);
    if (taken.length <= 1) {
      this.undoStack.push(...taken);
      return taken.length;
    }
    this.undoStack.push({
      label,
      do: () => {
        for (const command of taken) command.do();
      },
      undo: () => {
        for (let i = taken.length - 1; i >= 0; i--) taken[i].undo();
      },
    });
    // The stack was rewritten directly, so the UI's mirror is stale — it
    // would still offer "Undo <last inner step>", telling the user the wrong
    // thing about what Ctrl+Z does.
    this.#syncHistoryState();
    return taken.length;
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
