import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  Box,
  Braces,
  ChevronDown,
  Download,
  EyeOff,
  File,
  FileCode2,
  Folder,
  FolderOpen,
  FolderPlus,
  Grid2x2,
  Globe,
  Grid3x3,
  Image,
  Layers,
  LayoutGrid,
  List,
  Package,
  Palette,
  PanelLeft,
  Search,
  Shapes,
  Tag,
  Target,
  Trash2,
  Volume2,
  Workflow,
  Film,
  X,
} from "lucide-react";
import { useProjectStore, basename } from "../store/projectStore.js";
import { useSelectionStore } from "../store/selectionStore.js";
import { useAssetProcessingStore } from "../store/assetProcessingStore.js";
import {
  extOf,
  toBlobUrl,
  readAssetMeta,
  listProjectEntries,
  withoutSidecars,
  onAssetInvalidated,
  MODEL_EXTENSIONS,
  MODEL_IMPORT_EXTENSIONS,
  TEXTURE_EXTENSIONS,
  SCRIPT_EXTENSIONS,
  MATERIAL_EXTENSIONS,
  CUBEMAP_EXTENSIONS,
  PREFAB_EXTENSIONS,
  ANIMATOR_EXTENSIONS,
  GEOMETRY_EXTENSIONS,
} from "../assetLoader.js";
import { MATERIAL_DEFAULTS } from "../../engine/materialAsset.js";
import { createDefaultTimeline } from "../../engine/timeline/timelineAsset.js";
import {
  CUBEMAP_DEFAULTS,
  CUBEMAP_FACES,
  guessCubemapFaces,
  normalizeCubemapDef,
} from "../../engine/cubemapAsset.js";
import { armAssetDrag, useAssetDrop, consumeAssetDragClick } from "../assetDrag.js";
import { createScriptFile } from "../scriptAsset.js";
import { openInIDE } from "../openInIde.js";
import { scaffoldProjectTypes } from "../projectTypes.js";
import { FolderTree } from "../components/FolderTree.jsx";
import { clickSelect, pathsInBox } from "../assetSelection.js";
import {
  invoke,
  createAssetFile,
  createFolder,
  deleteEntries,
  renameEntry,
  moveDraggedIntoFolder,
  groupIntoFolder,
  formatBytes,
  formatDate,
} from "../assetOps.js";
import { ASSET_TYPES, assetType, filterEntries } from "../assetFilter.js";
import { loadAssetFlags, setAssetFlags, useAssetFlagsStore } from "../assetFlags.js";
import { collectUsedAssets } from "../assetUsage.js";
import { samePath, useAssetRevealStore } from "../assetReveal.js";
import { openAssetPath } from "../openAsset.js";
import {
  PACK_ATLAS_EVENT,
  consumePackAtlasRequest,
  requestNewTexture,
  requestPackAtlas,
} from "../textureEditorRequest.js";
import { PackAtlasDialog } from "./TextureOps.jsx";
import { buildAtlasFromImages } from "../atlasFile.js";
import { ContextMenu, isTextEditTarget } from "../ContextMenu.jsx";
import { requestGeometryThumb } from "../geometryThumb.js";

const ICON_BY_EXT = {
  glb: Box,
  gltf: Box,
  fbx: Box,
  scene: Layers,
  json: Braces,
  js: FileCode2,
  ts: FileCode2,
  mat: Palette,
  cubemap: Globe,
  png: Image,
  jpg: Image,
  jpeg: Image,
  webp: Image,
  prefab: Package,
  entity: Package, // legacy prefab snapshots
  anim: Workflow,
  geom: Shapes,
  timeline: Film,
};

const TYPE_LABEL = {
  glb: "Model",
  gltf: "Model",
  fbx: "FBX source",
  scene: "Scene",
  json: "JSON",
  js: "Script",
  ts: "Script",
  mat: "Material",
  cubemap: "Cube Map",
  png: "Texture",
  jpg: "Texture",
  jpeg: "Texture",
  webp: "Texture",
  entity: "Prefab",
  anim: "Animator",
  geom: "Geometry",
  timeline: "Timeline",
};

/**
 * Grid density / detail presets, mirroring Explorer's view menu. `thumb` is the
 * preview size in px; the details view lays entries out as rows with metadata
 * columns instead of tiles.
 */
const VIEW_MODES = [
  { id: "details", title: "Details", Icon: List, thumb: 18 },
  { id: "small", title: "Small icons", Icon: Grid3x3, thumb: 24 },
  { id: "medium", title: "Medium icons", Icon: Grid2x2, thumb: 40 },
  { id: "large", title: "Large icons", Icon: LayoutGrid, thumb: 72 },
];

const VIEW_KEY = "engine.assets.viewMode.v1";
const TREE_KEY = "engine.assets.showTree.v1";

/** New Script lands in the folder the user is browsing (the inspector's
 *  inline version writes to `<root>/scripts` instead — see scriptAsset.js). */
const createScript = () =>
  createScriptFile({ directory: useProjectStore.getState().currentPath });
const createMaterial = () =>
  createAssetFile("NewMaterial.mat", JSON.stringify(MATERIAL_DEFAULTS, null, 2));

/** Empty six-face cube map; faces are assigned in the asset inspector. */
const createCubemap = (faces = null) =>
  createAssetFile(
    "NewCubemap.cubemap",
    JSON.stringify(faces ? { ...CUBEMAP_DEFAULTS, faces } : CUBEMAP_DEFAULTS, null, 2),
  );

/** "New Cube Map from Selection": fills the slots by filename convention
 *  (px/nx/…, posx/negx/…, right/left/top/…) so a downloaded 6-file skybox
 *  becomes a usable asset in one step. Unmatched slots stay empty. */
