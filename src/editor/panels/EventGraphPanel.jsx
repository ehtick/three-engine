import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { GraphEditor } from "../nodegraph/GraphEditor.jsx";
import { eventGraphRegistry } from "../eventGraphRegistry.js";
import { engine } from "../engineInstance.js";
import { useSelectionStore } from "../store/selectionStore.js";
import { useProjectStore } from "../store/projectStore.js";
import { listProjectScripts } from "../scriptIntrospect.js";
import { useSceneStore } from "../store/sceneStore.js";
import { commandBus } from "../commands/CommandBus.js";
import { AddComponentCommand, SetComponentPropCommand } from "../commands/componentCommands.js";

/**
 * The event graph for the selected entity's Events component.
 *
 * A panel rather than an inspector section because a graph needs room — the
 * same reason Shader Graph and Particles are panels. The Events component's
 * inspector keeps the row list, which is the right editor for "when X, do these
 * three things", and offers a button through to here for the wiring rows cannot
 * express: a branch, a value passed between actions, several triggers sharing
 * one chain.
 *
 * Both run. The graph is not a view of the rows and the rows are not a
 * flattened graph — converting between them would be lossy in the direction
 * that matters, and a lossy round-trip through an editor is how authored work
 * quietly disappears.
 */

/** A new graph starts with one trigger, because an empty canvas does not say
 *  what it wants. Positioned left, where the exec chain will grow rightward. */
const STARTER_GRAPH = {
  nodes: [
    {
      id: "trigger-start",
      type: "on-lifecycle",
      props: { phase: "start" },
      position: { x: 40, y: 120 },
    },
  ],
  edges: [],
};

/**
 * Which nodes ran recently, as CSS classes for the editor.
 *
 * Polled rather than pushed: a graph on a per-frame event would otherwise
 * re-render the canvas from inside `emit`. The component bumps a counter when
 * anything runs, so an idle graph costs one integer comparison per tick and no
 * React work at all.
 *
 * Two classes, because "ran once, a while ago" and "running right now" are
 * different questions — the first tells you a branch was taken, the second
 * shows you the flow live.
 */
function useRunTrace(entityId) {
  const [classes, setClasses] = useState(null);
  useEffect(() => {
    const component = entityId ? engine.getEntity(entityId)?.getComponent("events") : null;
    if (!component?.traceGraph) return undefined;
    component.traceGraph(true);
    let lastSeq = -1;
    const lastSeen = new Map();
    const id = setInterval(() => {
      const seq = component.graphTraceSeq ?? 0;
      const now = performance.now();
      if (seq !== lastSeq) {
        lastSeq = seq;
        for (const nodeId of component.graphTrace?.keys() ?? []) lastSeen.set(nodeId, now);
      }
      if (!lastSeen.size) return;
      const next = {};
      let live = false;
      for (const [nodeId, at] of lastSeen) {
        const age = now - at;
        if (age > 4000) continue;
        next[nodeId] = age < 400 ? "graph-node-running" : "graph-node-ran";
        live = true;
      }
      setClasses(live ? next : null);
    }, 120);
    return () => {
      clearInterval(id);
      component.traceGraph(false);
    };
  }, [entityId]);
  return classes;
}

export function EventGraphPanel() {
  const selectedId = useSelectionStore((s) => s.ids[0] ?? null);
  const entity = useSceneStore((s) => (selectedId ? s.entities[selectedId] : null));
  const component = entity?.components?.events;
  const saved = component?.graph;
  const dirtyRef = useRef(false);
  const nodeClasses = useRunTrace(selectedId);
  const rootPath = useProjectStore((s) => s.rootPath);

  // Warm the script cache so the `call` node's method picker has real options
  // to offer. `describe()` is synchronous and has nowhere to await, so the read
  // has to have already happened by the time a node renders.
  useEffect(() => {
    if (rootPath) listProjectScripts(rootPath).catch(() => {});
  }, [rootPath]);

  // Frozen per entity: the editor owns its working copy from here. Letting a
  // committed graph's identity flow back in would reload the canvas — losing
  // selection, viewport and undo — on every single edit.
  const initialGraph = useMemo(
    () => saved ?? STARTER_GRAPH,
    [selectedId], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const onChange = useCallback(
    (graph) => {
      if (!selectedId) return;
      dirtyRef.current = true;
      commandBus.execute(
        new SetComponentPropCommand(selectedId, "events", "graph", graph, "Edit event graph"),
      );
    },
    [selectedId],
  );

  if (!entity) {
    return <div className="inspector-panel empty">Select an entity to edit its event graph.</div>;
  }

  if (!component) {
    // Column-flow of its own: `.inspector-panel.empty` is `display:flex` with
    // no direction, so a paragraph beside a button becomes two squeezed
    // columns rather than a stack.
    return (
      <div className="events-graph-empty">
        <p>
          “{entity.name}” has no <strong>Events</strong> component yet.
        </p>
        <button
          className="toolbar-btn"
          onClick={() => commandBus.execute(new AddComponentCommand(selectedId, "events"))}
        >
          <Plus size={13} /> Add Events
        </button>
      </div>
    );
  }

  return (
    <GraphEditor
      key={selectedId}
      kind="events"
      registry={eventGraphRegistry}
      initialGraph={initialGraph}
      onChange={onChange}
      nodeClasses={nodeClasses}
      hint="Pink wires run the flow, coloured wires carry values · right-click the canvas to add nodes · a value left unwired uses the node's own field · Ctrl+Z undoes"
    />
  );
}
