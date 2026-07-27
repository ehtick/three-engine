import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Inline widgets for node-graph params, shared by the shader and particle
 * editors. Every root element carries `nodrag nopan` so interacting with a
 * widget doesn't drag the node or pan the canvas out from under the pointer.
 *
 * The convention across all of them: `onChange(value, gesture)` where
 * `gesture` is true for the continuous middle of a drag and false/absent for
 * the committed final value. Callers use that to coalesce undo entries and to
 * route live drags through hot uniforms instead of a full recompile.
 */

const clamp = (v, min, max) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));

/** Trims float noise from accumulated drag deltas (0.30000000000000004). */
function tidy(v, step) {
  const decimals = step >= 1 ? 0 : Math.min(5, Math.ceil(-Math.log10(step)) + 1);
  return parseFloat(v.toFixed(decimals));
}

/**
 * Number field you can drag to scrub — the single biggest daily improvement
 * over a bare `<input type="number">`, whose 12px spinner arrows are the only
 * way to nudge a value without selecting text and retyping it.
 *
 * Drag horizontally to change; Shift for fine (×0.1), Alt for coarse (×10).
 * A click without movement focuses the input for typing, so both interaction
 * styles live on one control.
 *
 * Pointer lock is requested on drag so the value keeps changing after the
 * cursor would have run off the screen edge; browsers may refuse it (it needs
 * a user gesture and can be blocked by permissions policy), so plain pointer
 * capture is the fallback and `movementX` works for both.
 */
export function NumberField({ value, step = 0.1, min, max, onChange, title, className = "" }) {
  const inputRef = useRef(null);
  const drag = useRef(null);
  const [text, setText] = useState(null); // non-null while typing

  const onPointerDown = useCallback(
    (e) => {
      // Only the label/grip area starts a scrub; pointerdown inside the text
      // input itself must keep its native caret placement behaviour.
      if (e.button !== 0) return;
      e.preventDefault();
      const el = e.currentTarget;
      el.setPointerCapture(e.pointerId);
      drag.current = { value: Number(value) || 0, moved: 0, pointerId: e.pointerId };
      el.requestPointerLock?.({ unadjustedMovement: true })?.catch?.(() => {});
    },
    [value],
  );

  const onPointerMove = useCallback(
    (e) => {
      const d = drag.current;
      if (!d) return;
      const scale = e.shiftKey ? 0.1 : e.altKey ? 10 : 1;
      d.moved += Math.abs(e.movementX);
      d.value += e.movementX * step * scale;
      onChange?.(tidy(clamp(d.value, min, max), step * scale), true);
    },
    [onChange, step, min, max],
  );

  const endDrag = useCallback(
    (e) => {
      const d = drag.current;
      if (!d) return;
      drag.current = null;
      if (document.pointerLockElement) document.exitPointerLock?.();
      e.currentTarget.releasePointerCapture?.(d.pointerId);
      // A press with (essentially) no movement is a click: hand focus to the
      // input so typing works. 3px of slop absorbs hand tremor.
      if (d.moved < 3) inputRef.current?.focus();
      else onChange?.(tidy(clamp(d.value, min, max), step), false);
    },
    [onChange, step, min, max],
  );

  const commitText = (raw) => {
    setText(null);
    const parsed = parseFloat(raw);
    if (!Number.isNaN(parsed)) onChange?.(clamp(parsed, min, max), false);
  };

  return (
    <div className={`gf-number nodrag nopan ${className}`} title={title}>
      <span
        className="gf-number-grip"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={() => (drag.current = null)}
      />
      <input
        ref={inputRef}
        className="gf-number-input"
        type="text"
        inputMode="decimal"
        value={text ?? (value ?? 0)}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => text != null && commitText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commitText(e.currentTarget.value);
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            setText(null);
            e.currentTarget.blur();
          } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const s = step * (e.shiftKey ? 0.1 : e.altKey ? 10 : 1);
            onChange?.(tidy(clamp((Number(value) || 0) + (e.key === "ArrowUp" ? s : -s), min, max), s), false);
          }
        }}
      />
    </div>
  );
}

export function Vec3Field({ value, step = 0.1, onChange, labels = ["x", "y", "z"] }) {
  const v = value ?? [0, 0, 0];
  return (
    <div className="gf-vec3 nodrag nopan">
      {labels.map((label, i) => (
        <label key={label} className={`gf-vec3-axis axis-${label}`}>
          <span>{label}</span>
          <NumberField
            value={v[i] ?? 0}
            step={step}
            onChange={(next, gesture) => {
              const out = [...v];
              out[i] = next;
              onChange?.(out, gesture);
            }}
          />
        </label>
      ))}
    </div>
  );
}

