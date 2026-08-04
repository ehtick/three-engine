import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Brush,
  ChevronDown,
  ChevronUp,
  Copy,
  Droplet,
  Eraser,
  Eye,
  EyeOff,
  Grid3x3,
  Image as ImageIcon,
  Lasso,
  Layers as LayersIcon,
  Lock,
  Minus,
  Move,
  PaintBucket,
  Pipette,
  Plus,
  Redo2,
  Save,
  Circle as CircleIcon,
  Square,
  SquareDashed,
  Trash2,
  Undo2,
  Unlock,
  Wand2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useModulesStore, setModuleEnabled } from "../modules.js";
import { useProjectStore, basename } from "../store/projectStore.js";
import { useSelectionStore } from "../store/selectionStore.js";
import { extOf, TEXTURE_EXTENSIONS } from "../assetLoader.js";
import { uniqueName } from "../assetOps.js";
import { pushToast } from "../toasts.js";
import { NEW_TEXTURE_EVENT, consumeNewTextureRequest } from "../textureEditorRequest.js";
import {
  createTextureAsset,
  openTextureDocument,
  saveTextureDocument,
} from "../textureFile.js";
import { bufferToImageData } from "../texture/codecPng.js";
import { BLEND_MODES, compositeLayers, blendInto } from "../texture/blend.js";
import {
  clearRegion,
  cloneBuffer,
  copyRegion,
  createBuffer,
  parseColor,
  toHex,
} from "../texture/pixels.js";
import {
  activeLayer as findActiveLayer,
  addLayer,
  cloneDocument,
  duplicateLayer,
  getLayer,
  mergeDown,
  removeLayer,
  reorderLayer,
} from "../texture/layers.js";
import {
  applyStroke,
  createStroke,
  fillGradient,
  floodFill,
  pickColor,
  stampBrush,
  strokeEllipse,
  strokeRect,
  strokeSegment,
} from "../texture/draw.js";
import {
  combineSelection,
  createSelection,
  ellipseSelection,
  invertSelection,
  isSelectionEmpty,
  polygonSelection,
  rectSelection,
  wandSelection,
} from "../texture/selection.js";
import {
  captureRegion,
  createHistory,
  documentEntry,
  regionEntry,
} from "../texture/history.js";

/**
 * The texture editor: paint, layers, selections, save.
 *
 * Three implementation notes carry most of the weight here.
 *
 * **The document lives in a ref, not in state.** A 2K document is 16MB per
 * layer; putting it in `useState` would mean React comparing, and potentially
 * cloning, tens of megabytes on every pointer move. Mutations bump a `version`
 * counter, which is what the layer list re-renders on. The canvas is painted
 * imperatively and never re-renders at all.
 *
 * **A live stroke re-rasterizes only the segment just drawn.** The active
 * layer is copied once at pointer-down; each move restores that segment's
 * rectangle from the copy and re-applies the accumulated stroke inside it.
 * Restoring is what keeps `max()`-accumulated coverage correct, and clipping to
 * the segment is what keeps a long stroke from getting quadratically slower as
 * its dirty region grows.
 *
 * **The composite is incremental too.** Only the rectangle that changed is
 * re-composited and only that rectangle is pushed to the display canvas
 * (`putImageData`'s 7-argument form), so brush latency is a function of brush
 * size rather than document size.
 */

const CHECKER = 8; // px of the transparency checkerboard, in screen space
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 64;

const TOOLS = [
  { id: "brush", label: "Brush", Icon: Brush, key: "B" },
  { id: "eraser", label: "Eraser", Icon: Eraser, key: "E" },
  { id: "fill", label: "Paint Bucket", Icon: PaintBucket, key: "G" },
  { id: "gradient", label: "Gradient", Icon: Droplet, key: "N" },
  { id: "line", label: "Line", Icon: Minus, key: "U" },
  { id: "rect", label: "Rectangle", Icon: Square, key: "R" },
  { id: "ellipse", label: "Ellipse", Icon: CircleIcon, key: "O" },
  { id: "selectRect", label: "Rectangle Select", Icon: SquareDashed, key: "M" },
  { id: "selectEllipse", label: "Ellipse Select", Icon: CircleIcon, key: "" },
  { id: "lasso", label: "Lasso", Icon: Lasso, key: "L" },
  { id: "wand", label: "Magic Wand", Icon: Wand2, key: "W" },
  { id: "eyedropper", label: "Eyedropper", Icon: Pipette, key: "I" },
  { id: "move", label: "Move Layer", Icon: Move, key: "V" },
];

const SHAPE_TOOLS = new Set(["line", "rect", "ellipse"]);
const SELECT_TOOLS = new Set(["selectRect", "selectEllipse", "lasso", "wand"]);
const PAINT_TOOLS = new Set(["brush", "eraser", "line", "rect", "ellipse"]);

const isImagePath = (path) => !!path && TEXTURE_EXTENSIONS.includes(extOf(path));

// ---------------------------------------------------------------------------

export function TextureEditorPanel() {
  const moduleOn = useModulesStore((s) => s.enabled.includes("texture-editor"));
  const assetPath = useSelectionStore((s) => s.assetPath);
  const hasProject = useProjectStore((s) => !!s.rootPath);

  // The panel keeps editing whatever it last opened. Clicking an entity in the
  // hierarchy clears `assetPath`, and blanking a half-finished painting because
  // the user glanced at the scene would be indefensible.
  const [path, setPath] = useState(null);
  useEffect(() => {
    if (isImagePath(assetPath)) setPath(assetPath);
  }, [assetPath]);

  if (!moduleOn) {
    return (
      <div className="panel-empty texture-editor-gate">
        <ImageIcon size={26} />
        <p>The Texture Editor module is not enabled for this project.</p>
        <button className="toolbar-btn" onClick={() => setModuleEnabled("texture-editor", true)}>
          Enable Texture Editor
        </button>
      </div>
    );
  }
  if (!hasProject) return <div className="panel-empty">Open a project to edit textures.</div>;
  return <TextureWorkspace path={path} onPathChange={setPath} key={path ?? "none"} />;
}

// ---------------------------------------------------------------------------