const createCubemapFromTextures = (paths) => createCubemap(guessCubemapFaces(paths));

const ANIMATOR_TEMPLATE = {
  version: 1,
  parameters: [],
  states: [{ id: "state-idle", name: "Idle", clip: "", speed: 1, loop: true, x: 260, y: 140 }],
  entry: "state-idle",
  transitions: [],
};
const createAnimator = () =>
  createAssetFile("NewAnimator.anim", JSON.stringify(ANIMATOR_TEMPLATE, null, 2));

const createSequence = () =>
  createAssetFile("NewTimeline.timeline", JSON.stringify(createDefaultTimeline(), null, 2));

/** A new image is not a JSON template — it needs a size and a background, and
 *  those live in the Texture Editor's own dialog so there is one place that
 *  knows how to make one. */
const createTexture = () => {
  requestNewTexture();
  import("../EditorShell.jsx").then((m) => m.openPanel("textureEditor"));
};

/** Texture image thumbnail (blob URL over Tauri fs). */
function TextureThumb({ path, size }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let live = true;
    toBlobUrl(path).then((u) => live && setUrl(u)).catch(() => {});
    return () => (live = false);
  }, [path]);
  if (!url)
    return (
      <div className="asset-icon" style={{ width: size, height: size }}>
        <Image size={size * 0.65} strokeWidth={1.5} />
      </div>
    );
  return (
    <img
      className="asset-thumb"
      style={{ width: size, height: size }}
      src={url}
      alt=""
      draggable={false}
    />
  );
}

// Plain white on a swatch is the classic "I haven't set a color yet" signal —
// a freshly-created .mat file is white by default and looks identical to a mesh
// that has no material assigned at all. Flag it so the user can tell the
// difference at a glance.
const isUnsetColor = (color) => !color || color.toLowerCase() === "#ffffff" || color.toLowerCase() === "white";

/** Material preview: color swatch, with its texture blended in when set.
 *  Reads the live shared material first (via getMaterialColorPreview) so the
 *  swatch reflects what the mesh actually renders — including edits made in
 *  the Shader Graph panel that haven't been autosaved yet, and pre-existing
 *  .mat files whose top-level `color` field is stale. Falls back to the
 *  top-level `def.color` only when no live material is loaded. */
function MaterialThumb({ path, size }) {
  const [def, setDef] = useState(null);
  const [mapUrl, setMapUrl] = useState(null);
  const [liveColor, setLiveColor] = useState(null);
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const d = { ...MATERIAL_DEFAULTS, ...JSON.parse(await invoke("read_text_file", { path })) };
        if (!live) return;
        setDef(d);
        if (d.map) setMapUrl(await toBlobUrl(d.map).catch(() => null));
      } catch {
        if (live) setDef((prev) => prev ?? { ...MATERIAL_DEFAULTS, color: "#888" });
      }
    })();
    // Subscribe to live material updates so the swatch refreshes as soon as
    // the shared material instance finishes its async compile / ShaderGraph
    // edit. Resolves to `null` until the compile lands.
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
  // Live color wins over the stale top-level field — that's the whole point.
  const color = liveColor ?? def?.color;
  const unset = isUnsetColor(color);
  return (
    <div
      className={`asset-thumb mat-thumb${unset ? " mat-thumb--unset" : ""}`}
      style={{ width: size, height: size, background: color ?? "#888" }}
      title={unset ? "Default color — open in the Shader Graph panel to set a real color" : undefined}
    >
      {mapUrl && <img className="mat-thumb-map" src={mapUrl} alt="" draggable={false} />}
    </div>
  );
}

/** Geometry preview: offscreen lit mesh snapshot (shared renderer + cache).
 *  Below ~32px the silhouette is unreadable, so details/small views keep the
 *  type icon and skip the GPU work. */
function GeometryThumb({ path, size }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    if (size < 32) {
      setUrl(null);
      return;
    }
    let live = true;
    let gen = 0;
    setUrl(null);
    const load = () => {
      const my = ++gen;
      requestGeometryThumb(path)
        .then((next) => {
          if (live && my === gen) setUrl(next);
        })
        .catch(() => {
          if (live && my === gen) setUrl(null);
        });
    };
    load();
    const unsub = onAssetInvalidated((changed) => {
      if (!samePath(changed, path)) return;
      if (live) setUrl(null);
      load();
    });
    return () => {
      live = false;
      unsub();
    };
  }, [path, size]);
  if (!url) {
    return (
      <div className="asset-icon" style={{ width: size, height: size }}>
        <Shapes size={size * 0.65} strokeWidth={1.5} />
      </div>
    );
  }
  return (
    <img
      className="asset-thumb geom-thumb"
      style={{ width: size, height: size }}
      src={url}
      alt=""
      draggable={false}
    />
  );
}

/** Cube map preview: its +Z face (or the first assigned one) with a cube badge,
 *  so an incomplete asset is visibly different from a finished one. */
function CubemapThumb({ path, size }) {
  const [state, setState] = useState(null); // { url, complete } | null
  useEffect(() => {
    let live = true;
    setState(null);
    (async () => {
      try {
        const def = normalizeCubemapDef(JSON.parse(await invoke("read_text_file", { path })));
        const assigned = CUBEMAP_FACES.map((face) => def.faces[face.key]).filter(Boolean);
        const front = def.faces.pz || assigned[0] || "";
        const url = front ? await toBlobUrl(front).catch(() => null) : null;
        if (live) setState({ url, complete: assigned.length === CUBEMAP_FACES.length });
      } catch {
        if (live) setState({ url: null, complete: false });
      }
    })();
    return () => (live = false);
  }, [path]);
  return (
    <div
      className={`asset-icon cubemap-thumb${state && !state.complete ? " cubemap-thumb--incomplete" : ""}`}
      style={{ width: size, height: size }}
      title={state && !state.complete ? "Incomplete cube map — assign all six faces" : undefined}
    >
      {state?.url ? (
        <img src={state.url} alt="" draggable={false} style={{ width: size, height: size }} />
      ) : (
        <Globe size={size * 0.65} strokeWidth={1.5} />
      )}
    </div>
  );
}

