import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, ExternalLink, Loader2, Music, Search, KeyRound } from "lucide-react";
import { useModulesStore, setModuleEnabled } from "../modules.js";
import { useProjectStore } from "../store/projectStore.js";
import { CREDENTIAL_CHANGED_EVENT } from "../credentialEvents.js";
import {
  PROVIDERS,
  SORTS,
  KINDS,
  search,
  importSound,
  getSavedToken,
  openApiKeyPage,
  openSourcePage,
  formatDuration,
  formatBytes,
  resolveArchiveFiles,
} from "../audioLibrary.js";
import { AudioScrubber } from "../components/AudioScrubber.jsx";
import { usePanelVisible } from "../usePanelVisible.js";

/**
 * The licence chip's colour is the whole message: green = take it and go,
 * amber = you owe a credit line, red = you cannot sell this. The words live in
 * the tooltip so the row stays one line instead of three stacked pills.
 */
/** Starting points, so an empty panel suggests rather than sits there. */
const FREESOUND_EXAMPLES = [
  "footsteps gravel", "sword impact", "door creak", "ui click",
  "explosion distant", "forest night", "rain on window", "sci-fi whoosh",
];
const COMMONS_EXAMPLES = ["rain", "birdsong", "city traffic", "thunder", "river", "wind"];

const licenceTone = (license) =>
  // "Unknown" is not the same claim as "non-commercial", and painting them the
  // same red is a lie in both directions: it condemns items that may be fine and
  // it makes the genuinely unshippable ones stop standing out. Most Internet
  // Archive items declare nothing, so this is the common case, not an edge one.
  license.id === "unknown" ? "unset" : !license.commercial ? "bad" : license.attribution ? "warn" : "good";

const licenceTitle = (license) =>
  license.id === "unknown"
    ? "No licence declared — check the source page before shipping this"
    : !license.commercial
      ? `${license.name} — cannot be used in anything you sell`
      : license.attribution
        ? `${license.name} — free to ship, but must be credited (recorded in Audio/CREDITS.md)`
        : `${license.name} — free to ship, no credit required`;

/**
 * Audio Library browser: search Freesound and Wikimedia Commons for game SFX
 * and ambience, audition results in place, and import the chosen sound into
 * `<project>/Audio/` with its licence recorded in `Audio/CREDITS.md`.
 *
 * Auditioning is why this is a list and not a thumbnail grid: the thing you're
 * choosing is a sound, so every row is a play button and a waveform, and only
 * one row plays at a time. Freesound's CDN serves previews and waveform images
 * without credentials, so both are plain `<audio>`/`<img>` sources; Commons has
 * no waveform image, so those rows draw a placeholder rather than shift layout.
 *
 * Gated on the `audio-library` module so projects opt in explicitly.
 */
