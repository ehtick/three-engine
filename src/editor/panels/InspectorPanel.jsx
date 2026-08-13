// NOTE: strict type-checking intentionally not enabled here — ~25 pre-existing
// errors unrelated to events (JSX field prop-shape mismatches, missing
// Entity/Engine properties like tags/viewOnly/virtualCameras), a follow-up.
import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  X,
  Plus,
  Crosshair,
  Eye,
  EyeOff,
  ScanEye,
  Package,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  Sparkles,
  Link,
  Link2Off,
  Search,
  Pencil,
  ExternalLink,
  PanelsTopLeft,
  Waypoints,
  Layers2,
  FilePlus,
  Axis3d,
} from "lucide-react";
import { useSceneStore } from "../store/sceneStore.js";
import { useSelectionStore } from "../store/selectionStore.js";
import { getComponentClass, getComponentTypes } from "../../engine/index.js";
import { commandBus } from "../commands/CommandBus.js";
import { RenameEntityCommand, BatchCommand, SetEntityViewOnlyCommand, SetEntityPersistentCommand, SetEntityEnabledInEditorCommand, SetEntityEnabledInGameCommand, SetEntityTagsCommand } from "../commands/entityCommands.js";
import { ANCHOR_PRESETS, applyAnchorPreset } from "../../engine/ui/layout.js";
import { collectBoneNames } from "../../engine/anim/mask.js";
import { SetTransformCommand } from "../commands/transformCommands.js";
import {
  AddComponentCommand,
  RemoveComponentCommand,
  SetComponentPropCommand,
} from "../commands/componentCommands.js";
import { openPanel } from "../EditorShell.jsx";
import { engine } from "../engineInstance.js";
import { AssetField } from "../fields/AssetField.jsx";
import { PREFAB_EXTENSIONS } from "../assetLoader.js";
import { AssetInspector } from "./AssetInspector.jsx";
import { useAssetDrop } from "../assetDrag.js";
import { getEditorCameraView } from "./ViewportPanel.jsx";
import { useModulesStore } from "../modules.js";
import { usePrefabStore } from "../store/prefabStore.js";
import { prefabRegistry, diffInstance, getPrefabRoot } from "../../engine/index.js";
import { applyPrefab, revertPrefab, unpackPrefab, openPrefabMode, createVariantFromInstance } from "../prefab.js";
import { SoundSection } from "../components/SoundSection.jsx";
import { ListenerSection } from "../components/ListenerSection.jsx";
import { TerrainSection } from "../components/TerrainSection.jsx";
import { TimelineSection } from "../components/TimelineSection.jsx";
import { LinePointsSection, DecalSection, TrailSection } from "../components/VfxSections.jsx";
import { EventBindingsSection, ActionListSections } from "../components/EventSections.jsx";
import { LodSection } from "../components/LodSection.jsx";
import { ImpostorSection } from "../components/ImpostorSection.jsx";
import { SplineSection, SplineMeshSection, SplineFollowerSection } from "../components/SplineSection.jsx";
import { useGeometryEditStore } from "../store/geometryEditStore.js";
import {
  APPLY_MODES,
  APPLY_MODE_LABELS,
  applyTransformStatus,
  applyTransformToGeometry,
} from "../applyTransform.js";
import { assignTerrainAssets, createTerrainAssets } from "../terrainAssetSetup.js";
import { NumberField } from "../fields/NumberField.jsx";
import { componentIcon, groupComponentTypes } from "../componentIcons.js";
import { TagField } from "../fields/TagField.jsx";
import { PopoverMenu } from "../fields/PopoverMenu.jsx";
import { ContextMenu, useContextMenu } from "../ContextMenu.jsx";
import { createScriptFile } from "../scriptAsset.js";
import { stemToClassName } from "../scriptClassSync.js";
import { openInIDE } from "../openInIde.js";
import { GEOMETRY_MODIFIER_DEFINITIONS, createGeometryModifier } from "../../engine/geometryModifiers.js";
import { applyGeometryModifier } from "../geometryModifierEditing.js";

/**
 * Returns the live engine entity referenced by `targetId` (the value stored
 * on the camera's `followTarget` prop), or null when nothing is set / the
 * referenced entity no longer exists.
 */
function resolveFollowEntity(targetId) {
  if (!targetId) return null;
  return engine.getEntity(targetId) ?? null;
}

/**
 * Drives the "Pick" interaction for the camera's follow target. We can't
 * reuse the standard pointer-pick path because that lives on the viewport
 * canvas — and the user is interacting with the inspector. Instead, when
 * picking is active, the next click on the hierarchy panel selects the
 * clicked entity and we then set that as the follow target. We arm
 * picking via a single module-level flag so the hierarchy panel can poll
 * it from its existing click handler.
 */
let followPickArmed = false;
export function isFollowPickArmed() {
  return followPickArmed;
}
export function armFollowPick() {
  followPickArmed = true;
}
export function disarmFollowPick() {
  followPickArmed = false;
}

/**
 * Independent pick-flag for the InstancerComponent "Surface Entity" picker.
 * Separate from the camera-follow flag so the two pickers don't fight each
 * other. The hierarchy panel polls all pick-armed flags and treats the first
 * one set as the active consumer.
 */
let surfacePickArmed = false;
export function isSurfacePickArmed() {
  return surfacePickArmed;
}
export function armSurfacePick() {
  surfacePickArmed = true;
}
export function disarmSurfacePick() {
  surfacePickArmed = false;
}
/** Read whether any picker is currently armed (used by HierarchyPanel). */
export function isAnyPickArmed() {
  return followPickArmed || surfacePickArmed;
}

/**
 * UI components (`uielement`, `uiimage`, `uitext`, `uibutton`, `uilayout`,
 * `uiscroll`, `uimask`) only make sense as descendants of a UI Screen. Walks
 * the parent chain of `entityId` (inclusive) and returns true if any entity
 * along the way carries a `uiscreen` component. Used to gate the Add
 * Component dropdown so non-UI entities don't see UI-only options.
 *
 * Reads the live engine (not the scene mirror) because the helper can be
 * called for ids not yet mirrored in React state, and the engine is the
 * source of truth anyway.
 */
export function isInsideUiScreen(entityId) {
  if (!entityId) return false;
  let entity = engine.getEntity(entityId);
  while (entity) {
    if (entity.getComponent?.("uiscreen")) return true;
    entity = entity.parent;
  }
  return false;
}

const RAD2DEG = 180 / Math.PI;
const DEG2RAD = Math.PI / 180;

const AXES = ["x", "y", "z"];

/**
 * One axis cell: a coloured X/Y/Z tag welded to its number field. The tag is
 * the standard DCC convention (red/green/blue = X/Y/Z) and does the work three
 * unlabelled boxes in a row can't — you can tell at a glance which one is Z
 * without counting from the left.
 */
function AxisField({ axis, value, mixed, onCommit, step }) {
  return (
    <div className={`axis-field axis-${axis}`}>
      <span className="axis-tag">{axis.toUpperCase()}</span>
      <NumberField value={value} mixed={mixed} step={step} onCommit={onCommit} />
    </div>
  );
}

function Vector3Row({ label, values, onCommit, step }) {
  return (
    <div className="field-row">
      <span className="field-label">{label}</span>
      <div className="vector-fields">
        {AXES.map((axis, i) => (
          <AxisField
            key={axis}
            axis={axis}
            value={values[i]}
            step={step}
            onCommit={(v) => {
              const next = [...values];
              next[i] = v;
              onCommit(next);
            }}
          />
        ))}
      </div>
    </div>
  );
}

const UNIFORM_SCALE_KEY = "engine.inspector.uniformScale.v1";

/**
 * "Constrain proportions" for the Scale row. Editing one axis drives the other
 * two by the same ratio, so scaling a model up stays a scale rather than a
 * squash. Persisted because it's a working preference, not scene data — the
 * user who wants it on wants it on for every object they touch that session.
 */
function useUniformScale() {
  const [locked, setLocked] = useState(() => localStorage.getItem(UNIFORM_SCALE_KEY) === "1");
  const toggle = () =>
    setLocked((prev) => {
      localStorage.setItem(UNIFORM_SCALE_KEY, prev ? "0" : "1");
      return !prev;
    });
  return [locked, toggle];
}

/** Applies a single-axis scale edit to all three axes, preserving ratios. */
function uniformScale(previous, axis, value) {
  const from = previous[axis];
  // A zero (or absent) source axis has no ratio to preserve — the only sane
  // reading of "make X 3 while locked" is a cube scale of 3.
  if (!from) return [value, value, value];
  const ratio = value / from;
  return previous.map((v) => parseFloat((v * ratio).toPrecision(7)));
}

function ScaleRow({ values, onCommit, locked, onToggleLock }) {
  return (
    <div className="field-row">
      <span className="field-label">Scale</span>
      <div className="vector-fields">
        {AXES.map((axis, i) => (
          <AxisField
            key={axis}
            axis={axis}
            value={values[i]}
            onCommit={(v) => {
              if (locked) return onCommit(uniformScale(values, i, v));
              const next = [...values];
              next[i] = v;
              onCommit(next);
            }}
          />
        ))}
      </div>
      <button
        className={`icon-btn lock-btn ${locked ? "active-toggle" : ""}`}
        title={locked ? "Proportions locked — click to scale axes independently" : "Scale axes independently — click to lock proportions"}
        onClick={onToggleLock}
      >
        {locked ? <Link size={12} /> : <Link2Off size={12} />}
      </button>
    </div>
  );
}

/**
 * True when the entity carries a directional light. Directional lights are
 * infinite sources — only their rotation matters — so position/scale controls
 * are hidden from the inspector and locked at the world origin.
 */
function isDirectionalLightEntity(entity) {
  const live = engine.getEntity(entity.id);
  const component = live?.getComponent?.("light");
  return !!component && component.props?.kind === "directional";
}

/** Session-only transform copy buffer — the Transform section's Copy/Paste. */
let transformClipboard = null;

const IDENTITY_TRANSFORM = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };

function TransformSection({ entity }) {
  const { position, rotation, scale } = entity.transform;
  const rotationDeg = rotation.map((r) => r * RAD2DEG);
  const lockNonRotation = isDirectionalLightEntity(entity);
  const [uniform, toggleUniform] = useUniformScale();

  const commit = (patch) => {
    commandBus.execute(new SetTransformCommand(entity.id, { ...entity.transform, ...patch }));
  };

  const { menu, open: openMenu, close: closeMenu } = useContextMenu();
  const menuItems = [
    { label: "Reset Position", action: () => commit({ position: [...IDENTITY_TRANSFORM.position] }) },
    { label: "Reset Rotation", action: () => commit({ rotation: [...IDENTITY_TRANSFORM.rotation] }) },
    { label: "Reset Scale", action: () => commit({ scale: [...IDENTITY_TRANSFORM.scale] }) },
    { label: "Reset Transform", action: () => commit(structuredClone(IDENTITY_TRANSFORM)) },
    { separator: true },
    {
      label: "Copy Transform",
      action: () => (transformClipboard = structuredClone(entity.transform)),
    },
    {
      label: "Paste Transform",
      disabled: !transformClipboard,
      action: () => commit(structuredClone(transformClipboard)),
    },
  ];

  return (
    <div className="inspector-section" onContextMenu={openMenu}>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={closeMenu} />}
      <div className="section-header">Transform</div>
      {!lockNonRotation && (
        <Vector3Row label="Position" values={position} onCommit={(v) => commit({ position: v })} />
      )}
      <Vector3Row
        label="Rotation"
        values={rotationDeg}
        step={1}
        onCommit={(v) => commit({ rotation: v.map((d) => d * DEG2RAD) })}
      />
      {!lockNonRotation && (
        <ScaleRow
          values={scale}
          locked={uniform}
          onToggleLock={toggleUniform}
          onCommit={(v) => commit({ scale: v })}
        />
      )}
    </div>
  );
}

const fileName = (p) => p?.split(/[\\/]/).pop() ?? "";

