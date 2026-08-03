import { exportGame } from "./exportGame.js";
import { useProjectStore } from "./store/projectStore.js";

let stopLivePreview = null;

export async function stopBrowserPreview(outDir) {
  stopLivePreview?.();
  stopLivePreview = null;
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

async function startLivePreview({ root, outDir, onProgress }) {
  stopLivePreview?.();
  const [{ ensureEngine }, { onAssetInvalidated }] = await Promise.all([
    import("./engineInstance.js"),
    import("./assetLoader.js"),
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
    dirty = false;
    building = true;
    const includeDerivedData = derivedDirty;
    derivedDirty = false;
    try {
      const report = await exportGame({
        outDir,
        onProgress,
        buildOverride: { target: "web", livePreview: true, includeDerivedData },
      });
      if (!report.ok && !report.cancelled) {
        console.error(`Live browser preview rebuild failed: ${report.error}`);
      }
    } catch (error) {
      console.error(`Live browser preview rebuild failed: ${error?.message ?? error}`);
    } finally {
      building = false;
      if (dirty && !stopped) timer = setTimeout(flush, 250);
    }
  };
  const schedule = (assetPath = "") => {
    if (stopped) return;
    dirty = true;
    // (gi-sdf derived-data tracking removed with the SDF bake pipeline.)
    clearTimeout(timer);
    timer = setTimeout(flush, 250);
  };

  const unsubs = [
    engine.on("hierarchy-changed", schedule),
    engine.on("settings-changed", schedule),
    engine.on("script-loaded", schedule),
    onAssetInvalidated(schedule),
  ];
  const unsubscribeProject = useProjectStore.subscribe((state, previous) => {
    if (state.rootPath !== previous.rootPath || state.projectMeta !== previous.projectMeta) schedule();
  });
  stopLivePreview = () => {
    stopped = true;
    clearTimeout(timer);
    for (const unsubscribe of unsubs) unsubscribe?.();
    unsubscribeProject?.();
    stopLivePreview = null;
  };
}

/** Builds the authored scene into a disposable project-local preview and
 * exposes it on localhost plus the current LAN for phone/tablet testing. */
export async function openBrowserPreview({ onProgress } = {}) {
  const root = useProjectStore.getState().rootPath;
  if (!root) throw new Error("Open a project before starting a browser preview.");

  const { invoke } = await import("@tauri-apps/api/core");
  let outDir;
  try {
    outDir = await invoke("prepare_browser_preview", { projectRoot: root });
  } catch (error) {
    throw new Error(`Could not prepare preview output: ${error?.message ?? error}`);
  }
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
  try {
    await openBrowserPreviewUrl(urls.localUrl);
  } catch (error) {
    openError = error?.message ?? String(error);
  }
  console.log(
    `Browser preview: ${urls.localUrl}` +
      (urls.lanUrl ? `\nMobile / local Wi-Fi: ${urls.lanUrl}` : "\nNo LAN address was detected.") +
      (openError ? `\nAutomatic browser launch failed: ${openError}` : ""),
  );
  await startLivePreview({ root, outDir, onProgress });
  return { ...urls, openError, report };
}
