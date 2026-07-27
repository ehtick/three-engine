import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, Search } from "lucide-react";
import { useProjectStore } from "../store/projectStore.js";
import { listProjectAssets, toBlobUrl, extOf, TEXTURE_EXTENSIONS, MATERIAL_EXTENSIONS } from "../assetLoader.js";
import { MATERIAL_DEFAULTS } from "../../engine/materialAsset.js";
import { useAssetDrop } from "../assetDrag.js";
import { revealAssetInPanel } from "../assetReveal.js";
import { PopoverMenu } from "./PopoverMenu.jsx";
import { ContextMenu, useContextMenu } from "../ContextMenu.jsx";
import { openAssetPath } from "../openAsset.js";
import { openPanel } from "../EditorShell.jsx";
import { useSelectionStore } from "../store/selectionStore.js";

const fileName = (p) => p?.split(/[\\/]/).pop() ?? "";

// Plain white on a swatch is the classic "I haven't set a color yet" signal —
// a freshly-created .mat file is white by default and looks identical to a mesh
// that has no material assigned at all. Flag it so the user can tell the
// difference at a glance.
const isUnsetColor = (color) => !color || color.toLowerCase() === "#ffffff" || color.toLowerCase() === "white";

function relativeToRoot(path) {
  const root = useProjectStore.getState().rootPath;
  if (!root) return path;
  const norm = (p) => p.replaceAll("\\", "/");
  const r = norm(root);
  const p = norm(path);
  return p.toLowerCase().startsWith(`${r.toLowerCase()}/`) ? p.slice(r.length + 1) : path;
}

/** Inline swatch/texture preview for .mat values and options. Reads the live
 *  shared material first so the swatch reflects the actual rendered color,
 *  not a stale top-level `def.color` from disk. */
function MaterialOptionThumb({ path }) {
  const [def, setDef] = useState(null);
  const [mapUrl, setMapUrl] = useState(null);
  const [liveColor, setLiveColor] = useState(null);
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const value = { ...MATERIAL_DEFAULTS, ...JSON.parse(await invoke("read_text_file", { path })) };
        if (!live) return;
        setDef(value);
        setMapUrl(value.map ? await toBlobUrl(value.map).catch(() => null) : null);
      } catch {
        if (live) setDef((prev) => prev ?? { ...MATERIAL_DEFAULTS, color: "#888" });
      }
    })();
    let unsub = () => {};
    import("../../engine/materialAsset.js").then(({ getMaterialColorPreview, loadMaterialAsset, subscribeMaterial }) => {
      if (!live) return;
      // Make sure the cache has an entry — the swatch may mount before any
      // mesh has loaded this .mat, and the live-color walk needs an entry.
      loadMaterialAsset(path).then(() => {
        if (!live) return;
        const refresh = () => {
          if (live) setLiveColor(getMaterialColorPreview(path));
        };
        refresh();
        unsub = subscribeMaterial(path, refresh);
      });
    });
    return () => {
      live = false;
      unsub();
    };
  }, [path]);
  const color = liveColor ?? def?.color;
  const unset = isUnsetColor(color);
  return (
    <div
      className={`asset-option-thumb mat-thumb${unset ? " mat-thumb--unset" : ""}`}
      style={{ background: color ?? "#888" }}
      title={unset ? "Default color — open in the Shader Graph panel to set a real color" : undefined}
    >
      {mapUrl && <img className="mat-thumb-map" src={mapUrl} alt="" draggable={false} />}
    </div>
  );
}
/** Small inline preview for texture options/values in asset pickers. */
function TextureOptionThumb({ path }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let live = true;
    if (TEXTURE_EXTENSIONS.includes(extOf(path))) {
      toBlobUrl(path).then((u) => live && setUrl(u)).catch(() => {});
    } else {
      setUrl(null);
    }
    return () => (live = false);
  }, [path]);
  if (!url) return null;
  return <img className="asset-option-thumb" src={url} alt="" draggable={false} />;
}

function OptionThumb({ path }) {
  return MATERIAL_EXTENSIONS.includes(extOf(path))
    ? <MaterialOptionThumb path={path} />
    : <TextureOptionThumb path={path} />;
}
/**
 * Asset reference input: drop target + picker listing project files of the
 * right type (descriptor.exts). Value is the asset's absolute path; commit ""
 * to clear.
 */
