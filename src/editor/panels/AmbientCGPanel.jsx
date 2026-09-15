import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Download, Globe, Loader2, Power, Search } from "../icons/index.jsx";
import { useModulesStore, setModuleEnabled } from "../modules.js";
import { useProjectStore } from "../store/projectStore.js";
import {
  fetchAssetIndex,
  fetchAssetFiles,
  thumbUrl,
  previewUrl,
  textureDownloadSize,
  pickResolution,
  availableResolutions,
  downloadTexture,
  downloadHdri,
  downloadModel,
  RES_DEFAULTS,
  modelPreviewUrl,
  fetchArchiveBytes,
} from "../ambientcg.js";
import { AssetPreview } from "../components/AssetPreview.jsx";
import { loadObjArchivePreview } from "../previewSources.js";

import { Select } from "../fields/Select.jsx";
const TABS = [
  { id: "Material", label: "Materials" },
  { id: "HDRI", label: "HDRIs" },
  { id: "3DModel", label: "Models" },
];

const PAGE = 60; // tiles rendered per "Show more" step (thumbs are lazy anyway)

const formatBytes = (bytes) => {
  if (!bytes) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 10 || u === 0 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
};

/**
 * AmbientCG browser: thumbnail grid of CC0 PBR materials, HDRIs and 3D
 * models with search + category filter, and a detail pane that downloads
 * the chosen ZIP, extracts the files we care about, and writes either a
 * ready-to-use .mat (materials), an .exr (HDRIs), or a .prefab containing
 * an ObjModelComponent (3D models) into the project's AmbientCG/ folder.
 * Gated on the `ambientcg` module so projects opt in explicitly.
 */
