import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2, Box, Video, Lightbulb, Sparkles, FileCode2, Package, Circle, ChevronRight, Monitor, Type, Image as ImageIcon, MousePointerClick, Rows3, ScrollText, Square, Eye, EyeOff, Play, Pause, Mountain, Spline, Search, X } from "lucide-react";
import { useSceneStore } from "../store/sceneStore.js";
import { useSelectionStore } from "../store/selectionStore.js";
import { useModulesStore } from "../modules.js";
import { commandBus } from "../commands/CommandBus.js";
import {
  BatchCommand,
  CreateEntityCommand,
  RenameEntityCommand,
  ReparentEntityCommand,
  SetEntityEnabledInEditorCommand,
  SetEntityEnabledInGameCommand,
  isDescendantOf,
  topMostIds,
} from "../commands/entityCommands.js";
import { AddComponentCommand, SetComponentPropCommand } from "../commands/componentCommands.js";
import {
  APPLY_MODES,
  APPLY_MODE_LABELS,
  applyTransformStatus,
  applyTransformToGeometry,
} from "../applyTransform.js";
import {
  copyEntities,
  cutEntities,
  pasteEntities,
  clipboardHasEntities,
  duplicateSelection,
  deleteSelection,
} from "../clipboard.js";
import { groupSelection } from "../group.js";
import { useAssetDrop } from "../assetDrag.js";
import { loadCollapsed, saveCollapsed } from "../hierarchyPrefs.js";
import {
  instantiatePrefab,
  openPrefabMode,
  exitPrefabMode,
  createPrefabFromEntity,
  createVariantFromInstance,
  applyPrefab,
  revertPrefab,
  unpackPrefab,
} from "../prefab.js";
import { usePrefabStore } from "../store/prefabStore.js";
import { prefabRegistry, diffInstance, getPrefabRoot } from "../../engine/index.js";
import { extOf, PREFAB_EXTENSIONS, MODEL_EXTENSIONS } from "../assetLoader.js";
import { basename } from "../store/projectStore.js";
import { isFollowPickArmed, disarmFollowPick, isSurfacePickArmed, disarmSurfacePick } from "./InspectorPanel.jsx";
import { isListenerPickArmed, disarmListenerPick } from "../components/ListenerSection.jsx";
import { disarmTerrainScatterSourcePick, getTerrainScatterSourcePick } from "../terrainBrush.js";
import { engine } from "../engineInstance.js";
import { newScene } from "../sceneIO.js";
import { createTerrainAssets } from "../terrainAssetSetup.js";
import { getCursor3DPosition } from "../threeDCursor.js";
import { ContextMenu as SharedContextMenu, isTextEditTarget } from "../ContextMenu.jsx";
import { openPanel } from "../EditorShell.jsx";
import { runWorkflow } from "../store/aiStore.js";
import { getWorkflow } from "../ai/workflows.js";
import { getActiveProvider } from "../ai/providers/index.js";

const DROPPABLE_ASSET_EXTENSIONS = [...PREFAB_EXTENSIONS, ...MODEL_EXTENSIONS];

/** Assets-panel drop onto the tree: spawn under `parentId` (null = root). */
function dropAssetOnEntity(path, parentId) {
  const ext = extOf(path);
  if (PREFAB_EXTENSIONS.includes(ext)) {
    instantiatePrefab(path, null, parentId).catch((err) => console.error(String(err)));
  } else if (MODEL_EXTENSIONS.includes(ext)) {
    // Raw .glb (legacy leftover or hand-copied file): run it through the
    // import pipeline — mesh entities + geometry/material assets — then drop
    // the resulting prefab where the user aimed.
    (async () => {
      const { unpackGlb } = await import("../glbImport.js");
      const folder = await unpackGlb(path);
      const stem = basename(path).replace(/\.[^.]+$/, "");
      await instantiatePrefab(`${folder}/${stem}.prefab`, null, parentId);
    })().catch((err) => console.error(String(err)));
  }
}

// Common base entities that live directly in the world. Always shown.
const COMMON_PRESETS = [
  { label: "Empty", Icon: Circle, color: "#8ea0b5", spec: { name: "Entity", components: [] } },
  // Mesh defaults to a box; the inspector's Geometry dropdown still exposes
  // sphere/plane/cylinder/cone/torus so users can pick the shape there.
  { label: "Mesh", Icon: Box, color: "#4da3ff", spec: { name: "Mesh", components: [{ type: "mesh", props: { geometry: "box" } }] } },
  // Light defaults to directional; the inspector's kind dropdown exposes
  // point/spot/ambient so users can pick the type there.
  { label: "Light", Icon: Lightbulb, color: "#f5c451", spec: { name: "Light", components: [{ type: "light", props: { kind: "directional" } }] } },
  { label: "Camera", Icon: Video, color: "#4da3ff", spec: { name: "Camera", components: [{ type: "camera" }] } },
  // Particles ship as a first-class object rather than "add an empty, then
  // remember which component makes it emit" — an emitter is a thing you place,
  // not a behaviour you bolt on. The component's own defaults drive the graph.
  { label: "Particles", Icon: Sparkles, color: "#b784f5", spec: { name: "Particles", components: [{ type: "particles", props: {} }] } },
  // A path is a placeable object, not a behaviour bolted onto an empty — the
  // same argument as Particles. Roads, patrol routes and camera rails all
  // start here and differ only in what you point at it afterwards.
  { label: "Path", Icon: Spline, color: "#8ea0b5", spec: { name: "Path", components: [{ type: "spline", props: {} }] } },
];

// Terrain lives in the optional `terrain` module — only offered in the Add
// menu when that module is enabled (mirrors how UI presets are gated).
const TERRAIN_PRESET = {
  label: "Terrain",
  Icon: Mountain,
  color: "#8ea0b5",
  spec: { name: "Terrain", components: [{ type: "terrain", props: {} }] },
};

// UI Screen — top-level UI container. Always shown so the user can add one
// from anywhere in the scene.
const UI_SCREEN_PRESET = {
  label: "UI Screen",
  Icon: Monitor,
  color: "#3fd0c9",
  spec: { name: "UI Screen", components: [{ type: "uiscreen" }] },
};

