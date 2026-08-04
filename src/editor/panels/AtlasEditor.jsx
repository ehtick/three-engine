import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Grid3x3,
  Pause,
  Play,
  Plus,
  Save,
  Scissors,
  Trash2,
  Undo2,
  Wand2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { basename } from "../store/projectStore.js";
import { pushToast } from "../toasts.js";
import { ContextMenu } from "../ContextMenu.jsx";
import { readImageBuffer } from "../textureFile.js";
import { bufferToImageData } from "../texture/codecPng.js";
import { sliceByAlpha, sliceGrid } from "../texture/slice.js";
import { exportRegions, readAtlas, writeAtlas } from "../atlasFile.js";
import { applySlice, uniqueRegionName } from "../texture/atlasOps.js";
import { atlasImagePath, frameAt, normalizeAtlas } from "../../engine/sprite/atlasAsset.js";

/**
 * The atlas surface: regions over a sheet, their pivots and nine-slice borders,
 * and the animations built from them.
 *
 * It shares the panel with the paint canvas rather than being its own panel,
 * because the two are used together constantly — slicing a sheet wants to see
 * the alpha you just erased, and fixing a sprite's bleed means painting inside
 * the atlas you just packed. Separate panels would mean saving and reopening
 * between every such step.
 *
 * The definition is small JSON, so unlike the paint document it lives in
 * ordinary React state and its undo stack is whole-document snapshots.
 */

const HANDLE = 5; // px, screen-space, for edge/corner hit tests
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 32;

