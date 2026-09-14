import { Building2, Cylinder, Pencil, Blocks, Move, Route, Square, DoorOpen, Brush, Eraser } from "../icons/index.jsx";
import { ArchitectureField, ArchitectureNumber } from "./ArchitectureBuilder.jsx";
import { setArchitectureSculptSetting } from "../architectureSculptTool.js";
import { updateArchitectureForm, setArchitectureModel } from "../architectureModelBuild.js";
import { listStyles } from "../../modules/architecture/styles/catalog.js";
import { engine } from "../engineInstance.js";

export const SCULPT_TOOLS = [
  ["build", "Building", Building2, "Drag a building footprint. Walls and roof form together."],
  ["round", "Tower", Cylinder, "Drag a round building footprint."],
  ["wall", "Wall", Pencil, "Draw a continuous wall through the scene."],
  ["grow", "Grow", Blocks, "Click ground to start; click walls to extend, roofs to stack. Right-click removes."],
  ["reshape", "Reshape", Move, "Select a building; drag handles to resize, lift, move or rotate it."],
  ["path", "Path", Route, "Draw a path. Crossed walls open into passages."],
  ["window", "Window", Square, "Click a facade to add a window at the cursor."],
  ["door", "Door", DoorOpen, "Click a facade to add a doorway."],
  ["paint", "Paint", Brush, "Choose a colour, then click a building."],
  ["erase", "Erase", Eraser, "Remove a form. Its neighbours adapt."],
];
export const SCULPT_COLORS = [["#d5d1c7", "Limestone"], ["#bd8d76", "Terracotta"], ["#dcc79c", "Sandstone"], ["#829b8c", "Sage"], ["#829aa9", "Slate blue"], ["#766c69", "Charcoal"]];

function applySetting(state, key, value, onError) {
  try {
    setArchitectureSculptSetting(key, value);
    if (state.tool === "reshape" && state.entityId && state.formId && ["roof", "roofHeight", "color"].includes(key)) {
      updateArchitectureForm(state.entityId, state.formId, { [key]: value });
    }
    onError("");
  } catch (error) { onError(error.message || String(error)); }
}

/** A composition's style is the whole look: every form re-derives walls, roofs, openings and
 * details from it. Picking one restyles the selected composition and becomes the default for the
 * next one drawn. */
function applyStyle(state, id, onError) {
  try {
    setArchitectureSculptSetting("style", id);
    const model = engine.getEntity(state.entityId)?.getComponent("architecture")?.props.model;
    if (model && model.style?.id !== id) setArchitectureModel(state.entityId, { ...model, style: { ...(model.style ?? { seed: 1 + Math.floor(Math.random() * 100000) }), id } }, "Set building style");
    onError("");
  } catch (error) { onError(error.message || String(error)); }
}

export function ArchitectureStyleStrip({ state, onError }) {
  const model = engine.getEntity(state.entityId)?.getComponent("architecture")?.props.model;
  const current = model ? model.style?.id ?? "" : state.style;
  return <div className="architecture-style-strip" role="listbox" aria-label="Building style">
    {listStyles().map(style => <button key={style.id} role="option" className="architecture-style-chip" aria-selected={current === style.id} aria-pressed={current === style.id} title={style.description} onClick={() => applyStyle(state, style.id, onError)}>
      <span className="architecture-style-swatch">{style.swatch.map((hex, i) => <i key={i} style={{ background: hex }} />)}</span>
      <span>{style.label}</span>
    </button>)}
  </div>;
}

export function ArchitectureSculptControls({ state, onTool, onError }) {
  const form = engine.getEntity(state.entityId)?.getComponent("architecture")?.props.model?.forms?.find((item) => item.id === state.formId);
  const roof = state.tool === "reshape" && form ? form.roof : state.roof;
  const color = state.tool === "reshape" && form ? form.color : state.color;
  return <>
    <div className="architecture-tool-strip architecture-sculpt-tools">
      {SCULPT_TOOLS.map(([id, label, Icon, hint]) => <button key={id} className={`architecture-tool-tile ${state.active && state.tool === id ? "active" : ""}`} aria-label={`Architecture ${id}`} aria-pressed={state.active && state.tool === id} title={hint} onClick={() => onTool(id)}><Icon size={23} /><span>{label}</span></button>)}
    </div>
    <ArchitectureStyleStrip state={state} onError={onError} />
    <div className="architecture-context-bar architecture-sculpt-context">
      <div className="architecture-roof-choices" aria-label="Building roof">
        <span>Roof</span>{[["auto", "Style"], ["gable", "Gable"], ["hip", "Hip"], ["shed", "Shed"], ["flat", "Flat"], ["none", "Open"]].map(([value, label]) => <button key={value} aria-label={`${label} building roof`} aria-pressed={roof === value} title={state.tool === "reshape" && form ? "Change selected building roof" : "Roof for new buildings"} onClick={() => applySetting(state, "roof", value, onError)}>{label}</button>)}
      </div>
      <button className="architecture-new-composition" title="Start a separate building composition" aria-label="New building composition" onClick={() => { setArchitectureSculptSetting("entityId", null); onTool("build"); }}>New</button>
      <div className="architecture-swatches" aria-label="Building colour">{SCULPT_COLORS.map(([hex, label]) => <button key={hex} style={{ "--swatch": hex }} title={label} aria-label={`${label} building colour`} aria-pressed={color === hex} onClick={() => applySetting(state, "color", hex, onError)} />)}</div>
    </div>
  </>;
}

export function ArchitectureSculptSettings({ state, onError }) {
  const number = (key, label, min, max, step = .1) => <ArchitectureField key={key} label={label}><ArchitectureNumber label={`Building ${key}`} value={state[key]} min={min} max={max} step={step} onChange={(value) => applySetting(state, key, value, onError)} /></ArchitectureField>;
  return <>
    <p className="architecture-hint">Drag on the scene to build. Select Reshape to change a building with its handles.</p>
    <div className="architecture-field-grid">
      {number("height", "Initial height (m)", .25, 100)}
      {number("cellSize", "Grow cell (m)", .5, 20)}
      {number("snap", "Drawing snap (0 = free)", 0, 10, .25)}
      {number("width", "Path width (m)", .25, 20)}
      {number("thickness", "Wall thickness (0 = style)", 0, 5)}
      {number("roofHeight", "Roof rise (0 = style pitch)", 0, 50)}
    </div>
    <label className="architecture-toggle"><input type="checkbox" checked={state.windows !== false} onChange={(event) => applySetting(state, "windows", event.target.checked, onError)} /> Automatic windows on new buildings</label>
    <p className="architecture-hint">Grow adds beside the clicked wall or above the clicked roof. Right-click removes a form; middle-drag or Alt-drag orbits.</p>
    <p className="architecture-hint">Neighbouring forms share an exterior. Paths cut passages, windows follow their building, and every gesture has one Undo.</p>
  </>;
}
