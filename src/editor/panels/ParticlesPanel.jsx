import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, RotateCcw, Sparkles, Zap } from "lucide-react";
import { ReactFlowProvider } from "@xyflow/react";
import { useSelectionStore } from "../store/selectionStore.js";
import { useSceneStore } from "../store/sceneStore.js";
import { engine } from "../engineInstance.js";
import { commandBus } from "../commands/CommandBus.js";
import { AddComponentCommand, SetComponentPropCommand } from "../commands/componentCommands.js";
import {
  P_NODE_TYPES,
  nodeDefaults,
  compileParticleGraph,
  particleGraphSignature,
  DEFAULT_PARTICLE_GRAPH,
} from "../../engine/particleGraph.js";
import { PARTICLE_PRESETS } from "../particlePresets.js";
import { GraphEditor } from "../nodegraph/GraphEditor.jsx";
import { stripHelpers } from "../nodegraph/graphUtils.js";

const CATEGORY_LABELS = {
  emitter: "Emitters",
  attribute: "Attributes",
  value: "Values",
  math: "Math",
  noise: "Noise",
  force: "Forces",
  system: "System",
};

/**
 * Adapter from the particle node registry (`P_NODE_TYPES`) to the shape the
 * shared graph toolkit renders. The registry keeps its own vocabulary
 * (`category`, `{key,label,type}` ports, params-only editing) — this is the
 * translation layer, so the compiler never has to care how the editor draws.
 */
const particleRegistry = {
  describe(type) {
    const meta = P_NODE_TYPES[type];
    if (!meta) return null;
    return {
      label: meta.label,
      // The System node is the graph's terminus; it borrows the "output"
      // category colour so it reads like one at a glance.
      cat: meta.category === "system" ? "output" : meta.category,
      inputs: (meta.inputs ?? []).map((i) => ({ key: i.key, label: i.label, type: i.type ?? "any" })),
      outputs: (meta.outputs ?? []).map((o) => ({ key: o.key, label: o.label, type: o.type ?? "any" })),
      params: meta.params ?? [],
      // Particle values are per-particle GPU state; there is nothing a
      // fullscreen-quad thumbnail could meaningfully show.
      noPreview: true,
    };
  },
  items: Object.entries(P_NODE_TYPES).map(([type, meta]) => ({
    type,
    label: meta.label,
    cat: meta.category,
    catLabel: CATEGORY_LABELS[meta.category] ?? meta.category,
    inputTypes: (meta.inputs ?? []).map((i) => i.type ?? "any"),
    outputTypes: (meta.outputs ?? []).map((o) => o.type ?? "any"),
  })),
  defaults: nodeDefaults,
  protectedTypes: [],
  /**
   * A graph needs at least one System node to compile. Multiple System nodes
   * (multi-emitter graphs) can be freely added and removed otherwise, so this
   * only ever vetoes the removal that would take the count to zero.
   */
  guardRemove(nodes, removeIds) {
    let systems = nodes.reduce((n, node) => n + (node.data.nodeType === "system" ? 1 : 0), 0);
    const blocked = [];
    for (const id of removeIds) {
      if (nodes.find((n) => n.id === id)?.data.nodeType !== "system") continue;
      if (systems <= 1) blocked.push(id);
      else systems--;
    }
    return blocked;
  },
};