function Thumb({ entry, size }) {
  if (entry.is_dir)
    return (
      <div className="asset-icon dir-icon" style={{ width: size, height: size }}>
        <Folder size={size * 0.72} strokeWidth={1.5} />
      </div>
    );
  if (TEXTURE_EXTENSIONS.includes(entry.ext)) return <TextureThumb path={entry.path} size={size} />;
  if (entry.ext === "mat") return <MaterialThumb path={entry.path} size={size} />;
  if (entry.ext === "cubemap") return <CubemapThumb path={entry.path} size={size} />;
  if (entry.ext === "geom") return <GeometryThumb path={entry.path} size={size} />;
  const Icon = ICON_BY_EXT[entry.ext] ?? File;
  return (
    <div className="asset-icon" style={{ width: size, height: size }}>
      <Icon size={size * 0.65} strokeWidth={1.5} />
    </div>
  );
}

/** Corner badge on a model tile showing how much Draco compression saved. */
function DracoBadge({ path }) {
  const [pct, setPct] = useState(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      const meta = await readAssetMeta(`${path}.meta`);
      const d = meta?.draco;
      if (!alive || !d?.original || !d?.compressed) return;
      const saved = 1 - d.compressed / d.original;
      setPct(saved > 0.005 ? Math.round(saved * 100) : 0);
    })();
    return () => {
      alive = false;
    };
  }, [path]);
  if (pct == null) return null;
  return (
    <div className="asset-badge draco-badge" title={`Draco compressed · ${pct}% smaller`}>
      −{pct}%
    </div>
  );
}

const DRAGGABLE_EXTENSIONS = [
  ...MODEL_EXTENSIONS,
  ...TEXTURE_EXTENSIONS,
  ...SCRIPT_EXTENSIONS,
  ...MATERIAL_EXTENSIONS,
  ...CUBEMAP_EXTENSIONS,
  ...PREFAB_EXTENSIONS,
  ...ANIMATOR_EXTENSIONS,
  ...GEOMETRY_EXTENSIONS,
];

const openEntry = (entry) => openAssetPath(entry.path, { isDir: entry.is_dir });

function RenameInput({ entry, setRenamingPath }) {
  const commit = (value) => {
    setRenamingPath(null);
    renameEntry(entry, value);
  };
  return (
    <input
      className="rename-input asset-rename"
      autoFocus
      defaultValue={entry.name}
      onFocus={(e) => e.target.select()}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") commit(e.target.value);
        if (e.key === "Escape") setRenamingPath(null);
      }}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    />
  );
}

/**
 * Corner badges for the build flags. Excluded assets read as dimmed with a
 * struck-through eye; preloaded ones get a download arrow. Both are visible at
 * a glance from the grid, which is the point — build behaviour you can only
 * discover by clicking each asset in turn isn't discoverable at all.
 */
function FlagBadges({ path }) {
  const flags = useAssetFlagsStore((s) => s.flags[path]);
  if (!flags?.preload && !flags?.exclude) return null;
  return (
    <div className="asset-flag-badges">
      {flags.exclude && (
        <span className="asset-flag-badge exclude" title="Excluded from game builds">
          <EyeOff size={9} />
        </span>
      )}
      {flags.preload && (
        <span className="asset-flag-badge preload" title="Loaded during the preload phase">
          <Download size={9} />
        </span>
      )}
    </div>
  );
}