function TextureWorkspace({ path, onPathChange }) {
  const docRef = useRef(null);
  const [version, setVersion] = useState(0);
  const [status, setStatus] = useState(path ? "loading" : "empty");
  const [warning, setWarning] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  // "New Texture" in the Assets panel latches a request rather than firing an
  // event into the void — this panel is lazy-loaded and usually mounts AFTER
  // the click that asked for it. See textureEditorRequest.js.
  const [showNew, setShowNew] = useState(() => !path || consumeNewTextureRequest());
  useEffect(() => {
    const open = () => setShowNew(true);
    window.addEventListener(NEW_TEXTURE_EVENT, open);
    if (consumeNewTextureRequest()) setShowNew(true);
    return () => window.removeEventListener(NEW_TEXTURE_EVENT, open);
  }, []);

  const [tool, setTool] = useState("brush");
  const [color, setColor] = useState("#ffffff");
  const [altColor, setAltColor] = useState("#000000");
  const [alpha, setAlpha] = useState(255);
  const [brushSize, setBrushSize] = useState(24);
  const [hardness, setHardness] = useState(0.85);
  const [opacity, setOpacity] = useState(1);
  const [tolerance, setTolerance] = useState(0.12);
  const [contiguous, setContiguous] = useState(true);
  const [shapeFill, setShapeFill] = useState(true);
  const [gradientType, setGradientType] = useState("linear");
  const [selectMode, setSelectMode] = useState("replace");
  const [tiling, setTiling] = useState(false);

  const historyRef = useRef(createHistory());
  const selectionRef = useRef(null);
  const compositeRef = useRef(null);
  const [selectionVersion, setSelectionVersion] = useState(0);

  const bump = useCallback(() => setVersion((v) => v + 1), []);

  // --- load --------------------------------------------------------------
  useEffect(() => {
    if (!path) {
      setStatus("empty");
      return;
    }
    let cancelled = false;
    setStatus("loading");
    openTextureDocument(path)
      .then(({ doc, warning: warn }) => {
        if (cancelled) return;
        docRef.current = doc;
        compositeRef.current = compositeLayers(doc.layers, doc.width, doc.height);
        selectionRef.current = null;
        historyRef.current = createHistory();
        setWarning(warn);
        setDirty(false);
        setStatus("ready");
        bump();
      })
      .catch((error) => {
        if (cancelled) return;
        setStatus("error");
        setWarning(String(error?.message ?? error));
      });
    return () => {
      cancelled = true;
    };
  }, [path, bump]);

  const doc = docRef.current;
  const layer = doc ? findActiveLayer(doc) : null;

  // --- composite bookkeeping ---------------------------------------------
  const recomposite = useCallback((rect) => {
    const document_ = docRef.current;
    const composite = compositeRef.current;
    if (!document_ || !composite) return;
    const region = rect ?? { x0: 0, y0: 0, x1: document_.width, y1: document_.height };
    clearRegion(composite, region);
    const clip = {
      x: Math.max(0, Math.floor(region.x0)),
      y: Math.max(0, Math.floor(region.y0)),
      width: Math.max(0, Math.ceil(region.x1) - Math.floor(region.x0)),
      height: Math.max(0, Math.ceil(region.y1) - Math.floor(region.y0)),
    };
    for (const l of document_.layers) {
      if (l.visible === false) continue;
      blendInto(composite, l.buffer, {
        offsetX: l.offset?.[0] ?? 0,
        offsetY: l.offset?.[1] ?? 0,
        opacity: l.opacity ?? 1,
        blend: l.blend ?? "normal",
        mask: l.mask ?? null,
        clip,
      });
    }
  }, []);

  // Registered by the canvas. Every edit routes its dirty rectangle through
  // here so there is exactly one place that decides what gets re-uploaded.
  const invalidateRef = useRef(null);

  const markEdited = useCallback(
    (rect) => {
      recomposite(rect);
      invalidateRef.current?.(rect);
      setDirty(true);
      bump();
    },
    [recomposite, bump],
  );

  /** Mid-gesture: recomposite and repaint without a React render. A brush
   *  stroke fires this at pointer rate; re-rendering the layer list two hundred
   *  times per second to show pixels the canvas has already drawn is pure cost. */
  const markPainting = useCallback(
    (rect) => {
      recomposite(rect);
      invalidateRef.current?.(rect);
    },
    [recomposite],
  );

  /** End of a gesture: the document is now different from what is on disk. */
  const markTouched = useCallback(() => {
    setDirty(true);
    bump();
  }, [bump]);

  // --- history -----------------------------------------------------------
  const pushHistory = useCallback((entry) => {
    historyRef.current.push(entry);
  }, []);

  /** Structural edits (layer add/remove/reorder/merge) snapshot the document. */
  const withDocumentSnapshot = useCallback(
    (label, mutate) => {
      const before = cloneDocument(docRef.current);
      mutate(docRef.current);
      pushHistory(
        documentEntry(
          () => cloneDocument(docRef.current),
          (snapshot) => {
            docRef.current = cloneDocument(snapshot);
            compositeRef.current = compositeLayers(
              docRef.current.layers,
              docRef.current.width,
              docRef.current.height,
            );
            setDirty(true);
            bump();
          },
          before,
          label,
        ),
      );
      markEdited(null);
    },
    [pushHistory, markEdited, bump],
  );

  // Undo/redo write straight into the existing buffers, so the display surface
  // has no way to notice — it must be told, or the canvas keeps showing the
  // state that was just rewound.
  const undo = useCallback(() => {
    if (!historyRef.current.undo()) return;
    markEdited(null);
  }, [markEdited]);

  const redo = useCallback(() => {
    if (!historyRef.current.redo()) return;
    markEdited(null);
  }, [markEdited]);

  // --- save --------------------------------------------------------------
  const save = useCallback(async () => {
    if (!docRef.current || !path || saving) return;
    setSaving(true);
    try {
      await saveTextureDocument(path, docRef.current);
      setDirty(false);
      pushToast({ title: `Saved ${basename(path)}` });
    } catch (error) {
      console.error(error);
      pushToast({ level: "error", title: "Save failed", detail: String(error?.message ?? error) });
    } finally {
      setSaving(false);
    }
  }, [path, saving]);

  // --- selection ---------------------------------------------------------
  const setSelection = useCallback((mask) => {
    selectionRef.current = mask && isSelectionEmpty(mask) ? null : mask;
    setSelectionVersion((v) => v + 1);
  }, []);

  const selectAll = useCallback(() => {
    const d = docRef.current;
    if (d) setSelection(createSelection(d.width, d.height, 255));
  }, [setSelection]);

  const deselect = useCallback(() => setSelection(null), [setSelection]);

  const invert = useCallback(() => {
    const d = docRef.current;
    if (!d) return;
    setSelection(invertSelection(selectionRef.current, d.width, d.height));
  }, [setSelection]);

  // --- keyboard ----------------------------------------------------------
  const rootRef = useRef(null);
  useEffect(() => {
    const onKey = (event) => {
      const root = rootRef.current;
      if (!root || !root.contains(document.activeElement) ) {
        // Hover, not focus: clicking on the canvas does not move
        // `document.activeElement`, so a focus-only test would drop every
        // shortcut the moment the user actually painted something.
        if (!root?.matches(":hover")) return;
      }
      const target = event.target;
      if (target instanceof HTMLElement && /input|textarea|select/i.test(target.tagName)) return;
      const ctrl = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();

      if (ctrl && key === "z") {
        event.preventDefault();
        event.stopPropagation();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (ctrl && key === "y") {
        event.preventDefault();
        redo();
        return;
      }
      if (ctrl && key === "s") {
        event.preventDefault();
        event.stopPropagation();
        save();
        return;
      }
      if (ctrl && key === "a") {
        event.preventDefault();
        selectAll();
        return;
      }
      if (ctrl && key === "d") {
        event.preventDefault();
        event.stopPropagation();
        deselect();
        return;
      }
      if (ctrl && key === "i") {
        event.preventDefault();
        invert();
        return;
      }
      if (ctrl) return;

      if (key === "[") {
        setBrushSize((s) => Math.max(1, Math.round(s * 0.8)));
        return;
      }
      if (key === "]") {
        setBrushSize((s) => Math.min(512, Math.round(s * 1.25) + 1));
        return;
      }
      if (key === "x") {
        setColor(altColor);
        setAltColor(color);
        return;
      }
      const match = TOOLS.find((t) => t.key && t.key.toLowerCase() === key);
      if (match) setTool(match.id);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [undo, redo, save, selectAll, deselect, invert, color, altColor]);

  // --- new document ------------------------------------------------------
  const createNew = useCallback(
    async ({ name, width, height, background }) => {
      const { currentPath, entries, refresh } = useProjectStore.getState();
      if (!currentPath) return;
      const fileName = uniqueName(name.endsWith(".png") ? name : `${name}.png`, entries);
      const { path: created } = await createTextureAsset(currentPath, fileName, {
        width,
        height,
        background,
      });
      await refresh();
      useSelectionStore.getState().selectAsset(created);
      setShowNew(false);
      onPathChange(created);
    },
    [onPathChange],
  );

  const toolProps = {
    tool,
    color,
    altColor,
    alpha,
    brushSize,
    hardness,
    opacity,
    tolerance,
    contiguous,
    shapeFill,
    gradientType,
    selectMode,
  };

  return (
    <div className="texture-editor" ref={rootRef} tabIndex={-1}>
      <div className="panel-toolbar texture-toolbar">
        <button className="toolbar-btn" onClick={() => setShowNew(true)}>
          <Plus size={13} /> New
        </button>
        <button className="toolbar-btn" disabled={!dirty || saving || !path} onClick={save}>
          <Save size={13} /> {saving ? "Saving…" : "Save"}
        </button>
        <span className="toolbar-sep" />
        <button className="toolbar-btn icon-only" title="Undo (Ctrl+Z)" onClick={undo}>
          <Undo2 size={14} />
        </button>
        <button className="toolbar-btn icon-only" title="Redo (Ctrl+Shift+Z)" onClick={redo}>
          <Redo2 size={14} />
        </button>
        <span className="toolbar-sep" />
        <button
          className={`toolbar-btn icon-only ${tiling ? "active" : ""}`}
          title="Tiling preview — repeat the texture to check its seams"
          onClick={() => setTiling((t) => !t)}
        >
          <Grid3x3 size={14} />
        </button>
        <span className="texture-title">
          {path ? basename(path) : "No texture open"}
          {dirty ? " •" : ""}
        </span>
      </div>

      {warning && (
        <div className="texture-warning">
          {warning}
          <button className="toolbar-btn tiny" onClick={() => setWarning(null)}>
            Dismiss
          </button>
        </div>
      )}

      <div className="texture-body">
        <ToolColumn tool={tool} onTool={setTool} />

        <div className="texture-main">
          <ToolOptions
            tool={tool}
            color={color}
            altColor={altColor}
            onColor={setColor}
            onAltColor={setAltColor}
            alpha={alpha}
            onAlpha={setAlpha}
            brushSize={brushSize}
            onBrushSize={setBrushSize}
            hardness={hardness}
            onHardness={setHardness}
            opacity={opacity}
            onOpacity={setOpacity}
            tolerance={tolerance}
            onTolerance={setTolerance}
            contiguous={contiguous}
            onContiguous={setContiguous}
            shapeFill={shapeFill}
            onShapeFill={setShapeFill}
            gradientType={gradientType}
            onGradientType={setGradientType}
            selectMode={selectMode}
            onSelectMode={setSelectMode}
            onSelectAll={selectAll}
            onDeselect={deselect}
            onInvert={invert}
            hasSelection={!!selectionRef.current}
          />

          {status === "loading" && <div className="panel-empty">Loading texture…</div>}
          {status === "error" && <div className="panel-empty">Could not open this texture.</div>}
          {status === "empty" && !showNew && (
            <div className="panel-empty">
              <ImageIcon size={26} />
              <p>Select a texture in the Assets panel, or create a new one.</p>
              <button className="toolbar-btn" onClick={() => setShowNew(true)}>
                New Texture…
              </button>
            </div>
          )}
          {status === "ready" && doc && (
            <TextureCanvas
              doc={doc}
              layer={layer}
              composite={compositeRef}
              selectionRef={selectionRef}
              selectionVersion={selectionVersion}
              version={version}
              tiling={tiling}
              toolProps={toolProps}
              invalidateRef={invalidateRef}
              onSelection={setSelection}
              onEdited={markEdited}
              onPainting={markPainting}
              onTouched={markTouched}
              onHistory={pushHistory}
              onPickColor={setColor}
            />
          )}
        </div>

        {status === "ready" && doc && (
          <LayerColumn
            doc={doc}
            version={version}
            onSelect={(id) => {
              doc.activeId = id;
              bump();
            }}
            onToggle={(id) => {
              const l = getLayer(doc, id);
              if (!l) return;
              l.visible = !l.visible;
              markEdited(null);
            }}
            onLock={(id) => {
              const l = getLayer(doc, id);
              if (!l) return;
              l.locked = !l.locked;
              bump();
            }}
            onRename={(id, name) => {
              const l = getLayer(doc, id);
              if (!l) return;
              l.name = name;
              setDirty(true);
              bump();
            }}
            onOpacity={(id, value) => {
              const l = getLayer(doc, id);
              if (!l) return;
              l.opacity = value;
              markEdited(null);
            }}
            onBlend={(id, mode) => {
              const l = getLayer(doc, id);
              if (!l) return;
              l.blend = mode;
              markEdited(null);
            }}
            onAdd={() => withDocumentSnapshot("Add Layer", (d) => addLayer(d, { name: `Layer ${d.layers.length}` }))}
            onDuplicate={(id) => withDocumentSnapshot("Duplicate Layer", (d) => duplicateLayer(d, id))}
            onDelete={(id) => withDocumentSnapshot("Delete Layer", (d) => removeLayer(d, id))}
            onMerge={(id) => withDocumentSnapshot("Merge Down", (d) => mergeDown(d, id))}
            onReorder={(id, delta) => withDocumentSnapshot("Reorder Layer", (d) => reorderLayer(d, id, delta))}
          />
        )}
      </div>

      <StatusBar doc={doc} historyRef={historyRef} version={version} />

      {showNew && <NewTextureDialog onCancel={() => setShowNew(false)} onCreate={createNew} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// canvas
// ---------------------------------------------------------------------------

function TextureCanvas({
  doc,
  layer,
  composite,
  selectionRef,
  selectionVersion,
  version,
  tiling,
  toolProps,
  invalidateRef,
  onSelection,
  onEdited,
  onPainting,
  onTouched,
  onHistory,
  onPickColor,
}) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const viewRef = useRef({ zoom: 1, x: 0, y: 0 });
  // Zoom/pan live in a ref (they change at pointer rate); this counter is the
  // one bit of state that tells the paint effect the view moved.
  const [viewVersion, bumpView] = useState(0);
  const cursorRef = useRef({ x: -1, y: -1, inside: false });
  const gestureRef = useRef(null);
  const outlineRef = useRef(null);
  const imageDataRef = useRef(null);
  const surfaceRef = useRef(null); // doc-sized canvas the view is scaled from
  const uploadRef = useRef({ full: true, rect: null }); // what still needs uploading
  const toolRef = useRef(toolProps);
  toolRef.current = toolProps;

  /**
   * Pushes the composite (or just the rectangle that changed) into the
   * document-sized canvas the view draws from.
   *
   * The `ImageData` is a *view* over the composite's own array, not a copy —
   * and `putImageData`'s 7-argument form uploads only the dirty rectangle. Both
   * matter: a full upload of a 2K document is 16MB per pointer move, which is
   * enough to make a brush feel laggy on hardware that has no trouble at all
   * with the actual painting.
   */
  const syncSurface = useCallback(() => {
    const buffer = composite.current;
    if (!buffer) return null;
    let surface = surfaceRef.current;
    if (!surface || surface.width !== buffer.width || surface.height !== buffer.height) {
      surface = document.createElement("canvas");
      surface.width = buffer.width;
      surface.height = buffer.height;
      surfaceRef.current = surface;
      imageDataRef.current = null;
      uploadRef.current = { full: true, rect: null };
    }
    if (!imageDataRef.current || imageDataRef.current.data !== buffer.data) {
      imageDataRef.current = bufferToImageData(buffer);
      uploadRef.current = { full: true, rect: null };
    }
    const pending = uploadRef.current;
    // Neither flag set means the pixels are already on the surface — panning
    // and zooming must not re-upload anything.
    if (!pending.full && !pending.rect) return surface;

    const ctx = surface.getContext("2d", { willReadFrequently: false });
    if (pending.full) {
      ctx.putImageData(imageDataRef.current, 0, 0);
    } else {
      const x = Math.max(0, Math.floor(pending.rect.x0));
      const y = Math.max(0, Math.floor(pending.rect.y0));
      const w = Math.min(buffer.width, Math.ceil(pending.rect.x1)) - x;
      const h = Math.min(buffer.height, Math.ceil(pending.rect.y1)) - y;
      if (w > 0 && h > 0) ctx.putImageData(imageDataRef.current, 0, 0, x, y, w, h);
    }
    uploadRef.current = { full: false, rect: null };
    return surface;
  }, [composite]);

  /** Records what changed so the next paint uploads only that. A null rect
   *  means "everything" — layer visibility, undo, a document swap. */
  const invalidateSurface = useCallback((rect) => {
    const pending = uploadRef.current;
    if (!rect) {
      uploadRef.current = { full: true, rect: null };
      return;
    }
    if (pending.full) return;
    pending.rect = pending.rect
      ? {
          x0: Math.min(pending.rect.x0, rect.x0),
          y0: Math.min(pending.rect.y0, rect.y0),
          x1: Math.max(pending.rect.x1, rect.x1),
          y1: Math.max(pending.rect.y1, rect.y1),
        }
      : { ...rect };
  }, []);

  const fit = useCallback(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const zoom = Math.min(
      (wrap.clientWidth - 48) / doc.width,
      (wrap.clientHeight - 48) / doc.height,
      8,
    );
    viewRef.current = {
      zoom: Math.max(MIN_ZOOM, zoom),
      x: wrap.clientWidth / 2 - (doc.width * Math.max(MIN_ZOOM, zoom)) / 2,
      y: wrap.clientHeight / 2 - (doc.height * Math.max(MIN_ZOOM, zoom)) / 2,
    };
    bumpView((v) => v + 1);
  }, [doc.width, doc.height]);

  useEffect(() => {
    fit();
  }, [fit]);

  // Selection outline: rebuilt only when the selection changes, then drawn with
  // the same transform as the image so it tracks zoom and pan for free.
  useEffect(() => {
    const mask = selectionRef.current;
    if (!mask) {
      outlineRef.current = null;
      return;
    }
    const { width, height } = doc;
    const edge = createBuffer(width, height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (!mask[i]) continue;
        const boundary =
          x === 0 || y === 0 || x === width - 1 || y === height - 1 ||
          !mask[i - 1] || !mask[i + 1] || !mask[i - width] || !mask[i + width];
        if (boundary) {
          const d = i * 4;
          edge.data[d] = edge.data[d + 1] = edge.data[d + 2] = 255;
          edge.data[d + 3] = 255;
        }
      }
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d").putImageData(new ImageData(edge.data, width, height), 0, 0);
    outlineRef.current = canvas;
  }, [selectionVersion, selectionRef, doc]);

  // --- painting the view --------------------------------------------------
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    const buffer = composite.current;
    if (!canvas || !wrap || !buffer) return;
    const dpr = window.devicePixelRatio || 1;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const { zoom, x, y } = viewRef.current;
    const dw = doc.width * zoom;
    const dh = doc.height * zoom;

    // Checkerboard in SCREEN space, so it stays a constant size as you zoom —
    // a checkerboard that scales with the image reads as part of the artwork.
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, dw, dh);
    ctx.clip();
    ctx.fillStyle = "#2a2a2e";
    ctx.fillRect(x, y, dw, dh);
    ctx.fillStyle = "#37373d";
    for (let cy = Math.floor(y / CHECKER) * CHECKER; cy < y + dh; cy += CHECKER) {
      for (let cx = Math.floor(x / CHECKER) * CHECKER; cx < x + dw; cx += CHECKER) {
        if (((cx / CHECKER) & 1) !== ((cy / CHECKER) & 1)) continue;
        ctx.fillRect(cx, cy, CHECKER, CHECKER);
      }
    }
    ctx.restore();

    const source = syncSurface();
    if (!source) return;
    ctx.imageSmoothingEnabled = zoom < 1;
    if (tiling) {
      ctx.globalAlpha = 0.45;
      for (let ty = -1; ty <= 1; ty++) {
        for (let tx = -1; tx <= 1; tx++) {
          if (!tx && !ty) continue;
          ctx.drawImage(source, x + tx * dw, y + ty * dh, dw, dh);
        }
      }
      ctx.globalAlpha = 1;
    }
    ctx.drawImage(source, x, y, dw, dh);

    if (outlineRef.current) {
      ctx.imageSmoothingEnabled = false;
      ctx.globalAlpha = 0.9;
      ctx.drawImage(outlineRef.current, x, y, dw, dh);
      ctx.globalAlpha = 1;
    }

    // Document border, so an empty transparent texture is still locatable.
    ctx.strokeStyle = "rgba(255,255,255,0.22)";
    ctx.lineWidth = 1;
    ctx.strokeRect(x - 0.5, y - 0.5, dw + 1, dh + 1);

    // In-progress shape / selection rubber band.
    const gesture = gestureRef.current;
    if (gesture?.preview) {
      ctx.strokeStyle = "rgba(255,255,255,0.8)";
      ctx.setLineDash([4, 3]);
      const p = gesture.preview;
      ctx.strokeRect(x + p.x * zoom, y + p.y * zoom, p.width * zoom, p.height * zoom);
      ctx.setLineDash([]);
    }

    // Brush cursor: a true-size ring is the only reliable way to know what a
    // stroke will cover before committing to it.
    const cursor = cursorRef.current;
    const tp = toolRef.current;
    if (cursor.inside && PAINT_TOOLS.has(tp.tool) && !SHAPE_TOOLS.has(tp.tool)) {
      ctx.strokeStyle = "rgba(0,0,0,0.75)";
      ctx.beginPath();
      ctx.arc(x + cursor.x * zoom, y + cursor.y * zoom, (tp.brushSize / 2) * zoom, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = "rgba(255,255,255,0.75)";
      ctx.beginPath();
      ctx.arc(x + cursor.x * zoom, y + cursor.y * zoom, (tp.brushSize / 2) * zoom - 1, 0, Math.PI * 2);
      ctx.stroke();
    }
  }, [composite, doc.width, doc.height, tiling, syncSurface]);

  // The workspace invalidates through this so every edit — wherever it
  // originates — goes through one upload path.
  useEffect(() => {
    invalidateRef.current = invalidateSurface;
    return () => {
      if (invalidateRef.current === invalidateSurface) invalidateRef.current = null;
    };
  }, [invalidateRef, invalidateSurface]);

  // Repaint on any state that changes what is on screen. The stroke path calls
  // `draw` directly, so this is not on the pointer-move critical path.
  useEffect(() => {
    draw();
  }, [draw, version, selectionVersion, viewVersion]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => draw());
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [draw]);

  // --- coordinate helpers -------------------------------------------------
  const toDoc = useCallback((event) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const { zoom, x, y } = viewRef.current;
    return {
      x: (event.clientX - rect.left - x) / zoom,
      y: (event.clientY - rect.top - y) / zoom,
    };
  }, []);

  // --- gestures -----------------------------------------------------------
  const beginStroke = useCallback(
    (point) => {
      if (!layer || layer.locked || layer.visible === false) {
        pushToast({ title: layer?.locked ? "That layer is locked" : "That layer is hidden" });
        return null;
      }
      return {
        kind: "stroke",
        base: cloneBuffer(layer.buffer),
        stroke: createStroke(doc.width, doc.height),
        carry: 0,
        last: point,
        total: { x0: doc.width, y0: doc.height, x1: 0, y1: 0 },
      };
    },
    [layer, doc.width, doc.height],
  );

  const growTotal = (total, rect) => {
    total.x0 = Math.min(total.x0, rect.x0);
    total.y0 = Math.min(total.y0, rect.y0);
    total.x1 = Math.max(total.x1, rect.x1);
    total.y1 = Math.max(total.y1, rect.y1);
  };

  const applySegment = useCallback(
    (gesture, rect) => {
      const tp = toolRef.current;
      const clip = {
        x0: Math.max(0, Math.floor(rect.x0)),
        y0: Math.max(0, Math.floor(rect.y0)),
        x1: Math.min(doc.width, Math.ceil(rect.x1)),
        y1: Math.min(doc.height, Math.ceil(rect.y1)),
      };
      if (clip.x1 <= clip.x0 || clip.y1 <= clip.y0) return;
      // Restore, then re-apply: coverage accumulates with max(), so painting
      // over already-painted pixels a second time would darken them.
      copyRegion(layer.buffer, gesture.base, clip);
      applyStroke(layer.buffer, gesture.stroke, {
        color: parseColor(tp.color, tp.alpha),
        opacity: tp.opacity,
        erase: tp.tool === "eraser",
        selection: selectionRef.current,
        clip,
      });
      growTotal(gesture.total, clip);
      onPainting(clip);
      draw();
    },
    [doc.width, doc.height, layer, onPainting, draw, selectionRef],
  );

  const onPointerDown = useCallback(
    (event) => {
      if (event.button === 1 || event.altKey || (event.button === 0 && event.shiftKey && event.ctrlKey)) {
        gestureRef.current = { kind: "pan", start: { x: event.clientX, y: event.clientY }, view: { ...viewRef.current } };
        event.currentTarget.setPointerCapture(event.pointerId);
        return;
      }
      if (event.button !== 0) return;
      const tp = toolRef.current;
      const point = toDoc(event);
      event.currentTarget.setPointerCapture(event.pointerId);

      if (tp.tool === "eyedropper") {
        const picked = pickColor(composite.current, Math.floor(point.x), Math.floor(point.y));
        if (picked) onPickColor(toHex(picked));
        return;
      }
      if (tp.tool === "move") {
        if (!layer || layer.locked) return;
        gestureRef.current = { kind: "move", start: point, origin: [...layer.offset], before: cloneDocument(doc) };
        return;
      }
      if (tp.tool === "wand") {
        const mask = wandSelection(composite.current, Math.floor(point.x), Math.floor(point.y), {
          tolerance: tp.tolerance,
          contiguous: tp.contiguous,
        });
        onSelection(combineSelection(selectionRef.current, mask, tp.selectMode, doc.width, doc.height));
        return;
      }
      if (SELECT_TOOLS.has(tp.tool)) {
        gestureRef.current =
          tp.tool === "lasso"
            ? { kind: "lasso", points: [[point.x, point.y]] }
            : { kind: "marquee", start: point, preview: { x: point.x, y: point.y, width: 0, height: 0 } };
        return;
      }
      if (tp.tool === "fill") {
        if (!layer || layer.locked) return;
        const before = cloneBuffer(layer.buffer);
        const stroke = floodFill(composite.current, Math.floor(point.x), Math.floor(point.y), {
          tolerance: tp.tolerance,
          contiguous: tp.contiguous,
          selection: selectionRef.current,
        });
        if (!stroke) return;
        const rect = { ...stroke.dirty };
        const snapshot = captureRegion(before, rect);
        applyStroke(layer.buffer, stroke, {
          color: parseColor(tp.color, tp.alpha),
          opacity: tp.opacity,
          selection: selectionRef.current,
        });
        onHistory(regionEntry(layer.buffer, rect, snapshot, "Fill"));
        onEdited(rect);
        return;
      }
      if (tp.tool === "gradient") {
        if (!layer || layer.locked) return;
        gestureRef.current = {
          kind: "gradient",
          start: point,
          base: cloneBuffer(layer.buffer),
          preview: { x: point.x, y: point.y, width: 0, height: 0 },
        };
        return;
      }
      if (SHAPE_TOOLS.has(tp.tool)) {
        const gesture = beginStroke(point);
        if (!gesture) return;
        gesture.kind = "shape";
        gesture.start = point;
        gestureRef.current = gesture;
        return;
      }
      // brush / eraser
      const gesture = beginStroke(point);
      if (!gesture) return;
      gestureRef.current = gesture;
      stampBrush(gesture.stroke, point.x, point.y, tp.brushSize / 2, tp.hardness);
      // The down point is already stamped; start the spacing rhythm from zero
      // so the next dab lands one full step away rather than on top of it.
      gesture.carry = 0;
      applySegment(gesture, {
        x0: point.x - tp.brushSize,
        y0: point.y - tp.brushSize,
        x1: point.x + tp.brushSize,
        y1: point.y + tp.brushSize,
      });
    },
    [toDoc, layer, doc, composite, selectionRef, onSelection, onPickColor, onHistory, onEdited, beginStroke, applySegment],
  );

  const onPointerMove = useCallback(
    (event) => {
      const point = toDoc(event);
      cursorRef.current = { x: point.x, y: point.y, inside: true };
      const gesture = gestureRef.current;
      const tp = toolRef.current;

      if (!gesture) {
        draw();
        return;
      }

      if (gesture.kind === "pan") {
        viewRef.current = {
          zoom: gesture.view.zoom,
          x: gesture.view.x + (event.clientX - gesture.start.x),
          y: gesture.view.y + (event.clientY - gesture.start.y),
        };
        draw();
        return;
      }

      if (gesture.kind === "stroke") {
        const radius = tp.brushSize / 2;
        gesture.carry = strokeSegment(gesture.stroke, gesture.last.x, gesture.last.y, point.x, point.y, {
          radius,
          hardness: tp.hardness,
          spacing: 0.2,
          carry: gesture.carry,
        });
        applySegment(gesture, {
          x0: Math.min(gesture.last.x, point.x) - radius - 2,
          y0: Math.min(gesture.last.y, point.y) - radius - 2,
          x1: Math.max(gesture.last.x, point.x) + radius + 2,
          y1: Math.max(gesture.last.y, point.y) + radius + 2,
        });
        gesture.last = point;
        return;
      }

      if (gesture.kind === "shape") {
        // A shape is redrawn from scratch each move: the stroke buffer is
        // rebuilt rather than accumulated, or dragging a rectangle would leave
        // every intermediate size painted underneath it.
        const previous = gesture.stroke.dirty;
        gesture.stroke = createStroke(doc.width, doc.height);
        const rect = {
          x: Math.min(gesture.start.x, point.x),
          y: Math.min(gesture.start.y, point.y),
          width: Math.abs(point.x - gesture.start.x),
          height: Math.abs(point.y - gesture.start.y),
        };
        if (tp.tool === "rect") strokeRect(gesture.stroke, rect, { fill: tp.shapeFill, lineWidth: tp.brushSize / 4 });
        else if (tp.tool === "ellipse") {
          strokeEllipse(gesture.stroke, rect, { fill: tp.shapeFill, lineWidth: tp.brushSize / 4 });
        } else {
          strokeSegment(gesture.stroke, gesture.start.x, gesture.start.y, point.x, point.y, {
            radius: tp.brushSize / 2,
            hardness: tp.hardness,
            spacing: 0.1,
          });
        }
        const union = {
          x0: Math.min(previous.x0, gesture.stroke.dirty.x0) - 2,
          y0: Math.min(previous.y0, gesture.stroke.dirty.y0) - 2,
          x1: Math.max(previous.x1, gesture.stroke.dirty.x1) + 2,
          y1: Math.max(previous.y1, gesture.stroke.dirty.y1) + 2,
        };
        applySegment(gesture, union);
        return;
      }

      if (gesture.kind === "gradient" || gesture.kind === "marquee") {
        gesture.current = point;
        gesture.preview = {
          x: Math.min(gesture.start.x, point.x),
          y: Math.min(gesture.start.y, point.y),
          width: Math.abs(point.x - gesture.start.x),
          height: Math.abs(point.y - gesture.start.y),
        };
        draw();
        return;
      }

      if (gesture.kind === "lasso") {
        gesture.points.push([point.x, point.y]);
        draw();
        return;
      }

      if (gesture.kind === "move") {
        layer.offset = [
          Math.round(gesture.origin[0] + (point.x - gesture.start.x)),
          Math.round(gesture.origin[1] + (point.y - gesture.start.y)),
        ];
        onPainting(null);
        draw();
      }
    },
    [toDoc, draw, doc.width, doc.height, layer, applySegment, onPainting],
  );

  const onPointerUp = useCallback(
    (event) => {
      const gesture = gestureRef.current;
      gestureRef.current = null;
      if (!gesture) return;
      const tp = toolRef.current;
      event.currentTarget.releasePointerCapture?.(event.pointerId);

      if (gesture.kind === "stroke" || gesture.kind === "shape") {
        const total = gesture.total;
        if (total.x1 > total.x0 && total.y1 > total.y0) {
          const before = captureRegion(gesture.base, total);
          onHistory(regionEntry(layer.buffer, total, before, gesture.kind === "shape" ? "Shape" : "Paint"));
        }
        onTouched();
        return;
      }

      if (gesture.kind === "gradient") {
        const end = gesture.current ?? gesture.start;
        const before = cloneBuffer(layer.buffer);
        const rect = { x0: 0, y0: 0, x1: doc.width, y1: doc.height };
        const snapshot = captureRegion(before, rect);
        fillGradient(layer.buffer, {
          type: tp.gradientType,
          x0: gesture.start.x,
          y0: gesture.start.y,
          x1: end.x,
          y1: end.y,
          from: parseColor(tp.color, tp.alpha),
          to: parseColor(tp.altColor, tp.gradientType === "linear" ? tp.alpha : 0),
          opacity: tp.opacity,
          selection: selectionRef.current,
        });
        onHistory(regionEntry(layer.buffer, rect, snapshot, "Gradient"));
        onEdited(null);
        return;
      }

      if (gesture.kind === "marquee") {
        const rect = gesture.preview;
        if (rect.width < 1 || rect.height < 1) {
          onSelection(null);
          return;
        }
        const shape =
          tp.tool === "selectEllipse"
            ? ellipseSelection(doc.width, doc.height, rect)
            : rectSelection(doc.width, doc.height, rect);
        onSelection(combineSelection(selectionRef.current, shape, tp.selectMode, doc.width, doc.height));
        return;
      }

      if (gesture.kind === "lasso") {
        if (gesture.points.length < 3) {
          onSelection(null);
          return;
        }
        const shape = polygonSelection(doc.width, doc.height, gesture.points);
        onSelection(combineSelection(selectionRef.current, shape, tp.selectMode, doc.width, doc.height));
        return;
      }

      if (gesture.kind === "move") {
        const before = gesture.before;
        const after = cloneDocument(doc);
        onHistory({
          label: "Move Layer",
          bytes: 64,
          undo: () => {
            const l = getLayer(doc, layer.id);
            if (l) l.offset = [...(getLayer(before, layer.id)?.offset ?? [0, 0])];
          },
          redo: () => {
            const l = getLayer(doc, layer.id);
            if (l) l.offset = [...(getLayer(after, layer.id)?.offset ?? [0, 0])];
          },
        });
        onEdited(null);
      }
    },
    [layer, doc, onHistory, onEdited, onTouched, onSelection, selectionRef],
  );

  const onWheel = useCallback(
    (event) => {
      event.preventDefault();
      const rect = canvasRef.current.getBoundingClientRect();
      const view = viewRef.current;
      const factor = Math.exp(-event.deltaY * 0.0015);
      const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.zoom * factor));
      // Zoom about the pointer: the texel under the cursor must not move, or
      // zooming in on a detail walks it off screen.
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      viewRef.current = {
        zoom,
        x: px - ((px - view.x) / view.zoom) * zoom,
        y: py - ((py - view.y) / view.zoom) * zoom,
      };
      draw();
    },
    [draw],
  );

  return (
    <div className="texture-canvas-wrap" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className="texture-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => {
          cursorRef.current.inside = false;
          draw();
        }}
        onWheel={onWheel}
        onContextMenu={(e) => e.preventDefault()}
      />
      <div className="texture-view-controls">
        <button
          className="toolbar-btn icon-only"
          title="Zoom out"
          onClick={() => {
            viewRef.current.zoom = Math.max(MIN_ZOOM, viewRef.current.zoom / 1.5);
            draw();
          }}
        >
          <ZoomOut size={14} />
        </button>
        <button className="toolbar-btn tiny" onClick={fit}>
          Fit
        </button>
        <button
          className="toolbar-btn icon-only"
          title="Zoom in"
          onClick={() => {
            viewRef.current.zoom = Math.min(MAX_ZOOM, viewRef.current.zoom * 1.5);
            draw();
          }}
        >
          <ZoomIn size={14} />
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// chrome
// ---------------------------------------------------------------------------

