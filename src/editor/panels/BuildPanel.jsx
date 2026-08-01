import { useCallback, useEffect, useState } from "react";
import { Hammer, Play, FolderOpen, RefreshCw, AlertTriangle } from "lucide-react";
import { useProjectStore, basename } from "../store/projectStore.js";
import { getProjectSettings, saveProjectSettings } from "../projectSettings.js";
import {
  BUILD_DEFAULTS,
  BUILD_TARGETS,
  normalizeRelPath,
  resolveBuildScenes,
  toProjectRelative,
} from "../build/buildSettings.js";
import { QUALITY_PRESETS } from "../../engine/sceneSettings.js";
import { listProjectAssets } from "../assetLoader.js";
import { currentScenePath } from "../sceneIO.js";
import { useModulesStore } from "../modules.js";
import { exportGame, formatBytes } from "../exportGame.js";

function Row({ label, children, hint }) {
  return (
    <>
      <div className="field-row">
        <span className="field-label">{label}</span>
        {children}
      </div>
      {hint ? (
        <div className="asset-hint" style={{ padding: "0 2px 6px" }}>
          {hint}
        </div>
      ) : null}
    </>
  );
}

/**
 * Build Settings — what ships, at what quality, wrapped how.
 *
 * Everything here writes into project.json's `settings.build` and is read back
 * by `exportGame`. The panel deliberately shows the *resolved* plan (which
 * scene will actually boot, how many scenes will ship) rather than only the raw
 * settings: the fallback chain for a start scene is three deep, and a build
 * that boots into the wrong level is the kind of thing you discover after
 * uploading.
 */
