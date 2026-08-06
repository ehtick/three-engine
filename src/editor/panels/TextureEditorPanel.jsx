import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Blend,
  Brush,
  ChevronDown,
  Check,
  ChevronUp,
  CircleDashed,
  CircleDot,
  Circle as CircleIcon,
  Copy,
  Droplet,
  Eraser,
  Eye,
  EyeOff,
  CircleSlash2,
  Feather,
  FolderOpen,
  Grid3x3,
  Image as ImageIcon,
  Lasso,
  Layers as LayersIcon,
  Lock,
  Maximize2,
  Minus,
  Move,
  PaintBucket,
  Pipette,
  Plus,
  Radius,
  Redo2,
  Repeat,
  Save,
  Scissors,
  Sparkles,
  Square,
  SquareDashed,
  SquareDot,
  SquareMinus,
  SquarePlus,
  Target,
  AlignCenter,
  AlignLeft,
  AlignRight,
  Trash2,
  Type,
  Undo2,
  Unlock,
  Wand2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useModulesStore, setModuleEnabled } from "../modules.js";
import { useProjectStore, basename } from "../store/projectStore.js";
import { useSelectionStore } from "../store/selectionStore.js";
import { extOf, ATLAS_EXTENSIONS, TEXTURE_EXTENSIONS } from "../assetLoader.js";
import { uniqueName } from "../assetOps.js";
import { pushToast } from "../toasts.js";
import { ContextMenu } from "../ContextMenu.jsx";
import { SelectField } from "../fields/SelectField.jsx";
import { TexturePicker } from "./TexturePicker.jsx";
import {
  NEW_TEXTURE_EVENT,
  TEXT_FONT_EVENT,
  consumeNewTextureRequest,
  currentTextToolFont,
  setTextToolFont,
} from "../textureEditorRequest.js";
import {
  createTextureAsset,
  openTextureDocument,
  readImageBuffer,
  saveTextureDocument,
  writeTextureMeta,
} from "../textureFile.js";
import {
  CanvasSizeDialog,
  OperationDialog,
  TransformDialog,
  OperationMenus,
  PackChannelsDialog,
  ResizeDialog,
  SwizzleDialog,
  anchorOffset,
} from "./TextureOps.jsx";
import { AtlasEditor } from "./AtlasEditor.jsx";
import { createAtlasForImage, findAtlasForImage } from "../atlasFile.js";
import { bufferToImageData } from "../texture/codecPng.js";
import { BLEND_MODES, compositeLayers, blendInto } from "../texture/blend.js";
import {
  clearRegion,
  cloneBuffer,
  copyMaskRegion,
  copyRegion,
  createBuffer,
  cropBuffer,
  opaqueBounds,
  parseColor,
  toHex,
} from "../texture/pixels.js";
import {
  activeLayer as findActiveLayer,
  addLayer,
  addLayerMask,
  applyLayerMask,
  cloneDocument,
  cropDocument,
  documentFromBuffer,
  duplicateLayer,
  flipDocument,
  getLayer,
  mergeDown,
  removeLayer,
  reorderLayer,
  resampleDocument,
  resizeDocumentCanvas,
  rotateDocument,
  trimDocument,
} from "../texture/layers.js";
import { adjustmentById, defaultParams, luminance } from "../texture/adjust.js";
import { transformBuffer, transformClips } from "../texture/transform.js";
import {
  LAYER_EFFECTS,
  defaultEffect,
  hasEffects,
  isFullyOpaque,
  renderLayerEffects,
} from "../texture/layerFx.js";
import { filterById } from "../texture/filters.js";
import {
  alphaFromLuminance,
  bleedAlpha,
  fillChannel,
  packChannels,
  premultiply,
  splitChannels,
  swizzle,
  unpremultiply,
} from "../texture/channels.js";
import {
  applyStroke,
  applyStrokeToMask,
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
  selectionBounds,
  wandSelection,
} from "../texture/selection.js";
import {
  captureRegion,
  createHistory,
  documentEntry,
  regionEntry,
} from "../texture/history.js";
import { rasterizeTextStroke } from "../texture/text.js";

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
  { id: "selectEllipse", label: "Ellipse Select", Icon: CircleDashed, key: "" },
  { id: "lasso", label: "Lasso", Icon: Lasso, key: "L" },
  { id: "wand", label: "Magic Wand", Icon: Wand2, key: "W" },
  { id: "eyedropper", label: "Eyedropper", Icon: Pipette, key: "I" },
  { id: "text", label: "Text", Icon: Type, key: "T" },
  { id: "move", label: "Move Layer", Icon: Move, key: "V" },
];

/** What the Text tool draws with when no project font is chosen. */
const SYSTEM_FONT_STACK = "system-ui, sans-serif";

/**
 * System stacks offered alongside the project's own fonts.
 *
 * Not a font picker over everything installed — the browser cannot enumerate
 * local fonts without a permission prompt, and a texture that renders with
 * whatever happens to be on the author's machine is a texture that looks
 * different on someone else's. These four are generic families every platform
 * resolves to something, and the honest answer for anything specific is to
 * import the font as a project asset.
 */
const SYSTEM_FONTS = [
  { value: SYSTEM_FONT_STACK, label: "System Sans" },
  { value: "Georgia, 'Times New Roman', serif", label: "System Serif" },
  { value: "ui-monospace, Consolas, monospace", label: "System Mono" },
  { value: "Impact, 'Arial Black', sans-serif", label: "Display" },
];

const SHAPE_TOOLS = new Set(["line", "rect", "ellipse"]);
const SELECT_TOOLS = new Set(["selectRect", "selectEllipse", "lasso", "wand"]);
const PAINT_TOOLS = new Set(["brush", "eraser", "line", "rect", "ellipse"]);

const TEXT_ALIGNS = [
  { id: "left", label: "Left", Icon: AlignLeft },
  { id: "center", label: "Center", Icon: AlignCenter },
  { id: "right", label: "Right", Icon: AlignRight },
];

const SELECT_MODES = [
  { id: "replace", label: "Replace", Icon: SquareDashed },
  { id: "add", label: "Add to selection", Icon: SquarePlus },
  { id: "subtract", label: "Subtract from selection", Icon: SquareMinus },
  { id: "intersect", label: "Intersect with selection", Icon: SquareDot },
];

const GRADIENT_TYPES = [
  { id: "linear", label: "Linear gradient", Icon: Minus },
  { id: "radial", label: "Radial gradient", Icon: Radius },
];

/** Icon segmented control — replaces a native <select> wherever the options are
 *  few and picturable. A dropdown here means an unstyleable OS popup for a
 *  choice that is one click as a row of buttons. */
function Segmented({ options, value, onChange }) {
  return (
    <div className="tx-group">
      {options.map(({ id, label, Icon }) => (
        <button
          key={id}
          className={`tx-btn icon ${value === id ? "on" : ""}`}
          title={label}
          onClick={() => onChange(id)}
        >
          <Icon size={14} />
        </button>
      ))}
    </div>
  );
}

const isImagePath = (path) => !!path && TEXTURE_EXTENSIONS.includes(extOf(path));
const isAtlasPath = (path) => !!path && ATLAS_EXTENSIONS.includes(extOf(path));

// ---------------------------------------------------------------------------

