import { useEffect } from "react";
import { MenuBar } from "./MenuBar.jsx";
import {
  copyEntities,
  cutEntities,
  pasteEntities,
  duplicateSelection,
  deleteSelection,
} from "./clipboard.js";
import { groupSelection } from "./group.js";
import {
  openScene,
  saveScene,
  restoreLastScene,
  hasScenePath,
  sceneBooted,
  markSceneBooted,
} from "./sceneIO.js";
import { useSceneStore } from "./store/sceneStore.js";
import { useSelectionStore } from "./store/selectionStore.js";
import { useProjectStore } from "./store/projectStore.js";
import { engine, ensureEngine } from "./engineInstance.js";
import { toggle as togglePlay, togglePaused, stepFrame } from "./playMode.js";
import { commandBus } from "./commands/CommandBus.js";
import { getProjectSettings, applyProjectSettings } from "./projectSettings.js";
import { isGraphHovered, isPointerInside } from "./nodegraph/graphContext.js";
import { dispatchVisibilityKeyAction } from "./keybindings.js";
import { dispatchTerrainKeyAction } from "./terrainBrush.js";
import { useGeometryEditStore } from "./store/geometryEditStore.js";
import { GlobalContextMenu } from "./nativeContextMenu.jsx";

/**
 * Editor "chrome": the menu bar, scene restore on first mount, keyboard
 * shortcuts, and autosave timer. Kept in its own module so that its chain
 * of eager imports (`MenuBar → clipboard → entityCommands → engine/index.js`)
 * doesn't enter the boot module graph — it's lazy-loaded once the project
 * hub has been dismissed.
 */
