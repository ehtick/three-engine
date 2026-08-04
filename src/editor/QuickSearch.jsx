import { useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  ChevronDown,
  ChevronUp,
  CornerDownLeft,
  FileBox,
  PanelsTopLeft,
  Search,
  Settings2,
  X,
} from "lucide-react";
import { useProjectStore } from "./store/projectStore.js";
import { useSceneStore } from "./store/sceneStore.js";
import { useSelectionStore } from "./store/selectionStore.js";
import { listProjectEntries, withoutSidecars } from "./assetLoader.js";
import { openPanel } from "./EditorShell.jsx";
import { useAssetRevealStore } from "./assetReveal.js";

const PANELS = [
  ["viewport", "Viewport"], ["game", "Game"], ["hierarchy", "Hierarchy"],
  ["inspector", "Inspector"], ["assets", "Assets"], ["console", "Console"],
  ["shaderGraph", "Shader Graph"], ["particles", "Particles"], ["animator", "Animator"],
  ["timeline", "Timeline"], ["sceneSettings", "Scene Settings"],
  ["projectSettings", "Project Settings"], ["build", "Build"], ["modules", "Modules"],
  ["input", "Input"], ["geometryEditor", "Geometry Editor"], ["postprocess", "Post Process"],
  ["polyhaven", "Poly Haven"], ["ambientcg", "AmbientCG"], ["sketchfab", "Sketchfab"],
  ["terminal", "Terminal"], ["mcp", "Assistant (MCP)"],
];

const SETTINGS = [
  ["sceneSettings", "Scene Settings", ["Environment", "Background", "Ambient", "Intensity", "Cube Map", "Show as Sky", "Use for Lighting", "Fog", "Type", "Color", "Near", "Far", "Density", "Tone mapping", "Exposure", "Shadows", "Performance", "Max device pixel ratio", "Render scale", "Dynamic res", "Target FPS", "Volume quality", "Occlusion culling", "Renderer", "Antialias", "MSAA samples", "Transparent", "Shadow", "Map type"]],
  ["projectSettings", "Project Settings", ["Editor", "Autosave", "Snap move", "Snap rotate", "Snap scale", "Show grid", "Grid size", "Divisions", "Keybindings", "Scripts", "Hot reload", "Poll", "Performance", "Pixel ratio cap", "Game", "Title", "Main scene", "Saves", "Save id", "Save version", "Physics Layers"]],
];

const TYPE_WEIGHT = { entity: 0, asset: 1, panel: 2, setting: 3 };

function makeItem(type, title, subtitle, activate, keywords = "") {
  return { type, title, subtitle, activate, haystack: normalizeSearch(`${title} ${subtitle ?? ""} ${keywords}`) };
}

