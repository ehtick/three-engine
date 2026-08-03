import { exportGame } from "./exportGame.js";
import { useProjectStore } from "./store/projectStore.js";
import { vmSingleton } from "./singleton.js";

// VM-wide, not module-level: a `?t=` HMR twin of this module would otherwise
// see `stop === null`, conclude no preview is running, and let a second live
// loop (and its rebuild exports) pile up beside an unreachable first one.
const state = vmSingleton("browserPreview", () => ({
  /** Teardown for the active live-rebuild loop, or null. */
  stop: null,
  /** Latched after a failed player-runtime auto-rebuild so the loop doesn't
   *  retry a broken `npm run build:player` every few seconds. Reset when a
   *  new preview session starts. */
  templateRebuildBroken: false,
  /** The result of the running preview ({ localUrl, lanUrl, report, … }) or
   *  null. Owned here, not in panel state: dockview remounts the viewport on
   *  tab moves, and a remounted toolbar must find the running server again
   *  instead of offering to start a second one. */
  active: null,
  /** True while openBrowserPreview is mid-flight, so auto-resume and a
   *  user click can't race two builds into the same output directory. */
  starting: false,
}));

/** The currently running preview's URLs/report, or null. */
export function getActiveBrowserPreview() {
  return state.active;
}

/** localStorage key holding the project root whose preview was live when the
 *  editor last ran — how a restart knows to bring the server back up without
 *  being asked, so a phone bookmark keeps working across editor restarts. */
const RESUME_KEY = "three-engine.browser-preview-project";

export function shouldResumeBrowserPreview(root) {
  try {
    return !!root && localStorage.getItem(RESUME_KEY) === root;
  } catch {
    return false;
  }
}

function rememberBrowserPreview(root) {
  try {
    localStorage.setItem(RESUME_KEY, root);
  } catch {
    // Preview still works for this session; it just won't auto-resume.
  }
}

function forgetBrowserPreview() {
  try {
    localStorage.removeItem(RESUME_KEY);
  } catch {}
}

export async function stopBrowserPreview(outDir) {
  // Forget FIRST: even if tearing the server down throws, an explicit stop
  // must never come back as an auto-resume next session.
  forgetBrowserPreview();
  state.active = null;
  state.stop?.();
  state.stop = null;
  if (!outDir) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("stop_build_lan", { dir: outDir });
}

/** Opens one of the trusted preview endpoints from a compact toolbar action. */
export async function openBrowserPreviewUrl(url) {
  if (!url) return;
  const [{ openUrl }, { invoke }] = await Promise.all([
    import("@tauri-apps/plugin-opener"),
    import("@tauri-apps/api/core"),
  ]);
  try {
    await openUrl(url);
  } catch (error) {
    try {
      await invoke("open_browser_url", { url });
    } catch (fallbackError) {
      throw new Error(fallbackError?.message ?? String(fallbackError ?? error));
    }
  }
}

/**
 * Rebuilds dist-player/ when engine source is newer than the template.
 *
 * The template is what a served build RUNS. Engine edits reach the editor
 * viewport instantly (vite dev serves source), but the browser preview keeps
 * executing whatever `npm run build:player` last produced — the "the served
 * build behaves nothing like the editor" trap that once ran a deleted GI
 * pipeline for a day. A packaged editor has no checkout, reports
 * `canRebuild: false`, and skips this entirely.
 *
 * A missing template (fresh checkout, never built) also lands here: the
 * status call fails, the rebuild attempt builds it for the first time.
 */
async function ensurePlayerTemplateFresh(invoke, onProgress) {
  if (state.templateRebuildBroken) return;
  const status = await invoke("player_template_status").catch(() => null);
  if (status && (!status.stale || !status.canRebuild)) return;
  try {
    onProgress?.({
      phase: "template",
      message: "Engine source changed — rebuilding player runtime…",
    });
    await invoke("rebuild_player_template");
  } catch (error) {
    // npm missing or the build itself failing: warn once and keep previewing
    // on the existing template rather than taking the preview down.
    state.templateRebuildBroken = true;
    console.warn(
      `Player runtime auto-rebuild failed — preview continues on the existing template.\n${error?.message ?? error}`,
    );
  }
}

