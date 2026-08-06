import { useEffect, useState } from "react";
import { Download, ExternalLink, Globe, Hash, Info, KeyRound, Loader2, Search, Store, UploadCloud } from "lucide-react";
import { useModulesStore, setModuleEnabled } from "../modules.js";
import { useProjectStore } from "../store/projectStore.js";
import {
  downloadAndImport,
  fetchLibrary,
  fetchMyGames,
  fetchUploads,
  getSavedToken,
  openGameEditPage,
  openGamePage,
} from "../itchio.js";
import { STORE_SORTS, browseStore, openStoreItem, searchStore } from "../itchioStore.js";
import { CREDENTIAL_CHANGED_EVENT } from "../credentialEvents.js";

const openModulesPanel = () => import("../EditorShell.jsx").then((m) => m.openPanel("modules"));

const TABS = [
  { id: "library", label: "Library" },
  { id: "store", label: "Store" },
  { id: "publish", label: "Publish" },
];

/** Shared "connect this in the Modules panel" banner for a missing credential. */
function CredentialBanner({ children }) {
  return (
    <div className="sf-authbar">
      <KeyRound size={13} />
      <span>{children}</span>
      <button className="toolbar-btn" onClick={() => openModulesPanel()}>Open Modules</button>
    </div>
  );
}

/**
 * itch.io browser: your owned/purchased library, whole-store discovery, and
 * a guided publish flow for your own games. Gated on the `itchio` module
 * like every other external-catalog panel. Library/Publish need the itch.io
 * API key (per-account data only — itch.io has no anonymous catalog); Store
 * needs no credential at all — it fetches itch.io's public pages directly
 * and parses the HTML (see itchioStore.js) since reaching the *whole* store
 * means scraping, which itch.io's own API can't do.
 */
export function ItchioPanel() {
  const moduleOn = useModulesStore((s) => s.enabled.includes("itchio"));
  const [tab, setTab] = useState("library");
  const [token, setToken] = useState(() => getSavedToken());

  useEffect(() => {
    const onCredentialChange = (event) => {
      if (event.detail?.id === "itchio") setToken(getSavedToken());
    };
    window.addEventListener(CREDENTIAL_CHANGED_EVENT, onCredentialChange);
    return () => window.removeEventListener(CREDENTIAL_CHANGED_EVENT, onCredentialChange);
  }, []);

  if (!moduleOn) {
    return (
      <div className="ph-panel">
        <div className="ph-gate">
          <Globe size={28} />
          <h3>itch.io</h3>
          <p>
            Browse your itch.io library and the whole store, import downloads into the project, or
            build a publish-ready zip for one of your own games. Enable the itch.io module to get
            started.
          </p>
          <button className="toolbar-btn wide" onClick={() => setModuleEnabled("itchio", true)}>
            Enable itch.io module
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="ph-panel">
      <div className="ph-toolbar">
        <div className="ph-tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`ph-tab${tab === t.id ? " active" : ""}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {tab === "store" ? (
        <StoreTab token={token} />
      ) : !token ? (
        <>
          <CredentialBanner>
            Connect your itch.io API key in the Modules panel to browse your library or publish
          </CredentialBanner>
          <div className="ph-status">Connect an itch.io API key in the Modules panel to continue.</div>
        </>
      ) : tab === "library" ? (
        <LibraryTab />
      ) : (
        <PublishTab />
      )}
    </div>
  );
}

const STORE_HELP =
  "Browsing reads itch.io's own public pages — no account needed, but it's unofficial and "
  + "itch.io rate-limits rapid repeated searches. Free items import straight into the project; "
  + "paid ones have to be bought on itch.io first.";

/**
 * Store discovery. Mode is derived rather than toggled: a query means search,
 * an empty query means browse the game-assets category by the active sort
 * chip (or a tag, which itch.io's URL scheme accepts instead of a sort, never
 * alongside it). One request per user action — see itchioStore.js on the rate
 * limit — so nothing here fires on keystroke.
 */
