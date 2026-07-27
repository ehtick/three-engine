import { useEffect, useState } from "react";
import { Plus, Trash2, Check, Eye, EyeOff, Eraser } from "lucide-react";
import { commandBus } from "../commands/CommandBus.js";
import { SetComponentPropCommand } from "../commands/componentCommands.js";
import { SetTerrainSplatmapCommand } from "../commands/terrainCommands.js";
import { AssetField } from "../fields/AssetField.jsx";
import { MATERIAL_EXTENSIONS, MODEL_EXTENSIONS, TEXTURE_EXTENSIONS } from "../assetLoader.js";
import { engine } from "../engineInstance.js";
import { ensureTerrainAssets } from "../terrainAssetSetup.js";
import { SCULPT_TOOLS, MAX_TERRAIN_LAYERS, makeTerrainLayer, makeTerrainScatterLayer } from "../../modules/terrain/TerrainComponent.js";
import { FALLOFF_CURVES } from "../brush.js";
import {
  armTerrainBrush,
  armTerrainScatterSourcePick,
  disarmTerrainScatterSourcePick,
  disarmTerrainBrush,
  getTerrainBrushMode,
  getTerrainBrushSettings,
  getTerrainScatterSourcePick,
  setTerrainBrushSetting,
  subscribeTerrainBrush,
} from "../terrainBrush.js";

const TOOL_HINTS = {
  raise: "Push the surface up",
  lower: "Push the surface down",
  smooth: "Average out bumps and noise",
  flatten: "Level toward the height where the stroke started",
  sharpen: "Amplify detail — accent ridges and creases",
  contrast: "Push away from the local average — the inverse of Smooth",
  pinch: "Pull the surface toward the height under the brush centre",
  erode: "Carve downhill — weathered valleys and channels",
  noise: "Add coherent random bumps for natural variation",
};

function NumberInput({ value, min, max, step = 0.1, onCommit }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const n = parseFloat(text);
    if (!Number.isNaN(n)) {
      let v = n;
      if (min !== undefined) v = Math.max(min, v);
      if (max !== undefined) v = Math.min(max, v);
      onCommit(v);
    } else {
      setText(String(value));
    }
  };
  return (
    <input
      className="number-field"
      type="number"
      min={min}
      max={max}
      step={step}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.target.blur();
        if (e.key === "Escape") {
          setText(String(value));
          e.target.blur();
        }
      }}
    />
  );
}

function PropRow({ label, children }) {
  return (
    <div className="field-row">
      <span className="field-label">{label}</span>
      {children}
    </div>
  );
}

function ScatterNameInput({ value, onCommit }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <input
      className="terrain-scatter-name"
      value={text}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => onCommit(text.trim() || value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") { setText(value); e.currentTarget.blur(); }
      }}
    />
  );
}

/**
 * Mutates the terrain's *live* scatter data, then pushes the result back through
 * the command bus so it's undoable and reaches the scene file.
 *
 * Goes through the component rather than `props.scatterLayers` because painted
 * instances live on the component until a stroke commits — building the new
 * value from props could silently drop instances that haven't landed there yet.
 */
function runOnScatterLayer(entityId, mutate) {
  const component = engine.getEntity(entityId)?.getComponent("terrain");
  if (!component) return;
  mutate(component);
  commandBus.execute(
    new SetComponentPropCommand(entityId, "terrain", "scatterLayers", JSON.parse(component.commitScatterLayers())),
  );
}