async function startLivePreview({ outDir, onProgress }) {
  state.stop?.();
  const [{ ensureEngine }, { onAssetInvalidated }, { useHistoryStore }, { usePlayStore }, { invoke }] =
    await Promise.all([
      import("./engineInstance.js"),
      import("./assetLoader.js"),
      import("./commands/CommandBus.js"),
      import("./store/playStore.js"),
      import("@tauri-apps/api/core"),
    ]);
  const engine = await ensureEngine();
  let timer = null;
  let building = false;
  let dirty = false;
  let derivedDirty = false;
  let stopped = false;

  const flush = async () => {
    timer = null;
    if (stopped || building || !dirty) return;
    // Play mode mutates the scene live (physics, spawns — which emit
    // hierarchy-changed). Serializing THAT would publish runtime state as if
    // it were authored. Keep the dirt and wait: leaving Play reconciles the
    // scene back to its authored state and emits hierarchy-changed, which
    // reschedules this flush with the right content.
    if (usePlayStore.getState().playing) return;
    dirty = false;
    building = true;
    const includeDerivedData = derivedDirty;
    derivedDirty = false;
    let failed = false;
    try {
      await ensurePlayerTemplateFresh(invoke, onProgress);
      const report = await exportGame({
        outDir,
        onProgress,
        buildOverride: { target: "web", livePreview: true, includeDerivedData },
      });
      if (!report.ok && !report.cancelled) {
        failed = true;
        console.error(`Live browser preview rebuild failed: ${report.error}`);
      }
    } catch (error) {
      failed = true;
      console.error(`Live browser preview rebuild failed: ${error?.message ?? error}`);
    } finally {
      building = false;
      if (failed && !stopped) {
        // A transient failure (a file locked mid-save, a script that doesn't
        // transpile *yet*) must not strand the preview on a stale build until
        // the NEXT edit happens to arrive: keep the dirt and retry.
        dirty = true;
        timer = setTimeout(flush, 5000);
      } else if (dirty && !stopped) {
        timer = setTimeout(flush, 250);
      }
    }
  };
  const schedule = () => {
    if (stopped) return;
    dirty = true;
    clearTimeout(timer);
    timer = setTimeout(flush, 250);
  };

  const unsubs = [
    engine.on("hierarchy-changed", schedule),
    engine.on("settings-changed", schedule),
    engine.on("script-loaded", schedule),
    onAssetInvalidated(schedule),
    // Every undoable edit crosses the command bus, and some mutate nothing
    // that emits an engine event — moving an entity (SetTransformCommand →
    // Entity.setTransform) is completely silent. "I moved things around and
    // the hosted preview never updated" was the everyday staleness. The
    // history mirror is rewritten after every execute/undo/redo, so it is
    // the one hook that sees all of them.
    useHistoryStore.subscribe(schedule),
  ];
  const unsubscribeProject = useProjectStore.subscribe((current, previous) => {
    if (current.rootPath !== previous.rootPath || current.projectMeta !== previous.projectMeta)
      schedule();
  });
  // Flushes deferred by Play mode restart here. Leaving Play emits
  // hierarchy-changed anyway (the reconcile), so this is belt and braces —
  // but a stranded dirty flag means "stale until the next edit", the exact
  // failure this loop exists to prevent.
  const unsubscribePlay = usePlayStore.subscribe((current, previous) => {
    if (previous.playing && !current.playing && dirty) schedule();
  });
  // Engine-source edits never pass through the editor — they are files in the
  // checkout — so none of the hooks above fire for them. Poll instead: the
  // status command is an mtime walk in Rust, tens of milliseconds. The actual
  // rebuild happens inside flush() so it serializes with exports (vite empties
  // dist-player/ mid-build; copying the template concurrently would ship a
  // half-written runtime).
  const templatePoll = setInterval(async () => {
    if (stopped || building || dirty || state.templateRebuildBroken) return;
    const status = await invoke("player_template_status").catch(() => null);
    if (!stopped && status?.stale && status.canRebuild) schedule();
  }, 5000);

  state.stop = () => {
    stopped = true;
    clearTimeout(timer);
    clearInterval(templatePoll);
    for (const unsubscribe of unsubs) unsubscribe?.();
    unsubscribeProject?.();
    unsubscribePlay?.();
    state.stop = null;
  };
}

/** Builds the authored scene into a disposable project-local preview and
 * exposes it on localhost plus the current LAN for phone/tablet testing.
 * `openBrowser: false` restarts the hosting silently (the auto-resume path
 * after an editor restart) without stealing focus to a new tab. */
export async function openBrowserPreview({ onProgress, openBrowser = true } = {}) {
  const root = useProjectStore.getState().rootPath;
  if (!root) throw new Error("Open a project before starting a browser preview.");
  if (state.starting) return null;
  state.starting = true;
  try {
    return await runOpenBrowserPreview({ root, onProgress, openBrowser });
  } finally {
    state.starting = false;
  }
}

async function runOpenBrowserPreview({ root, onProgress, openBrowser }) {
  const { invoke } = await import("@tauri-apps/api/core");
  let outDir;
  try {
    outDir = await invoke("prepare_browser_preview", { projectRoot: root });
  } catch (error) {
    throw new Error(`Could not prepare preview output: ${error?.message ?? error}`);
  }
  // A fresh session gets a fresh chance: whatever broke the auto-rebuild last
  // time (a syntax error mid-edit, npm hiccup) may be fixed by now.
  state.templateRebuildBroken = false;
  await ensurePlayerTemplateFresh(invoke, onProgress);
  let buildStage = "Starting browser build…";
  const report = await exportGame({
    outDir,
    onProgress: (progress) => {
      buildStage = progress?.message || progress?.phase || buildStage;
      onProgress?.(progress);
    },
    // Browser preview is always a directly servable folder, independent of
    // whether the project's release target is zip or desktop.
    buildOverride: { target: "web", livePreview: true, includeDerivedData: true },
  });
  if (!report.ok) {
    if (report.cancelled) return null;
    throw new Error(
      `Browser preview build failed while ${buildStage}: ${report.error || "unknown build error"}`,
    );
  }

  let urls;
  try {
    urls = await invoke("serve_build_lan", { dir: report.contentDir });
  } catch (error) {
    throw new Error(`Could not serve preview from ${report.contentDir}: ${error?.message ?? error}`);
  }
  // Some Windows installations return os error 3 from the opener plugin even
  // though the URL and preview server are valid. Fall back to a tiny native
  // launcher command, and never discard working server URLs just because the
  // automatic launch failed.
  let openError = null;
  if (openBrowser) {
    try {
      await openBrowserPreviewUrl(urls.localUrl);
    } catch (error) {
      openError = error?.message ?? String(error);
    }
  }
  console.log(
    `Browser preview: ${urls.localUrl}` +
      (urls.lanUrl ? `\nMobile / local Wi-Fi: ${urls.lanUrl}` : "\nNo LAN address was detected.") +
      (openError ? `\nAutomatic browser launch failed: ${openError}` : ""),
  );
  await startLivePreview({ outDir, onProgress });
  rememberBrowserPreview(root);
  state.active = { ...urls, openError, report };
  return state.active;
}
