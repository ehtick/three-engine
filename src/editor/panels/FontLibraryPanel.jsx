// @ts-nocheck
import { useEffect, useMemo, useRef, useState } from "react";
import { Search, Download, Check, AlertTriangle, RefreshCw, Type } from "lucide-react";
import {
  fetchFontCatalog,
  catalogCategories,
  ensurePreviewFont,
  previewFamilyName,
  importGoogleFont,
} from "../fontLibrary.js";
import { usePanelVisible } from "../usePanelVisible.js";
import { useProjectStore } from "../store/projectStore.js";
import { revealAssetInPanel } from "../assetReveal.js";

/** How many families render at once. More is slower to paint and no more useful. */
const PAGE = 48;

const SORTS = [
  { id: "defaultSort", label: "Popular" },
  { id: "trending", label: "Trending" },
  { id: "alpha", label: "A–Z" },
  { id: "dateAdded", label: "Newest" },
];

/**
 * One row of the browser: the family name, then the sample rendered in that
 * family.
 *
 * The specimen font is fetched only once the row is actually on screen. With
 * ~1,900 families in the catalog, loading eagerly would mean a couple of
 * thousand font downloads to show a list — so the row starts in the UI's own
 * face and swaps when its own font arrives, which is also why the sample text
 * is visible (rather than blank) the whole time.
 */
function FontRow({ entry, sample, size, installed, onImport, busy }) {
  const ref = useRef(null);
  const [family, setFamily] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    let live = true;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((record) => record.isIntersecting)) return;
        observer.disconnect();
        ensurePreviewFont(entry.family)
          .then(() => live && setFamily(previewFamilyName(entry.family)))
          .catch(() => live && setFailed(true));
      },
      { rootMargin: "200px" },
    );
    observer.observe(element);
    return () => {
      live = false;
      observer.disconnect();
    };
  }, [entry.family]);

  return (
    <div className="font-row" ref={ref}>
      <div className="font-row-head">
        <span className="font-row-name">{entry.family}</span>
        <span className="font-row-meta">
          {entry.category}
          {entry.variants.length > 1 ? ` · ${entry.variants.length} styles` : ""}
          {entry.variable ? " · variable" : ""}
          {entry.designers[0] ? ` · ${entry.designers[0]}` : ""}
        </span>
        {!entry.openSource && (
          <span className="font-row-warn" title="Not open source — check Google's licence terms before shipping it">
            <AlertTriangle size={12} />
          </span>
        )}
        <button
          className="toolbar-btn"
          disabled={busy}
          onClick={() => onImport(entry)}
          title={`Download ${entry.family} into the project`}
        >
          {installed ? <Check size={13} /> : <Download size={13} />}
          {busy ? "Importing…" : installed ? "Re-import" : "Import"}
        </button>
      </div>
      <div
        className="font-row-sample"
        style={{ fontFamily: family ? `"${family}"` : "inherit", fontSize: size, opacity: family ? 1 : 0.45 }}
        title={failed ? "Preview unavailable" : undefined}
      >
        {sample || entry.family}
      </div>
    </div>
  );
}

/**
 * Browse and import Google Fonts.
 *
 * Only the "which weights" question gets asked at import time, and only when
 * the family has more than one — everything else (subsets, formats, display
 * strategy) is a web-delivery concern that means nothing for a game shipping
 * the file itself.
 */
