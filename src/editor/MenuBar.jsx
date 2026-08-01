import { useEffect, useState } from "react";
import { commandBus, useHistoryStore } from "./commands/CommandBus.js";
import { useSelectionStore } from "./store/selectionStore.js";
import { useSceneStore } from "./store/sceneStore.js";
import {
  copyEntities,
  cutEntities,
  pasteEntities,
  clipboardHasEntities,
  duplicateSelection,
  deleteSelection,
} from "./clipboard.js";
import { groupSelection } from "./group.js";
import { newScene, openScene, saveScene } from "./sceneIO.js";
import { useProjectStore } from "./store/projectStore.js";
import { openPanel, resetLayout } from "./EditorShell.jsx";
import { describeBinding, getBinding, visibilityActions } from "./keybindings.js";
import { ProcessingIndicator } from "./components/ProcessingIndicator.jsx";
import {
  setCursor3DPosition,
  toggleCursor3DVisible,
} from "./threeDCursor.js";
import {
  snapCursorToSelection,
  snapCursorToWorldOrigin,
  snapCursorToGridFloor,
  snapSelectionToCursor,
  snapSelectionToOrigin,
} from "./threeDCursorOps.js";
import { subscribeMenuItems } from "../engine/editorBridge.js";
import { useMcpStore } from "./api/mcpBridge.js";

/**
 * Merges script-contributed entries (`@menuItem` / `Editor.menu.add`) into the
 * static menu definition.
 *
 * Entries whose top-level name matches an existing menu are appended to it
 * behind a separator, so a script extending "Edit" lands where the user would
 * look. Everything else creates its own top-level menu — which is how "Tools"
 * (the default) appears only once a project actually has tool scripts, rather
 * than sitting there empty in every project.
 */
function withScriptMenus(menus, scriptItems) {
  if (!scriptItems.length) return menus;
  const merged = { ...menus };
  for (const entry of scriptItems) {
    const item = { label: entry.label, action: entry.run };
    if (merged[entry.menu]) merged[entry.menu] = [...merged[entry.menu], item];
    else merged[entry.menu] = [item];
  }
  // The separator has to go in after the fact: the loop above appends one item
  // at a time and would otherwise emit a separator per entry.
  for (const name of Object.keys(merged)) {
    const added = scriptItems.filter((entry) => entry.menu === name).length;
    if (!added || !menus[name]) continue;
    const at = merged[name].length - added;
    merged[name] = [...merged[name].slice(0, at), { separator: true }, ...merged[name].slice(at)];
  }
  return merged;
}

/**
 * Bridge state in the menu bar — always present, which is the point.
 *
 * The first version hid itself while MCP was off, which made the feature
 * findable only by someone who already knew it existed and where its settings
 * lived (three levels into Project Settings). "Hard to find" was the reported
 * problem, and a permanent one-word chip is the cheapest honest fix: it is the
 * entry point when off, and a live indicator when on — including a call counter,
 * because when something outside the window is editing your scene you should be
 * able to see it happening.
 */
function McpIndicator() {
  const status = useMcpStore((s) => s.status);
  const toolCount = useMcpStore((s) => s.toolCount);
  const callCount = useMcpStore((s) => s.callCount);
  const port = useMcpStore((s) => s.port);
  const tone = status === "connected" ? "connected" : status === "disabled" ? "off" : "waiting";
  return (
    <button
      className={`mcp-chip ${tone}`}
      title={
        status === "connected"
          ? `Assistant connected on port ${port} — ${toolCount} tools, ${callCount} call${callCount === 1 ? "" : "s"} served. Click for details.`
          : status === "disabled"
            ? "Assistant access is off. Click to open the MCP panel and turn it on."
            : `Waiting for an assistant on port ${port}. Click for details.`
      }
      onClick={() => openPanel("mcp")}
    >
      <span className="mcp-dot" />
      MCP{status === "connected" && callCount > 0 ? ` ${callCount}` : ""}
    </button>
  );
}