export function AtlasEditor({ path, onOpenImage }) {
  const [def, setDef] = useState(null);
  const [image, setImage] = useState(null);
  const [status, setStatus] = useState("loading");
  const [dirty, setDirty] = useState(false);
  const [selected, setSelected] = useState(null); // region name
  const [selectedAnim, setSelectedAnim] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [menu, setMenu] = useState(null);
  const historyRef = useRef([]);

  // --- load ---------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    (async () => {
      const loaded = await readAtlas(path);
      const buffer = await readImageBuffer(atlasImagePath(loaded, path));
      if (cancelled) return;
      // The sheet is the truth about its own size; a `size` recorded when the
      // atlas was written can be stale if the PNG was edited or replaced.
      setDef({ ...loaded, size: [buffer.width, buffer.height] });
      setImage(buffer);
      setStatus("ready");
      setSelected(loaded.regions[0]?.name ?? null);
      historyRef.current = [];
      setDirty(false);
    })().catch((error) => {
      if (cancelled) return;
      console.error(error);
      setStatus("error");
    });
    return () => {
      cancelled = true;
    };
  }, [path]);

  const commit = useCallback((next, { record = true } = {}) => {
    setDef((current) => {
      if (record && current) {
        historyRef.current.push(JSON.stringify(current));
        if (historyRef.current.length > 60) historyRef.current.shift();
      }
      return typeof next === "function" ? next(current) : next;
    });
    setDirty(true);
  }, []);

  const undo = useCallback(() => {
    const snapshot = historyRef.current.pop();
    if (!snapshot) return;
    setDef(normalizeAtlas(JSON.parse(snapshot)));
    setDirty(true);
  }, []);

  const save = useCallback(async () => {
    if (!def) return;
    try {
      await writeAtlas(path, def);
      setDirty(false);
      pushToast({ title: `Saved ${basename(path)}` });
    } catch (error) {
      pushToast({ level: "error", title: "Save failed", detail: String(error?.message ?? error) });
    }
  }, [def, path]);

  // --- region editing -----------------------------------------------------
  const region = useMemo(() => def?.regions.find((r) => r.name === selected) ?? null, [def, selected]);

  const updateRegion = useCallback(
    (name, patch, options) => {
      commit(
        (current) => ({
          ...current,
          regions: current.regions.map((r) => (r.name === name ? { ...r, ...patch } : r)),
        }),
        options,
      );
    },
    [commit],
  );

  const addRegion = useCallback(
    (rect) => {
      if (!def) return;
      const name = uniqueRegionName(def, "sprite");
      commit((current) => ({
        ...current,
        regions: [
          ...current.regions,
          { name, rect: [rect.x, rect.y, rect.width, rect.height], pivot: [0.5, 0.5], border: [0, 0, 0, 0] },
        ],
      }));
      setSelected(name);
    },
    [def, commit],
  );

  const deleteRegion = useCallback(
    (name) => {
      commit((current) => ({
        ...current,
        regions: current.regions.filter((r) => r.name !== name),
        // Frames referencing a deleted region are dropped here rather than left
        // to `normalizeAtlas` on the next load, so the animation list is honest
        // about its length straight away.
        animations: current.animations.map((a) => ({ ...a, frames: a.frames.filter((f) => f !== name) })),
      }));
      setSelected(null);
    },
    [commit],
  );

  const renameRegion = useCallback(
    (from, to) => {
      const clean = to.trim();
      if (!clean || clean === from) return;
      commit((current) => {
        if (current.regions.some((r) => r.name === clean)) {
          pushToast({ title: `"${clean}" is already used in this atlas` });
          return current;
        }
        return {
          ...current,
          regions: current.regions.map((r) => (r.name === from ? { ...r, name: clean } : r)),
          animations: current.animations.map((a) => ({
            ...a,
            frames: a.frames.map((f) => (f === from ? clean : f)),
          })),
        };
      });
      setSelected(clean);
    },
    [commit],
  );

  // --- slicing ------------------------------------------------------------
  const runSlice = useCallback(
    (rects, baseName) => {
      if (!rects.length) {
        pushToast({ title: "Nothing found to slice" });
        return;
      }
      commit((current) => normalizeAtlas(applySlice(current, rects, { baseName })));
      setSelected(null);
      setDialog(null);
      pushToast({ title: `Sliced into ${rects.length} region${rects.length === 1 ? "" : "s"}` });
    },
    [commit],
  );

  // --- animations ---------------------------------------------------------
  const addAnimation = useCallback(
    (frames) => {
      commit((current) => {
        const taken = new Set(current.animations.map((a) => a.name));
        let name = "animation";
        for (let i = 1; taken.has(name); i++) name = `animation_${i}`;
        return {
          ...current,
          animations: [...current.animations, { name, fps: 12, loop: true, frames }],
        };
      });
    },
    [commit],
  );

  const updateAnimation = useCallback(
    (name, patch) => {
      commit((current) => ({
        ...current,
        animations: current.animations.map((a) => (a.name === name ? { ...a, ...patch } : a)),
      }));
    },
    [commit],
  );

  if (status === "loading") return <div className="panel-empty">Loading atlas…</div>;
  if (status === "error" || !def) {
    return <div className="panel-empty">Could not open this atlas — is its image missing?</div>;
  }

  return (
    <div className="atlas-editor">
      <div className="texture-options">
        <button className="toolbar-btn" disabled={!dirty} onClick={save}>
          <Save size={13} /> Save
        </button>
        <button className="toolbar-btn icon-only" title="Undo" onClick={undo}>
          <Undo2 size={14} />
        </button>
        <span className="toolbar-sep" />
        <button
          className="toolbar-btn tiny"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setMenu({ x: rect.left, y: rect.bottom + 2 });
          }}
        >
          <Scissors size={12} /> Slice
        </button>
        <button className="toolbar-btn tiny" onClick={() => addRegion({ x: 0, y: 0, width: 32, height: 32 })}>
          <Plus size={12} /> Region
        </button>
        <button
          className="toolbar-btn tiny"
          disabled={!def.regions.length}
          onClick={async () => {
            try {
              const { directory, written } = await exportRegions(path, def, image);
              pushToast({ title: `Exported ${written.length} sprites`, detail: basename(directory) });
            } catch (error) {
              pushToast({ level: "error", title: "Export failed", detail: String(error?.message ?? error) });
            }
          }}
        >
          Export Sprites
        </button>
        <button className="toolbar-btn tiny" onClick={() => onOpenImage?.(atlasImagePath(def, path))}>
          Edit Sheet
        </button>
        <span className="texture-options-spacer" />
        <span className="texture-title">
          {basename(path)}
          {dirty ? " •" : ""}
        </span>
      </div>

      <div className="atlas-body">
        <AtlasCanvas
          def={def}
          image={image}
          selected={selected}
          onSelect={setSelected}
          onCreate={addRegion}
          onUpdateRegion={updateRegion}
        />
        <div className="atlas-side">
          <RegionList
            def={def}
            selected={selected}
            onSelect={setSelected}
            onDelete={deleteRegion}
            onAddAnimation={addAnimation}
          />
          {region && (
            <RegionInspector
              region={region}
              sheet={def.size}
              onRename={(next) => renameRegion(region.name, next)}
              onChange={(patch, options) => updateRegion(region.name, patch, options)}
            />
          )}
          <AnimationSection
            def={def}
            image={image}
            selected={selectedAnim}
            onSelect={setSelectedAnim}
            onChange={updateAnimation}
            onDelete={(name) =>
              commit((current) => ({
                ...current,
                animations: current.animations.filter((a) => a.name !== name),
              }))
            }
            onAdd={() => addAnimation(def.regions.map((r) => r.name))}
          />
        </div>
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: "By Grid…", action: () => setDialog({ kind: "grid" }) },
            { label: "By Transparency…", hint: "Find every separate piece of artwork", action: () => setDialog({ kind: "alpha" }) },
          ]}
        />
      )}

      {dialog?.kind === "grid" && (
        <GridSliceDialog
          size={def.size}
          onCancel={() => setDialog(null)}
          onApply={(options) =>
            runSlice(
              sliceGrid({ width: def.size[0], height: def.size[1], buffer: image, ...options }),
              options.baseName,
            )
          }
        />
      )}
      {dialog?.kind === "alpha" && (
        <AlphaSliceDialog
          onCancel={() => setDialog(null)}
          onApply={(options) => runSlice(sliceByAlpha(image, options), options.baseName)}
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* canvas                                                                      */
/* -------------------------------------------------------------------------- */

function AtlasCanvas({ def, image, selected, onSelect, onCreate, onUpdateRegion }) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const viewRef = useRef({ zoom: 1, x: 0, y: 0 });
  const gestureRef = useRef(null);
  const surfaceRef = useRef(null);
  const [, bumpView] = useState(0);

  const surface = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    canvas.getContext("2d").putImageData(bufferToImageData(image), 0, 0);
    surfaceRef.current = canvas;
    return canvas;
  }, [image]);

  const fit = useCallback(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const zoom = Math.max(
      MIN_ZOOM,
      Math.min((wrap.clientWidth - 40) / image.width, (wrap.clientHeight - 40) / image.height, 8),
    );
    viewRef.current = {
      zoom,
      x: wrap.clientWidth / 2 - (image.width * zoom) / 2,
      y: wrap.clientHeight / 2 - (image.height * zoom) / 2,
    };
    bumpView((v) => v + 1);
  }, [image.width, image.height]);

  useEffect(() => {
    fit();
  }, [fit]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
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
    ctx.fillStyle = "#1a1a1e";
    ctx.fillRect(x, y, image.width * zoom, image.height * zoom);
    ctx.imageSmoothingEnabled = zoom < 1;
    ctx.drawImage(surface, x, y, image.width * zoom, image.height * zoom);

    for (const region of def.regions) {
      const [rx, ry, rw, rh] = region.rect;
      const isSelected = region.name === selected;
      ctx.lineWidth = 1;
      ctx.strokeStyle = isSelected ? "#0a84ff" : "rgba(255,255,255,0.42)";
      ctx.strokeRect(x + rx * zoom + 0.5, y + ry * zoom + 0.5, rw * zoom - 1, rh * zoom - 1);
      if (isSelected) {
        ctx.fillStyle = "rgba(10,132,255,0.12)";
        ctx.fillRect(x + rx * zoom, y + ry * zoom, rw * zoom, rh * zoom);

        // Nine-slice guides, drawn only for the selected region: four of these
        // per sprite across a full sheet would be unreadable, and they are only
        // ever adjusted one sprite at a time.
        const [bl, br, bt, bb] = region.border;
        ctx.strokeStyle = "rgba(0,255,170,0.85)";
        ctx.setLineDash([3, 3]);
        const line = (x0, y0, x1, y1) => {
          ctx.beginPath();
          ctx.moveTo(x + x0 * zoom, y + y0 * zoom);
          ctx.lineTo(x + x1 * zoom, y + y1 * zoom);
          ctx.stroke();
        };
        if (bl > 0) line(rx + bl, ry, rx + bl, ry + rh);
        if (br > 0) line(rx + rw - br, ry, rx + rw - br, ry + rh);
        if (bt > 0) line(rx, ry + bt, rx + rw, ry + bt);
        if (bb > 0) line(rx, ry + rh - bb, rx + rw, ry + rh - bb);
        ctx.setLineDash([]);

        // Pivot cross.
        const px = x + (rx + region.pivot[0] * rw) * zoom;
        const py = y + (ry + region.pivot[1] * rh) * zoom;
        ctx.strokeStyle = "#ffd60a";
        ctx.beginPath();
        ctx.moveTo(px - 5, py);
        ctx.lineTo(px + 5, py);
        ctx.moveTo(px, py - 5);
        ctx.lineTo(px, py + 5);
        ctx.stroke();

        // Corner handles.
        ctx.fillStyle = "#0a84ff";
        for (const [hx, hy] of [
          [rx, ry],
          [rx + rw, ry],
          [rx, ry + rh],
          [rx + rw, ry + rh],
        ]) {
          ctx.fillRect(x + hx * zoom - 3, y + hy * zoom - 3, 6, 6);
        }
      }
    }

    const gesture = gestureRef.current;
    if (gesture?.kind === "create" && gesture.rect) {
      ctx.strokeStyle = "#ffffff";
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(
        x + gesture.rect.x * zoom,
        y + gesture.rect.y * zoom,
        gesture.rect.width * zoom,
        gesture.rect.height * zoom,
      );
      ctx.setLineDash([]);
    }
  }, [def, image, selected, surface]);

  useEffect(() => {
    draw();
  }, [draw]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => draw());
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [draw]);

  const toImage = useCallback((event) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const { zoom, x, y } = viewRef.current;
    return { x: (event.clientX - rect.left - x) / zoom, y: (event.clientY - rect.top - y) / zoom };
  }, []);

  /** Which part of the selected region (if any) is under the pointer. */
  const hitSelected = useCallback(
    (point) => {
      const current = def.regions.find((r) => r.name === selected);
      if (!current) return null;
      const [rx, ry, rw, rh] = current.rect;
      const tol = HANDLE / viewRef.current.zoom;
      const nearL = Math.abs(point.x - rx) < tol;
      const nearR = Math.abs(point.x - (rx + rw)) < tol;
      const nearT = Math.abs(point.y - ry) < tol;
      const nearB = Math.abs(point.y - (ry + rh)) < tol;
      const inside = point.x >= rx - tol && point.x <= rx + rw + tol && point.y >= ry - tol && point.y <= ry + rh + tol;
      if (!inside) return null;
      if (nearL || nearR || nearT || nearB) {
        return { kind: "resize", edges: { l: nearL, r: nearR, t: nearT, b: nearB }, region: current };
      }
      // Nine-slice guides sit inside the rect, so they are tested before the
      // move gesture — otherwise the border can only ever be typed, never
      // dragged, which is the whole reason to draw it.
      const [bl, br, bt, bb] = current.border;
      if (bl > 0 && Math.abs(point.x - (rx + bl)) < tol) return { kind: "border", edge: "l", region: current };
      if (br > 0 && Math.abs(point.x - (rx + rw - br)) < tol) return { kind: "border", edge: "r", region: current };
      if (bt > 0 && Math.abs(point.y - (ry + bt)) < tol) return { kind: "border", edge: "t", region: current };
      if (bb > 0 && Math.abs(point.y - (ry + rh - bb)) < tol) return { kind: "border", edge: "b", region: current };
      return { kind: "move", region: current };
    },
    [def, selected],
  );

  const onPointerDown = useCallback(
    (event) => {
      const point = toImage(event);
      event.currentTarget.setPointerCapture(event.pointerId);

      if (event.button === 1 || event.altKey) {
        gestureRef.current = { kind: "pan", start: { x: event.clientX, y: event.clientY }, view: { ...viewRef.current } };
        return;
      }
      if (event.button !== 0) return;

      const hit = hitSelected(point);
      if (hit) {
        gestureRef.current = { ...hit, start: point, origin: [...hit.region.rect], border: [...hit.region.border] };
        return;
      }
      // Topmost region wins, so a small sprite drawn over a large background
      // region is still selectable.
      const under = [...def.regions].reverse().find((r) => {
        const [rx, ry, rw, rh] = r.rect;
        return point.x >= rx && point.x <= rx + rw && point.y >= ry && point.y <= ry + rh;
      });
      if (under) {
        onSelect(under.name);
        gestureRef.current = { kind: "move", region: under, start: point, origin: [...under.rect] };
        return;
      }
      gestureRef.current = { kind: "create", start: point, rect: null };
    },
    [toImage, hitSelected, def, onSelect],
  );

  const onPointerMove = useCallback(
    (event) => {
      const gesture = gestureRef.current;
      if (!gesture) return;
      const point = toImage(event);

      if (gesture.kind === "pan") {
        viewRef.current = {
          zoom: gesture.view.zoom,
          x: gesture.view.x + (event.clientX - gesture.start.x),
          y: gesture.view.y + (event.clientY - gesture.start.y),
        };
        draw();
        return;
      }
      if (gesture.kind === "create") {
        gesture.rect = {
          x: Math.round(Math.min(gesture.start.x, point.x)),
          y: Math.round(Math.min(gesture.start.y, point.y)),
          width: Math.round(Math.abs(point.x - gesture.start.x)),
          height: Math.round(Math.abs(point.y - gesture.start.y)),
        };
        draw();
        return;
      }

      const [ox, oy, ow, oh] = gesture.origin;
      const dx = Math.round(point.x - gesture.start.x);
      const dy = Math.round(point.y - gesture.start.y);

      if (gesture.kind === "move") {
        // Clamped to the sheet: a region partly outside it samples texels that
        // do not exist, which reads as a sprite with a transparent bite taken
        // out of one side.
        const x = Math.max(0, Math.min(def.size[0] - ow, ox + dx));
        const y = Math.max(0, Math.min(def.size[1] - oh, oy + dy));
        onUpdateRegion(gesture.region.name, { rect: [x, y, ow, oh] }, { record: !gesture.recorded });
        gesture.recorded = true;
        return;
      }
      if (gesture.kind === "resize") {
        let x = ox;
        let y = oy;
        let w = ow;
        let h = oh;
        if (gesture.edges.l) {
          x = Math.min(ox + ow - 1, Math.max(0, ox + dx));
          w = ow + (ox - x);
        }
        if (gesture.edges.r) w = Math.max(1, Math.min(def.size[0] - x, ow + dx));
        if (gesture.edges.t) {
          y = Math.min(oy + oh - 1, Math.max(0, oy + dy));
          h = oh + (oy - y);
        }
        if (gesture.edges.b) h = Math.max(1, Math.min(def.size[1] - y, oh + dy));
        onUpdateRegion(gesture.region.name, { rect: [x, y, w, h] }, { record: !gesture.recorded });
        gesture.recorded = true;
        return;
      }
      if (gesture.kind === "border") {
        const border = [...gesture.border];
        if (gesture.edge === "l") border[0] = clamp(Math.round(point.x - ox), 0, ow - 1);
        if (gesture.edge === "r") border[1] = clamp(Math.round(ox + ow - point.x), 0, ow - 1);
        if (gesture.edge === "t") border[2] = clamp(Math.round(point.y - oy), 0, oh - 1);
        if (gesture.edge === "b") border[3] = clamp(Math.round(oy + oh - point.y), 0, oh - 1);
        onUpdateRegion(gesture.region.name, { border }, { record: !gesture.recorded });
        gesture.recorded = true;
      }
    },
    [toImage, draw, def, onUpdateRegion],
  );

  const onPointerUp = useCallback(
    (event) => {
      const gesture = gestureRef.current;
      gestureRef.current = null;
      event.currentTarget.releasePointerCapture?.(event.pointerId);
      if (gesture?.kind === "create" && gesture.rect && gesture.rect.width > 2 && gesture.rect.height > 2) {
        onCreate(gesture.rect);
      }
      draw();
    },
    [onCreate, draw],
  );

  return (
    <div className="atlas-canvas-wrap" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className="atlas-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onContextMenu={(e) => e.preventDefault()}
        onWheel={(event) => {
          event.preventDefault();
          const rect = canvasRef.current.getBoundingClientRect();
          const view = viewRef.current;
          const zoom = clamp(view.zoom * Math.exp(-event.deltaY * 0.0015), MIN_ZOOM, MAX_ZOOM);
          const px = event.clientX - rect.left;
          const py = event.clientY - rect.top;
          viewRef.current = {
            zoom,
            x: px - ((px - view.x) / view.zoom) * zoom,
            y: py - ((py - view.y) / view.zoom) * zoom,
          };
          draw();
        }}
      />
      <div className="texture-view-controls">
        <button
          className="toolbar-btn icon-only"
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

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* -------------------------------------------------------------------------- */
/* side panel                                                                  */
/* -------------------------------------------------------------------------- */

function RegionList({ def, selected, onSelect, onDelete, onAddAnimation }) {
  return (
    <div className="atlas-section">
      <div className="atlas-section-head">
        Regions <span className="muted">{def.regions.length}</span>
        <button
          className="toolbar-btn tiny"
          disabled={!def.regions.length}
          title="Make an animation from every region, in order"
          onClick={() => onAddAnimation(def.regions.map((r) => r.name))}
        >
          <Play size={11} /> All
        </button>
      </div>
      <div className="atlas-list">
        {def.regions.map((region) => (
          <div
            key={region.name}
            className={`atlas-row ${region.name === selected ? "active" : ""}`}
            onClick={() => onSelect(region.name)}
          >
            <span className="atlas-row-name">{region.name}</span>
            <span className="muted">
              {region.rect[2]}×{region.rect[3]}
            </span>
            <button
              className="atlas-row-x"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(region.name);
              }}
            >
              <Trash2 size={11} />
            </button>
          </div>
        ))}
        {!def.regions.length && <p className="texture-dialog-note">Slice the sheet, or drag on it to add a region.</p>}
      </div>
    </div>
  );
}