function ParticleGraphEditor({ entityId, initialGraph }) {
  const editorRef = useRef(null);
  const graphRef = useRef(initialGraph);
  const [dirty, setDirty] = useState(false);
  const [presetOpen, setPresetOpen] = useState(false);
  const [autosave, setAutosave] = useState(() => {
    try {
      return localStorage.getItem("engine.autosave.particles") === "1";
    } catch {
      return false;
    }
  });

  const toggleAutosave = () => {
    setAutosave((cur) => {
      const next = !cur;
      try {
        localStorage.setItem("engine.autosave.particles", next ? "1" : "0");
      } catch {}
      return next;
    });
  };

  const onChange = useCallback((graph, meta) => {
    graphRef.current = graph;
    // A load (initial or preset) is not a user edit; marking it dirty would
    // arm autosave the instant the panel opens.
    if (meta?.reason !== "load") setDirty(true);
  }, []);

  const apply = useCallback(async () => {
    // Frames and reroute pins are authoring aids — the compiler never sees
    // them, but they stay in the graph that gets saved so the layout survives.
    const graph = stripHelpers(graphRef.current);
    // Value-only edits (same structural signature as the committed graph) are
    // applied live via uniforms in the component — skip the redundant
    // validation compile so slider drags stay cheap.
    const committed = engine.getEntity(entityId)?.getComponent?.("particles")?.props?.graph;
    if (!committed || particleGraphSignature(committed) !== particleGraphSignature(graph)) {
      try {
        await compileParticleGraph(graph); // validate before committing
      } catch (err) {
        console.error(`Particle graph error: ${err.message ?? err}`);
        return;
      }
    }
    // The FULL graph (helpers included) is what gets stored, so reopening the
    // editor restores comments and reroutes; ParticleComponent tolerates the
    // extra nodes because nothing in a compiled branch reaches them.
    commandBus.execute(new SetComponentPropCommand(entityId, "particles", "graph", graphRef.current));
    setDirty(false);
  }, [entityId]);

  // Autosave: when enabled, commit every change. Debounced so transient
  // mutations (dragging a node fires a change per intermediate position)
  // collapse into a single write at the end of the gesture.
  useEffect(() => {
    if (!autosave || !dirty) return;
    const id = setTimeout(apply, 150);
    return () => clearTimeout(id);
  }, [autosave, dirty, apply]);

  const restart = () => engine.getEntity(entityId)?.getComponent("particles")?.restart();

  const toolbar = (
    <>
      <div className="dropdown-wrap">
        <button className="toolbar-btn" onClick={() => setPresetOpen((v) => !v)}>
          <Sparkles size={13} />
          Presets
        </button>
        {presetOpen && (
          <>
            <div className="dropdown-overlay" onClick={() => setPresetOpen(false)} />
            <div className="dropdown-menu">
              {Object.keys(PARTICLE_PRESETS).map((name) => (
                <button
                  key={name}
                  className="dropdown-item"
                  onClick={() => {
                    setPresetOpen(false);
                    // `record` makes the preset load one undoable step, so a
                    // mis-click doesn't destroy the graph the user was building.
                    editorRef.current?.load(PARTICLE_PRESETS[name], { record: true });
                    setDirty(true);
                  }}
                >
                  {name}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
      <button className="toolbar-btn icon-only" title="Restart simulation" onClick={restart}>
        <RotateCcw size={14} />
      </button>
      <button
        className={`toolbar-btn icon-only${autosave ? " active" : ""}`}
        title={autosave ? "Autosave on — changes apply instantly" : "Autosave off — click Apply to commit"}
        onClick={toggleAutosave}
      >
        <Zap size={14} />
      </button>
      <button className="toolbar-btn" disabled={!dirty || autosave} onClick={apply}>
        <Check size={13} />
        Apply{dirty ? " •" : ""}
      </button>
    </>
  );

  return (
    <GraphEditor
      ref={editorRef}
      kind="particles"
      registry={particleRegistry}
      initialGraph={initialGraph}
      onChange={onChange}
      toolbar={toolbar}
      hint="Wire emitters and forces into the Particle System node · right-click the canvas or drop a wire on it to add nodes · double-click a wire to delete it (Alt+double-click for a reroute pin) · Ctrl+Z undoes"
    />
  );
}

export function ParticlesPanel() {
  const selectedId = useSelectionStore((s) => s.ids[0] ?? null);
  const entity = useSceneStore((s) => (selectedId ? s.entities[selectedId] : null));
  const graph = entity?.components?.particles?.graph;
  const hasParticles = !!entity?.components?.particles;
  // Frozen at mount: the editor owns its working copy from here, and letting a
  // committed-graph identity change flow back in would reload the canvas (and
  // lose selection/undo) on every Apply.
  const initialGraph = useMemo(() => graph ?? DEFAULT_PARTICLE_GRAPH, [entity?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!entity) {
    return <div className="shader-graph-panel empty">Select an entity to edit its particle system.</div>;
  }

  if (!hasParticles) {
    return (
      <div className="shader-graph-panel empty">
        <div>
          <div style={{ marginBottom: 10 }}>“{entity.name}” has no Particles component.</div>
          <button
            className="toolbar-btn"
            onClick={() => commandBus.execute(new AddComponentCommand(entity.id, "particles"))}
          >
            Add Particles Component
          </button>
        </div>
      </div>
    );
  }

  return (
    <ReactFlowProvider>
      <ParticleGraphEditor key={entity.id} entityId={entity.id} initialGraph={initialGraph} />
    </ReactFlowProvider>
  );
}
