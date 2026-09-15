import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Download, Globe, Loader2, Power, Search } from "../icons/index.jsx";
import { useModulesStore, setModuleEnabled } from "../modules.js";
import { useProjectStore } from "../store/projectStore.js";
import {
  fetchAssetIndex,
  fetchAssetFiles,
  thumbUrl,
  previewUrl,
  textureMapPlan,
  textureDownloadSize,
  modelDownloadSize,
  hdriDownloadSize,
  pickResolution,
  modelPreviewPlan,
  downloadTexture,
  downloadModel,
  downloadHdri,
  setSceneEnvironment,
} from "../polyhaven.js";
import { AssetPreview } from "../components/AssetPreview.jsx";
import { loadRemappedGltf } from "../previewSources.js";

import { Select } from "../fields/Select.jsx";
const TABS = [
  { id: "textures", label: "Materials" },
  { id: "models", label: "Models" },
  { id: "hdris", label: "HDRIs" },
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
 * Poly Haven browser: website-style thumbnail grid (Materials / Models /
 * HDRIs) with search + category filters, and a detail pane that downloads
 * straight into the project's PolyHaven/ folder in a ready-to-use form.
 * Gated on the `polyhaven` module so projects opt in explicitly.
 */
export function PolyHavenPanel() {
  const moduleOn = useModulesStore((s) => s.enabled.includes("polyhaven"));
  const hasProject = useProjectStore((s) => !!s.rootPath);

  const [tab, setTab] = useState("textures");
  const [items, setItems] = useState(null); // null = loading, [] = loaded
  const [error, setError] = useState(null);
  const [query, setQuery] = useState("");
  // The search input is bound directly to `query`; the local name + tags
  // substring filter over `items` consumes `deferredQuery`, allowed to lag
  // a frame. The PolyHaven index per tab runs into the hundreds; the filter
  // is cheap individually but the lowercased substring over every item is
  // what lags the input.
  const deferredQuery = useDeferredValue(query);
  const [category, setCategory] = useState("");
  const [shown, setShown] = useState(PAGE);
  const [selectedId, setSelectedId] = useState(null);
  const gridRef = useRef(null);

  useEffect(() => {
    if (!moduleOn) return;
    let alive = true;
    setItems(null);
    setError(null);
    fetchAssetIndex(tab).then(
      (list) => alive && setItems(list),
      (err) => alive && setError(err.message ?? String(err)),
    );
    return () => {
      alive = false;
    };
  }, [tab, moduleOn]);

  // Tab/filter changes restart pagination and scroll back up.
  useEffect(() => {
    setShown(PAGE);
    gridRef.current?.scrollTo?.(0, 0);
  }, [tab, query, category]);

  const categories = useMemo(() => {
    const counts = new Map();
    for (const item of items ?? []) {
      for (const c of item.categories ?? []) counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  }, [items]);

  const filtered = useMemo(() => {
    if (!items) return [];
    const q = deferredQuery.trim().toLowerCase();
    return items.filter(
      (item) =>
        (!category || item.categories?.includes(category)) &&
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
      <div className="ph-panel">
        <div className="ph-gate">
          <Globe size={28} className="empty-glyph" />
          <button className="toolbar-btn wide" onClick={() => setModuleEnabled("polyhaven", true)}>
            <Power size={13} /> Enable Poly Haven module
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="ph-panel">
      <div className="ph-toolbar">
        <div className="ph-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={`ph-tab${tab === t.id ? " active" : ""}`}
              onClick={() => {
                setTab(t.id);
                setSelectedId(null);
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="ph-search">
          <Search size={13} />
          <input
            type="text"
            placeholder={`Search ${items ? filtered.length : "…"} assets`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <Select className="ph-category" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
      </div>

      <div className="ph-body">
        <div className="ph-grid-scroll" ref={gridRef}>
          {error ? (
            <div className="ph-status">Couldn't reach Poly Haven: {error}</div>
          ) : items === null ? (
            <div className="ph-status">
              <Loader2 size={14} className="ph-spin" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="ph-status">No assets match.</div>
          ) : (
            <>
              <div className="ph-grid">
                {filtered.slice(0, shown).map((item) => (
                  <div
                    key={item.id}
                    className={`ph-tile${item.id === selectedId ? " active" : ""}`}
                    onClick={() => setSelectedId(item.id)}
                    title={item.name}
                  >
                    <img src={thumbUrl(item.id)} loading="lazy" alt={item.name} draggable={false} />
                    <span className="ph-tile-name">{item.name}</span>
                  </div>
                ))}
              </div>
              {shown < filtered.length && (
                <button className="toolbar-btn wide ph-more" onClick={() => setShown((s) => s + PAGE * 2)}>
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
            type={tab}
            hasProject={hasProject}
            onClose={() => setSelectedId(null)}
          />
        )}
      </div>
    </div>
  );
}

function AssetDetail({ asset, type, hasProject, onClose }) {
  const [files, setFiles] = useState(null);
  const [error, setError] = useState(null);
  const [res, setRes] = useState("2k");
  const [progress, setProgress] = useState(null); // { label, loaded, total }
  const [done, setDone] = useState(null); // success message
  const busy = !!progress;

  useEffect(() => {
    let alive = true;
    fetchAssetFiles(asset.id).then(
      (f) => alive && setFiles(f),
      (err) => alive && setError(err.message ?? String(err)),
    );
    return () => {
      alive = false;
    };
  }, [asset.id]);

  // Resolutions offered for this asset kind (union for textures via the plan).
  const resolutions = useMemo(() => {
    if (!files) return [];
    const source =
      type === "hdris"
        ? files.hdri
        : type === "models"
          ? files.gltf
          : textureMapPlan(files)[0]?.byRes;
    const order = ["1k", "2k", "4k", "8k", "12k", "16k", "24k"];
    return Object.keys(source ?? {}).sort((a, b) => order.indexOf(a) - order.indexOf(b));
  }, [files, type]);

  useEffect(() => {
    if (resolutions.length && !resolutions.includes(res)) {
      setRes(pickResolution(Object.fromEntries(resolutions.map((r) => [r, 1])), res) ?? resolutions[0]);
    }
  }, [resolutions, res]);

  // The preview always loads the SMALLEST glTF on offer, not the resolution
  // selected for download: this is a thumbnail replacement, and pulling 4k
  // textures to spin a 260px pane would cost more than the import it is meant
  // to help you decide on.
  const preview = useMemo(
    () => (type === "models" && files ? modelPreviewPlan(files, resolutions[0] ?? "1k") : null),
    [type, files, resolutions],
  );

  const size = useMemo(() => {
    if (!files) return 0;
    if (type === "hdris") return hdriDownloadSize(files, res);
    if (type === "models") return modelDownloadSize(files, res);
    return textureDownloadSize(files, res);
  }, [files, type, res]);

  const run = async (fn, doneMessage) => {
    setDone(null);
    setError(null);
    setProgress({ label: "Starting…", loaded: 0, total: size });
    try {
      await fn();
      setDone(doneMessage);
      console.log(`Poly Haven: imported "${asset.name}" (${res})`);
    } catch (err) {
      setError(err.message ?? String(err));
      console.error(`Poly Haven download failed: ${err.message ?? err}`);
    } finally {
      setProgress(null);
    }
  };

  const args = { name: asset.name, files, res, onProgress: setProgress };
  const percent = progress?.total ? Math.min(100, Math.round((progress.loaded / progress.total) * 100)) : null;

  return (
    <div className="ph-detail">
      <button className="ph-detail-close" onClick={onClose} title="Close">
        ×
      </button>
      {/* Models get the live mesh; materials and HDRIs keep the still,
          which for those two IS the asset — a rendered sphere and a
          panorama both say more than a viewport would. The plan carries the
          include table because Poly Haven's resources are not where the
          .gltf claims they are; see modelPreviewPlan. */}
      <AssetPreview
        src={type === "models" ? (preview?.url ?? null) : null}
        load={preview ? () => loadRemappedGltf(preview.url, preview.resources) : null}
        thumbnailUrl={previewUrl(asset.id)}
        alt={asset.name}
      />
      <h3 className="ph-detail-name">{asset.name}</h3>
      <div className="ph-detail-meta">
        {asset.authors && <span>by {Object.keys(asset.authors).join(", ")}</span>}
        <span><span className="cnt" title="downloads">{(asset.download_count ?? 0).toLocaleString()}</span> · CC0</span>
      </div>
      {asset.categories?.length > 0 && (
        <div className="ph-detail-cats">
          {asset.categories.slice(0, 6).map((c) => (
            <span key={c} className="ph-chip">
              {c}
            </span>
          ))}
        </div>
      )}

      {files === null && !error ? (
        <div className="ph-status">
          <Loader2 size={14} className="ph-spin" />
        </div>
      ) : (
        <>
          <div className="ph-detail-row">
            <label>Resolution</label>
            <Select value={res} disabled={busy} onChange={(e) => setRes(e.target.value)}>
              {resolutions.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </Select>
            <span className="ph-size">{formatBytes(size)}</span>
          </div>

          {!hasProject && <div className="ph-status">Open a project to download.</div>}

          {busy ? (
            <div className="ph-progress">
              <div className="ph-progress-bar">
                <div
                  className="ph-progress-fill"
                  style={{ width: percent === null ? "100%" : `${percent}%` }}
                />
              </div>
              <span>{progress.label}</span>
            </div>
          ) : (
            <div className="ph-detail-actions">
              <button
                className="toolbar-btn wide"
                disabled={!hasProject || !files}
                onClick={() =>
                  run(async () => {
                    if (type === "textures") await downloadTexture(args);
                    else if (type === "models") await downloadModel(args);
                    else await downloadHdri(args);
                  }, type === "textures" ? "Material imported ✓" : type === "models" ? "Model imported ✓" : "HDRI imported ✓")
                }
              >
                <Download size={13} />{" "}
                {type === "textures" ? "Download material" : type === "models" ? "Download model" : "Download HDRI"}
              </button>
              {type === "hdris" && (
                <button
                  className="toolbar-btn wide"
                  disabled={!hasProject || !files}
                  onClick={() =>
                    run(async () => {
                      const path = await downloadHdri(args);
                      await setSceneEnvironment(path);
                    }, "Set as scene environment ✓")
                  }
                >
                  Download &amp; use as sky
                </button>
              )}
            </div>
          )}
          {done && <div className="ph-done">{done}</div>}
          {error && <div className="ph-error">{error}</div>}
        </>
      )}
    </div>
  );
}
