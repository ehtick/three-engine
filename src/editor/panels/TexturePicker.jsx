import { useEffect, useMemo, useRef, useState } from "react";
import { Image as ImageIcon, Search, X } from "lucide-react";
import { listProjectAssets, TEXTURE_EXTENSIONS, toBlobUrl } from "../assetLoader.js";
import { useProjectStore, basename } from "../store/projectStore.js";

/**
 * "Open a texture" — every image in the project as a thumbnail grid, filtered
 * as you type.
 *
 * The Assets panel can already do this, but reaching for it means leaving the
 * editor you are in, finding the file among scripts and materials and scenes,
 * and double-clicking it. A picker scoped to *textures* is one click from where
 * the question is asked, and it is the only affordance an empty texture editor
 * has: without it the panel is a blank rectangle with no way forward.
 *
 * Search matches the whole project-relative path, not just the file name, so
 * "hero idle" finds `Characters/Hero/idle.png` — folders carry most of the
 * meaning in an asset tree and matching only the basename throws that away.
 */
export function TexturePicker({ onPick, onCancel }) {
  const rootPath = useProjectStore((s) => s.rootPath);
  const [entries, setEntries] = useState(null); // null = loading
  const [query, setQuery] = useState("");
  const inputRef = useRef(null);

  useEffect(() => {
    let live = true;
    listProjectAssets(rootPath, TEXTURE_EXTENSIONS, 8)
      .then((found) => live && setEntries(found))
      .catch(() => live && setEntries([]));
    return () => {
      live = false;
    };
  }, [rootPath]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const relative = (path) =>
    String(path ?? "")
      .replaceAll("\\", "/")
      .replace(`${String(rootPath ?? "").replaceAll("\\", "/")}/`, "");

  const shown = useMemo(() => {
    const list = entries ?? [];
    const needle = query.trim().toLowerCase();
    if (!needle) return list;
    // Every whitespace-separated term must appear somewhere in the path, so
    // terms can be given in any order — "idle hero" and "hero idle" both work.
    const terms = needle.split(/\s+/);
    return list.filter((entry) => {
      const hay = relative(entry.path ?? entry).toLowerCase();
      return terms.every((term) => hay.includes(term));
    });
  }, [entries, query, rootPath]);

  return (
    <div className="texture-dialog-backdrop" onPointerDown={onCancel}>
      <div className="texture-dialog picker" onPointerDown={(e) => e.stopPropagation()}>
        <div className="picker-head">
          <Search size={13} />
          <input
            ref={inputRef}
            value={query}
            placeholder="Search textures…"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onCancel();
              // Enter opens the only remaining match — the natural end of a
              // search that has narrowed to one thing.
              if (e.key === "Enter" && shown.length === 1) onPick(shown[0].path ?? shown[0]);
            }}
          />
          {query && (
            <button className="tx-icon-btn" title="Clear" onClick={() => setQuery("")}>
              <X size={12} />
            </button>
          )}
          <span className="tx-count">{entries ? `${shown.length}` : "…"}</span>
        </div>

        {entries === null && <p className="tx-hint">Scanning the project…</p>}
        {entries !== null && shown.length === 0 && (
          <p className="tx-hint">
            {entries.length ? "No texture matches that." : "This project has no textures yet."}
          </p>
        )}

        <div className="picker-grid">
          {shown.map((entry) => {
            const path = entry.path ?? entry;
            return (
              <button key={path} className="picker-tile" title={relative(path)} onClick={() => onPick(path)}>
                <PickerThumb path={path} />
                <span className="picker-name">{basename(path)}</span>
              </button>
            );
          })}
        </div>

        <div className="texture-dialog-actions">
          <button className="tx-btn quiet" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/** Thumbnails load lazily and independently — a project with 400 textures must
 *  not block the grid on decoding all of them before showing anything. */
function PickerThumb({ path }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let live = true;
    toBlobUrl(path)
      .then((u) => live && setUrl(u))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [path]);
  if (!url) {
    return (
      <span className="picker-thumb empty">
        <ImageIcon size={18} />
      </span>
    );
  }
  return <img className="picker-thumb" src={url} alt="" draggable={false} />;
}
