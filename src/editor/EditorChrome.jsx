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
import { keyScopeOwns } from "./keyScope.js";
import { chordMatches, dispatchVisibilityKeyAction, getBinding } from "./keybindings.js";
import { dispatchTerrainKeyAction } from "./terrainBrush.js";
import { useGeometryEditStore } from "./store/geometryEditStore.js";
import { GlobalContextMenu } from "./nativeContextMenu.jsx";
import { freeze } from "../engine/freezeLedger.js";

/** Longest an autosave may wait for a gap in the user's hands. Deferring a
 *  save trades a hitch for a window of loss, so the trade is bounded. */
const AUTOSAVE_MAX_DEFER_MS = 4000;

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
    let inputListeners = null;
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
        freeze.bootStage("modules: import + enable");
        const { syncProjectModules } = await import("./modules.js");
        await syncProjectModules().catch((err) => console.error(`Modules: ${err.message ?? err}`));
        // Apply saved input config (if any) before scene load so scripts
        // can read bindings during their first onUpdate.
        const { useProjectStore: store } = await import("./store/projectStore.js");
        const input = store.getState().projectMeta?.input;
        if (input) engine.applyInput(input);
        // The project's event catalog, for the same reason and at the same
        // point: a script's first onUpdate can legitimately ask
        // `engine.events.has(...)`, and the Events panel reads the live
        // registry rather than project.json.
        const events = store.getState().projectMeta?.events;
        const eventErrors = engine.applyEvents(events);
        for (const err of eventErrors) console.warn(`Events: ${err}`);
        // Prefabs must be in the registry before the scene loads: a scene
        // stores instances as links, and a link with no def can't expand.
        freeze.bootStage("prefabs: load");
        // The dynamic import is inside the stage and is NOT free: under the
        // dev server it is a fetch per module in prefab.js's graph. The stage
        // measured ~3 s while its three marked sub-steps summed to ~1.1 s, and
        // an unnamed second is one nobody can fix — so the import is marked
        // like everything else.
        const tImport = performance.now();
        const { loadProjectPrefabs } = await import("./prefab.js");
        freeze.bootMark("prefabs: import module", performance.now() - tImport);
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
        freeze.bootStage(null);
        console.log("Editor ready");
        // THE BOOT TABLE (zero-freeze plan unit 0.2). One line per stage plus
        // how much of the boot the main thread spent BLOCKED — the difference
        // between a boot that is slow and a boot that is frozen. `profile.boot`
        // returns the same thing on demand, and GI logs it again at first light.
        freeze.logBoot("Editor ready");
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
      //
      // ── AND IT WAITS FOR A GAP IN THE USER'S HANDS (2026-09-07) ──────────
      // A save is a full engine walk plus a `JSON.stringify` of the whole
      // scene; the freeze ledger measured it at ~57 ms and it was landing on
      // the interval REGARDLESS of what the user was doing — including in the
      // middle of a drag, which is exactly when 57 ms is felt as a snag. The
      // work has to happen, but nothing about it is urgent to the millisecond:
      // it now waits for ~600 ms of no pointer or key activity.
      //
      // ⚠ DEFERRING A SAVE WIDENS THE WINDOW OF LOSS, so the wait is capped
      // hard: never more than `AUTOSAVE_MAX_DEFER_MS` past the interval, and
      // the scene is also written whenever the window loses focus or is
      // hidden — the two moments a person expects their work to be safe.
      // `__editorAutosaveIdleGap = 0` saves on the tick again.
      let lastSave = performance.now();
      let lastInput = 0;
      const noteInput = () => { lastInput = performance.now(); };
      // Losing focus or hiding the window is the moment a person stops
      // watching, so it is the moment their work has to be on disk — and it is
      // also, conveniently, a moment no frame is being felt.
      const saveNow = () => {
        const canPersist = hasScenePath() || useProjectStore.getState().rootPath;
        if (canPersist && useSceneStore.getState().dirty && !engine.playing) {
          lastSave = performance.now();
          saveScene();
        }
      };
      const onHide = () => { if (document.visibilityState === "hidden") saveNow(); };
      window.addEventListener("blur", saveNow);
      document.addEventListener("visibilitychange", onHide);
      for (const type of ["pointerdown", "pointermove", "wheel", "keydown"]) {
        window.addEventListener(type, noteInput, { passive: true, capture: true });
      }
      inputListeners = () => {
        for (const type of ["pointerdown", "pointermove", "wheel", "keydown"]) {
          window.removeEventListener(type, noteInput, { capture: true });
        }
        window.removeEventListener("blur", saveNow);
        document.removeEventListener("visibilitychange", onHide);
      };
      autosave = setInterval(() => {
        const seconds = getProjectSettings().editor.autosaveSeconds;
        if (!seconds) return; // 0 = disabled
        const since = performance.now() - lastSave;
        if (since < seconds * 1000) return;
        const idleGap = Number(globalThis.__editorAutosaveIdleGap ?? 600);
        const busy = performance.now() - lastInput < idleGap;
        // …unless the deferral has run past its cap, in which case save anyway:
        // an autosave that keeps waiting is a data-loss bug, and a 57 ms hitch
        // is not.
        if (busy && since < seconds * 1000 + AUTOSAVE_MAX_DEFER_MS) return;
        lastSave = performance.now();
        const canPersist = hasScenePath() || useProjectStore.getState().rootPath;
        if (canPersist && useSceneStore.getState().dirty && !engine.playing) saveScene();
      }, 1000);
    });

    return () => {
      cancelled = true;
      if (autosave) clearInterval(autosave);
      inputListeners?.();
    };
  }, [projectKey]);

  useEffect(() => {
    const onKeyDown = (e) => {
      const ctrl = e.ctrlKey || e.metaKey;

      // Application verbs first. These are the only keys allowed to fire from
      // inside a context that owns the keyboard — running the game or building
      // it means the same thing whether you are in the viewport or mid-word in
      // the code editor, and no panel or text field claims them. Everything
      // below this block is scene editing and defers to the owning scope.
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
      // Rebindable viewport screenshot (Shift+Alt+S by default; Alt = Option
      // on macOS). This sits WITH THE APPLICATION VERBS, above the keyScope
      // gate below, because the capture is WYSIWYG of the whole presented
      // frame — it means the same thing from the viewport, mid-word in the
      // code editor, or with focus in an inspector field, and no panel has a
      // meaning of its own for it. Dispatched from behind `keyScopeOwns` it
      // was silently dead everywhere except a bare viewport: every denylist
      // scope (code, texture, timeline, audio, graph, geometry) and every
      // focused text field owns "everything unclaimed", and Shift+Alt+S is
      // unclaimed — the key arrived and nothing happened, not even an error.
      // It cannot ride keyScope's static passthrough lists instead: the chord
      // is user-rebindable (a hardcoded list would only ever know the
      // default), and its matching goes through keyTokenFromEvent's
      // `event.code` fallback, which keyScope's key-spelled chords can't
      // express. Dynamic import: the capture path pulls the renderer ops
      // chunk, which nothing on the boot path needs until the chord fires.
      if (chordMatches(e, getBinding("editor.screenshot"))) {
        e.preventDefault();
        import("./viewportScreenshot.js")
          .then((m) => m.saveViewportScreenshot())
          .catch((err) => console.error(`Screenshot failed: ${err}`));
        return;
      }
      // Scene editing from here down. Whichever context owns the keyboard —
      // the code editor, a text field, the geometry/texture/audio/timeline
      // panels, a node graph — gets these keys instead; `keyScope` resolves
      // that in one place so the contexts can't contradict each other.
      if (keyScopeOwns(e)) return;

      // While the game is running, none of the scene-edit shortcuts may
      // fire — they share keys with the project's character controller
      // (Shift+D = Sprint+Right, WASD, E/F, Delete, etc.) and would
      // duplicate or delete live actors in the running scene. App verbs
      // above (Ctrl+P to stop Play, Ctrl+. to step, Ctrl+Shift+P to
      // pause, Ctrl+B build, screenshot) keep working so the user can
      // still escape Play mode.
      if (engine?.playing) return;

      if (ctrl && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveScene({ saveAs: e.shiftKey });
        return;
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
