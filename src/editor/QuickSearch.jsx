import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  ChevronDown,
  ChevronUp,
  CornerDownLeft,
  FileBox,
  History,
  PanelsTopLeft,
  Search,
  Settings2,
  X,
} from "./icons/index.jsx";
import { useProjectStore } from "./store/projectStore.js";
import { useSceneStore } from "./store/sceneStore.js";
import { useSelectionStore } from "./store/selectionStore.js";
import { listProjectEntries, withoutSidecars } from "./assetLoader.js";
import { openPanel } from "./EditorShell.jsx";
import { useAssetRevealStore } from "./assetReveal.js";
import { keyScopeOwns } from "./keyScope.js";
import { makeItem, score, TYPE_WEIGHT } from "./quickSearchRank.js";
import { parseQuery, nameMatches } from "./queryLang.js";
import { entityMatcher } from "./queryEvalEntity.js";
import { assetMatcher, queryNeeds } from "./queryEvalAsset.js";
import { candidateFromMirror, scopePool } from "./hierarchySearch.js";
import { getAssetMeta, ensureAssetMeta, useAssetMetaStore } from "./assetMetaIndex.js";
import { useSearchRecents, noteSearch, removeSearch, clearSearchRecents } from "./searchRecents.js";

const ENTITY_KEY_PREFIX = "entity:";
const ASSET_KEY_PREFIX = "asset:";

// The two additions to the result list have no stylesheet yet and this file is
// not the place to add one, so they carry their small amount of layout inline —
// the row itself reuses `.quick-search-result`, which is styled by class.
const GROUP_STYLE = {
  display: "flex", alignItems: "center", gap: 8, padding: "3px 9px 5px",
  color: "var(--text-dim)", fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase",
};
const GHOST_BUTTON_STYLE = {
  display: "grid", placeItems: "center", flex: "none", padding: 0,
  color: "var(--text-dim)", background: "transparent", border: 0, borderRadius: 5, cursor: "pointer",
};

const PANELS = [
  ["viewport", "Viewport"], ["game", "Game"], ["hierarchy", "Hierarchy"],
  ["inspector", "Inspector"], ["assets", "Assets"], ["console", "Console"],
  ["shaderGraph", "Shader Graph"], ["particles", "Particles"], ["vfx", "VFX"], ["animator", "Animator"],
  ["timeline", "Timeline"], ["sceneSettings", "Scene Settings"],
  ["projectSettings", "Project Settings"], ["build", "Build"], ["modules", "Modules"],
  ["input", "Input"], ["events", "Events"], ["eventGraph", "Event Graph"], ["geometryEditor", "Geometry Editor"], ["postprocess", "Post Process"],
  ["polyhaven", "Poly Haven"], ["ambientcg", "AmbientCG"], ["sketchfab", "Sketchfab"],
  ["polypizza", "Poly Pizza"], ["kaykit", "KayKit"], ["fab", "Fab"],
  ["itchio", "itch.io"], ["audioLibrary", "Audio Library"], ["audioEditor", "Audio Editor"],
  ["terminal", "Terminal"], ["mcp", "Assistant (MCP)"],
  // The panel id doubles as a search keyword (see `panelItems`), so "git"
  // finds this even though the panel is called Source Control.
  ["git", "Source Control"],
];

const SETTINGS = [
  ["sceneSettings", "Scene Settings", ["Environment", "Background", "Ambient", "Intensity", "Cube Map", "Show as Sky", "Use for Lighting", "Fog", "Type", "Color", "Near", "Far", "Density", "Tone mapping", "Exposure", "Shadows", "Performance", "Max device pixel ratio", "Render scale", "Dynamic res", "Target FPS", "Volume quality", "Occlusion culling", "Renderer", "Antialias", "MSAA samples", "Transparent", "Shadow", "Map type"]],
  ["projectSettings", "Project Settings", ["Editor", "Autosave", "Snap move", "Snap rotate", "Snap scale", "Show grid", "Grid size", "Divisions", "Keybindings", "Scripts", "Hot reload", "Poll", "Performance", "Pixel ratio cap", "Game", "Title", "Main scene", "Saves", "Save id", "Save version", "Physics Layers"]],
];

function ResultIcon({ type }) {
  const Icon = type === "entity" ? Box : type === "asset" ? FileBox : type === "panel" ? PanelsTopLeft : Settings2;
  return <Icon size={15} strokeWidth={1.8} aria-hidden="true" />;
}