function runOnSplatLayer(entityId, layerIndex, operation) {
  const component = engine.getEntity(entityId)?.getComponent("terrain");
  if (!component?.splatData) return;
  const before = component.props.splatmap;
  if (operation === "fill") {
    if (typeof component.fillSplatLayer === "function") component.fillSplatLayer(layerIndex);
    else {
      for (let offset = 0; offset < component.splatData.length; offset += 4) {
        for (let channel = 0; channel < 4; channel++) component.splatData[offset + channel] = channel === layerIndex ? 255 : 0;
      }
      component.splatTexture.needsUpdate = true;
    }
  } else {
    if (typeof component.clearSplatLayer === "function") component.clearSplatLayer(layerIndex);
    else {
      for (let offset = layerIndex; offset < component.splatData.length; offset += 4) component.splatData[offset] = 0;
      component.splatTexture.needsUpdate = true;
    }
  }
  component.commitSplatmap();
  commandBus.execute(new SetTerrainSplatmapCommand(entityId, before, component.props.splatmap));
}
/** A min/max pair on one row — the shape most scatter variation takes. */
function RangeRow({ label, title, min, max, step = 0.05, lo, hi, onCommit }) {
  return (
    <div className="field-row" title={title}>
      <span className="field-label">{label}</span>
      <div className="terrain-range">
        <NumberInput value={lo} min={min} max={max} step={step} onCommit={(v) => onCommit(v, Math.max(v, hi))} />
        <span className="terrain-range-sep">–</span>
        <NumberInput value={hi} min={min} max={max} step={step} onCommit={(v) => onCommit(Math.min(lo, v), v)} />
      </div>
    </div>
  );
}

/**
 * Placement settings for a scatter layer.
 *
 * These are layer properties, not brush properties, and instances store only
 * their random *draws* — so every control here re-resolves across the instances
 * already painted. Widening Scale grows the rocks that are already down;
 * switching Align re-orients them. "Reseed" re-rolls the draws when you want a
 * different shuffle rather than a different range.
 */
function ScatterPlacement({ layer, entityId, layerIndex, onChange }) {
  const [open, setOpen] = useState(false);
  const align = layer.align ?? "surface";

  const reseed = () => runOnScatterLayer(entityId, (c) => c.reseedScatterLayer(layerIndex));

  return (
    <>
      <button className="terrain-placement-toggle" onClick={() => setOpen((v) => !v)}>
        {open ? "▾" : "▸"} Placement
      </button>
      {open && (
        <div className="terrain-placement">
          <PropRow label="Align">
            <select className="select-field" value={align} onChange={(e) => onChange({ align: e.target.value })}>
              <option value="surface">Terrain normal</option>
              <option value="axis">Fixed axis</option>
              <option value="source">Copy source rotation</option>
            </select>
          </PropRow>
          {align !== "source" && (
            <PropRow label="Up Axis">
              <select
                className="select-field"
                value={layer.alignAxis ?? "+y"}
                onChange={(e) => onChange({ alignAxis: e.target.value })}
              >
                {["+x", "-x", "+y", "-y", "+z", "-z"].map((axis) => (
                  <option key={axis} value={axis}>{axis.toUpperCase()}</option>
                ))}
              </select>
            </PropRow>
          )}
          {align === "surface" && (
            <PropRow label="Normal Blend">
              <NumberInput
                value={layer.alignBlend ?? 1}
                min={0}
                max={1}
                step={0.05}
                onCommit={(v) => onChange({ alignBlend: v })}
              />
            </PropRow>
          )}
          <RangeRow
            label="Yaw°"
            title="Random spin about the instance's own up axis"
            min={-360}
            max={360}
            step={5}
            lo={layer.yawMin ?? 0}
            hi={layer.yawMax ?? 360}
            onCommit={(yawMin, yawMax) => onChange({ yawMin, yawMax })}
          />
          <PropRow label="Tilt Jitter°">
            <NumberInput
              value={layer.tiltJitter ?? 0}
              min={0}
              max={90}
              step={1}
              onCommit={(v) => onChange({ tiltJitter: v })}
            />
          </PropRow>

          <RangeRow
            label="Scale"
            title="Uniform scale range"
            min={0.01}
            lo={layer.scaleMin ?? 0.8}
            hi={layer.scaleMax ?? 1.2}
            onCommit={(scaleMin, scaleMax) => onChange({ scaleMin, scaleMax })}
          />
          <RangeRow
            label="Stretch"
            title="Extra multiplier on the up axis only — squat and lanky variants of the same model"
            min={0.01}
            lo={layer.stretchMin ?? 1}
            hi={layer.stretchMax ?? 1}
            onCommit={(stretchMin, stretchMax) => onChange({ stretchMin, stretchMax })}
          />

          <PropRow label="Sink">
            <NumberInput
              value={layer.heightOffset ?? 0}
              step={0.05}
              onCommit={(v) => onChange({ heightOffset: v })}
            />
          </PropRow>
          <PropRow label="Sink Jitter">
            <NumberInput
              value={layer.heightJitter ?? 0}
              min={0}
              step={0.05}
              onCommit={(v) => onChange({ heightJitter: v })}
            />
          </PropRow>

          <RangeRow
            label="Slope°"
            title="Only paint where the ground's angle falls in this range — grass on the flats, nothing on the cliffs"
            min={0}
            max={90}
            step={1}
            lo={layer.slopeMin ?? 0}
            hi={layer.slopeMax ?? 90}
            onCommit={(slopeMin, slopeMax) => onChange({ slopeMin, slopeMax })}
          />
          <RangeRow
            label="Altitude"
            title="Only paint between these heights — seaweed below the waterline, snow-line pines above"
            step={0.5}
            lo={layer.altitudeMin ?? -1000}
            hi={layer.altitudeMax ?? 1000}
            onCommit={(altitudeMin, altitudeMax) => onChange({ altitudeMin, altitudeMax })}
          />

          <div className="inspector-hint" style={{ margin: "2px 2px 5px" }}>
            Slope and Altitude only gate *new* instances — they don't remove what's already painted.
          </div>
          <button className="toolbar-btn wide" onClick={reseed} title="Re-roll the random variation on every instance in this layer">
            Reseed variation
          </button>
        </div>
      )}
    </>
  );
}

