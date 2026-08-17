import { useState } from "react";
import { SelectField } from "../fields/SelectField.jsx";
import { ANCHOR_ROWS, FIT_MODES, MAX_SIZE, clampSize } from "../texture/fit.js";

/**
 * "Resize Images…" for a selection in the Assets panel.
 *
 * Distinct from the Texture Editor's own Resize / Canvas Size dialogs, which
 * operate on the one open document and therefore know its size: this one may be
 * pointed at eight files of eight different sizes, so it never shows "current
 * size" and never pre-fills from one. That is also why the percentage unit
 * exists — "half of each of these" is otherwise unsayable to a mixed selection.
 *
 * The mode picker is the load-bearing control. See texture/fit.js for what the
 * four modes mean; the anchor and the resampling filter are hidden for the
 * modes they do nothing in, rather than shown disabled, because a greyed
 * control invites the question "why can't I set that?" on every open.
 */

const PX_PRESETS = [64, 128, 256, 512, 1024, 2048, 4096];
const PERCENT_PRESETS = [25, 50, 75, 200];

export function ResizeAssetsDialog({ count = 1, onApply, onCancel, busy = false }) {
  const [unit, setUnit] = useState("px");
  const [width, setWidth] = useState(1024);
  const [height, setHeight] = useState(1024);
  const [scale, setScale] = useState(50);
  const [mode, setMode] = useState("fit");
  const [anchor, setAnchor] = useState("c");
  const [filter, setFilter] = useState("bilinear");

  const percent = unit === "percent";
  const cropping = mode === "cover" || mode === "canvas";
  const many = count > 1;
  const label = many ? `${count} Images` : "Image";

  const apply = () => {
    if (busy) return;
    onApply(
      percent
        ? { scale: Math.max(1, Math.min(1000, Math.round(Number(scale) || 100))), mode: "stretch", filter }
        : {
            width: clampSize(width),
            height: clampSize(height),
            mode,
            anchor,
            filter,
          },
    );
  };

  return (
    <div className="texture-dialog-backdrop" onPointerDown={busy ? undefined : onCancel}>
      <div className="texture-dialog" onPointerDown={(e) => e.stopPropagation()}>
        <h3>
          Resize {label}
          {busy && <span className="texture-dialog-busy"> · working…</span>}
        </h3>
        <p className="texture-dialog-note">
          Writes over the {many ? "files" : "file"} on disk — this is not on the undo stack. Any layer
          stack and KTX2 derivative is resized along with the image.
        </p>

        <div className="tx-group">
          <button className={`tx-btn ${percent ? "" : "on"}`} onClick={() => setUnit("px")}>
            Pixels
          </button>
          <button className={`tx-btn ${percent ? "on" : ""}`} onClick={() => setUnit("percent")}>
            Percent
          </button>
        </div>

        {percent ? (
          <>
            <div className="texture-dialog-presets">
              {PERCENT_PRESETS.map((value) => (
                <button key={value} className="tx-btn quiet" onClick={() => setScale(value)}>
                  {value}%
                </button>
              ))}
            </div>
            <label>
              Scale
              <input
                type="number"
                min={1}
                max={1000}
                step={1}
                value={scale}
                onChange={(e) => setScale(Number(e.target.value))}
              />
            </label>
            <p className="texture-dialog-note">
              {many
                ? "Each image is scaled by this much from its own size."
                : "Scaled from the image's own size."}
            </p>
          </>
        ) : (
          <>
            <div className="texture-dialog-presets">
              {PX_PRESETS.map((size) => (
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
            <div className="texture-dialog-row">
              <label>
                Width
                <input
                  type="number"
                  min={1}
                  max={MAX_SIZE}
                  value={width}
                  onChange={(e) => setWidth(Number(e.target.value))}
                />
              </label>
              <label>
                Height
                <input
                  type="number"
                  min={1}
                  max={MAX_SIZE}
                  value={height}
                  onChange={(e) => setHeight(Number(e.target.value))}
                />
              </label>
            </div>
            <div className="texture-dialog-field">
              <span>Mode</span>
              <SelectField
                value={mode}
                options={FIT_MODES.map(({ id, label: text, hint }) => ({ value: id, label: text, hint }))}
                onChange={setMode}
              />
            </div>
            {cropping && (
              <>
                <span className="texture-anchor-label">Anchor</span>
                <div className="texture-anchor-grid">
                  {ANCHOR_ROWS.flat().map((id) => (
                    <button
                      key={id}
                      className={`texture-anchor ${anchor === id ? "active" : ""}`}
                      onClick={() => setAnchor(id)}
                      title={id}
                    />
                  ))}
                </div>
              </>
            )}
          </>
        )}

        {(percent || mode !== "canvas") && (
          <div className="texture-dialog-field">
            <span>Resampling</span>
            <SelectField
              value={filter}
              options={[
                { value: "bilinear", label: "Smooth", hint: "Box-filtered — photographic source" },
                { value: "nearest", label: "Sharp", hint: "Nearest — pixel art and masks" },
              ]}
              onChange={setFilter}
            />
          </div>
        )}

        <div className="texture-dialog-actions">
          <button className="tx-btn quiet" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button className="tx-btn primary" disabled={busy} onClick={apply}>
            Resize {label}
          </button>
        </div>
      </div>
    </div>
  );
}