function ToolColumn({ tool, onTool }) {
  return (
    <div className="texture-tools">
      {TOOLS.map(({ id, label, Icon, key }) => (
        <button
          key={id}
          className={`texture-tool ${tool === id ? "active" : ""}`}
          title={key ? `${label} (${key})` : label}
          onClick={() => onTool(id)}
        >
          <Icon size={15} />
        </button>
      ))}
    </div>
  );
}

function ToolOptions(props) {
  const { tool } = props;
  const showBrush = PAINT_TOOLS.has(tool);
  const showTolerance = tool === "fill" || tool === "wand";
  const showShape = tool === "rect" || tool === "ellipse";
  const showSelect = SELECT_TOOLS.has(tool);

  return (
    <div className="texture-options">
      <div className="texture-swatches" title="Primary / secondary colour (X swaps)">
        <input type="color" value={props.color} onChange={(e) => props.onColor(e.target.value)} />
        <input type="color" value={props.altColor} onChange={(e) => props.onAltColor(e.target.value)} />
      </div>
      <Slider label="Alpha" value={props.alpha} min={0} max={255} step={1} onChange={props.onAlpha} />
      {showBrush && (
        <>
          <Slider label="Size" value={props.brushSize} min={1} max={400} step={1} onChange={props.onBrushSize} />
          <Slider label="Hardness" value={props.hardness} min={0} max={1} step={0.01} onChange={props.onHardness} />
        </>
      )}
      {(showBrush || tool === "fill" || tool === "gradient") && (
        <Slider label="Opacity" value={props.opacity} min={0} max={1} step={0.01} onChange={props.onOpacity} />
      )}
      {showTolerance && (
        <>
          <Slider label="Tolerance" value={props.tolerance} min={0} max={1} step={0.01} onChange={props.onTolerance} />
          <label className="texture-check">
            <input
              type="checkbox"
              checked={props.contiguous}
              onChange={(e) => props.onContiguous(e.target.checked)}
            />
            Contiguous
          </label>
        </>
      )}
      {showShape && (
        <label className="texture-check">
          <input type="checkbox" checked={props.shapeFill} onChange={(e) => props.onShapeFill(e.target.checked)} />
          Filled
        </label>
      )}
      {tool === "gradient" && (
        <select value={props.gradientType} onChange={(e) => props.onGradientType(e.target.value)}>
          <option value="linear">Linear</option>
          <option value="radial">Radial</option>
        </select>
      )}
      {showSelect && (
        <select value={props.selectMode} onChange={(e) => props.onSelectMode(e.target.value)}>
          <option value="replace">Replace</option>
          <option value="add">Add</option>
          <option value="subtract">Subtract</option>
          <option value="intersect">Intersect</option>
        </select>
      )}
      <span className="texture-options-spacer" />
      <button className="toolbar-btn tiny" onClick={props.onSelectAll}>
        All
      </button>
      <button className="toolbar-btn tiny" disabled={!props.hasSelection} onClick={props.onDeselect}>
        None
      </button>
      <button className="toolbar-btn tiny" onClick={props.onInvert}>
        Invert
      </button>
    </div>
  );
}