export function AssetField({ descriptor, value, onCommit }) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState(null);
  const [query, setQuery] = useState("");
  const triggerRef = useRef(null);

  const exts = descriptor.exts ?? [];
  const emptyLabel = descriptor.emptyLabel ?? "None";
  const showThumb = value && [...TEXTURE_EXTENSIONS, ...MATERIAL_EXTENSIONS].includes(extOf(value));

  const dropRef = useAssetDrop({ accepts: exts, onDrop: onCommit });
  // One element is both the drop target and the popover's anchor.
  const setTriggerRef = useCallback(
    (el) => {
      triggerRef.current = el;
      dropRef(el);
    },
    [dropRef],
  );

  const browse = async () => {
    // Clicking a filled slot also points the Assets panel at the file, so
    // "which material is this?" is answered without leaving the inspector.
    if (value) revealAssetInPanel(value).catch(() => {});
    setOpen(true);
    setOptions(null);
    setQuery("");
    const root = useProjectStore.getState().rootPath;
    setOptions(await listProjectAssets(root, exts));
  };

  // Left-click has to stay the picker (that's what the field is for), so
  // everything that acts on the asset ALREADY in the slot lives here. Without
  // it there is no way to say "show me this file" without also opening a
  // dropdown over the thing you wanted to look at.
  const { menu, open: openMenu, close: closeMenu } = useContextMenu();
  const menuItems = value
    ? [
        {
          label: "Show in Assets Panel",
          action: async () => {
            // Unlike the click-reveal, an explicit request opens the panel if
            // it's closed — the user asked for it by name.
            openPanel("assets");
            // Let Dockview mount/activate the panel before it is asked to
            // browse; revealing into a panel that doesn't exist yet is a no-op.
            await new Promise((resolve) => requestAnimationFrame(resolve));
            revealAssetInPanel(value).catch(() => {});
          },
        },
        { label: "Open", action: () => openAssetPath(value) },
        {
          label: "Select Asset",
          hint: "Show this asset's own import settings in the Inspector",
          action: () => useSelectionStore.getState().selectAsset(value),
        },
        { separator: true },
        { label: "Copy Path", action: () => navigator.clipboard.writeText(value).catch(() => {}) },
        { label: "Replace…", action: browse },
        { label: "Clear", danger: true, action: () => onCommit("") },
      ]
    : [{ label: "Browse…", action: browse }];

  // A project with forty materials makes an unfiltered picker a scroll hunt.
  // Matching on the full path (not just the filename) means the folder a user
  // organised by is also a way to find things: typing "props" narrows to
  // everything under Props/.
  const needle = query.trim().toLowerCase();
  const matches = needle
    ? (options ?? []).filter((path) => path.toLowerCase().includes(needle))
    : options;

  return (
    <div className="dropdown-wrap asset-field-wrap">
      <div
        className={`asset-field ${value ? "" : "empty"}`}
        title={value || `${emptyLabel} — drop an asset here or browse`}
        ref={setTriggerRef}
        onClick={browse}
        onContextMenu={openMenu}
      >
        {showThumb && <OptionThumb path={value} />}
        <span className="asset-field-name">{value ? fileName(value) : emptyLabel}</span>
        <span className="asset-field-caret">
          <ChevronDown size={12} />
        </span>
      </div>
      {open && (
        <PopoverMenu
          anchorRef={triggerRef}
          className="asset-options component-menu"
          minWidth={250}
          onClose={() => setOpen(false)}
        >
          <div className="component-menu-search">
            <Search size={12} />
            <input
              autoFocus
              type="text"
              placeholder="Search assets…"
              value={query}
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Escape") setOpen(false);
                else if (e.key === "Enter" && matches?.length) {
                  setOpen(false);
                  onCommit(matches[0]);
                }
              }}
            />
          </div>
          <div className="component-menu-list">
            <button
              className="dropdown-item"
              onClick={() => {
                setOpen(false);
                onCommit("");
              }}
            >
              {emptyLabel}
            </button>
            {options === null && <div className="dropdown-item">Loading…</div>}
            {matches?.map((path) => (
              <button
                key={path}
                className="dropdown-item asset-option"
                title={path}
                onClick={() => {
                  setOpen(false);
                  onCommit(path);
                }}
              >
                <OptionThumb path={path} />
                <span className="asset-option-name">{fileName(path)}</span>
                <span className="asset-option-path">{relativeToRoot(path)}</span>
              </button>
            ))}
            {matches?.length === 0 && (
              <div className="dropdown-item">{needle ? "No matches" : "No assets found"}</div>
            )}
          </div>
        </PopoverMenu>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={closeMenu} />}
    </div>
  );
}
