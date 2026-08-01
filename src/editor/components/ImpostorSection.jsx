import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { engine } from "../engineInstance.js";

/**
 * Impostor inspector (roadmap item 14).
 *
 * The bake is asynchronous, deduplicated across every prop that shares a mesh,
 * and can fail — none of which the schema-driven rows can express. What an
 * author needs to know is exactly three things: is there an atlas yet, what did
 * it cost, and how many props are sharing it. The last one is the number that
 * says whether the feature is doing its job: a forest reporting "1 draw call,
 * 500 instances" is working, and one reporting 500 batches is not.
 */
export function ImpostorSection({ entityId }) {
  const [, force] = useState(0);
  const component = engine.getEntity(entityId)?.getComponent?.("impostor");

  useEffect(() => {
    // The bake completes in the engine's frame loop, not in React, so nothing
    // here would re-render on its own.
    const id = setInterval(() => force((v) => v + 1), 250);
    return () => clearInterval(id);
  }, []);

  if (!component) return null;

  const atlas = component.atlas;
  const system = engine.impostors;
  const batch = system?.batches?.get(component.batchKey);
  const queued = system?.queue?.includes(component);
  const sourceMissing = !component.resolveSource();

  const rebake = () => {
    system?.rebake(component);
    force((v) => v + 1);
  };

  return (
    <div className="impostor-section">
      <div className="field-row">
        <span className="field-label">Atlas</span>
        <span className={atlas ? "field-value ok" : "field-value warn"}>
          {atlas
            ? `${atlas.size}×${atlas.size} · ${atlas.frames}² views`
            : component.bakeError
              ? "failed"
              : queued
                ? "baking…"
                : "not baked"}
        </span>
      </div>
      {atlas && (
        <div className="field-row">
          <span className="field-label">Sharing</span>
          <span className="field-value">
            {batch ? `${batch.members.length} prop${batch.members.length === 1 ? "" : "s"}, 1 draw call` : "—"}
          </span>
        </div>
      )}
      {atlas && (
        <div className="field-row">
          <span className="field-label">Billboard</span>
          <span className="field-value">{(atlas.radius * 2).toFixed(2)} m across</span>
        </div>
      )}
      {component.bakeError && <div className="inspector-hint">{component.bakeError}</div>}
      {sourceMissing && (
        <div className="inspector-hint">
          No source to bake. An impostor bakes the first sibling under the same parent —
          the usual setup is one child of an LOD group per level, with this as the last —
          or whichever entity you point Source at.
        </div>
      )}
      <div className="field-row">
        <span className="field-label" />
        <button
          type="button"
          className="toolbar-btn"
          title="Bake the source again"
          onClick={rebake}
          disabled={sourceMissing}
        >
          <RefreshCw size={12} /> Re-bake
        </button>
      </div>
      <div className="inspector-hint">
        The atlas is baked at runtime and shared by every prop with the same mesh and
        settings, so re-baking one re-bakes them all. Edit the source mesh and press this;
        nothing else can know a model changed underneath it.
      </div>
    </div>
  );
}