export function TextureEditorPanel() {
  const moduleOn = useModulesStore((s) => s.enabled.includes("texture-editor"));
  const assetPath = useSelectionStore((s) => s.assetPath);
  const hasProject = useProjectStore((s) => !!s.rootPath);

  // The panel keeps editing whatever it last opened. Clicking an entity in the
  // hierarchy clears `assetPath`, and blanking a half-finished painting because
  // the user glanced at the scene would be indefensible.
  const [path, setPath] = useState(null);
  const [atlasPath, setAtlasPath] = useState(null);
  const [mode, setMode] = useState("paint");
  const [slicing, setSlicing] = useState(false);

  /**
   * "Cut this sheet into sprites."
   *
   * The entry point that was missing: slicing lives on the Atlas surface, and
   * that surface only appears once some `.atlas` claims the image — so from a
   * plain spritesheet there was no way in at all. This creates the (empty)
   * atlas beside the image and switches to it, where Slice ▸ By Grid / By
   * Transparency does the actual work.
   */
  const sliceIntoSprites = useCallback(async () => {
    if (atlasPath) {
      setMode("atlas");
      return;
    }
    if (!path || slicing) return;
    setSlicing(true);
    try {
      const created = await createAtlasForImage(path);
      await useProjectStore.getState().refresh();
      setAtlasPath(created);
      setMode("atlas");
      pushToast({ title: `Created ${basename(created)}`, detail: "Use Slice to cut the sheet into regions" });
    } catch (error) {
      pushToast({ level: "error", title: "Could not create an atlas", detail: String(error?.message ?? error) });
    } finally {
      setSlicing(false);
    }
  }, [atlasPath, path, slicing]);

  useEffect(() => {
    if (isImagePath(assetPath)) {
      setPath(assetPath);
      // Drop the previous sheet's atlas immediately. The workspace looks up
      // this image's own atlas as it loads and reports it back; until then
      // there is none — leaving the old one attached would offer an Atlas tab,
      // and a "Sprites" button, for a completely different sheet.
      setAtlasPath(null);
      setMode("paint");
    } else if (isAtlasPath(assetPath)) {
      setAtlasPath(assetPath);
      setMode("atlas");
    }
  }, [assetPath]);

  if (!moduleOn) {
    return (
      <div className="panel-empty texture-editor-gate">
        <ImageIcon size={26} />
        <p>The Texture Editor module is not enabled for this project.</p>
        <button className="tx-btn primary" onClick={() => setModuleEnabled("texture-editor", true)}>
          Enable Texture Editor
        </button>
      </div>
    );
  }
  if (!hasProject) return <div className="panel-empty">Open a project to edit textures.</div>;

  // Paint and Atlas are modes of one panel over one sheet, not two panels: the
  // two are used in the same breath (slice what you just erased; paint inside
  // the atlas you just packed), and separate panels would mean saving and
  // reopening between every such step.
  return (
    <div className="texture-modes">
      {atlasPath && (
        <div className="texture-mode-tabs">
          <button className={mode === "paint" ? "active" : ""} disabled={!path} onClick={() => setMode("paint")}>
            Paint
          </button>
          <button className={mode === "atlas" ? "active" : ""} onClick={() => setMode("atlas")}>
            Atlas · {basename(atlasPath)}
          </button>
        </div>
      )}
      {mode === "atlas" && atlasPath ? (
        <AtlasEditor
          path={atlasPath}
          key={atlasPath}
          onOpenImage={(image) => {
            setPath(image);
            setMode("paint");
          }}
        />
      ) : (
        <TextureWorkspace
          path={path}
          onPathChange={setPath}
          onAtlasChange={setAtlasPath}
          onSliceIntoSprites={sliceIntoSprites}
          hasAtlas={!!atlasPath}
          key={path ?? "none"}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function TextureWorkspace({ path, onPathChange, onAtlasChange, onSliceIntoSprites, hasAtlas }) {
  const docRef = useRef(null);
  const [version, setVersion] = useState(0);
  const [status, setStatus] = useState(path ? "loading" : "empty");
  const [warning, setWarning] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  // Only when something actually ASKED for a new texture. Opening the panel
  // with nothing loaded used to raise the New dialog on its own, which puts a
  // modal in front of someone who came to open an existing file — the empty
  // state offers both routes instead, and neither is forced.
  const [showNew, setShowNew] = useState(() => consumeNewTextureRequest());
  const [showPicker, setShowPicker] = useState(false);
  useEffect(() => {
    const open = () => setShowNew(true);
    window.addEventListener(NEW_TEXTURE_EVENT, open);
    if (consumeNewTextureRequest()) setShowNew(true);
    return () => window.removeEventListener(NEW_TEXTURE_EVENT, open);
  }, []);

  const [tool, setTool] = useState("brush");
  // Painting targets the active layer's MASK instead of its pixels. Kept as a
  // panel-level flag rather than a tool, because every tool should work on a
  // mask — a mask is painted with the same brush, bucket and gradient.
  const [maskEditing, setMaskEditing] = useState(false);
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
  // Text tool. `textFont` is a project font asset path, or "" for a system
  // stack — the same distinction UI Text draws, and for the same reason: a
  // generated family that can't collide with anything installed locally.
  const [textFont, setTextFont] = useState(() => currentTextToolFont());
  const [textSize, setTextSize] = useState(48);
  const [textBold, setTextBold] = useState(false);
  const [textItalic, setTextItalic] = useState(false);
  const [textAlign, setTextAlign] = useState("left");
  const [textOutline, setTextOutline] = useState(0);
  const [textLineHeight, setTextLineHeight] = useState(1.2);
  const [projectFonts, setProjectFonts] = useState([]);
  const [textFontFamily, setTextFontFamily] = useState(SYSTEM_FONT_STACK);
  const [tiling, setTiling] = useState(false);

  const historyRef = useRef(createHistory());
  const selectionRef = useRef(null);
  const compositeRef = useRef(null);
  const [selectionVersion, setSelectionVersion] = useState(0);

  const bump = useCallback(() => setVersion((v) => v + 1), []);

  /**
   * Rendered layer effects, cached per layer.
   *
   * An outline or a shadow costs a dilate and a blur over the whole layer —
   * milliseconds, which is nothing once and unusable at pointer rate. The key
   * is the layer's `rev` (bumped when its pixels change) plus its effect
   * settings, so a stroke on layer A never recomputes layer B, and moving a
   * slider recomputes only what the slider changed.
   */
  const fxCacheRef = useRef(new Map());
  const renderEffects = useCallback((layer) => {
    if (!hasEffects(layer)) {
      fxCacheRef.current.delete(layer.id);
      return null;
    }
    const key = `${layer.rev ?? 0}:${JSON.stringify(layer.effects)}`;
    const cached = fxCacheRef.current.get(layer.id);
    if (cached?.key === key) return cached.value;
    const value = renderLayerEffects(layer.buffer, layer.effects);
    fxCacheRef.current.set(layer.id, { key, value });
    return value;
  }, []);

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
        compositeRef.current = compositeLayers(doc.layers, doc.width, doc.height, null, renderEffects);
        selectionRef.current = null;
        historyRef.current = createHistory();
        setWarning(warn);
        setDirty(false);
        setStatus("ready");
        bump();
        // Offer the Atlas tab when some atlas in this folder claims this image.
        // Matched by the atlas's own `image` field rather than by filename, so
        // `Sheet.atlas` finds `Sheet.png` and a hand-named one still resolves.
        findAtlasForImage(path)
          .then((found) => {
            if (!cancelled && found) onAtlasChange?.(found);
          })
          .catch(() => {});
      })
      .catch((error) => {
        if (cancelled) return;
        setStatus("error");
        setWarning(String(error?.message ?? error));
      });
    return () => {
      cancelled = true;
    };
  }, [path, bump, onAtlasChange, renderEffects]);

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
      const common = {
        offsetX: l.offset?.[0] ?? 0,
        offsetY: l.offset?.[1] ?? 0,
        opacity: l.opacity ?? 1,
        blend: l.blend ?? "normal",
        clip,
      };
      const fx = renderEffects(l);
      for (const under of fx?.under ?? []) blendInto(composite, under, common);
      blendInto(composite, l.buffer, { ...common, mask: l.mask ?? null });
      for (const over of fx?.over ?? []) blendInto(composite, over, common);
    }
  }, [renderEffects]);

  // Registered by the canvas. Every edit routes its dirty rectangle through
  // here so there is exactly one place that decides what gets re-uploaded.
  const invalidateRef = useRef(null);

  const markEdited = useCallback(
    (rect) => {
      // Bump the active layer's revision so its effects are re-rendered. Doing
      // it here rather than at every edit site is what keeps "did I remember to
      // invalidate?" from being a question anyone has to answer.
      const active = docRef.current ? findActiveLayer(docRef.current) : null;
      if (active) active.rev = (active.rev ?? 0) + 1;
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
              null,
              renderEffects,
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
    [pushHistory, markEdited, bump, renderEffects],
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
      await saveTextureDocument(path, docRef.current, { renderEffects });
      setDirty(false);
      pushToast({ title: `Saved ${basename(path)}` });
    } catch (error) {
      console.error(error);
      pushToast({ level: "error", title: "Save failed", detail: String(error?.message ?? error) });
    } finally {
      setSaving(false);
    }
  }, [path, saving, renderEffects]);

  // --- operations (Image / Adjust / Filter / Channels) --------------------

  /**
   * Runs a pixel operation on the active layer as ONE undo step.
   *
   * The whole layer is captured rather than a rectangle, because an adjustment
   * or a filter can touch anything — but only for these operations, which are
   * occasional. Strokes must never take this path (see history.js).
   */
  const runOnLayer = useCallback(
    (label, fn, { preview = false, base = null } = {}) => {
      const d = docRef.current;
      const target = d ? findActiveLayer(d) : null;
      if (!target) return false;
      if (target.locked) {
        pushToast({ title: "That layer is locked" });
        return false;
      }
      const rect = { x0: 0, y0: 0, x1: d.width, y1: d.height };
      // Restore BEFORE capturing the undo state. A dialog has been writing
      // previews into this layer; capturing first would record the last preview
      // as the "before", so undo would return to a state the user never chose.
      if (base) target.buffer.data.set(base.data);
      const before = preview ? null : captureRegion(target.buffer, rect);
      fn(target.buffer, selectionRef.current);
      if (!preview) pushHistory(regionEntry(target.buffer, rect, before, label));
      markEdited(null);
      return true;
    },
    [pushHistory, markEdited],
  );

  // A dialog previews by writing into the live layer, so it holds the layer's
  // pre-dialog pixels and restores them on every parameter change — and on
  // Cancel. Previewing on a copy and swapping at the end would be tidier and
  // would mean the preview isn't what gets applied.
  const [operation, setOperation] = useState(null);

  const openOperation = useCallback((next) => {
    const d = docRef.current;
    const target = d ? findActiveLayer(d) : null;
    if (!target) return;
    if (target.locked) {
      pushToast({ title: "That layer is locked" });
      return;
    }
    setOperation({ ...next, base: cloneBuffer(target.buffer) });
  }, []);

  const closeOperation = useCallback(
    (restore) => {
      setOperation((current) => {
        if (current?.base && restore) {
          const target = findActiveLayer(docRef.current);
          if (target) {
            target.buffer.data.set(current.base.data);
            markEdited(null);
          }
        }
        return null;
      });
    },
    [markEdited],
  );

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

  // --- clipboard ----------------------------------------------------------
  //
  // Its own clipboard, not the OS one. The system clipboard can only carry an
  // encoded image, so a round trip through it would flatten alpha precision
  // and lose the selection's own soft edge — the very thing the editor is
  // careful about everywhere else. It also means copying here cannot clobber
  // whatever the user has copied elsewhere in the editor.
  const clipboardRef = useRef(null);

  /** Pixels of the active layer inside the selection, with the selection's
   *  coverage folded into their alpha so a feathered edge survives the copy. */
  const captureSelection = useCallback(() => {
    const d = docRef.current;
    const layer = d ? findActiveLayer(d) : null;
    if (!layer) return null;
    const selection = selectionRef.current;
    const bounds = selection
      ? selectionBounds(selection, d.width, d.height)
      : { x: 0, y: 0, width: d.width, height: d.height };
    if (!bounds) return null;
    const buffer = cropBuffer(layer.buffer, bounds.x, bounds.y, bounds.width, bounds.height);
    if (selection) {
      for (let y = 0; y < bounds.height; y++) {
        for (let x = 0; x < bounds.width; x++) {
          const cover = selection[(bounds.y + y) * d.width + (bounds.x + x)] / 255;
          const at = (y * bounds.width + x) * 4 + 3;
          buffer.data[at] *= cover;
        }
      }
    }
    return { buffer, x: bounds.x, y: bounds.y };
  }, []);

  /** Clears the selected pixels of the active layer (alpha only — see draw.js
   *  on why an eraser must not pull colour toward black). */
  const eraseSelection = useCallback(
    (label = "Delete") => {
      const d = docRef.current;
      const layer = d ? findActiveLayer(d) : null;
      if (!layer || layer.locked) {
        if (layer?.locked) pushToast({ title: "That layer is locked" });
        return false;
      }
      const selection = selectionRef.current;
      const bounds = selection
        ? selectionBounds(selection, d.width, d.height)
        : { x: 0, y: 0, width: d.width, height: d.height };
      if (!bounds) return false;
      const rect = { x0: bounds.x, y0: bounds.y, x1: bounds.x + bounds.width, y1: bounds.y + bounds.height };
      const before = captureRegion(layer.buffer, rect);
      for (let y = bounds.y; y < bounds.y + bounds.height; y++) {
        for (let x = bounds.x; x < bounds.x + bounds.width; x++) {
          const cover = selection ? selection[y * d.width + x] / 255 : 1;
          if (cover <= 0) continue;
          layer.buffer.data[(y * d.width + x) * 4 + 3] *= 1 - cover;
        }
      }
      pushHistory(regionEntry(layer.buffer, rect, before, label));
      markEdited(null);
      return true;
    },
    [pushHistory, markEdited],
  );

  const copySelection = useCallback(() => {
    const captured = captureSelection();
    if (!captured) return false;
    clipboardRef.current = captured;
    pushToast({ title: `Copied ${captured.buffer.width} × ${captured.buffer.height}` });
    return true;
  }, [captureSelection]);

  const cutSelection = useCallback(() => {
    if (!copySelection()) return;
    eraseSelection("Cut");
  }, [copySelection, eraseSelection]);

  /** Drops a buffer onto a brand-new layer at a document position. Paste and
   *  "layer via copy" are the same operation with a different source. */
  const dropOntoNewLayer = useCallback(
    (source, label, name) => {
      if (!source) return;
      withDocumentSnapshot(label, (d) => {
        const layer = addLayer(d, { name });
        blendInto(layer.buffer, source.buffer, { offsetX: source.x, offsetY: source.y });
      });
      // Photoshop switches to Move after a paste, and it is right to: the thing
      // you just made is floating and the next action is almost always to place
      // it. Landing in Brush instead means the first drag paints over it.
      setTool("move");
    },
    [withDocumentSnapshot],
  );

  const pasteAsLayer = useCallback(() => {
    if (!clipboardRef.current) {
      pushToast({ title: "Nothing copied yet" });
      return;
    }
    dropOntoNewLayer(clipboardRef.current, "Paste", "Pasted");
  }, [dropOntoNewLayer]);

  /** Ctrl+J — the selection straight onto a new layer, no clipboard involved,
   *  so it never disturbs what you copied earlier. */
  const layerViaCopy = useCallback(
    (cut = false) => {
      const captured = captureSelection();
      if (!captured) return;
      if (cut && !eraseSelection("Layer via Cut")) return;
      dropOntoNewLayer(captured, cut ? "Layer via Cut" : "Layer via Copy", cut ? "Cut layer" : "Copied layer");
    },
    [captureSelection, eraseSelection, dropOntoNewLayer],
  );

  /**
   * Transforms the active layer, or just the selected area of it.
   *
   * With a selection, the transform is applied to the selected pixels and
   * dropped back in place with the rest of the layer left alone — which is what
   * "transform the selection" means everywhere else, and the reason it is the
   * same code path rather than a second tool.
   */
  const transformLayer = useCallback(
    (label, spec, { base = null, preview = false } = {}) => {
      const d = docRef.current;
      const target = d ? findActiveLayer(d) : null;
      if (!target || target.locked) return;
      const source = base ?? cloneBuffer(target.buffer);
      const rect = { x0: 0, y0: 0, x1: d.width, y1: d.height };
      const before = preview ? null : captureRegion(target.buffer, rect);
      const selection = selectionRef.current;

      const moved = transformBuffer(source, { ...spec, width: d.width, height: d.height });
      if (!selection) {
        target.buffer.data.set(moved.data);
      } else {
        // Lift the selected pixels, transform them, and drop them back into a
        // hole punched where they were. Transforming the whole layer and then
        // masking would move the unselected pixels too and mask the evidence.
        target.buffer.data.set(source.data);
        for (let i = 0; i < selection.length; i++) {
          const cover = selection[i] / 255;
          if (cover <= 0) continue;
          target.buffer.data[i * 4 + 3] *= 1 - cover;
        }
        const lifted = cloneBuffer(source);
        for (let i = 0; i < selection.length; i++) lifted.data[i * 4 + 3] *= selection[i] / 255;
        const liftedMoved = transformBuffer(lifted, { ...spec, width: d.width, height: d.height });
        blendInto(target.buffer, liftedMoved, {});
      }

      if (!preview) pushHistory(regionEntry(target.buffer, rect, before, label));
      target.rev = (target.rev ?? 0) + 1;
      markEdited(null);
    },
    [pushHistory, markEdited],
  );

  // --- the operation menus -----------------------------------------------
  const [dialog, setDialog] = useState(null);
  // Right-click on the canvas. The shortcuts are the fast path; this is how
  // anyone finds out they exist.
  const [canvasMenu, setCanvasMenu] = useState(null);

  const runCommand = useCallback(
    (kind, payload) => {
      const d = docRef.current;
      if (!d) return;
      switch (kind) {
        case "resize":
        case "canvas":
        case "pack":
        case "swizzle":
          setDialog({ kind });
          return;
        case "transformLayer": {
          const target = findActiveLayer(d);
          if (!target || target.locked) {
            if (target?.locked) pushToast({ title: "That layer is locked" });
            return;
          }
          // Snapshot before the first preview: every preview transforms from
          // THIS, never from the previous preview, or scaling to 50% twice in
          // a row would land at 25% without anyone asking for it.
          setDialog({ kind: "transform", base: cloneBuffer(target.buffer) });
          return;
        }
        case "flipLayer":
          transformLayer("Flip Layer", {
            scaleX: payload === "horizontal" ? -1 : 1,
            scaleY: payload === "vertical" ? -1 : 1,
            filter: "nearest",
          });
          return;
        case "rotateLayer":
          // Quarter turns are exact, so they take the nearest sampler — a
          // bilinear 90° rotation resamples every texel for no reason and
          // softens pixel art that should have come through untouched.
          transformLayer("Rotate Layer", { angle: payload, filter: "nearest" });
          return;
        case "fitLayer": {
          const target = findActiveLayer(d);
          const bounds = target ? opaqueBounds(target.buffer) : null;
          if (!bounds) {
            pushToast({ title: "That layer is empty" });
            return;
          }
          const scale = Math.min(d.width / bounds.width, d.height / bounds.height);
          transformLayer("Fit Layer", {
            scaleX: scale,
            scaleY: scale,
            // The content is scaled about the canvas centre, so anything not
            // already centred has to be brought there first — otherwise "fit"
            // scales a corner-hugging logo off the edge.
            offsetX: (d.width / 2 - (bounds.x + bounds.width / 2)) * scale,
            offsetY: (d.height / 2 - (bounds.y + bounds.height / 2)) * scale,
          });
          return;
        }
        case "centreLayer": {
          const target = findActiveLayer(d);
          const bounds = target ? opaqueBounds(target.buffer) : null;
          if (!bounds) {
            pushToast({ title: "That layer is empty" });
            return;
          }
          transformLayer("Centre Layer", {
            offsetX: d.width / 2 - (bounds.x + bounds.width / 2),
            offsetY: d.height / 2 - (bounds.y + bounds.height / 2),
          });
          return;
        }
        case "adjust":
        case "filter": {
          const spec = kind === "adjust" ? adjustmentById(payload) : filterById(payload);
          if (!spec) return;
          if (!spec.params.length) {
            runOnLayer(spec.label, (buffer, selection) =>
              spec.apply(buffer, defaultParams(spec), spec.wholeLayer ? null : selection),
            );
            return;
          }
          openOperation({ kind, spec });
          return;
        }
        case "flip":
          withDocumentSnapshot(payload === "vertical" ? "Flip Vertical" : "Flip Horizontal", (doc) =>
            flipDocument(doc, payload),
          );
          return;
        case "rotate":
          withDocumentSnapshot("Rotate", (doc) => rotateDocument(doc, payload));
          deselect();
          return;
        case "trim": {
          let kept = null;
          withDocumentSnapshot("Trim", (doc) => {
            kept = trimDocument(doc);
          });
          deselect();
          pushToast({
            title: kept ? `Trimmed to ${kept.width} × ${kept.height}` : "Nothing to trim",
          });
          return;
        }
        case "cropToSelection": {
          const bounds = selectionRef.current
            ? selectionBounds(selectionRef.current, d.width, d.height)
            : null;
          if (!bounds) {
            pushToast({ title: "Make a selection first" });
            return;
          }
          withDocumentSnapshot("Crop", (doc) => cropDocument(doc, bounds.x, bounds.y, bounds.width, bounds.height));
          deselect();
          return;
        }
        case "split":
          withDocumentSnapshot("Split Channels", (doc) => {
            const source = findActiveLayer(doc);
            if (!source) return;
            const parts = splitChannels(source.buffer);
            // Only the first is left visible: four stacked opaque greyscale
            // layers would show nothing but the top one, which reads as the
            // command having done something wrong.
            for (const name of ["r", "g", "b", "a"]) {
              addLayer(doc, {
                name: `${source.name} ${name.toUpperCase()}`,
                buffer: parts[name],
                visible: name === "r",
              });
            }
          });
          return;
        case "alphaFromLuminance":
          runOnLayer("Alpha from Luminance", (buffer) => alphaFromLuminance(buffer, { invert: !!payload }));
          return;
        case "makeOpaque":
          runOnLayer("Make Opaque", (buffer) => fillChannel(buffer, "a", 255));
          return;
        case "bleed":
          runOnLayer("Bleed Colour", (buffer) => bleedAlpha(buffer, { distance: 4 }));
          return;
        case "premultiply":
          runOnLayer("Premultiply Alpha", (buffer) => premultiply(buffer));
          return;
        case "unpremultiply":
          runOnLayer("Unpremultiply Alpha", (buffer) => unpremultiply(buffer));
          return;
        default:
      }
    },
    [runOnLayer, openOperation, withDocumentSnapshot, deselect, transformLayer],
  );

  /** Pack Channels writes a NEW asset rather than replacing the open document:
   *  the sources are usually four other files, and silently overwriting whatever
   *  happened to be open would be the wrong side of destructive. */
  const packChannelsToAsset = useCallback(
    async ({ slots, name, width, height }) => {
      const { currentPath, entries, refresh } = useProjectStore.getState();
      if (!currentPath) return;
      try {
        const channels = {};
        for (const key of ["r", "g", "b", "a"]) {
          const slot = slots[key];
          channels[key] = slot.path
            ? { buffer: await readImageBuffer(slot.path), source: slot.source, invert: slot.invert }
            : { constant: slot.constant };
        }
        const packed = packChannels({ width, height, channels });
        const fileName = uniqueName(name.endsWith(".png") ? name : `${name}.png`, entries);
        const target = `${currentPath.replace(/[\\/]$/, "")}/${fileName}`;
        await saveTextureDocument(target, documentFromBuffer(packed), { writeSidecar: false });
        // A packed map is data, not colour — tagging it linear here saves the
        // "why is my roughness washed out" bug report later.
        await writeTextureMeta(target, { colorSpace: "linear" });
        await refresh();
        setDialog(null);
        pushToast({ title: `Packed ${fileName}` });
        useSelectionStore.getState().selectAsset(target);
        onPathChange(target);
      } catch (error) {
        console.error(error);
        pushToast({ level: "error", title: "Pack failed", detail: String(error?.message ?? error) });
      }
    },
    [onPathChange],
  );

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
      if (ctrl && key === "c") {
        event.preventDefault();
        event.stopPropagation();
        copySelection();
        return;
      }
      if (ctrl && key === "x") {
        event.preventDefault();
        event.stopPropagation();
        cutSelection();
        return;
      }
      if (ctrl && key === "v") {
        event.preventDefault();
        event.stopPropagation();
        pasteAsLayer();
        return;
      }
      if (ctrl && key === "j") {
        event.preventDefault();
        event.stopPropagation();
        layerViaCopy(event.shiftKey);
        return;
      }
      if (ctrl) return;

      if (key === "delete" || key === "backspace") {
        event.preventDefault();
        event.stopPropagation();
        eraseSelection();
        return;
      }

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
  }, [
    undo, redo, save, selectAll, deselect, invert, color, altColor,
    copySelection, cutSelection, pasteAsLayer, layerViaCopy, eraseSelection,
  ]);

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
    // The Text tool's style, as one object so the canvas can hand it straight
    // to the rasterizer.
    text: {
      fontFamily: textFontFamily,
      fontSize: textSize,
      bold: textBold,
      italic: textItalic,
      align: textAlign,
      outlineWidth: textOutline,
      lineHeight: textLineHeight,
    },
  };
  // The project's own fonts, for the Text tool's picker. Refreshed with the
  // project so a font imported from the Fonts panel while this is open shows
  // up without a reload.
  const projectRoot = useProjectStore((state) => state.rootPath);
  const projectVersion = useProjectStore((state) => state.entries);
  useEffect(() => {
    let live = true;
    if (!projectRoot) {
      setProjectFonts([]);
      return undefined;
    }
    (async () => {
      const { listProjectAssets, FONT_EXTENSIONS } = await import("../assetLoader.js");
      const paths = await listProjectAssets(projectRoot, FONT_EXTENSIONS, 6);
      if (live) setProjectFonts(paths);
    })().catch(() => {});
    return () => {
      live = false;
    };
  }, [projectRoot, projectVersion]);

  // The Inspector's "Use in Texture Editor" action sets the font through a
  // latch, because it also opens this panel and the panel may not exist yet
  // when it fires (see textureEditorRequest.js).
  useEffect(() => {
    const onFont = (event) => setTextFont(event.detail ?? "");
    window.addEventListener(TEXT_FONT_EVENT, onFont);
    return () => window.removeEventListener(TEXT_FONT_EVENT, onFont);
  }, []);

  /**
   * Resolves the chosen font to a CSS family the canvas can actually use.
   *
   * A project font has to be registered with the platform before `ctx.font`
   * will honour it, and rasterizing one texel too early silently falls back to
   * the default face — which looks like the wrong font was picked rather than
   * like a race. So the family only changes once the load has resolved.
   */
  useEffect(() => {
    let live = true;
    if (!textFont) {
      setTextFontFamily(SYSTEM_FONT_STACK);
      return undefined;
    }
    import("../../engine/ui/fontAsset.js")
      .then(({ ensureFontLoaded }) => ensureFontLoaded(textFont))
      .then((entry) => {
        if (live && entry?.loaded) setTextFontFamily(`"${entry.family}", ${SYSTEM_FONT_STACK}`);
      })
      .catch((error) => {
        console.error(`Couldn't load font "${basename(textFont)}": ${error?.message ?? error}`);
        if (live) setTextFontFamily(SYSTEM_FONT_STACK);
      });
    return () => {
      live = false;
    };
  }, [textFont]);

  // Leaving mask mode when the layer's mask goes away — otherwise the brush
  // silently paints colour where the user expects to be shaping visibility.
  // In an effect, not during render: a setState in the render body of a
  // component that renders on every pointer move is an infinite loop waiting
  // for the right sequence of edits.
  const activeHasMask = !!(doc && findActiveLayer(doc)?.mask);
  useEffect(() => {
    if (maskEditing && !activeHasMask) setMaskEditing(false);
  }, [maskEditing, activeHasMask]);

  return (
    <div className="texture-editor" ref={rootRef} tabIndex={-1}>
      <div className="texture-toolbar">
        <button className="tx-btn" title="Open a texture from this project…" onClick={() => setShowPicker(true)}>
          <FolderOpen size={14} />
          <span className="tx-label">Open</span>
        </button>
        <button className="tx-btn" title="New texture…" onClick={() => setShowNew(true)}>
          <Plus size={14} />
          <span className="tx-label">New</span>
        </button>
        <button className="tx-btn" title="Save (Ctrl+S)" disabled={!dirty || saving || !path} onClick={save}>
          <Save size={14} />
          <span className="tx-label">{saving ? "Saving…" : "Save"}</span>
        </button>
        <span className="tx-sep" />
        <button className="tx-btn quiet icon" title="Undo (Ctrl+Z)" onClick={undo}>
          <Undo2 size={14} />
        </button>
        <button className="tx-btn quiet icon" title="Redo (Ctrl+Shift+Z)" onClick={redo}>
          <Redo2 size={14} />
        </button>
        <span className="tx-sep" />
        <OperationMenus
          onCommand={runCommand}
          hasSelection={!!selectionRef.current}
          disabled={status !== "ready"}
        />
        <span className="tx-sep" />
        <button
          className={`tx-btn quiet icon ${tiling ? "on" : ""}`}
          title="Tiling preview — repeat the texture to check its seams"
          onClick={() => setTiling((t) => !t)}
        >
          <Grid3x3 size={14} />
        </button>
        {/* Only offered when there is no atlas yet: once one exists the mode
            tabs above are the way back to it, and two routes to the same place
            is one more control than the toolbar needs. */}
        {!hasAtlas && (
          <button
            className="tx-btn"
            disabled={status !== "ready"}
            title="Cut this sheet into sprite regions — creates a .atlas beside it"
            onClick={onSliceIntoSprites}
          >
            <Scissors size={14} />
            <span className="tx-label">Slice</span>
          </button>
        )}
        <span className="tx-spacer" />
        <span className="tx-title" title={path ?? ""}>
          {path ? basename(path) : "No texture open"}
          {dirty ? <b>•</b> : null}
        </span>
      </div>

      {warning && (
        <div className="texture-warning">
          {warning}
          <span className="tx-spacer" />
          <button className="tx-icon-btn" title="Dismiss" onClick={() => setWarning(null)}>
            <X size={13} />
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
            textFont={textFont}
            onTextFont={(value) => {
              setTextFont(value);
              setTextToolFont(value);
            }}
            projectFonts={projectFonts}
            textSize={textSize}
            onTextSize={setTextSize}
            textBold={textBold}
            onTextBold={setTextBold}
            textItalic={textItalic}
            onTextItalic={setTextItalic}
            textAlign={textAlign}
            onTextAlign={setTextAlign}
            textOutline={textOutline}
            onTextOutline={setTextOutline}
            textLineHeight={textLineHeight}
            onTextLineHeight={setTextLineHeight}
          />

          {status === "loading" && <div className="panel-empty">Loading texture…</div>}
          {status === "error" && <div className="panel-empty">Could not open this texture.</div>}
          {status === "empty" && (
            <div className="panel-empty texture-empty">
              <ImageIcon size={28} />
              <p>No texture open.</p>
              <div className="tx-row">
                <button className="tx-btn primary" onClick={() => setShowPicker(true)}>
                  <FolderOpen size={14} />
                  <span>Open Texture…</span>
                </button>
                <button className="tx-btn" onClick={() => setShowNew(true)}>
                  <Plus size={14} />
                  <span>New Texture…</span>
                </button>
              </div>
              <p className="tx-hint">Or double-click any image in the Assets panel.</p>
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
              maskEditing={maskEditing}
              invalidateRef={invalidateRef}
              hasClipboard={!!clipboardRef.current}
              onContextMenu={(at) => setCanvasMenu(at)}
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
            maskEditing={maskEditing}
            onMaskEditing={setMaskEditing}
            onAddMask={(id, fromSelection) =>
              withDocumentSnapshot(fromSelection ? "Mask from Selection" : "Add Mask", (d) => {
                const l = getLayer(d, id);
                if (l) {
                  addLayerMask(l, d.width, d.height, {
                    fromSelection: fromSelection ? selectionRef.current : null,
                  });
                }
              })
            }
            onDeleteMask={(id) =>
              withDocumentSnapshot("Delete Mask", (d) => {
                const l = getLayer(d, id);
                if (l) l.mask = null;
              })
            }
            onApplyMask={(id) =>
              withDocumentSnapshot("Apply Mask", (d) => {
                const l = getLayer(d, id);
                if (l) applyLayerMask(l);
              })
            }
            hasSelection={!!selectionRef.current}
            onAddEffect={(id, effectId) =>
              withDocumentSnapshot("Add Effect", (d) => {
                const l = getLayer(d, id);
                if (!l || l.effects.some((e) => e.id === effectId)) return;
                l.effects = [...l.effects, defaultEffect(effectId)];
              })
            }
            onChangeEffect={(id, effectId, patch) => {
              const l = getLayer(doc, id);
              if (!l) return;
              l.effects = l.effects.map((e) => (e.id === effectId ? { ...e, ...patch } : e));
              markEdited(null);
            }}
            onRemoveEffect={(id, effectId) =>
              withDocumentSnapshot("Remove Effect", (d) => {
                const l = getLayer(d, id);
                if (l) l.effects = l.effects.filter((e) => e.id !== effectId);
              })
            }
            onAdd={() => withDocumentSnapshot("Add Layer", (d) => addLayer(d, { name: `Layer ${d.layers.length}` }))}
            onDuplicate={(id) => withDocumentSnapshot("Duplicate Layer", (d) => duplicateLayer(d, id))}
            onDelete={(id) => withDocumentSnapshot("Delete Layer", (d) => removeLayer(d, id))}
            onMerge={(id) => withDocumentSnapshot("Merge Down", (d) => mergeDown(d, id))}
            onReorder={(id, delta) => withDocumentSnapshot("Reorder Layer", (d) => reorderLayer(d, id, delta))}
          />
        )}
      </div>

      <StatusBar doc={doc} historyRef={historyRef} version={version} />

      {canvasMenu && (
        <ContextMenu
          x={canvasMenu.x}
          y={canvasMenu.y}
          onClose={() => setCanvasMenu(null)}
          items={[
            { label: "Copy", shortcut: "Ctrl+C", action: copySelection },
            { label: "Cut", shortcut: "Ctrl+X", action: cutSelection },
            { label: "Paste as Layer", shortcut: "Ctrl+V", disabled: !clipboardRef.current, action: pasteAsLayer },
            { separator: true },
            {
              label: "Layer via Copy",
              shortcut: "Ctrl+J",
              hint: "The selection on a new layer, leaving this one intact",
              action: () => layerViaCopy(false),
            },
            { label: "Layer via Cut", shortcut: "Ctrl+Shift+J", action: () => layerViaCopy(true) },
            { separator: true },
            { label: "Delete Selected", shortcut: "Del", action: () => eraseSelection() },
            { separator: true },
            { label: "Select All", shortcut: "Ctrl+A", action: selectAll },
            { label: "Deselect", shortcut: "Ctrl+D", disabled: !selectionRef.current, action: deselect },
            { label: "Invert Selection", shortcut: "Ctrl+I", action: invert },
            {
              label: "Crop to Selection",
              disabled: !selectionRef.current,
              action: () => runCommand("cropToSelection"),
            },
          ]}
        />
      )}

      {showPicker && (
        <TexturePicker
          onCancel={() => setShowPicker(false)}
          onPick={(picked) => {
            setShowPicker(false);
            // Through the selection store, so the Assets panel and the asset
            // inspector follow along — opening a texture here should leave the
            // rest of the editor pointing at the same file.
            useSelectionStore.getState().selectAsset(picked);
            onPathChange(picked);
          }}
        />
      )}

      {showNew && <NewTextureDialog onCancel={() => setShowNew(false)} onCreate={createNew} />}

      {operation && (
        <OperationDialog
          spec={operation.spec}
          docSize={{ width: doc?.width ?? 0, height: doc?.height ?? 0 }}
          onPreview={(params) =>
            runOnLayer(operation.spec.label, (buffer, selection) =>
              operation.spec.apply(buffer, params, operation.spec.wholeLayer ? null : selection),
            { preview: true, base: operation.base })
          }
          onApply={(params) => {
            // Applied from the ORIGINAL pixels, not on top of the preview —
            // otherwise a blur previewed three times is applied three times.
            runOnLayer(operation.spec.label, (buffer, selection) =>
              operation.spec.apply(buffer, params, operation.spec.wholeLayer ? null : selection),
            { base: operation.base });
            closeOperation(false);
          }}
          onCancel={() => closeOperation(true)}
        />
      )}

      {dialog?.kind === "resize" && (
        <ResizeDialog
          docSize={{ width: doc.width, height: doc.height }}
          onCancel={() => setDialog(null)}
          onApply={({ width, height, filter }) => {
            withDocumentSnapshot("Resize Image", (d) => resampleDocument(d, width, height, { filter }));
            deselect();
            setDialog(null);
          }}
        />
      )}

      {dialog?.kind === "canvas" && (
        <CanvasSizeDialog
          docSize={{ width: doc.width, height: doc.height }}
          onCancel={() => setDialog(null)}
          onApply={({ width, height, anchor }) => {
            const offset = anchorOffset(anchor, { width: doc.width, height: doc.height }, { width, height });
            withDocumentSnapshot("Canvas Size", (d) => resizeDocumentCanvas(d, width, height, offset.x, offset.y));
            deselect();
            setDialog(null);
          }}
        />
      )}

      {dialog?.kind === "transform" && (
        <TransformDialog
          scope={selectionRef.current ? "Selection" : "Layer"}
          clipsAt={(spec) => transformClips(doc.width, doc.height, spec)}
          onPreview={(spec) => transformLayer("Transform", spec, { base: dialog.base, preview: true })}
          onApply={(spec) => {
            transformLayer("Transform Layer", spec, { base: dialog.base });
            setDialog(null);
          }}
          onCancel={() => {
            // Put the pre-dialog pixels back: previewing wrote into the live
            // layer so that what you see is exactly what Apply commits.
            const target = findActiveLayer(docRef.current);
            if (target && dialog.base) target.buffer.data.set(dialog.base.data);
            markEdited(null);
            setDialog(null);
          }}
        />
      )}

      {dialog?.kind === "swizzle" && (
        <SwizzleDialog
          onCancel={() => setDialog(null)}
          onApply={({ mapping, invert: inverted }) => {
            runOnLayer("Swizzle Channels", (buffer) => swizzle(buffer, mapping, { invert: inverted }));
            setDialog(null);
          }}
        />
      )}

      {dialog?.kind === "pack" && (
        <PackChannelsDialog
          docSize={{ width: doc.width, height: doc.height }}
          onCancel={() => setDialog(null)}
          onApply={packChannelsToAsset}
        />
      )}
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
  maskEditing,
  invalidateRef,
  hasClipboard,
  onContextMenu,
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
  const readoutRef = useRef(null);
  void hasClipboard;
  // How far the ants have crawled, in dash units. A ref because it advances
  // every frame and must never trigger a render.
  const antsOffsetRef = useRef(0);
  // Space is the universal "pan without changing tools" modifier. Held in a ref
  // and mirrored onto the wrapper as a class, so the cursor changes without a
  // React render on every keypress.
  const spaceRef = useRef(false);

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

  // Whether the view has ever been framed against a REAL layout. A panel can
  // mount with a zero-sized wrapper — a dock tab that is not the active one, or
  // simply the first paint before layout settles — and fitting against 0
  // clamps the zoom to its minimum and parks the image in the corner. That is
  // exactly the "my texture isn't there" symptom, and it never recovers on its
  // own because the resize observer only ever redrew.
  const fittedRef = useRef(false);
  // Whether the user has zoomed or panned since the last fit, and the size the
  // view was last laid out at.
  const viewTouchedRef = useRef(false);
  const sizeRef = useRef(null);

  const fit = useCallback(() => {
    const wrap = wrapRef.current;
    if (!wrap) return false;
    const width = wrap.clientWidth;
    const height = wrap.clientHeight;
    if (width < 8 || height < 8) return false;
    const zoom = Math.max(MIN_ZOOM, Math.min((width - 48) / doc.width, (height - 48) / doc.height, 8));
    viewRef.current = {
      zoom,
      x: width / 2 - (doc.width * zoom) / 2,
      y: height / 2 - (doc.height * zoom) / 2,
    };
    fittedRef.current = true;
    // A fit is the auto view again: a later resize may re-fit freely.
    viewTouchedRef.current = false;
    sizeRef.current = { width, height };
    bumpView((v) => v + 1);
    return true;
  }, [doc.width, doc.height]);


  // A new document is a new framing; anything else keeps the user's view.
  useEffect(() => {
    fittedRef.current = false;
    fit();
  }, [fit]);

  // The selection's boundary as line SEGMENTS in document space, rebuilt only
  // when the selection changes.
  //
  // Not a bitmap. Drawing an edge mask and scaling it to the view makes the
  // outline `zoom` pixels thick — a chunky white wall at 8x rather than a
  // hairline — and a bitmap cannot be dashed. Segments stroke at exactly 1px
  // at any zoom and take `setLineDash` directly, which is what makes real
  // marching ants possible for a lasso or a wand result that has no path.
  //
  // Collinear edges are merged into runs, so a rectangular marquee is 4 lines
  // rather than a few hundred one-texel ticks.
  useEffect(() => {
    const mask = selectionRef.current;
    if (!mask) {
      outlineRef.current = null;
      return;
    }
    const { width, height } = doc;
    // The 50% coverage line is the boundary — a feathered selection has no
    // single edge, and this is the one every editor draws.
    const inside = (x, y) => x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] >= 128;
    const segments = [];

    for (let y = 0; y <= height; y++) {
      let run = -1;
      for (let x = 0; x <= width; x++) {
        const edge = x < width && inside(x, y - 1) !== inside(x, y);
        if (edge && run < 0) run = x;
        else if (!edge && run >= 0) {
          segments.push([run, y, x, y]);
          run = -1;
        }
      }
    }
    for (let x = 0; x <= width; x++) {
      let run = -1;
      for (let y = 0; y <= height; y++) {
        const edge = y < height && inside(x - 1, y) !== inside(x, y);
        if (edge && run < 0) run = y;
        else if (!edge && run >= 0) {
          segments.push([x, run, x, y]);
          run = -1;
        }
      }
    }
    outlineRef.current = segments.length ? segments : null;
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

    // Marching ants: two dashed passes, black then white offset by one dash, so
    // the outline reads on any artwork — a single white dash disappears over
    // white pixels, which is most of what gets selected.
    if (outlineRef.current) {
      const offset = antsOffsetRef.current;
      const path = () => {
        ctx.beginPath();
        for (const [x0, y0, x1, y1] of outlineRef.current) {
          // The half-pixel keeps a 1px stroke on the pixel rather than
          // straddling two and rendering as a 2px blur.
          ctx.moveTo(Math.round(x + x0 * zoom) + 0.5, Math.round(y + y0 * zoom) + 0.5);
          ctx.lineTo(Math.round(x + x1 * zoom) + 0.5, Math.round(y + y1 * zoom) + 0.5);
        }
        ctx.stroke();
      };
      ctx.save();
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.lineDashOffset = -offset;
      ctx.strokeStyle = "rgba(0,0,0,0.9)";
      path();
      ctx.lineDashOffset = -offset + 4;
      ctx.strokeStyle = "#ffffff";
      path();
      ctx.restore();
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

    // The lasso path, live. Without this the tool is invisible until the
    // pointer is released, which is indistinguishable from it not working.
    if (gesture?.kind === "lasso" && gesture.points.length > 1) {
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(x + gesture.points[0][0] * zoom, y + gesture.points[0][1] * zoom);
      for (let i = 1; i < gesture.points.length; i++) {
        ctx.lineTo(x + gesture.points[i][0] * zoom, y + gesture.points[i][1] * zoom);
      }
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Brush cursor: a true-size ring is the only reliable way to know what a
    // stroke will cover before committing to it.
    const cursor = cursorRef.current;
    const tp = toolRef.current;

    // Written straight into the DOM rather than through state: this updates on
    // every pointer move, and a React render per move to print two numbers is
    // exactly the cost the whole canvas is built to avoid.
    if (readoutRef.current) {
      const at = cursor.inside
        ? `${Math.floor(cursor.x)}, ${Math.floor(cursor.y)}`
        : `${doc.width} × ${doc.height}`;
      readoutRef.current.textContent = `${at}   ${Math.round(zoom * 100)}%`;
    }
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

  useEffect(() => {
    const set = (down) => (event) => {
      if (event.code !== "Space" && event.key !== " ") return;
      const target = event.target;
      if (target instanceof HTMLElement && /input|textarea|select/i.test(target.tagName)) return;
      if (spaceRef.current === down) return;
      spaceRef.current = down;
      wrapRef.current?.classList.toggle("panning", down);
      // Space scrolls the page by default, which inside a docked panel means
      // the whole editor lurches while the user is trying to pan.
      if (down) event.preventDefault();
    };
    const onDown = set(true);
    const onUp = set(false);
    const onBlur = () => {
      spaceRef.current = false;
      wrapRef.current?.classList.remove("panning");
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

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

  // Crawl the ants. Runs ONLY while there is a selection — an idle canvas must
  // not hold a repaint loop open, and this is the one thing on screen that has
  // to animate without anything having happened.
  useEffect(() => {
    if (!selectionRef.current) return undefined;
    let raf = 0;
    let last = 0;
    const tick = (now) => {
      raf = requestAnimationFrame(tick);
      // ~30fps is plenty for a crawl and halves the cost of holding the loop.
      if (now - last < 33) return;
      const dt = last ? Math.min(0.2, (now - last) / 1000) : 0;
      last = now;
      // 8px per second — one full dash cycle a second: fast enough to read as
      // motion, slow enough not to fight the artwork for attention.
      antsOffsetRef.current = (antsOffsetRef.current + dt * 8) % 8;
      draw();
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [selectionVersion, selectionRef, draw]);

  /**
   * Keeps the view sensible when the panel changes size.
   *
   * Maximizing a panel that is showing the auto-fitted view should re-fit — the
   * whole point of maximizing is to see more of the image, and being left with
   * a postage stamp in a huge panel is the complaint this fixes. But a view the
   * user has zoomed or panned is theirs: re-fitting that would throw away the
   * detail they navigated to every time the window changed. So the auto view
   * re-fits, and a touched view is merely kept CENTRED on whatever it was
   * looking at, instead of drifting toward a corner as the panel grows.
   */
  const reflow = useCallback(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const width = wrap.clientWidth;
    const height = wrap.clientHeight;
    if (width < 8 || height < 8) return;
    if (!fittedRef.current || !viewTouchedRef.current) {
      fit();
      return;
    }
    const previous = sizeRef.current;
    sizeRef.current = { width, height };
    if (previous && (previous.width !== width || previous.height !== height)) {
      const view = viewRef.current;
      viewRef.current = {
        zoom: view.zoom,
        x: view.x + (width - previous.width) / 2,
        y: view.y + (height - previous.height) / 2,
      };
    }
    draw();
  }, [fit, draw]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || typeof ResizeObserver === "undefined") return;
    // The first real size is the first chance to frame the image. After that a
    // resize is just a repaint — re-fitting would throw away the user's zoom
    // every time the panel is dragged.
    const observer = new ResizeObserver(reflow);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [reflow]);

  // --- coordinate helpers -------------------------------------------------
  const toDoc = useCallback((event) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const { zoom, x, y } = viewRef.current;
    return {
      x: (event.clientX - rect.left - x) / zoom,
      y: (event.clientY - rect.top - y) / zoom,
    };
  }, []);

  // --- text tool ----------------------------------------------------------
  //
  // Typing is not a drag gesture, so it lives outside `gestureRef`: a text box
  // stays open across pointer events, keystrokes and tool-option changes until
  // it is committed or cancelled. The live preview works by keeping a clean
  // copy of the layer (`base`) and re-applying `base + rasterized text` on
  // every change — the same restore-and-reapply the shape tools use, which is
  // what makes the preview WYSIWYG rather than an approximation drawn on top.
  const textRef = useRef(null);
  const [textBox, setTextBox] = useState(null); // mirrors textRef for rendering
  const textAreaRef = useRef(null);

  /** Re-renders the in-progress text into the layer from the clean base. */
  const paintText = useCallback(() => {
    const entry = textRef.current;
    if (!entry || !layer) return;
    const tp = toolRef.current;
    // Restore the whole layer rather than the last dirty rect: text can shrink
    // (deleting a character, switching to a smaller size) and a rect-only
    // restore leaves the tail of the previous string behind.
    layer.buffer.data.set(entry.base.data);
    const stroke = rasterizeTextStroke(doc.width, doc.height, {
      x: entry.x,
      y: entry.y,
      text: entry.text,
      ...tp.text,
    });
    if (stroke) {
      applyStroke(layer.buffer, stroke, {
        color: parseColor(tp.color, tp.alpha),
        opacity: tp.opacity,
        blend: "normal",
        selection: selectionRef.current,
      });
    }
    entry.lastStroke = stroke;
    onEdited(null);
  }, [layer, doc.width, doc.height, onEdited, selectionRef]);

  const beginText = useCallback(
    (point) => {
      if (!layer || layer.locked) return;
      const entry = {
        // Snapped to whole texels: a baseline at x.5 makes canvas antialias
        // every glyph horizontally, and typed text on a 64px icon looks
        // blurred for no reason the user can see.
        x: Math.round(point.x),
        y: Math.round(point.y),
        text: "",
        base: cloneBuffer(layer.buffer),
        lastStroke: null,
      };
      textRef.current = entry;
      setTextBox({ x: entry.x, y: entry.y });
      // Focus after the overlay has actually mounted.
      requestAnimationFrame(() => textAreaRef.current?.focus());
    },
    [layer],
  );

  const cancelText = useCallback(() => {
    const entry = textRef.current;
    textRef.current = null;
    setTextBox(null);
    if (!entry || !layer) return;
    layer.buffer.data.set(entry.base.data);
    onEdited(null);
  }, [layer, onEdited]);

  const commitText = useCallback(() => {
    const entry = textRef.current;
    textRef.current = null;
    setTextBox(null);
    if (!entry || !layer) return;
    if (!entry.text.trim() || !entry.lastStroke) {
      // Nothing typed — put the layer back exactly as it was rather than
      // pushing an empty undo step.
      layer.buffer.data.set(entry.base.data);
      onEdited(null);
      return;
    }
    const rect = { ...entry.lastStroke.dirty };
    const snapshot = captureRegion(entry.base, rect);
    onHistory(regionEntry(layer.buffer, rect, snapshot, "Text"));
    onTouched?.();
    onEdited(rect);
  }, [layer, onHistory, onEdited, onTouched]);

  // Re-render the preview when a tool option changes mid-typing, so adjusting
  // the size slider with a box open shows the result immediately.
  useEffect(() => {
    if (textRef.current) paintText();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    toolProps.text?.fontFamily,
    toolProps.text?.fontSize,
    toolProps.text?.bold,
    toolProps.text?.italic,
    toolProps.text?.align,
    toolProps.text?.outlineWidth,
    toolProps.text?.lineHeight,
    toolProps.color,
    toolProps.alpha,
    toolProps.opacity,
  ]);

  // Switching tools, layers or documents ends the box rather than leaving an
  // orphaned preview baked into a layer nobody is editing anymore.
  useEffect(() => {
    if (textRef.current && toolProps.tool !== "text") commitText();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolProps.tool]);
  // Unmounting with a box open commits it rather than losing what was typed.
  // Through a ref, because an empty-dependency cleanup would otherwise capture
  // the FIRST render's `commitText` — and with it a `layer` that is null on
  // mount, so the commit would silently do nothing.
  const commitTextRef = useRef(commitText);
  commitTextRef.current = commitText;
  useEffect(
    () => () => {
      if (textRef.current) commitTextRef.current();
    },
    [],
  );

  /** Where the text box floats, in wrapper-relative screen pixels. */
  const textScreen = useMemo(() => {
    if (!textBox) return null;
    const { zoom, x, y } = viewRef.current;
    return { left: textBox.x * zoom + x, top: textBox.y * zoom + y };
    // viewVersion is the signal that zoom/pan changed — the ref itself can't
    // be a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [textBox, viewVersion]);

  // --- gestures -----------------------------------------------------------
  const beginStroke = useCallback(
    (point) => {
      if (!layer || layer.locked || layer.visible === false) {
        pushToast({ title: layer?.locked ? "That layer is locked" : "That layer is hidden" });
        return null;
      }
      const onMask = maskEditing && !!layer.mask;
      return {
        kind: "stroke",
        onMask,
        // A mask is one byte per texel, so its pre-stroke copy is a quarter the
        // size of the pixel one — worth keeping the two paths apart rather than
        // round-tripping the mask through an RGBA buffer.
        base: onMask ? new Uint8Array(layer.mask) : cloneBuffer(layer.buffer),
        stroke: createStroke(doc.width, doc.height),
        carry: 0,
        last: point,
        total: { x0: doc.width, y0: doc.height, x1: 0, y1: 0 },
      };
    },
    [layer, doc.width, doc.height, maskEditing],
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
      if (gesture.onMask) {
        copyMaskRegion(layer.mask, gesture.base, doc.width, clip);
        applyStrokeToMask(layer.mask, doc.width, gesture.stroke, {
          // White reveals, black hides — the brush's own colour decides, which
          // is the convention every editor with masks shares.
          value: tp.tool === "eraser" ? 0 : luminance(...parseColor(tp.color, 255).slice(0, 3)),
          opacity: tp.opacity,
          selection: selectionRef.current,
          clip,
        });
      } else {
        copyRegion(layer.buffer, gesture.base, clip);
        applyStroke(layer.buffer, gesture.stroke, {
          color: parseColor(tp.color, tp.alpha),
          opacity: tp.opacity,
          erase: tp.tool === "eraser",
          selection: selectionRef.current,
          clip,
        });
      }
      growTotal(gesture.total, clip);
      onPainting(clip);
      draw();
    },
    [doc.width, doc.height, layer, onPainting, draw, selectionRef],
  );

  const onPointerDown = useCallback(
    (event) => {
      // Middle mouse or Space+drag pans, the two gestures every paint program
      // shares. Alt is NOT pan here — it is the temporary eyedropper, which is
      // the more useful of the two while a brush is in hand.
      if (event.button === 1 || spaceRef.current) {
        gestureRef.current = { kind: "pan", start: { x: event.clientX, y: event.clientY }, view: { ...viewRef.current } };
        event.currentTarget.setPointerCapture(event.pointerId);
        return;
      }
      if (event.button !== 0) return;
      const tp = toolRef.current;
      const point = toDoc(event);
      event.currentTarget.setPointerCapture(event.pointerId);

      if (event.altKey) {
        const picked = pickColor(composite.current, Math.floor(point.x), Math.floor(point.y));
        if (picked) onPickColor(toHex(picked));
        return;
      }

      if (tp.tool === "eyedropper") {
        const picked = pickColor(composite.current, Math.floor(point.x), Math.floor(point.y));
        if (picked) onPickColor(toHex(picked));
        return;
      }
      if (tp.tool === "text") {
        if (!layer || layer.locked) return;
        // Clicking while a text box is open commits it and starts another,
        // which is how every paint program behaves and is much less annoying
        // than being trapped in one box until you find the confirm button.
        if (textRef.current) commitText();
        beginText(point);
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
    [toDoc, layer, doc, composite, selectionRef, onSelection, onPickColor, onHistory, onEdited, beginStroke, applySegment, beginText, commitText],
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
        viewTouchedRef.current = true;
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
        let end = point;
        if (event.shiftKey) {
          // Shift constrains: a square/circle for the box tools, 45° steps for
          // a line. Doing it here rather than in the rasterizer keeps the
          // preview and the committed shape identical by construction.
          if (tp.tool === "line") {
            const dx = point.x - gesture.start.x;
            const dy = point.y - gesture.start.y;
            const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
            const length = Math.hypot(dx, dy);
            end = {
              x: gesture.start.x + Math.cos(angle) * length,
              y: gesture.start.y + Math.sin(angle) * length,
            };
          } else {
            const size = Math.max(Math.abs(point.x - gesture.start.x), Math.abs(point.y - gesture.start.y));
            end = {
              x: gesture.start.x + Math.sign(point.x - gesture.start.x || 1) * size,
              y: gesture.start.y + Math.sign(point.y - gesture.start.y || 1) * size,
            };
          }
        }
        const rect = {
          x: Math.min(gesture.start.x, end.x),
          y: Math.min(gesture.start.y, end.y),
          width: Math.abs(end.x - gesture.start.x),
          height: Math.abs(end.y - gesture.start.y),
        };
        if (tp.tool === "rect") strokeRect(gesture.stroke, rect, { fill: tp.shapeFill, lineWidth: tp.brushSize / 4 });
        else if (tp.tool === "ellipse") {
          strokeEllipse(gesture.stroke, rect, { fill: tp.shapeFill, lineWidth: tp.brushSize / 4 });
        } else {
          strokeSegment(gesture.stroke, gesture.start.x, gesture.start.y, end.x, end.y, {
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
        let end = point;
        if (event.shiftKey && gesture.kind === "marquee") {
          const size = Math.max(Math.abs(point.x - gesture.start.x), Math.abs(point.y - gesture.start.y));
          end = {
            x: gesture.start.x + Math.sign(point.x - gesture.start.x || 1) * size,
            y: gesture.start.y + Math.sign(point.y - gesture.start.y || 1) * size,
          };
        }
        gesture.current = end;
        gesture.preview = {
          x: Math.min(gesture.start.x, end.x),
          y: Math.min(gesture.start.y, end.y),
          width: Math.abs(end.x - gesture.start.x),
          height: Math.abs(end.y - gesture.start.y),
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
        let dx = point.x - gesture.start.x;
        let dy = point.y - gesture.start.y;
        // Shift locks to the dominant axis — nudging a layer sideways without
        // drifting a pixel vertically is otherwise a matter of luck.
        if (event.shiftKey) {
          if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        layer.offset = [Math.round(gesture.origin[0] + dx), Math.round(gesture.origin[1] + dy)];
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
          if (gesture.onMask) {
            const before = gesture.base;
            const after = new Uint8Array(layer.mask);
            onHistory({
              label: "Paint Mask",
              bytes: before.length * 2,
              undo: () => layer.mask.set(before),
              redo: () => layer.mask.set(after),
            });
          } else {
            const before = captureRegion(gesture.base, total);
            onHistory(regionEntry(layer.buffer, total, before, gesture.kind === "shape" ? "Shape" : "Paint"));
          }
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
      viewTouchedRef.current = true;
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
        onContextMenu={(e) => {
          e.preventDefault();
          onContextMenu?.({ x: e.clientX, y: e.clientY });
        }}
      />
      {textScreen && (
        <div
          className="texture-text-entry"
          style={{ left: textScreen.left, top: textScreen.top }}
          // The canvas below is listening for pointer-downs to start another
          // text box; without this, clicking into the textarea to move the
          // caret would commit the box you are typing in.
          onPointerDown={(event) => event.stopPropagation()}
        >
          <textarea
            ref={textAreaRef}
            value={textBox?.text ?? ""}
            placeholder="Type…"
            spellCheck={false}
            onChange={(event) => {
              if (!textRef.current) return;
              textRef.current.text = event.target.value;
              setTextBox((current) => ({ ...current, text: event.target.value }));
              paintText();
            }}
            onKeyDown={(event) => {
              // Enter inserts a newline (text is multi-line); Ctrl/Cmd+Enter
              // and Escape are the two ways out. Stopped from bubbling so the
              // panel's single-letter tool shortcuts don't fire while typing.
              event.stopPropagation();
              if (event.key === "Escape") {
                event.preventDefault();
                cancelText();
              } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                commitText();
              }
            }}
          />
          <div className="texture-text-actions">
            <span className="hint">Ctrl+Enter to place · Esc to cancel</span>
            <button className="tx-btn quiet" onClick={cancelText}>
              Cancel
            </button>
            <button className="tx-btn primary" onClick={commitText}>
              <Check size={13} />
              Place
            </button>
          </div>
        </div>
      )}
      <div className="tx-readout" ref={readoutRef} />
      <div className="texture-view-controls">
        <button
          className="tx-btn quiet icon"
          title="Zoom out"
          onClick={() => {
            viewRef.current.zoom = Math.max(MIN_ZOOM, viewRef.current.zoom / 1.5);
            viewTouchedRef.current = true;
            draw();
          }}
        >
          <ZoomOut size={14} />
        </button>
        <button className="tx-btn quiet icon" title="Fit to view" onClick={fit}>
          <Maximize2 size={13} />
        </button>
        <button
          className="tx-btn quiet icon"
          title="Zoom in"
          onClick={() => {
            viewRef.current.zoom = Math.min(MAX_ZOOM, viewRef.current.zoom * 1.5);
            viewTouchedRef.current = true;
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
      <div className="texture-swatches">
        <input
          type="color"
          title="Primary colour"
          value={props.color}
          onChange={(e) => props.onColor(e.target.value)}
        />
        <input
          type="color"
          title="Secondary colour"
          value={props.altColor}
          onChange={(e) => props.onAltColor(e.target.value)}
        />
        <button
          className="tx-icon-btn"
          title="Swap colours (X)"
          onClick={() => {
            const a = props.color;
            props.onColor(props.altColor);
            props.onAltColor(a);
          }}
        >
          <Repeat size={12} />
        </button>
      </div>

      <Slider Icon={Blend} title="Alpha" value={props.alpha} min={0} max={255} step={1} onChange={props.onAlpha} />
      {showBrush && (
        <>
          <Slider Icon={CircleDot} title="Brush size ([ and ])" value={props.brushSize} min={1} max={400} step={1} onChange={props.onBrushSize} />
          <Slider Icon={Feather} title="Hardness" value={props.hardness} min={0} max={1} step={0.01} onChange={props.onHardness} />
        </>
      )}
      {(showBrush || tool === "fill" || tool === "gradient") && (
        <Slider Icon={Droplet} title="Opacity" value={props.opacity} min={0} max={1} step={0.01} onChange={props.onOpacity} />
      )}
      {showTolerance && (
        <>
          <Slider Icon={Target} title="Tolerance" value={props.tolerance} min={0} max={1} step={0.01} onChange={props.onTolerance} />
          <label className="texture-check" title="Only fill/select the connected region">
            <input type="checkbox" checked={props.contiguous} onChange={(e) => props.onContiguous(e.target.checked)} />
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
        <Segmented options={GRADIENT_TYPES} value={props.gradientType} onChange={props.onGradientType} />
      )}
      {tool === "text" && (
        <>
          <select
            className="select-field texture-font-select"
            value={props.textFont}
            title="Project fonts are registered under a generated family, so a texture looks the same on every machine"
            onChange={(event) => props.onTextFont(event.target.value)}
          >
            <optgroup label="System">
              <option value="">System Sans</option>
            </optgroup>
            {props.projectFonts?.length > 0 && (
              <optgroup label="Project fonts">
                {props.projectFonts.map((fontPath) => (
                  <option value={fontPath} key={fontPath}>
                    {basename(fontPath)}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <Slider Icon={Type} title="Font size" value={props.textSize} min={6} max={400} step={1} onChange={props.onTextSize} />
          <button
            className={`tx-icon-btn${props.textBold ? " active" : ""}`}
            title="Bold"
            onClick={() => props.onTextBold(!props.textBold)}
          >
            <b>B</b>
          </button>
          <button
            className={`tx-icon-btn${props.textItalic ? " active" : ""}`}
            title="Italic"
            onClick={() => props.onTextItalic(!props.textItalic)}
          >
            <i>I</i>
          </button>
          <Segmented options={TEXT_ALIGNS} value={props.textAlign} onChange={props.onTextAlign} />
          <Slider Icon={CircleSlash2} title="Outline width" value={props.textOutline} min={0} max={24} step={0.5} onChange={props.onTextOutline} />
          <Slider Icon={LayersIcon} title="Line height" value={props.textLineHeight} min={0.6} max={3} step={0.05} onChange={props.onTextLineHeight} />
        </>
      )}
      {showSelect && (
        <Segmented options={SELECT_MODES} value={props.selectMode} onChange={props.onSelectMode} />
      )}

      <span className="tx-spacer" />
      <div className="tx-group">
        <button className="tx-btn" title="Select all (Ctrl+A)" onClick={props.onSelectAll}>
          All
        </button>
        <button className="tx-btn" title="Deselect (Ctrl+D)" disabled={!props.hasSelection} onClick={props.onDeselect}>
          None
        </button>
        <button className="tx-btn" title="Invert selection (Ctrl+I)" onClick={props.onInvert}>
          Invert
        </button>
      </div>
    </div>
  );
}

/** Icon, slider, value. The name lives in the tooltip — a strip of five
 *  spelled-out labels is what made this toolbar wrap onto two lines. */
function Slider({ Icon, title, value, min, max, step, onChange }) {
  return (
    <label className="tx-slider" title={title}>
      <Icon size={13} />
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
  maskEditing, onMaskEditing, onAddMask, onDeleteMask, onApplyMask, hasSelection,
  onAddEffect, onChangeEffect, onRemoveEffect,
}) {
  const active = doc.activeId;
  const rows = useMemo(() => [...doc.layers].reverse(), [doc, version]);
  const [renaming, setRenaming] = useState(null);
  const [fxMenu, setFxMenu] = useState(null);
  const layer = getLayer(doc, active);

  return (
    <div className="texture-layers">
      <div className="tx-section-head" style={{ padding: "9px 10px", height: "auto" }}>
        <LayersIcon size={13} />
        Layers
        <span className="tx-count">{doc.layers.length}</span>
      </div>

      <div className="tx-list">
        {rows.map((l) => (
          <div
            key={l.id}
            className={`tx-row-item ${l.id === active ? "active" : ""}`}
            onClick={() => onSelect(l.id)}
          >
            <button
              className="tx-icon-btn"
              title={l.visible === false ? "Show" : "Hide"}
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
              <span className="tx-name" onDoubleClick={() => setRenaming(l.id)}>
                {l.name}
              </span>
            )}
            {/* Badges, not words: at a glance you can see which layers carry a
                mask and which carry effects, without a second column of text. */}
            {l.mask && (
              <span className={`tx-badge ${l.id === active && maskEditing ? "on" : ""}`} title="Has a layer mask">
                <CircleSlash2 size={11} />
              </span>
            )}
            {hasEffects(l) && (
              <span className="tx-badge" title={`${l.effects.length} effect${l.effects.length === 1 ? "" : "s"}`}>
                <Sparkles size={11} />
              </span>
            )}
            <button
              className={`tx-icon-btn ${l.locked ? "" : "reveal"}`}
              title={l.locked ? "Unlock" : "Lock"}
              onClick={(e) => {
                e.stopPropagation();
                onLock(l.id);
              }}
            >
              {l.locked ? <Lock size={12} /> : <Unlock size={12} />}
            </button>
          </div>
        ))}
      </div>

      {layer && (
        <div className="texture-layer-props">
          <div className="tx-field">
            <span>Blend</span>
            <SelectField
              value={layer.blend ?? "normal"}
              options={BLEND_MODES}
              capitalize
              title="Layer blend mode"
              onChange={(mode) => onBlend(layer.id, mode)}
            />
          </div>
          <div className="tx-field">
            <span>Opacity</span>
            <Slider
              Icon={Droplet}
              title="Layer opacity"
              value={layer.opacity ?? 1}
              min={0}
              max={1}
              step={0.01}
              onChange={(v) => onOpacity(layer.id, v)}
            />
          </div>

          {/* Mask. Editing is a mode rather than a tool, because every tool
              should work on a mask — it is painted with the same brush. */}
          <div className="tx-row">
            {layer.mask ? (
              <>
                <button
                  className={`tx-btn ${maskEditing ? "on" : "quiet"}`}
                  title="Paint the mask instead of the layer — white reveals, black hides"
                  onClick={() => onMaskEditing(!maskEditing)}
                >
                  <CircleSlash2 size={13} />
                  <span>{maskEditing ? "Editing mask" : "Edit mask"}</span>
                </button>
                <span className="tx-spacer" />
                <button className="tx-icon-btn" title="Apply the mask to the pixels" onClick={() => onApplyMask(layer.id)}>
                  <Check size={13} />
                </button>
                <button className="tx-icon-btn danger" title="Delete the mask" onClick={() => onDeleteMask(layer.id)}>
                  <Trash2 size={13} />
                </button>
              </>
            ) : (
              <>
                <button className="tx-btn quiet" title="Add a layer mask" onClick={() => onAddMask(layer.id, false)}>
                  <CircleSlash2 size={13} />
                  <span>Mask</span>
                </button>
                <button
                  className="tx-btn quiet"
                  disabled={!hasSelection}
                  title={hasSelection ? "Mask from the current selection" : "Make a selection first"}
                  onClick={() => onAddMask(layer.id, true)}
                >
                  From selection
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {layer && (
        <div className="tx-section">
          <div className="tx-section-head">
            <Sparkles size={13} />
            Effects
            <span className="tx-count">{layer.effects?.length ?? 0}</span>
            <span className="tx-spacer" />
            <button
              className="tx-icon-btn"
              title="Add an effect"
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                setFxMenu({ x: rect.right, y: rect.bottom + 4 });
              }}
            >
              <Plus size={12} />
            </button>
          </div>
          {!layer.effects?.length && <p className="tx-hint">Outline, shadow and glow follow the layer&apos;s shape.</p>}
          {!!layer.effects?.length && isFullyOpaque(layer.buffer) && (
            <p className="tx-hint warn">
              This layer is opaque edge to edge, so an outline, shadow or glow has nowhere to show.
              Erase part of it, add a mask, or put it above another layer.
            </p>
          )}
          {(layer.effects ?? []).map((effect) => (
            <LayerEffectRow
              key={effect.id}
              effect={effect}
              onChange={(patch) => onChangeEffect(layer.id, effect.id, patch)}
              onRemove={() => onRemoveEffect(layer.id, effect.id)}
            />
          ))}
        </div>
      )}

      <div className="texture-layer-actions">
        <button className="tx-btn quiet icon" title="New layer" onClick={onAdd}>
          <Plus size={14} />
        </button>
        <button className="tx-btn quiet icon" title="Duplicate layer" onClick={() => onDuplicate(active)}>
          <Copy size={14} />
        </button>
        <button className="tx-btn quiet icon" title="Move up" onClick={() => onReorder(active, +1)}>
          <ChevronUp size={14} />
        </button>
        <button className="tx-btn quiet icon" title="Move down" onClick={() => onReorder(active, -1)}>
          <ChevronDown size={14} />
        </button>
        <button className="tx-btn quiet icon" title="Merge down" onClick={() => onMerge(active)}>
          <LayersIcon size={14} />
        </button>
        <span className="tx-spacer" />
        <button className="tx-btn quiet icon danger" title="Delete layer" onClick={() => onDelete(active)}>
          <Trash2 size={14} />
        </button>
      </div>

      {fxMenu && (
        <ContextMenu
          x={fxMenu.x}
          y={fxMenu.y}
          onClose={() => setFxMenu(null)}
          items={LAYER_EFFECTS.map((spec) => ({
            label: spec.label,
            disabled: (layer?.effects ?? []).some((e) => e.id === spec.id),
            action: () => onAddEffect(active, spec.id),
          }))}
        />
      )}
    </div>
  );
}

/** One effect and its parameters, collapsed to a header until opened — four
 *  effects expanded at once would fill the column and hide the layer list. */
function LayerEffectRow({ effect, onChange, onRemove }) {
  const spec = LAYER_EFFECTS.find((e) => e.id === effect.id);
  const [open, setOpen] = useState(true);
  if (!spec) return null;
  return (
    <div className={`tx-effect ${effect.enabled === false ? "off" : ""}`}>
      <div className="tx-effect-head">
        <button
          className="tx-icon-btn"
          title={effect.enabled === false ? "Enable" : "Disable"}
          onClick={() => onChange({ enabled: effect.enabled === false })}
        >
          {effect.enabled === false ? <EyeOff size={12} /> : <Eye size={12} />}
        </button>
        <span className="tx-name" onClick={() => setOpen((v) => !v)}>
          {spec.label}
        </span>
        <button className="tx-icon-btn danger reveal" title="Remove effect" onClick={onRemove}>
          <Trash2 size={12} />
        </button>
      </div>
      {open &&
        spec.params.map((param) =>
          param.color ? (
            <label key={param.key} className="tx-field">
              <span>{param.label}</span>
              <input
                type="color"
                value={effect[param.key] ?? param.default}
                onChange={(e) => onChange({ [param.key]: e.target.value })}
              />
            </label>
          ) : (
            <EffectSlider
              key={param.key}
              param={param}
              value={effect[param.key] ?? param.default}
              onChange={(v) => onChange({ [param.key]: v })}
            />
          ),
        )}
    </div>
  );
}

/**
 * An effect parameter, echoed instantly and committed on a delay.
 *
 * An effect re-renders the whole layer — a dilate and a blur — and a raw
 * `onChange` runs that on every tick of a drag, which is what made the shadow
 * sliders feel stuck. The knob follows the pointer from local state, so the UI
 * never lags; the document is written once the value settles, which is also
 * what keeps the undo history to one entry per gesture rather than forty.
 */
function EffectSlider({ param, value, onChange }) {
  const [local, setLocal] = useState(value);
  const committed = useRef(value);
  const commitRef = useRef(onChange);
  commitRef.current = onChange;

  // Follow the document when it changes underneath (undo, a preset).
  useEffect(() => {
    if (value !== committed.current) {
      committed.current = value;
      setLocal(value);
    }
  }, [value]);

  useEffect(() => {
    if (local === committed.current) return undefined;
    const timer = setTimeout(() => {
      committed.current = local;
      commitRef.current(local);
    }, 90);
    return () => clearTimeout(timer);
  }, [local]);

  return (
    <label className="tx-field">
      <span>{param.label}</span>
      <Slider
        Icon={Blend}
        title={param.label}
        value={local}
        min={param.min}
        max={param.max}
        step={param.step}
        onChange={setLocal}
      />
    </label>
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
      <span>
        {doc.layers.length} layer{doc.layers.length === 1 ? "" : "s"}
      </span>
      <span className="tx-spacer" />
      {undoLabel && <span>Undo: {undoLabel}</span>}
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
              className="tx-btn quiet"
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
          <button className="tx-btn quiet" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="tx-btn primary"
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