export function FontLibraryPanel({ api }) {
  const visible = usePanelVisible(api);
  const [catalog, setCatalog] = useState(null);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [sort, setSort] = useState("defaultSort");
  const [sample, setSample] = useState("The quick brown fox jumps");
  const [size, setSize] = useState(26);
  const [count, setCount] = useState(PAGE);
  const [busy, setBusy] = useState(null);
  const [status, setStatus] = useState("");
  const [picking, setPicking] = useState(null); // family awaiting a variant choice
  const [chosen, setChosen] = useState([]);
  const rootPath = useProjectStore((state) => state.rootPath);

  const load = () => {
    setError(null);
    setCatalog(null);
    fetchFontCatalog()
      .then(setCatalog)
      .catch((err) => setError(String(err?.message ?? err)));
  };

  // Deferred until the panel is actually looked at — it's a megabyte of JSON
  // over the network, and a tab nobody opened shouldn't fetch it.
  useEffect(() => {
    if (visible && !catalog && !error) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const categories = useMemo(() => (catalog ? catalogCategories(catalog) : []), [catalog]);

  const results = useMemo(() => {
    if (!catalog) return [];
    const terms = query.trim().toLowerCase();
    let list = catalog.filter((entry) => {
      if (category !== "all" && entry.category !== category) return false;
      if (!terms) return true;
      return (
        entry.family.toLowerCase().includes(terms) ||
        entry.designers.some((name) => name.toLowerCase().includes(terms)) ||
        entry.subsets.some((subset) => subset.includes(terms))
      );
    });
    if (sort === "alpha") list = [...list].sort((a, b) => a.family.localeCompare(b.family));
    else if (sort === "dateAdded") list = [...list].sort((a, b) => b.dateAdded.localeCompare(a.dateAdded));
    else list = [...list].sort((a, b) => a[sort] - b[sort]);
    return list;
  }, [catalog, query, category, sort]);

  useEffect(() => setCount(PAGE), [query, category, sort]);

  const beginImport = (entry) => {
    if (entry.variants.length <= 1) return runImport(entry, entry.variants);
    setPicking(entry);
    // Regular first — it is what all but a handful of imports actually want,
    // and pre-checking it means the common case is one more click, not five.
    setChosen(entry.variants.filter((variant) => variant.weight === 400 && !variant.italic).map((v) => v.key));
    return undefined;
  };

  const runImport = async (entry, variants) => {
    setPicking(null);
    setBusy(entry.family);
    setStatus(`Downloading ${entry.family}…`);
    try {
      const written = await importGoogleFont(entry.family, variants, {
        onProgress: ({ index, total, name }) => setStatus(`${name} (${index + 1}/${total})`),
      });
      setStatus(`Imported ${written.length} file${written.length === 1 ? "" : "s"} into Fonts/`);
      revealAssetInPanel(written[0]);
    } catch (err) {
      setStatus("");
      setError(String(err?.message ?? err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="font-library">
      <div className="font-library-bar">
        <div className="search-field">
          <Search size={13} />
          <input
            type="text"
            value={query}
            placeholder="Search Google Fonts…"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <select className="select-field" value={category} onChange={(event) => setCategory(event.target.value)}>
          <option value="all">All categories</option>
          {categories.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <select className="select-field" value={sort} onChange={(event) => setSort(event.target.value)}>
          {SORTS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <div className="font-library-bar">
        <input
          className="text-field grow"
          type="text"
          value={sample}
          placeholder="Sample text"
          onChange={(event) => setSample(event.target.value)}
        />
        <input
          className="range-field"
          type="range"
          min={12}
          max={72}
          value={size}
          onChange={(event) => setSize(Number(event.target.value))}
          title="Sample size"
        />
        <span className="font-library-status">{status}</span>
      </div>

      {error && (
        <div className="font-library-error">
          {error}
          <button className="toolbar-btn" onClick={load}>
            <RefreshCw size={13} />
            Retry
          </button>
        </div>
      )}
      {!rootPath && <div className="asset-hint">Open a project to import fonts into it.</div>}
      {!catalog && !error && <div className="asset-hint">Loading the Google Fonts catalog…</div>}

      {picking && (
        <div className="font-variant-picker">
          <div className="section-header">{picking.family} — pick weights</div>
          <div className="font-variant-chips">
            {picking.variants.map((variant) => (
              <label key={variant.key} className={`font-variant${chosen.includes(variant.key) ? " on" : ""}`}>
                <input
                  type="checkbox"
                  checked={chosen.includes(variant.key)}
                  onChange={(event) =>
                    setChosen((current) =>
                      event.target.checked
                        ? [...current, variant.key]
                        : current.filter((key) => key !== variant.key),
                    )
                  }
                />
                {variant.label}
              </label>
            ))}
          </div>
          <div className="font-variant-actions">
            <button
              className="toolbar-btn"
              disabled={!chosen.length}
              onClick={() =>
                runImport(picking, picking.variants.filter((variant) => chosen.includes(variant.key)))
              }
            >
              <Download size={13} />
              Import {chosen.length} file{chosen.length === 1 ? "" : "s"}
            </button>
            <button className="toolbar-btn" onClick={() => setPicking(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="font-library-list">
        {catalog && !results.length && (
          <div className="asset-hint">
            <Type size={14} /> No family matches “{query}”.
          </div>
        )}
        {results.slice(0, count).map((entry) => (
          <FontRow
            key={entry.family}
            entry={entry}
            sample={sample}
            size={size}
            installed={false}
            busy={busy === entry.family}
            onImport={beginImport}
          />
        ))}
        {results.length > count && (
          <button className="toolbar-btn wide" onClick={() => setCount((value) => value + PAGE)}>
            Show more ({results.length - count} remaining)
          </button>
        )}
      </div>
    </div>
  );
}