function AssetItem({ entry, view, visible, renaming, setRenamingPath, onContextMenu, subtitle }) {
  const draggable = entry.is_dir || DRAGGABLE_EXTENSIONS.includes(entry.ext);
  const selected = useSelectionStore((s) => s.assetPaths.includes(entry.path));
  // "Revealed" is the inspector pointing at this file (see assetReveal.js) —
  // a highlight, not a selection, so the entity stays selected behind it.
  const revealed = useAssetRevealStore((s) => samePath(s.path, entry.path));
  const excluded = useAssetFlagsStore((s) => s.flags[entry.path]?.exclude === true);
  const tags = useAssetFlagsStore((s) => s.flags[entry.path]?.tags);
  const details = view.id === "details";

  // Folders accept asset drops (move into folder).
  const dropRef = useAssetDrop({
    accepts: (path) => path !== entry.path,
    hoverClass: "drop-target",
    onDrop: (path) => moveDraggedIntoFolder(path, entry.path),
  });

  const handlers = {
    "data-asset-path": entry.path,
    ref: entry.is_dir ? dropRef : undefined,
    onPointerDown: (e) => {
      // Selecting on pointerdown (not click) so a drag that starts on an
      // unselected tile carries that tile, and a drag on a multi-selection
      // keeps it intact.
      if (renaming || e.target.closest("input") || e.button !== 0) return;
      // Any real click supersedes an inspector reveal.
      useAssetRevealStore.getState().clear();
      const sel = useSelectionStore.getState();
      const inSelection = sel.assetPaths.includes(entry.path);
      if (!inSelection || e.shiftKey || e.ctrlKey || e.metaKey) clickSelect(e, entry, visible);
      if (draggable) armAssetDrag(e, entry.path, { isDir: entry.is_dir });
    },
    onClick: (e) => {
      if (consumeAssetDragClick()) return;
      // A plain click on an already-multi-selected tile collapses the
      // selection to it (Explorer behaviour) — pointerdown left it alone so
      // the drag could carry the whole set.
      const sel = useSelectionStore.getState();
      if (!e.shiftKey && !e.ctrlKey && !e.metaKey && sel.assetPaths.length > 1) {
        sel.selectAsset(entry.path);
      }
    },
    onDoubleClick: () => openEntry(entry),
    onContextMenu: (e) => onContextMenu(e, entry),
    title: entry.name,
  };

  if (details) {
    return (
      <div
        className={`asset-row ${selected ? "selected" : ""} ${revealed ? "revealed" : ""} ${excluded ? "excluded" : ""}`}
        {...handlers}
      >
        <div className="asset-row-name">
          <Thumb entry={entry} size={view.thumb} />
          {renaming ? (
            <RenameInput entry={entry} setRenamingPath={setRenamingPath} />
          ) : (
            <>
              <span className="asset-row-label">{entry.name}</span>
              {subtitle && <span className="asset-row-path">{subtitle}</span>}
              {tags?.length > 0 && (
                <span className="asset-row-tags" title={tags.join(", ")}>
                  <Tag size={9} />
                  {tags.join(", ")}
                </span>
              )}
            </>
          )}
        </div>
        <div className="asset-col">{entry.is_dir ? "Folder" : (TYPE_LABEL[entry.ext] ?? entry.ext.toUpperCase())}</div>
        <div className="asset-col">{entry.is_dir ? "—" : formatBytes(entry.size)}</div>
        <div className="asset-col">{formatDate(entry.modified)}</div>
      </div>
    );
  }

  return (
    <div
      className={`asset-tile ${entry.is_dir ? "dir" : ""} ${selected ? "selected" : ""} ${revealed ? "revealed" : ""} ${excluded ? "excluded" : ""}`}
      {...handlers}
    >
      <Thumb entry={entry} size={view.thumb} />
      {entry.ext === "glb" && <DracoBadge path={entry.path} />}
      <FlagBadges path={entry.path} />
      {renaming ? (
        <RenameInput entry={entry} setRenamingPath={setRenamingPath} />
      ) : (
        <>
          <div className="asset-name">{entry.name}</div>
          {subtitle && <div className="asset-subpath">{subtitle}</div>}
        </>
      )}
    </div>
  );
}

function AssetContextMenu({ menu, close, setRenamingPath, selectedEntries }) {
  const entry = menu.entry;
  // Right-clicking inside a multi-selection acts on the whole set.
  const multi = entry && selectedEntries.length > 1 && selectedEntries.some((s) => s.path === entry.path);
  const targets = multi ? selectedEntries : entry ? [entry] : [];

  // Six selected face textures are one "New Cube Map from Selection" away from
  // a usable skybox — offer it whenever the selection is all textures.
  const textureTargets = targets.filter((t) => !t.is_dir && TEXTURE_EXTENSIONS.includes(t.ext));
  const canMakeCubemap = targets.length > 1 && textureTargets.length === targets.length;

  // Build flags act on files; a folder has nothing of its own to ship.
  const fileTargets = targets.filter((target) => !target.is_dir);
  const flagsOf = (target) => useAssetFlagsStore.getState().flags[target.path] ?? {};
  const allPreload = fileTargets.length > 0 && fileTargets.every((t) => flagsOf(t).preload);
  const allExclude = fileTargets.length > 0 && fileTargets.every((t) => flagsOf(t).exclude);

  const items = entry
    ? [
        // "Open" first: it's what a double-click does, and a menu that doesn't
        // offer the primary action reads as incomplete.
        !multi && { label: "Open", action: () => openEntry(entry) },
        !multi && !entry.is_dir && {
          label: "Copy Path",
          action: () => navigator.clipboard.writeText(entry.path).catch(() => {}),
        },
        { separator: true },
        ...(multi
          ? []
          : [{ label: "Rename", action: () => setRenamingPath(entry.path) }]),
        {
          label: multi ? `Group ${targets.length} into Folder` : "Group into Folder",
          shortcut: "Ctrl+G",
          action: () => groupIntoFolder(targets),
        },
        ...(fileTargets.length
          ? [
              {
                label: allPreload ? "Don't Preload" : "Preload",
                hint: "Load during the boot phase so it's ready before the first frame",
                action: () => setAssetFlags(fileTargets.map((t) => t.path), { preload: !allPreload }),
              },
              {
                label: allExclude ? "Include in Builds" : "Exclude from Builds",
                hint: "Keep the file in the project but leave it out of exported games",
                action: () => setAssetFlags(fileTargets.map((t) => t.path), { exclude: !allExclude }),
              },
            ]
          : []),
        ...(canMakeCubemap
          ? [
              {
                label: "New Cube Map from Selection",
                action: () => createCubemapFromTextures(textureTargets.map((t) => t.path)),
              },
            ]
          : []),
        ...(!multi && !entry.is_dir && TEXTURE_EXTENSIONS.includes(entry.ext)
          ? [{ label: "Edit Texture", action: () => openAssetPath(entry.path) }]
          : []),
        ...(textureTargets.length > 1 && textureTargets.length === targets.length
          ? [
              {
                label: `Pack ${textureTargets.length} into Atlas…`,
                hint: "One sheet plus a .atlas naming each region after its file",
                action: () => requestPackAtlas(textureTargets.map((t) => t.path)),
              },
            ]
          : []),
        ...(!multi && MODEL_IMPORT_EXTENSIONS.includes(entry.ext)
          ? [
              { label: "Unpack Model", action: () => unpackModel(entry.path) },
              ...(entry.ext === "glb"
                ? [{ label: "Compress (Draco)", action: () => compressModel(entry.path) }]
                : []),
            ]
          : []),
        ...(!multi && !entry.is_dir
          ? [{ label: "Open in Default App", action: () => openInIDE(entry.path) }]
          : []),
        { separator: true },
        {
          label: multi ? `Delete ${targets.length} items` : "Delete",
          shortcut: "Del",
          danger: true,
          action: () => deleteEntries(targets),
        },
      ]
    : [
        { header: "Create" },
        { label: "New Folder", action: createFolder },
        { label: "New Script", action: createScript },
        { label: "New Material", action: createMaterial },
        { label: "New Texture", action: createTexture },
        { label: "New Cube Map", action: () => createCubemap() },
        { label: "New Animator", action: createAnimator },
        { label: "New Timeline", action: createSequence },
        { separator: true },
        { label: "Refresh", action: () => useProjectStore.getState().refresh() },
      ];

  return <ContextMenu x={menu.x} y={menu.y} items={items} onClose={close} />;
}

