import { useEffect, useRef, useState } from "react";
import { Download, ExternalLink, KeyRound, Loader2, Pizza, Search } from "lucide-react";
import { useModulesStore, setModuleEnabled } from "../modules.js";
import { useProjectStore } from "../store/projectStore.js";
import {
  CATEGORIES,
  FILTER_PROMPT,
  LICENSES,
  downloadModel,
  getSavedToken,
  needsFilter,
  openModelPage,
  searchModels,
} from "../polypizza.js";
import { CREDENTIAL_CHANGED_EVENT } from "../credentialEvents.js";
import { ModelPreview } from "../components/ModelPreview.jsx";

const openModulesPanel = () => import("../EditorShell.jsx").then((m) => m.openPanel("modules"));

const PAGE_SIZE = 24;

/**
 * Poly Pizza's browse/import grid — the same shape as the Sketchfab and Poly
 * Haven panels, with three differences that come from the API rather than
 * taste:
 *
 *   - **The key gates browsing, not just downloading.** Poly Pizza 401s every
 *     endpoint without one, so an unkeyed panel shows a connect prompt instead
 *     of a grid. Sketchfab's equivalent bar is advisory (you can browse, you
 *     just cannot download); this one is a wall, and saying so up front beats
 *     an empty grid with an error under it.
 *   - **Category and licence are server-side filters**, offered before any
 *     search runs. Sketchfab's panel derives its dropdown from what the last
 *     page happened to contain, which cannot narrow a search you have not made
 *     yet. Twelve fixed categories can.
 *   - **Paging is by page number against a known total**, so the button can
 *     say how much is left rather than discovering the end by hitting it.
 *
 * The licence filter defaults to CC0. Most of the catalogue is CC-BY and some
 * is NC/ND, and the difference is a legal one that a grid of thumbnails is very
 * good at hiding — opening on the unambiguous subset is the safe default, and
 * the dropdown is right there.
 */