export function AudioLibraryPanel({ api } = {}) {
  // Dockview leaves an inactive tab mounted; without this the panel keeps
  // searching and keeps every row subscribed to the audition player while
  // nobody can see it.
  const visible = usePanelVisible(api);
  const moduleOn = useModulesStore((s) => s.enabled.includes("audio-library"));
  const hasProject = useProjectStore((s) => !!s.rootPath);

  const [provider, setProvider] = useState("freesound");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("sfx");
  const [sort, setSort] = useState("relevance");
  const [cc0Only, setCc0Only] = useState(false);
  const [monoOnly, setMonoOnly] = useState(false);
  const [sfxOnly, setSfxOnly] = useState(true);

  const [items, setItems] = useState([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // The Modules panel owns the key, and dockview keeps this panel mounted while
  // it's on an inactive tab — so the key can change under a live panel and it
  // has to resync rather than stay stuck on "no key".
  const [hasKey, setHasKey] = useState(() => !!getSavedToken());
  useEffect(() => {
    const resync = () => setHasKey(!!getSavedToken());
    window.addEventListener(CREDENTIAL_CHANGED_EVENT, resync);
    return () => window.removeEventListener(CREDENTIAL_CHANGED_EVENT, resync);
  }, []);

  const needsKey = provider === "freesound" && !hasKey;
  const listRef = useRef(null);

  // Guards against a slower earlier search overwriting a newer one. Switching
  // to a tab fires a browse, typing immediately fires a narrower search, and
  // the browse — being the heavier query — can land second and replace the
  // results you asked for. The symptom is baffling: the box says "door" and the
  // list shows everything.
  const requestRef = useRef(0);

  // One request per settled user action, never per keystroke — Freesound
  // allows 60/minute and an undebounced search box eats that in seconds.
  const runSearch = useCallback(
    async (targetPage, { append }) => {
      const ticket = ++requestRef.current;
      setLoading(true);
      setError(null);
      try {
        const res = await search({ provider, query, page: targetPage, sort, kind, cc0Only, monoOnly, sfxOnly });
        if (ticket !== requestRef.current) return;
        setItems((prev) => (append ? [...prev, ...res.results] : res.results));
        setTotal(res.total);
        setHasMore(res.hasMore);
        setPage(targetPage);
      } catch (err) {
        if (ticket !== requestRef.current) return;
        setError(err.message ?? String(err));
        if (!append) setItems([]);
      } finally {
        if (ticket === requestRef.current) setLoading(false);
      }
    },
    [provider, query, sort, kind, cc0Only, monoOnly, sfxOnly],
  );

  // The Archive can browse without a query (its scope filter alone is a useful
  // shelf); Freesound and Commons cannot — an empty query there returns
  // hundreds of thousands of arbitrary results ranked by nothing, which looks
  // like the panel is broken. Show suggestions instead of noise.
  const canBrowseEmpty = provider === "archive";
  const idle = !query.trim() && !canBrowseEmpty;

  useEffect(() => {
    if (!moduleOn || needsKey || !visible) return;
    if (idle) {
      requestRef.current++;
      setItems([]);
      setTotal(null);
      setHasMore(false);
      setError(null);
      return;
    }
    let alive = true;
    const handle = setTimeout(() => {
      if (alive) {
        listRef.current?.scrollTo?.(0, 0);
        runSearch(1, { append: false });
      }
    }, 350);
    return () => {
      alive = false;
      clearTimeout(handle);
    };
  }, [moduleOn, needsKey, idle, visible, runSearch]);

  if (!moduleOn) {
    return (
      <div className="audiolib-panel">
        <div className="audiolib-gate">
          <Music size={28} />
          <h3>Audio Library</h3>
          <p>
            Search hundreds of thousands of free sound effects and ambiences from Freesound and
            Wikimedia Commons, audition them here, and import them straight into the project with
            their licences recorded. Enable the Audio Library module to get started.
          </p>
          <button className="toolbar-btn wide" onClick={() => setModuleEnabled("audio-library", true)}>
            Enable Audio Library module
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="audiolib-panel">
      <div className="audiolib-toolbar">
        <div className="audiolib-tabs" role="tablist">
          {PROVIDERS.map((p) => (
            <button
              key={p.id}
              role="tab"
              aria-selected={provider === p.id}
              className={`audiolib-tab${provider === p.id ? " active" : ""}`}
              onClick={() => setProvider(p.id)}
              title={p.blurb}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="audiolib-search">
          <Search size={13} />
          <input
            type="text"
            placeholder={provider === "freesound" ? "footsteps gravel, sword impact, forest…" : "rain, city, birdsong…"}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      <div className="audiolib-filters">
        {/* The Archive's index carries no durations, so a length filter there
            would be a control that silently does nothing — it's replaced by the
            scope toggle below, which is the filter that actually matters for it.
            Conditional render, NOT the `hidden` attribute: `.audiolib-kinds` sets
            `display:flex`, and a class selector beats the UA stylesheet's
            `[hidden]{display:none}`, so `hidden` renders nothing invisible. */}
        {provider !== "archive" && (
          <div className="audiolib-kinds">
            {KINDS.map((k) => (
              <button
                key={k.id}
                className={`audiolib-chip${kind === k.id ? " active" : ""}`}
                onClick={() => setKind(k.id)}
                title={k.hint}
              >
                {k.label}
              </button>
            ))}
          </div>
        )}
        {provider === "archive" && (
          <label
            className="audiolib-check"
            title="The Internet Archive is a general media archive. Without this, a search for 'footsteps' returns every sermon and radio play whose description mentions the word."
          >
            <input type="checkbox" checked={sfxOnly} onChange={(e) => setSfxOnly(e.target.checked)} />
            Sound effects only
          </label>
        )}
        <label className="audiolib-check" title="Public domain — no credit needed, no strings">
          <input type="checkbox" checked={cc0Only} onChange={(e) => setCc0Only(e.target.checked)} />
          CC0 only
        </label>
        {provider === "freesound" && (
          <label className="audiolib-check" title="Only mono files spatialise correctly on a 3D sound">
            <input type="checkbox" checked={monoOnly} onChange={(e) => setMonoOnly(e.target.checked)} />
            Mono
          </label>
        )}
        {provider === "freesound" && (
          <select className="audiolib-sort" value={sort} onChange={(e) => setSort(e.target.value)}>
            {SORTS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="audiolib-list" ref={listRef}>
        {needsKey ? (
          <div className="audiolib-gate inline">
            <KeyRound size={24} />
            <h3>Freesound needs a free API key</h3>
            <p>
              Register an application on Freesound to get one — it's instant, free, and needs no
              payment details. Paste the key into the Audio Library module in the Modules panel.
              Commons works with no key at all if you'd rather start there.
            </p>
            <button className="toolbar-btn wide" onClick={() => openApiKeyPage()}>
              <ExternalLink size={13} /> Get a Freesound API key
            </button>
          </div>
        ) : error ? (
          <div className="audiolib-status error">{error}</div>
        ) : loading && items.length === 0 ? (
          <div className="audiolib-status">
            <Loader2 size={14} className="audiolib-spin" /> Searching…
          </div>
        ) : idle ? (
          <div className="audiolib-suggest">
            <p>Search {PROVIDERS.find((p) => p.id === provider)?.label}, or start from one of these:</p>
            <div className="audiolib-suggest-chips">
              {(provider === "freesound" ? FREESOUND_EXAMPLES : COMMONS_EXAMPLES).map((example) => (
                <button key={example} className="audiolib-chip" onClick={() => setQuery(example)}>
                  {example}
                </button>
              ))}
            </div>
          </div>
        ) : items.length === 0 ? (
          <div className="audiolib-status">Nothing matched.</div>
        ) : (
          <>
            {total != null && (
              <div className="audiolib-count">
                {total.toLocaleString()} result{total === 1 ? "" : "s"}
              </div>
            )}
            {/* Rows are not rendered while the tab is hidden: each one holds an
                AudioScrubber subscribed to the shared player, and thirty of them
                ticking behind an inactive tab is pure waste. The results array
                is kept, so coming back is instant and nothing is re-fetched. */}
            {visible && items.map((item) => (
              <SoundRow key={item.key} item={item} hasProject={hasProject} />
            ))}
            {hasMore && (
              <button
                className="toolbar-btn wide audiolib-more"
                disabled={loading}
                onClick={() => runSearch(page + 1, { append: true })}
              >
                {loading ? <Loader2 size={13} className="audiolib-spin" /> : null}
                {loading ? "Loading…" : "Show more"}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function SoundRow({ item, hasProject }) {
  const [progress, setProgress] = useState(null);
  const [done, setDone] = useState(null);
  const [error, setError] = useState(null);
  const [playError, setPlayError] = useState(null);
  const busy = !!progress;

  // Only facts we actually have. A row of "—" placeholders for fields a
  // provider doesn't expose reads as broken data rather than as absent data.
  const meta = useMemo(() => {
    const bits = [];
    if (item.duration > 0) bits.push(formatDuration(item.duration));
    if (item.channels) bits.push(item.channels === 1 ? "mono" : `${item.channels}ch`);
    if (item.sampleRate) bits.push(`${Math.round(item.sampleRate / 1000)}k`);
    if (item.downloadBytes) bits.push(formatBytes(item.downloadBytes));
    if (item.downloads > 0) bits.push(`${item.downloads.toLocaleString()}↓`);
    return bits.join(" · ");
  }, [item]);

  // An Archive row is a whole item and doesn't know its audio URL until the
  // item's metadata is fetched — one request, on the first play, not thirty on
  // the first render.
  const resolveSrc = useMemo(
    () =>
      item.needsResolve
        ? async () => {
            const { files } = await resolveArchiveFiles(item.id);
            if (!files.length) throw new Error("This item has no playable audio.");
            return files[0].url;
          }
        : null,
    [item.needsResolve, item.id],
  );

  const runImport = async () => {
    setError(null);
    setDone(null);
    setProgress({ label: "Starting…" });
    try {
      const result = await importSound(item, { onProgress: setProgress });
      // An Archive result is a whole item, so say how many files landed — and
      // say so when some didn't, rather than reporting a partial import clean.
      setDone(
        result.files
          ? [
              `Imported ${result.files} file${result.files === 1 ? "" : "s"} (${formatBytes(result.bytes)})`,
              result.failed ? `${result.failed} failed` : null,
              result.skipped ? `${result.skipped} past the 200-file cap skipped` : null,
            ].filter(Boolean).join(" · ")
          : `Imported ${formatBytes(result.bytes)}`,
      );
      console.log(`Audio Library: imported "${item.name}" → ${result.path}`);
    } catch (err) {
      setError(err.message ?? String(err));
      console.error(`Audio Library import failed: ${err.message ?? err}`);
    } finally {
      setProgress(null);
    }
  };

  return (
    <div className="audiolib-row">
      <div className="audiolib-info">
        <div className="audiolib-name" title={item.name}>
          {item.name}
        </div>
        <div className="audiolib-meta">
          {item.author && <span className="audiolib-author">{item.author}</span>}
          {meta && <span>{meta}</span>}
        </div>
      </div>

      {/* The scrubber fills the space between the title and the licence — the
          dead gap the old layout left — and is the same control the Inspector
          uses, sharing one player so only one sound is ever heard at a time. */}
      <AudioScrubber
        id={item.key}
        src={item.previewUrl}
        resolveSrc={resolveSrc}
        waveformUrl={item.waveformUrl}
        duration={item.duration}
        variant="row"
        onError={setPlayError}
      />

      <span className={`audiolib-lic ${licenceTone(item.license)}`} title={licenceTitle(item.license)}>
        {item.license.name}
      </span>

      <div className="audiolib-actions">
        <button className="audiolib-icon-btn" onClick={() => openSourcePage(item)} title="Open the source page">
          <ExternalLink size={13} />
        </button>
        <button
          className="audiolib-icon-btn primary"
          onClick={runImport}
          disabled={!hasProject || busy}
          title={hasProject ? "Import into the project" : "Open a project to import"}
        >
          {busy ? <Loader2 size={13} className="audiolib-spin" /> : <Download size={13} />}
        </button>
      </div>

      {(busy || done || error || playError) && (
        <div className={`audiolib-rowmsg${error || playError ? " bad" : done ? " good" : ""}`}>
          {error ?? playError ?? (busy ? progress.label : done)}
        </div>
      )}
    </div>
  );
}