/** Copies OS-dropped files into the folder currently open in the panel. */
async function importDroppedPaths(paths) {
  const { currentPath, refresh } = useProjectStore.getState();
  if (!currentPath || !paths?.length) return;
  const track = useAssetProcessingStore.getState().track;
  await track(
    (n) => `Importing ${n} ${n === 1 ? "asset" : "assets"}…`,
    async () => {
      try {
        const imported = await invoke("import_files", { paths, destDir: currentPath });
        await refresh();
        console.log(`Imported ${imported.length} ${imported.length === 1 ? "asset" : "assets"}`);
        // Imported models unpack into an asset folder (textures/materials/prefab).
        for (const path of imported) {
          if (MODEL_IMPORT_EXTENSIONS.includes(extOf(path))) await unpackModel(path);
          if (TEXTURE_EXTENSIONS.includes(extOf(path))) {
            const { autoCompressTexture } = await import("../basisCompress.js");
            await autoCompressTexture(path).catch((err) =>
              console.warn(`Basis compression skipped for ${basename(path)}: ${err.message ?? err}`),
            );
          }
        }
      } catch (err) {
        console.error(`Import failed: ${err}`);
      }
    },
    paths.length,
  );
}

async function unpackModel(path) {
  try {
    if (extOf(path) === "fbx") {
      const { unpackFbx } = await import("../fbxImport.js");
      await unpackFbx(path);
    } else {
      const { unpackGlb } = await import("../glbImport.js");
      await unpackGlb(path);
    }
  } catch (err) {
    console.error(`Unpack failed for ${basename(path)}: ${err.message ?? err}`);
  }
}

/** Manually Draco-compresses a .glb in place (context menu). */
async function compressModel(path) {
  try {
    const { compressGlbInPlace, formatBytes: fmt } = await import("../dracoCompress.js");
    const info = await compressGlbInPlace(path);
    if (info == null) {
      console.log(`${basename(path)} is already Draco-compressed`);
    } else if (info.compressed < info.original) {
      const pct = Math.round((1 - info.compressed / info.original) * 100);
      console.log(`Draco: ${basename(path)} −${pct}% (${fmt(info.original)} → ${fmt(info.compressed)})`);
    } else {
      console.log(`Draco: ${basename(path)} already minimal — left uncompressed`);
    }
    await useProjectStore.getState().refresh();
  } catch (err) {
    console.error(`Compression failed for ${basename(path)}: ${err.message ?? err}`);
  }
}

/**
 * Rubber-band selection over the asset grid. Returns the marquee rectangle to
 * draw (in grid-content coordinates) plus the pointerdown handler that starts
 * a drag. Tiles are hit-tested through their `data-asset-path` attribute, so
 * this works identically for the tile grid and the details rows.
 */
