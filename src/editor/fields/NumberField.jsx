import { useRef, useState } from "react";

/**
 * The inspector's number input. Two interaction modes on one control:
 *
 *   - Click and type, like any text field.
 *   - Press and drag horizontally to scrub the value (Blender / Unity style).
 *     Shift = fine (x0.1), Alt = coarse (x10).
 *
 * Scrubbing is what makes an inspector feel like a tool rather than a form:
 * nudging a position by "a bit" shouldn't mean select-all + retype. The two
 * modes coexist because focus decides which one is active — an unfocused field
 * scrubs on drag, a focused one behaves like a normal text box so caret
 * placement and text selection still work.
 *
 * Pointer capture (not pointer lock) drives the delta. Pointer lock keeps
 * working past the screen edge but hides the cursor and needs a permissions
 * dance that browsers can refuse; for fields this small, capture is the
 * predictable choice.
 */

const clamp = (v, min, max) =>
  Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));

/** Trims float noise accumulated over many drag deltas (0.30000000000000004). */
function tidy(value, step) {
  const decimals = step >= 1 ? 0 : Math.min(5, Math.ceil(-Math.log10(step)) + 1);
  return parseFloat(value.toFixed(decimals));
}

export function formatNumber(v) {
  if (typeof v !== "number" || Number.isNaN(v)) return "0";
  return String(Math.round(v * 1000) / 1000);
}

/** Movement in px before a press counts as a scrub instead of a click. */
const DRAG_SLOP = 3;

export function NumberField({
  value,
  onCommit,
  min,
  max,
  step = 0.1,
  mixed = false,
  className = "",
  title,
}) {
  // `draft` is non-null only while the field is actively edited; otherwise the
  // displayed text derives DIRECTLY from `value`. Syncing via useEffect+state
  // on every `value` change is a "Cascading Update" — a full Inspector
  // re-render on every frame of a gizmo drag. Deriving avoids the extra render.
  const [draft, setDraft] = useState(null);
  const [scrubbing, setScrubbing] = useState(false);
  const inputRef = useRef(null);
  const drag = useRef(null);
  const text = draft !== null ? draft : mixed ? "" : formatNumber(value);

  const commitText = () => {
    const parsed = parseFloat(text);
    if (!Number.isNaN(parsed) && (mixed || parsed !== value)) {
      onCommit(clamp(parsed, min, max));
    }
    // Invalid/unchanged: text reverts to `value` automatically when draft clears.
  };

  const onPointerDown = (e) => {
    // A focused field is in "typing mode" — leave the caret alone. Middle/right
    // buttons and modifier-clicks stay native too.
    if (e.button !== 0 || document.activeElement === e.currentTarget) return;
    drag.current = {
      pointerId: e.pointerId,
      value: Number(value) || 0,
      moved: 0,
      active: false,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e) => {
    const d = drag.current;
    if (!d) return;
    d.moved += Math.abs(e.movementX);
    if (!d.active) {
      if (d.moved < DRAG_SLOP) return;
      d.active = true;
      setScrubbing(true);
      // The browser focused us on mousedown and may have started a text
      // selection. Drop both so the drag reads as a scrub, not a highlight.
      e.currentTarget.blur();
      window.getSelection?.()?.removeAllRanges?.();
    }
    const scale = e.shiftKey ? 0.1 : e.altKey ? 10 : 1;
    d.value += e.movementX * step * scale;
    onCommit(tidy(clamp(d.value, min, max), step * scale));
  };

  const endDrag = (e) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    setScrubbing(false);
    e.currentTarget.releasePointerCapture?.(d.pointerId);
    // A press that never crossed the slop threshold is a plain click; the
    // browser already gave the input focus, so typing just works.
    if (d.active) onCommit(tidy(clamp(d.value, min, max), step));
  };

  return (
    <input
      ref={inputRef}
      className={`number-field${scrubbing ? " scrubbing" : ""}${className ? ` ${className}` : ""}`}
      type="text"
      inputMode="decimal"
      title={title}
      value={text}
      placeholder={mixed ? "—" : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={() => {
        drag.current = null;
        setScrubbing(false);
      }}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => setDraft(mixed ? "" : formatNumber(value))}
      onBlur={() => {
        // A scrub blurs the field itself — don't let that path re-commit the
        // pre-drag text over the value the drag just wrote.
        if (draft !== null && !drag.current?.active) commitText();
        setDraft(null);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        else if (e.key === "Escape") {
          setDraft(null);
          e.currentTarget.blur();
        } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          const s = step * (e.shiftKey ? 0.1 : e.altKey ? 10 : 1);
          const base = draft !== null ? parseFloat(draft) : value;
          if (Number.isNaN(base)) return;
          const next = tidy(clamp(base + (e.key === "ArrowUp" ? s : -s), min, max), s);
          setDraft(formatNumber(next));
          onCommit(next);
        }
      }}
    />
  );
}