function Slider({ label, value, min, max, step, onChange }) {
  return (
    <label className="texture-slider">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <b>{step < 1 ? Number(value).toFixed(2) : Math.round(value)}</b>
    </label>
  );
}

function LayerColumn({
  doc, version, onSelect, onToggle, onLock, onRename, onOpacity, onBlend,
  onAdd, onDuplicate, onDelete, onMerge, onReorder,
}) {
  const active = doc.activeId;
  const rows = useMemo(() => [...doc.layers].reverse(), [doc, version]);
  const [renaming, setRenaming] = useState(null);

  return (
    <div className="texture-layers">
      <div className="texture-layers-head">
        <LayersIcon size={13} /> Layers
      </div>
      <div className="texture-layer-list">
        {rows.map((l) => (
          <div
            key={l.id}
            className={`texture-layer ${l.id === active ? "active" : ""}`}
            onClick={() => onSelect(l.id)}
          >
            <button
              className="texture-layer-eye"
              onClick={(e) => {
                e.stopPropagation();
                onToggle(l.id);
              }}
            >
              {l.visible === false ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
            {renaming === l.id ? (
              <input
                autoFocus
                defaultValue={l.name}
                onBlur={(e) => {
                  onRename(l.id, e.target.value.trim() || l.name);
                  setRenaming(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape") setRenaming(null);
                }}
              />
            ) : (
              <span className="texture-layer-name" onDoubleClick={() => setRenaming(l.id)}>
                {l.name}
              </span>
            )}
            <button
              className="texture-layer-lock"
              onClick={(e) => {
                e.stopPropagation();
                onLock(l.id);
              }}
            >
              {l.locked ? <Lock size={12} /> : <Unlock size={12} opacity={0.35} />}
            </button>
          </div>
        ))}
      </div>

      {(() => {
        const l = getLayer(doc, active);
        if (!l) return null;
        return (
          <div className="texture-layer-props">
            <select value={l.blend ?? "normal"} onChange={(e) => onBlend(l.id, e.target.value)}>
              {BLEND_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {mode}
                </option>
              ))}
            </select>
            <Slider
              label="Opacity"
              value={l.opacity ?? 1}
              min={0}
              max={1}
              step={0.01}
              onChange={(v) => onOpacity(l.id, v)}
            />
          </div>
        );
      })()}

      <div className="texture-layer-actions">
        <button className="toolbar-btn icon-only" title="New layer" onClick={onAdd}>
          <Plus size={13} />
        </button>
        <button className="toolbar-btn icon-only" title="Duplicate" onClick={() => onDuplicate(active)}>
          <Copy size={13} />
        </button>
        <button className="toolbar-btn icon-only" title="Move up" onClick={() => onReorder(active, +1)}>
          <ChevronUp size={13} />
        </button>
        <button className="toolbar-btn icon-only" title="Move down" onClick={() => onReorder(active, -1)}>
          <ChevronDown size={13} />
        </button>
        <button className="toolbar-btn icon-only" title="Merge down" onClick={() => onMerge(active)}>
          <LayersIcon size={13} />
        </button>
        <button className="toolbar-btn icon-only danger" title="Delete" onClick={() => onDelete(active)}>
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  );
}