/**
 * Terrain component's inspector section: arm/disarm the sculpt & paint
 * brushes (viewport pointer handlers in ViewportPanel.jsx read the armed
 * state from terrainBrush.js), brush parameter controls, and the texture
 * layer list (up to 4, blended via the splatmap — see TerrainComponent.js).
 * Exactly one layer is "active" at a time; painting writes that layer's
 * splat channel.
 */
export function TerrainSection({ entityId, props }) {
  const [, force] = useState(0);
  useEffect(() => subscribeTerrainBrush(() => force((v) => v + 1)), []);
  useEffect(() => {
    const entity = engine.getEntity(entityId);
    ensureTerrainAssets(entity, props).catch((err) => console.error(`Could not create terrain assets: ${err}`));
  }, [entityId]);

  const mode = getTerrainBrushMode();
  const settings = getTerrainBrushSettings();
  const layers = props.layers ?? [];
  const scatterLayers = props.scatterLayers ?? [];
  const activeLayer = Math.min(settings.activeLayer, Math.max(0, layers.length - 1));
  const activeScatterLayer = Math.min(settings.activeScatterLayer, Math.max(0, scatterLayers.length - 1));
  const activeLayerHasMaterial = !!layers[activeLayer]?.material;

  const commit = (key, value) =>
    commandBus.execute(new SetComponentPropCommand(entityId, "terrain", key, value));

  const toggleMode = (next) => {
    if (mode === next) disarmTerrainBrush();
    else armTerrainBrush(next);
  };

  const addLayer = () => {
    if (layers.length >= MAX_TERRAIN_LAYERS) return;
    commit("layers", [...layers, makeTerrainLayer()]);
    setTerrainBrushSetting("activeLayer", layers.length); // select the new one
  };
  const removeLayer = (i) => {
    commit("layers", layers.filter((_, idx) => idx !== i));
    setTerrainBrushSetting("activeLayer", Math.max(0, Math.min(activeLayer, layers.length - 2)));
  };
  const updateLayer = (i, patch) => {
    commit("layers", layers.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  };
  const addScatterLayer = () => {
    commit("scatterLayers", [...scatterLayers, makeTerrainScatterLayer({ name: `Scatter ${scatterLayers.length + 1}` })]);
    setTerrainBrushSetting("activeScatterLayer", scatterLayers.length);
  };
  const removeScatterLayer = (i) => {
    commit("scatterLayers", scatterLayers.filter((_, idx) => idx !== i));
    setTerrainBrushSetting("activeScatterLayer", Math.max(0, Math.min(activeScatterLayer, scatterLayers.length - 2)));
    if (scatterLayers.length === 1 && mode === "scatter") disarmTerrainBrush();
  };
  const updateScatterLayer = (i, patch) => {
    commit("scatterLayers", scatterLayers.map((layer, idx) => (idx === i ? { ...layer, ...patch } : layer)));
  };

  return (
    <>
      <div className="inspector-subheader">Brush</div>
      <div className="camera-follow-row">
        <button
          className={`toolbar-btn ${mode === "sculpt" ? "active" : ""}`}
          onClick={() => toggleMode("sculpt")}
          title="Sculpt terrain height with the mouse in the viewport (S)"
        >
          {mode === "sculpt" ? "Sculpting…" : "Sculpt"}
        </button>
        <button
          className={`toolbar-btn ${mode === "paint" ? "active" : ""}`}
          onClick={() => toggleMode("paint")}
          disabled={!activeLayerHasMaterial}
          title={activeLayerHasMaterial ? "Paint the active material layer with the mouse in the viewport (P)" : "Assign a material to the active layer first"}
        >
          {mode === "paint" ? "Painting…" : "Paint"}
        </button>
        <button
          className={`toolbar-btn ${mode === "erase" ? "active" : ""}`}
          onClick={() => toggleMode("erase")}
          disabled={!activeLayerHasMaterial}
          title={activeLayerHasMaterial ? "Erase the active material layer, revealing the base (E)" : "Assign a material to the active layer first"}
        >
          {mode === "erase" ? "Erasing…" : "Erase"}
        </button>
        <button
          className={`toolbar-btn ${mode === "scatter" ? "active" : ""}`}
          onClick={() => toggleMode("scatter")}
          disabled={!scatterLayers.length}
          title="Paint model instances onto the terrain (C). Hold Ctrl while dragging to remove."
        >
          {mode === "scatter" ? "Scattering…" : "Scatter"}
        </button>
      </div>
      {mode ? (
        <div className="inspector-hint" style={{ margin: "2px 2px 6px" }}>
          {mode === "sculpt"
            ? "Drag over the terrain to sculpt. Right-drag still orbits."
            : mode === "scatter"
              ? `Drag to place ${scatterLayers[activeScatterLayer]?.name ?? "instances"}. Ctrl-drag removes.`
            : mode === "erase"
              ? `Drag to erase Layer ${activeLayer + 1}, revealing what's underneath.`
              : `Drag over the terrain to paint Layer ${activeLayer + 1}.`}
        </div>
      ) : (
        <div className="inspector-hint" style={{ margin: "2px 2px 6px" }}>
          S sculpt · P paint · E erase · C scatter · F size · Shift+F strength (scatter: spacing) · Ctrl+F hardness.
        </div>
      )}

      {mode === "sculpt" && (
        <PropRow label="Tool">
          <select
            className="select-field"
            value={settings.tool}
            title={TOOL_HINTS[settings.tool]}
            onChange={(e) => setTerrainBrushSetting("tool", e.target.value)}
          >
            {SCULPT_TOOLS.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </PropRow>
      )}

      {mode && (
        <>
          <PropRow label="Radius">
            <NumberInput value={settings.radius} min={0.1} step={0.5} onCommit={(v) => setTerrainBrushSetting("radius", v)} />
          </PropRow>
          <PropRow label="Strength">
            <NumberInput value={settings.strength} min={0.01} max={1} step={0.05} onCommit={(v) => setTerrainBrushSetting("strength", v)} />
          </PropRow>
          <PropRow label="Hardness">
            <NumberInput value={settings.hardness} min={0} max={1} step={0.05} onCommit={(v) => setTerrainBrushSetting("hardness", v)} />
          </PropRow>
          <PropRow label="Falloff">
            <select
              value={settings.falloff ?? ""}
              title="Shared with the mesh sculptor. Hardness keeps the original terrain curve."
              onChange={(e) => setTerrainBrushSetting("falloff", e.target.value || null)}
            >
              <option value="">Hardness</option>
              {FALLOFF_CURVES.map((curve) => (
                <option key={curve.id} value={curve.id}>{curve.label}</option>
              ))}
            </select>
          </PropRow>
        </>
      )}

      {mode === "scatter" && (
        <>
          <PropRow label="Spacing">
            <NumberInput value={settings.scatterSpacing} min={0.1} step={0.25} onCommit={(v) => setTerrainBrushSetting("scatterSpacing", v)} />
          </PropRow>
          <PropRow label="Jitter">
            <NumberInput value={settings.scatterJitter} min={0} max={1} step={0.05} onCommit={(v) => setTerrainBrushSetting("scatterJitter", v)} />
          </PropRow>
        </>
      )}

      <div className="inspector-subheader">
        Scatter Layers
        {mode === "scatter" && <span style={{ opacity: 0.6, fontWeight: 400 }}> — click to select active</span>}
      </div>
      {scatterLayers.length === 0 && (
        <div className="inspector-hint" style={{ margin: "4px 2px 8px" }}>
          Add a scatter layer and choose a GLB model for rocks, bushes, trees, or props.
        </div>
      )}
      {scatterLayers.map((layer, i) => (
        <div
          key={i}
          className={`terrain-layer ${activeScatterLayer === i ? "active" : ""} ${layer.visible === false ? "hidden" : ""}`}
          onClick={() => setTerrainBrushSetting("activeScatterLayer", i)}
          title="Click to make this the active scatter layer"
        >
          <div className="terrain-layer-header">
            <span className={`terrain-layer-badge ${activeScatterLayer === i ? "active" : ""}`}>
              {activeScatterLayer === i ? <Check size={11} /> : i + 1}
            </span>
            <ScatterNameInput value={layer.name ?? `Scatter ${i + 1}`} onCommit={(name) => updateScatterLayer(i, { name })} />
            <span className="terrain-instance-count">{layer.instances?.length ?? 0}</span>
            <button
              className="icon-btn"
              title={layer.visible === false ? "Show scatter layer" : "Hide scatter layer"}
              onClick={(e) => { e.stopPropagation(); updateScatterLayer(i, { visible: layer.visible === false }); }}
            >
              {layer.visible === false ? <EyeOff size={12} /> : <Eye size={12} />}
            </button>
            <button
              className="icon-btn"
              title="Clear every instance of this layer (keeps the layer and its settings)"
              disabled={!(layer.instances?.length)}
              onClick={(e) => { e.stopPropagation(); runOnScatterLayer(entityId, (c) => c.clearScatterLayer(i)); }}
            >
              <Eraser size={12} />
            </button>
            <button className="icon-btn" title="Remove scatter layer" onClick={(e) => { e.stopPropagation(); removeScatterLayer(i); }}>
              <Trash2 size={12} />
            </button>
          </div>
          <div onClick={(e) => e.stopPropagation()}>
            <PropRow label="Source">
              <select className="select-field" value={layer.sourceType ?? "asset"} onChange={(e) => updateScatterLayer(i, { sourceType: e.target.value })}>
                <option value="asset">GLB asset</option>
                <option value="entity">Scene entity</option>
              </select>
            </PropRow>
            {(layer.sourceType ?? "asset") === "asset" ? (
              <PropRow label="Model">
                <AssetField descriptor={{ exts: MODEL_EXTENSIONS }} value={layer.model ?? ""} onCommit={(v) => updateScatterLayer(i, { model: v })} />
              </PropRow>
            ) : (
              <>
                <PropRow label="Entity">
                  <div className="camera-follow-row" style={{ margin: 0, width: "100%" }}>
                    <input
                      className="text-field"
                      readOnly
                      value={engine.getEntity(layer.sourceEntity)?.name ?? (layer.sourceEntity ? "Missing entity" : "None")}
                      title={layer.sourceEntity || "Pick an entity with a Mesh or Model component"}
                    />
                    <button
                      className="toolbar-btn"
                      onClick={() => {
                        const pick = getTerrainScatterSourcePick();
                        if (pick?.terrainEntityId === entityId && pick.layerIndex === i) disarmTerrainScatterSourcePick();
                        else armTerrainScatterSourcePick(entityId, i);
                      }}
                    >
                      {getTerrainScatterSourcePick()?.terrainEntityId === entityId && getTerrainScatterSourcePick()?.layerIndex === i ? "Cancel" : "Pick"}
                    </button>
                    <button className="toolbar-btn" disabled={!layer.sourceEntity} onClick={() => updateScatterLayer(i, { sourceEntity: "" })}>Clear</button>
                  </div>
                </PropRow>
                {engine.getEntity(layer.sourceEntity)?.getComponent("animation") && (
                  <div className="inspector-hint" style={{ margin: "2px 2px 5px" }}>
                    Animated source detected. Scatter uses its mesh as static hardware instances; independent animation requires clone mode.
                  </div>
                )}
              </>
            )}
            <ScatterPlacement
              layer={layer}
              entityId={entityId}
              layerIndex={i}
              onChange={(patch) => updateScatterLayer(i, patch)}
            />
          </div>
        </div>
      ))}
      <button className="toolbar-btn wide" onClick={addScatterLayer}>
        <Plus size={14} /> Add scatter layer
      </button>

      <div className="inspector-subheader">
        Material Layers
        {(mode === "paint" || mode === "erase") && <span style={{ opacity: 0.6, fontWeight: 400 }}> — click to select active</span>}
      </div>
      {layers.length === 0 && (
        <div className="inspector-hint" style={{ margin: "4px 2px 8px" }}>
          No layers yet. Add one and assign a material, then paint it in.
        </div>
      )}
      {layers.map((layer, i) => (
        <div
          key={i}
          className={`terrain-layer ${activeLayer === i ? "active" : ""} ${layer.visible === false ? "hidden" : ""}`}
          onClick={() => setTerrainBrushSetting("activeLayer", i)}
          title="Click to make this the active paint layer"
        >
          <div className="terrain-layer-header">
            <span className={`terrain-layer-badge ${activeLayer === i ? "active" : ""}`}>
              {activeLayer === i ? <Check size={11} /> : i + 1}
            </span>
            <span className="terrain-layer-title">Layer {i + 1}</span>
            <button
              className="icon-btn"
              title={layer.visible === false ? "Show texture layer" : "Hide texture layer"}
              onClick={(e) => { e.stopPropagation(); updateLayer(i, { visible: layer.visible === false }); }}
            >
              {layer.visible === false ? <EyeOff size={12} /> : <Eye size={12} />}
            </button>
            <button
              className="icon-btn"
              title="Remove layer"
              onClick={(e) => {
                e.stopPropagation();
                removeLayer(i);
              }}
            >
              <Trash2 size={12} />
            </button>
          </div>
          <div onClick={(e) => e.stopPropagation()}>
            <PropRow label="Material">
              <AssetField
                descriptor={{ exts: MATERIAL_EXTENSIONS }}
                value={layer.material ?? ""}
                onCommit={(v) => updateLayer(i, { material: v })}
              />
            </PropRow>
            <PropRow label="Opacity">
              <NumberInput value={layer.opacity ?? 1} min={0} max={1} step={0.05} onCommit={(v) => updateLayer(i, { opacity: v })} />
            </PropRow>
            <PropRow label="Tiling">
              <NumberInput value={layer.tiling ?? 20} min={0.01} step={0.25} onCommit={(v) => updateLayer(i, { tiling: v })} />
            </PropRow>
            <div className="camera-follow-row" style={{ margin: "4px 0 0" }}>
              <button
                className="toolbar-btn"
                disabled={!layer.material}
                onClick={() => runOnSplatLayer(entityId, i, "fill")}
              >
                Fill
              </button>
              <button
                className="toolbar-btn"
                onClick={() => runOnSplatLayer(entityId, i, "clear")}
              >
                Clear
              </button>
            </div>
          </div>
        </div>
      ))}
      <button className="toolbar-btn wide" onClick={addLayer} disabled={layers.length >= MAX_TERRAIN_LAYERS}>
        <Plus size={14} /> Add layer
      </button>
    </>
  );
}