// UI elements (Panel / Image / Text / Button / Layout / Scroll View) only
// make sense inside a UI Screen. The hierarchy menu reveals them only when
// the active parent (currently selected entity, or the implicit scene root
// for the no-selection case) is a UI Screen, so users can't spawn an orphan
// Button at the scene root by accident.
const UI_ELEMENT_PRESETS = [
  {
    label: "UI Panel",
    Icon: Square,
    color: "#3fd0c9",
    spec: {
      name: "Panel",
      components: [
        { type: "uielement", props: { size: [360, 240] } },
        { type: "uiimage", props: { color: "#1c1d22", opacity: 0.92, cornerRadius: 14 } },
      ],
    },
  },
  {
    label: "UI Image",
    Icon: ImageIcon,
    color: "#3fd0c9",
    spec: {
      name: "Image",
      components: [{ type: "uielement", props: { size: [128, 128] } }, { type: "uiimage" }],
    },
  },
  {
    label: "UI Text",
    Icon: Type,
    color: "#3fd0c9",
    spec: {
      name: "Text",
      components: [
        { type: "uielement", props: { size: [220, 40] } },
        { type: "uitext", props: { text: "New Text" } },
      ],
    },
  },
  {
    label: "UI Button",
    Icon: MousePointerClick,
    color: "#3fd0c9",
    spec: {
      name: "Button",
      components: [
        { type: "uielement", props: { size: [180, 44] } },
        { type: "uiimage", props: { color: "#0a84ff", cornerRadius: 10 } },
        { type: "uibutton" },
      ],
      children: [
        {
          name: "Label",
          components: [
            {
              type: "uielement",
              props: { anchorMin: [0, 0], anchorMax: [1, 1], size: [0, 0], raycastTarget: false },
            },
            { type: "uitext", props: { text: "Button", fontWeight: "600" } },
          ],
        },
      ],
    },
  },
  {
    label: "UI Layout (Column)",
    Icon: Rows3,
    color: "#3fd0c9",
    spec: {
      name: "Layout",
      components: [
        { type: "uielement", props: { size: [300, 400] } },
        { type: "uilayout" },
      ],
    },
  },
  {
    label: "UI Scroll View",
    Icon: ScrollText,
    color: "#3fd0c9",
    spec: {
      name: "Scroll View",
      components: [
        { type: "uielement", props: { size: [320, 420] } },
        { type: "uiimage", props: { color: "#151619", opacity: 0.9, cornerRadius: 12 } },
        { type: "uiscroll" },
      ],
      children: [
        {
          name: "Content",
          components: [
            {
              type: "uielement",
              props: { anchorMin: [0, 0], anchorMax: [1, 0], pivot: [0.5, 0], size: [0, 420] },
            },
            { type: "uilayout", props: { fitContent: true } },
          ],
        },
      ],
    },
  },
];

/** One row in the Add menu: coloured glyph + label, so the list can be
 *  scanned by shape instead of read word by word. */
function PresetItem({ preset, onPick }) {
  const Icon = preset.Icon ?? Circle;
  return (
    <button className="dropdown-item component-item" onClick={() => onPick(preset.spec)}>
      <Icon size={14} style={{ color: preset.color ?? "#8ea0b5" }} className="component-item-icon" />
      <span className="component-item-label">{preset.label}</span>
    </button>
  );
}

/** True iff `parentId` refers to a UI Screen entity (or is null — the scene
 *  root, which is *not* a UI Screen). Used to gate UI element presets so
 *  they only appear when the user is adding inside a UI Screen. */
function isParentUiScreen(parentId) {
  if (!parentId) return false;
  const entity = useSceneStore.getState().entities[parentId];
  return !!entity?.components?.uiscreen;
}

/** Shared empty set so a scene with nothing collapsed doesn't allocate. */
const NO_COLLAPSE = new Set();

/** True when the mirrored entity table holds nothing — cheaper than
 *  `Object.keys(...).length` on a scene-sized map, and this is asked on every
 *  render of the panel. */
function hasNoEntities(entities) {
  for (const _ in entities) return false;
  return true;
}

/** The collapse set a scene with no remembered state opens with: every entity
 *  that has children, so only top-level rows show. */
function defaultCollapsedFor(entities) {
  const next = new Set();
  for (const id in entities) {
    if (entities[id]?.childIds?.length) next.add(id);
  }
  return next.size ? next : NO_COLLAPSE;
}

/** Drops ids that no longer name an entity — but only when there are entities
 *  to check against, so a mid-load empty table can never erase the set. */
function pruneCollapsed(ids, entities) {
  const valid = Object.keys(entities);
  if (!valid.length || !ids.size) return ids;
  const validSet = new Set(valid);
  let dropped = false;
  const next = new Set();
  for (const id of ids) {
    if (validSet.has(id)) next.add(id);
    else dropped = true;
  }
  return dropped ? next : ids;
}

// Tauri's `dragDropEnabled` (default true, needed by the Assets panel for OS
// file imports) intercepts the webview's native drag-and-drop wholesale —
// dragstart/dragover/drop never fire for HTML5 `draggable` elements either.
// So reordering here is implemented as a manual pointer-driven drag instead
// of relying on the HTML5 DnD API.
const DRAG_THRESHOLD_PX = 4;
let dragSession = null; // { ids, sourceId, startX, startY, moved }
let suppressNextClick = false;

// Hovering a drag over a collapsed row with children auto-expands it after
// a short delay, mirroring the OS file-explorer "hover to open" convention.
const HOVER_EXPAND_MS = 600;
let hoverExpandId = null;
let hoverExpandTimer = null;

function clearHoverExpand() {
  hoverExpandId = null;
  clearTimeout(hoverExpandTimer);
  hoverExpandTimer = null;
}

/** Finds the row (or the tree's empty area) under a point, DOM-based. */
function hitTestRow(clientX, clientY) {
  const el = document.elementFromPoint(clientX, clientY);
  if (!el) return null;
  const row = el.closest("[data-entity-id]");
  if (row) {
    const rect = row.getBoundingClientRect();
    const y = (clientY - rect.top) / rect.height;
    const pos = y < 0.25 ? "before" : y > 0.75 ? "after" : "on";
    return { id: row.dataset.entityId, pos };
  }
  return el.closest(".hierarchy-tree") ? { id: null, pos: "root" } : null;
}

/** Icon (and accent color) for what the entity primarily is, by component priority. */
function EntityIcon({ components }) {
  const { Icon, color } = components.uiscreen
    ? { Icon: Monitor, color: "icon-camera" }
    : components.uibutton
    ? { Icon: MousePointerClick, color: "icon-particles" }
    : components.uitext
    ? { Icon: Type, color: "icon-script" }
    : components.uiscroll
    ? { Icon: ScrollText, color: "icon-model" }
    : components.uilayout
    ? { Icon: Rows3, color: "icon-model" }
    : components.uiimage
    ? { Icon: ImageIcon, color: "icon-mesh" }
    : components.uielement
    ? { Icon: Square, color: "icon-default" }
    : components.camera
    ? { Icon: Video, color: "icon-camera" }
    : components.light
      ? { Icon: Lightbulb, color: "icon-light" }
      : components.particles
        ? { Icon: Sparkles, color: "icon-particles" }
        : components.spline
          ? // Before `mesh`, because a road carries both a path and the mesh
            // swept from it and the path is what the entity IS. The accent is
            // the same green the curve is drawn in, so the hierarchy row and
            // the thing in the viewport are recognisably one object.
            { Icon: Spline, color: "icon-path" }
          : components.terrain
          ? { Icon: Mountain, color: "icon-model" }
          : components.mesh
          ? { Icon: Box, color: "icon-mesh" }
          : components.model
            ? { Icon: Package, color: "icon-model" }
            : components.script
              ? { Icon: FileCode2, color: "icon-script" }
              : { Icon: Circle, color: "icon-default" };
  return <Icon className={`entity-icon ${color}`} size={13} strokeWidth={1.75} />;
}