function StatusBar({ doc, historyRef, version }) {
  // `version` is read only to re-render when the document changes underneath.
  void version;
  const undoLabel = historyRef.current?.undoLabel?.();
  if (!doc) return <div className="texture-status" />;
  return (
    <div className="texture-status">
      <span>
        {doc.width} × {doc.height}
      </span>
      <span>{doc.layers.length} layer{doc.layers.length === 1 ? "" : "s"}</span>
      {undoLabel && <span className="muted">Undo: {undoLabel}</span>}
    </div>
  );
}

function NewTextureDialog({ onCancel, onCreate }) {
  const [name, setName] = useState("NewTexture");
  const [width, setWidth] = useState(512);
  const [height, setHeight] = useState(512);
  const [transparent, setTransparent] = useState(true);
  const [background, setBackground] = useState("#ffffff");

  return (
    <div className="texture-dialog-backdrop" onPointerDown={onCancel}>
      <div className="texture-dialog" onPointerDown={(e) => e.stopPropagation()}>
        <h3>New Texture</h3>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="texture-dialog-row">
          <label>
            Width
            <input type="number" min={1} max={8192} value={width} onChange={(e) => setWidth(Number(e.target.value))} />
          </label>
          <label>
            Height
            <input type="number" min={1} max={8192} value={height} onChange={(e) => setHeight(Number(e.target.value))} />
          </label>
        </div>
        <div className="texture-dialog-presets">
          {[64, 128, 256, 512, 1024, 2048].map((size) => (
            <button
              key={size}
              className="toolbar-btn tiny"
              onClick={() => {
                setWidth(size);
                setHeight(size);
              }}
            >
              {size}
            </button>
          ))}
        </div>
        <label className="texture-check">
          <input type="checkbox" checked={transparent} onChange={(e) => setTransparent(e.target.checked)} />
          Transparent background
        </label>
        {!transparent && (
          <label>
            Background
            <input type="color" value={background} onChange={(e) => setBackground(e.target.value)} />
          </label>
        )}
        <div className="texture-dialog-actions">
          <button className="toolbar-btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="toolbar-btn primary"
            onClick={() =>
              onCreate({
                name,
                width: Math.max(1, Math.min(8192, Math.round(width))),
                height: Math.max(1, Math.min(8192, Math.round(height))),
                background: transparent ? null : background,
              })
            }
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