function RegionInspector({ region, sheet, onRename, onChange }) {
  const [name, setName] = useState(region.name);
  useEffect(() => setName(region.name), [region.name]);
  const [x, y, w, h] = region.rect;

  const num = (label, value, apply, { min = 0, max = 8192 } = {}) => (
    <label key={label} className="atlas-num">
      <span>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => apply(clamp(Math.round(Number(e.target.value) || 0), min, max))}
      />
    </label>
  );

  return (
    <div className="atlas-section">
      <div className="atlas-section-head">Region</div>
      <label className="atlas-field">
        <span>Name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => onRename(name)}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") setName(region.name);
          }}
        />
      </label>
      <div className="atlas-grid4">
        {num("X", x, (v) => onChange({ rect: [Math.min(v, sheet[0] - w), y, w, h] }), { max: sheet[0] })}
        {num("Y", y, (v) => onChange({ rect: [x, Math.min(v, sheet[1] - h), w, h] }), { max: sheet[1] })}
        {num("W", w, (v) => onChange({ rect: [x, y, Math.max(1, Math.min(v, sheet[0] - x)), h] }), { min: 1 })}
        {num("H", h, (v) => onChange({ rect: [x, y, w, Math.max(1, Math.min(v, sheet[1] - y))] }), { min: 1 })}
      </div>

      <div className="atlas-section-head sub">
        Pivot <span className="muted">0–1, from the top-left</span>
      </div>
      <div className="atlas-grid4">
        <label className="atlas-num">
          <span>X</span>
          <input
            type="number" step={0.05} min={0} max={1} value={region.pivot[0]}
            onChange={(e) => onChange({ pivot: [clamp(Number(e.target.value) || 0, 0, 1), region.pivot[1]] })}
          />
        </label>
        <label className="atlas-num">
          <span>Y</span>
          <input
            type="number" step={0.05} min={0} max={1} value={region.pivot[1]}
            onChange={(e) => onChange({ pivot: [region.pivot[0], clamp(Number(e.target.value) || 0, 0, 1)] })}
          />
        </label>
        <button className="toolbar-btn tiny" onClick={() => onChange({ pivot: [0.5, 0.5] })}>
          Centre
        </button>
        <button className="toolbar-btn tiny" title="Feet — where a standing character wants its origin" onClick={() => onChange({ pivot: [0.5, 1] })}>
          Bottom
        </button>
      </div>

      <div className="atlas-section-head sub">
        Nine-slice <span className="muted">texture px</span>
      </div>
      <div className="atlas-grid4">
        {num("L", region.border[0], (v) => onChange({ border: [Math.min(v, w - 1), region.border[1], region.border[2], region.border[3]] }))}
        {num("R", region.border[1], (v) => onChange({ border: [region.border[0], Math.min(v, w - 1), region.border[2], region.border[3]] }))}
        {num("T", region.border[2], (v) => onChange({ border: [region.border[0], region.border[1], Math.min(v, h - 1), region.border[3]] }))}
        {num("B", region.border[3], (v) => onChange({ border: [region.border[0], region.border[1], region.border[2], Math.min(v, h - 1)] }))}
      </div>
      <NineSlicePreview region={region} />
    </div>
  );
}