/** Text field that doubles as a drop target for Assets-panel paths. */
function TextPropField({ value, onCommit, readOnly = false, mixed = false }) {
  const dropRef = useAssetDrop({
    accepts: (path, isDir) => !readOnly && !isDir,
    onDrop: onCommit,
  });
  return (
    <input
      className="text-field"
      type="text"
      key={`${mixed ? "mixed" : "value"}-${value}`}
      defaultValue={mixed ? "" : value}
      placeholder={mixed ? "— Mixed —" : undefined}
      ref={dropRef}
      readOnly={readOnly}
      onBlur={(e) => {
        const initial = mixed ? "" : String(value ?? "");
        if (!readOnly && e.target.value !== initial) onCommit(e.target.value);
      }}
    />
  );
}

/** Handles both `vec3` and `vec2` — the axis count is the only difference, and
 *  a second near-identical component would be one more place to fix a bug. */
function Vec3PropField({ value, onCommit, mixed = [], axes = 3 }) {
  const values = Array.isArray(value) ? value : new Array(axes).fill(0);
  return (
    <div className="vector-fields">
      {Array.from({ length: axes }, (_, i) => i).map((i) => (
        <AxisField
          key={i}
          axis={AXES[i]}
          value={values[i] ?? 0}
          mixed={!!mixed[i]}
          onCommit={(v) => {
            const next = [...values];
            next[i] = v;
            onCommit(next, i);
          }}
        />
      ))}
    </div>
  );
}

function MixedCheckbox({ checked, mixed, onChange, ...props }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!mixed;
  }, [mixed]);
  return <input ref={ref} type="checkbox" checked={!mixed && !!checked} onChange={onChange} {...props} />;
}

const valuesEqual = (a, b) => {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => valuesEqual(value, b[index]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    return aKeys.length === bKeys.length && aKeys.every((key) => valuesEqual(a[key], b[key]));
  }
  return false;
};