function StoreTab({ token }) {
  const hasProject = useProjectStore((state) => !!state.rootPath);
  const [sort, setSort] = useState("top-sellers");
  const [tag, setTag] = useState("");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(null); // the filter the current results came from
  const [items, setItems] = useState(null);
  const [nextPage, setNextPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);

  const fetchPage = (filter, page) =>
    filter.query ? searchStore(filter.query, page) : browseStore({ ...filter, page });

  const load = async (filter) => {
    setBusy(true);
    setError(null);
    setSelectedId(null);
    setActive(filter);
    try {
      const result = await fetchPage(filter, 1);
      setItems(result.items);
      setNextPage(result.nextPage);
    } catch (err) {
      setError(err.message ?? String(err));
      setItems([]);
    } finally {
      setBusy(false);
    }
  };

  // A store panel that opens empty is just a search box; one browse on mount
  // costs a single request and makes the tab useful immediately.
  useEffect(() => { load({ sort: "top-sellers", tag: "", query: "" }); }, []);

  const submit = (event) => {
    event.preventDefault();
    load({ sort, tag: tag.trim(), query: query.trim() });
  };

  const pickSort = (id) => {
    setSort(id);
    setQuery("");
    setTag("");
    load({ sort: id, tag: "", query: "" });
  };

  const loadMore = async () => {
    if (!nextPage || loadingMore || !active) return;
    setLoadingMore(true);
    setError(null);
    try {
      const result = await fetchPage(active, nextPage);
      setItems((current) => [...(current ?? []), ...result.items]);
      setNextPage(result.nextPage);
    } catch (err) {
      setError(err.message ?? String(err));
    } finally {
      setLoadingMore(false);
    }
  };

  const selected = (items ?? []).find((it) => it.id === selectedId) ?? null;
  const filtered = !!(active?.query || active?.tag);

  return (
    <div className="itchio-store">
      <form className="itchio-searchbar" onSubmit={submit}>
        <div className="ph-search">
          <Search size={13} />
          <input
            placeholder="Search the itch.io store…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="ph-search itchio-tagfield">
          <Hash size={13} />
          <input
            placeholder="tag"
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            title="Narrows to game assets with this itch.io tag, e.g. pixel-art"
          />
        </div>
        <button className="toolbar-btn" disabled={busy}>
          {busy ? <Loader2 size={13} className="ph-spin" /> : <Search size={13} />}
          {busy ? "Searching…" : "Search"}
        </button>
        <span className="itchio-help" title={STORE_HELP}><Info size={13} /></span>
      </form>

      <div className="itchio-chips">
        {STORE_SORTS.filter((s) => s.id).map((s) => (
          <button
            key={s.id}
            type="button"
            className={`itchio-chip${!filtered && sort === s.id ? " active" : ""}`}
            onClick={() => pickSort(s.id)}
          >
            {s.label}
          </button>
        ))}
        {filtered && (
          <span className="itchio-chip-note">
            {active.query ? `Results for "${active.query}"` : `Tagged "${active.tag}"`} — pick a
            chip to go back to browsing
          </span>
        )}
      </div>

      <div className="ph-body">
        <div className="ph-grid-scroll">
          {error && !items?.length ? (
            <div className="ph-status">{error}</div>
          ) : busy ? (
            <div className="ph-status"><Loader2 size={14} className="ph-spin" /> Searching itch.io…</div>
          ) : items === null ? null : items.length === 0 ? (
            <div className="ph-status">No results.</div>
          ) : (
            <>
              <div className="ph-grid itchio-grid">
                {items.map((it) => (
                  <button
                    type="button"
                    key={it.id}
                    className={`ph-tile itchio-tile${it.id === selectedId ? " active" : ""}`}
                    onClick={() => setSelectedId(it.id)}
                    title={it.title}
                  >
                    {it.coverUrl
                      ? <img src={it.coverUrl} loading="lazy" alt="" draggable={false} />
                      : <div className="sf-thumb-empty"><Store size={20} /></div>}
                    <span className={`itchio-price${it.isFree ? " free" : ""}`}>
                      {it.isFree ? "Free" : it.price}
                    </span>
                    <span className="itchio-tile-meta">
                      <span className="itchio-tile-name">{it.title}</span>
                      {it.author && <span className="itchio-tile-author">{it.author}</span>}
                    </span>
                  </button>
                ))}
              </div>
              {nextPage && (
                <button className="toolbar-btn wide ph-more" disabled={loadingMore} onClick={loadMore}>
                  {loadingMore ? <><Loader2 size={13} className="ph-spin" /> Loading…</> : "Load more"}
                </button>
              )}
              {error && <div className="ph-error sf-load-error">{error}</div>}
            </>
          )}
        </div>
        {selected && (
        <div className="ph-detail">
          <button className="ph-detail-close" onClick={() => setSelectedId(null)} title="Close">×</button>
          {selected.coverUrl && <img className="ph-detail-preview" src={selected.coverUrl} alt="" />}
          <div className="itchio-detail-head">
            <h3 className="ph-detail-name">{selected.title}</h3>
            <div className="ph-detail-meta">
              {selected.author && <span>by {selected.author}</span>}
            </div>
            <div className="itchio-detail-tags">
              <span className={`itchio-price${selected.isFree ? " free" : ""} inline`}>
                {selected.isFree ? "Free" : selected.price ?? "Paid"}
              </span>
              {selected.saleTag && <span className="itchio-price sale inline">{selected.saleTag}</span>}
            </div>
          </div>
          {selected.description && <p className="sf-description">{selected.description}</p>}
          {!token ? (
            <CredentialBanner>
              Connect your itch.io API key in the Modules panel to import free items from here
            </CredentialBanner>
          ) : !selected.gameId ? (
            <div className="ph-status">itch.io didn't tag this listing with a game id — open it on itch.io to download.</div>
          ) : (
            <StoreDownloads key={selected.id} item={selected} hasProject={hasProject} />
          )}
          <div className="ph-detail-actions">
            <button className="toolbar-btn wide" onClick={() => openStoreItem(selected).catch((err) => setError(String(err)))}>
              <ExternalLink size={13} /> Open on itch.io
            </button>
          </div>
          <div className="sf-license-note">
            itch.io exposes no license metadata — check the project page for the actual usage terms
            before shipping anything from here.
          </div>
        </div>
        )}
      </div>
    </div>
  );
}

