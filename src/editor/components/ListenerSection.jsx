// @ts-check
import { useEffect, useState } from "react";
import { engine } from "../engineInstance.js";

/**
 * Listener inspector section. Shows whether this component currently owns
 * the engine's audio listener (and which entity does). Picking is rare
 * because picking a different entity as the listener requires moving the
 * listener there — handy when the camera hands off to a rig or a cutscene.
 *
 * The picking mechanism mirrors the camera-follow picker: it arms a module-
 * level flag, the hierarchy panel observes a click and routes it to the
 * listener on the currently selected entity.
 */

let listenerPickArmed = false;
export function isListenerPickArmed() {
  return listenerPickArmed;
}
export function armListenerPick() {
  listenerPickArmed = true;
}
export function disarmListenerPick() {
  listenerPickArmed = false;
}

export function ListenerSection({ entityId }) {
  const [, force] = useState(0);
  useEffect(() => {
    const refresh = () => force((v) => v + 1);
    return engine.on("audio-changed", refresh);
  }, []);

  const component = engine.getEntity(entityId)?.getComponent?.("listener");
  const activeListener = engine.audio?.listenerEntity;
  const winner = activeListener?.id === entityId;
  const winnerName = activeListener?.name ?? activeListener?.id ?? "(none)";

  // Pick resolution itself lives in HierarchyPanel — the section just arms /
  // disarms the armed flag and shows status.

  if (!component) return null;

  return (
    <div className="listener-section">
      <div className="inspector-subheader">Audio Listener</div>
      <div className="field-row">
        <span className="field-label">Status</span>
        <span className={winner ? "field-value ok" : "field-value warn"}>
          {winner ? "Active" : "Yielding"}
        </span>
      </div>
      <div className="field-row">
        <span className="field-label">Active holder</span>
        <span className="field-value">{winnerName}</span>
      </div>
      <div className="field-row">
        <span className="field-label">Pick from hierarchy</span>
        <button
          className="toolbar-btn"
          title="Reassign the listener to a different entity"
          onClick={() => {
            if (listenerPickArmed) disarmListenerPick();
            else armListenerPick();
            force((v) => v + 1);
          }}
        >
          {listenerPickArmed ? "Cancel" : "Pick"}
        </button>
      </div>
      <div className="inspector-hint">
        The first ListenerComponent to attach becomes the active listener. Other
        listener components yield (still in the scene) so you can swap by
        toggling their Enabled checkbox.
      </div>
    </div>
  );
}
