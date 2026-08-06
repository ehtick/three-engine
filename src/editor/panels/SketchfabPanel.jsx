import { useEffect, useMemo, useRef, useState } from "react";
import { Download, ExternalLink, Globe, KeyRound, Loader2, Search } from "lucide-react";
import { useModulesStore, setModuleEnabled } from "../modules.js";
import { useProjectStore } from "../store/projectStore.js";
import { downloadModel, getSavedToken, openModelPage, searchModels } from "../sketchfab.js";
import { CREDENTIAL_CHANGED_EVENT } from "../credentialEvents.js";

const openModulesPanel = () => import("../EditorShell.jsx").then((m) => m.openPanel("modules"));

export function SketchfabPanel() {
  const moduleOn = useModulesStore((state) => state.enabled.includes("sketchfab"));
  const hasProject = useProjectStore((state) => !!state.rootPath);
  const [query, setQuery] = useState("");
  const [request, setRequest] = useState("");
  const [category, setCategory] = useState("");
  const [items, setItems] = useState(null);
  const [next, setNext] = useState(null);
  const [error, setError] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [token, setToken] = useState(() => getSavedToken());
  const gridRef = useRef(null);

  useEffect(() => {
    const onCredentialChange = (event) => {
      if (event.detail?.id === "sketchfab") setToken(getSavedToken());
    };
    window.addEventListener(CREDENTIAL_CHANGED_EVENT, onCredentialChange);
    return () => window.removeEventListener(CREDENTIAL_CHANGED_EVENT, onCredentialChange);
  }, []);

  useEffect(() => {
    if (!moduleOn) return;
    let alive = true;
    setItems(null);
    setNext(null);
    setError(null);
    searchModels(request).then(
      (result) => {
        if (!alive) return;
        setItems(result.models);
        setNext(result.next);
      },
      (err) => alive && setError(err.message ?? String(err)),
    );
    return () => {
      alive = false;
    };
  }, [moduleOn, request]);

  useEffect(() => {
    setSelectedId(null);
    setCategory("");
    gridRef.current?.scrollTo?.(0, 0);
  }, [request]);

  const categories = useMemo(() => {
    const values = new Set((items ?? []).flatMap((item) => item.categories));
    return [...values].sort();
  }, [items]);
  const filtered = useMemo(
    () => (items ?? []).filter((item) => !category || item.categories.includes(category)),
    [items, category],
  );
  const selected = (items ?? []).find((item) => item.id === selectedId) ?? null;

  const submit = (event) => {
    event.preventDefault();
    setRequest(query.trim());
  };

  const loadMore = async () => {
    if (!next || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const result = await searchModels("", next);
      setItems((current) => [...(current ?? []), ...result.models]);
      setNext(result.next);
    } catch (err) {
      setError(err.message ?? String(err));
    } finally {
      setLoadingMore(false);
    }
  };

  if (!moduleOn) {
    return (
      <div className="ph-panel">
        <div className="ph-gate">
          <Globe size={28} />
          <h3>Sketchfab</h3>
          <p>
            Browse downloadable Creative Commons models from Sketchfab and import GLTF assets with
            creator attribution. Enable the Sketchfab module to get started.
          </p>
          <button className="toolbar-btn wide" onClick={() => setModuleEnabled("sketchfab", true)}>
            Enable Sketchfab module
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="ph-panel sf-panel">
      <form className="ph-toolbar" onSubmit={submit}>
        <div className="ph-search">
          <Search size={13} />
          <input
            type="text"
            placeholder="Search downloadable Sketchfab models"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <button className="toolbar-btn" type="submit">Search</button>
        <select className="ph-category" value={category} onChange={(event) => setCategory(event.target.value)}>
          <option value="">All loaded categories</option>
          {categories.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </form>

      {!token && (
        <div className="sf-authbar">
          <KeyRound size={13} />
          <span>Downloads require your personal Sketchfab token — connect it in the Modules panel</span>
          <button className="toolbar-btn" onClick={() => openModulesPanel()}>Open Modules</button>
        </div>
      )}

      <div className="ph-body">
        <div className="ph-grid-scroll" ref={gridRef}>
          {error && !items ? (
            <div className="ph-status">Couldn't reach Sketchfab: {error}</div>
          ) : items === null ? (
            <div className="ph-status"><Loader2 size={14} className="ph-spin" /> Loading catalog…</div>
          ) : filtered.length === 0 ? (
            <div className="ph-status">No downloadable models match.</div>
          ) : (
            <>
              <div className="ph-grid">
                {filtered.map((item) => (
                  <div
                    key={item.id}
                    className={`ph-tile${item.id === selectedId ? " active" : ""}`}
                    onClick={() => setSelectedId(item.id)}
                    title={`${item.name} by ${item.author}`}
                  >
                    {item.thumbnailUrl
                      ? <img src={item.thumbnailUrl} loading="lazy" alt={item.name} draggable={false} />
                      : <div className="sf-thumb-empty">3D</div>}
                    {item.animated && <span className="sf-badge">Animated</span>}
                    <span className="ph-tile-name">{item.name}</span>
                  </div>
                ))}
              </div>
              {next && !category && (
                <button className="toolbar-btn wide ph-more" disabled={loadingMore} onClick={loadMore}>
                  {loadingMore ? <><Loader2 size={13} className="ph-spin" /> Loading…</> : "Load more"}
                </button>
              )}
              {error && <div className="ph-error sf-load-error">{error}</div>}
            </>
          )}
        </div>
        {selected && (
          <ModelDetail
            key={selected.id}
            model={selected}
            hasProject={hasProject}
            hasToken={!!token}
            onClose={() => setSelectedId(null)}
          />
        )}
      </div>
    </div>
  );
}

function ModelDetail({ model, hasProject, hasToken, onClose }) {
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);

  const runDownload = async () => {
    setError(null);
    setDone(null);
    setProgress({ label: "Starting…" });
    try {
      await downloadModel(model, setProgress);
      setDone("Model imported with attribution ✓");
      console.log(`Sketchfab: imported "${model.name}" by ${model.author}`);
    } catch (err) {
      setError(err.message ?? String(err));
    } finally {
      setProgress(null);
    }
  };

  return (
    <div className="ph-detail">
      <button className="ph-detail-close" onClick={onClose} title="Close">×</button>
      {model.thumbnailUrl && <img className="ph-detail-preview" src={model.thumbnailUrl} alt={model.name} />}
      <h3 className="ph-detail-name">{model.name}</h3>
      <div className="ph-detail-meta">
        <span>by {model.author}</span>
        <span>{model.license}</span>
        <span>{model.views.toLocaleString()} views · {model.likes.toLocaleString()} likes</span>
        {model.faces > 0 && <span>{model.faces.toLocaleString()} faces</span>}
      </div>
      {model.categories.length > 0 && (
        <div className="ph-detail-cats">
          {model.categories.slice(0, 5).map((value) => <span className="ph-chip" key={value}>{value}</span>)}
        </div>
      )}
      {model.description && <p className="sf-description">{model.description.replace(/<[^>]*>/g, " ")}</p>}
      {!hasProject && <div className="ph-status">Open a project to download.</div>}
      {!hasToken && <div className="ph-status">Connect your Sketchfab token in the Modules panel to download.</div>}
      {progress ? (
        <div className="ph-progress">
          <div className="ph-progress-bar"><div className="ph-progress-fill sf-progress" /></div>
          <span>{progress.label}</span>
        </div>
      ) : (
        <div className="ph-detail-actions">
          <button className="toolbar-btn wide" disabled={!hasProject || !hasToken} onClick={runDownload}>
            <Download size={13} /> Download &amp; import
          </button>
          <button className="toolbar-btn wide" onClick={() => openModelPage(model).catch((err) => setError(String(err)))}>
            <ExternalLink size={13} /> Open on Sketchfab
          </button>
        </div>
      )}
      <div className="sf-license-note">Creator, source, and license are saved in ATTRIBUTION.md.</div>
      {done && <div className="ph-done">{done}</div>}
      {error && <div className="ph-error">{error}</div>}
    </div>
  );
}