/** Depth-first visible order of entity ids (for shift-range selection). */
function flattenTree(rootIds, entities) {
  const out = [];
  const walk = (id) => {
    const e = entities[id];
    if (!e) return;
    out.push(id);
    e.childIds.forEach(walk);
  };
  rootIds.forEach(walk);
  return out;
}

/** Walks the subtree under `id` and returns every descendant id (depth-first,
 *  no parent included). Used to fold/unfold entire branches in one pass. */
function collectDescendants(id, entities) {
  const out = [];
  const stack = [...(entities[id]?.childIds ?? [])];
  while (stack.length) {
    const cur = stack.pop();
    const e = entities[cur];
    if (!e) continue;
    out.push(cur);
    if (e.childIds.length) stack.push(...e.childIds);
  }
  return out;
}

/**
 * Rank an entity against the search query in the priority order the user
 * asked for. Returns a numeric tier where lower = better; `Infinity` means
 * "no match". Tiers:
 *   0 — name starts with query (case-insensitive)
 *   1 — name contains query
 *   2 — entity has a component whose type starts with query
 *   3 — entity has a component whose type contains query
 *   4 — entity carries a tag containing the query
 *
 * Both the name and every component type are checked in this priority, so
 * "can" jumps to the top for entities literally named "can" AND for any
 * entity carrying a `camera` component.
 *
 * A `tag:` prefix searches tags exclusively — "tag:enemy" finds every tagged
 * enemy without also dragging in the entity someone named "Enemy spawn note".
 */
function matchTier(entity, q) {
  const tags = (entity.tags ?? []).map((tag) => tag.toLowerCase());
  if (q.startsWith("tag:")) {
    const needle = q.slice(4).trim();
    if (!needle) return tags.length ? 0 : Infinity;
    if (tags.some((tag) => tag === needle)) return 0;
    return tags.some((tag) => tag.includes(needle)) ? 1 : Infinity;
  }
  const name = (entity.name ?? "").toLowerCase();
  if (name.startsWith(q)) return 0;
  if (name.includes(q)) return 1;
  const components = entity.components ?? {};
  for (const type of Object.keys(components)) {
    const t = type.toLowerCase();
    if (t.startsWith(q)) return 2;
  }
  for (const type of Object.keys(components)) {
    const t = type.toLowerCase();
    if (t.includes(q)) return 3;
  }
  if (tags.some((tag) => tag.includes(q))) return 4;
  return Infinity;
}

/**
 * Renders `name` with the (case-insensitive) `query` substring wrapped in
 * `<mark>` so the matched fragment pops visually. The original casing of
 * `name` is preserved in the output. Empty query renders the plain name.
 *
 * Only used inside a match row — it's the "this is why this row matched"
 * signal. Tiers 2/3 (component-name matches) don't substring-highlight
 * the entity name (the match was on a component type, not on the name),
 * so the highlight is suppressed for those tiers to avoid confusing the
 * user into thinking the name contained the query.
 */
function HighlightedName({ name, query, tier }) {
  if (!query || tier == null || tier >= 2) {
    return <span className="entity-name-text">{name}</span>;
  }
  const lower = name.toLowerCase();
  const q = query.toLowerCase();
  const idx = lower.indexOf(q);
  if (idx === -1) return <span className="entity-name-text">{name}</span>;
  const end = idx + query.length;
  return (
    <span className="entity-name-text">
      {name.slice(0, idx)}
      <mark className="hierarchy-search-mark">{name.slice(idx, end)}</mark>
      {name.slice(end)}
    </span>
  );
}

/** Builds the search index for the current scene: { id -> tier }. Walks the
 *  full scene (not just visible rows) so collapsed branches still surface
 *  when they match the query. Returns `null` when the query is empty so the
 *  caller can fast-path to "show everything". */
function buildSearchIndex(rootIds, entities, query) {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const out = {};
  const stack = [...rootIds];
  while (stack.length) {
    const id = stack.pop();
    const e = entities[id];
    if (!e) continue;
    const tier = matchTier(e, q);
    if (tier !== Infinity) out[id] = { tier };
    if (e.childIds.length) stack.push(...e.childIds);
  }
  return out;
}

/** Walks from `id` up to the scene root, collecting every ancestor id.
 *  Used to uncollapse the path to a search result so the user lands on
 *  the right row when search exits. */
function collectAncestors(id, entities) {
  const out = [];
  const parentsOf = new Map();
  for (const eid in entities) {
    const e = entities[eid];
    for (const childId of e.childIds) parentsOf.set(childId, eid);
  }
  let cur = parentsOf.get(id);
  while (cur) {
    out.push(cur);
    cur = parentsOf.get(cur);
  }
  return out;
}

function handleRowClick(e, id, rootIds, entities) {
  if (suppressNextClick) {
    suppressNextClick = false;
    return;
  }
  // If the inspector armed a "pick follow target" gesture, this click
  // resolves it: assign `id` as the follow target of whichever camera
  // entity is currently selected (single, mandatory) and disarm.
  if (isFollowPickArmed()) {
    disarmFollowPick();
    const cameraId = useSelectionStore.getState().ids[0];
    if (!cameraId) return;
    const camera = engine.getEntity(cameraId);
    if (!camera || !camera.getComponent("camera")) return;
    // Use a direct SetComponentPropCommand so the change is undoable and
    // matches every other prop change in the inspector.
    commandBus.execute(new SetComponentPropCommand(cameraId, "camera", "followTarget", id));
    return;
  }
  // If the inspector armed a "pick surface entity" gesture, this click
  // resolves it: assign `id` as the scatterSurfaceEntity on whichever
  // Instancer component is on the currently selected entity.
  if (isSurfacePickArmed()) {
    disarmSurfacePick();
    const instancerEntityId = useSelectionStore.getState().ids[0];
    if (!instancerEntityId) return;
    const instancerEntity = engine.getEntity(instancerEntityId);
    if (!instancerEntity || !instancerEntity.getComponent("instancer")) return;
    commandBus.execute(
      new SetComponentPropCommand(instancerEntityId, "instancer", "scatterSurfaceEntity", id),
    );
    return;
  }
  const terrainScatterPick = getTerrainScatterSourcePick();
  if (terrainScatterPick) {
    disarmTerrainScatterSourcePick();
    const source = engine.getEntity(id);
    const terrain = engine.getEntity(terrainScatterPick.terrainEntityId)?.getComponent("terrain");
    if (!source || !terrain || (!source.getComponent("mesh") && !source.getComponent("model"))) return;
    const layers = terrain.props.scatterLayers ?? [];
    if (!layers[terrainScatterPick.layerIndex]) return;
    commandBus.execute(new SetComponentPropCommand(
      terrainScatterPick.terrainEntityId,
      "terrain",
      "scatterLayers",
      layers.map((layer, index) => index === terrainScatterPick.layerIndex
        ? { ...layer, sourceType: "entity", sourceEntity: id }
        : layer),
    ));
    return;
  }
  // Listener target pick: move the listener to the picked entity. Yield the
  // current holder (if any) and add a ListenerComponent to the picked entity,
  // making it the new audio listener.
  if (isListenerPickArmed()) {
    disarmListenerPick();
    const sourceId = useSelectionStore.getState().ids[0];
    if (!sourceId || sourceId === id) return;
    const current = engine.audio?.listenerEntity;
    if (current && current.id !== id) {
      current.getComponent?.("listener")?.setEnabled?.(false);
    }
    const target = engine.getEntity(id);
    if (!target) return;
    if (!target.getComponent("listener")) {
      commandBus.execute(new AddComponentCommand(id, "listener"));
    } else {
      target.getComponent("listener").setEnabled(true);
    }
    return;
  }
  const sel = useSelectionStore.getState();
  if (e.ctrlKey || e.metaKey) {
    sel.toggle(id);
  } else if (e.shiftKey && sel.anchorId) {
    const order = flattenTree(rootIds, entities);
    const a = order.indexOf(sel.anchorId);
    const b = order.indexOf(id);
    if (a === -1 || b === -1) return sel.select(id);
    sel.select(order.slice(Math.min(a, b), Math.max(a, b) + 1), sel.anchorId);
  } else {
    sel.select(id);
  }
}