/**
 * The store-side download list. Deliberately *asks* itch.io for the uploads
 * rather than deciding from the scraped price tag: `/games/{id}/uploads`
 * serves free games to any valid API key, and also serves paid games the
 * caller already bought, so itch.io's own answer covers cases the listing
 * markup can't distinguish (name-your-own-price, already-owned, on-sale-to-
 * free). A refusal is the paid-and-unowned case, and the only honest
 * response to that is to send the user to the purchase page.
 */
function StoreDownloads({ item, hasProject }) {
  const [uploads, setUploads] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    setUploads(null);
    setError(null);
    fetchUploads(item.gameId).then(
      (list) => alive && setUploads(list),
      (err) => alive && setError(err.message ?? String(err)),
    );
    return () => { alive = false; };
  }, [item.gameId]);

  if (error || (uploads && uploads.length === 0)) {
    return (
      <div className="ph-status">
        {item.isFree
          ? `itch.io won't serve this one's files (${error ?? "no downloads listed"}) — it may be browser-only or claim-gated. Open it on itch.io to grab it.`
          : "Paid item — buy it on itch.io and it'll show up in your Library tab, ready to import."}
      </div>
    );
  }
  if (uploads === null) {
    return <div className="ph-status"><Loader2 size={14} className="ph-spin" /> Checking downloads…</div>;
  }
  return (
    <>
      {!hasProject && <div className="ph-status">Open a project to download.</div>}
      <div className="itchio-upload-list">
        {uploads.map((upload) => (
          <UploadRow key={upload.id} game={item} upload={upload} hasProject={hasProject} />
        ))}
      </div>
    </>
  );
}

function LibraryTab() {
  const hasProject = useProjectStore((state) => !!state.rootPath);
  const [games, setGames] = useState(null);
  const [nextPage, setNextPage] = useState(1);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);

  useEffect(() => {
    let alive = true;
    setGames(null);
    setError(null);
    fetchLibrary(1).then(
      (result) => {
        if (!alive) return;
        setGames(result.games);
        setNextPage(result.nextPage);
      },
      (err) => alive && setError(err.message ?? String(err)),
    );
    return () => { alive = false; };
  }, []);

  const loadMore = async () => {
    if (!nextPage || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const result = await fetchLibrary(nextPage);
      setGames((current) => [...(current ?? []), ...result.games]);
      setNextPage(result.nextPage);
    } catch (err) {
      setError(err.message ?? String(err));
    } finally {
      setLoadingMore(false);
    }
  };

  const selected = (games ?? []).find((g) => `${g.id}-${g.downloadKeyId}` === selectedId) ?? null;

  return (
    <div className="ph-body">
      <div className="ph-grid-scroll">
        {error && !games ? (
          <div className="ph-status">Couldn't reach itch.io: {error}</div>
        ) : games === null ? (
          <div className="ph-status"><Loader2 size={14} className="ph-spin" /> Loading your library…</div>
        ) : games.length === 0 ? (
          <div className="ph-status">Nothing owned or purchased on this itch.io account yet.</div>
        ) : (
          <>
            <div className="ph-grid">
              {games.map((game) => {
                const id = `${game.id}-${game.downloadKeyId}`;
                return (
                  <div
                    key={id}
                    className={`ph-tile${id === selectedId ? " active" : ""}`}
                    onClick={() => setSelectedId(id)}
                    title={game.title}
                  >
                    {game.coverUrl
                      ? <img src={game.coverUrl} loading="lazy" alt={game.title} draggable={false} />
                      : <div className="sf-thumb-empty">🎮</div>}
                    <span className="ph-tile-name">{game.title}</span>
                  </div>
                );
              })}
            </div>
            {nextPage && (
              <button className="toolbar-btn wide ph-more" disabled={loadingMore} onClick={loadMore}>
                {loadingMore ? <><Loader2 size={13} className="ph-spin" /> Loading…</> : "Load more"}
              </button>
            )}
            {error && <div className="ph-error sf-load-error">{error}</div>}
          </>
        )}
      </div>
      {selected && (
        <GameUploads key={selectedId} game={selected} hasProject={hasProject} onClose={() => setSelectedId(null)} />
      )}
    </div>
  );
}

