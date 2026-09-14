import { useEffect, useState } from "react";
import { NumberField } from "../fields/NumberField.jsx";
import { EntityField } from "../fields/EntityField.jsx";
import { Select } from "../fields/Select.jsx";
import { Leaf } from "../icons/index.jsx";
import { commandBus } from "../commands/CommandBus.js";
import { BatchCommand } from "../commands/entityCommands.js";
import { SetComponentPropCommand } from "../commands/componentCommands.js";
import { engine } from "../engineInstance.js";
import { useSceneStore } from "../store/sceneStore.js";
import { createFoliage } from "../foliageAuthoring.js";
import { FOLIAGE_CHOICES, foliagePreset, isFoliageSurface } from "../foliagePresets.js";

function Row({ label, title, children }) {
  return <div className="field-row" title={title}><span className="field-label">{label}</span>{children}</div>;
}

/** The same one-click flow for terrain, primitive meshes and imported models. */
export function FoliageSurfaceSection({ entityId, terrain = false }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const add = async (species) => {
    setBusy(true);
    setError("");
    try { await createFoliage({ species, surfaceId: entityId, parentId: entityId }); }
    catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  };
  return <div data-foliage-surface={entityId}>
    <div className="inspector-subheader"><Leaf size={13} /> Procedural Foliage</div>
    <div className="camera-follow-row">
      <button className="toolbar-btn" disabled={busy} onClick={() => add("oak")}>Trees</button>
      <button className="toolbar-btn" disabled={busy} onClick={() => add("grass")}>Grass</button>
      <button className="toolbar-btn" disabled={busy} onClick={() => add("wildflowers")}>Flowers</button>
    </div>
    <div className="inspector-hint" style={{ margin: "4px 2px 8px" }}>
      {busy ? "Creating foliage…" : terrain
        ? "Cover this terrain with a procedural layer. Foliage follows sculpted heights; each layer has its own density and slope range."
        : "Scatter over this surface. Adjust density, species and wind on the new foliage layer."}
    </div>
    {error && <div className="inspector-hint" role="alert">{error}</div>}
  </div>;
}

