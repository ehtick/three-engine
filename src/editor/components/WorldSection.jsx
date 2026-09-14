import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Crosshair, Leaf, Mountain, Palette, RefreshCw, RotateCcw } from "../icons/index.jsx";
import { Select } from "../fields/Select.jsx";
import { engine } from "../engineInstance.js";
import { commandBus } from "../commands/CommandBus.js";
import { useSelectionStore } from "../store/selectionStore.js";
import { normalizeWorldDocument } from "../../engine/world/worldDocument.js";
import { describeWorldParameters } from "../../engine/world/worldConfig.js";
import {
  focusWorld, newWorldSeed, resetWorldRoofColor, selectWorldTerrain,
  setWorldRoofColor, updateWorldSettings,
} from "../worldBuild.js";
import "../world.css";

const hexColor = (value) => /^#[0-9a-f]{6}$/i.test(value ?? "");
const readPath = (source, path) => path.split(".").reduce((value, key) => value?.[key], source);
const patchFor = (path, value) => {
  const keys = path.split(".");
  return keys.length === 1 ? { [keys[0]]: value } : { [keys[0]]: { [keys[1]]: value } };
};

/** Controls in the order the parameter table declares them, by category. */
const PARAMETERS = describeWorldParameters();
const GROUPS = [...new Set(PARAMETERS.map((parameter) => parameter.group))]
  .map((group) => ({ group, parameters: PARAMETERS.filter((parameter) => parameter.group === group) }));
const SECTIONS = {
  landscape: ["World", "Terrain", "Streaming", "Water", "Banks", "Settlements", "Vegetation"],
  look: ["Look"],
};

/**
 * One live control.
 *
 * Dragging applies continuously: the World cancels its in-flight generation and
 * starts again from the new value, so the viewport follows the slider instead of
 * waiting for an Apply. The whole drag collapses into one undo entry.
 */
function WorldControl({ parameter, value, onLive, onCommit, disabled }) {
  const [local, setLocal] = useState(value);
  const dragging = useRef(false);
  useEffect(() => { if (!dragging.current) setLocal(value); }, [value]);
  const label = parameter.label;

  if (parameter.kind === "boolean") {
    return <label className="world-toggle" title={parameter.hint}>
      <input type="checkbox" checked={!!value} disabled={disabled}
        onChange={(event) => onCommit(event.target.checked)} /> {label}
    </label>;
  }
  if (parameter.kind === "enum") {
    return <div className="world-field" title={parameter.hint}><span>{label}</span>
      <Select aria-label={label} value={String(value)} disabled={disabled}
        onChange={(event) => onCommit(parameter.choices.every((choice) => typeof choice === "number")
          ? Number(event.target.value) : event.target.value)}>
        {parameter.choices.map((choice) => <option key={choice} value={choice}>{String(choice)}</option>)}
      </Select>
    </div>;
  }
  if (parameter.kind === "color") {
    return <div className="world-field" title={parameter.hint}><span>{label}</span>
      <WorldColor value={value} onCommit={onCommit} label={label} />
    </div>;
  }
  const integer = parameter.kind === "integer";
  const clamp = (next) => Math.min(parameter.max, Math.max(parameter.min, integer ? Math.round(next) : next));
  // A seed spans the whole 32-bit range; a slider there is useless, so it and
  // other very wide integers get a plain number field.
  const wide = integer && parameter.max - parameter.min > 500;
  return <div className="world-field world-slider" title={parameter.hint}>
    <span>{label}</span>
    <div className="world-slider-row">
      {!wide && <input type="range" aria-label={label} disabled={disabled}
        min={parameter.min} max={parameter.max} step={parameter.step ?? .05} value={local}
        onPointerDown={() => { dragging.current = true; commandBus.beginPreview(`Set World ${label.toLowerCase()}`); }}
        onChange={(event) => { const next = clamp(Number(event.target.value)); setLocal(next); onLive(next); }}
        onPointerUp={() => { dragging.current = false; commandBus.endPreview(); }}
        onPointerCancel={() => { dragging.current = false; commandBus.endPreview(); }}
        onKeyUp={() => commandBus.endPreview()} />}
      <input className="world-input" type="number" aria-label={`${label} value`} disabled={disabled}
        min={parameter.min} max={parameter.max} step={parameter.step ?? .05} value={local}
        onChange={(event) => setLocal(event.target.value)}
        onBlur={() => {
          const next = Number(local);
          if (!String(local).trim() || !Number.isFinite(next)) { setLocal(value); return; }
          const bounded = clamp(next);
          setLocal(bounded);
          if (bounded !== value) onCommit(bounded);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
          if (event.key === "Escape") { event.stopPropagation(); setLocal(value); }
        }} />
    </div>
  </div>;
}

