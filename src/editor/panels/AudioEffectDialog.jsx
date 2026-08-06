import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { EFFECTS, defaultParams } from "../audio/effects.js";

/**
 * One dialog for every effect, generated from the registry descriptor.
 *
 * Written generically rather than as one dialog per effect because the
 * descriptor already carries everything a form needs — label, range, unit,
 * default — and hand-writing eighteen dialogs would mean eighteen places for the
 * UI to disagree with what the DSP actually accepts.
 *
 * ## The preview loop trap
 *
 * This cost real time in the texture editor and applies verbatim here:
 * previewing writes to the document, which re-renders the panel, which hands
 * this dialog a fresh inline `onPreview`, which re-runs the effect that
 * triggered the render — forever, at whatever rate the effect takes to run.
 * It is symptomless in a screenshot.
 *
 * The fix is the two refs below: the callbacks live in a ref so they are never
 * effect dependencies, and only a *parameter* change schedules work.
 */
export function AudioEffectDialog({ effectId, onPreview, onApply, onCancel, busy, note }) {
  const effect = EFFECTS[effectId];
  const [params, setParams] = useState(() => defaultParams(effectId));
  const [live, setLive] = useState(true);

  // Callbacks in a ref — see the note above. The effect below depends on
  // `params` alone, so a re-render caused BY a preview cannot trigger another.
  const callbacks = useRef({ onPreview });
  callbacks.current.onPreview = onPreview;

  useEffect(() => {
    if (!live) return;
    const handle = setTimeout(() => callbacks.current.onPreview?.(params), 180);
    return () => clearTimeout(handle);
  }, [params, live]);

  const set = useCallback((key, value) => setParams((p) => ({ ...p, [key]: value })), []);

  if (!effect) return null;

  return (
    <div className="aud-dialog" role="dialog" aria-label={effect.label}>
      <div className="aud-dialog-head">
        <span className="aud-dialog-title">{effect.label}</span>
        <button className="aud-dialog-close" onClick={onCancel} title="Cancel">×</button>
      </div>

      {effect.description && <p className="aud-dialog-desc">{effect.description}</p>}
      {note && <p className="aud-dialog-note">{note}</p>}

      <div className="aud-dialog-body">
        {Object.entries(effect.params).map(([key, descriptor]) => (
          <ParamField key={key} name={key} descriptor={descriptor} value={params[key]} onChange={set} />
        ))}
        {Object.keys(effect.params).length === 0 && (
          <p className="aud-dialog-desc">No settings — apply to run it.</p>
        )}
      </div>

      <div className="aud-dialog-foot">
        <label className="aud-dialog-live" title="Hear the effect as you change it">
          <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />
          Preview
        </label>
        {effect.changesLength && <span className="aud-dialog-flag">changes length</span>}
        {effect.wholeBufferOnly && <span className="aud-dialog-flag">whole track</span>}
        <span className="aud-dialog-spacer" />
        <button className="aud-btn text" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="aud-btn primary" onClick={() => onApply(params)} disabled={busy}>
          {busy ? <Loader2 size={13} className="aud-spin" /> : null} Apply
        </button>
      </div>
    </div>
  );
}

function ParamField({ name, descriptor, value, onChange }) {
  if (descriptor.type === "boolean") {
    return (
      <label className="aud-param check" title={descriptor.hint ?? ""}>
        <input type="checkbox" checked={!!value} onChange={(e) => onChange(name, e.target.checked)} />
        <span>{descriptor.label}</span>
      </label>
    );
  }
  if (descriptor.type === "enum") {
    return (
      <label className="aud-param" title={descriptor.hint ?? ""}>
        <span className="aud-param-label">{descriptor.label}</span>
        <select value={value} onChange={(e) => onChange(name, e.target.value)}>
          {descriptor.options.map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <label className="aud-param" title={descriptor.hint ?? ""}>
      <span className="aud-param-label">{descriptor.label}</span>
      <input
        type="range"
        min={descriptor.min}
        max={descriptor.max}
        step={descriptor.step}
        value={value}
        onChange={(e) => onChange(name, Number(e.target.value))}
      />
      {/* The number is editable as well as draggable: a slider can't hit
          "exactly -18 dB", and for a threshold that is usually the point. */}
      <input
        className="aud-param-number"
        type="number"
        min={descriptor.min}
        max={descriptor.max}
        step={descriptor.step}
        value={Number(value)}
        onChange={(e) => onChange(name, Number(e.target.value))}
      />
      {descriptor.unit && <span className="aud-param-unit">{descriptor.unit}</span>}
    </label>
  );
}