export function FoliageSection({ entityId, props }) {
  const [, refresh] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => refresh((value) => value + 1), 800);
    return () => clearInterval(timer);
  }, [entityId]);
  const component = engine.getEntity(entityId)?.getComponent("foliage");
  const stats = component?.stats;
  const scatter = props.distribution === "scatter";
  // Grass draws a sward rather than scattering clumps, so the controls that
  // only mean something to a scattered prototype are not shown for it.
  const drawn = props.species === "grass" && props.drawnGrass !== false;
  const commit = (key, value) => commandBus.execute(new SetComponentPropCommand(entityId, "foliage", key, value));
  const patch = (values, label) => commandBus.execute(new BatchCommand(
    Object.entries(values).map(([key, value]) => new SetComponentPropCommand(entityId, "foliage", key, value)), label));
  const number = (key, label, min, max, step = 0.1, title) => <Row label={label} title={title}>
    <NumberField value={props[key]} min={min} max={max} step={step} onCommit={(value) => commit(key, value)} />
  </Row>;
  const toggle = (key, label, title) => <Row label={label} title={title}>
    <input type="checkbox" checked={!!props[key]} onChange={(event) => commit(key, event.target.checked)} aria-label={label} />
  </Row>;
  const range = (lo, hi, label, min, max, step = 0.1, title) => <Row label={label} title={title}>
    <div className="terrain-range">
      <NumberField value={props[lo]} min={min} max={max} step={step} onCommit={(value) => patch({ [lo]: value, [hi]: Math.max(value, props[hi]) }, `Set ${label}`)} />
      <span className="terrain-range-sep">–</span>
      <NumberField value={props[hi]} min={min} max={max} step={step} onCommit={(value) => patch({ [lo]: Math.min(props[lo], value), [hi]: value }, `Set ${label}`)} />
    </div>
  </Row>;
  const colors = [["leafColor", "Foliage color"], ["barkColor", "Bark color"], ["flowerColor", "Flower color"]];
  return <div data-foliage-section={entityId}>
    <Row label="Species">
      <Select value={props.species} onChange={(event) => patch(foliagePreset(event.target.value), "Apply foliage preset")}>
        {FOLIAGE_CHOICES.map(({ species, label }) => <option key={species} value={species}>{label}</option>)}
      </Select>
    </Row>
    <Row label="Placement">
      <Select value={props.distribution} onChange={(event) => commit("distribution", event.target.value)}>
        <option value="single">Single plant</option><option value="scatter">Scatter on surface</option><option value="placements">Placed population</option>
      </Select>
    </Row>
    {props.distribution === 'placements' && <div className="inspector-hint">{props.placements?.length ?? 0} placed plants. Shape and color edits retain their positions.</div>}
    {scatter && <>
      <Row label="Surface" title="Pick a Mesh, Model, Terrain, or a group. You can also drag its hierarchy row here.">
        <EntityField value={props.surface ?? ""} onCommit={(value) => commit("surface", value)} descriptor={{
          emptyLabel: "Own mesh / parent surface",
          filter: (entity) => isFoliageSurface(entity, (id) => useSceneStore.getState().entities[id]),
        }} />
      </Row>
      {!drawn && number("density", "Plants / m²", 0, undefined, 0.01, "Coverage per square metre of surface area, capped by the instance limit.")}
      {!drawn && number("maxInstances", "Plant limit", 0, 100000, 100, "Hard limit for this foliage layer. Increase for larger areas.")}
    </>}
    {number("seed", "Seed", 0, undefined, 1)}
    <button className="toolbar-btn wide" onClick={() => commit("seed", ((props.seed ?? 1) + 1) >>> 0)}>New variation</button>

    <details open>
      <summary className="inspector-subheader">Plant shape</summary>
      {number("height", drawn ? "Blade height" : "Height", 0.05, undefined, 0.05)}
      {!drawn && number("width", "Width", 0.02, undefined, 0.05)}
      {!["grass", "wildflowers"].includes(props.species) && <>
        {number("leafDensity", "Leaf density", .5, 1.6, .05, "Amount of foliage within the crown. Higher values increase geometry cost.")}
        {number("leafSize", "Leaf size", .6, 1.5, .05, "Scale of leaves and small shoots, relative to the species default.")}
        {number("branchDensity", "Branch density", .6, 1.4, .05, "Number of branching shoots within the species' growth pattern.")}
        {number("crownBase", "Crown base offset", -.15, .2, .01, "Raise or lower the crown base by a fraction of the tree's height.")}
        {number("crownSpread", "Crown spread", .7, 1.3, .05, "Spread of the crown relative to the tree's width.")}
      </>}
      {colors.filter(([key]) => key === "leafColor" || (key === "flowerColor" ? props.species === "wildflowers" : !["grass", "wildflowers"].includes(props.species))).map(([key, label]) =>
        <Row key={key} label={label}><input className="color-field" type="color" value={props[key]} onChange={(event) => commit(key, event.target.value)} aria-label={label} /></Row>)}
    </details>
    {/* The switch lives OUTSIDE the `drawn` gate: inside it, turning the sward
        off hid the only control that could turn it back on (09-14). */}
    {props.species === "grass" && toggle("drawnGrass", "Drawn sward")}
    {drawn && <details open>
      <summary className="inspector-subheader">Grass</summary>
      <div className="inspector-hint">Grass is drawn as a continuous sward, not scattered as clumps: a few instanced
        rings follow the camera and every blade is built in the shader. Turn this off for the old scattered plants.</div>
      {number("grassDensity", "Coverage", 0, 1, .02, "Share of the blade budget that survives. The ground it grows on can thin it further.")}
      {number("blades", "Blade budget", 0, 2400000, 10000, "Blades drawn across the whole sward. This is what it costs, and the cost is linear in it.")}
      {number("bladeWidth", "Blade width", .002, .3, .002)}
      {number("grassLean", "Blade lean", 0, 1.2, .05, "How far a blade leans at rest, before any wind.")}
      {number("groundBlend", "Blend with ground", 0, 1, .05, "How much of the terrain's own colour a blade takes, so the sward meets the ground.")}
      {number("grassBrightness", "Brightness", 0, 2, .05, "Multiplies the whole sward's colour. This is the one that takes it darker than any colour picker can.")}
      {number("grassOcclusion", "Root shading", 0, 1, .05, "How dark a blade is at the litter it grows out of, compared with its tip.")}
      {number("grassVariation", "Colour variation", 0, 1, .05, "Spread of brightness between neighbouring tufts. Zero is a uniform sward.")}
      {number("grassSpecular", "Glint", 0, 1, .01, "The specular rim on a blade edge. Zero removes it; it is what makes thin grass sparkle in sunlight.")}
      {number("grassRoughness", "Roughness", 0, 1, .01)}
      {number("grassSky", "Sky light", 0, 2, .05, "How much ambient sky the sward takes. Lower it for grass in shade.")}
      {[["barkColor", "Base color"], ["leafColor", "Tip color"], ["dryColor", "Dry color"]].map(([key, label]) =>
        <Row key={key} label={label}><input className="color-field" type="color" value={props[key]} onChange={(event) => commit(key, event.target.value)} aria-label={label} /></Row>)}
    </details>}
    {scatter && !drawn && <details>
      <summary className="inspector-subheader">Placement variation</summary>
      {range("minScale", "maxScale", "Scale", 0.05, undefined, 0.05)}
      {number("minSpacing", "Spacing", 0, undefined, 0.1, "Minimum distance between plants, in metres.")}
      {range("minSlope", "maxSlope", "Slope °", 0, 180, 1, "Measured from world up. Raise the upper limit to cover walls or undersides.")}
      {range("minAltitude", "maxAltitude", "Altitude", undefined, undefined, 1, "World-space height range, in metres.")}
      {toggle("alignToNormal", "Follow normal", "Orient plants along the surface normal; turn off to keep trees upright.")}
    </details>}
    <details>
      <summary className="inspector-subheader">Wind and interaction</summary>
      {toggle("wind", "Wind")}
      {props.wind && <>
        {number("windStrength", "Wind response", 0, 2, 0.01, "How strongly this foliage responds to the Scene wind force.")}
        {number("windGustStrength", "Gust response", 0, 2, 0.05, "How strongly this foliage responds to the Scene wind gusts.")}
        {number("windScale", "Gust size", 0.5, undefined, 0.5, "World-space size of the gust pattern in metres; larger values move wider patches together.")}
        {number("windTurbulence", "Turbulence", 0, 1, 0.05, "Fine motion at leaf and blade tips, layered over the shared gust pattern.")}
        <div className="inspector-hint">Direction, force and gust frequency follow Scene → Wind.</div>
      </>}
      {toggle("interaction", "Collider bending", "Bend foliage around nearby enabled scene colliders.")}
      {props.interaction && <>
        {number("interactionStrength", "Bend strength", 0, 2, 0.05)}
        {number("interactionRadius", "Extra reach", 0, 10, 0.1)}
        <div className="inspector-hint">Nearby colliders bend plants visually. Add a collider to a solid trunk when characters should stop against it.</div>
      </>}
    </details>
    <details>
      <summary className="inspector-subheader">Distance and performance</summary>
      {number("lodNear", "Detail distance", 1, undefined, 1, drawn ? "Radius of the full-detail ring around the camera." : undefined)}
      {!drawn && number("lodFar", "Impostor distance", 2, undefined, 1)}
      {number("maxDistance", "Draw distance", 3, undefined, 1)}
      {!drawn && number("chunkSize", "Cell size", 4, 128, 1, "Smaller cells select detail more precisely; larger cells reduce CPU bookkeeping. Plant size also limits the effective cell size.")}
      {toggle("castShadow", "Cast shadows")}
      {toggle("receiveShadow", "Receive shadows")}
      <div className="inspector-hint">{drawn
        ? "A drawn sward has no impostors and no cells: it is three rings between the detail and draw distances."
        : "Detail reduces automatically with distance. Use shorter draw distances for grass and flowers, and longer distances for trees."}</div>
    </details>
    {stats && <div className="inspector-hint" role="status" style={{ margin: "6px 2px" }}>
      {Number(stats.instances ?? 0).toLocaleString()} plants · {stats.chunks ?? 0} cells · {stats.drawCalls ?? 0} draws
      {stats.status && <div>{stats.status}</div>}
    </div>}
    {component?.error && <div className="inspector-hint" role="alert">{component.error}</div>}
  </div>;
}