function MultiTransformSection({ entities }) {
  const primary = entities[0];
  // Directional lights have no positional/scale state — only rotation
  // changes their behaviour. If every selected entity is a directional light
  // we collapse the transform panel to a single Rotation row.
  const allDirectional = entities.every(isDirectionalLightEntity);
  const [uniform, toggleUniform] = useUniformScale();
  const rows = allDirectional
    ? [["Rotation", "rotation", RAD2DEG]]
    : [
        ["Position", "position", 1],
        ["Rotation", "rotation", RAD2DEG],
        ["Scale", "scale", 1],
      ];
  const commitAxis = (key, axis, displayValue, displayScale) => {
    const value = displayValue / displayScale;
    const commands = entities.map((entity) => {
      const before = engine.getEntity(entity.id)?.getTransform() ?? entity.transform;
      const next = { ...before, [key]: [...before[key]] };
      // Locked proportions apply per entity against that entity's own scale,
      // so a mixed selection keeps each object's shape instead of snapping
      // them all to the primary's ratios.
      if (key === "scale" && uniform) next[key] = uniformScale(before[key], axis, value);
      else next[key][axis] = value;
      return new SetTransformCommand(entity.id, next, before);
    });
    commandBus.execute(new BatchCommand(commands, `Transform ${entities.length} entities`));
  };

  return (
    <div className="inspector-section">
      <div className="section-header">Transform</div>
      {rows.map(([label, key, displayScale]) => (
        <div className="field-row" key={key}>
          <span className="field-label">{label}</span>
          <div className="vector-fields">
            {[0, 1, 2].map((axis) => {
              const values = entities.map((entity) => entity.transform[key][axis]);
              return (
                <AxisField
                  key={axis}
                  axis={AXES[axis]}
                  step={key === "rotation" ? 1 : 0.1}
                  value={primary.transform[key][axis] * displayScale}
                  mixed={!values.every((value) => Object.is(value, values[0]))}
                  onCommit={(value) => commitAxis(key, axis, value, displayScale)}
                />
              );
            })}
          </div>
          {key === "scale" && (
            <button
              className={`icon-btn lock-btn ${uniform ? "active-toggle" : ""}`}
              title={uniform ? "Proportions locked — click to scale axes independently" : "Scale axes independently — click to lock proportions"}
              onClick={toggleUniform}
            >
              {uniform ? <Link size={12} /> : <Link2Off size={12} />}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * Picks another entity in the scene. The value stored is the entity id, so it
 * survives renames; the dropdown shows names, disambiguated by their parent
 * when two siblings share one (which is common — "Door", "Door").
 *
 * Known limitation: an id reference authored INSIDE a prefab does not survive
 * instantiation (prefab expansion mints fresh ids and does not rewrite props),
 * so inside a prefab, reference an ancestor or leave it empty for "the world".
 */
function EntityRefField({ descriptor, value, onCommit }) {
  const entities = useSceneStore((s) => s.entities);
  const options = Object.values(entities ?? {})
    .filter((e) => !descriptor.filter || descriptor.filter(e))
    .map((e) => {
      const parent = e.parentId ? entities[e.parentId]?.name : null;
      return { id: e.id, label: parent ? `${e.name}  ·  ${parent}` : e.name };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
  const missing = value && !entities?.[value];
  return (
    <select className="select-field" value={value ?? ""} onChange={(e) => onCommit(e.target.value)}>
      <option value="">{descriptor.emptyLabel ?? "— None —"}</option>
      {missing && <option value={value}>— Missing —</option>}
      {options.map((opt) => (
        <option key={opt.id} value={opt.id}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}

/**
 * One typed property editor, chosen by `descriptor.type`.
 *
 * Exported so sections living in their own files (the event wiring in
 * `components/EventSections.jsx`) render entity pickers, asset pickers and
 * selects identically to the generic field list rather than growing a second,
 * slightly-different set.
 */
export function PropField({ descriptor, value, onCommit, mixed = false, mixedAxes = [] }) {
  switch (descriptor.type) {
    case "asset":
      return <AssetField descriptor={descriptor} value={mixed ? "" : value} onCommit={onCommit} />;
    // A prefab reference: an asset picker pinned to prefab files. The value is
    // the asset path, which is exactly what `engine.instantiate()` takes.
    case "prefab":
      return (
        <AssetField
          descriptor={{ ...descriptor, exts: PREFAB_EXTENSIONS }}
          value={mixed ? "" : value}
          onCommit={onCommit}
        />
      );
    case "vec3":
      return <Vec3PropField value={value} mixed={mixedAxes} onCommit={onCommit} />;
    case "vec2":
      return <Vec3PropField value={value} mixed={mixedAxes} onCommit={onCommit} axes={2} />;
    case "number":
      return (
        <NumberField
          value={value}
          mixed={mixed}
          min={descriptor.min}
          max={descriptor.max}
          step={descriptor.step}
          onCommit={onCommit}
        />
      );
    case "color":
      return (
        <input
          type="color"
          value={value}
          className={`color-field${mixed ? " mixed" : ""}`}
          onChange={(e) => onCommit(e.target.value)}
        />
      );
    // Entity reference — a joint's connected body, a camera's follow target.
    // Stores the entity id; empty means "none" (which several components read
    // as "the world" or "no target").
    case "entity":
      return <EntityRefField descriptor={descriptor} value={mixed ? "" : value} onCommit={onCommit} />;
    case "select": {
      // `options` may be a function so a schema can offer choices that are
      // only known at runtime — the physics Layer dropdown reads the project's
      // layer names, which load long after the component class does.
      const options =
        typeof descriptor.options === "function" ? descriptor.options() ?? [] : descriptor.options ?? [];
      // A value saved before the option list changed (a renamed layer) would
      // otherwise render as a blank select that silently rewrites the prop on
      // the next change. Show it, marked, until the user picks something.
      const stale = !mixed && value != null && value !== "" && !options.includes(value);
      // A DOM <select>'s value is ALWAYS a string, so committing `e.target.value`
      // raw wrote "2" for a numeric option list of [2, 4]. Nothing matched it
      // afterwards: the field rendered "2 (missing)" forever, and consumers doing
      // the natural strict compare silently took their fallback branch —
      // GISystem's `props.c0DirRes === 2 ? 2 : 4` read a user's saved "2" as 4 for
      // as long as that scene existed. Map back onto the option's OWN value so a
      // number stays a number and a string stays a string.
      const commitOption = (raw) => {
        const match = options.find((opt) => String(opt) === raw);
        onCommit(match === undefined ? raw : match);
      };
      return (
        <select className="select-field" value={mixed ? "" : value} onChange={(e) => commitOption(e.target.value)}>
          {mixed && <option value="">— Mixed —</option>}
          {stale && <option value={value}>{`${value} (missing)`}</option>}
          {options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      );
    }
    case "boolean":
      return (
        <MixedCheckbox checked={value} mixed={mixed} onChange={(e) => onCommit(e.target.checked)} />
      );
    default:
      return <TextPropField value={value} mixed={mixed} onCommit={onCommit} readOnly={descriptor.readOnly} />;
  }
}

const SCRIPT_FILE_EXTS = ["js", "ts"];

/** An empty slot, so "Add Script" and a file drop agree on the shape. */
const emptyScriptSlot = () => ({ path: "", enabled: true, attributes: {} });

/**
 * The Scripts section: a reorderable list of script slots, each with its own
 * file, enable toggle and `@attribute` fields.
 *
 * One entity holds many scripts (see `ScriptComponent`), so this replaces what
 * used to be a single "File" field plus one flat attribute list. Every edit
 * rewrites the whole `scripts` array through `SetComponentPropCommand`, which
 * keeps undo/redo and prefab-override derivation working without any
 * script-specific plumbing in either.
 */
/**
 * The "New" button on a script slot: names the file inline, then creates it in
 * `<root>/scripts` and assigns it to that slot. Authoring a behaviour otherwise
 * meant leaving the inspector for the Assets panel, making the file there, and
 * coming back to point the slot at it.
 */
function NewScriptButton({ defaultName, onCreated }) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const create = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const path = await createScriptFile({ name: name.trim() || defaultName });
      onCreated(path);
      setNaming(false);
      setName("");
    } catch (err) {
      console.error(`Could not create script: ${err.message ?? err}`);
    } finally {
      setBusy(false);
    }
  };

  if (naming) {
    return (
      <input
        className="text-field script-name-input"
        autoFocus
        spellCheck={false}
        placeholder={defaultName}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => setNaming(false)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") create();
          else if (e.key === "Escape") setNaming(false);
        }}
      />
    );
  }
  return (
    <button
      className="icon-btn"
      title="Create a new script and assign it to this slot"
      onClick={() => setNaming(true)}
    >
      <FilePlus size={12} />
    </button>
  );
}

function ScriptsSection({ entityId, props }) {
  const [, bump] = useState(0);
  // Attribute descriptors only exist once a module has loaded, so re-render on
  // load. Also covers hot reload adding or removing an @attribute.
  useEffect(() => engine.on("script-loaded", () => bump((v) => v + 1)), []);

  const component = engine.getEntity(entityId)?.getComponent("script");
  const slots = props.scripts ?? [];
  // Name the file after the entity by default — "PlayerController.ts" beats
  // "NewScript 3.ts" when you come back to the project a week later.
  const defaultScriptName = `${stemToClassName(engine.getEntity(entityId)?.name ?? "New") || "New"}Script.ts`;

  const commit = (next, label) =>
    commandBus.execute(new SetComponentPropCommand(entityId, "script", "scripts", next, label));

  const updateSlot = (index, patch, label) =>
    commit(
      slots.map((slot, i) => (i === index ? { ...slot, ...patch } : slot)),
      label,
    );

  const move = (index, delta) => {
    const target = index + delta;
    if (target < 0 || target >= slots.length) return;
    const next = [...slots];
    [next[index], next[target]] = [next[target], next[index]];
    commit(next, "Reorder scripts");
  };

  return (
    <>
      {slots.map((slot, index) => {
        const defs = component?.getAttributeDefs(index) ?? {};
        const enabled = slot.enabled !== false;
        return (
          <div className="script-slot" key={index}>
            <div className="field-row script-file-row">
              <AssetField
                descriptor={{ key: `script-${index}`, label: "File", exts: SCRIPT_FILE_EXTS }}
                value={slot.path ?? ""}
                onCommit={(path) => updateSlot(index, { path }, "Set script")}
              />
              {/* The six actions travel as one cluster so they can wrap to
                  their own line together when the inspector is narrow. Seven
                  controls sharing one row shrank the file field to "B..", which
                  is the one thing in the row that has to stay readable. */}
              <div className="script-slot-actions">
                {/* Two ways out to the same file. The Code panel is first and
                    keeps the pencil because editing a script without leaving the
                    app is the default we want; "Open in IDE" stays one click away
                    for when the user genuinely wants their own setup. */}
                <button
                  className="icon-btn"
                  title={
                    slot.path
                      ? `Edit ${slot.path.split(/[\\/]/).pop()} in the Code panel`
                      : "Assign a script first"
                  }
                  disabled={!slot.path}
                  // Lazy, like openAsset.js's own use of it: codeStore pulls in
                  // the Monaco setup module, and the Inspector opens far more
                  // often than this button is pressed.
                  onClick={() => import("../codeStore.js").then((m) => m.openCodeFile(slot.path))}
                >
                  <Pencil size={12} />
                </button>
                <button
                  className="icon-btn"
                  title={
                    slot.path
                      ? `Open ${slot.path.split(/[\\/]/).pop()} in your IDE`
                      : "Assign a script first"
                  }
                  disabled={!slot.path}
                  onClick={() => openInIDE(slot.path)}
                >
                  <ExternalLink size={12} />
                </button>
                <NewScriptButton
                  defaultName={defaultScriptName}
                  onCreated={(path) => updateSlot(index, { path }, "Create script")}
                />
                <button
                  className="icon-btn"
                  title={enabled ? "Disable this script" : "Enable this script"}
                  onClick={() => updateSlot(index, { enabled: !enabled }, "Toggle script")}
                >
                  {enabled ? <Eye size={12} /> : <EyeOff size={12} />}
                </button>
                <button
                  className="icon-btn"
                  title="Move up (runs earlier)"
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  <ChevronUp size={12} />
                </button>
                <button
                  className="icon-btn"
                  title="Move down (runs later)"
                  disabled={index === slots.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ChevronDown size={12} />
                </button>
                <button
                  className="icon-btn"
                  title="Remove this script"
                  onClick={() =>
                    commit(
                      slots.filter((_, i) => i !== index),
                      "Remove script",
                    )
                  }
                >
                  <X size={12} />
                </button>
              </div>
            </div>
            {Object.entries(defs).map(([key, def]) => (
              <div className="field-row" key={key}>
                <span className="field-label indented">{def.label ?? key}</span>
                <PropField
                  descriptor={{ key, label: key, type: def.type ?? "number", ...def }}
                  value={slot.attributes?.[key] ?? def.default}
                  onCommit={(v) =>
                    updateSlot(
                      index,
                      { attributes: { ...slot.attributes, [key]: v } },
                      `Set ${key}`,
                    )
                  }
                />
              </div>
            ))}
          </div>
        );
      })}
      <div className="script-add-row">
        <button
          className="toolbar-btn wide"
          onClick={() => commit([...slots, emptyScriptSlot()], "Add script")}
        >
          <Plus size={12} /> Add Script
        </button>
        <button
          className="toolbar-btn"
          title={`Create ${defaultScriptName} in scripts/ and attach it`}
          onClick={async () => {
            try {
              const path = await createScriptFile({ name: defaultScriptName });
              commit([...slots, { ...emptyScriptSlot(), path }], "Add script");
            } catch (err) {
              console.error(`Could not create script: ${err.message ?? err}`);
            }
          }}
        >
          <FilePlus size={12} /> New
        </button>
      </div>
    </>
  );
}

/**
 * Camera-only follow section. Renders three controls on the camera's
 * component panel:
 *   - Follow target: a text field showing the live entity name (or id when
 *     the entity has been deleted), with Pick / Clear buttons. Picking arms
 *     the hierarchy panel to consume the next row click as the target.
 *   - Viewport / Game checkboxes: enable follow while editing / playing.
 *   - Show preview checkbox: editor-only PIP toggle.
 */
function CameraFollowSection({ entityId, props }) {
  const [, force] = useState(0);
  // Mirror the live engine prop values into local state so toggles reflect
  // the current camera (the scene mirror doesn't refresh on prop changes).
  useEffect(() => {
    const onChange = (info) => {
      if (info.entityId === entityId && info.componentType === "camera") force((v) => v + 1);
    };
    return engine.on("component-changed", onChange);
  }, [entityId]);

  const target = resolveFollowEntity(props.followTarget);
  const targetLabel = target ? target.name : props.followTarget || "";
  const targetMissing = !!props.followTarget && !target;

  const commitProp = (key, value) =>
    commandBus.execute(new SetComponentPropCommand(entityId, "camera", key, value));

  return (
    <>
      <div className="inspector-subheader">Follow target</div>
      <div className="camera-follow-row">
        <input
          className={`text-field ${targetMissing ? "missing-ref" : ""}`}
          type="text"
          value={targetLabel}
          placeholder="(none)"
          readOnly
          title={targetMissing ? "Referenced entity no longer exists" : "Entity to look at"}
        />
        <button
          className="toolbar-btn"
          title="Pick an entity from the hierarchy as the follow target"
          onClick={() => {
            if (isFollowPickArmed()) disarmFollowPick();
            else armFollowPick();
            force((v) => v + 1);
          }}
        >
          {isFollowPickArmed() ? "Cancel" : "Pick"}
        </button>
        <button
          className="toolbar-btn"
          title="Clear the follow target"
          disabled={!props.followTarget}
          onClick={() => commitProp("followTarget", null)}
        >
          Clear
        </button>
      </div>
      <div className="camera-follow-toggles">
        <label className="field-row inline">
          <input
            type="checkbox"
            checked={!!props.followInViewport}
            onChange={(e) => commitProp("followInViewport", e.target.checked)}
          />
          <span>Viewport</span>
        </label>
        <label className="field-row inline">
          <input
            type="checkbox"
            checked={!!props.followInGame}
            onChange={(e) => commitProp("followInGame", e.target.checked)}
          />
          <span>Game</span>
        </label>
      </div>
      <label className="field-row inline preview-toggle">
        <input
          type="checkbox"
          checked={props.showPreview !== false}
          onChange={(e) => commitProp("showPreview", e.target.checked)}
        />
        {props.showPreview !== false ? <Eye size={12} /> : <EyeOff size={12} />}
        <span>Show preview</span>
      </label>
    </>
  );
}

/**
 * Instancer-only section: appears when scatterShape === "onMesh". Renders a
 * Pick / Clear pair for the surface entity, plus helper text describing the
 * current projected-mode center. Mirrors the camera-follow picker UX so users
 * have one mental model for "pick from hierarchy".
 */
function InstancerSurfaceSection({ entityId, props }) {
  const [, force] = useState(0);
  // Mirror the live prop so the picker row reflects the picked entity name
  // (and any entity-deletion events).
  useEffect(() => {
    const onChange = (info) => {
      if (info.entityId === entityId && info.componentType === "instancer") force((v) => v + 1);
    };
    const onHierarchy = () => force((v) => v + 1);
    return () => {}; // noop cleanup; force is idempotent
  }, [entityId]);

  const targetId = props.scatterSurfaceEntity;
  const target = targetId ? engine.getEntity(targetId) : null;
  const targetLabel = target ? target.name : targetId || "";
  const targetMissing = !!targetId && !target;
  const surfaceMode = props.scatterSurfaceMode ?? "whole";

  const commitProp = (key, value) =>
    commandBus.execute(new SetComponentPropCommand(entityId, "instancer", key, value));

  return (
    <>
      <div className="inspector-subheader">Surface</div>
      <div className="camera-follow-row">
        <input
          className={`text-field ${targetMissing ? "missing-ref" : ""}`}
          type="text"
          value={targetLabel}
          placeholder="(self)"
          readOnly
          title={
            targetMissing
              ? "Referenced entity no longer exists — falling back to this entity's mesh"
              : target
                ? "Mesh/Model whose surface is scattered on"
                : "Empty = use this entity's own Mesh/Model component"
          }
        />
        <button
          className="toolbar-btn"
          title="Pick an entity from the hierarchy to scatter on its surface"
          onClick={() => {
            if (isSurfacePickArmed()) disarmSurfacePick();
            else armSurfacePick();
            force((v) => v + 1);
          }}
        >
          {isSurfacePickArmed() ? "Cancel" : "Pick"}
        </button>
        <button
          className="toolbar-btn"
          title="Clear — scatter on this entity's own mesh"
          disabled={!targetId}
          onClick={() => commitProp("scatterSurfaceEntity", "")}
        >
          Clear
        </button>
      </div>
      {surfaceMode === "projected" && (
        <div className="field-row" style={{ opacity: 0.75 }}>
          <span className="field-label" />
          <span className="inspector-hint">
            Points inside the projected shape are cast onto the surface along the chosen axis.
          </span>
        </div>
      )}
    </>
  );
}

/** Two-number field (anchors, pivot, pos, size). */
function Vec2PropField({ value, onCommit, labels = ["X", "Y"], step = 1 }) {
  const values = Array.isArray(value) ? value : [0, 0];
  return (
    <div className="vector-fields">
      {[0, 1].map((i) => (
        <NumberField
          key={`${i}-${labels[i]}`}
          value={values[i] ?? 0}
          step={step}
          onCommit={(v) => {
            const next = [...values];
            next[i] = v;
            onCommit(next);
          }}
        />
      ))}
    </div>
  );
}

const EPSILON = 1e-6;
const POINT_PRESETS = [
  ["top-left", "top", "top-right"],
  ["left", "center", "right"],
  ["bottom-left", "bottom", "bottom-right"],
];

/** Name of the matching preset for the current anchors/pivot, or null. */
function matchAnchorPreset(props) {
  for (const [name, preset] of Object.entries(ANCHOR_PRESETS)) {
    const same = (a, b) => Math.abs(a[0] - b[0]) < EPSILON && Math.abs(a[1] - b[1]) < EPSILON;
    if (
      same(preset.anchorMin, props.anchorMin ?? [0.5, 0.5]) &&
      same(preset.anchorMax, props.anchorMax ?? [0.5, 0.5])
    ) {
      return name;
    }
  }
  return null;
}

/**
 * Custom inspector for the UI Element rect: a 3×3 anchor-preset grid plus
 * stretch buttons, then pos/size fields whose labels adapt to the anchoring
 * (Unity-style: point-anchored = X/Y + W/H, stretched = insets from edges).
 */
function UiElementSection({ entityId, props }) {
  const commit = (key, value) =>
    commandBus.execute(new SetComponentPropCommand(entityId, "uielement", key, value));

  const applyPreset = (name) => {
    const next = applyAnchorPreset(name, props.size);
    if (!next) return;
    const cmds = Object.entries(next).map(
      ([key, value]) => new SetComponentPropCommand(entityId, "uielement", key, value),
    );
    commandBus.execute(new BatchCommand(cmds, `Anchor: ${name}`));
  };

  const active = matchAnchorPreset(props);
  const stretchX = (props.anchorMax?.[0] ?? 0.5) - (props.anchorMin?.[0] ?? 0.5) > EPSILON;
  const stretchY = (props.anchorMax?.[1] ?? 0.5) - (props.anchorMin?.[1] ?? 0.5) > EPSILON;

  const posLabels = [stretchX ? "Left" : "X", stretchY ? "Top" : "Y"];
  const sizeLabels = [stretchX ? "Right" : "W", stretchY ? "Bottom" : "H"];

  const el = engine.getEntity(entityId)?.getComponent("uielement");
  const layoutControlled = !!el?.layoutControlled;

  return (
    <>
      <div className="field-row">
        <span className="field-label">Anchor</span>
        <div className="anchor-preset-wrap">
          <div className="anchor-preset-grid">
            {POINT_PRESETS.flat().map((name) => (
              <button
                key={name}
                className={`anchor-preset-cell ${active === name ? "active" : ""}`}
                title={name}
                onClick={() => applyPreset(name)}
              >
                <span className="anchor-dot" />
              </button>
            ))}
          </div>
          <div className="anchor-preset-stretch">
            {["stretch-x", "stretch-y", "stretch"].map((name) => (
              <button
                key={name}
                className={`toolbar-btn tiny ${active === name ? "active" : ""}`}
                title={name}
                onClick={() => applyPreset(name)}
              >
                {name === "stretch-x" ? "↔" : name === "stretch-y" ? "↕" : "⛶"}
              </button>
            ))}
          </div>
        </div>
      </div>
      {layoutControlled && (
        <div className="field-row">
          <span className="field-label" style={{ opacity: 0.6 }}>
            Positioned by parent UI Layout
          </span>
        </div>
      )}
      <div className="field-row">
        <span className="field-label">{posLabels.join(" / ")}</span>
        <Vec2PropField value={props.pos} labels={posLabels} onCommit={(v) => commit("pos", v)} />
      </div>
      <div className="field-row">
        <span className="field-label">{sizeLabels.join(" / ")}</span>
        <Vec2PropField value={props.size} labels={sizeLabels} onCommit={(v) => commit("size", v)} />
      </div>
      <div className="field-row">
        <span className="field-label">Pivot</span>
        <Vec2PropField value={props.pivot} step={0.1} onCommit={(v) => commit("pivot", v)} />
      </div>
      <div className="field-row">
        <span className="field-label">Opacity</span>
        <NumberField value={props.opacity ?? 1} min={0} max={1} step={0.05} onCommit={(v) => commit("opacity", v)} />
      </div>
      <div className="field-row">
        <span className="field-label">Visible</span>
        <input type="checkbox" checked={props.visible !== false} onChange={(e) => commit("visible", e.target.checked)} />
      </div>
      <div className="field-row">
        <span className="field-label">Raycast Target</span>
        <input
          type="checkbox"
          checked={props.raycastTarget !== false}
          onChange={(e) => commit("raycastTarget", e.target.checked)}
        />
      </div>
    </>
  );
}

const MATERIAL_SLOT_KEYS = [
  "material",
  "material2",
  "material3",
  "material4",
  "material5",
  "material6",
  "material7",
  "material8",
];

/**
 * The Mesh component's material list.
 *
 * A mesh has eight slots in its data model (one per geometry group), but
 * almost every mesh uses exactly one. Showing all eight pickers made the Mesh
 * inspector seven rows of noise; this renders only the slots in use plus an
 * "Add Material Slot" button, so the extra capacity is there when authored
 * multi-group geometry needs it and invisible when it doesn't.
 *
 * Removing a slot shifts the ones below it up, because slot index *is* the
 * geometry group index — leaving a hole would silently repaint a different
 * part of the mesh.
 */
function MaterialSlotsSection({ entityId, props }) {
  const filled = MATERIAL_SLOT_KEYS.reduce(
    (last, key, index) => (props[key] ? index + 1 : last),
    0,
  );
  const [shown, setShown] = useState(filled);
  // A different entity (or one whose slots changed underneath us, e.g. undo)
  // resets the manual "show one more empty slot" state.
  useEffect(() => setShown(filled), [entityId, filled]);
  const count = Math.max(1, shown, filled);

  const values = MATERIAL_SLOT_KEYS.map((key) => props[key] ?? "");

  const commitSlots = (next, label) => {
    // Only the slots that actually moved become commands — a slot removal
    // renumbers the tail, and writing all eight every time would put seven
    // no-op prop changes into the undo entry.
    const commands = [];
    MATERIAL_SLOT_KEYS.forEach((key, index) => {
      const value = next[index] ?? "";
      if (value !== values[index]) {
        commands.push(new SetComponentPropCommand(entityId, "mesh", key, value));
      }
    });
    if (!commands.length) return;
    commandBus.execute(new BatchCommand(commands, label));
  };

  const setSlot = (index, value) => {
    const next = [...values];
    next[index] = value;
    commitSlots(next, index === 0 ? "Set material" : `Set material slot ${index + 1}`);
  };

  const removeSlot = (index) => {
    const next = [...values];
    next.splice(index, 1);
    next.push("");
    commitSlots(next, `Remove material slot ${index + 1}`);
    setShown(Math.max(1, count - 1));
  };

  return (
    <>
      {Array.from({ length: count }, (_, index) => (
        <div className="field-row" key={MATERIAL_SLOT_KEYS[index]}>
          <span className="field-label">{count === 1 ? "Material" : `Material ${index + 1}`}</span>
          <AssetField
            descriptor={{
              key: MATERIAL_SLOT_KEYS[index],
              label: "Material",
              exts: ["mat"],
              emptyLabel: index === 0 ? "Default" : "None",
            }}
            value={values[index]}
            onCommit={(value) => setSlot(index, value)}
          />
          {count > 1 && (
            <button
              className="icon-btn"
              title={`Remove slot ${index + 1} (later slots shift up)`}
              onClick={() => removeSlot(index)}
            >
              <X size={12} />
            </button>
          )}
        </div>
      ))}
      {count < MATERIAL_SLOT_KEYS.length && (
        <button
          className="toolbar-btn subtle wide"
          title="Add another material slot — used by geometry with multiple groups"
          onClick={() => setShown(count + 1)}
        >
          <Plus size={12} /> Add Material Slot
        </button>
      )}
    </>
  );
}

/**
 * The Mesh section's editor shortcuts. Three full-width text buttons stacked
 * with no spacing read as one grey slab and give no hint which is which;
 * colour-coded icons in a row are scannable, take one line instead of three,
 * and put the wording in a tooltip where it isn't competing for attention.
 */
function EditorActionRow({ actions }) {
  return (
    <div className="editor-action-row">
      {actions.map(({ label, hint, Icon, color, onClick }) => (
        <button
          key={label}
          className="editor-action"
          style={{ "--action-color": color }}
          title={hint ? `${label} — ${hint}` : label}
          onClick={onClick}
        >
          <Icon size={15} />
          <span className="editor-action-label">{label}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * Entity tags row. Suggestions come from every tag already used anywhere in
 * the scene, so the second entity you tag "enemy" gets it from the list rather
 * than from your memory of how you spelled it.
 */
function EntityTagsRow({ entityIds, tags, mixed = false }) {
  const suggestions = engine.allTags?.() ?? [];
  const commit = (next) => {
    if (entityIds.length === 1) {
      commandBus.execute(new SetEntityTagsCommand(entityIds[0], next));
      return;
    }
    // Multi-selection shows only the tags every entity shares, so a write has
    // to be expressed as a delta — replacing each list with `next` wholesale
    // would silently delete the tags that made an entity distinct.
    const added = next.filter((tag) => !tags.includes(tag));
    const removed = tags.filter((tag) => !next.includes(tag));
    const commands = entityIds.map((id) => {
      const own = engine.getEntity(id)?.tags ?? [];
      const merged = [...new Set([...own.filter((tag) => !removed.includes(tag)), ...added])].sort();
      return new SetEntityTagsCommand(id, merged);
    });
    commandBus.execute(new BatchCommand(commands, `Set tags on ${entityIds.length} entities`));
  };
  return (
    <div className="field-row tags-row">
      <span className="field-label">Tags</span>
      <TagField
        tags={tags}
        suggestions={suggestions}
        placeholder={mixed ? "— Mixed —" : "Add tag…"}
        onChange={commit}
      />
    </div>
  );
}

/**
 * Copied component values, so "set up one light exactly right, then give the
 * other four the same settings" doesn't mean retyping every field. Deliberately
 * module-level and session-only — pasting into a different component type is
 * meaningless, so the type is stored alongside and checked before offering it.
 */
let componentClipboard = null;

/** Props worth copying: the schema's, minus the ones that identify an instance. */
function copyableProps(cls, props) {
  const out = {};
  for (const descriptor of cls?.schema ?? []) {
    if (descriptor.key in props) out[descriptor.key] = props[descriptor.key];
  }
  return out;
}

/**
 * Tip-bone picker for the IK component.
 *
 * A dropdown of the sibling Model's real bone names, because the alternative is
 * typing "mixamorig:LeftFoot" from memory and getting a warning three frames
 * later. The chain is derived from the tip (two bones up), so the hint spells
 * out which bones that resolves to — picking a thigh instead of a foot is the
 * mistake this component invites.
 */
function IKBoneField({ entityId, props }) {
  const [bones, setBones] = useState([]);
  useEffect(() => {
    const refresh = () => {
      const root = engine.getEntity(entityId)?.getComponent("model")?.root;
      setBones(root ? collectBoneNames(root) : []);
    };
    refresh();
    // The GLB loads asynchronously; without this the list is empty exactly when
    // you first add the component, which is when you need it.
    const unsub = engine.on?.("model-loaded", refresh);
    return () => unsub?.();
  }, [entityId]);

  const chain = useMemo(() => {
    const root = engine.getEntity(entityId)?.getComponent("model")?.root;
    const tip = props.tipBone ? root?.getObjectByName(props.tipBone) : null;
    const mid = tip?.parent;
    const upper = mid?.parent;
    return mid?.isBone && upper?.isBone ? `${upper.name} → ${mid.name} → ${tip.name}` : null;
  }, [entityId, props.tipBone, bones]);

  return (
    <>
      <div className="field-row">
        <span className="field-label">Tip Bone</span>
        {bones.length ? (
          <select
            className="select-field"
            value={props.tipBone ?? ""}
            onChange={(e) =>
              commandBus.execute(new SetComponentPropCommand(entityId, "ik", "tipBone", e.target.value))
            }
          >
            <option value="">None</option>
            {bones.map((b) => (
              <option key={b.name} value={b.name}>
                {" ".repeat(b.depth * 2) + b.name}
              </option>
            ))}
          </select>
        ) : (
          <input
            className="text-field"
            key={props.tipBone}
            defaultValue={props.tipBone ?? ""}
            placeholder="bone name"
            onBlur={(e) =>
              commandBus.execute(
                new SetComponentPropCommand(entityId, "ik", "tipBone", e.target.value.trim()),
              )
            }
          />
        )}
      </div>
      {props.tipBone && (
        <div className="field-row">
          <span className="field-label" style={{ opacity: 0.6 }}>
            {chain ?? "no two-bone chain above this bone"}
          </span>
        </div>
      )}
    </>
  );
}

/**
 * Solo for a virtual camera — "show me this shot now", without editing the
 * priority you actually shipped.
 *
 * Deliberately NOT undoable and NOT saved: it is a viewfinder, not a scene
 * edit. Soloing one shot releases every other, because two solos is not a
 * question the brain can answer and the second click would silently do nothing.
 */
function VirtualCameraActions({ entityId }) {
  const [solo, setSolo] = useState(
    () => !!engine.getEntity(entityId)?.getComponent("vcam")?.solo,
  );
  const toggle = () => {
    const next = !solo;
    for (const vcam of engine.virtualCameras ?? []) vcam.setSolo(false);
    engine.getEntity(entityId)?.getComponent("vcam")?.setSolo(next);
    setSolo(next);
  };
  const brain = [...(engine.entities?.values() ?? [])]
    .map((e) => e.getComponent("camera"))
    .find(Boolean);
  return (
    <>
      <EditorActionRow
        actions={[
          {
            label: solo ? "Unsolo" : "Solo",
            hint: "make this shot live, ignoring priority",
            Icon: ScanEye,
            color: solo ? "#ffb347" : "#4fd475",
            onClick: toggle,
          },
        ]}
      />
      {solo && !engine.playing && !brain?.props?.previewRigInEditor && (
        <div className="field-row">
          <span className="field-label" style={{ opacity: 0.6 }}>
            Turn on the Camera's "Preview Rig" to see it in the editor
          </span>
        </div>
      )}
    </>
  );
}

/**
 * Bake the entity's transform into its mesh geometry (Blender's Ctrl+A).
 *
 * Lives on the Mesh section rather than Transform because it only exists when
 * there is geometry to write into, and because its side effect is a `.geom`
 * rewrite or fork — a Transform-section control would be grey noise on lights,
 * cameras and empties. The hierarchy context menu keeps the same modes for
 * the Blender-muscle-memory path.
 */
function ApplyTransformSection({ entityId }) {
  const status = applyTransformStatus(entityId);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const anchorRef = useRef(null);

  useEffect(() => {
    setResult(null);
    setOpen(false);
  }, [entityId]);

  if (!status.ok) return null;

  const run = async (mode) => {
    setOpen(false);
    setBusy(true);
    try {
      const next = await applyTransformToGeometry(entityId, mode);
      setResult(next);
      if (next.ok) console.log(next.message);
      else console.warn(`Apply Transform: ${next.message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="apply-transform-section">
      <button
        ref={anchorRef}
        type="button"
        className="apply-transform-trigger"
        disabled={busy}
        title={
          status.fork
            ? "Bake transform into mesh geometry — saves a new .geom (primitive or shared asset)"
            : "Bake transform into mesh geometry and clear the applied axes"
        }
        onClick={() => setOpen((value) => !value)}
      >
        <Axis3d size={14} />
        <span className="apply-transform-label">{busy ? "Applying…" : "Apply Transform"}</span>
        {status.fork && <span className="apply-transform-hint">new .geom</span>}
        <ChevronDown size={12} className="apply-transform-chevron" />
      </button>
      {open && (
        <PopoverMenu
          anchorRef={anchorRef}
          className="apply-transform-menu"
          minWidth={200}
          onClose={() => setOpen(false)}
        >
          {APPLY_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              className="dropdown-item"
              onClick={() => run(mode)}
            >
              {APPLY_MODE_LABELS[mode]}
            </button>
          ))}
        </PopoverMenu>
      )}
      {result && (
        <div
          className={`apply-transform-result${result.ok ? "" : " apply-transform-result--error"}`}
          title={result.message}
        >
          {result.message}
        </div>
      )}
    </div>
  );
}

/**
 * Bake button for the scene's navmesh, with a readout of what it produced.
 *
 * Reporting the result matters more here than for most actions: a bake that
 * finds no walkable geometry, or produces a navmesh that covers nothing,
 * leaves the viewport looking exactly like a bake that never ran.
 */
function NavMeshActions({ entityId }) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const scenePath = useSceneStore((s) => s.scenePath);

  const bake = async () => {
    const component = engine.getEntity(entityId)?.getComponent("navmesh");
    if (!component) return;
    setBusy(true);
    try {
      // Named after the scene, so two levels in one project don't overwrite
      // each other's navmesh — the failure mode of a fixed filename is that
      // level 2 works and level 1 silently gets level 2's mesh.
      const sceneName = (scenePath?.split(/[\\/]/).pop() ?? "Scene").replace(/\.scene$/i, "");
      const result = await component.bakeAndSave(`navmesh/${sceneName}.navmesh`);
      if (!result.success) setStatus({ error: result.error });
      else {
        const s = result.stats ?? {};
        setStatus({
          text: `${s.triangles ?? 0} tris · ${s.links ?? 0} links · ${s.ms ?? 0}ms`,
        });
      }
    } catch (error) {
      setStatus({ error: String(error?.message ?? error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <EditorActionRow
        actions={[
          {
            label: busy ? "Baking…" : "Bake NavMesh",
            hint: "rebuild the navmesh from the scene and save it",
            Icon: Waypoints,
            color: "#4da3ff",
            onClick: busy ? () => {} : bake,
          },
        ]}
      />
      {status && (
        <div className="field-row">
          <span className="field-label" style={{ opacity: 0.7, color: status.error ? "#ff8080" : undefined }}>
            {status.error ?? status.text}
          </span>
        </div>
      )}
    </>
  );
}

/** Fire button for an impulse source — tuning shake by numbers alone is hopeless. */
function ImpulseSourceActions({ entityId }) {
  return (
    <EditorActionRow
      actions={[
        {
          label: "Fire",
          hint: "emit this shake once, right now",
          Icon: Sparkles,
          color: "#ff8080",
          onClick: () => engine.getEntity(entityId)?.getComponent("impulsesource")?.fire(),
        },
      ]}
    />
  );
}

/** Blender-style ordered modifier cards for the Geometry Modifiers component. */
function GeometryModifiersSection({ entityId, props }) {
  const [busyId, setBusyId] = useState(null);
  const [message, setMessage] = useState("");
  const modifiers = props.modifiers ?? [];
  const commit = (next, label) =>
    commandBus.execute(new SetComponentPropCommand(entityId, "geometryModifiers", "modifiers", next, label));
  const update = (index, patch, label = "Edit modifier") => commit(
    modifiers.map((modifier, current) => current === index ? { ...modifier, ...patch } : modifier),
    label,
  );
  const move = (index, delta) => {
    const target = index + delta;
    if (target < 0 || target >= modifiers.length) return;
    const next = [...modifiers];
    [next[index], next[target]] = [next[target], next[index]];
    commit(next, "Reorder modifiers");
  };
  const apply = async (modifier) => {
    if (busyId) return;
    setBusyId(modifier.id);
    setMessage("");
    const result = await applyGeometryModifier(entityId, modifier.id);
    setMessage(result.message);
    setBusyId(null);
  };

  return (
    <div className="modifier-stack-editor">
      <select
        className="select-field modifier-add"
        value=""
        onChange={(event) => {
          const modifier = createGeometryModifier(event.target.value);
          if (modifier) commit([...modifiers, modifier], `Add ${GEOMETRY_MODIFIER_DEFINITIONS.find((entry) => entry.type === modifier.type)?.label ?? "modifier"}`);
        }}
      >
        <option value="">Add Modifier…</option>
        {GEOMETRY_MODIFIER_DEFINITIONS.map((definition) => (
          <option key={definition.type} value={definition.type}>{definition.label}</option>
        ))}
      </select>
      {!modifiers.length && <div className="modifier-stack-empty">No modifiers</div>}
      {modifiers.map((modifier, index) => {
        const definition = GEOMETRY_MODIFIER_DEFINITIONS.find((entry) => entry.type === modifier.type);
        if (!definition) return null;
        const expanded = modifier.expanded !== false;
        const enabled = modifier.enabled !== false;
        return (
          <div className={`modifier-card ${enabled ? "" : "disabled"}`} key={modifier.id}>
            <div className="modifier-card-header">
              <button className="modifier-disclosure" title={expanded ? "Collapse" : "Expand"} onClick={() => update(index, { expanded: !expanded }, "Toggle modifier panel") }>
                <ChevronRight size={13} className={expanded ? "expanded" : ""} />
                <span>{definition.label}</span>
              </button>
              <span className="modifier-card-actions">
                <button className="modifier-apply" disabled={!!busyId || !enabled} title="Bake this modifier into the geometry" onClick={() => apply(modifier)}>
                  {busyId === modifier.id ? "Applying…" : "Apply"}
                </button>
                <button className="icon-btn" title={enabled ? "Disable modifier" : "Enable modifier"} onClick={() => update(index, { enabled: !enabled }, "Toggle modifier") }>
                  {enabled ? <Eye size={12} /> : <EyeOff size={12} />}
                </button>
                <button className="icon-btn" title="Move modifier up" disabled={index === 0} onClick={() => move(index, -1)}><ChevronUp size={12} /></button>
                <button className="icon-btn" title="Move modifier down" disabled={index === modifiers.length - 1} onClick={() => move(index, 1)}><ChevronDown size={12} /></button>
                <button className="icon-btn" title="Remove modifier" onClick={() => commit(modifiers.filter((_, current) => current !== index), `Remove ${definition.label}`)}><X size={12} /></button>
              </span>
            </div>
            {expanded && (
              <div className="modifier-card-body">
                {definition.fields.filter((descriptor) => !descriptor.showIf || descriptor.showIf(modifier)).map((descriptor) => (
                  <div className="field-row" key={descriptor.key}>
                    <span className="field-label">{descriptor.label}</span>
                    <PropField descriptor={descriptor} value={modifier[descriptor.key]} onCommit={(value) => update(index, { [descriptor.key]: value }, `Set ${definition.label} ${descriptor.label}`)} />
                  </div>
                ))}
                {!definition.fields.length && <div className="modifier-card-note">Area-weighted vertex normals</div>}
              </div>
            )}
          </div>
        );
      })}
      {message && <div className="modifier-stack-message">{message}</div>}
    </div>
  );
}

/**
 * Collapsible "Advanced" group for schema fields marked `advanced: true`.
 * Collapsed by default — the point is to keep a component's inspector down
 * to the handful of properties people actually touch day to day (GI's
 * Quality + Intensity), with the rest one click away instead of a wall of
 * rows. Any component can opt individual fields in; nothing here knows what
 * GI (or any other component) actually is.
 *
 * Local `useState`, not persisted — the toggle is keyed by the component
 * type's position in the schema list (`key={type}` on ComponentSection), so
 * it stays open while you tweak values on one entity but starts collapsed
 * again for a component you haven't opened this session.
 */
function AdvancedFieldsSection({ children }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="advanced-fields">
      <button
        type="button"
        className="advanced-fields-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <ChevronDown size={12} className={`advanced-fields-chevron${open ? "" : " collapsed"}`} />
        <span>Advanced</span>
      </button>
      {open && <div className="advanced-fields-body">{children}</div>}
    </div>
  );
}

function ComponentSection({ entityId, type, props }) {
  const cls = getComponentClass(type);
  // Mirror the live `enabled` flag into local state so the eye icon
  // reflects the engine's current decision (the scene mirror doesn't
  // refresh on every component prop change without a re-render trigger).
  // We deliberately read from the engine here — same pattern as the
  // camera-follow section above — so external mutations (undo/redo,
  // scene load) all show up in the UI.
  const [, force] = useState(0);
  useEffect(() => {
    const onChange = (info) => {
      if (info.entityId === entityId && info.componentType === type) force((v) => v + 1);
    };
    return engine.on("component-changed", onChange);
  }, [entityId, type]);
  const component = engine.getEntity(entityId)?.getComponent(type);
  const enabled = component ? component.enabled !== false : props.enabled !== false;
  // viewOnly: per-component OR entity-wide. Reading both keeps the toggle
  // showing the user's effective intent — if the entity toggle is on, this
  // component is gated even when its own prop is off (and vice versa).
  const entityViewOnly = !!engine.getEntity(entityId)?.viewOnly;
  const viewOnly = component ? component.viewOnly : (!!props.viewOnly || entityViewOnly);
  const toggleEnabled = () => {
    if (!component) return;
    commandBus.execute(new SetComponentPropCommand(entityId, type, "enabled", !enabled));
  };
  const toggleViewOnly = () => {
    if (!component) return;
    commandBus.execute(new SetComponentPropCommand(entityId, type, "viewOnly", !viewOnly));
  };

  const { menu, open: openMenu, close: closeMenu } = useContextMenu();
  const setProps = (values, label) =>
    commandBus.execute(
      new BatchCommand(
        Object.entries(values).map(([key, value]) => new SetComponentPropCommand(entityId, type, key, value)),
        label,
      ),
    );
  const menuItems = [
    { label: enabled ? "Disable Component" : "Enable Component", action: toggleEnabled },
    { label: viewOnly ? "Clear View-Only" : "Set View-Only", action: toggleViewOnly },
    { separator: true },
    {
      label: "Copy Component Values",
      action: () => (componentClipboard = { type, props: copyableProps(cls, props) }),
    },
    {
      label: "Paste Component Values",
      disabled: componentClipboard?.type !== type,
      action: () => setProps(componentClipboard.props, `Paste ${cls?.label ?? type} values`),
    },
    {
      label: "Reset to Defaults",
      disabled: !cls?.defaults,
      action: () => setProps({ ...cls.defaults }, `Reset ${cls.label}`),
    },
    { separator: true },
    {
      label: "Remove Component",
      danger: true,
      action: () => commandBus.execute(new RemoveComponentCommand(entityId, type)),
    },
  ];

  // Unknown type: its module is disabled. The data survives — say so.
  if (!cls) {
    return (
      <div className="inspector-section">
        <div className="section-header">
          {type}
          <button
            className="icon-btn"
            title="Remove component"
            onClick={() => commandBus.execute(new RemoveComponentCommand(entityId, type))}
          >
            <X size={12} />
          </button>
        </div>
        <div className="field-row">
          <span className="field-label" style={{ opacity: 0.6 }}>
            Missing — enable its module in Window → Modules
          </span>
        </div>
      </div>
    );
  }

  const { Icon, color } = componentIcon(type);
  return (
    <div className={`inspector-section ${enabled ? "" : "disabled"}`} onContextMenu={openMenu}>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={closeMenu} />}
      <div className="section-header">
        <span className="section-title">
          <Icon size={13} style={{ color }} />
          {cls.label}
        </span>
        <span className="section-actions">
          <button
            className={`icon-btn ${viewOnly ? "active-toggle" : ""}`}
            title={
              viewOnly
                ? entityViewOnly && !props.viewOnly
                  ? "View-Only (inherited from entity)"
                  : "Disable view-only gating"
                : "Pause while off-camera"
            }
            onClick={toggleViewOnly}
          >
            <ScanEye size={12} />
          </button>
          <button
            className="icon-btn"
            title={enabled ? "Disable component" : "Enable component"}
            onClick={toggleEnabled}
          >
            {enabled ? <Eye size={12} /> : <EyeOff size={12} />}
          </button>
          <button
            className="icon-btn"
            title="Remove component"
            onClick={() => commandBus.execute(new RemoveComponentCommand(entityId, type))}
          >
            <X size={12} />
          </button>
        </span>
      </div>
      {(() => {
        const visible = cls.schema.filter((descriptor) => {
          if (descriptor.hidden) return false;
          if (descriptor.showIf && !descriptor.showIf(props)) return false;
          // Mesh materials render through MaterialSlotsSection below, which owns
          // the whole slot list (add / remove / renumber) rather than one row.
          if (type === "mesh" && descriptor.key === "material") return false;
          // The tip bone gets a dropdown of the rig's actual bones instead of a
          // text field — typing "mixamorig:LeftFoot" from memory is a coin flip.
          if (type === "ik" && descriptor.key === "tipBone") return false;
          return true;
        });
        const renderField = (descriptor) => (
          <div className="field-row" key={descriptor.key}>
            <span className="field-label">{descriptor.label}</span>
            <PropField
              descriptor={descriptor}
              value={props[descriptor.key]}
              onCommit={(v) => {
                if (type === "mesh" && descriptor.key === "geometry" && props.geometryAsset) {
                  commandBus.execute(new BatchCommand([
                    new SetComponentPropCommand(entityId, type, "geometryAsset", ""),
                    new SetComponentPropCommand(entityId, type, descriptor.key, v),
                  ], "Use primitive geometry"));
                  return;
                }
                // A schema field may declare `flipsToCustom: "otherKey"` so
                // editing it also flips a sibling preset selector to
                // "custom" in the SAME undo step (e.g. GI's advanced fields
                // flip `quality`) — skipped once the preset already reads
                // "custom" so repeated edits don't keep rewriting it.
                if (descriptor.flipsToCustom && props[descriptor.flipsToCustom] !== "custom") {
                  commandBus.execute(new BatchCommand([
                    new SetComponentPropCommand(entityId, type, descriptor.key, v),
                    new SetComponentPropCommand(entityId, type, descriptor.flipsToCustom, "custom"),
                  ], `Set ${descriptor.label}`));
                  return;
                }
                commandBus.execute(new SetComponentPropCommand(entityId, type, descriptor.key, v));
              }}
            />
          </div>
        );
        const advanced = visible.filter((descriptor) => descriptor.advanced);
        return (
          <>
            {visible.filter((descriptor) => !descriptor.advanced).map(renderField)}
            {advanced.length > 0 && (
              <AdvancedFieldsSection>{advanced.map(renderField)}</AdvancedFieldsSection>
            )}
          </>
        );
      })()}
      {type === "uielement" && <UiElementSection entityId={entityId} props={props} />}
      {type === "script" && <ScriptsSection entityId={entityId} props={props} />}
      {type === "events" && <EventBindingsSection entityId={entityId} props={props} />}
      {/* Any component declaring an `actions` prop gets an editor for it — the
          UI button's onClick/onFocus/... lists today, whatever grows one next
          without a change here. */}
      <ActionListSections entityId={entityId} componentType={type} props={props} />
      {type === "geometryModifiers" && <GeometryModifiersSection entityId={entityId} props={props} />}
      {type === "mesh" && (
        <>
          <MaterialSlotsSection entityId={entityId} props={props} />
          <EditorActionRow
            actions={[
              {
                label: "Edit Geometry",
                hint: "edit this mesh in place, in the viewport",
                Icon: Pencil,
                color: "#4fd475",
                onClick: () => {
                  useGeometryEditStore.getState().enter(entityId);
                  openPanel("viewport");
                },
              },
              {
                label: "Geometry Editor",
                hint: "open the full geometry editor panel",
                Icon: PanelsTopLeft,
                color: "#4da3ff",
                onClick: () => openPanel("geometryEditor"),
              },
              {
                label: "Shader Graph",
                hint: "edit this mesh's material graph",
                Icon: Waypoints,
                color: "#b784f5",
                onClick: () => openPanel("shaderGraph"),
              },
            ]}
          />
          <ApplyTransformSection entityId={entityId} />
        </>
      )}
      {type === "camera" && (
        <CameraFollowSection entityId={entityId} props={props} />
      )}
      {type === "instancer" && props.scatterShape === "onMesh" && (
        <InstancerSurfaceSection entityId={entityId} props={props} />
      )}
      {type === "camera" && (
        <EditorActionRow
          actions={[
            {
              label: "Adjust to View",
              hint: "copy the editor viewport's pose onto this camera",
              Icon: Crosshair,
              color: "#4da3ff",
              onClick: () => {
                const view = getEditorCameraView();
                if (!view) return;
                const entity = engine.getEntity(entityId);
                const before = entity?.getTransform();
                if (!before) return;
                commandBus.execute(
                  new SetTransformCommand(entityId, {
                    position: view.position,
                    rotation: view.rotation,
                    scale: before.scale,
                  }, before),
                );
              },
            },
            ...(engine.getEntity(entityId)?.getComponent?.("postprocess")
              ? [{
                  label: "Post Process",
                  hint: "open the post-process graph for this camera",
                  Icon: Sparkles,
                  color: "#b784f5",
                  onClick: () => openPanel("postprocess"),
                }]
              : []),
          ]}
        />
      )}
      {type === "particles" && (
        <EditorActionRow
          actions={[
            {
              label: "Particle Editor",
              hint: "edit this emitter's node graph",
              Icon: Waypoints,
              color: "#b784f5",
              onClick: () => openPanel("particles"),
            },
          ]}
        />
      )}
      {type === "animation" && props.controller && (
        <EditorActionRow
          actions={[
            {
              label: "Animator",
              hint: "edit this controller's state machine",
              Icon: Layers2,
              color: "#4fd475",
              onClick: () => openPanel("animator"),
            },
          ]}
        />
      )}
      {type === "ik" && <IKBoneField entityId={entityId} props={props} />}
      {type === "vcam" && <VirtualCameraActions entityId={entityId} />}
      {type === "navmesh" && <NavMeshActions entityId={entityId} />}
      {type === "impulsesource" && <ImpulseSourceActions entityId={entityId} />}
      {type === "sound" && <SoundSection entityId={entityId} props={props} />}
      {type === "listener" && <ListenerSection entityId={entityId} />}
      {type === "timeline" && <TimelineSection entityId={entityId} props={props} />}
      {type === "line" && <LinePointsSection entityId={entityId} props={props} />}
      {type === "trail" && <TrailSection entityId={entityId} />}
      {type === "decal" && <DecalSection entityId={entityId} />}
      {type === "lod" && <LodSection entityId={entityId} props={props} />}
      {type === "impostor" && <ImpostorSection entityId={entityId} />}
      {type === "spline" && <SplineSection entityId={entityId} props={props} />}
      {type === "splineMesh" && <SplineMeshSection entityId={entityId} />}
      {type === "splineFollower" && <SplineFollowerSection entityId={entityId} />}
      {type === "terrain" && <TerrainSection entityId={entityId} props={props} />}
      {type === "collider" && props.shape === "heightfield" && !engine.getEntity(entityId)?.getComponent("terrain") && (
        <div className="field-row">
          <span className="field-label" style={{ opacity: 0.6 }}>
            Requires a Terrain component on this entity
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * Multi-entity selection: edit attributes shared across the selection.
 *
 * "Shared" means the same script file at the same slot index on every selected
 * entity. Matching by index as well as path keeps the write side unambiguous —
 * editing a value maps to one known slot per entity rather than guessing which
 * of several copies of the same script was meant. Selections whose script
 * lists differ simply show fewer rows.
 */
function MultiScriptAttributeFields({ entities }) {
  const components = entities.map((entity) => engine.getEntity(entity.id)?.getComponent("script"));
  const slotLists = entities.map((entity) => entity.components.script?.scripts ?? []);
  const slotCount = Math.min(...slotLists.map((list) => list.length), Infinity);
  if (!Number.isFinite(slotCount) || slotCount === 0) return null;

  const rows = [];
  for (let index = 0; index < slotCount; index++) {
    const paths = slotLists.map((list) => list[index]?.path ?? "");
    // Different files at this position — nothing meaningful to co-edit.
    if (!paths.every((path) => path === paths[0]) || !paths[0]) continue;

    const definitions = components.map((component) => component?.getAttributeDefs?.(index) ?? {});
    const sharedKeys = Object.keys(definitions[0] ?? {}).filter((key) =>
      definitions.every((defs) => key in defs),
    );
    if (!sharedKeys.length) continue;

    const stem = paths[0].split(/[\\/]/).pop();
    rows.push(
      <div className="inspector-subheader" key={`h-${index}`}>
        {stem}
      </div>,
    );

    for (const key of sharedKeys) {
      const def = definitions[0][key];
      const values = slotLists.map(
        (list, i) => list[index]?.attributes?.[key] ?? definitions[i][key].default,
      );
      const isMixed = !values.every((value) => valuesEqual(value, values[0]));
      const mixedAxes =
        (def.type === "vec3" || def.type === "vec2")
          ? [0, 1, 2].map((axis) => !values.every((value) => value?.[axis] === values[0]?.[axis]))
          : [];
      rows.push(
        <div className="field-row" key={`${index}-${key}`}>
          <span className="field-label indented">{def.label ?? key}</span>
          <PropField
            descriptor={{ key, label: key, type: def.type ?? "number", ...def }}
            value={values[0]}
            mixed={isMixed}
            mixedAxes={mixedAxes}
            onCommit={(value, changedAxis) => {
              const commands = entities.map((entity, i) => {
                const list = slotLists[i];
                const attributes = { ...(list[index]?.attributes ?? {}) };
                if ((def.type === "vec3" || def.type === "vec2") && Number.isInteger(changedAxis)) {
                  const next = [...(attributes[key] ?? def.default ?? [0, 0, 0])];
                  next[changedAxis] = value[changedAxis];
                  attributes[key] = next;
                } else attributes[key] = value;
                const scripts = list.map((slot, s) => (s === index ? { ...slot, attributes } : slot));
                return new SetComponentPropCommand(
                  entity.id,
                  "script",
                  "scripts",
                  scripts,
                  `Set ${key}`,
                );
              });
              commandBus.execute(
                new BatchCommand(commands, `Set ${key} on ${entities.length} scripts`),
              );
            }}
          />
        </div>,
      );
    }
  }
  return rows;
}

function MultiComponentSection({ entities, type }) {
  const cls = getComponentClass(type);
  const [, force] = useState(0);
  const entityIds = entities.map((entity) => entity.id);
  const propsList = entities.map((entity) => entity.components[type]);

  useEffect(() => {
    const selected = new Set(entityIds);
    return engine.on("component-changed", (info) => {
      if (selected.has(info.entityId) && info.componentType === type) force((value) => value + 1);
    });
  }, [type, entityIds.join("|")]);

  const liveComponents = entityIds.map((id) => engine.getEntity(id)?.getComponent(type)).filter(Boolean);
  const enabledValues = liveComponents.map((component) => component.enabled !== false);
  const viewOnlyValues = liveComponents.map((component) => !!component.props.viewOnly);
  const batchProps = (key, value, label = `Set ${key} on ${entities.length} entities`) => {
    const commands = entityIds.map((id) => new SetComponentPropCommand(id, type, key, value));
    commandBus.execute(new BatchCommand(commands, label));
  };
  const removeAll = () => commandBus.execute(
    new BatchCommand(
      entityIds.map((id) => new RemoveComponentCommand(id, type)),
      `Remove ${cls?.label ?? type} from ${entities.length} entities`,
    ),
  );

  if (!cls) {
    return (
      <div className="inspector-section">
        <div className="section-header">
          {type}
          <button className="icon-btn" title="Remove component from selection" onClick={removeAll}>
            <X size={12} />
          </button>
        </div>
        <div className="field-row"><span className="field-label" style={{ opacity: 0.6 }}>Missing module</span></div>
      </div>
    );
  }

  const enabledMixed = !enabledValues.every((value) => value === enabledValues[0]);
  const viewOnlyMixed = !viewOnlyValues.every((value) => value === viewOnlyValues[0]);
  const { Icon, color } = componentIcon(type);
  return (
    <div className={`inspector-section ${!enabledMixed && !enabledValues[0] ? "disabled" : ""}`}>
      <div className="section-header">
        <span className="section-title">
          <Icon size={13} style={{ color }} />
          {cls.label}
        </span>
        <span className="section-actions">
          <button
            className={`icon-btn ${!viewOnlyMixed && viewOnlyValues[0] ? "active-toggle" : ""}`}
            title={viewOnlyMixed ? "Mixed view-only state; click to enable all" : "Toggle view-only for selection"}
            onClick={() => batchProps("viewOnly", viewOnlyMixed ? true : !viewOnlyValues[0])}
          >
            <ScanEye size={12} />
          </button>
          <button
            className="icon-btn"
            title={enabledMixed ? "Mixed enabled state; click to enable all" : "Toggle component for selection"}
            onClick={() => batchProps("enabled", enabledMixed ? true : !enabledValues[0])}
          >
            {enabledMixed || enabledValues[0] ? <Eye size={12} /> : <EyeOff size={12} />}
          </button>
          <button className="icon-btn" title="Remove component from selection" onClick={removeAll}>
            <X size={12} />
          </button>
        </span>
      </div>
      {(() => {
        const visible = cls.schema.filter((descriptor) => {
          if (descriptor.hidden) return false;
          if (descriptor.showIf && !propsList.every((props) => descriptor.showIf(props))) return false;
          return true;
        });
        const renderField = (descriptor) => {
          const values = propsList.map((props) => props[descriptor.key]);
          const mixed = !values.every((value) => valuesEqual(value, values[0]));
          const mixedAxes = descriptor.type === "vec3" || descriptor.type === "vec2"
            ? [0, 1, 2].map((axis) => !values.every((value) => value?.[axis] === values[0]?.[axis]))
            : [];
          return (
            <div className="field-row" key={descriptor.key}>
              <span className="field-label">{descriptor.label}</span>
              <PropField
                descriptor={descriptor}
                value={values[0]}
                mixed={mixed}
                mixedAxes={mixedAxes}
                onCommit={(value, changedAxis) => {
                  const commands = [];
                  for (const entity of entities) {
                    const props = entity.components[type];
                    if (type === "mesh" && descriptor.key === "geometry" && props.geometryAsset) {
                      commands.push(new SetComponentPropCommand(entity.id, type, "geometryAsset", ""));
                    }
                    let entityValue = value;
                    if ((descriptor.type === "vec3" || descriptor.type === "vec2") && Number.isInteger(changedAxis)) {
                      entityValue = [...(props[descriptor.key] ?? [0, 0, 0])];
                      entityValue[changedAxis] = value[changedAxis];
                    }
                    commands.push(new SetComponentPropCommand(entity.id, type, descriptor.key, entityValue));
                    // See the single-entity ComponentSection for what
                    // `flipsToCustom` means — applied per-entity here so a
                    // mixed selection still gets one undo step overall.
                    if (descriptor.flipsToCustom && props[descriptor.flipsToCustom] !== "custom") {
                      commands.push(new SetComponentPropCommand(entity.id, type, descriptor.flipsToCustom, "custom"));
                    }
                  }
                  commandBus.execute(new BatchCommand(commands, `Set ${descriptor.label} on ${entities.length} entities`));
                }}
              />
            </div>
          );
        };
        const advanced = visible.filter((descriptor) => descriptor.advanced);
        return (
          <>
            {visible.filter((descriptor) => !descriptor.advanced).map(renderField)}
            {advanced.length > 0 && (
              <AdvancedFieldsSection>{advanced.map(renderField)}</AdvancedFieldsSection>
            )}
          </>
        );
      })()}
      {type === "script" && <MultiScriptAttributeFields entities={entities} />}
      <div className="asset-hint">Editing shared values on {entities.length} selected entities.</div>
    </div>
  );
}

/** One line in the Overrides dropdown, with its own Apply / Revert. */
function OverrideRow({ rootId, override, label }) {
  return (
    <div className="prefab-override-row">
      <span className="prefab-override-label" title={label}>
        {label}
      </span>
      <button className="prefab-mini-btn" title="Apply just this to the prefab" onClick={() => applyPrefab(rootId, [override])}>
        Apply
      </button>
      <button className="prefab-mini-btn" title="Discard just this change" onClick={() => revertPrefab(rootId, [override])}>
        Revert
      </button>
    </div>
  );
}

/** Human-readable description of an override, for the dropdown. */
function describeOverride(root, override) {
  const target = override.t?.length
    ? (findEntityByFidPath(root, override.t)?.name ?? override.t.join(" › "))
    : root.name;
  switch (override.k) {
    case "prop":
      return `${target} › ${getComponentClass(override.c)?.label ?? override.c} › ${override.key}`;
    case "transform":
      return `${target} › ${override.key}`;
    case "name":
      return `${target} › name`;
    case "flag":
      return `${target} › ${override.key}`;
    case "tags":
      return `${target} › tags`;
    case "addComponent":
      return `${target} › added ${getComponentClass(override.c)?.label ?? override.c}`;
    case "removeComponent":
      return `${target} › removed ${getComponentClass(override.c)?.label ?? override.c}`;
    case "addEntity":
      return `${target} › added "${override.v?.name ?? "entity"}"`;
    case "removeEntity":
      return `removed "${target}"`;
    default:
      return target;
  }
}

/** Live entity at an fid path inside an instance. */
function findEntityByFidPath(root, path) {
  let entity = root;
  for (const fid of path) {
    entity = entity?.children.find((c) => c.fid === fid);
    if (!entity) return null;
  }
  return entity;
}

/**
 * The prefab bar at the top of the inspector for anything inside an instance:
 * where the prefab lives, what's been changed on this instance, and the
 * Apply / Revert / Open / Unpack actions.
 */
function PrefabSection({ entityId }) {
  const [overridesOpen, setOverridesOpen] = useState(false);
  usePrefabStore((s) => s.version);
  // Re-derive the override diff when THIS entity's mirror changes (its own
  // edits, and full refreshes rebuild every mirror). Subscribing to the
  // whole map re-ran diffInstance() on every gizmo-drag frame of ANY entity.
  useSceneStore((s) => s.entities[entityId]);

  const live = engine.getEntity(entityId);
  const root = live ? getPrefabRoot(live) : null;
  if (!root) return null;

  const guid = prefabRegistry.resolveLink(root.prefab);
  const def = guid ? prefabRegistry.getDef(guid) : null;
  const path = guid ? prefabRegistry.pathOf(guid) : null;
  const overrides = guid ? diffInstance(root) : [];
  const baseName = def?.variantOf ? prefabRegistry.getDef(prefabRegistry.resolveLink(def.variantOf))?.name : null;

  if (!guid) {
    return (
      <div className="prefab-section missing">
        <div className="prefab-section-head">
          <Package size={13} />
          <span className="prefab-section-name">Missing Prefab</span>
        </div>
        <div className="prefab-section-note">
          The asset this instance came from can't be found. Its overrides are preserved — restore the file, or unpack to
          keep these entities as plain objects.
        </div>
        <div className="prefab-actions">
          <button className="toolbar-btn" onClick={() => unpackPrefab(root.id, { deep: true })}>
            Unpack Completely
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="prefab-section">
      <div className="prefab-section-head">
        <Package size={13} />
        <span className="prefab-section-name" title={path ?? ""}>
          {def?.name ?? "Prefab"}
        </span>
        {baseName && <span className="prefab-variant-tag" title={`Variant of ${baseName}`}>variant of {baseName}</span>}
        {root !== live && <span className="prefab-section-note inline">(part of this prefab)</span>}
      </div>

      <div className="prefab-actions">
        <button className="toolbar-btn" disabled={!path} onClick={() => openPrefabMode(path)} title="Edit the prefab asset in isolation">
          Open
        </button>
        <button className="toolbar-btn" disabled={!path} onClick={() => useSelectionStore.getState().selectAsset(path)} title="Reveal the asset in the Assets panel">
          Select
        </button>
        <button
          className="toolbar-btn"
          disabled={!overrides.length}
          onClick={() => applyPrefab(root.id)}
          title="Push every change on this instance into the prefab (all other instances update)"
        >
          Apply All
        </button>
        <button
          className="toolbar-btn"
          disabled={!overrides.length}
          onClick={() => revertPrefab(root.id)}
          title="Discard every change on this instance"
        >
          Revert All
        </button>
      </div>

      <div className="prefab-actions">
        <button className="toolbar-btn" onClick={() => createVariantFromInstance(root.id)} title="Make a new prefab that inherits from this one, with these changes baked in">
          Create Variant
        </button>
        <button className="toolbar-btn" onClick={() => unpackPrefab(root.id)} title="Break the link, keep the entities (nested prefabs stay linked)">
          Unpack
        </button>
      </div>

      {overrides.length > 0 && (
        <>
          <button className="prefab-overrides-toggle" onClick={() => setOverridesOpen((v) => !v)}>
            <ChevronRight size={11} className={overridesOpen ? "open" : ""} />
            {overrides.length} override{overrides.length === 1 ? "" : "s"}
          </button>
          {overridesOpen && (
            <div className="prefab-overrides">
              {overrides.map((override, i) => (
                <OverrideRow key={i} rootId={root.id} override={override} label={describeOverride(root, override)} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The Add Component picker: grouped, icon-led, and filterable.
 *
 * The flat alphabetical text list it replaces meant reading ~25 grey labels to
 * find one. Grouping puts related components together, the coloured glyph lets
 * you recognise a component without reading it, and the search box turns "I
 * know it's called something like rigid…" into two keystrokes. The field
 * autofocuses so the menu is keyboard-first: open, type, Enter.
 */
function AddComponentMenu({ types, disabledReason, suffix, onPick, onClose, anchorRef }) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const label = (type) => getComponentClass(type)?.label ?? type;

  const matches = useMemo(
    () => (needle ? types.filter((type) => `${label(type)} ${type}`.toLowerCase().includes(needle)) : types),
    [types, needle],
  );
  const groups = useMemo(() => groupComponentTypes(matches), [matches]);
  // A search narrows to a flat, ranked-by-nothing list — grouping headers over
  // one or two hits is just noise.
  const flat = !!needle;

  const pickFirst = () => {
    const first = matches.find((type) => !disabledReason?.(type));
    if (first) onPick(first);
  };

  const renderItem = (type) => {
    const reason = disabledReason?.(type);
    const { Icon, color } = componentIcon(type);
    return (
      <button
        key={type}
        className="dropdown-item component-item"
        disabled={!!reason}
        title={reason ?? undefined}
        onClick={() => !reason && onPick(type)}
      >
        <Icon size={14} style={{ color }} className="component-item-icon" />
        <span className="component-item-label">{label(type)}</span>
        {suffix?.(type) && <span className="component-item-suffix">{suffix(type)}</span>}
      </button>
    );
  };

  return (
    <PopoverMenu anchorRef={anchorRef} className="component-menu" minWidth={232} onClose={onClose}>
      <div className="component-menu-search">
        <Search size={12} />
        <input
          autoFocus
          type="text"
          placeholder="Search components…"
          value={query}
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") pickFirst();
            else if (e.key === "Escape") onClose();
          }}
        />
      </div>
      <div className="component-menu-list">
        {flat
          ? matches.map(renderItem)
          : groups.map((group) => (
              <div key={group.label}>
                <div className="dropdown-section-label">{group.label}</div>
                {group.types.map(renderItem)}
              </div>
            ))}
        {!matches.length && <div className="asset-hint">No matching components</div>}
      </div>
    </PopoverMenu>
  );
}

function MultiEntityInspector({ entities }) {
  const [addOpen, setAddOpen] = useState(false);
  const addButtonRef = useRef(null);
  const entityIds = entities.map((entity) => entity.id);
  const liveEntities = entityIds.map((id) => engine.getEntity(id)).filter(Boolean);
  const commonTypes = Object.keys(entities[0].components).filter(
    (type) => entities.every((entity) => type in entity.components) && !getComponentClass(type)?.internal,
  );
  const flagValues = (key, fallback = true) => liveEntities.map((entity) => entity[key] ?? fallback);
  const editorValues = liveEntities.map((entity) => entity.enabledInEditor !== false);
  const gameValues = liveEntities.map((entity) => entity.enabledInGame !== false);
  const viewOnlyValues = flagValues("viewOnly", false).map(Boolean);
  const persistentValues = flagValues("persistent", false).map(Boolean);
  const mixed = (values) => !values.every((value) => value === values[0]);
  const executeForAll = (Command, value, label) => commandBus.execute(
    new BatchCommand(entityIds.map((id) => new Command(id, value)), label),
  );

  const availableTypes = getComponentTypes()
    .filter((type) => entities.some((entity) => !(type in entity.components)))
    .filter((type) => {
      const cls = getComponentClass(type);
      return !cls?.internal && !cls?.importOnly && type !== "terrain";
    })
    .filter((type) => !type.startsWith("ui") || type === "uiscreen" || entities.every((entity) => isInsideUiScreen(entity.id)));
  const componentRequires = { instancer: ["mesh", "model"], postprocess: ["camera"] };

  return (
    <div className="inspector-panel">
      <div className="inspector-section multi-selection-summary">
        <div className="section-header">{entities.length} Entities Selected</div>
        <div className="field-row">
          <span className="field-label">Name</span>
          <input
            className="text-field"
            type="text"
            placeholder="— Multiple —"
            onBlur={(event) => {
              const name = event.target.value.trim();
              if (!name) return;
              executeForAll(RenameEntityCommand, name, `Rename ${entities.length} entities`);
              event.target.value = "";
            }}
            onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
          />
        </div>
        {(() => {
          // Only tags every selected entity carries are editable together;
          // adding one adds it to all of them, removing removes it from all.
          const lists = entities.map((entity) => entity.tags ?? []);
          const shared = lists[0].filter((tag) => lists.every((list) => list.includes(tag)));
          const mixed = lists.some((list) => list.length !== shared.length);
          return <EntityTagsRow entityIds={entityIds} tags={shared} mixed={mixed} />;
        })()}
        <div className="field-row">
          <span className="field-label">View Only</span>
          <MixedCheckbox
            checked={viewOnlyValues[0]}
            mixed={mixed(viewOnlyValues)}
            onChange={(event) => executeForAll(SetEntityViewOnlyCommand, event.target.checked, `Set View Only on ${entities.length} entities`)}
          />
        </div>
        <div className="field-row">
          <span className="field-label">Persistent</span>
          <MixedCheckbox
            checked={persistentValues[0]}
            mixed={mixed(persistentValues)}
            onChange={(event) => executeForAll(SetEntityPersistentCommand, event.target.checked, `Set Persistent on ${entities.length} entities`)}
          />
        </div>
        <div className="field-row visibility-row">
          <span className="field-label">Enabled</span>
          <div className="visibility-toggles">
            <label className="visibility-toggle">
              <MixedCheckbox
                checked={editorValues[0]}
                mixed={mixed(editorValues)}
                onChange={(event) => executeForAll(SetEntityEnabledInEditorCommand, event.target.checked, `Set editor visibility on ${entities.length} entities`)}
              />
              <span className="visibility-toggle-label">Editor</span>
            </label>
            <label className="visibility-toggle">
              <MixedCheckbox
                checked={gameValues[0]}
                mixed={mixed(gameValues)}
                onChange={(event) => executeForAll(SetEntityEnabledInGameCommand, event.target.checked, `Set game visibility on ${entities.length} entities`)}
              />
              <span className="visibility-toggle-label">Game</span>
            </label>
          </div>
        </div>
      </div>

      <MultiTransformSection entities={entities} />
      {commonTypes.map((type) => <MultiComponentSection key={type} entities={entities} type={type} />)}
      {!commonTypes.length && <div className="asset-hint">The selected entities have no components in common.</div>}

      <div className="add-component-wrap">
        <div className="dropdown-wrap">
          <button
            ref={addButtonRef}
            className="toolbar-btn wide"
            disabled={!availableTypes.length}
            onClick={() => setAddOpen((value) => !value)}
          >
            <Plus size={14} /> Add Component to Selection
          </button>
          {addOpen && (
            <AddComponentMenu
              anchorRef={addButtonRef}
              types={availableTypes}
              onClose={() => setAddOpen(false)}
              suffix={(type) => `${entities.filter((entity) => !(type in entity.components)).length}`}
              disabledReason={(type) => {
                const requirements = componentRequires[type];
                if (!requirements) return null;
                const targets = entities.filter((entity) => !(type in entity.components));
                const missing = targets.some(
                  (entity) => !requirements.some((required) => required in entity.components),
                );
                return missing
                  ? `Some selected entities are missing ${requirements
                      .map((t) => getComponentClass(t)?.label ?? t)
                      .join(" or ")}`
                  : null;
              }}
              onPick={(type) => {
                setAddOpen(false);
                const targets = entities.filter((entity) => !(type in entity.components));
                commandBus.execute(new BatchCommand(
                  targets.map((entity) => new AddComponentCommand(entity.id, type)),
                  `Add ${getComponentClass(type)?.label ?? type} to ${targets.length} entities`,
                ));
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

export function InspectorPanel() {
  const selectedIds = useSelectionStore((s) => s.ids);
  const selectedId = selectedIds[0] ?? null;
  const assetPath = useSelectionStore((s) => s.assetPath);
  // Narrow subscription: only the SELECTED entities' mirror objects. The
  // whole-map version re-rendered the full inspector (every component
  // section and field) on every gizmo-drag frame of ANY entity —
  // updateTransform replaces the map object per pointermove.
  const entities = useSceneStore(
    useShallow((s) => selectedIds.map((id) => s.entities[id]).filter(Boolean)),
  );
  const entity = entities[0] ?? null;
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const addButtonRef = useRef(null);
  // Toggling a module (un)registers component types — re-render for the list.
  useModulesStore((s) => s.enabled);

  // Esc closes the open Add Component menu without dismissing focus from
  // the trigger button. Keeps the menu from "sticking open" if the user
  // opens it and then backs out.
  useEffect(() => {
    if (!addMenuOpen) return;
    const onKey = (e) => {
      if (e.key === "Escape") setAddMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [addMenuOpen]);

  // Flip-up-when-tight is PopoverMenu's job now — it measures the real menu
  // height against the viewport instead of guessing from the 60vh cap.

  if (!entity && assetPath) return <AssetInspector path={assetPath} />;
  if (!entity) {
    return <div className="inspector-panel empty">No entity selected</div>;
  }
  if (entities.length > 1) return <MultiEntityInspector entities={entities} />;

  const availableTypes = getComponentTypes()
    .filter((t) => !(t in entity.components))
    // `internal` components are invisible everywhere; `importOnly` ones show
    // their inspector section but can't be added by hand (e.g. Skinned Mesh —
    // meaningless without an imported rig above it).
    .filter((t) => {
      const cls = getComponentClass(t);
      return !cls?.internal && !cls?.importOnly;
    })
    // UI components only exist inside a UI Screen subtree. Without an
    // ancestor `uiscreen`, the dropdown hides everything except `uiscreen`
    // itself (which is what *creates* the UI subtree). UI Screen itself is
    // always available so the user can start a UI hierarchy from anywhere.
    .filter((t) => {
      if (!t.startsWith("ui")) return true;
      if (t === "uiscreen") return true;
      return isInsideUiScreen(entity.id);
    });

  /**
   * Components that depend on other components being present. The entry is
   * kept visible in the dropdown but disabled, with a tooltip explaining the
   * missing prerequisite so the user knows what to add. Each value is a list
   * of component types — any one of them satisfies the requirement.
   *   { "instancer": ["mesh", "model"] }  — Instancer requires a Mesh or
   *   Model component on the same entity to read the source geometry from.
   */
  const componentRequires = { instancer: ["mesh", "model"], postprocess: ["camera"] };

  const commitName = (value) => {
    const name = value.trim();
    if (name && name !== entity.name) {
      commandBus.execute(new RenameEntityCommand(entity.id, name));
    }
  };

  // Per-mode visibility state lives on the live engine entity; the React
  // mirror doesn't include it (mirroring everything every tick would be
  // wasteful — and these flags only change when the user toggles them).
  // Reading through the engine instance guarantees we always show the
  // current value, even after undo/redo or scene reload.
  const liveEntity = engine.getEntity(entity.id);
  const editorEnabled = liveEntity?.enabledInEditor !== false;
  const gameEnabled = liveEntity?.enabledInGame !== false;

  return (
    <div className="inspector-panel">
      <PrefabSection entityId={entity.id} />
      <div className="inspector-section">
        <div className="field-row">
          <span className="field-label">Name</span>
          <input
            className="text-field"
            type="text"
            key={entity.id + entity.name}
            defaultValue={entity.name}
            onBlur={(e) => commitName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && e.target.blur()}
          />
        </div>
        <EntityTagsRow entityIds={[entity.id]} tags={entity.tags ?? []} />
        <div className="field-row">
          <span className="field-label">View Only</span>
          <label className="field-row inline" title="Pause this entity's components while it is outside the camera frustum">
            <input
              type="checkbox"
              checked={!!engine.getEntity(entity.id)?.viewOnly}
              onChange={(e) =>
                commandBus.execute(new SetEntityViewOnlyCommand(entity.id, e.target.checked))
              }
            />
          </label>
        </div>
        <div className="field-row">
          <span className="field-label">Persistent</span>
          <label
            className="field-row inline"
            title="Survive engine.loadScene — for game managers, the audio listener, or a player that carries between levels"
          >
            <input
              type="checkbox"
              checked={!!liveEntity?.persistent}
              onChange={(e) =>
                commandBus.execute(new SetEntityPersistentCommand(entity.id, e.target.checked))
              }
            />
          </label>
        </div>
        <div className="field-row visibility-row">
          <span className="field-label">Enabled</span>
          <div className="visibility-toggles" role="group" aria-label="Visibility per mode">
            <label
              className="visibility-toggle"
              title={editorEnabled ? "Visible in editor — click to hide in editor" : "Hidden in editor — click to show in editor"}
            >
              <input
                type="checkbox"
                checked={editorEnabled}
                onChange={(e) =>
                  commandBus.execute(
                    new SetEntityEnabledInEditorCommand(entity.id, e.target.checked),
                  )
                }
              />
              <span className="visibility-toggle-label">Editor</span>
            </label>
            <label
              className="visibility-toggle"
              title={gameEnabled ? "Enabled in game (play) — click to disable in game" : "Disabled in game — click to enable in game"}
            >
              <input
                type="checkbox"
                checked={gameEnabled}
                onChange={(e) =>
                  commandBus.execute(
                    new SetEntityEnabledInGameCommand(entity.id, e.target.checked),
                  )
                }
              />
              <span className="visibility-toggle-label">Game</span>
            </label>
          </div>
        </div>
      </div>

      <TransformSection entity={entity} />

      {Object.entries(entity.components)
        .filter(([type]) => !getComponentClass(type)?.internal)
        .map(([type, props]) => (
          <ComponentSection key={type} entityId={entity.id} type={type} props={props} />
        ))}

      <div className="add-component-wrap">
        <div className="dropdown-wrap">
          <button
            ref={addButtonRef}
            className="toolbar-btn wide"
            disabled={!availableTypes.length}
            onClick={() => setAddMenuOpen((open) => !open)}
          >
            <Plus size={14} />
            Add Component
          </button>
          {addMenuOpen && (
            <AddComponentMenu
              anchorRef={addButtonRef}
              types={availableTypes}
              onClose={() => setAddMenuOpen(false)}
              disabledReason={(type) => {
                const requiredTypes = componentRequires[type];
                if (!requiredTypes || requiredTypes.some((t) => t in entity.components)) return null;
                const label = getComponentClass(type)?.label ?? type;
                const requiredLabel = requiredTypes
                  .map((t) => getComponentClass(t)?.label ?? t)
                  .join(" or ");
                return `${label} requires a ${requiredLabel} component on this entity`;
              }}
              onPick={async (type) => {
                setAddMenuOpen(false);
                if (type === "terrain") {
                  const mesh = entity.getComponent("mesh");
                  const needsAssets = !mesh?.props.geometryAsset || !mesh?.props.material;
                  let assets = null;
                  if (needsAssets) {
                    try {
                      assets = await createTerrainAssets();
                    } catch (err) {
                      console.error(`Could not create terrain assets: ${err}`);
                    }
                  }
                  commandBus.execute(new AddComponentCommand(entity.id, type));
                  assignTerrainAssets(entity, assets);
                } else {
                  commandBus.execute(new AddComponentCommand(entity.id, type));
                }
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
