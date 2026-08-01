import { useEffect, useState } from "react";
import { Film } from "lucide-react";
import { useSceneStore } from "../store/sceneStore.js";
import { commandBus } from "../commands/CommandBus.js";
import { SetComponentPropCommand } from "../commands/componentCommands.js";
import { useSelectionStore } from "../store/selectionStore.js";
import { openPanel } from "../EditorShell.jsx";
import { invoke } from "../assetOps.js";
import { normalizeTimeline, trackLabel } from "../../engine/timeline/timelineAsset.js";

/**
 * The Timeline component's inspector extras: an "Edit Timeline" jump, and the
 * per-track binding table.
 *
 * Bindings are the answer to "the same open-the-gate sequence on twelve gates".
 * A track names a target entity by default, which is right for a one-off
 * cutscene; overriding it here lets one asset drive a different object per
 * director. The table is read from the asset itself rather than stored on the
 * component, so a track added in the panel shows up here without the director
 * knowing anything about it.
 */
export function TimelineSection({ entityId, props }) {
  const entities = useSceneStore((s) => s.entities);
  const [tracks, setTracks] = useState([]);
  const [error, setError] = useState(null);
  const asset = props.asset;

  useEffect(() => {
    let live = true;
    if (!asset) {
      setTracks([]);
      return () => {};
    }
    (async () => {
      try {
        const json = normalizeTimeline(JSON.parse(await invoke("read_text_file", { path: asset })));
        if (!live) return;
        setTracks(json.tracks);
        setError(null);
      } catch (err) {
        if (live) setError(String(err));
      }
    })();
    return () => {
      live = false;
    };
  }, [asset]);

  const setBinding = (trackId, value) => {
    const next = { ...(props.bindings ?? {}) };
    if (value) next[trackId] = value;
    else delete next[trackId];
    commandBus.execute(new SetComponentPropCommand(entityId, "timeline", "bindings", next));
  };

  const entityOptions = Object.values(entities ?? {})
    .map((e) => ({ id: e.id, name: e.name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <>
      <div className="script-add-row">
        <button
          className="toolbar-btn"
          disabled={!asset}
          onClick={() => {
            useSelectionStore.getState().selectAsset(asset);
            openPanel("timeline");
          }}
        >
          <Film size={12} /> Edit Timeline
        </button>
      </div>
      {error && <div className="field-row dim">Couldn't read the timeline: {error}</div>}
      {tracks.length > 0 && (
        <>
          <div className="field-row">
            <span className="field-label">Bindings</span>
          </div>
          {tracks.map((track) => (
            <div className="field-row" key={track.id}>
              <span className="field-label" title={trackLabel(track)}>
                {trackLabel(track)}
              </span>
              <select
                className="select-field"
                value={props.bindings?.[track.id] ?? ""}
                onChange={(e) => setBinding(track.id, e.target.value)}
              >
                <option value="">
                  {track.target
                    ? `— as authored (${entities?.[track.target]?.name ?? "missing"}) —`
                    : "— this entity —"}
                </option>
                {entityOptions.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </>
      )}
    </>
  );
}