/**
 * Applies a drop. `pos` is "on" (make child of target), or "before"/"after"
 * (insert as sibling of target). Reparents all dragged top-most entities in
 * one undo step.
 */
function performDrop(draggedIds, targetId, pos) {
  const { entities, rootIds } = useSceneStore.getState();
  const ids = topMostIds(draggedIds).filter((id) => entities[id]);
  const parentId = pos === "on" ? targetId : (entities[targetId]?.parentId ?? null);

  const valid = ids.filter(
    (id) => id !== targetId && !(parentId && isDescendantOf(parentId, id)) && id !== parentId,
  );
  if (!valid.length) return;

  const cmds = [];
  if (pos === "on") {
    for (const id of valid) {
      if (entities[id]?.parentId !== parentId) cmds.push(new ReparentEntityCommand(id, parentId));
      else cmds.push(new ReparentEntityCommand(id, parentId, null)); // move to end
    }
  } else {
    // Sibling list without the dragged entities → stable insertion index.
    const siblings = (parentId ? entities[parentId].childIds : rootIds).filter((id) => !valid.includes(id));
    let index = siblings.indexOf(targetId);
    if (index === -1) index = siblings.length;
    if (pos === "after") index += 1;
    valid.forEach((id, i) => cmds.push(new ReparentEntityCommand(id, parentId, index + i)));
  }
  commandBus.execute(new BatchCommand(cmds, cmds.length === 1 ? cmds[0].label : `Move ${cmds.length} entities`));
}

/** Drop onto the empty tree area: move dragged top-most entities to scene root. */
function performDropToRoot(draggedIds) {
  const { entities } = useSceneStore.getState();
  const ids = topMostIds(draggedIds).filter((id) => entities[id]?.parentId);
  if (!ids.length) return;
  const cmds = ids.map((id) => new ReparentEntityCommand(id, null));
  commandBus.execute(new BatchCommand(cmds, cmds.length === 1 ? cmds[0].label : `Move ${cmds.length} entities`));
}

/**
 * Per-row visibility icons. Two compact buttons toggle the entity's
 * editor-mode and game-mode enabled flags respectively — the first uses
 * an Eye/EyeOff pair (editor visibility is the most-edited), the second
 * uses Play/Pause so the two states are visually distinct in a narrow
 * row. Each click is a single, undoable command. The icons read live
 * values via `engine.getEntity(...)?.[flag]` rather than the React
 * mirror so toggles made from the inspector reflect immediately. They
 * live inside the row but stop propagation so they don't change
 * selection.
 */
function VisibilityIcons({ id }) {
  const live = engine.getEntity(id);
  if (!live) return null;
  const editorOn = live.enabledInEditor !== false;
  const gameOn = live.enabledInGame !== false;
  return (
    <span
      className="hierarchy-vis-icons"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className={`hierarchy-vis-icon ${editorOn ? "on" : "off"}`}
        title={editorOn ? "Visible in editor — click to hide" : "Hidden in editor — click to show"}
        onClick={() =>
          commandBus.execute(new SetEntityEnabledInEditorCommand(id, !editorOn))
        }
      >
        {editorOn ? <Eye size={12} /> : <EyeOff size={12} />}
      </button>
      <button
        type="button"
        className={`hierarchy-vis-icon ${gameOn ? "on" : "off"}`}
        title={gameOn ? "Enabled in game — click to disable" : "Disabled in game — click to enable"}
        onClick={() =>
          commandBus.execute(new SetEntityEnabledInGameCommand(id, !gameOn))
        }
      >
        {gameOn ? <Play size={10} /> : <Pause size={10} />}
      </button>
    </span>
  );
}

/**
 * Prefab state for one row: is it an instance root (blue name + badge), a node
 * *inside* an instance (blue name only), or an ordinary entity? Subscribing to
 * the registry version is what makes the badge light up the moment a prefab is
 * created, applied or reverted.
 */
function usePrefabRowInfo(id) {
  usePrefabStore((s) => s.version);
  const live = engine.getEntity(id);
  const root = live ? getPrefabRoot(live) : null;
  if (!root) return {};
  const isRoot = root === live;
  const guid = prefabRegistry.resolveLink(root.prefab);
  const def = guid ? prefabRegistry.getDef(guid) : null;
  return {
    kind: isRoot ? "root" : "child",
    name: def?.name ?? "Prefab",
    path: guid ? prefabRegistry.pathOf(guid) : null,
    missing: !guid,
    // Only the root carries overrides, so only the root can look "modified".
    dirty: isRoot && !!guid && diffInstance(root).length > 0,
  };
}