export function MenuBar() {
  const [openMenu, setOpenMenu] = useState(null);
  const [scriptItems, setScriptItems] = useState([]);
  // Fires immediately with the current list, then on every register/unregister
  // (including the ones a hot-reloading script triggers).
  useEffect(() => subscribeMenuItems(setScriptItems), []);
  // Narrow selectors — subscribing to the whole store re-rendered the menu
  // bar on every command-history mutation.
  const undoLabel = useHistoryStore((s) => s.undoLabel);
  const redoLabel = useHistoryStore((s) => s.redoLabel);
  const canUndo = useHistoryStore((s) => s.canUndo);
  const canRedo = useHistoryStore((s) => s.canRedo);
  const history = { undoLabel, redoLabel, canUndo, canRedo };
  const selection = useSelectionStore((s) => s.ids);
  const sceneName = useSceneStore((s) => s.sceneName);
  const dirty = useSceneStore((s) => s.dirty);

  const sceneRoot = useProjectStore((s) => s.rootPath);
  const menus = {
    File: [
      { label: "New Scene", action: () => newScene() },
      { label: "Open Scene…", shortcut: "Ctrl+O", action: () => openScene() },
      { separator: true },
      { label: "Save Scene", shortcut: "Ctrl+S", action: () => saveScene() },
      { label: "Save Scene As…", action: () => saveScene({ saveAs: true }) },
      { separator: true },
      {
        label: "New Project…",
        action: () => useProjectStore.getState().createProject(),
      },
      {
        label: "Open Project Folder…",
        action: () => useProjectStore.getState().openFolder(),
      },
      {
        label: "Close Project",
        shortcut: "Ctrl+Shift+W",
        disabled: !sceneRoot,
        action: () => useProjectStore.getState().closeProject(),
      },
      { separator: true },
      // The panel is where a build is *configured*; this is the one-click path
      // for someone who has already configured it (or is happy with defaults).
      { label: "Build Settings…", action: () => openPanel("build") },
      { label: "Build Game…", shortcut: "Ctrl+B", action: () => import("./exportGame.js").then((m) => m.exportGame()) },
    ],
    Edit: [
      {
        label: history.undoLabel ? `Undo ${history.undoLabel}` : "Undo",
        shortcut: "Ctrl+Z",
        disabled: !history.canUndo,
        action: () => commandBus.undo(),
      },
      {
        label: history.redoLabel ? `Redo ${history.redoLabel}` : "Redo",
        shortcut: "Ctrl+Shift+Z",
        disabled: !history.canRedo,
        action: () => commandBus.redo(),
      },
      { separator: true },
      {
        label: "Copy",
        shortcut: "Ctrl+C",
        disabled: !selection.length,
        action: () => copyEntities(selection),
      },
      {
        label: "Cut",
        shortcut: "Ctrl+X",
        disabled: !selection.length,
        action: () => cutEntities(selection),
      },
      {
        label: "Paste",
        shortcut: "Ctrl+V",
        disabled: !clipboardHasEntities(),
        action: () => {
          const first = selection[0];
          const parentId = first ? (useSceneStore.getState().entities[first]?.parentId ?? null) : null;
          pasteEntities(parentId);
        },
      },
      { separator: true },
      {
        label: "Duplicate",
        shortcut: "Ctrl+D",
        disabled: !selection.length,
        action: () => duplicateSelection(),
      },
      {
        label: "Group Selection",
        shortcut: "Ctrl+G",
        disabled: selection.length < 2,
        action: () => groupSelection(),
      },
      {
        label: "Delete",
        shortcut: "Del",
        disabled: !selection.length,
        action: () => deleteSelection(),
      },
    ],
    Window: [
      { label: "Viewport", action: () => openPanel("viewport") },
      { label: "Game", action: () => openPanel("game") },
      { label: "Hierarchy", action: () => openPanel("hierarchy") },
      { label: "Inspector", action: () => openPanel("inspector") },
      { label: "Assets", action: () => openPanel("assets") },
      { label: "Console", action: () => openPanel("console") },
      { separator: true },
      { label: "Shader Graph", action: () => openPanel("shaderGraph") },
      { label: "Particles", action: () => openPanel("particles") },
      { label: "Animator", action: () => openPanel("animator") },
      { label: "Timeline", action: () => openPanel("timeline") },
      { separator: true },
      { label: "Scene Settings", action: () => openPanel("sceneSettings") },
      { label: "Project Settings", action: () => openPanel("projectSettings") },
      { label: "Build Settings", action: () => openPanel("build") },
      { label: "Modules", action: () => openPanel("modules") },
      { label: "Input", action: () => openPanel("input") },
      { label: "Poly Haven", action: () => openPanel("polyhaven") },
      { label: "AmbientCG", action: () => openPanel("ambientcg") },
      { label: "Sketchfab", action: () => openPanel("sketchfab") },
      { label: "Terminal", action: () => openPanel("terminal") },
      { label: "Assistant (MCP)", action: () => openPanel("mcp") },
      { separator: true },
      { label: "Reset Layout", action: () => resetLayout() },
    ],
    Visibility: [
      {
        label: "Toggle selected (editor)",
        shortcut: describeBinding(getBinding("editor.toggleSelected")),
        disabled: !selection.length,
        action: () => visibilityActions.toggleSelectedEditor(),
      },
      {
        label: "Toggle all unselected (editor)",
        shortcut: describeBinding(getBinding("editor.toggleUnselected")),
        action: () => visibilityActions.toggleUnselectedEditor(),
      },
      { separator: true },
      {
        label: "Toggle selected (game)",
        shortcut: describeBinding(getBinding("game.toggleSelected")),
        disabled: !selection.length,
        action: () => visibilityActions.toggleSelectedGame(),
      },
      {
        label: "Toggle all unselected (game)",
        shortcut: describeBinding(getBinding("game.toggleUnselected")),
        action: () => visibilityActions.toggleUnselectedGame(),
      },
    ],
    Cursor: [
      {
        label: "Snap Selection to 3D Cursor",
        shortcut: "Shift+S",
        disabled: !selection.length,
        action: () => snapSelectionToCursor(),
      },
      {
        label: "Snap Selection to World Origin",
        disabled: !selection.length,
        action: () => snapSelectionToOrigin(),
      },
      { separator: true },
      {
        label: "3D Cursor to Selection",
        shortcut: "Shift+S",
        disabled: !selection.length,
        action: () => snapCursorToSelection(),
      },
      { label: "3D Cursor to World Origin", action: () => snapCursorToWorldOrigin() },
      { label: "3D Cursor to Grid Floor", action: () => snapCursorToGridFloor() },
      {
        label: "Reset 3D Cursor",
        action: () => setCursor3DPosition(0, 0, 0),
      },
      { separator: true },
      {
        label: "Toggle 3D Cursor",
        action: () => toggleCursor3DVisible(),
      },
    ],
  };

  const runItem = (item) => {
    setOpenMenu(null);
    item.action();
  };

  return (
    <div className="menu-bar">
      {Object.entries(withScriptMenus(menus, scriptItems)).map(([name, items]) => (
        <div key={name} className="menu-wrap">
          <button
            className={`menu-btn ${openMenu === name ? "open" : ""}`}
            onClick={() => setOpenMenu(openMenu === name ? null : name)}
            onMouseEnter={() => openMenu && setOpenMenu(name)}
          >
            {name}
          </button>
          {openMenu === name && (
            <div className="dropdown-menu menu-dropdown">
              {items.map((item, i) =>
                item.separator ? (
                  <div key={i} className="menu-separator" />
                ) : (
                  <button
                    // Index-suffixed because script-contributed entries can
                    // legitimately repeat a label (two entities running the
                    // same tool script), and a duplicate key drops one of them.
                    key={`${item.label}-${i}`}
                    className="dropdown-item"
                    disabled={item.disabled}
                    onClick={() => runItem(item)}
                  >
                    <span>{item.label}</span>
                    {item.shortcut && <span className="menu-shortcut">{item.shortcut}</span>}
                  </button>
                ),
              )}
            </div>
          )}
        </div>
      ))}
      {openMenu && <div className="dropdown-overlay" onClick={() => setOpenMenu(null)} />}
      <div className="menu-spacer" />
      <McpIndicator />
      <ProcessingIndicator />
      <div className="menu-title">
        {sceneName}
        {dirty ? " •" : ""} — Three Engine
      </div>
    </div>
  );
}
