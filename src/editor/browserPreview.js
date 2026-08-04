import { exportGame } from "./exportGame.js";
import { useProjectStore } from "./store/projectStore.js";
import { vmSingleton } from "./singleton.js";
import { pushToast, dismissToastKey } from "./toasts.js";

// VM-wide, not module-level: a `?t=` HMR twin of this module would otherwise
// see `stop === null`, conclude no preview is running, and let a second live
// loop (and its rebuild exports) pile up beside an unreachable first one.
const state = vmSingleton("browserPreview", () => ({
  /** Teardown for the active live-rebuild loop, or null. */
  stop: null,
  /** The result of the running preview ({ localUrl, lanUrl, report, … }) or
   *  null. Owned here, not in panel state: dockview remounts the viewport on
   *  tab moves, and a remounted toolbar must find the running server again
   *  instead of offering to start a second one. */
  active: null,
  /** True while openBrowserPreview is mid-flight, so duplicate user clicks
   *  can't race two builds into the same output directory. */
  starting: false,
  /** { url } for the running public share tunnel, or null. Owned here for
   *  the same dockview-remount reason as `active`. */
  share: null,
  /** True while startShareTunnel is mid-flight — the first run downloads a
   *  ~55 MB binary, which is plenty of time for a second click. */
  sharing: false,
}));

/** The currently running preview's URLs/report, or null. */
export function getActiveBrowserPreview() {
  return state.active;
}

export async function stopBrowserPreview(outDir) {
  state.active = null;
  state.stop?.();
  state.stop = null;
  const { invoke } = await import("@tauri-apps/api/core");
  // The tunnel forwards to the server being stopped; left running it would
  // keep a public URL alive that now serves connection errors.
  if (state.share) {
    state.share = null;
    await invoke("stop_share_tunnel").catch(() => {});
  }
  if (!outDir) return;
  await invoke("stop_build_lan", { dir: outDir });
}

/** The running public share tunnel ({ url }) or null. */
export function getActiveShareTunnel() {
  return state.share;
}

/**
 * Forwards the running browser preview to a public Cloudflare quick-tunnel
 * URL (https://<random>.trycloudflare.com) so the build can be demoed to
 * people outside the local network. The link serves the same live-updating
 * build as the LAN preview and dies with the tunnel, the preview, or the
 * editor. Returns null if a start is already in flight.
 */
export async function startShareTunnel({ onProgress } = {}) {
  if (state.share) return state.share;
  if (!state.active?.localUrl) {
    throw new Error("Start the browser preview before creating a share link.");
  }
  if (state.sharing) return null;
  state.sharing = true;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const port = Number(new URL(state.active.localUrl).port);
    if (!port) throw new Error(`Preview URL has no port: ${state.active.localUrl}`);
    const status = await invoke("share_binary_status").catch(() => null);
    onProgress?.({
      phase: "share",
      message: status?.ready
        ? "Creating public link…"
        : "Downloading Cloudflare Tunnel (one time, ~55 MB)…",
    });
    const url = await invoke("start_share_tunnel", { port });
    state.share = { url };
    return state.share;
  } finally {
    state.sharing = false;
  }
}

export async function stopShareTunnel() {
  state.share = null;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("stop_share_tunnel");
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
async function ensurePlayerTemplateFresh(invoke, onProgress, { force = false } = {}) {
  const status = await invoke("player_template_status");
  if (!status) throw new Error("Could not determine player runtime freshness.");
  if (!status.canRebuild) {
    if (status.stale) {
      throw new Error("The player runtime is stale and this editor cannot rebuild it.");
    }
    return;
  }
  if (!force && !status.stale) return;
  onProgress?.({
    phase: "template",
    message: force ? "Building fresh player runtime…" : "Engine source changed — rebuilding player runtime…",
  });
  await invoke("rebuild_player_template");
  const after = await invoke("player_template_status");
  if (after?.stale) {
    throw new Error("Player runtime rebuild completed, but the template is still stale.");
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
    let failure = "";
    try {
      await ensurePlayerTemplateFresh(invoke, onProgress);
      const report = await exportGame({
        outDir,
        onProgress,
        buildOverride: { target: "web", livePreview: true, includeDerivedData },
      });
      if (!report.ok && !report.cancelled) {
        failed = true;
        failure = `${report.error}`;
      }
    } catch (error) {
      failed = true;
      failure = `${error?.message ?? error}`;
    } finally {
      if (failed) {
        console.error(`Live browser preview rebuild failed: ${failure}`);
        // Keyed: the retry loop fires every 5s on a persistent failure — one
        // toast that updates, not a pile. Cleared on the next good rebuild.
        pushToast({
          level: "warn",
          title: "Live preview is stale — rebuild failed",
          detail: failure,
          key: "live-preview-rebuild",
        });
      } else {
        dismissToastKey("live-preview-rebuild");
      }
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
    engine.on("component-changed", schedule),
    engine.on("modules-changed", schedule),
    engine.on("audio-changed", schedule),
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
    if (stopped || building || dirty) return;
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
 * `openBrowser: false` starts the hosting silently without stealing focus to
 * a new tab. */
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
  // Always rebuild the player runtime when a preview is explicitly started.
  // The editor viewport may be running source through Vite while the player
  // template is a prebuilt artifact; serving it without this step can make
  // the browser execute a different engine than the editor.
  await ensurePlayerTemplateFresh(invoke, onProgress, { force: true });
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
  state.active = { ...urls, openError, report };
  return state.active;
}