function EntityRow({
  id,
  depth,
  renamingId,
  setRenamingId,
  dropHint,
  setDropHint,
  onContextMenu,
  rootIds,
  collapsedIds,
  onToggleCollapsed,
  draggingIds,
  onRowPointerDown,
  searchMatches,
  searchQuery,
  onPickSearchResult,
}) {
  const entity = useSceneStore((s) => s.entities[id]);
  const selected = useSelectionStore((s) => s.ids.includes(id));
  const prefab = usePrefabRowInfo(id);
  // Assets-panel drags (.prefab/.entity/.glb) land on rows as "add as child".
  const assetDropRef = useAssetDrop({
    accepts: DROPPABLE_ASSET_EXTENSIONS,
    onDrop: (path) => dropAssetOnEntity(path, id),
  });
  if (!entity) return null;

  const isDragging = draggingIds.includes(id);

  // Search visibility: when the panel has built a match index, only rows
  // that actually matched render. The hierarchy is reduced to a flat list
  // of hits — the user picks one, the panel clears the query and uncollapses
  // the path to that entity so they land in the regular tree view.
  const searchMatch = searchMatches ? searchMatches[id] ?? null : null;
  const isSearching = !!searchMatches;
  const hidden = isSearching && !searchMatch;
  if (hidden) return null;

  // While searching, render every match at depth 0 for a clean vertical
  // list — original nesting is irrelevant when the tree is filtered.
  const effectiveDepth = isSearching ? 0 : depth;
  const hasChildren = !isSearching && entity.childIds.length > 0;
  const collapsed = hasChildren && collapsedIds.has(id);

  // While searching, clicking a hit exits the search and lands the user on
  // the full hierarchy with that entity's path uncollapsed and selected.
  // Outside of search, the regular select / drag / pick handlers in
  // handleRowClick apply.
  const onRowClick = (e) => {
    if (isSearching) {
      e.stopPropagation();
      onPickSearchResult?.(id);
      return;
    }
    handleRowClick(e, id, rootIds, useSceneStore.getState().entities);
  };

  const commitRename = (value) => {
    setRenamingId(null);
    const name = value.trim();
    if (name && name !== entity.name) {
      commandBus.execute(new RenameEntityCommand(id, name));
    }
  };

  // Toggle the persisted collapse state. The actual state mutation (with
  // descendant-collapse rule) lives in the panel — the row only forwards
  // intent so the rule has one implementation.
  const onChevronClick = (e) => {
    e.stopPropagation();
    onToggleCollapsed(id);
  };

  const hintPos = dropHint?.id === id ? dropHint.pos : null;
  const rowClasses = [
    "hierarchy-row",
    selected ? "selected" : "",
    isDragging ? "row-dragging" : "",
    hintPos === "on" ? "drop-target" : "",
    hintPos === "before" ? "drop-before" : "",
    hintPos === "after" ? "drop-after" : "",
    searchMatch ? `hierarchy-search-match tier-${searchMatch.tier}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      <div
        className={rowClasses}
        style={{ paddingLeft: 8 + effectiveDepth * 14 }}
        data-entity-id={id}
        ref={assetDropRef}
        onClick={onRowClick}
        onDoubleClick={() => setRenamingId(id)}
        onContextMenu={(e) => onContextMenu(e, id)}
        onPointerDown={(e) => onRowPointerDown(e, id)}
      >
        {hasChildren ? (
          <button className={`row-disclosure ${collapsed ? "collapsed" : ""}`} onClick={onChevronClick}>
            <ChevronRight size={12} strokeWidth={2} />
          </button>
        ) : (
          <span className="row-disclosure-spacer" />
        )}
        {renamingId === id ? (
          <input
            className="rename-input"
            autoFocus
            defaultValue={entity.name}
            onFocus={(e) => e.target.select()}
            onBlur={(e) => commitRename(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename(e.target.value);
              if (e.key === "Escape") setRenamingId(null);
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <>
            <EntityIcon components={entity.components} />
            <span className={`entity-name ${prefab.kind ? `prefab-${prefab.kind}` : ""}`}>
              <HighlightedName name={entity.name} query={searchQuery} tier={searchMatch?.tier ?? null} />
            </span>
            {prefab.kind === "root" && (
              <span
                className={`prefab-badge ${prefab.dirty ? "dirty" : ""} ${prefab.missing ? "missing" : ""}`}
                title={
                  prefab.missing
                    ? "Prefab asset is missing"
                    : `Prefab instance: ${prefab.name}${prefab.dirty ? " (modified)" : ""} — double-click to open`
                }
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  if (prefab.path) openPrefabMode(prefab.path);
                }}
              >
                <Package size={11} />
                {prefab.dirty && <span className="prefab-dot" />}
              </span>
            )}
          </>
        )}
        <VisibilityIcons id={id} />
      </div>
      {!isSearching && !collapsed &&
        entity.childIds.map((childId) => (
          <EntityRow
            key={childId}
            id={childId}
            depth={depth + 1}
            renamingId={renamingId}
            setRenamingId={setRenamingId}
            dropHint={dropHint}
            setDropHint={setDropHint}
            onContextMenu={onContextMenu}
            rootIds={rootIds}
            collapsedIds={collapsedIds}
            forcedCollapsed={null}
            onToggleCollapsed={onToggleCollapsed}
            draggingIds={draggingIds}
            onRowPointerDown={onRowPointerDown}
            searchMatches={searchMatches}
            searchQuery={searchQuery}
            onPickSearchResult={onPickSearchResult}
          />
        ))}
    </>
  );
}

/**
 * The prefab half of the row context menu. What's on offer depends on whether
 * the row is a prefab instance (apply / revert / unpack / open) or a plain
 * entity (create a prefab out of it).
 */
/**
 * Blender's Object → Apply submenu, flattened (this menu has no submenus).
 *
 * Only offered on a row that has geometry to bake into — on anything else the
 * five entries would be five greyed-out lines of noise in the menu everyone
 * uses for Duplicate and Delete.
 */
function applyTransformMenuItems(single) {
  if (!single) return [];
  const status = applyTransformStatus(single);
  if (!status.ok) return [];
  return [
    { separator: true },
    { header: "Apply Transform" },
    ...APPLY_MODES.map((mode) => ({
      label: APPLY_MODE_LABELS[mode],
      // The fork is the part a user needs warning about, because it creates a
      // file and quietly stops sharing one.
      hint: status.fork ? "saves a new .geom" : undefined,
      action: async () => {
        const result = await applyTransformToGeometry(single, mode);
        // Success and refusal both end up in the console: the hierarchy has no
        // status line, and silently doing nothing is the worst outcome for an
        // operation whose whole point is that the numbers change.
        if (result.ok) console.log(result.message);
        else console.warn(`Apply Transform: ${result.message}`);
      },
    })),
  ];
}

function prefabMenuItems(single) {
  if (!single) return [];
  const live = engine.getEntity(single);
  if (!live) return [];
  const root = getPrefabRoot(live);

  if (!root) {
    return [{ separator: true }, { label: "Create Prefab…", action: () => createPrefabFromEntity(single) }];
  }

  // Apply/Revert always act on the instance root, even when the click was on a
  // child inside it — that's the object that owns the overrides.
  const rootId = root.id;
  const dirty = diffInstance(root).length > 0;
  const assetPath = root.prefab ? prefabRegistry.pathOf(prefabRegistry.resolveLink(root.prefab)) : null;

  return [
    { separator: true },
    { label: "Open Prefab", disabled: !assetPath, action: () => openPrefabMode(assetPath) },
    { label: "Select Prefab Asset", disabled: !assetPath, action: () => useSelectionStore.getState().selectAsset(assetPath) },
    { label: "Apply All", disabled: !dirty, action: () => applyPrefab(rootId) },
    { label: "Revert All", disabled: !dirty, action: () => revertPrefab(rootId) },
    { label: "Create Prefab Variant…", action: () => createVariantFromInstance(rootId) },
    { label: "Unpack Prefab", action: () => unpackPrefab(rootId, { deep: false }) },
    { label: "Unpack Completely", action: () => unpackPrefab(rootId, { deep: true }) },
  ];
}

function ContextMenu({ menu, close, setRenamingId, onCreate, onNewScene, terrainEnabled }) {
  const selection = useSelectionStore.getState().ids;
  const single = selection.length === 1 ? selection[0] : null;
  const canPaste = clipboardHasEntities();

  // A mutating workflow may only run on a provider that can close its own
  // tool set (see aiStore.runWorkflow — this mirrors that check so the menu
  // item is disabled rather than offered-then-refused).
  const diagnoseWorkflow = getWorkflow("diagnose-selected");
  const aiProvider = getActiveProvider();
  const aiBlockedHint =
    diagnoseWorkflow?.mutates && !aiProvider?.capabilities?.scopedTools
      ? `${aiProvider?.label ?? "This provider"} cannot limit itself to this workflow's tools. Switch to a scoped provider (e.g. Ollama).`
      : undefined;

  // Right-click on empty tree space is a "create here" gesture, not an
  // "operate on the selection" one — offering Delete/Rename for whatever
  // happened to be selected elsewhere would act on something off-screen.
  const items = menu.empty
    ? [
        { header: "Create" },
        ...[...COMMON_PRESETS, ...(terrainEnabled ? [TERRAIN_PRESET] : [])].map((preset) => ({
          label: preset.label,
          icon: preset.Icon,
          action: () => onCreate(preset.spec),
        })),
        { label: UI_SCREEN_PRESET.label, icon: UI_SCREEN_PRESET.Icon, action: () => onCreate(UI_SCREEN_PRESET.spec) },
        { separator: true },
        { label: "Paste", shortcut: "Ctrl+V", disabled: !canPaste, action: () => pasteEntities(null) },
        { label: "New Scene", action: onNewScene },
      ]
    : [
        { label: "Copy", shortcut: "Ctrl+C", action: () => copyEntities(selection) },
        { label: "Cut", shortcut: "Ctrl+X", action: () => cutEntities(selection) },
        {
          label: "Paste",
          shortcut: "Ctrl+V",
          disabled: !canPaste,
          action: () => pasteEntities(single ? useSceneStore.getState().entities[single]?.parentId : null),
        },
        { label: "Paste as Child", disabled: !canPaste || !single, action: () => pasteEntities(single) },
        { separator: true },
        { label: "Duplicate", shortcut: "Ctrl+D", action: duplicateSelection },
        { label: "Group Selection", shortcut: "Ctrl+G", disabled: selection.length < 2, action: groupSelection },
        { label: "Rename", disabled: !single, action: () => setRenamingId(single) },
        ...applyTransformMenuItems(single),
        ...prefabMenuItems(single),
        { separator: true },
        {
          label: "AI: Diagnose this",
          icon: Sparkles,
          disabled: !single || !!aiBlockedHint,
          hint: aiBlockedHint,
          action: () => {
            openPanel("ai");
            runWorkflow("diagnose-selected", single);
          },
        },
        { separator: true },
        { label: "Delete", shortcut: "Del", danger: true, action: deleteSelection },
      ];

  return <SharedContextMenu x={menu.x} y={menu.y} items={items} onClose={close} />;
}

export function HierarchyPanel() {
  const rootIds = useSceneStore((s) => s.rootIds);
  const sceneName = useSceneStore((s) => s.sceneName);
  const dirty = useSceneStore((s) => s.dirty);
  const selection = useSelectionStore((s) => s.ids);
  const terrainEnabled = useModulesStore((s) => s.enabled.includes("terrain"));
  const stage = usePrefabStore((s) => s.stage);
  const stageDirty = usePrefabStore((s) => s.stageDirty);
  const [renamingId, setRenamingId] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dropHint, setDropHint] = useState(null);
  const [contextMenu, setContextMenu] = useState(null); // {x, y}
  // The collapse set and the scene it belongs to are ONE piece of state.
  // They used to be a `useState` set beside a `useRef` key, and the two could
  // disagree for a render: the key advanced to the freshly-loaded scene while
  // the ids still described the previous one, and the persist effect wrote
  // that pairing to localStorage. The scene came back fully unfolded and its
  // remembered folding was gone — which is exactly the "forgets on every
  // startup" symptom. Bundled, a key change and its ids can never be out of
  // step, because they are set in the same call.
  const [collapse, setCollapse] = useState(() => ({ key: null, ids: NO_COLLAPSE }));
  const [draggingIds, setDraggingIds] = useState([]);
  const [ghostPos, setGhostPos] = useState(null); // {x, y}
  const [searchQuery, setSearchQuery] = useState("");

  // Assets dropped on empty tree space spawn at the scene root.
  const treeAssetDropRef = useAssetDrop({
    accepts: DROPPABLE_ASSET_EXTENSIONS,
    onDrop: (path) => dropAssetOnEntity(path, null),
  });

  // Whenever the scene swaps (boot, File → Open, File → New Scene, project
  // switch), adopt that scene's remembered collapse state — DURING RENDER, not
  // in an effect. An effect runs after the browser has painted the committed
  // tree, which is why the hierarchy used to appear fully unfolded for a frame
  // and then snap shut. Setting state while rendering is React's supported way
  // to adjust state to a changed input: it throws this render away and redoes
  // it immediately, so the first tree that reaches the screen is already
  // folded.
  //
  // `rootIds` is not a trigger. It changes on every hierarchy edit, and the
  // scene name is the thing that identifies which saved set applies.
  //
  // A saved set is adopted the moment the name changes — it needs no entities
  // to be correct, and waiting would risk saving over it. A *default* waits
  // until entities exist: a scene loads its name before its contents, and
  // "nothing here has children" recorded as the user's folding is how a fresh
  // scene would open flat forever after.
  const entitiesNow = useSceneStore.getState().entities;
  const savedCollapse = collapse.key === sceneName ? null : loadCollapsed(sceneName);
  const pendingCollapse =
    collapse.key === sceneName || (!savedCollapse && hasNoEntities(entitiesNow))
      ? null
      : { key: sceneName, ids: savedCollapse ?? defaultCollapsedFor(entitiesNow) };
  if (pendingCollapse) setCollapse(pendingCollapse);
  const collapsedIds = (pendingCollapse ?? collapse).ids;

  /** Applies an updater to the collapse set, keeping it bound to its scene.
   *  Returning the same set is a no-op, so callers can bail without forcing a
   *  render and a redundant localStorage write. */
  const setCollapsedIds = (updater) =>
    setCollapse((prev) => {
      const ids = typeof updater === "function" ? updater(prev.ids) : updater;
      return ids === prev.ids ? prev : { key: prev.key, ids };
    });

  // Persist whenever the pair changes. Stale ids are dropped here rather than
  // on load: this runs after a commit, where an empty entity table means the
  // scene really is empty and not merely still loading.
  useEffect(() => {
    if (collapse.key === null) return;
    saveCollapsed(collapse.key, pruneCollapsed(collapse.ids, useSceneStore.getState().entities));
  }, [collapse]);

  // Manual pointer-driven drag (see the DRAG_THRESHOLD_PX comment above):
  // pointerdown on a row arms a session; once the pointer moves past the
  // threshold it becomes an active drag, hit-tested purely via the DOM
  // (elementFromPoint) since HTML5 DnD events don't reach us in Tauri.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Escape") return;
    if (isFollowPickArmed()) disarmFollowPick();
    else if (isSurfacePickArmed()) disarmSurfacePick();
    else if (isListenerPickArmed()) disarmListenerPick();
    else if (getTerrainScatterSourcePick()) disarmTerrainScatterSourcePick();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const onMove = (e) => {
      if (!dragSession) return;
      if (!dragSession.moved) {
        const dx = e.clientX - dragSession.startX;
        const dy = e.clientY - dragSession.startY;
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        dragSession.moved = true;
        const sel = useSelectionStore.getState().ids;
        dragSession.ids = sel.includes(dragSession.sourceId) ? [...sel] : [dragSession.sourceId];
        setDraggingIds(dragSession.ids);
      }
      setGhostPos({ x: e.clientX, y: e.clientY });

      const hit = hitTestRow(e.clientX, e.clientY);
      if (!hit || hit.id === null || dragSession.ids.includes(hit.id)) {
        setDropHint(null);
        clearHoverExpand();
        return;
      }
      setDropHint((cur) => (cur?.id === hit.id && cur.pos === hit.pos ? cur : { id: hit.id, pos: hit.pos }));

      const entities = useSceneStore.getState().entities;
      const hasChildren = (entities[hit.id]?.childIds.length ?? 0) > 0;
      if (hit.pos === "on" && hasChildren) {
        if (hoverExpandId !== hit.id) {
          clearHoverExpand();
          hoverExpandId = hit.id;
          hoverExpandTimer = setTimeout(() => {
            setCollapsedIds((prev) => {
              if (!prev.has(hit.id)) return prev;
              const next = new Set(prev);
              next.delete(hit.id);
              return next;
            });
            clearHoverExpand();
          }, HOVER_EXPAND_MS);
        }
      } else if (hoverExpandId) {
        clearHoverExpand();
      }
    };

    const onUp = (e) => {
      if (!dragSession) return;
      if (dragSession.moved) {
        suppressNextClick = true;
        setTimeout(() => (suppressNextClick = false), 300);
        const hit = hitTestRow(e.clientX, e.clientY);
        if (hit && !dragSession.ids.includes(hit.id)) {
          if (hit.id === null) performDropToRoot(dragSession.ids);
          else performDrop(dragSession.ids, hit.id, hit.pos);
        }
      }
      dragSession = null;
      clearHoverExpand();
      setDraggingIds([]);
      setDropHint(null);
      setGhostPos(null);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      dragSession = null;
      clearHoverExpand();
    };
  }, []);

  const onRowPointerDown = (e, id) => {
    if (e.button !== 0 || renamingId === id) return;
    if (e.target.closest("button, input")) return;
    dragSession = { ids: null, sourceId: id, startX: e.clientX, startY: e.clientY, moved: false };
  };

  /** Toggle a node's collapsed state, applying the user's stated rule:
   *  uncollapsing an entity also collapses every descendant. The
   *  chevron is a real toggle — clicking a currently-expanded row folds
   *  it back up, and clicking a currently-collapsed row opens it one
   *  level deep (with all of its descendants collapsed in turn, until
   *  the user uncollapses them). */
  const onToggleCollapsed = (id) => {
    const entities = useSceneStore.getState().entities;
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        // Currently collapsed → user wants to unfold. Remove this id AND
        // collapse every descendant so the branch opens one level deep.
        next.delete(id);
        for (const d of collectDescendants(id, entities)) {
          if (entities[d]?.childIds?.length) next.add(d);
        }
        return next;
      }
      // Currently expanded → user wants to fold. Just add this id; any
      // descendants already in the set stay collapsed (they were folded
      // when the user previously unfolded this branch one level deep).
      next.add(id);
      return next;
    });
  };

  /** Search-mode "exit to entity": when the user clicks a hit, clear the
   *  query, drop every ancestor of the chosen entity from `collapsedIds`
   *  so the path is fully expanded, and select the entity. The hierarchy
   *  then snaps back to its normal tree view, focused on the picked row. */
  const onPickSearchResult = (id) => {
    const entities = useSceneStore.getState().entities;
    const ancestors = collectAncestors(id, entities);
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      for (const a of ancestors) next.delete(a);
      return next;
    });
    useSelectionStore.getState().select(id);
    setSearchQuery("");
  };

  // Search → match index. Recomputed only when the query or scene changes;
  // empty query short-circuits to `null` so the tree falls back to normal
  // (unfiltered) rendering.
  //
  // Subscribe to the entities map ONLY while a query is active: rows track
  // their own entity via per-id selectors, but a whole-map subscription
  // here re-rendered the entire panel (every un-memoized row, its prefab
  // diff, its visibility icons) on EVERY gizmo-drag frame — sceneStore's
  // updateTransform replaces the map object per pointermove. With no
  // query the selector returns a stable null and drag frames skip React
  // entirely.
  const entities = useSceneStore((s) => (searchQuery.trim() ? s.entities : null));
  const searchMatches = useMemo(() => buildSearchIndex(rootIds, entities, searchQuery), [rootIds, entities, searchQuery]);
  // No more ancestor-aware collapse overlay: in search mode the row hides
  // anything that isn't a match, so the user's saved `collapsedIds` is
  // simply ignored. Clearing the search restores the exact prior state.

  // Sorted match ids for the "X results" pill. Tier-0/1 (name) first, then
  // tier-2/3 (component), with name as the stable tiebreaker.
  const sortedMatchIds = useMemo(() => {
    if (!searchMatches) return [];
    return Object.keys(searchMatches).sort((a, b) => {
      const t = searchMatches[a].tier - searchMatches[b].tier;
      if (t !== 0) return t;
      return (entities[a]?.name ?? "").localeCompare(entities[b]?.name ?? "");
    });
  }, [searchMatches, entities]);

  const createEntity = async (spec) => {
    setMenuOpen(false);
    const selected = useSelectionStore.getState().ids;
    const parentId = selected.length === 1 ? selected[0] : null;
    let prepared = spec;
    if (spec.components?.some((component) => component.type === "terrain")) {
      try {
        const assets = await createTerrainAssets(spec.components.find((component) => component.type === "terrain")?.props);
        if (assets) {
          const components = [...(spec.components ?? [])];
          const meshIndex = components.findIndex((component) => component.type === "mesh");
          if (meshIndex === -1) {
            components.unshift({ type: "mesh", props: { geometryAsset: assets.geometryAsset, material: assets.material } });
          } else {
            components[meshIndex] = {
              ...components[meshIndex],
              props: { ...components[meshIndex].props, geometryAsset: assets.geometryAsset, material: assets.material },
            };
          }
          prepared = { ...spec, components };
        }
      } catch (err) {
        console.error(`Could not create terrain assets: ${err}`);
      }
    }
    // New entities snap to the 3D cursor by default — like Blender's
    // "Add Mesh at Cursor" behavior. Parent override still wins: when the
    // user explicitly adds inside a selected entity that entity owns the
    // transform, so we keep the default origin in that branch.
    if (!parentId && !spec.transform) {
      prepared = {
        ...prepared,
        transform: {
          position: getCursor3DPosition().toArray(),
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
        },
      };
    }
    const cmd = new CreateEntityCommand(parentId ? { ...prepared, parentId } : prepared);
    commandBus.execute(cmd);
    useSelectionStore.getState().select(cmd.entityId);
    if (parentId) {
      setCollapsedIds((prev) => {
        if (!prev.has(parentId)) return prev;
        const next = new Set(prev);
        next.delete(parentId);
        return next;
      });
    }
  };

  /** Creates and opens a fresh scene. Reuses sceneIO.newScene so the new
   *  scene follows the same path it does from File → New Scene (baseline
   *  content + autosave when a project is open). Errors are logged there. */
  const createScene = () => {
    setMenuOpen(false);
    newScene().catch((err) => console.warn(`Couldn't create new scene: ${err}`));
  };

  const onRowContextMenu = (e, id) => {
    // A row mid-rename is a text field; let the edit menu win.
    if (isTextEditTarget(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    if (!useSelectionStore.getState().ids.includes(id)) {
      useSelectionStore.getState().select(id);
    }
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  return (
    <div className="hierarchy-panel">
      {stage && (
        <div className="prefab-stage-bar" title="You are editing a prefab in isolation — the scene is set aside">
          <button
            className="prefab-stage-back"
            onClick={() => exitPrefabMode({ save: true }).catch((err) => console.error(String(err)))}
          >
            <ChevronRight size={12} className="prefab-stage-chevron" />
            Scenes
          </button>
          <span className="prefab-stage-name">
            <Package size={12} />
            {stage.name}
            {stageDirty && <span className="prefab-dot" />}
          </span>
        </div>
      )}
      <div className="panel-toolbar">
        <div className="dropdown-wrap">
          <button className="toolbar-btn" onClick={() => setMenuOpen((v) => !v)}> <Plus size={14} /> </button>
          {menuOpen && (
            <>
              <div className="dropdown-overlay" onClick={() => setMenuOpen(false)} />
              <div className="dropdown-menu component-menu">
                <div className="dropdown-section-label">Scene</div>
                <button key="New Scene" className="dropdown-item component-item" onClick={createScene}>
                  <FileCode2 size={14} style={{ color: "#8ea0b5" }} className="component-item-icon" />
                  <span className="component-item-label">New Scene</span>
                </button>
                <div className="dropdown-section-label">Entity</div>
                {[...COMMON_PRESETS, ...(terrainEnabled ? [TERRAIN_PRESET] : [])].map((p) => (
                  <PresetItem key={p.label} preset={p} onPick={createEntity} />
                ))}
                <div className="dropdown-section-label">UI</div>
                <PresetItem preset={UI_SCREEN_PRESET} onPick={createEntity} />
                {isParentUiScreen(useSelectionStore.getState().ids[0] ?? null) &&
                  UI_ELEMENT_PRESETS.map((p) => (
                    <PresetItem key={p.label} preset={p} onPick={createEntity} />
                  ))}
              </div>
            </>
          )}
        </div>
        <button
          className="toolbar-btn icon-only"
          title="Delete selection (Del)"
          disabled={!selection.length}
          onClick={deleteSelection}
        >
          <Trash2 size={14} />
        </button>
        <div className="hierarchy-search">
          <Search size={12} className="hierarchy-search-icon" />
          <input
            className="hierarchy-search-input"
            type="text"
            placeholder="Search name, component, tag:…"
            title="Search by name or component type. Prefix with tag: to search tags only."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && searchQuery) {
                e.stopPropagation();
                setSearchQuery("");
                return;
              }
              // Enter on a non-empty query jumps straight to the top match:
              // clear the search, uncollapse the path to that entity, and
              // select it. Mirrors what happens on click but keeps the
              // keyboard flow for "type → Enter → land" without a mouse.
              if (e.key === "Enter" && sortedMatchIds.length > 0) {
                e.preventDefault();
                e.stopPropagation();
                onPickSearchResult(sortedMatchIds[0]);
              }
            }}
            spellCheck={false}
          />
          {searchQuery && (
            <button
              type="button"
              className="hierarchy-search-clear"
              title="Clear search (Esc)"
              onClick={() => setSearchQuery("")}
            >
              <X size={11} />
            </button>
          )}
          {searchQuery && (
            <span
              className={`hierarchy-search-count ${sortedMatchIds.length === 0 ? "is-zero" : ""}`}
              title={`${sortedMatchIds.length} match${sortedMatchIds.length === 1 ? "" : "es"}`}
            >
              {sortedMatchIds.length}
            </span>
          )}
        </div>
      </div>
      <div className="scene-label">
        {sceneName}
        {dirty ? " •" : ""}
      </div>
      <div
        className={`hierarchy-tree ${isFollowPickArmed() || getTerrainScatterSourcePick() ? "follow-pick-armed" : ""}`}
        ref={treeAssetDropRef}
        onClick={(e) => {
          if (isFollowPickArmed()) {
            // A click on a row already handled the pick via handleRowClick;
            // only react here for clicks on the empty tree area to disarm.
            if (e.target === e.currentTarget) disarmFollowPick();
            return;
          }
          if (getTerrainScatterSourcePick()) {
            if (e.target === e.currentTarget) disarmTerrainScatterSourcePick();
            return;
          }
          if (e.target === e.currentTarget) useSelectionStore.getState().clear();
        }}
        onContextMenu={(e) => {
          // Rows stop propagation, so anything reaching here is empty space.
          e.preventDefault();
          e.stopPropagation();
          setContextMenu({ x: e.clientX, y: e.clientY, empty: true });
        }}
      >
        {(searchMatches ? sortedMatchIds : rootIds).map((id) => (
          <EntityRow
            key={id}
            id={id}
            depth={0}
            renamingId={renamingId}
            setRenamingId={setRenamingId}
            dropHint={dropHint}
            setDropHint={setDropHint}
            onContextMenu={onRowContextMenu}
            rootIds={rootIds}
            collapsedIds={collapsedIds}
            forcedCollapsed={null}
            onToggleCollapsed={onToggleCollapsed}
            draggingIds={draggingIds}
            onRowPointerDown={onRowPointerDown}
            searchMatches={searchMatches}
            searchQuery={searchQuery}
            onPickSearchResult={onPickSearchResult}
          />
        ))}
        {searchMatches && sortedMatchIds.length === 0 && (
          <div className="hierarchy-search-empty">No entities match “{searchQuery}”.</div>
        )}
      </div>
      {contextMenu && (
        <ContextMenu
          menu={contextMenu}
          close={() => setContextMenu(null)}
          setRenamingId={setRenamingId}
          onCreate={createEntity}
          onNewScene={createScene}
          terrainEnabled={terrainEnabled}
        />
      )}
      {ghostPos && draggingIds.length > 0 && (
        <div className="hierarchy-drag-ghost" style={{ left: ghostPos.x, top: ghostPos.y }}>
          {draggingIds.length === 1
            ? (useSceneStore.getState().entities[draggingIds[0]]?.name ?? "Entity")
            : `${draggingIds.length} entities`}
        </div>
      )}
    </div>
  );
}
