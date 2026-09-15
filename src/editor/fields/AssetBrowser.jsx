import { useDeferredValue, useEffect, useState } from "react";
import { Search, X } from "../icons/index.jsx";
import { isBuiltinMaterial, WATER_MATERIAL_PATH } from "../../engine/builtinMaterials.js";
import { useProjectStore } from "../store/projectStore.js";
import { listProjectAssets } from "../assetLoader.js";
import { samePath } from "../assetReveal.js";
import { thumbKind } from "../assetThumbs.js";
import { iconForPath } from "../assetIcons.js";
import { AssetThumb } from "../components/AssetThumb.jsx";
import { PopoverMenu } from "./PopoverMenu.jsx";

const fileName = (p) => String(p ?? "").split(/[\\/]/).pop() ?? "";

function relativeToRoot(path) {
  const root = useProjectStore.getState().rootPath;
  if (!root) return path;
  const norm = (p) => p.replaceAll("\\", "/");
  const r = norm(root);
  const p = norm(path);
  return p.toLowerCase().startsWith(`${r.toLowerCase()}/`) ? p.slice(r.length + 1) : path;
}

/** A tile's picture: the rendered preview when the asset has one, else its glyph. */
export function AssetPicture({ path, glyphSize = 26 }) {
  if (path && thumbKind(path)) return <AssetThumb path={path} fill className="asset-picture-img" />;
  const Icon = iconForPath(path);
  return <Icon className="asset-picture-glyph" size={glyphSize} strokeWidth={1.5} aria-hidden="true" />;
}

/**
 * The picker behind every asset field: a grid of previews of every project
 * asset of the wanted types, a search box, "none" first. Replaces the old
 * dropdown list — a material or a mesh is chosen by what it looks like, and
 * a name in a list said nothing about that.
 */
export function AssetBrowser({ anchorRef, exts, value, emptyLabel = "None", layer = null, onPick, onClose }) {
  const [options, setOptions] = useState(null);
  const [query, setQuery] = useState("");
  // The asset search input binds to `query` so every keystroke paints
  // immediately; the full-path substring filter over `options` consumes
  // `deferredQuery`. A material slot in a heavy project can list thousands
  // of textures, and the picker can be re-opened many times per inspector.
  // Enter-to-pick still reads `query` so picking the highlighted match on a
  // partially-typed input never loses the just-typed character.
  const deferredQuery = useDeferredValue(query);
  const rootPath = useProjectStore((s) => s.rootPath);

  useEffect(() => {
    let live = true;
    setOptions(null);
    const wanted = exts ?? [];
    listProjectAssets(rootPath, wanted, 8)
      .then((found) => {
        if (!live) return;
        setOptions([...(wanted.includes("mat") ? [WATER_MATERIAL_PATH] : []), ...found]);
      })
      .catch(() => live && setOptions([]));
    return () => {
      live = false;
    };
  }, [rootPath, exts]);

  // Matching on the whole project-relative path, not only the name: the
  // folder someone organised by is also a way to find things.
  const needle = deferredQuery.trim().toLowerCase();
  const matches = needle ? (options ?? []).filter((path) => path.toLowerCase().includes(needle)) : options;
  const nameOf = (path) => (isBuiltinMaterial(path) ? "Water (built-in)" : fileName(path));

  return (
    <PopoverMenu anchorRef={anchorRef} className="asset-browser" minWidth={352} layer={layer} onClose={onClose}>
      <label className="asset-browser-search">
        <Search size={12} aria-hidden="true" />
        <input
          autoFocus
          type="text"
          placeholder="Search"
          aria-label="Search assets"
          value={query}
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") onClose();
            else if (e.key === "Enter" && matches?.length) onPick(matches[0]);
          }}
        />
      </label>
      <div className="asset-browser-grid" role="listbox">
        <button
          type="button"
          role="option"
          aria-selected={!value}
          className={`asset-browser-tile none${value ? "" : " current"}`}
          title={emptyLabel}
          onClick={() => onPick("")}
        >
          <div className="asset-browser-preview">
            <X size={20} strokeWidth={1.5} aria-hidden="true" />
          </div>
          <span className="asset-browser-name">{emptyLabel}</span>
        </button>
        {matches?.map((path) => {
          const current = !!value && samePath(path, value);
          return (
            <button
              key={path}
              type="button"
              role="option"
              aria-selected={current}
              className={`asset-browser-tile${current ? " current" : ""}`}
              title={relativeToRoot(path)}
              onClick={() => onPick(path)}
            >
              <div className="asset-browser-preview">
                <AssetPicture path={path} />
              </div>
              <span className="asset-browser-name">{nameOf(path)}</span>
            </button>
          );
        })}
      </div>
      {options === null && <div className="asset-browser-note">Loading…</div>}
      {matches?.length === 0 && <div className="asset-browser-note">{needle ? "No matches" : "No assets of this type"}</div>}
    </PopoverMenu>
  );
}