export function BuildPanel() {
  const rootPath = useProjectStore((s) => s.rootPath);
  const projectName = useProjectStore((s) => s.projectMeta?.name);
  const mainScene = useProjectStore((s) => s.projectMeta?.mainScene ?? "");
  const enabledModules = useModulesStore((s) => s.enabled);

  const [build, setBuild] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [scenes, setScenes] = useState([]);
  const [busy, setBusy] = useState(null); // progress message while building
  const [report, setReport] = useState(null);

  useEffect(() => {
    if (rootPath) setBuild({ ...BUILD_DEFAULTS, ...(getProjectSettings().build ?? {}) });
  }, [rootPath]);

  const refreshScenes = useCallback(async () => {
    if (!rootPath) return;
    const found = await listProjectAssets(rootPath, ["scene"], 8);
    setScenes(found.map((abs) => toProjectRelative(rootPath, abs)));
  }, [rootPath]);

  useEffect(() => {
    refreshScenes();
  }, [refreshScenes]);

  if (!rootPath) return <div className="inspector-panel empty">Open a project to configure its build.</div>;
  if (!build) return <div className="inspector-panel empty">Loading…</div>;

  const patch = (p) => {
    setBuild({ ...build, ...p });
    setDirty(true);
  };
  const patchLoading = (p) => patch({ loading: { ...build.loading, ...p } });

  const save = async () => {
    const settings = { ...getProjectSettings(), build };
    await saveProjectSettings(settings);
    setDirty(false);
  };

  const openScene = currentScenePath() ? toProjectRelative(rootPath, currentScenePath()) : "";
  const plan = resolveBuildScenes({ available: scenes, build, mainScene, openScene });

  const shipsAll = !Array.isArray(build.scenes);
  const shipping = new Set((build.scenes ?? scenes).map((s) => normalizeRelPath(s).toLowerCase()));
  const toggleScene = (rel) => {
    const list = shipsAll ? [...scenes] : [...build.scenes];
    const i = list.findIndex((s) => normalizeRelPath(s).toLowerCase() === normalizeRelPath(rel).toLowerCase());
    if (i === -1) list.push(rel);
    else list.splice(i, 1);
    patch({ scenes: list });
  };

  const runBuild = async (andRun) => {
    // Settings are read from project.json by the exporter, so an unsaved edit
    // would build the previous configuration — save first rather than build
    // something the panel isn't showing.
    if (dirty) await save();
    setReport(null);
    setBusy("Starting…");
    try {
      const result = await exportGame({ onProgress: ({ message }) => setBusy(message) });
      setReport(result);
      if (result.ok && andRun) await runPreview(result.contentDir);
    } finally {
      setBusy(null);
    }
  };

  const basisOn = enabledModules.includes("basis");
  const dracoOn = enabledModules.includes("draco");

  return (
    <div className="inspector-panel scene-settings-panel">
      <div className="panel-toolbar">
        <span className="asset-path" title={rootPath}>
          {projectName ?? basename(rootPath)}
        </span>
        <button className="toolbar-btn" disabled={!!busy} onClick={() => runBuild(false)}>
          <Hammer size={13} />
          Build{dirty ? " •" : ""}
        </button>
        <button
          className="toolbar-btn"
          disabled={!!busy || build.target === "desktop"}
          title={
            build.target === "desktop"
              ? "The desktop target produces a project to compile, not something to run yet — build the web target to preview."
              : "Build, then serve it on localhost and open it"
          }
          onClick={() => runBuild(true)}
        >
          <Play size={13} />
          Build &amp; Run
        </button>
      </div>

      {busy ? <div className="asset-hint" style={{ padding: "6px 10px" }}>{busy}</div> : null}

      <div className="inspector-section">
        <div className="section-header">Target</div>
        <Row label="Target" hint={BUILD_TARGETS[build.target]?.hint}>
          <select
            className="text-field"
            value={build.target}
            onChange={(e) => patch({ target: e.target.value })}
          >
            {Object.entries(BUILD_TARGETS).map(([id, def]) => (
              <option key={id} value={id}>
                {def.label}
              </option>
            ))}
          </select>
        </Row>
      </div>

      <div className="inspector-section">
        <div className="section-header">Scenes</div>
        <Row
          label="Start scene"
          hint={
            plan.startScene
              ? `Boots into ${plan.startScene}`
              : "No scene found — save a scene into the project first."
          }
        >
          <select
            className="text-field"
            value={normalizeRelPath(build.startScene)}
            onChange={(e) => patch({ startScene: e.target.value })}
          >
            <option value="">
              {mainScene ? `Project main scene (${mainScene})` : "First scene found"}
            </option>
            {scenes.map((rel) => (
              <option key={rel} value={rel}>
                {rel}
              </option>
            ))}
          </select>
        </Row>
        <Row
          label="Ship"
          hint={
            shipsAll
              ? "Every scene in the project ships. Uncheck one to switch to an explicit list."
              : "Only the checked scenes ship. The start scene is always included."
          }
        >
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <label style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <input
                type="checkbox"
                checked={shipsAll}
                onChange={(e) => patch({ scenes: e.target.checked ? null : [...scenes] })}
              />
              All
            </label>
            <button className="toolbar-btn icon-only" title="Rescan the project for scenes" onClick={refreshScenes}>
              <RefreshCw size={12} />
            </button>
          </div>
        </Row>
        <div className="build-scene-list">
          {scenes.length === 0 ? <div className="asset-hint">No .scene files found.</div> : null}
          {scenes.map((rel) => {
            const isStart = normalizeRelPath(rel).toLowerCase() === normalizeRelPath(plan.startScene).toLowerCase();
            return (
              <label key={rel} className="field-row" title={rel}>
                <input
                  type="checkbox"
                  checked={shipsAll || shipping.has(normalizeRelPath(rel).toLowerCase()) || isStart}
                  disabled={isStart}
                  onChange={() => toggleScene(rel)}
                />
                <span className="field-label" style={{ flex: 1, marginLeft: 6 }}>
                  {rel}
                  {isStart ? " (start)" : ""}
                </span>
              </label>
            );
          })}
        </div>
      </div>

      <div className="inspector-section">
        <div className="section-header">Quality</div>
        <Row
          label="Preset"
          hint={
            "A ceiling, not an override: a preset can only make a scene cheaper than it was " +
            "authored. Ultra ships every scene exactly as saved."
          }
        >
          <select
            className="text-field"
            value={build.quality}
            onChange={(e) => patch({ quality: e.target.value })}
          >
            {Object.entries(QUALITY_PRESETS).map(([id, preset]) => (
              <option key={id} value={id}>
                {preset.label}
              </option>
            ))}
          </select>
        </Row>
      </div>

      <div className="inspector-section">
        <div className="section-header">Presentation</div>
        <Row
          label="Icon"
          hint="Used as the page favicon, the loading-screen logo and the desktop app icon."
        >
          <div style={{ display: "flex", gap: 4, width: "100%" }}>
            <input
              className="text-field"
              style={{ flex: 1 }}
              value={build.icon}
              placeholder="textures/icon.png"
              onChange={(e) => patch({ icon: normalizeRelPath(e.target.value) })}
            />
            <button
              className="toolbar-btn icon-only"
              title="Choose an image"
              onClick={async () => {
                const { open } = await import("@tauri-apps/plugin-dialog");
                const picked = await open({
                  title: "Game icon",
                  filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp"] }],
                });
                if (picked) patch({ icon: toProjectRelative(rootPath, picked) });
              }}
            >
              <FolderOpen size={12} />
            </button>
          </div>
        </Row>
        <Row label="Loading bg">
          <input
            className="color-field"
            type="color"
            value={build.loading.background}
            onChange={(e) => patchLoading({ background: e.target.value })}
          />
        </Row>
        <Row label="Loading accent">
          <input
            className="color-field"
            type="color"
            value={build.loading.accent}
            onChange={(e) => patchLoading({ accent: e.target.value })}
          />
        </Row>
        <Row label="Show title">
          <input
            type="checkbox"
            checked={build.loading.showTitle !== false}
            onChange={(e) => patchLoading({ showTitle: e.target.checked })}
          />
        </Row>
        <Row label="Show logo">
          <input
            type="checkbox"
            checked={build.loading.showLogo !== false}
            onChange={(e) => patchLoading({ showLogo: e.target.checked })}
          />
        </Row>
      </div>

      <div className="inspector-section">
        <div className="section-header">Compression</div>
        <Row
          label="Textures (Basis)"
          hint={
            basisOn
              ? "Encodes shipped PNG/JPEG to a GPU-compressed KTX2 derivative. Per-asset opt-outs still win."
              : "Enable the Basis Compression module to use this."
          }
        >
          <input
            type="checkbox"
            disabled={!basisOn}
            checked={!!build.compressTextures && basisOn}
            onChange={(e) => patch({ compressTextures: e.target.checked })}
          />
        </Row>
        <Row
          label="Models (Draco)"
          hint={
            dracoOn
              ? "Compresses shipped .glb meshes into the build. Project files are left untouched."
              : "Enable the Draco Compression module to use this."
          }
        >
          <input
            type="checkbox"
            disabled={!dracoOn}
            checked={!!build.compressModels && dracoOn}
            onChange={(e) => patch({ compressModels: e.target.checked })}
          />
        </Row>
      </div>

      {plan.warnings.length ? (
        <div className="inspector-section">
          <div className="section-header">Warnings</div>
          {plan.warnings.map((w) => (
            <div key={w} className="asset-hint" style={{ padding: "0 2px 4px" }}>
              <AlertTriangle size={11} style={{ verticalAlign: "-1px" }} /> {w}
            </div>
          ))}
        </div>
      ) : null}

      {report ? <BuildReport report={report} /> : null}

      <div className="asset-hint" style={{ padding: "4px 10px" }}>
        Stored in project.json under <code>settings.build</code>.
      </div>
    </div>
  );
}