function useBoxSelect(gridRef) {
  const [box, setBox] = useState(null); // {left, top, width, height} in content coords

  const onPointerDown = (e) => {
    const grid = gridRef.current;
    if (!grid || e.button !== 0) return;
    // Only empty space starts a marquee — tiles handle their own pointerdown.
    if (e.target.closest("[data-asset-path]")) return;

    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    const base = additive ? useSelectionStore.getState().assetPaths : [];
    if (!additive) useSelectionStore.getState().clear();

    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;

    const onMove = (ev) => {
      const rect = grid.getBoundingClientRect();
      if (!dragging) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
        dragging = true;
      }
      const view = {
        left: Math.min(startX, ev.clientX),
        right: Math.max(startX, ev.clientX),
        top: Math.min(startY, ev.clientY),
        bottom: Math.max(startY, ev.clientY),
      };
      const hits = pathsInBox(
        view,
        [...grid.querySelectorAll("[data-asset-path]")].map((el) => [
          el.dataset.assetPath,
          el.getBoundingClientRect(),
        ]),
      );
      useSelectionStore.getState().selectAssets([...base, ...hits], { anchor: hits[0] ?? base[0] });

      setBox({
        left: view.left - rect.left + grid.scrollLeft,
        top: view.top - rect.top + grid.scrollTop,
        width: view.right - view.left,
        height: view.bottom - view.top,
      });
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setBox(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return { box, onPointerDown };
}

export function AssetsPanel() {
  const rootPath = useProjectStore((s) => s.rootPath);
  const currentPath = useProjectStore((s) => s.currentPath);
  const entries = useProjectStore((s) => s.entries);
  const loading = useProjectStore((s) => s.loading);
  const error = useProjectStore((s) => s.error);
  const assetPaths = useSelectionStore((s) => s.assetPaths);
  const [renamingPath, setRenamingPath] = useState(null);
  const [contextMenu, setContextMenu] = useState(null); // {x, y, entry|null}
  const [packPaths, setPackPaths] = useState(null); // pending "Pack into Atlas"
  const [fileDropActive, setFileDropActive] = useState(false);
  const [viewId, setViewId] = useState(() => localStorage.getItem(VIEW_KEY) ?? "medium");
  const [showTree, setShowTree] = useState(() => localStorage.getItem(TREE_KEY) !== "0");
  const [query, setQuery] = useState("");
  const [typeId, setTypeId] = useState("all");
  const [typeMenuOpen, setTypeMenuOpen] = useState(false);
  const [usedOnly, setUsedOnly] = useState(false);
  const [usedPaths, setUsedPaths] = useState(null); // Set of normalised paths
  const [projectEntries, setProjectEntries] = useState(null); // whole-project search pool
  const [scanning, setScanning] = useState(false);
  const selectedEntityIds = useSelectionStore((s) => s.ids);
  // Tag edits change what a tag: query matches, so re-filter when they land.
  const flagVersion = useAssetFlagsStore((s) => s.flags);
  const panelRef = useRef(null);
  const gridRef = useRef(null);

  // "Pack into Atlas" is raised by the context menu, which unmounts the instant
  // it is clicked — so the request travels here, where the dialog can outlive it.
  useEffect(() => {
    const open = () => {
      const pending = consumePackAtlasRequest();
      if (pending?.length) setPackPaths(pending);
    };
    window.addEventListener(PACK_ATLAS_EVENT, open);
    return () => window.removeEventListener(PACK_ATLAS_EVENT, open);
  }, []);

  const view = VIEW_MODES.find((v) => v.id === viewId) ?? VIEW_MODES[2];
  // A search or a "used by selection" filter is a question about the project,
  // not about the folder that happens to be open — so both widen the pool to
  // every asset and show where each hit lives.
  const searching = query.trim().length > 0 || usedOnly || typeId !== "all";
  // An empty scan means it failed, not that the project is empty — a project
  // with an open folder always has at least that folder's contents. Falling
  // back to the folder listing keeps a failed scan showing *something*
  // filterable instead of a blank grid that reads as "no matches".
  const projectWide = searching && projectEntries !== null && projectEntries.length > 0;

  // Generated sidecars are managed through their source asset, not shown as
  // tiles — but the raw listing (which has them) is what the flag loader needs.
  const folderEntries = useMemo(() => withoutSidecars(entries), [entries]);
  const projectAssets = useMemo(
    () => (projectEntries ? withoutSidecars(projectEntries) : null),
    [projectEntries],
  );
  const pool = projectWide ? projectAssets : folderEntries;
  const visible = useMemo(
    () => (searching ? filterEntries(pool, { typeId, query, usedPaths: usedOnly ? usedPaths : null }) : pool),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pool, searching, typeId, query, usedOnly, usedPaths, flagVersion],
  );
  const selectedEntries = useMemo(
    () => visible.filter((e) => assetPaths.includes(e.path)),
    [visible, assetPaths],
  );
  const activeType = assetType(typeId);
  const filtersActive = query.trim().length > 0 || typeId !== "all" || usedOnly;

  const clearFilters = () => {
    setQuery("");
    setTypeId("all");
    setUsedOnly(false);
  };

  /** Folder of an entry, relative to the project root — the search subtitle. */
  const relativeFolder = (entry) => {
    if (!projectWide || !rootPath) return null;
    const dir = entry.path.slice(0, entry.path.length - entry.name.length - 1);
    const rel = dir.slice(rootPath.length + 1).replaceAll("\\", "/");
    return rel || basename(rootPath);
  };

  // Load the whole-project pool the first time a filter is switched on, and
  // refresh it whenever the project tree changes underneath us.
  const changeCounter = useProjectStore((s) => s.changeCounter);
  useEffect(() => {
    if (!searching || !rootPath) return;
    let live = true;
    setScanning(true);
    listProjectEntries(rootPath)
      .then((all) => {
        if (!live) return;
        setProjectEntries(all);
        return loadAssetFlags(all);
      })
      .catch((err) => console.warn(`Asset scan failed: ${err}`))
      .finally(() => live && setScanning(false));
    return () => {
      live = false;
    };
  }, [searching, rootPath, changeCounter]);

  // Which assets the selected entities reference. Recomputed on selection
  // change so the filter tracks what the user is looking at in the viewport.
  useEffect(() => {
    if (!usedOnly) return;
    let live = true;
    collectUsedAssets(selectedEntityIds)
      .then((paths) => live && setUsedPaths(paths))
      .catch((err) => console.warn(`Couldn't resolve used assets: ${err}`));
    return () => {
      live = false;
    };
  }, [usedOnly, selectedEntityIds]);

  // Build flags for whatever is on screen, so badges render without each tile
  // doing its own read. Feeds the RAW listing — the `.meta` entries in it are
  // how the loader knows which assets have a sidecar to open.
  useEffect(() => {
    if (entries.length) loadAssetFlags(entries).catch(() => {});
  }, [entries]);

  const { box, onPointerDown: onGridPointerDown } = useBoxSelect(gridRef);

  const setView = (id) => {
    setViewId(id);
    localStorage.setItem(VIEW_KEY, id);
  };
  const toggleTree = () => {
    setShowTree((prev) => {
      localStorage.setItem(TREE_KEY, prev ? "0" : "1");
      return !prev;
    });
  };

  // Drop an asset on the "Up" button: move it into the parent folder.
  const upDropRef = useAssetDrop({
    accepts: () => currentPath !== rootPath,
    onDrop: (path) => {
      const parent = currentPath.replace(/[\\/][^\\/]+$/, "");
      moveDraggedIntoFolder(path, parent || rootPath);
    },
  });

  useEffect(() => {
    if (!rootPath) useProjectStore.getState().restoreLastFolder();
  }, [rootPath]);

  // Leaving a folder drops its selection — the paths aren't on screen any more.
  // Only the asset half: the entity selection is not this panel's to discard.
  useEffect(() => {
    useSelectionStore.getState().clearAssets();
    setRenamingPath(null);
  }, [currentPath]);

  // Scroll to whatever the inspector last pointed at. Keyed on the token (not
  // the path) so clicking the same field twice re-scrolls; keyed on `visible`
  // too because the reveal usually arrives one folder-listing before the tile
  // it wants exists. A filter that hides the tile is cleared first — otherwise
  // "reveal" silently does nothing.
  const revealToken = useAssetRevealStore((s) => s.token);
  const revealPath = useAssetRevealStore((s) => s.path);
  useEffect(() => {
    if (!revealPath) return;
    if (filtersActive && !visible.some((entry) => samePath(entry.path, revealPath))) {
      clearFilters();
      return;
    }
    const match = visible.find((entry) => samePath(entry.path, revealPath));
    if (!match) return;
    const el = gridRef.current?.querySelector(`[data-asset-path="${CSS.escape(match.path)}"]`);
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealToken, revealPath, visible]);

  // Ensure the engine's .d.ts files are present in the project root so the
  // user's IDE provides `this.entity` / `this.engine` autocomplete when they
  // open a script. Idempotent — only writes files that are missing or stale.
  // Runs on every Assets-panel mount so newly-opened projects (and ones
  // opened before the bootstrap was added) get up to date types.
  useEffect(() => {
    if (!rootPath) return;
    scaffoldProjectTypes(rootPath).catch((err) => {
      console.warn(`Could not scaffold engine types into ${rootPath}: ${err}`);
    });
  }, [rootPath]);

  // OS-file drag-drop import. Tauri intercepts native file drags (HTML5 drop
  // events never fire for them), so listen to the webview's drag-drop event
  // and hit-test its position against this panel.
  useEffect(() => {
    let unlisten = null;
    let disposed = false;

    const overPanel = (position) => {
      const el = panelRef.current;
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const scale = window.devicePixelRatio || 1;
      const x = position.x / scale;
      const y = position.y / scale;
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    };

    (async () => {
      try {
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        const stop = await getCurrentWebview().onDragDropEvent((event) => {
          const { type } = event.payload;
          if (type === "over") {
            setFileDropActive(overPanel(event.payload.position));
          } else if (type === "drop") {
            setFileDropActive(false);
            if (overPanel(event.payload.position)) importDroppedPaths(event.payload.paths);
          } else {
            setFileDropActive(false);
          }
        });
        if (disposed) stop();
        else unlisten = stop;
      } catch (err) {
        console.warn(`File-drop listener unavailable: ${err}`);
      }
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  if (!rootPath) {
    return (
      <div className="assets-panel empty">
        <div>
          No project folder open.
          <br />
          <button className="toolbar-btn" onClick={() => useProjectStore.getState().openFolder()}>
            Open Folder…
          </button>
        </div>
      </div>
    );
  }

  const onTileContextMenu = (e, entry) => {
    // A tile mid-rename is a text field; let the edit menu win.
    if (isTextEditTarget(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    // Right-clicking outside the selection reselects the clicked entry, so the
    // menu always acts on what's highlighted.
    if (entry && !useSelectionStore.getState().assetPaths.includes(entry.path)) {
      useSelectionStore.getState().selectAsset(entry.path);
    }
    setContextMenu({ x: e.clientX, y: e.clientY, entry });
  };

  // Grid keyboard shortcuts. The grid is focusable, so these only fire while
  // the Assets panel has focus and never steal Delete from the viewport.
  const onGridKeyDown = (e) => {
    if (e.target.closest("input")) return;
    const sel = useSelectionStore.getState();
    if (e.key === "Delete" && sel.assetPaths.length) {
      e.preventDefault();
      e.stopPropagation();
      deleteEntries(visible.filter((v) => sel.assetPaths.includes(v.path)));
    } else if (e.key === "F2" && sel.assetPath) {
      e.preventDefault();
      setRenamingPath(sel.assetPath);
    } else if (e.key === "Escape") {
      sel.clear();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      sel.selectAssets(visible.map((v) => v.path));
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "g" && sel.assetPaths.length) {
      // Ctrl+G — same gesture the hierarchy uses to group entities.
      e.preventDefault();
      e.stopPropagation();
      const targets = visible.filter((v) => sel.assetPaths.includes(v.path));
      groupIntoFolder(targets).then((path) => path && setRenamingPath(path));
    }
  };

  return (
    <div className={`assets-panel ${fileDropActive ? "file-drop" : ""}`} ref={panelRef}>
      <div className="panel-toolbar">
        <button
          className={`toolbar-btn icon-only ${showTree ? "active" : ""}`}
          title="Toggle folder tree"
          onClick={toggleTree}
        >
          <PanelLeft size={14} />
        </button>
        <button
          className="toolbar-btn icon-only"
          title="Up one folder"
          disabled={currentPath === rootPath}
          onClick={() => useProjectStore.getState().goUp()}
          ref={upDropRef}
        >
          <ArrowUp size={14} />
        </button>
        <span className="asset-path" title={currentPath}>
          {currentPath === rootPath ? basename(rootPath) : currentPath?.slice(rootPath.length + 1)}
        </span>
        {selectedEntries.length > 0 && (
          <button
            className="toolbar-btn icon-only danger"
            title={
              selectedEntries.length === 1
                ? `Delete ${selectedEntries[0].name}`
                : `Delete ${selectedEntries.length} items`
            }
            onClick={() => deleteEntries(selectedEntries)}
          >
            <Trash2 size={14} />
          </button>
        )}
        <button className="toolbar-btn icon-only" title="New folder" onClick={createFolder}>
          <FolderPlus size={14} />
        </button>
        <button className="toolbar-btn icon-only" title="New script" onClick={createScript}>
          <FileCode2 size={14} />
        </button>
        <button className="toolbar-btn icon-only" title="New material" onClick={createMaterial}>
          <Palette size={14} />
        </button>
        <div className="view-mode-group">
          {VIEW_MODES.map(({ id, title, Icon }) => (
            <button
              key={id}
              className={`toolbar-btn icon-only ${viewId === id ? "active" : ""}`}
              title={title}
              onClick={() => setView(id)}
            >
              <Icon size={14} />
            </button>
          ))}
        </div>
        <button
          className="toolbar-btn icon-only"
          title="Open project folder…"
          onClick={() => useProjectStore.getState().openFolder()}
        >
          <FolderOpen size={14} />
        </button>
      </div>
      <div className="assets-filterbar">
        <div className="assets-search">
          <Search size={12} className="assets-search-icon" />
          <input
            className="assets-search-input"
            type="text"
            placeholder="Search assets… (tag:name to match tags)"
            value={query}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape" && query) setQuery("");
            }}
          />
          {query && (
            <button className="assets-search-clear" title="Clear search" onClick={() => setQuery("")}>
              <X size={11} />
            </button>
          )}
        </div>
        <div className="dropdown-wrap">
          <button
            className={`toolbar-btn filter-btn ${typeId !== "all" ? "active" : ""}`}
            title="Filter by asset type"
            onClick={() => setTypeMenuOpen((v) => !v)}
          >
            <activeType.Icon size={13} />
            <span className="filter-btn-label">{activeType.label}</span>
            <ChevronDown size={11} />
          </button>
          {typeMenuOpen && (
            <>
              <div className="dropdown-overlay" onClick={() => setTypeMenuOpen(false)} />
              <div className="dropdown-menu component-menu align-right">
                {ASSET_TYPES.map(({ id, label, Icon }) => (
                  <button
                    key={id}
                    className={`dropdown-item component-item ${typeId === id ? "checked" : ""}`}
                    onClick={() => {
                      setTypeId(id);
                      setTypeMenuOpen(false);
                    }}
                  >
                    <Icon size={14} className="component-item-icon" />
                    <span className="component-item-label">{label}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        <button
          className={`toolbar-btn icon-only ${usedOnly ? "active" : ""}`}
          title={
            selectedEntityIds.length
              ? `Show only assets used by the ${selectedEntityIds.length === 1 ? "selected object" : `${selectedEntityIds.length} selected objects`}`
              : "Show only assets used by the selected objects (nothing selected)"
          }
          disabled={!selectedEntityIds.length && !usedOnly}
          onClick={() => setUsedOnly((v) => !v)}
        >
          <Target size={14} />
        </button>
        {filtersActive && (
          <button className="toolbar-btn icon-only" title="Clear filters" onClick={clearFilters}>
            <X size={14} />
          </button>
        )}
      </div>
      {error && <div className="asset-error">{error}</div>}
      <div className="assets-body">
        {showTree && (
          <div className="assets-sidebar">
            <FolderTree />
          </div>
        )}
        <div
          className={`asset-grid view-${view.id}`}
          ref={gridRef}
          tabIndex={0}
          onKeyDown={onGridKeyDown}
          onPointerDown={onGridPointerDown}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            useSelectionStore.getState().clear();
            setContextMenu({ x: e.clientX, y: e.clientY, entry: null });
          }}
        >
          {(loading || (searching && scanning && !projectEntries)) && (
            <div className="asset-hint">{scanning ? "Searching project…" : "Loading…"}</div>
          )}
          {!loading && visible.length === 0 && (
            <div className="asset-hint">
              {searching
                ? usedOnly && !selectedEntityIds.length
                  ? "Select an object to see the assets it uses"
                  : "No assets match these filters"
                : "Empty folder"}
            </div>
          )}
          {searching && visible.length > 0 && (
            <div className="asset-result-bar">
              {visible.length} {visible.length === 1 ? "result" : "results"}
              {projectWide ? " across the project" : ""}
              {usedOnly ? " · used by selection" : ""}
            </div>
          )}
          {view.id === "details" && visible.length > 0 && (
            <div className="asset-row header">
              <div className="asset-row-name">Name</div>
              <div className="asset-col">Type</div>
              <div className="asset-col">Size</div>
              <div className="asset-col">Modified</div>
            </div>
          )}
          {visible.map((entry) => (
            <AssetItem
              key={entry.path}
              entry={entry}
              view={view}
              visible={visible}
              renaming={renamingPath === entry.path}
              setRenamingPath={setRenamingPath}
              onContextMenu={onTileContextMenu}
              subtitle={relativeFolder(entry)}
            />
          ))}
          {box && (
            <div
              className="asset-marquee"
              style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
            />
          )}
        </div>
      </div>
      {contextMenu && (
        <AssetContextMenu
          menu={contextMenu}
          close={() => setContextMenu(null)}
          setRenamingPath={setRenamingPath}
          selectedEntries={selectedEntries}
        />
      )}
      {packPaths && (
        <PackAtlasDialog
          count={packPaths.length}
          onCancel={() => setPackPaths(null)}
          onApply={async (options) => {
            try {
              const { atlasPath, overflow } = await buildAtlasFromImages(packPaths, {
                directory: currentPath,
                ...options,
              });
              await useProjectStore.getState().refresh();
              setPackPaths(null);
              if (overflow.length) {
                // Never silently drop artwork: an atlas missing three sprites
                // looks like it worked until something renders empty.
                console.warn(`Atlas is full — left out: ${overflow.join(", ")}`);
              }
              openAssetPath(atlasPath);
            } catch (error) {
              console.error(`Pack failed: ${error?.message ?? error}`);
              setPackPaths(null);
            }
          }}
        />
      )}
    </div>
  );
}