function GameUploads({ game, hasProject, onClose }) {
  const [uploads, setUploads] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    setUploads(null);
    setError(null);
    fetchUploads(game.id, game.downloadKeyId).then(
      (list) => alive && setUploads(list),
      (err) => alive && setError(err.message ?? String(err)),
    );
    return () => { alive = false; };
  }, [game.id, game.downloadKeyId]);

  return (
    <div className="ph-detail">
      <button className="ph-detail-close" onClick={onClose} title="Close">×</button>
      {game.coverUrl && <img className="ph-detail-preview" src={game.coverUrl} alt={game.title} />}
      <h3 className="ph-detail-name">{game.title}</h3>
      {game.author && <div className="ph-detail-meta"><span>by {game.author}</span></div>}
      {!hasProject && <div className="ph-status">Open a project to download.</div>}
      {error ? (
        <div className="ph-error">{error}</div>
      ) : uploads === null ? (
        <div className="ph-status"><Loader2 size={14} className="ph-spin" /> Loading files…</div>
      ) : uploads.length === 0 ? (
        <div className="ph-status">No downloadable files on this game.</div>
      ) : (
        <div className="itchio-upload-list">
          {uploads.map((upload) => (
            <UploadRow key={upload.id} game={game} upload={upload} hasProject={hasProject} />
          ))}
        </div>
      )}
      <div className="ph-detail-actions">
        <button className="toolbar-btn wide" onClick={() => openGamePage(game).catch((err) => setError(String(err)))}>
          <ExternalLink size={13} /> Open on itch.io
        </button>
      </div>
    </div>
  );
}