function WorldColor({ value, onCommit, label = "cottage roof color" }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => {
    if (hexColor(text)) { if (text.toLowerCase() !== value?.toLowerCase()) onCommit(text.toLowerCase()); }
    else setText(value);
  };
  return <div className="world-color">
    <input type="color" aria-label={`Choose ${label}`} value={hexColor(text) ? text : "#626c71"}
      onChange={(event) => setText(event.target.value)} onBlur={commit} />
    <input className="world-input" aria-label={label} spellCheck={false} maxLength={7} value={text}
      onChange={(event) => setText(event.target.value)} onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
        if (event.key === "Escape") { event.stopPropagation(); setText(value); }
      }} />
    <button type="button" className="world-button" disabled={!hexColor(text) || text.toLowerCase() === value?.toLowerCase()} onClick={commit}>Apply</button>
  </div>;
}

function useWorldStatus(entityId, documentSignature) {
  const [live, setLive] = useState({ status: "", stage: "", error: "", stats: null, buildings: [] });
  useEffect(() => {
    let previous = "";
    const refresh = (stage) => {
      const component = engine.getEntity(entityId)?.getComponent("world");
      const features = component?.features ?? [];
      const next = {
        status: component?.status ?? "",
        stage: stage ?? component?._stage ?? "",
        error: component?.error?.message ?? (typeof component?.error === "string" ? component.error : ""),
        stats: component?.stats ?? null,
        buildings: features.filter((feature) => feature.kind === "building").map((feature) => ({ id: feature.id, ...feature.props })),
      };
      const signature = JSON.stringify(next);
      if (signature !== previous) { previous = signature; setLive(next); }
    };
    refresh();
    return engine.on("world-changed", (event) => { if (event.entityId === entityId) refresh(event.stage); });
  }, [entityId, documentSignature]);
  return live;
}

/** World edits use the same embedded document, command history and viewport as
 * the rest of the editor. Every control applies as you move it. */