/**
 * A schematic of what the borders do, at a size the sprite was not authored at.
 *
 * Deliberately not a picture of the artwork: the question a nine-slice border
 * answers is "which parts stretch", and a diagram of the nine cells answers it
 * at a glance where a scaled-up sprite makes you squint at its corners.
 */
function NineSlicePreview({ region }) {
  const [, , w, h] = region.rect;
  const [l, r, t, b] = region.border;
  if (!l && !r && !t && !b) {
    return <p className="texture-dialog-note">No border — the whole sprite stretches.</p>;
  }
  const cols = `${(l / w) * 100}% 1fr ${(r / w) * 100}%`;
  const rows = `${(t / h) * 100}% 1fr ${(b / h) * 100}%`;
  return (
    <div className="atlas-nineslice" style={{ gridTemplateColumns: cols, gridTemplateRows: rows }}>
      {Array.from({ length: 9 }, (_, i) => (
        <div key={i} className={`atlas-nineslice-cell ${i === 4 ? "centre" : i % 2 === 1 ? "edge" : "corner"}`} />
      ))}
    </div>
  );
}

function AnimationSection({ def, image, selected, onSelect, onChange, onDelete, onAdd }) {
  const animation = def.animations.find((a) => a.name === selected) ?? null;
  return (
    <div className="atlas-section">
      <div className="atlas-section-head">
        Animations <span className="muted">{def.animations.length}</span>
        <button className="toolbar-btn tiny" disabled={!def.regions.length} onClick={onAdd}>
          <Plus size={11} />
        </button>
      </div>
      <div className="atlas-list short">
        {def.animations.map((a) => (
          <div
            key={a.name}
            className={`atlas-row ${a.name === selected ? "active" : ""}`}
            onClick={() => onSelect(a.name)}
          >
            <span className="atlas-row-name">{a.name}</span>
            <span className="muted">{a.frames.length}f</span>
            <button
              className="atlas-row-x"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(a.name);
              }}
            >
              <Trash2 size={11} />
            </button>
          </div>
        ))}
      </div>
      {animation && (
        <>
          <label className="atlas-field">
            <span>Name</span>
            <input
              value={animation.name}
              onChange={(e) => onChange(animation.name, { name: e.target.value })}
            />
          </label>
          <div className="atlas-grid4">
            <label className="atlas-num">
              <span>FPS</span>
              <input
                type="number" min={0.1} max={120} step={1} value={animation.fps}
                onChange={(e) => onChange(animation.name, { fps: Math.max(0.1, Number(e.target.value) || 12) })}
              />
            </label>
            <label className="texture-check">
              <input
                type="checkbox"
                checked={animation.loop}
                onChange={(e) => onChange(animation.name, { loop: e.target.checked })}
              />
              Loop
            </label>
          </div>
          <AnimationPreview def={def} image={image} animation={animation} />
        </>
      )}
    </div>
  );
}

