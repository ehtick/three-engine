/**
 * Undo/redo for a node-graph editor.
 *
 * Deliberately LOCAL to the editor rather than routed through the scene-level
 * `commandBus` (src/editor/commands/CommandBus.js). That bus is entity-level
 * and calls `sceneStore.refresh()` after every entry; pushing a graph edit per
 * keystroke or per drag frame through it would flood the global history and
 * re-render the whole editor. Graph *commits* still go through the command bus
 * (the particle panel's `SetComponentPropCommand`), so an applied effect is
 * still undoable at scene level — this is the finer-grained layer underneath.
 *
 * Snapshot-based, not diff-based: a graph is a few hundred small plain objects,
 * so a structural copy costs nothing next to the React Flow re-render that
 * follows it, and snapshots can't drift out of sync the way inverse-op diffs do.
 */

const MAX_ENTRIES = 100;

/** Structural copy of the parts of a flow graph we restore. React Flow adds
 *  transient fields (measured, dragging, selected, and the handler callbacks
 *  the panel injects); none of them belong in history. */
function snapshot(nodes, edges) {
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.type,
      position: { ...n.position },
      data: { nodeType: n.data.nodeType, props: { ...n.data.props } },
      ...(n.parentId ? { parentId: n.parentId } : {}),
      ...(n.style ? { style: { ...n.style } } : {}),
      ...(n.width != null ? { width: n.width } : {}),
      ...(n.height != null ? { height: n.height } : {}),
      ...(n.zIndex != null ? { zIndex: n.zIndex } : {}),
    })),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      sourceHandle: e.sourceHandle ?? "out",
      target: e.target,
      targetHandle: e.targetHandle,
    })),
  };
}

/** Cheap structural equality — avoids pushing a no-op entry when a "change"
 *  turned out to only touch transient React Flow fields (selection, measured
 *  size). Those fire constantly and would otherwise fill the undo stack with
 *  entries that visibly do nothing when undone. */
function same(a, b) {
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

export function createGraphHistory() {
  let past = [];
  let future = [];
  let present = null;
  /** Set while a gesture (node drag, slider scrub) is in flight so its many
   *  intermediate states collapse into ONE undo entry: the first push of a
   *  gesture records the state BEFORE it, the rest are folded in. */
  let openGesture = null;

  const api = {
    /** Adopt a graph as the baseline without recording an undo entry
     *  (initial load, preset load that wants its own single entry, …). */
    reset(nodes, edges) {
      present = snapshot(nodes, edges);
      past = [];
      future = [];
      openGesture = null;
    },

    /**
     * Record a new state. `gesture` is an optional string key: consecutive
     * pushes sharing a key collapse into one entry (drag a node → one undo,
     * not sixty). Pass a different key or `null` to close the run.
     */
    push(nodes, edges, gesture = null) {
      const next = snapshot(nodes, edges);
      if (same(next, present)) return;
      const continuing = gesture != null && gesture === openGesture;
      if (!continuing && present) {
        past.push(present);
        if (past.length > MAX_ENTRIES) past.shift();
      }
      openGesture = gesture;
      present = next;
      future.length = 0;
    },

    /** Ends any open gesture so the next push starts a fresh undo entry. */
    endGesture() {
      openGesture = null;
    },

    undo() {
      if (!past.length) return null;
      future.push(present);
      present = past.pop();
      openGesture = null;
      return present;
    },

    redo() {
      if (!future.length) return null;
      past.push(present);
      present = future.pop();
      openGesture = null;
      return present;
    },

    get canUndo() {
      return past.length > 0;
    },
    get canRedo() {
      return future.length > 0;
    },
  };
  return api;
}