export function WorldSection({ entityId, props }) {
  const document = normalizeWorldDocument(props.document);
  const source = document.settings;
  const documentSignature = JSON.stringify(document);
  const [section, setSection] = useState("landscape");
  const [error, setError] = useState("");
  const [buildingId, setBuildingId] = useState("cottage");
  const live = useWorldStatus(entityId, documentSignature);
  const busy = /building|loading|generating|queued|pending/i.test(String(live.status));
  const roofEdit = [...document.edits].reverse().find((edit) => edit.kind === "override" && edit.target === buildingId && (edit.property === "roofColor" || JSON.stringify(edit.property) === '["roofColor"]'));
  const roofColor = roofEdit?.value ?? live.buildings.find((feature) => feature.id === buildingId)?.roofColor ?? "#626c71";
  const run = useCallback((action) => {
    try { setError(""); return action(); }
    catch (cause) { setError(cause.message || String(cause)); }
  }, []);
  const apply = useCallback((path, value, label) =>
    run(() => updateWorldSettings(entityId, patchFor(path, value), label)), [entityId, run]);

  const sections = useMemo(() => Object.fromEntries(Object.entries(SECTIONS).map(([id, names]) =>
    [id, GROUPS.filter((entry) => names.includes(entry.group))])), []);
  const places = live.stats?.places ?? [];
  const siting = live.stats?.siting;
  const short = siting && live.stats?.houses < siting.requested;

  return <div className="world-section" data-world-section={entityId}>
    <div className="world-intro">
      <div><Mountain size={17} /><strong>Temperate valley</strong></div>
      <span>{source.extent} × {source.extent} m</span>
    </div>
    {live.stats && <div className="world-stats">
      <span>{(live.stats.trees ?? 0).toLocaleString()} trees</span>
      <span>{live.stats.houses ?? 0} buildings</span>
      <span>{live.stats.lakes ?? 0} lakes</span>
      <span>{live.stats.rivers ?? 0} rivers</span>
    </div>}
    {!!places.length && <p className="world-hint">{places.map((place) => `${place.kind} of ${place.buildings}`).join(" · ")}</p>}
    <div className="world-navigation" aria-label="World viewpoints">
      <button type="button" className="world-button" onClick={() => run(() => focusWorld(entityId))}><Crosshair size={12} /> Valley</button>
      <button type="button" className="world-button" onClick={() => run(() => focusWorld(entityId, "forest"))}>Forest</button>
      <button type="button" className="world-button" disabled={!live.buildings.length} onClick={() => run(() => focusWorld(entityId, "cottage"))}>Village</button>
      <button type="button" className="world-button" onClick={() => run(() => newWorldSeed(entityId))}><RefreshCw size={12} /> New seed</button>
    </div>
    <div className="world-section-switch" aria-label="World controls">
      {[["landscape", "Landscape", Mountain], ["look", "Look", Palette], ["edits", "Local edits", Leaf]].map(([id, label, Icon]) =>
        <button key={id} type="button" aria-pressed={section === id} onClick={() => setSection(id)}><Icon size={12} />{label}</button>)}
    </div>
    {(section === "landscape" || section === "look") && sections[section].map(({ group, parameters }) =>
      <details className="world-group" key={group} open={["World", "Terrain", "Look"].includes(group)}>
        <summary>{group}</summary>
        <div className="world-field-grid">
          {parameters.map((parameter) => <WorldControl key={parameter.path} parameter={parameter}
            value={readPath(source, parameter.path)} disabled={false}
            onLive={(value) => apply(parameter.path, value, `Set World ${parameter.label.toLowerCase()}`)}
            onCommit={(value) => apply(parameter.path, value, `Set World ${parameter.label.toLowerCase()}`)} />)}
        </div>
      </details>)}
    {section === "landscape" && <p className="world-hint">
      Every control applies as you move it. The world rebuilds in the background and keeps your local edits.
    </p>}
    {section === "edits" && <>
      <div className="world-edit-card">
        <div className="world-field"><span>Building</span>
          <Select aria-label="Building to edit" value={buildingId} onChange={(event) => setBuildingId(event.target.value)}>
            {live.buildings.map((feature, index) => <option key={feature.id} value={feature.id}>{feature.role ?? "house"} {index + 1} · {feature.label}</option>)}
            {!live.buildings.some((feature) => feature.id === buildingId) && <option value={buildingId}>Building (not currently generated)</option>}
          </Select>
        </div>
        <div className="world-card-heading"><strong>Roof</strong><span className={roofEdit ? "world-edited" : ""}>{roofEdit ? "Custom color" : "Generated"}</span></div>
        <WorldColor value={roofColor} onCommit={(color) => run(() => setWorldRoofColor(entityId, buildingId, color))} />
        <div className="world-actions">
          <button type="button" className="world-button" disabled={!roofEdit} onClick={() => run(() => resetWorldRoofColor(entityId, buildingId))}><RotateCcw size={12} /> Reset roof color</button>
          <button type="button" className="world-button" disabled={!live.buildings.some((feature) => feature.id === buildingId)} onClick={() => run(() => focusWorld(entityId, "cottage", buildingId))}>Focus building</button>
        </div>
        <p className="world-hint">Enter any hex color. It stays through regeneration, look changes and scene saves.</p>
        {!source.buildings && <p className="world-hint">Enable buildings in Landscape to see this edit.</p>}
      </div>
      <div className="world-edit-card">
        <div className="world-card-heading"><strong>Sculpt terrain</strong></div>
        <p className="world-hint">Select the generated terrain to use the editor's terrain brushes.</p>
        <button type="button" className="world-button" disabled={busy} onClick={() => run(() => selectWorldTerrain(entityId))}><Mountain size={12} /> Select terrain</button>
      </div>
      <p className="world-hint">All applied changes use the editor's Undo and Redo.</p>
    </>}
    {busy && <p className="world-hint world-busy" role="status">Building{live.stage ? ` ${live.stage}` : ""}…</p>}
    {short && <p className="world-hint">{live.stats.houses} of {siting.requested} buildings fit. The rest had no dry, level, road-served plot.</p>}
    {!!live.stats?.unconnectedHouses?.length && <p className="world-hint">{live.stats.unconnectedHouses.length} moved building(s) have no suitable lane route. Their placement is preserved.</p>}
    {(error || live.error) && <p className="world-error" role="alert">{error || live.error}</p>}
    {live.error && <button type="button" className="world-button" onClick={() => run(() => engine.getEntity(entityId)?.getComponent("world")?.regenerate())}>Retry generation</button>}
  </div>;
}

/** Keep the route back to the document visible while editing a native provider. */
export function WorldOwnerLink({ entityId }) {
  let owner = engine.getEntity(entityId)?.parent;
  while (owner && !owner.getComponent("world")) owner = owner.parent;
  if (!owner) return null;
  const worldId = owner.id;
  return <div className="world-owner-link"><button type="button" className="world-button" onClick={() => useSelectionStore.getState().select(worldId)}><Mountain size={12} /> World controls<span>{owner.name}</span></button></div>;
}