function normalizeSearch(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function score(item, query) {
  const q = normalizeSearch(query).trim();
  if (!q) return 0;
  const tokens = q.split(/\s+/).filter(Boolean);
  const phraseAt = item.haystack.indexOf(q);
  const tokenPositions = tokens.map((token) => item.haystack.indexOf(token));
  // Match the complete phrase when possible, but accept all query words in
  // any order too. This keeps "mcp" useful for "Assistant (MCP)" and makes
  // multi-word searches forgiving without scanning anything asynchronously.
  if (phraseAt < 0 && tokenPositions.some((position) => position < 0)) {
    const compactQuery = q.replace(/[^a-z0-9]/g, "");
    const compactHaystack = item.haystack.replace(/[^a-z0-9]/g, "");
    if (!compactQuery || !compactHaystack.includes(compactQuery)) return -1;
  }
  const title = normalizeSearch(item.title);
  const firstMatch = phraseAt >= 0
    ? phraseAt
    : Math.min(...tokenPositions.filter((position) => position >= 0), item.haystack.length);
  // Keep every valid match above zero. The position only affects ordering;
  // it must never make a later match disappear from the result list.
  return 1000
    + (title === q ? 1400 : 0)
    + (title.startsWith(q) ? 1000 : 0)
    + (phraseAt === 0 ? 500 : 0)
    + (tokens.length > 1 && tokenPositions.every((position) => position >= 0) ? 120 : 0)
    - firstMatch
    - TYPE_WEIGHT[item.type];
}

function ResultIcon({ type }) {
  const Icon = type === "entity" ? Box : type === "asset" ? FileBox : type === "panel" ? PanelsTopLeft : Settings2;
  return <Icon size={15} strokeWidth={1.8} aria-hidden="true" />;
}

export function QuickSearch() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [projectAssets, setProjectAssets] = useState([]);
  const inputRef = useRef(null);
  const rootPath = useProjectStore((s) => s.rootPath);
  const changeCounter = useProjectStore((s) => s.changeCounter);
  const entities = useSceneStore((s) => s.entities);

  useEffect(() => {
    const onKey = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
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
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  useEffect(() => {
    if (!open || !rootPath) return;
    let live = true;
    listProjectEntries(rootPath)
      .then((entries) => live && setProjectAssets(withoutSidecars(entries).filter((entry) => !entry.is_dir)))
      .catch(() => live && setProjectAssets([]));
    return () => { live = false; };
  }, [open, rootPath, changeCounter]);

  const allItems = useMemo(() => {
    const entityItems = Object.values(entities).map((entity) => makeItem(
      "entity", entity.name || entity.id, "Entity · Hierarchy",
      () => { useSelectionStore.getState().select(entity.id); openPanel("inspector"); },
      `${entity.id} ${entity.tags?.join(" ") ?? ""}`,
    ));
    const assetItems = projectAssets.map((entry) => makeItem(
      "asset", entry.name, `Asset · ${entry.path}`,
      async () => {
        const project = useProjectStore.getState();
        useSelectionStore.getState().selectAsset(entry.path);
        openPanel("assets");
        const dir = entry.path.replace(/[\\/][^\\/]+$/, "");
        if (dir && dir !== project.currentPath) await project.navigate(dir);
        useAssetRevealStore.getState().reveal(entry.path);
      },
      entry.path,
    ));
    const panelItems = PANELS.map(([id, title]) => makeItem("panel", title, "Panel", () => openPanel(id), id));
    const settingItems = SETTINGS.flatMap(([id, title, properties]) => properties.map((property) => makeItem("setting", property, `Settings · ${title}`, () => {
        openPanel(id);
        window.setTimeout(() => {
          const labels = [...document.querySelectorAll(".field-label, .section-header")];
          labels.find((label) => label.textContent.trim().toLocaleLowerCase().includes(property.toLocaleLowerCase()))?.scrollIntoView({ block: "center", behavior: "smooth" });
        }, 80);
      }, `${property} ${title}`)));
    return [...entityItems, ...assetItems, ...panelItems, ...settingItems];
  }, [entities, projectAssets]);

  const results = useMemo(() => {
    const q = query.trim();
    if (!q) return allItems.slice().sort((a, b) => TYPE_WEIGHT[a.type] - TYPE_WEIGHT[b.type] || a.title.localeCompare(b.title)).slice(0, 60);
    return allItems.map((item) => ({ item, rank: score(item, q) })).filter((x) => x.rank >= 0)
      .sort((a, b) => b.rank - a.rank || a.item.title.localeCompare(b.item.title)).slice(0, 60).map((x) => x.item);
  }, [allItems, query]);

  useEffect(() => setActive((value) => Math.min(value, Math.max(0, results.length - 1))), [results.length]);

  const choose = async (item) => {
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
            placeholder="Search assets, entities, panels, and settings…" autoComplete="off" />
          <button type="button" className="quick-search-close" onClick={() => setOpen(false)} aria-label="Close search"><X size={15} /></button>
        </div>
        <div className="quick-search-results">
          {results.length ? results.map((item, index) => (
            <button type="button" key={`${item.type}:${item.title}:${item.subtitle}`} className={`quick-search-result ${index === active ? "active" : ""}`}
              onMouseEnter={() => setActive(index)} onClick={() => choose(item)}>
              <span className={`quick-search-kind ${item.type}`}><ResultIcon type={item.type} /></span>
              <span className="quick-search-copy"><span className="quick-search-title">{item.title}</span><span className="quick-search-subtitle">{item.subtitle}</span></span>
              <span className="quick-search-enter"><CornerDownLeft size={13} /></span>
            </button>
          )) : <div className="quick-search-empty">No matching editor items</div>}
        </div>
        <div className="quick-search-footer">
          <span className="quick-search-result-count">{results.length ? `${results.length} result${results.length === 1 ? "" : "s"}` : "No results"}</span>
          <span className="quick-search-hint"><kbd><ChevronUp size={11} /><ChevronDown size={11} /></kbd> Navigate</span>
          <span className="quick-search-hint"><kbd><CornerDownLeft size={11} /></kbd> Open</span>
          <span className="quick-search-hint"><kbd>Esc</kbd> Close</span>
        </div>
      </div>
    </div>
  );
}