function BuildReport({ report }) {
  if (report.cancelled) return null;
  if (!report.ok) {
    return (
      <div className="inspector-section">
        <div className="section-header">Build failed</div>
        <div className="asset-hint" style={{ padding: "0 2px 6px", color: "var(--danger, #e26d6d)" }}>
          {report.error}
        </div>
      </div>
    );
  }
  return (
    <div className="inspector-section">
      <div className="section-header">Last build</div>
      <div className="asset-hint" style={{ padding: "0 2px 6px" }}>
        {report.sceneCount} scene(s), {report.assetCount} file(s)
        {report.preloadCount ? `, ${report.preloadCount} preloaded` : ""}
        {report.savedBytes ? `, ${formatBytes(report.savedBytes)} saved by compression` : ""}
      </div>
      <div className="asset-hint" style={{ padding: "0 2px 6px", wordBreak: "break-all" }}>
        {report.zipPath ?? report.outDir}
      </div>
      {report.warnings?.map((w) => (
        <div key={w} className="asset-hint" style={{ padding: "0 2px 4px" }}>
          <AlertTriangle size={11} style={{ verticalAlign: "-1px" }} /> {w}
        </div>
      ))}
      <div style={{ display: "flex", gap: 4, padding: "4px 2px" }}>
        <button className="toolbar-btn" onClick={() => runPreview(report.contentDir)}>
          <Play size={12} />
          Run
        </button>
        <button
          className="toolbar-btn"
          onClick={async () => {
            const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
            revealItemInDir(report.zipPath ?? report.outDir);
          }}
        >
          <FolderOpen size={12} />
          Show
        </button>
      </div>
    </div>
  );
}

/**
 * Serves a build on loopback and opens it in the default browser.
 *
 * A built game can't be opened from the filesystem — module scripts, the
 * scene fetch and the WASM decoders are all blocked over `file://` — and
 * "now install a static server" is a strange thing for an engine to say about
 * its own output, so the editor runs one (see src-tauri/src/preview.rs).
 */
export async function runPreview(dir) {
  const { invoke } = await import("@tauri-apps/api/core");
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  const url = await invoke("serve_build", { dir });
  await openUrl(url);
  console.log(`Serving the build at ${url}`);
  return url;
}