/** Human-readable upload size — itch.io reports raw bytes. */
function formatSize(bytes) {
  if (!bytes) return null;
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function UploadRow({ game, upload, hasProject }) {
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const run = async () => {
    setError(null);
    setResult(null);
    setProgress({ label: "Starting…" });
    try {
      const outcome = await downloadAndImport({ game, upload, downloadKeyId: game.downloadKeyId, onProgress: setProgress });
      setResult(outcome);
    } catch (err) {
      setError(err.message ?? String(err));
    } finally {
      setProgress(null);
    }
  };

  const size = formatSize(upload.size);
  return (
    <div className="itchio-upload-row">
      <div className="itchio-upload-info">
        <span className="itchio-upload-name" title={upload.displayName}>{upload.displayName}</span>
        {size && !progress && !result && <span className="itchio-upload-sub">{size}</span>}
        {progress && <span className="itchio-upload-sub">{progress.label}</span>}
        {result && (
          <span className="itchio-upload-sub done">
            {result.imported} imported{result.copied ? `, ${result.copied} copied` : ""}
            {result.skipped ? `, ${result.skipped} skipped` : ""}
          </span>
        )}
        {error && <span className="ph-error">{error}</span>}
      </div>
      <button
        className="toolbar-btn itchio-upload-btn"
        disabled={!hasProject || !!progress}
        onClick={run}
        title={result ? "Download and import again" : "Download and import into the project"}
      >
        {progress ? <Loader2 size={12} className="ph-spin" /> : <Download size={12} />}
        {result ? "Again" : "Import"}
      </button>
    </div>
  );
}

function PublishTab() {
  const hasProject = useProjectStore((state) => !!state.rootPath);
  const [games, setGames] = useState(null);
  const [error, setError] = useState(null);
  const [selectedId, setSelectedId] = useState("");
  const [busy, setBusy] = useState(null);
  const [done, setDone] = useState(null);

  useEffect(() => {
    let alive = true;
    setGames(null);
    setError(null);
    fetchMyGames().then(
      (list) => alive && setGames(list),
      (err) => alive && setError(err.message ?? String(err)),
    );
    return () => { alive = false; };
  }, []);

  const selected = (games ?? []).find((g) => String(g.id) === selectedId) ?? null;

  const runBuildAndOpen = async () => {
    setBusy("Building zip…");
    setDone(null);
    setError(null);
    try {
      const { exportGame } = await import("../exportGame.js");
      const { useProjectStore } = await import("../store/projectStore.js");
      const { invoke } = await import("@tauri-apps/api/core");
      const outDir = await invoke("prepare_browser_preview", {
        projectRoot: useProjectStore.getState().rootPath,
        purpose: "itchio-publish",
        fresh: true,
      });
      const report = await exportGame({
        outDir,
        onProgress: ({ message }) => setBusy(message),
        buildOverride: { target: "zip" },
      });
      if (!report.ok) {
        if (report.cancelled) return;
        throw new Error(report.error || "unknown build error");
      }
      const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
      await revealItemInDir(report.zipPath ?? report.outDir);
      if (selected) await openGameEditPage(selected);
      setDone(report.zipPath ?? report.outDir);
    } catch (err) {
      setError(err.message ?? String(err));
    } finally {
      setBusy(null);
    }
  };

  if (!hasProject) return <div className="ph-status">Open a project to publish.</div>;
  if (error && !games) return <div className="ph-status">Couldn't reach itch.io: {error}</div>;
  if (games === null) {
    return <div className="ph-status"><Loader2 size={14} className="ph-spin" /> Loading your games…</div>;
  }

  return (
    <div className="itchio-publish">
      <div className="itchio-card">
        <header className="itchio-card-head">
          <span className="itchio-card-icon"><UploadCloud size={17} /></span>
          <div>
            <h3>Publish to itch.io</h3>
            <p>Package the project as a web build and put it on your itch.io page.</p>
          </div>
        </header>

        <ol className="itchio-steps">
          <li className="itchio-step">
            <span className="itchio-step-num">1</span>
            <div className="itchio-step-body">
              <span className="itchio-step-title">Pick the game</span>
              {games.length === 0 ? (
                <>
                  <p className="itchio-step-note">No games on this itch.io account yet.</p>
                  <button className="toolbar-btn" onClick={() => openGameEditPage({}).catch(() => {})}>
                    <ExternalLink size={13} /> Create one on itch.io
                  </button>
                </>
              ) : (
                <select
                  className="text-field itchio-step-select"
                  value={selectedId}
                  onChange={(e) => setSelectedId(e.target.value)}
                >
                  <option value="">Choose a game you publish…</option>
                  {games.map((g) => (
                    <option key={g.id} value={g.id}>{g.title}</option>
                  ))}
                </select>
              )}
            </div>
          </li>

          <li className={`itchio-step${selected ? "" : " pending"}`}>
            <span className="itchio-step-num">2</span>
            <div className="itchio-step-body">
              <span className="itchio-step-title">Build &amp; upload</span>
              <p className="itchio-step-note">
                {selected
                  ? <>Builds the zip, shows it in your file manager, and opens <b>{selected.title}</b>'s
                    edit page — drop the zip into its Uploads section.</>
                  : "Choose a game above and this builds the zip, then opens its edit page for you."}
              </p>
              <button
                className="toolbar-btn itchio-primary-btn"
                disabled={!!busy || !selected}
                onClick={runBuildAndOpen}
              >
                {busy ? <Loader2 size={13} className="ph-spin" /> : <UploadCloud size={13} />}
                {busy ? busy : "Build zip & open itch.io"}
              </button>
              {done && (
                <div className="itchio-step-result">
                  <span className="ph-done">Zip ready</span>
                  <code title={done}>{done}</code>
                </div>
              )}
              {error && <div className="ph-error">{error}</div>}
            </div>
          </li>
        </ol>

        <p className="itchio-card-foot">
          itch.io has no public upload API — automated pushes need the <code>butler</code> CLI, so
          the last hop stays a manual drag for now.
        </p>
      </div>
    </div>
  );
}
