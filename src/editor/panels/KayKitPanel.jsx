import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Download, ExternalLink, Loader2, Power, Search, Swords } from "../icons/index.jsx";
import { useModulesStore, setModuleEnabled } from "../modules.js";
import { useProjectStore } from "../store/projectStore.js";
import { PACKS, downloadModel, fetchPackItems, openModelPage, packImageUrl } from "../kaykit.js";
import { AssetPreview } from "../components/AssetPreview.jsx";

import { Select } from "../fields/Select.jsx";
/**
 * KayKit's browse/import grid — structurally the Poly Pizza panel minus
 * credentials, with one structural difference of its own: there is no server
 * to search. Browsing is two LOCAL steps — pick a pack (one GitHub API request
 * for its file tree, cached for the session), then filter its files by name —
 * so the toolbar has a pack picker where the other panels have a Search
 * button.
 *
 * The grid tiles are deliberately placeholders: GitHub serves no per-file
 * thumbnails, and rendering the pack's cover image on every tile would show
 * the same picture 200 times. The answer to "what am I about to import" is
 * the detail pane's live 3D preview, which loads the actual GLB — animations
 * included — from raw.githubusercontent.com.
 */
export function KayKitPanel() {
  const moduleOn = useModulesStore((state) => state.enabled.includes("kaykit"));
  const hasProject = useProjectStore((state) => !!state.rootPath);
  // The characters are the point — open on the pack that has them.
  const [packId, setPackId] = useState(PACKS[0].id);
  const [query, setQuery] = useState("");
  // The search input is bound directly to `query`; the local name filter
  // over `items` consumes `deferredQuery` and is allowed to lag a frame.
  // Per-pack file lists can run into hundreds of GLBs.
  const deferredQuery = useDeferredValue(query);
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const gridRef = useRef(null);

  useEffect(() => {
    if (!moduleOn) return;
    let alive = true;
    setItems(null);
    setError(null);
    setSelectedId(null);
    fetchPackItems(packId).then(
      (result) => alive && setItems(result),
      (err) => alive && setError(err.message ?? String(err)),
    );
    return () => {
      alive = false;
    };
  }, [moduleOn, packId]);

  useEffect(() => {
    gridRef.current?.scrollTo?.(0, 0);
  }, [packId, query]);

  const filtered = useMemo(() => {
    const needle = deferredQuery.trim().toLowerCase();
    return (items ?? []).filter((item) => !needle || item.name.toLowerCase().includes(needle));
  }, [items, deferredQuery]);
  const selected = (items ?? []).find((item) => item.id === selectedId) ?? null;

  if (!moduleOn) {
    return (
      <div className="ph-panel">
        <div className="ph-gate">
          <Swords size={28} className="empty-glyph" />
          <button className="toolbar-btn wide" onClick={() => setModuleEnabled("kaykit", true)}>
            <Power size={13} /> Enable KayKit module
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="ph-panel sf-panel">
      <form className="ph-toolbar" onSubmit={(event) => event.preventDefault()}>
        <Select
          className="ph-category"
          value={packId}
          onChange={(event) => setPackId(event.target.value)}
          title="Which KayKit pack to browse"
        >
          {PACKS.map((pack) => (
            <option key={pack.id} value={pack.id}>
              {pack.title} — {pack.kind}
            </option>
          ))}
        </Select>
        <div className="ph-search">
          <Search size={13} />
          <input
            type="text"
            placeholder="Filter by name"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      </form>

      <div className="ph-body">
        <div className="ph-grid-scroll" ref={gridRef}>
          {error && !items ? (
            <div className="ph-status">Couldn't reach GitHub: {error}</div>
          ) : items === null ? (
            <div className="ph-status"><Loader2 size={14} className="ph-spin" /></div>
          ) : filtered.length === 0 ? (
            <div className="ph-status">No models in this pack match.</div>
          ) : (
            <div className="ph-grid">
              {filtered.map((item) => (
                <div
                  key={item.id}
                  className={`ph-tile${item.id === selectedId ? " active" : ""}`}
                  onClick={() => setSelectedId(item.id)}
                  title={`${item.name} — ${item.pack.title}${item.animated ? ", animated" : ""}`}
                >
                  {item.kind === "character"
                    ? <div className="sf-thumb-empty">Char</div>
                    : <div className="sf-thumb-empty">3D</div>}
                  {item.animated && <span className="sf-badge">Animated</span>}
                  <span className="ph-tile-name">{item.name}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        {selected && (
          <ModelDetail
            key={selected.id}
            item={selected}
            hasProject={hasProject}
            onClose={() => setSelectedId(null)}
          />
        )}
      </div>
    </div>
  );
}

function ModelDetail({ item, hasProject, onClose }) {
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);

  const runDownload = async () => {
    setError(null);
    setDone(null);
    setProgress({ label: "Starting…" });
    try {
      await downloadModel(item, setProgress);
      setDone("Model imported ✓ (CC0 — no attribution required)");
      console.log(`KayKit: imported "${item.name}" from ${item.pack.title}`);
    } catch (err) {
      setError(err.message ?? String(err));
    } finally {
      setProgress(null);
    }
  };

  return (
    <div className="ph-detail">
      <button className="ph-detail-close" onClick={onClose} title="Close">×</button>
      {/* The real GLB from raw.githubusercontent.com, not a thumbnail — for a
          character that means turning it AND playing its clips before
          deciding to import. GitHub serves it CORS-open, so the engine's own
          loader reads it directly. Falls back to the pack cover if the file
          somehow fails. */}
      <AssetPreview src={item.downloadUrl} thumbnailUrl={packImageUrl(item.repo)} alt={item.name} />
      <h3 className="ph-detail-name">{item.name}</h3>
      <div className="ph-detail-meta">
        <span>{item.pack.title}</span>
        <span>{item.kind}</span>
        <span>CC0</span>
        {item.animated && <span>Animated</span>}
      </div>
      <p className="sf-description">{item.pack.description}</p>
      {!hasProject && <div className="ph-status">Open a project to download.</div>}
      {progress ? (
        <div className="ph-progress">
          <div className="ph-progress-bar"><div className="ph-progress-fill sf-progress" /></div>
          <span>{progress.label}</span>
        </div>
      ) : (
        <div className="ph-detail-actions">
          <button className="toolbar-btn wide" disabled={!hasProject} onClick={runDownload}>
            <Download size={13} /> Download &amp; import
          </button>
          <button className="toolbar-btn wide" onClick={() => openModelPage(item).catch((err) => setError(String(err)))}>
            <ExternalLink size={13} /> Open on GitHub
          </button>
        </div>
      )}
      {/* CC0: the ATTRIBUTION.md beside the asset records where it came from,
          not a licence duty — saying so prevents the file being read as one. */}
      <div className="sf-license-note">License: CC0 1.0 — free for any use, no credit required. Source is saved in ATTRIBUTION.md.</div>
      {done && <div className="ph-done">{done}</div>}
      {error && <div className="ph-error">{error}</div>}
    </div>
  );
}