export function PolyPizzaPanel() {
  const moduleOn = useModulesStore((state) => state.enabled.includes("polypizza"));
  const hasProject = useProjectStore((state) => !!state.rootPath);
  const [query, setQuery] = useState("");
  // `animated` is a TRI-state against the API — true filters to animated, false
  // filters to static, null does not filter — but the toolbar control is a
  // checkbox, whose "off" means "don't care". Storing the checkbox's own false
  // here would send `animated=false` and quietly hide every animated model from
  // the default view, which is the opposite of what an unticked box says.
  const [filters, setFilters] = useState({ query: "", category: "", license: "CC0", animated: null });
  const [items, setItems] = useState(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [error, setError] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [token, setToken] = useState(() => getSavedToken());
  const gridRef = useRef(null);

  useEffect(() => {
    const onCredentialChange = (event) => {
      if (event.detail?.id === "polypizza") setToken(getSavedToken());
    };
    window.addEventListener(CREDENTIAL_CHANGED_EVENT, onCredentialChange);
    return () => window.removeEventListener(CREDENTIAL_CHANGED_EVENT, onCredentialChange);
  }, []);

  // "Any licence" with no category, no Animated and no search term is a request
  // the API refuses: it demands one of the three, and "any licence" is the
  // ABSENCE of the License parameter rather than a wildcard value, so it cannot
  // satisfy the requirement. Detected up front so the grid explains itself
  // instead of rendering a raw ZodError.
  const unfiltered = needsFilter(filters);

  useEffect(() => {
    if (!moduleOn || !token || unfiltered) return undefined;
    let alive = true;
    setItems(null);
    setError(null);
    setPage(1);
    setSelectedId(null);
    gridRef.current?.scrollTo?.(0, 0);
    searchModels({ ...filters, limit: PAGE_SIZE, page: 1 }).then(
      (result) => {
        if (!alive) return;
        setItems(result.models);
        setTotal(result.total);
      },
      (err) => alive && setError(err.message ?? String(err)),
    );
    return () => {
      alive = false;
    };
  }, [moduleOn, token, filters, unfiltered]);

  const selected = (items ?? []).find((item) => item.id === selectedId) ?? null;
  const hasMore = items !== null && items.length < total;

  const submit = (event) => {
    event.preventDefault();
    setFilters((current) => ({ ...current, query: query.trim() }));
  };

  const setFilter = (patch) => setFilters((current) => ({ ...current, ...patch }));

  const loadMore = async () => {
    if (!hasMore || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const next = page + 1;
      const result = await searchModels({ ...filters, limit: PAGE_SIZE, page: next });
      // Concatenate rather than replace: the grid is a running list, and the
      // API pages a stable ordering, so appending cannot duplicate.
      setItems((current) => [...(current ?? []), ...result.models]);
      setTotal(result.total);
      setPage(next);
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
          <Pizza size={28} />
          <h3>Poly Pizza</h3>
          <p>
            Browse thousands of free low-poly models — CC0 and CC-BY, including rigged and animated
            characters and animals — and import them straight into the project. Enable the Poly
            Pizza module to get started.
          </p>
          <button className="toolbar-btn wide" onClick={() => setModuleEnabled("polypizza", true)}>
            Enable Poly Pizza module
          </button>
        </div>
      </div>
    );
  }

  if (!token) {
    return (
      <div className="ph-panel">
        <div className="ph-gate">
          <KeyRound size={28} />
          <h3>Connect Poly Pizza</h3>
          <p>
            Poly Pizza's API needs a free key before it will return anything at all — browsing and
            downloading both go through it. Generate one on poly.pizza and save it in the Modules
            panel.
          </p>
          <button className="toolbar-btn wide" onClick={() => openModulesPanel()}>
            Open Modules
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
            placeholder="Search Poly Pizza models"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <button className="toolbar-btn" type="submit">Search</button>
        <select
          className="ph-category"
          value={filters.category}
          onChange={(event) => setFilter({ category: event.target.value })}
        >
          <option value="">All categories</option>
          {CATEGORIES.map((value) => (
            <option key={value.id} value={value.id}>{value.label}</option>
          ))}
        </select>
        <select
          className="ph-category"
          value={filters.license}
          onChange={(event) => setFilter({ license: event.target.value })}
        >
          {LICENSES.map((value) => (
            <option key={value.id || "any"} value={value.id}>{value.label}</option>
          ))}
        </select>
        <label className="pp-animated" title="Only models that ship with animation clips">
          <input
            type="checkbox"
            checked={filters.animated === true}
            onChange={(event) => setFilter({ animated: event.target.checked ? true : null })}
          />
          Animated
        </label>
      </form>

      <div className="ph-body">
        <div className="ph-grid-scroll" ref={gridRef}>
          {unfiltered ? (
            <div className="ph-status">{FILTER_PROMPT}</div>
          ) : error && !items ? (
            <div className="ph-status">Couldn't reach Poly Pizza: {error}</div>
          ) : items === null ? (
            <div className="ph-status"><Loader2 size={14} className="ph-spin" /> Loading catalog…</div>
          ) : items.length === 0 ? (
            <div className="ph-status">No models match those filters.</div>
          ) : (
            <>
              <div className="ph-grid">
                {items.map((item) => (
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
              {hasMore && (
                <button className="toolbar-btn wide ph-more" disabled={loadingMore} onClick={loadMore}>
                  {loadingMore
                    ? <><Loader2 size={13} className="ph-spin" /> Loading…</>
                    : `Load more (${items.length} of ${total.toLocaleString()})`}
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
            onClose={() => setSelectedId(null)}
          />
        )}
      </div>
    </div>
  );
}

function ModelDetail({ model, hasProject, onClose }) {
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
      console.log(`Poly Pizza: imported "${model.name}" by ${model.author}`);
    } catch (err) {
      setError(err.message ?? String(err));
    } finally {
      setProgress(null);
    }
  };

  return (
    <div className="ph-detail">
      <button className="ph-detail-close" onClick={onClose} title="Close">×</button>
      {/* The live model, not the thumbnail. A still of an animated character
          says nothing about whether its walk cycle is usable, and that is the
          whole question being asked before an import. Falls back to the
          thumbnail only when there is no downloadable GLB to show. */}
      {/* Deliberately NOT `ph-detail-preview`: that class paints a background
          and rounds the corners for the <img> it was written for, and layering
          it under the stage's own box double-draws both. */}
      {model.downloadUrl ? (
        <ModelPreview src={model.downloadUrl} />
      ) : (
        model.thumbnailUrl && <img className="ph-detail-preview" src={model.thumbnailUrl} alt={model.name} />
      )}
      <h3 className="ph-detail-name">{model.name}</h3>
      <div className="ph-detail-meta">
        <span>by {model.author}</span>
        <span>{model.license}</span>
        {model.triangles > 0 && <span>{model.triangles.toLocaleString()} tris</span>}
        {model.animated && <span>Animated</span>}
      </div>
      {model.description && <p className="sf-description">{model.description.replace(/<[^>]*>/g, " ")}</p>}
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
          <button className="toolbar-btn wide" onClick={() => openModelPage(model).catch((err) => setError(String(err)))}>
            <ExternalLink size={13} /> Open on Poly Pizza
          </button>
        </div>
      )}
      {/* CC-BY is the majority licence here, so the credit line is not a nicety
          — it is the condition of use, and it is written next to the asset
          rather than into a list nobody opens at ship time. */}
      <div className="sf-license-note">
        {model.attribution
          ? `Credit required: ${model.attribution}`
          : "Creator, source, and license are saved in ATTRIBUTION.md."}
      </div>
      {done && <div className="ph-done">{done}</div>}
      {error && <div className="ph-error">{error}</div>}
    </div>
  );
}