export function ColorField({ value, onChange, showHex = true }) {
  const v = value ?? "#ffffff";
  return (
    <div className="gf-color nodrag nopan">
      <input
        className="gf-color-swatch"
        type="color"
        value={v}
        onChange={(e) => onChange?.(e.target.value, true)}
        onBlur={(e) => onChange?.(e.target.value, false)}
      />
      {showHex && (
        <input
          className="gf-color-hex"
          type="text"
          spellCheck={false}
          value={v}
          onChange={(e) => {
            const next = e.target.value;
            if (/^#[0-9a-f]{6}$/i.test(next)) onChange?.(next, false);
          }}
        />
      )}
    </div>
  );
}

export function SelectField({ value, options, onChange }) {
  return (
    <select className="gf-select nodrag nopan" value={value} onChange={(e) => onChange?.(e.target.value, false)}>
      {options.map((opt) => {
        const key = typeof opt === "string" ? opt : opt.value;
        const label = typeof opt === "string" ? opt : opt.label;
        return (
          <option key={key} value={key}>
            {label}
          </option>
        );
      })}
    </select>
  );
}

export function BoolField({ value, onChange }) {
  return (
    <button
      type="button"
      className={`gf-toggle nodrag nopan${value ? " on" : ""}`}
      onClick={() => onChange?.(!value, false)}
      role="switch"
      aria-checked={!!value}
    >
      <span className="gf-toggle-knob" />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Curve editor
// ---------------------------------------------------------------------------

const DEFAULT_CURVE = [
  { x: 0, y: 0 },
  { x: 1, y: 1 },
];

/**
 * Samples a control-point curve at `t` with monotone-safe linear
 * interpolation. Kept linear on purpose: a spline through user-placed points
 * can overshoot outside [0,1], and these curves drive size/opacity/velocity
 * where a negative overshoot is a visible popping artifact.
 */
export function sampleCurve(points, t) {
  const pts = points?.length ? points : DEFAULT_CURVE;
  if (t <= pts[0].x) return pts[0].y;
  if (t >= pts[pts.length - 1].x) return pts[pts.length - 1].y;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (t <= b.x) {
      const span = b.x - a.x;
      return span < 1e-6 ? b.y : a.y + ((t - a.x) / span) * (b.y - a.y);
    }
  }
  return pts[pts.length - 1].y;
}

/** Bakes a curve to a fixed-length Float32Array for upload to the GPU. */
export function bakeCurve(points, resolution = 64) {
  const out = new Float32Array(resolution);
  for (let i = 0; i < resolution; i++) out[i] = sampleCurve(points, i / (resolution - 1));
  return out;
}

const CURVE_W = 168;
const CURVE_H = 74;

/**
 * Canvas curve editor for over-life ramps (size, opacity, drag, …).
 * Drag a point to move it, double-click empty space to add one, right-click a
 * point to remove it. Endpoints stay pinned to x=0 and x=1 so the curve always
 * spans its full domain — a curve that stopped at x=0.7 would leave the last
 * 30% of every particle's life undefined.
 */
export function CurveField({ value, onChange, yMin = 0, yMax = 1 }) {
  const canvasRef = useRef(null);
  const [dragIndex, setDragIndex] = useState(null);
  const points = value?.length ? value : DEFAULT_CURVE;

  const toCanvas = useCallback(
    (p) => ({
      x: p.x * (CURVE_W - 2) + 1,
      y: CURVE_H - 1 - ((p.y - yMin) / (yMax - yMin || 1)) * (CURVE_H - 2),
    }),
    [yMin, yMax],
  );
  const fromCanvas = useCallback(
    (x, y) => ({
      x: clamp((x - 1) / (CURVE_W - 2), 0, 1),
      y: clamp(yMin + ((CURVE_H - 1 - y) / (CURVE_H - 2)) * (yMax - yMin), yMin, yMax),
    }),
    [yMin, yMax],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, CURVE_W, CURVE_H);
    ctx.fillStyle = "rgba(255,255,255,0.03)";
    ctx.fillRect(0, 0, CURVE_W, CURVE_H);
    ctx.strokeStyle = "rgba(255,255,255,0.07)";
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const gx = (i / 4) * CURVE_W;
      const gy = (i / 4) * CURVE_H;
      ctx.beginPath();
      ctx.moveTo(gx, 0);
      ctx.lineTo(gx, CURVE_H);
      ctx.moveTo(0, gy);
      ctx.lineTo(CURVE_W, gy);
      ctx.stroke();
    }
    ctx.strokeStyle = "#0a84ff";
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    points.forEach((p, i) => {
      const c = toCanvas(p);
      if (i === 0) ctx.moveTo(c.x, c.y);
      else ctx.lineTo(c.x, c.y);
    });
    ctx.stroke();
    ctx.fillStyle = "#ececee";
    for (const p of points) {
      const c = toCanvas(p);
      ctx.beginPath();
      ctx.arc(c.x, c.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [points, toCanvas]);

  const localPos = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const hitTest = (pos) =>
    points.findIndex((p) => {
      const c = toCanvas(p);
      return Math.hypot(c.x - pos.x, c.y - pos.y) < 7;
    });

  return (
    <canvas
      ref={canvasRef}
      className="gf-curve nodrag nopan"
      width={CURVE_W}
      height={CURVE_H}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const index = hitTest(localPos(e));
        // Endpoints are structural — removing one would leave the curve
        // undefined over part of its domain.
        if (index > 0 && index < points.length - 1) {
          onChange?.(points.filter((_, i) => i !== index), false);
        }
      }}
      onDoubleClick={(e) => {
        const pos = localPos(e);
        if (hitTest(pos) >= 0) return;
        const p = fromCanvas(pos.x, pos.y);
        const next = [...points, p].sort((a, b) => a.x - b.x);
        onChange?.(next, false);
      }}
      onPointerDown={(e) => {
        const index = hitTest(localPos(e));
        if (index < 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        setDragIndex(index);
      }}
      onPointerMove={(e) => {
        if (dragIndex == null) return;
        const pos = localPos(e);
        const p = fromCanvas(pos.x, pos.y);
        const next = points.map((q, i) => {
          if (i !== dragIndex) return q;
          // Endpoints slide vertically only.
          const isEnd = i === 0 || i === points.length - 1;
          return { x: isEnd ? q.x : p.x, y: p.y };
        });
        next.sort((a, b) => a.x - b.x);
        onChange?.(next, true);
      }}
      onPointerUp={() => {
        if (dragIndex != null) onChange?.(points, false);
        setDragIndex(null);
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Gradient (multi-stop colour ramp)
// ---------------------------------------------------------------------------

const DEFAULT_STOPS = [
  { t: 0, color: "#ffd27f" },
  { t: 1, color: "#ff3300" },
];

const GRAD_W = 168;
const GRAD_H = 22;

/** Bakes a stop list into RGB triplets for a GPU lookup texture/array. */
export function bakeGradient(stops, resolution = 64) {
  const list = (stops?.length ? [...stops] : DEFAULT_STOPS).sort((a, b) => a.t - b.t);
  const out = new Float32Array(resolution * 3);
  const hex = (c) => {
    const n = parseInt((c ?? "#ffffff").slice(1), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  };
  const rgb = list.map((s) => hex(s.color));
  for (let i = 0; i < resolution; i++) {
    const t = i / (resolution - 1);
    let k = 0;
    while (k < list.length - 1 && t > list[k + 1].t) k++;
    const a = list[k];
    const b = list[Math.min(k + 1, list.length - 1)];
    const span = b.t - a.t;
    const f = span < 1e-6 ? 0 : clamp((t - a.t) / span, 0, 1);
    for (let c = 0; c < 3; c++) {
      out[i * 3 + c] = rgb[k][c] + (rgb[Math.min(k + 1, list.length - 1)][c] - rgb[k][c]) * f;
    }
  }
  return out;
}

/**
 * Multi-stop colour ramp. Click a stop to select it (its swatch opens the
 * colour picker), drag to reposition, double-click the bar to insert a stop,
 * right-click a stop to delete it. Replaces the two-colour `gradient` node,
 * which could only ever do a straight A→B fade.
 */
export function GradientField({ value, onChange }) {
  const stops = (value?.length ? value : DEFAULT_STOPS).slice().sort((a, b) => a.t - b.t);
  const [selected, setSelected] = useState(0);
  const [dragIndex, setDragIndex] = useState(null);
  const barRef = useRef(null);

  const css = `linear-gradient(to right, ${stops.map((s) => `${s.color} ${s.t * 100}%`).join(", ")})`;
  const tAt = (e) => {
    const rect = barRef.current.getBoundingClientRect();
    return clamp((e.clientX - rect.left) / rect.width, 0, 1);
  };
  const update = (next, gesture) => {
    onChange?.(next.slice().sort((a, b) => a.t - b.t), gesture);
  };

  return (
    <div className="gf-gradient nodrag nopan">
      <div
        ref={barRef}
        className="gf-gradient-bar"
        style={{ background: css, width: GRAD_W, height: GRAD_H }}
        onDoubleClick={(e) => {
          const t = tAt(e);
          // New stop takes the colour the ramp already shows there, so
          // inserting a stop never changes the gradient's appearance.
          let k = 0;
          while (k < stops.length - 1 && t > stops[k + 1].t) k++;
          update([...stops, { t, color: stops[k].color }], false);
        }}
        onPointerMove={(e) => {
          if (dragIndex == null) return;
          update(stops.map((s, i) => (i === dragIndex ? { ...s, t: tAt(e) } : s)), true);
        }}
        onPointerUp={() => {
          if (dragIndex != null) update(stops, false);
          setDragIndex(null);
        }}
      >
        {stops.map((s, i) => (
          <span
            key={i}
            className={`gf-gradient-stop${selected === i ? " selected" : ""}`}
            style={{ left: `${s.t * 100}%`, background: s.color }}
            onPointerDown={(e) => {
              e.stopPropagation();
              barRef.current.setPointerCapture(e.pointerId);
              setSelected(i);
              setDragIndex(i);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              // A ramp needs at least two stops to be a ramp.
              if (stops.length > 2) {
                update(stops.filter((_, k) => k !== i), false);
                setSelected(0);
              }
            }}
          />
        ))}
      </div>
      <ColorField
        value={stops[Math.min(selected, stops.length - 1)]?.color}
        showHex={false}
        onChange={(color, gesture) =>
          update(stops.map((s, i) => (i === selected ? { ...s, color } : s)), gesture)
        }
      />
    </div>
  );
}