export function EditorChrome() {
  // The boot effect needs to re-run whenever the active project changes,
  // not just on mount — otherwise switching projects (or going back to the
  // hub via File → Close Project) would skip the scene bootstrap entirely.
  const projectKey = useProjectStore(
    (s) => `${s.hubSkipped ? "hub" : ""}|${s.rootPath ?? ""}`,
  );

  useEffect(() => {
    let autosave = null;
    let cancelled = false;
    ensureEngine().then(async () => {
      if (cancelled) return;
      // Boot the scene for whichever project is currently active. The flag
      // flips back to `false` in `openProject` when a project is switched,
      // so the engine always re-bootstraps for the new project. We also
      // run when projectKey changes — even if the module-level flag were
      // mistakenly left set — to cover long sessions where state could
      // drift.
      if (!sceneBooted || projectKey !== lastBootedKey) {
        markSceneBooted();
        lastBootedKey = projectKey;
        // Enabled modules must register their components BEFORE the scene
        // deserializes, or module components load as inert "missing" data.
        const { syncProjectModules } = await import("./modules.js");
        await syncProjectModules().catch((err) => console.error(`Modules: ${err.message ?? err}`));
        // Apply saved input config (if any) before scene load so scripts
        // can read bindings during their first onUpdate.
        const { useProjectStore: store } = await import("./store/projectStore.js");
        const input = store.getState().projectMeta?.input;
        if (input) engine.applyInput(input);
        // Prefabs must be in the registry before the scene loads: a scene
        // stores instances as links, and a link with no def can't expand.
        const { loadProjectPrefabs } = await import("./prefab.js");
        await loadProjectPrefabs().catch((err) => console.error(`Prefabs: ${err.message ?? err}`));
        // engine.assets' name/tag catalog — not load-bearing for the scene
        // itself, so it doesn't block boot, but scripts should find it
        // populated by the time Play actually starts running them.
        const { loadProjectAssetCatalog } = await import("./assetCatalog.js");
        loadProjectAssetCatalog().catch((err) => console.error(`Asset catalog: ${err.message ?? err}`));
        const restored = await restoreLastScene();
        // If nothing can be restored, the engine stays empty — `openProject`
        // wiped it for us. The user picks the opening scene via File →
        // New Scene or Open Scene…. Auto-creating a scene here silently
        // spawned stray "Main 1.scene"/"Main 2.scene" files whenever the
        // saved main/last scene was missing or moved.
        void restored;
        console.log("Editor ready");
        // Serving is sticky per project: if the preview server was running
        // when this project was last closed, bring it back. Deliberately not
        // awaited — a build takes seconds and nothing below depends on it,
        // and the toolbar subscribes to the preview state so the URLs appear
        // as soon as they exist.
        if (!cancelled) {
          import("./browserPreview.js")
            .then((m) => m.autoStartBrowserPreviewIfRemembered())
            .catch((err) => console.warn(`Preview autostart: ${err?.message ?? err}`));
        }
      }
      // Project settings (script hot reload, pixel ratio cap, grid/snap…)
      // apply once the engine exists.
      applyProjectSettings().catch((err) => console.warn(`Project settings: ${err}`));

      // Autosave: dirty scenes write themselves on the configured interval
      // (when not playing and when there's a destination on disk). A 1s tick
      // checks elapsed time so interval changes apply without a restart.
      let lastSave = performance.now();
      autosave = setInterval(() => {
        const seconds = getProjectSettings().editor.autosaveSeconds;
        if (!seconds) return; // 0 = disabled
        if (performance.now() - lastSave < seconds * 1000) return;
        lastSave = performance.now();
        const canPersist = hasScenePath() || useProjectStore.getState().rootPath;
        if (canPersist && useSceneStore.getState().dirty && !engine.playing) saveScene();
      }, 1000);
    });

    return () => {
      cancelled = true;
      if (autosave) clearInterval(autosave);
    };
  }, [projectKey]);

  useEffect(() => {
    const onKeyDown = (e) => {
      const inField = e.target.closest?.("input, textarea, select, [contenteditable]");
      const ctrl = e.ctrlKey || e.metaKey;

      if (ctrl && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveScene({ saveAs: e.shiftKey });
        return;
      }
      if (ctrl && e.key.toLowerCase() === "o") {
        e.preventDefault();
        openScene();
        return;
      }
      if (ctrl && e.key.toLowerCase() === "p") {
        e.preventDefault();
        // Shift pauses game time instead of leaving Play — the scene stays as
        // the game left it, and the viewport keeps rendering it.
        if (e.shiftKey) togglePaused();
        else togglePlay();
        return;
      }
      if (ctrl && e.key === ".") {
        e.preventDefault();
        stepFrame();
        return;
      }
      if (ctrl && !e.shiftKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        import("./exportGame.js").then((m) => m.exportGameWithToasts());
        return;
      }
      if (ctrl && e.shiftKey && e.key.toLowerCase() === "w") {
        e.preventDefault();
        useProjectStore.getState().closeProject();
        return;
      }
      // Geometry edit mode owns Delete, Ctrl+Z, G/R/S/E and selection keys.
      // Its canvas is created imperatively, but remains inside this wrapper.
      if (e.target.closest?.(".geometry-editor")) return;
      if (inField) return;
      // Node-graph editors (shader graph, particle graph) have their own
      // delete/selection handling — the DOM-ancestry check is a fallback,
      // but SVG edges/nodes don't always move `document.activeElement`, so
      // hover state is the reliable signal that a graph "owns" the keypress.
      if (e.target.closest?.(".react-flow") || isGraphHovered()) return;
      // The timeline's dope sheet owns Delete / Ctrl+Z / Space / arrows over its
      // own surface. Hover, not focus: clicking a keyframe diamond does not move
      // `document.activeElement`, exactly like the graph editors' SVG edges.
      if (e.target.closest?.(".timeline-panel")) return;
      for (const el of document.querySelectorAll(".timeline-panel")) {
        if (isPointerInside(el)) return;
      }
      // The texture editor owns Ctrl+Z / Ctrl+S / Delete / single-letter tool
      // keys over its own surface, for the same reason and by the same test:
      // clicking on a paint canvas never moves `document.activeElement`.
      if (e.target.closest?.(".texture-editor")) return;
      for (const el of document.querySelectorAll(".texture-editor")) {
        if (isPointerInside(el)) return;
      }
      // The audio editor owns Space (play/pause), Ctrl+Z/S/X/C/V and Delete
      // over its own surface. Same hover test: clicking a waveform lane never
      // moves `document.activeElement` either.
      if (e.target.closest?.(".audio-editor")) return;
      for (const el of document.querySelectorAll(".audio-editor")) {
        if (isPointerInside(el)) return;
      }

      const selection = useSelectionStore.getState().ids;
      if (e.shiftKey && !ctrl && !e.altKey && e.key.toLowerCase() === "d") {
        e.preventDefault();
        duplicateSelection().then(() => {
          window.dispatchEvent(new CustomEvent("editor-start-transform", { detail: "translate" }));
        });
        return;
      }
      // Terrain-editor context keys (S/P/E, [ ], B/Esc) — only fire while a
      // terrain entity is selected, so they get first crack at E before the
      // global game-visibility toggle below claims it.
      if (dispatchTerrainKeyAction(e)) {
        e.preventDefault();
        return;
      }
      // User-rebindable visibility hotkeys (H / Shift+H / E / Shift+E
      // by default). Routed through a dispatcher so the keys can be
      // changed in Project Settings. Returns true on consume.
      if (dispatchVisibilityKeyAction(e)) {
        e.preventDefault();
        return;
      }
      if (ctrl && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.shiftKey ? commandBus.redo() : commandBus.undo();
      } else if (ctrl && e.key.toLowerCase() === "y") {
        e.preventDefault();
        commandBus.redo();
      } else if (ctrl && e.key.toLowerCase() === "d") {
        e.preventDefault();
        duplicateSelection();
      } else if (ctrl && e.key.toLowerCase() === "g") {
        e.preventDefault();
        if (selection.length >= 2) groupSelection();
      } else if (ctrl && e.key.toLowerCase() === "c") {
        if (selection.length) copyEntities(selection);
      } else if (ctrl && e.key.toLowerCase() === "x") {
        if (selection.length) cutEntities(selection);
      } else if (ctrl && e.key.toLowerCase() === "v") {
        // Paste as sibling of the first selected entity, or at scene root.
        const first = selection[0];
        const parentId = first ? (useSceneStore.getState().entities[first]?.parentId ?? null) : null;
        pasteEntities(parentId);
      } else if (e.key === "Delete") {
        deleteSelection();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const blockGeometryReload = (event) => {
      if (!useGeometryEditStore.getState().entityId) return;
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "r") return;
      event.preventDefault();
    };
    window.addEventListener("keydown", blockGeometryReload, true);
    return () => window.removeEventListener("keydown", blockGeometryReload, true);
  }, []);

  return (
    <>
      <MenuBar />
      <GlobalContextMenu />
    </>
  );
}

// Tracks the project key (see useProjectStore selector above) the boot
// effect last ran for. Combined with the exported sceneBooted flag — which
// `openProject` resets — this guarantees the engine always re-bootstraps
// for the new project, even within a single mounted editor session where
// the effect's deps array keys on the same value.
let lastBootedKey = null;