export function AmbientCGPanel() {
  const moduleOn = useModulesStore((s) => s.enabled.includes("ambientcg"));
  const hasProject = useProjectStore((s) => !!s.rootPath);

  const [tab, setTab] = useState("Material");
  const [items, setItems] = useState(null); // null = loading, [] = loaded
  const [error, setError] = useState(null);
  const [query, setQuery] = useState("");
  // The search input is bound directly to `query`; the local name + tags
  // substring filter over `items` consumes `deferredQuery` and is allowed
  // to lag a frame. The network fetch already runs on a setTimeout debounce
  // (see loadEffect), so deferring the local filter here is what keeps the
  // box from chunking on the index snapshot.
  const deferredQuery = useDeferredValue(query);
  const [category, setCategory] = useState("");
  const [shown, setShown] = useState(PAGE);
  const [selectedId, setSelectedId] = useState(null);
  const gridRef = useRef(null);

  // Tab changes reset pagination + selection; the dataType param drives the
  // backend filter so each tab gets its own (cached) list.
  useEffect(() => {
    setShown(PAGE);
    setSelectedId(null);
  }, [tab]);

  useEffect(() => {
    if (!moduleOn) return;
    let alive = true;
    setItems(null);
    setError(null);
    // Debounce the network round-trip so typing doesn't fire one per keystroke.
    const handle = setTimeout(() => {
      fetchAssetIndex({ type: tab, query }).then(
        (list) => alive && setItems(list),
        (err) => alive && setError(err.message ?? String(err)),
      );
    }, 250);
    return () => {
      alive = false;
      clearTimeout(handle);
    };
  }, [tab, query, moduleOn]);

  // Filter / search changes restart pagination and scroll back up.
  useEffect(() => {
    setShown(PAGE);
    gridRef.current?.scrollTo?.(0, 0);
  }, [query, category]);

  const categories = useMemo(() => {
    const counts = new Map();
    for (const item of items ?? []) {
      if (item.category) counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  }, [items]);

  const filtered = useMemo(() => {
    if (!items) return [];
    const q = deferredQuery.trim().toLowerCase();
    return items.filter(
      (item) =>
        (!category || item.category === category) &&
        (!q ||
          item.name.toLowerCase().includes(q) ||
          item.tags?.some((t) => t.toLowerCase().includes(q))),
    );
  }, [items, deferredQuery, category]);

  const selected = useMemo(
    () => (selectedId ? (items ?? []).find((i) => i.id === selectedId) : null),
    [items, selectedId],
  );

  if (!moduleOn) {
    return (
      <div className="acg-panel">
        <div className="acg-gate">
          <Globe size={28} className="empty-glyph" />
          <button className="toolbar-btn wide" onClick={() => setModuleEnabled("ambientcg", true)}>
            <Power size={13} /> Enable AmbientCG module
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="acg-panel">
      <div className="acg-toolbar">
        <div className="acg-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={`acg-tab${tab === t.id ? " active" : ""}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="acg-search">
          <Search size={13} />
          <input
            type="text"
            placeholder={`Search ${items ? filtered.length : "…"} assets`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <Select className="acg-category" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
      </div>

      <div className="acg-body">
        <div className="acg-grid-scroll" ref={gridRef}>
          {error ? (
            <div className="acg-status">Couldn't reach AmbientCG: {error}</div>
          ) : items === null ? (
            <div className="acg-status">
              <Loader2 size={14} className="acg-spin" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="acg-status">No assets match.</div>
          ) : (
            <>
              <div className="acg-grid">
                {filtered.slice(0, shown).map((item) => (
                  <div
                    key={item.id}
                    className={`acg-tile${item.id === selectedId ? " active" : ""}`}
                    onClick={() => setSelectedId(item.id)}
                    title={item.name}
                  >
                    <img src={thumbUrl(item.id)} loading="lazy" alt={item.name} draggable={false} />
                    <span className="acg-tile-name">{item.name}</span>
                  </div>
                ))}
              </div>
              {shown < filtered.length && (
                <button className="toolbar-btn wide acg-more" onClick={() => setShown((s) => s + PAGE * 2)}>
                  Show more ({filtered.length - shown} left)
                </button>
              )}
            </>
          )}
        </div>

        {selected && (
          <AssetDetail
            key={selected.id}
            asset={selected}
            dataType={tab}
            hasProject={hasProject}
            onClose={() => setSelectedId(null)}
          />
        )}
      </div>
    </div>
  );
}

function AssetDetail({ asset, dataType, hasProject, onClose }) {
  const [files, setFiles] = useState(null);
  const [error, setError] = useState(null);
  const [res, setRes] = useState(RES_DEFAULTS[dataType] ?? "1K-JPG");
  const [progress, setProgress] = useState(null); // { label, loaded, total }
  const [done, setDone] = useState(null);
  const busy = !!progress;

  useEffect(() => {
    let alive = true;
    setFiles(null);
    setError(null);
    fetchAssetFiles(asset.id).then(
      (f) => alive && setFiles(f),
      (err) => alive && setError(err.message ?? String(err)),
    );
    return () => {
      alive = false;
    };
  }, [asset.id]);

  // Snap `res` back to a valid value when the asset's available list arrives
  // or the user switches between assets with different resolution schemes.
  const resolutions = useMemo(() => (files ? availableResolutions(files.downloads) : []), [files]);

  useEffect(() => {
    if (resolutions.length && !resolutions.includes(res)) {
      setRes(pickResolution(files.downloads, res) ?? resolutions[0]);
    }
  }, [resolutions, res, files]);

  // The preview downloads a real archive — ambientCG ships no preview mesh —
  // so it always takes the SMALLEST variant rather than the one selected for
  // import. See modelPreviewUrl.
  const previewArchive = useMemo(
    () => (dataType === "3DModel" && files ? modelPreviewUrl(files) : null),
    [dataType, files],
  );

  const size = useMemo(() => {
    if (!files) return 0;
    if (dataType === "HDRI" || dataType === "3DModel") {
      // v2 endpoint doesn't always expose ZIP sizes; surface "—" rather
      // than 0 to avoid implying "free" when we genuinely don't know.
      return files.downloads?.[res]?.size ?? null;
    }
    return textureDownloadSize(files, res);
  }, [files, res, dataType]);

  const run = async (fn, doneMessage) => {
    setDone(null);
    setError(null);
    setProgress({ label: "Starting…", loaded: 0, total: size ?? 0 });
    try {
      await fn();
      setDone(doneMessage);
      console.log(`AmbientCG: imported "${asset.name}" (${res})`);
    } catch (err) {
      setError(err.message ?? String(err));
      console.error(`AmbientCG download failed: ${err.message ?? err}`);
    } finally {
      setProgress(null);
    }
  };

  const args = { name: asset.name, files, res, onProgress: setProgress };
  const percent = progress?.total ? Math.min(100, Math.round((progress.loaded / progress.total) * 100)) : null;

  // Pick the right download function + label per dataType.
  const downloadAction = {
    Material: { fn: () => downloadTexture(args), label: "Download material", done: "Material imported ✓" },
    HDRI: { fn: () => downloadHdri(args), label: "Download HDRI", done: "HDRI imported ✓" },
    "3DModel": { fn: () => downloadModel(args), label: "Download model", done: "Model imported ✓" },
  }[dataType];

  return (
    <div className="acg-detail">
      <button className="acg-detail-close" onClick={onClose} title="Close">
        ×
      </button>
      {/* Models get the live mesh; materials and HDRIs keep the still,
          which for those two IS the asset — ambientCG's own rendered sphere
          says more about a material than a viewport would. */}
      <AssetPreview
        src={dataType === "3DModel" ? previewArchive : null}
        load={previewArchive ? () => fetchArchiveBytes(previewArchive).then(loadObjArchivePreview) : null}
        thumbnailUrl={previewUrl(asset.id)}
        alt={asset.name}
      />
      <h3 className="acg-detail-name">{asset.name}</h3>
      <div className="acg-detail-meta">
        {asset.category && <span>{asset.category}</span>}
        <span><span className="cnt" title="downloads">{(asset.downloadCount ?? 0).toLocaleString()}</span> · CC0</span>
      </div>
      {dataType === "Material" && asset.maps?.length > 0 && (
        <div className="acg-detail-cats">
          {asset.maps.map((m) => (
            <span key={m} className="acg-chip">
              {m}
            </span>
          ))}
        </div>
      )}
      {dataType === "HDRI" && (
        <div className="acg-detail-cats">
          <span className="acg-chip">Equirectangular</span>
          <span className="acg-chip">EXR</span>
        </div>
      )}
      {dataType === "3DModel" && (
        <div className="acg-detail-cats">
          <span className="acg-chip">Wavefront OBJ</span>
          <span className="acg-chip">PBR textures</span>
        </div>
      )}

      {files === null && !error ? (
        <div className="acg-status">
          <Loader2 size={14} className="acg-spin" />
        </div>
      ) : (
        <>
          <div className="acg-detail-row">
            <label>Resolution</label>
            <Select value={res} disabled={busy} onChange={(e) => setRes(e.target.value)}>
              {resolutions.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </Select>
            <span className="acg-size">{size == null ? "—" : formatBytes(size)}</span>
          </div>

          {!hasProject && <div className="acg-status">Open a project to download.</div>}

          {busy ? (
            <div className="acg-progress">
              <div className="acg-progress-bar">
                <div
                  className="acg-progress-fill"
                  style={{ width: percent === null ? "100%" : `${percent}%` }}
                />
              </div>
              <span>{progress.label}</span>
            </div>
          ) : (
            <div className="acg-detail-actions">
              <button
                className="toolbar-btn wide"
                disabled={!hasProject || !files}
                onClick={() => run(downloadAction.fn, downloadAction.done)}
              >
                <Download size={13} /> {downloadAction.label}
              </button>
            </div>
          )}
          {done && <div className="acg-done">{done}</div>}
          {error && <div className="acg-error">{error}</div>}
        </>
      )}
    </div>
  );
}