export function QuickSearch() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // The Ctrl+F input is bound directly to `query` so every keystroke paints
  // immediately; the parsed query, the results memo, and the matcher closures
  // all consume `deferredQuery`, which React is allowed to lag behind by a
  // frame. Without this the synchronous `pool.filter(...)` over entities +
  // projectAssets freezes the box whenever the project is non-trivial.
  const deferredQuery = useDeferredValue(query);
  const [active, setActive] = useState(0);
  const [projectAssets, setProjectAssets] = useState([]);
  const inputRef = useRef(null);
  // Monotonic ticket for the asset-meta warm-up below (the AudioLibraryPanel
  // idiom): a slower earlier probe must never be mistaken for the newer one.
  const ticketRef = useRef(0);
  const rootPath = useProjectStore((s) => s.rootPath);
  const changeCounter = useProjectStore((s) => s.changeCounter);
  const entities = useSceneStore((s) => s.entities);
  const recents = useSearchRecents((s) => s.recents);
  // Property filters (`?width>1920`) read metadata that is probed a batch at a
  // time; `version` moves as batches land, and the results below read it so a
  // two-phase fill actually fills.
  const metaVersion = useAssetMetaStore((s) => s.version);
  // Parsed once per keystroke (parseQuery memoizes per raw string), so the
  // structured gate and the warm-up below share one parse.
  const parsed = useMemo(() => parseQuery(deferredQuery), [deferredQuery]);
  const needs = useMemo(() => queryNeeds(parsed), [parsed]);

  useEffect(() => {
    const onKey = (event) => {
      // Capture phase, so this has to check ownership itself: a code editor
      // claims Ctrl+F for its own find widget, and stealing it here meant the
      // widget could never be opened. Every other context lets it through.
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "f" &&
        !keyScopeOwns(event)
      ) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(true);
        setQuery("");
        setActive(0);
        requestAnimationFrame(() => inputRef.current?.focus());
      }
      if (!open) return;
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
      }
    };
    // The bar's search field asks for the same thing the shortcut does.
    const onOpenRequest = () => {
      setOpen(true);
      setQuery("");
      setActive(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("editor-quick-search", onOpenRequest);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("editor-quick-search", onOpenRequest);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !rootPath) return;
    let live = true;
    listProjectEntries(rootPath)
      .then((entries) => live && setProjectAssets(withoutSidecars(entries).filter((entry) => !entry.is_dir)))
      .catch(() => live && setProjectAssets([]));
    return () => { live = false; };
  }, [open, rootPath, changeCounter]);

  // Warm the metadata a structured query's filters need, BEFORE the results
  // memo asks for it: the first keystroke of `texture?width>1920` would
  // otherwise test every texture against a null meta and report "nothing
  // matches" until the probes happened to land. Only queries that actually
  // name a meta-dependent filter trigger probes, and the ticket drops the run
  // for a query the user has already left.
  useEffect(() => {
    if (!open || !projectAssets.length || (!needs.dims && !needs.material)) return;
    const ticket = ++ticketRef.current;
    ensureAssetMeta(projectAssets, needs, ticket).catch(() => {});
  }, [open, needs, projectAssets]);

  // Every `key` below has to be UNIQUE, and that is not a detail. The list used
  // to be keyed on `type:title:subtitle`, so a scene with two entities both
  // named "Light Stand" gave them the same key — and React's own warning says
  // the result is children "duplicated and/or omitted". That is exactly what it
  // did: rows from the PREVIOUS query survived reconciliation and sat above the
  // real match, while the footer count (read from the array, not the DOM)
  // correctly said "1 result".
  const { items: allItems, mirrorById, entryByPath } = useMemo(() => {
    const entityItems = Object.values(entities).map((entity) => makeItem({
      key: `${ENTITY_KEY_PREFIX}${entity.id}`,
      type: "entity",
      title: entity.name || entity.id,
      subtitle: "Entity · Hierarchy",
      // Tags are searchable; the id only as a WHOLE — see quickSearchRank.js.
      terms: entity.tags ?? [],
      exact: entity.id,
      activate: () => { useSelectionStore.getState().select(entity.id); openPanel("inspector"); },
    }));
    const assetItems = projectAssets.map((entry) => makeItem({
      key: `${ASSET_KEY_PREFIX}${entry.path}`,
      type: "asset",
      title: entry.name,
      subtitle: `Asset · ${entry.path}`,
      terms: [entry.path],
      activate: async () => {
        const project = useProjectStore.getState();
        openPanel("assets");
        const dir = entry.path.replace(/[\\/][^\\/]+$/, "");
        if (dir && dir !== project.currentPath) await project.navigate(dir);
        // Select AFTER navigating. Browsing to a folder clears the asset
        // selection (the old paths aren't on screen any more), so selecting
        // first left the tile revealed but unselected — and "press Enter to
        // open it" needs a visibly selected subject.
        useSelectionStore.getState().selectAsset(entry.path);
        useAssetRevealStore.getState().reveal(entry.path, { focus: true });
      },
    }));
    const panelItems = PANELS.map(([id, title]) => makeItem({
      key: `panel:${id}`,
      type: "panel",
      title,
      subtitle: "Panel",
      // The panel id doubles as a keyword, so "git" finds "Source Control".
      terms: [id],
      activate: () => openPanel(id),
    }));
    const settingItems = SETTINGS.flatMap(([id, title, properties]) => properties.map((property) => makeItem({
      key: `setting:${id}:${property}`,
      type: "setting",
      title: property,
      subtitle: `Settings · ${title}`,
      terms: [title],
      activate: () => {
        openPanel(id);
        window.setTimeout(() => {
          const labels = [...document.querySelectorAll(".field-label, .section-header")];
          labels.find((label) => label.textContent.trim().toLocaleLowerCase().includes(property.toLocaleLowerCase()))?.scrollIntoView({ block: "center", behavior: "smooth" });
        }, 80);
      },
    })));
    // The structured path re-derives the source of each row (an item only
    // carries its rendered text), so hand it two lookups beside the list.
    const mirrorById = new Map(Object.values(entities).map((entity) => [entity.id, entity]));
    const entryByPath = new Map(projectAssets.map((entry) => [entry.path, entry]));
    return {
      items: [...entityItems, ...assetItems, ...panelItems, ...settingItems],
      mirrorById,
      entryByPath,
    };
  }, [entities, projectAssets]);

  const results = useMemo(() => {
    const q = deferredQuery.trim();
    if (!q) {
      // Empty box: recent searches first — they are the fastest thing to want
      // and the only rows here that mean "run this query again". The browse
      // list keeps the rest of the budget, so the dialog still tops out at 60.
      const recentItems = recents.map((raw) => ({
        key: `recent:${raw}`,
        type: "recent",
        title: raw,
        subtitle: "Recent search · Enter runs it as typed",
        recentQuery: raw,
        // Never reached: `choose` routes a recent row to `runRecent`, which
        // fills the box instead of closing the dialog.
        activate: () => {},
        exact: null,
        fields: [],
      }));
      return [
        ...recentItems,
        ...allItems.slice().sort((a, b) => TYPE_WEIGHT[a.type] - TYPE_WEIGHT[b.type] || a.title.localeCompare(b.title))
          .slice(0, Math.max(0, 60 - recentItems.length)),
      ];
    }
    if (!parsed.structured) {
      // Plain text: today's ranking, untouched.
      return allItems.map((item) => ({ item, rank: score(item, q) })).filter((x) => x.rank >= 0)
        .sort((a, b) => b.rank - a.rank || a.item.title.localeCompare(b.item.title)).slice(0, 60).map((x) => x.item);
    }
    // Structured. The grammar is the GATE, `score` only the ORDER: a texture
    // named "brick_albedo.png" satisfies `texture?width>1920` through its kind
    // word, and score("texture") against that title is -1 — dropping negative
    // ranks here would discard exactly the matches the name half never
    // mentioned. So the pool below decides what is in the list and a -1 merely
    // sorts to the bottom of it.
    const matchEntity = entityMatcher(parsed);
    const matchAsset = assetMatcher(parsed, { getMeta: getAssetMeta });
    // `Mesh > light` is a question about the SCENE TREE, so a scoped query
    // drops the asset, panel and settings pools entirely rather than quietly
    // answering it with whatever happens to be named "light" on disk. The
    // entity pool narrows to the descendants scopePool returns — the same
    // function, and therefore the same meaning of "inside", the Hierarchy
    // panel and the MCP op use.
    const scoped = parsed.scopes.length
      ? scopePool(
          parsed,
          [...mirrorById.keys()],
          (id) => (mirrorById.has(id) ? candidateFromMirror(mirrorById.get(id)) : null),
          (id) => mirrorById.get(id)?.childIds ?? [],
        )
      : null;
    // Panels and settings have no properties to filter on, so a term with no
    // name half (`?enabled=false`) must not match them at all — "every name
    // matches" would flood the list with rows the filters cannot have chosen.
    const nameHalf = (title) => parsed.terms.every((term) => term.name.mode !== "none" && nameMatches(title, term.name));
    const pool = allItems.filter((item) => {
      if (item.type === "entity") {
        const id = item.key.slice(ENTITY_KEY_PREFIX.length);
        if (scoped && !scoped.has(id)) return false;
        const mirror = mirrorById.get(id);
        return mirror ? matchEntity(candidateFromMirror(mirror)) !== Infinity : false;
      }
      if (scoped) return false;
      if (item.type === "asset") {
        const entry = entryByPath.get(item.key.slice(ASSET_KEY_PREFIX.length));
        return entry ? matchAsset(entry) : false;
      }
      return nameHalf(item.title);
    });
    const firstName = parsed.terms[0]?.name.text || q;
    return pool
      .map((item) => ({ item, rank: score(item, firstName) }))
      .sort((a, b) => b.rank - a.rank || a.item.title.localeCompare(b.item.title))
      .slice(0, 60)
      .map((x) => x.item);
  }, [allItems, mirrorById, entryByPath, deferredQuery, parsed, recents, metaVersion]);

  useEffect(() => setActive((value) => Math.min(value, Math.max(0, results.length - 1))), [results.length]);

  // A recent row is a query, not a destination: it refills the box and stays
  // open, so the results it produces are already on screen.
  const runRecent = (raw) => {
    setQuery(raw);
    setActive(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const choose = async (item) => {
    if (item.type === "recent") { runRecent(item.recentQuery); return; }
    // A real activation is what makes a search "recent" — typing alone does
    // not, or every aborted half-query would push out the useful ones.
    if (query.trim()) noteSearch(query);
    setOpen(false);
    await item.activate();
  };

  if (!open) return null;
  return (
    <div className="quick-search-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="quick-search" role="dialog" aria-label="Quick search">
        <div className="quick-search-input-wrap">
          <Search size={17} />
          <input ref={inputRef} value={query} onChange={(e) => { setQuery(e.target.value); setActive(0); }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setActive((v) => Math.min(v + 1, results.length - 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setActive((v) => Math.max(v - 1, 0)); }
              else if (e.key === "Enter" && results[active]) { e.preventDefault(); choose(results[active]); }
              else if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
            }}
            placeholder="Search assets, entities, panels, and settings…"
            title={"Plain text searches everything. The query language narrows entities and assets:\nName:    Lamp... (starts with) \u00b7 ...Box (ends with) \u00b7 \"red lamp\" (quote spaces)\nFilter:  mesh.castShadow=true \u00b7 light.intensity>1 \u00b7 texture?width>1920\nHas:     M...?cloth \u00b7 ?collider \u00b7 ?!sound\nInside:  Mesh > light (scene tree only \u2014 assets and panels drop out)"}
            autoComplete="off" />
          <button type="button" className="quick-search-close" onClick={() => setOpen(false)} aria-label="Close search"><X size={15} /></button>
        </div>
        <div className="quick-search-results">
          {results.length ? (
            <>
              {!query.trim() && recents.length > 0 && (
                <div className="quick-search-group" style={GROUP_STYLE}>
                  <span>Recent searches</span>
                  <button type="button" style={{ ...GHOST_BUTTON_STYLE, marginLeft: "auto", padding: "2px 6px", fontSize: 10 }}
                    onClick={() => clearSearchRecents()}>Clear</button>
                </div>
              )}
              {results.map((item, index) => item.type === "recent" ? (
                // A div, not a button: the row carries two actions (run it and
                // forget it) and one interactive element cannot nest another.
                // `.quick-search-result` is styled by class, so it lays out the
                // same here.
                <div key={item.key} role="button" tabIndex={-1}
                  className={`quick-search-result ${index === active ? "active" : ""}`}
                  onMouseEnter={() => setActive(index)} onClick={() => choose(item)}>
                  <span className="quick-search-kind recent"><History size={15} strokeWidth={1.8} aria-hidden="true" /></span>
                  <span className="quick-search-copy"><span className="quick-search-title">{item.title}</span><span className="quick-search-subtitle">{item.subtitle}</span></span>
                  <button type="button" style={{ ...GHOST_BUTTON_STYLE, width: 22, height: 22 }} title="Forget this search"
                    aria-label={`Forget ${item.title}`}
                    onClick={(event) => { event.stopPropagation(); removeSearch(item.recentQuery); }}>
                    <X size={12} />
                  </button>
                  <span className="quick-search-enter"><CornerDownLeft size={13} /></span>
                </div>
              ) : (
                <button type="button" key={item.key} className={`quick-search-result ${index === active ? "active" : ""}`}
                  onMouseEnter={() => setActive(index)} onClick={() => choose(item)}>
                  <span className={`quick-search-kind ${item.type}`}><ResultIcon type={item.type} /></span>
                  <span className="quick-search-copy"><span className="quick-search-title">{item.title}</span><span className="quick-search-subtitle">{item.subtitle}</span></span>
                  <span className="quick-search-enter"><CornerDownLeft size={13} /></span>
                </button>
              ))}
            </>
          ) : <div className="quick-search-empty">No matching editor items</div>}
        </div>
      </div>
    </div>
  );
}