/**
 * Plays the animation at its real frame rate.
 *
 * On wall-clock time via `requestAnimationFrame`, not the engine's game time:
 * this is an authoring preview, and it has to keep playing while the game is
 * paused — which is exactly when someone is looking at a sprite sheet.
 */
function AnimationPreview({ def, image, animation }) {
  const canvasRef = useRef(null);
  const [playing, setPlaying] = useState(true);
  const frameRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !animation.frames.length) return;
    const source = document.createElement("canvas");
    source.width = image.width;
    source.height = image.height;
    source.getContext("2d").putImageData(bufferToImageData(image), 0, 0);

    const ctx = canvas.getContext("2d");
    let raf = 0;
    let start = performance.now();
    const tick = (now) => {
      const t = playing ? (now - start) / 1000 : frameRef.current / animation.fps;
      const name = frameAt(animation, t);
      const region = def.regions.find((r) => r.name === name);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (region) {
        const [x, y, w, h] = region.rect;
        // Fit inside the box without upscaling past 4x — a 16px icon blown up
        // to fill 120px is a blur, not a preview.
        const scale = Math.min(canvas.width / w, canvas.height / h, 4);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(
          source, x, y, w, h,
          (canvas.width - w * scale) / 2, (canvas.height - h * scale) / 2, w * scale, h * scale,
        );
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [def, image, animation, playing]);

  return (
    <div className="atlas-preview">
      <canvas ref={canvasRef} width={132} height={96} />
      <button className="toolbar-btn icon-only" onClick={() => setPlaying((p) => !p)}>
        {playing ? <Pause size={13} /> : <Play size={13} />}
      </button>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* slice dialogs                                                               */
/* -------------------------------------------------------------------------- */

function GridSliceDialog({ size, onCancel, onApply }) {
  const [mode, setMode] = useState("size");
  const [cellWidth, setCellWidth] = useState(32);
  const [cellHeight, setCellHeight] = useState(32);
  const [columns, setColumns] = useState(4);
  const [rows, setRows] = useState(4);
  const [offsetX, setOffsetX] = useState(0);
  const [offsetY, setOffsetY] = useState(0);
  const [spacingX, setSpacingX] = useState(0);
  const [spacingY, setSpacingY] = useState(0);
  const [skipEmpty, setSkipEmpty] = useState(true);
  const [baseName, setBaseName] = useState("sprite");

  const options = {
    ...(mode === "size" ? { cellWidth, cellHeight } : { columns, rows }),
    offsetX, offsetY, spacingX, spacingY, skipEmpty, baseName,
  };
  const preview = sliceGrid({ width: size[0], height: size[1], ...options, skipEmpty: false }).length;

  return (
    <div className="texture-dialog-backdrop" onPointerDown={onCancel}>
      <div className="texture-dialog" onPointerDown={(e) => e.stopPropagation()}>
        <h3>Slice by Grid</h3>
        <p className="texture-dialog-note">
          Sheet is {size[0]} × {size[1]} — this makes {preview} cell{preview === 1 ? "" : "s"}.
        </p>
        <label>
          Define by
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="size">Cell size</option>
            <option value="count">Column / row count</option>
          </select>
        </label>
        <div className="texture-dialog-row">
          {mode === "size" ? (
            <>
              <label>
                Cell W
                <input type="number" min={1} value={cellWidth} onChange={(e) => setCellWidth(Number(e.target.value))} />
              </label>
              <label>
                Cell H
                <input type="number" min={1} value={cellHeight} onChange={(e) => setCellHeight(Number(e.target.value))} />
              </label>
            </>
          ) : (
            <>
              <label>
                Columns
                <input type="number" min={1} value={columns} onChange={(e) => setColumns(Number(e.target.value))} />
              </label>
              <label>
                Rows
                <input type="number" min={1} value={rows} onChange={(e) => setRows(Number(e.target.value))} />
              </label>
            </>
          )}
        </div>
        <div className="texture-dialog-row">
          <label>
            Offset X
            <input type="number" min={0} value={offsetX} onChange={(e) => setOffsetX(Number(e.target.value))} />
          </label>
          <label>
            Offset Y
            <input type="number" min={0} value={offsetY} onChange={(e) => setOffsetY(Number(e.target.value))} />
          </label>
        </div>
        <div className="texture-dialog-row">
          <label>
            Spacing X
            <input type="number" min={0} value={spacingX} onChange={(e) => setSpacingX(Number(e.target.value))} />
          </label>
          <label>
            Spacing Y
            <input type="number" min={0} value={spacingY} onChange={(e) => setSpacingY(Number(e.target.value))} />
          </label>
        </div>
        <label className="texture-check">
          <input type="checkbox" checked={skipEmpty} onChange={(e) => setSkipEmpty(e.target.checked)} />
          Skip empty cells
        </label>
        <label>
          Name prefix
          <input value={baseName} onChange={(e) => setBaseName(e.target.value)} />
        </label>
        <div className="texture-dialog-actions">
          <button className="toolbar-btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="toolbar-btn primary" onClick={() => onApply(options)}>
            <Grid3x3 size={13} /> Slice
          </button>
        </div>
      </div>
    </div>
  );
}

function AlphaSliceDialog({ onCancel, onApply }) {
  const [threshold, setThreshold] = useState(0);
  const [minSize, setMinSize] = useState(4);
  const [padding, setPadding] = useState(0);
  const [baseName, setBaseName] = useState("sprite");

  return (
    <div className="texture-dialog-backdrop" onPointerDown={onCancel}>
      <div className="texture-dialog" onPointerDown={(e) => e.stopPropagation()}>
        <h3>Slice by Transparency</h3>
        <p className="texture-dialog-note">
          Finds every connected piece of artwork. Pieces whose boxes overlap are kept together, so a
          sprite whose parts don&apos;t touch stays one region — but pieces that merely sit near each
          other stay separate, so a packed sheet isn&apos;t fused into one.
        </p>
        <label className="texture-param">
          <span>Alpha threshold</span>
          <input type="range" min={0} max={254} step={1} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} />
          <input type="number" min={0} max={254} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} />
        </label>
        <label className="texture-param">
          <span>Min size</span>
          <input type="range" min={1} max={64} step={1} value={minSize} onChange={(e) => setMinSize(Number(e.target.value))} />
          <input type="number" min={1} max={64} value={minSize} onChange={(e) => setMinSize(Number(e.target.value))} />
        </label>
        <label className="texture-param">
          <span>Padding</span>
          <input type="range" min={0} max={16} step={1} value={padding} onChange={(e) => setPadding(Number(e.target.value))} />
          <input type="number" min={0} max={16} value={padding} onChange={(e) => setPadding(Number(e.target.value))} />
        </label>
        <label>
          Name prefix
          <input value={baseName} onChange={(e) => setBaseName(e.target.value)} />
        </label>
        <div className="texture-dialog-actions">
          <button className="toolbar-btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="toolbar-btn primary" onClick={() => onApply({ threshold, minSize, padding, baseName })}>
            <Wand2 size={13} /> Slice
          </button>
        </div>
      </div>
    </div>
  );
}
