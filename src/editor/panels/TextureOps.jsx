import { useEffect, useMemo, useRef, useState } from "react";
import { ContextMenu } from "../ContextMenu.jsx";
import { AssetField } from "../fields/AssetField.jsx";
import { TEXTURE_EXTENSIONS } from "../assetLoader.js";
import { ADJUSTMENTS, defaultParams } from "../texture/adjust.js";
import { FILTERS } from "../texture/filters.js";
import { CHANNEL_SOURCES } from "../texture/channels.js";

/**
 * The Texture Editor's operation surfaces: the Image / Adjust / Filter /
 * Channels menus, and the dialogs they open.
 *
 * The menus are built from the same registries the operations are implemented
 * in (`ADJUSTMENTS`, `FILTERS`), so a new adjustment appears in the UI, with a
 * dialog, sliders and live preview, without anything being written here.
 *
 * Presentation only: every one of these calls back into the panel, which owns
 * the document, the selection and the undo stack.
 */

const MENUS = ["Image", "Adjust", "Filter", "Channels"];

export function OperationMenus({ onCommand, hasSelection, disabled }) {
  const [menu, setMenu] = useState(null);

  const open = (name, event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setMenu({ name, x: rect.left, y: rect.bottom + 2 });
  };

  const run = (kind, payload) => {
    setMenu(null);
    onCommand(kind, payload);
  };

  const items = useMemo(() => {
    if (!menu) return [];
    if (menu.name === "Image") {
      return [
        { label: "Resize Image…", action: () => run("resize") },
        { label: "Canvas Size…", action: () => run("canvas") },
        {
          label: "Crop to Selection",
          disabled: !hasSelection,
          hint: hasSelection ? "" : "Make a selection first",
          action: () => run("cropToSelection"),
        },
        { label: "Trim Transparent Edges", action: () => run("trim") },
        { separator: true },
        { label: "Flip Horizontal", action: () => run("flip", "horizontal") },
        { label: "Flip Vertical", action: () => run("flip", "vertical") },
        { label: "Rotate 90° CW", action: () => run("rotate", 1) },
        { label: "Rotate 90° CCW", action: () => run("rotate", 3) },
        { label: "Rotate 180°", action: () => run("rotate", 2) },
      ];
    }
    if (menu.name === "Adjust") {
      return [
        { header: "Active layer" },
        ...ADJUSTMENTS.map((spec) => ({
          label: spec.params.length ? `${spec.label}…` : spec.label,
          action: () => run("adjust", spec.id),
        })),
      ];
    }
    if (menu.name === "Filter") {
      return [
        { header: "Active layer" },
        ...FILTERS.map((spec) => ({
          label: spec.params.length ? `${spec.label}…` : spec.label,
          action: () => run("filter", spec.id),
        })),
      ];
    }
    return [
      { label: "Pack Channels…", hint: "Build one map from separate roughness / metal / AO files", action: () => run("pack") },
      { label: "Swizzle Channels…", action: () => run("swizzle") },
      { label: "Split into Layers", action: () => run("split") },
      { separator: true },
      { label: "Alpha from Luminance", action: () => run("alphaFromLuminance", false) },
      { label: "Alpha from Inverted Luminance", hint: "White background becomes transparent", action: () => run("alphaFromLuminance", true) },
      { label: "Make Opaque", action: () => run("makeOpaque") },
      { label: "Bleed Colour into Transparency", hint: "Stops filtering pulling the background into a sprite's edge", action: () => run("bleed") },
      { separator: true },
      { label: "Premultiply Alpha", action: () => run("premultiply") },
      { label: "Unpremultiply Alpha", action: () => run("unpremultiply") },
    ];
  }, [menu, hasSelection]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <div className="tx-group">
        {MENUS.map((name) => (
          <button
            key={name}
            className={`tx-btn ${menu?.name === name ? "on" : ""}`}
            disabled={disabled}
            onClick={(event) => open(name, event)}
          >
            {name}
          </button>
        ))}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
    </>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * One dialog for every adjustment and filter, driven by the operation's own
 * parameter declarations.
 *
 * Preview is **debounced**, not immediate. A blur on a 2K layer is real work,
 * and running it synchronously on every slider tick turns a smooth drag into a
 * sequence of stalls that makes the slider feel broken rather than slow.
 */
export function OperationDialog({ spec, docSize, onPreview, onApply, onCancel }) {
  const [params, setParams] = useState(() => {
    const initial = defaultParams(spec);
    for (const param of spec.params ?? []) {
      // "Offset by half" is what the seam-check workflow always wants, so it is
      // where the dialog opens rather than something to work out every time.
      if (param.halfDefault === "width") initial[param.key] = Math.round(docSize.width / 2);
      if (param.halfDefault === "height") initial[param.key] = Math.round(docSize.height / 2);
    }
    return initial;
  });
  const [busy, setBusy] = useState(false);
  const timer = useRef(null);
  const latest = useRef(params);
  latest.current = params;
  // The callback is held in a ref and deliberately NOT an effect dependency.
  // Previewing writes to the document, which re-renders the panel, which hands
  // this dialog a new inline `onPreview` — so depending on it re-runs the
  // effect, previews again, and the dialog spins re-applying the filter for as
  // long as it is open. Only a parameter change may schedule a preview.
  const previewRef = useRef(onPreview);
  previewRef.current = onPreview;

  useEffect(() => {
    setBusy(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      previewRef.current(latest.current);
      setBusy(false);
    }, 120);
    return () => clearTimeout(timer.current);
  }, [params]);

  const set = (key, value) => setParams((p) => ({ ...p, [key]: value }));

  return (
    <div className="texture-dialog-backdrop" onPointerDown={onCancel}>
      <div className="texture-dialog" onPointerDown={(e) => e.stopPropagation()}>
        <h3>
          {spec.label}
          {busy && <span className="texture-dialog-busy"> …</span>}
        </h3>
        {(spec.params ?? []).map((param) => (
          <ParamRow key={param.key} param={param} value={params[param.key]} onChange={(v) => set(param.key, v)} />
        ))}
        {!spec.params?.length && <p className="texture-dialog-note">Applies to the active layer.</p>}
        <div className="texture-dialog-actions">
          <button className="tx-btn quiet" onClick={onCancel}>
            Cancel
          </button>
          <button className="tx-btn primary" onClick={() => onApply(params)}>
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}

function ParamRow({ param, value, onChange }) {
  if (param.toggle) {
    return (
      <label className="texture-check">
        <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
        {param.label}
      </label>
    );
  }
  if (param.options) {
    return (
      <label>
        {param.label}
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          {param.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (param.color) {
    return (
      <label>
        {param.label}
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)} />
      </label>
    );
  }
  return (
    <label className="texture-param">
      <span>{param.label}</span>
      <input
        type="range"
        min={param.min}
        max={param.max}
        step={param.step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <input
        type="number"
        min={param.min}
        max={param.max}
        step={param.step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * Resize (resample) and Canvas Size (reframe) are deliberately two dialogs.
 * They are the same two numbers with completely different consequences, and an
 * editor that merges them into one is an editor where someone eventually
 * destroys their artwork by picking the wrong radio button.
 */
export function ResizeDialog({ docSize, onApply, onCancel }) {
  const [width, setWidth] = useState(docSize.width);
  const [height, setHeight] = useState(docSize.height);
  const [link, setLink] = useState(true);
  const [filter, setFilter] = useState("bilinear");

  const setW = (v) => {
    setWidth(v);
    if (link) setHeight(Math.max(1, Math.round((v * docSize.height) / docSize.width)));
  };
  const setH = (v) => {
    setHeight(v);
    if (link) setWidth(Math.max(1, Math.round((v * docSize.width) / docSize.height)));
  };

  return (
    <div className="texture-dialog-backdrop" onPointerDown={onCancel}>
      <div className="texture-dialog" onPointerDown={(e) => e.stopPropagation()}>
        <h3>Resize Image</h3>
        <div className="texture-dialog-row">
          <label>
            Width
            <input type="number" min={1} max={8192} value={width} onChange={(e) => setW(Number(e.target.value))} />
          </label>
          <label>
            Height
            <input type="number" min={1} max={8192} value={height} onChange={(e) => setH(Number(e.target.value))} />
          </label>
        </div>
        <label className="texture-check">
          <input type="checkbox" checked={link} onChange={(e) => setLink(e.target.checked)} />
          Keep aspect ratio
        </label>
        <div className="texture-dialog-presets">
          {[0.5, 2].map((scale) => (
            <button
              key={scale}
              className="tx-btn quiet"
              onClick={() => {
                setWidth(Math.max(1, Math.round(docSize.width * scale)));
                setHeight(Math.max(1, Math.round(docSize.height * scale)));
              }}
            >
              {scale < 1 ? "½×" : "2×"}
            </button>
          ))}
          {[64, 128, 256, 512, 1024, 2048].map((size) => (
            <button
              key={size}
              className="tx-btn quiet"
              onClick={() => {
                setWidth(size);
                setHeight(link ? Math.max(1, Math.round((size * docSize.height) / docSize.width)) : height);
              }}
            >
              {size}
            </button>
          ))}
        </div>
        <label>
          Resampling
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="bilinear">Smooth (bilinear)</option>
            <option value="nearest">Sharp (nearest — pixel art, masks)</option>
          </select>
        </label>
        <div className="texture-dialog-actions">
          <button className="tx-btn quiet" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="tx-btn primary"
            onClick={() => onApply({ width: clampSize(width), height: clampSize(height), filter })}
          >
            Resize
          </button>
        </div>
      </div>
    </div>
  );
}

const ANCHORS = [
  ["nw", "n", "ne"],
  ["w", "c", "e"],
  ["sw", "s", "se"],
];

export function CanvasSizeDialog({ docSize, onApply, onCancel }) {
  const [width, setWidth] = useState(docSize.width);
  const [height, setHeight] = useState(docSize.height);
  const [anchor, setAnchor] = useState("c");

  return (
    <div className="texture-dialog-backdrop" onPointerDown={onCancel}>
      <div className="texture-dialog" onPointerDown={(e) => e.stopPropagation()}>
        <h3>Canvas Size</h3>
        <p className="texture-dialog-note">
          The artwork keeps its pixel size; the frame around it changes.
        </p>
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
        <span className="texture-anchor-label">Anchor</span>
        <div className="texture-anchor-grid">
          {ANCHORS.flat().map((id) => (
            <button
              key={id}
              className={`texture-anchor ${anchor === id ? "active" : ""}`}
              onClick={() => setAnchor(id)}
              title={id}
            />
          ))}
        </div>
        <div className="texture-dialog-actions">
          <button className="tx-btn quiet" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="tx-btn primary"
            onClick={() => onApply({ width: clampSize(width), height: clampSize(height), anchor })}
          >
            Resize Canvas
          </button>
        </div>
      </div>
    </div>
  );
}

/** Anchor id → where the existing pixels land in the new frame. */
export function anchorOffset(anchor, oldSize, newSize) {
  const dx = newSize.width - oldSize.width;
  const dy = newSize.height - oldSize.height;
  const x = anchor.includes("w") ? 0 : anchor.includes("e") ? dx : Math.round(dx / 2);
  const y = anchor.includes("n") ? 0 : anchor.includes("s") ? dy : Math.round(dy / 2);
  return { x, y };
}

const clampSize = (v) => Math.max(1, Math.min(8192, Math.round(Number(v) || 1)));

/* -------------------------------------------------------------------------- */

const PACK_SLOTS = [
  { key: "r", label: "Red", hint: "roughness" },
  { key: "g", label: "Green", hint: "metalness" },
  { key: "b", label: "Blue", hint: "ambient occlusion" },
  { key: "a", label: "Alpha", hint: "height / opacity" },
];

/**
 * Pack Channels — four files in, one texture out.
 *
 * The default slot has no file and a constant, because that is the honest
 * default: a material where metalness is 0 everywhere should not require
 * anyone to author a black image to say so.
 */
export function PackChannelsDialog({ docSize, onApply, onCancel }) {
  const [slots, setSlots] = useState(() => ({
    r: { path: "", source: "luminance", invert: false, constant: 0 },
    g: { path: "", source: "luminance", invert: false, constant: 0 },
    b: { path: "", source: "luminance", invert: false, constant: 0 },
    a: { path: "", source: "luminance", invert: false, constant: 255 },
  }));
  const [name, setName] = useState("Packed");
  const [width, setWidth] = useState(docSize.width);
  const [height, setHeight] = useState(docSize.height);
  const [busy, setBusy] = useState(false);

  const patch = (key, values) => setSlots((s) => ({ ...s, [key]: { ...s[key], ...values } }));

  return (
    <div className="texture-dialog-backdrop" onPointerDown={busy ? undefined : onCancel}>
      <div className="texture-dialog wide" onPointerDown={(e) => e.stopPropagation()}>
        <h3>Pack Channels</h3>
        <p className="texture-dialog-note">
          Sources of a different size are resampled to the output size.
        </p>
        {PACK_SLOTS.map((slot) => (
          <div key={slot.key} className="texture-pack-row">
            <span className={`texture-pack-chip ch-${slot.key}`}>{slot.label}</span>
            <div className="texture-pack-field">
              <AssetField
                descriptor={{ exts: TEXTURE_EXTENSIONS, emptyLabel: `Constant (${slot.hint})` }}
                value={slots[slot.key].path}
                onCommit={(path) => patch(slot.key, { path: path ?? "" })}
              />
            </div>
            {slots[slot.key].path ? (
              <>
                <select
                  value={slots[slot.key].source}
                  onChange={(e) => patch(slot.key, { source: e.target.value })}
                  title="Which channel of the source file to read"
                >
                  {CHANNEL_SOURCES.map((source) => (
                    <option key={source} value={source}>
                      {source}
                    </option>
                  ))}
                </select>
                <label className="texture-check" title="Invert this channel">
                  <input
                    type="checkbox"
                    checked={slots[slot.key].invert}
                    onChange={(e) => patch(slot.key, { invert: e.target.checked })}
                  />
                  inv
                </label>
              </>
            ) : (
              <input
                type="number"
                min={0}
                max={255}
                value={slots[slot.key].constant}
                onChange={(e) => patch(slot.key, { constant: Number(e.target.value) })}
                title="Constant value for this channel"
              />
            )}
          </div>
        ))}
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
        <label>
          Save as
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="texture-dialog-actions">
          <button className="tx-btn quiet" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button
            className="tx-btn primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onApply({ slots, name, width: clampSize(width), height: clampSize(height) });
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Packing…" : "Pack"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * Packing loose sprites into a sheet.
 *
 * Padding and extrusion are both offered because they solve different problems
 * and neither substitutes for the other: padding stops a NEIGHBOUR bleeding in,
 * extrusion repeats a sprite's own edge outward so the empty space around it
 * cannot bleed in when a mipmap or a half-texel offset samples past the rect.
 * An atlas with padding but no extrusion still fringes at distance.
 */
export function PackAtlasDialog({ count, defaultName = "Atlas", onApply, onCancel }) {
  const [name, setName] = useState(defaultName);
  const [padding, setPadding] = useState(2);
  const [extrude, setExtrude] = useState(1);
  const [maxSize, setMaxSize] = useState(2048);
  const [powerOfTwo, setPowerOfTwo] = useState(true);
  const [busy, setBusy] = useState(false);

  return (
    <div className="texture-dialog-backdrop" onPointerDown={busy ? undefined : onCancel}>
      <div className="texture-dialog" onPointerDown={(e) => e.stopPropagation()}>
        <h3>Pack into Atlas</h3>
        <p className="texture-dialog-note">
          {count} image{count === 1 ? "" : "s"} → one sheet plus a `.atlas` naming each region after its file.
        </p>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="texture-dialog-row">
          <label>
            Padding
            <input type="number" min={0} max={16} value={padding} onChange={(e) => setPadding(Number(e.target.value))} />
          </label>
          <label>
            Extrude
            <input type="number" min={0} max={8} value={extrude} onChange={(e) => setExtrude(Number(e.target.value))} />
          </label>
        </div>
        <label>
          Max size
          <select value={maxSize} onChange={(e) => setMaxSize(Number(e.target.value))}>
            {[512, 1024, 2048, 4096, 8192].map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
        <label className="texture-check">
          <input type="checkbox" checked={powerOfTwo} onChange={(e) => setPowerOfTwo(e.target.checked)} />
          Power-of-two sheet
        </label>
        <div className="texture-dialog-actions">
          <button className="tx-btn quiet" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button
            className="tx-btn primary"
            disabled={busy || !name.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                await onApply({ name: name.trim(), padding, extrude, maxSize, powerOfTwo });
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Packing…" : "Pack"}
          </button>
        </div>
      </div>
    </div>
  );
}

const SWIZZLE_TARGETS = ["r", "g", "b", "a"];

export function SwizzleDialog({ onApply, onCancel }) {
  const [mapping, setMapping] = useState({ r: "r", g: "g", b: "b", a: "a" });
  const [invert, setInvert] = useState({});

  return (
    <div className="texture-dialog-backdrop" onPointerDown={onCancel}>
      <div className="texture-dialog" onPointerDown={(e) => e.stopPropagation()}>
        <h3>Swizzle Channels</h3>
        <p className="texture-dialog-note">Rewrites the active layer&apos;s channels from its own.</p>
        {SWIZZLE_TARGETS.map((target) => (
          <div key={target} className="texture-pack-row">
            <span className={`texture-pack-chip ch-${target}`}>{target.toUpperCase()}</span>
            <select
              value={mapping[target]}
              onChange={(e) => setMapping((m) => ({ ...m, [target]: e.target.value }))}
            >
              {CHANNEL_SOURCES.map((source) => (
                <option key={source} value={source}>
                  {source}
                </option>
              ))}
            </select>
            <label className="texture-check">
              <input
                type="checkbox"
                checked={!!invert[target]}
                onChange={(e) => setInvert((i) => ({ ...i, [target]: e.target.checked }))}
              />
              inv
            </label>
          </div>
        ))}
        <div className="texture-dialog-actions">
          <button className="tx-btn quiet" onClick={onCancel}>
            Cancel
          </button>
          <button className="tx-btn primary" onClick={() => onApply({ mapping, invert })}>
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
