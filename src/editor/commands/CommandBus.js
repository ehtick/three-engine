import { create } from "zustand";
import { engine } from "../engineInstance.js";
import { useSceneStore, sceneMirrorStats } from "../store/sceneStore.js";
import { useSelectionStore } from "../store/selectionStore.js";
import { usePrefabStore } from "../store/prefabStore.js";
import { vmSingleton } from "../singleton.js";

const MAX_HISTORY = 100;

/** Snapshot of how many times the mirror has been re-read. See #afterMutation. */
const mirrorMark = () => ({ full: sceneMirrorStats.full, incremental: sceneMirrorStats.incremental });

/**
 * Every editor mutation goes through here so undo/redo history is reliable.
 * A command is { label, do(), undo() }; do() is called on execute and redo.
 */
class CommandBus {
  constructor() {
    this.undoStack = [];
    this.redoStack = [];
    /** The open drag transaction, or null. See beginPreview. */
    this._preview = null;
  }

  execute(command) {
    // ── A DRAG IS A PREVIEW ───────────────────────────────────────────────
    // Inside a transaction the command RUNS (so the viewport shows the value
    // under the cursor) but is not pushed: the undo entry is synthesised once
    // on release, from the first command's `undo` — which captured the
    // pre-drag value — and the last command's `do`.
    if (this._preview) {
      command.do();
      this._preview.first ??= command;
      this._preview.last = command;
      // THE VIEWPORT WOULD OTHERWISE SLEEP THROUGH THE DRAG. `editorFramePacing`
      // suspends the render loop when the viewport is not focused (it is not —
      // the inspector is) and wakes it on every history-store publish, on the
      // documented ground that "EVERY scene mutation goes through the command
      // bus … each one refreshes the history store". A preview IS a scene
      // mutation through this bus, so it keeps that contract even though the
      // stack itself has not moved.
      this.#syncHistoryState();
      return;
    }
    const mark = mirrorMark();
    command.do();
    this.undoStack.push(command);
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack.length = 0;
    this.#afterMutation(mark);
  }

  undo() {
    const command = this.undoStack.pop();
    if (!command) return;
    const mark = mirrorMark();
    command.undo();
    this.redoStack.push(command);
    this.#afterMutation(mark);
  }

  redo() {
    const command = this.redoStack.pop();
    if (!command) return;
    const mark = mirrorMark();
    command.do();
    this.undoStack.push(command);
    this.#afterMutation(mark);
  }

  /**
   * ── DRAG = PREVIEW, RELEASE = COMMIT (2026-09-07, ZERO_FREEZE_PLAN §1.3) ──
   *
   * THE FAILURE: a NumberField scrub called `onCommit` on EVERY pointermove,
   * and each one was a full undoable command plus the whole edit fan-out, in
   * its own macrotask, so nothing coalesced — a one-second drag left ~100
   * entries in the undo stack and ran the scene-walking listeners ~100 times.
   *
   * Between `beginPreview()` and `endPreview()` every `execute` still applies
   * its command (the viewport must show the drag) but pushes nothing, and the
   * mirror is kept live by "component-changed" alone. `endPreview` pushes ONE
   * entry whose undo is the FIRST command's undo — the value the drag started
   * from. Callers that never reach `execute` (a field that writes an asset
   * rather than a component) simply produce no entry.
   *
   * Re-entrancy: a second `beginPreview` closes the first. Pointer capture
   * makes two simultaneous scrubs impossible, but a `pointercancel` that never
   * reached `endPreview` must not strand the transaction forever.
   */
  beginPreview(label) {
    if (this._preview) this.endPreview();
    this._preview = { label: label ?? null, first: null, last: null };
  }

  /** True while a drag transaction is open (a field asking "am I previewing"). */
  get previewing() {
    return this._preview !== null;
  }

  /** Closes the transaction and pushes its single undo entry. Returns 1 if it pushed. */
  endPreview() {
    const preview = this._preview;
    this._preview = null;
    if (!preview?.first) return 0;
    const { first, last } = preview;
    this.undoStack.push({
      label: preview.label ?? last.label ?? first.label,
      // Redo replays the first command too when the drag's opening step did
      // MORE than the rest — the inspector pairs the first write of a GI
      // advanced field with a `flipsToCustom` preset flip, and only that step.
      do: () => {
        if (first !== last) first.do();
        last.do();
      },
      undo: () => first.undo(),
    });
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack.length = 0;
    this.#afterMutation();
    return 1;
  }

  /** Abandons the transaction and puts the value back where the drag started. */
  cancelPreview() {
    const preview = this._preview;
    this._preview = null;
    if (!preview?.first) return;
    preview.first.undo();
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

  /**
   * ── ONE MIRROR REBUILD PER EDIT, NOT TWO (ZERO_FREEZE_PLAN §1.2) ─────────
   *
   * This used to call `refresh()` outright, and the "hierarchy-changed"
   * listener called it AGAIN a microtask later: every edit rebuilt the mirror
   * of every entity twice, each time with fresh object identities, so every
   * Hierarchy row re-rendered twice for one light-intensity change.
   *
   * Now the refresh is DEFERRED one microtask and skipped if the mirror is
   * already fresh. The ordering is what makes that safe and needs no reach
   * into the engine: `command.do()` emits first, so the coalesced
   * "hierarchy-changed" microtask is queued BEFORE this one and its full
   * refresh has already run (and bumped `full`) by the time this check reads
   * the counters. A value edit bumps `incremental` instead, synchronously,
   * inside `do()`. A command that emits nothing at all (rename, tags) moves
   * neither counter and still gets its full refresh here — which is why this
   * is a counter check and not a list of command types.
   *
   * `globalThis.__editorMirrorRefreshOnce = false` restores the unconditional
   * refresh for a one-boot A/B.
   */
  #afterMutation(mark = null) {
    // A procedural authoring owner may reconcile dependent products once a
    // command/drag commits. Preview steps intentionally never reach this seam.
    engine.emit('authoring-committed');
    if (mark && globalThis.__editorMirrorRefreshOnce !== false) {
      queueMicrotask(() => {
        if (sceneMirrorStats.full !== mark.full || sceneMirrorStats.incremental !== mark.incremental) return;
        useSceneStore.getState().refresh();
      });
    } else {
      useSceneStore.getState().refresh();
    }
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
