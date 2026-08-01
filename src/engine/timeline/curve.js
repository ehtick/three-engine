/**
 * Keyframe curve evaluation for timeline property tracks.
 *
 * Every function here is a pure function of (keys, time) — no cursor, no
 * "last evaluated" state. That is a requirement rather than a style choice: a
 * timeline is scrubbed backwards as often as it is played forwards, and any
 * evaluator that remembers where it was last frame produces a different pose
 * depending on how the playhead got there. The one thing a scrub has to
 * guarantee is that frame 40 looks the same whether you arrived from 39 or
 * from 200.
 *
 * Keys are stored sorted by `t` (normalizeTimeline sorts on load, and every
 * editor mutation re-sorts), so lookup is a binary search.
 */

/** Values a fresh key gets when a track is created with no sample to capture. */
export function defaultValueFor(valueType) {
  switch (valueType) {
    case "vec3":
    case "euler":
      return [0, 0, 0];
    case "color":
      return "#ffffff";
    case "boolean":
      return false;
    case "text":
      return "";
    default:
      return 0;
  }
}

/** True for value types that have no meaningful halfway point. */
export function isSteppedType(valueType) {
  return valueType === "boolean" || valueType === "text";
}

const clamp01 = (u) => (u < 0 ? 0 : u > 1 ? 1 : u);

// --- value <-> numeric components ------------------------------------------

function hexToRgb(hex) {
  const s = String(hex ?? "#000000").replace("#", "");
  const full = s.length === 3 ? s.split("").map((c) => c + c).join("") : s.padEnd(6, "0");
  const n = parseInt(full.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(rgb) {
  const to = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${to(rgb[0])}${to(rgb[1])}${to(rgb[2])}`;
}

/** Numeric components of a keyed value, or null when the type isn't numeric. */
export function toComponents(value, valueType) {
  switch (valueType) {
    case "vec3":
    case "euler":
      return Array.isArray(value) ? [value[0] ?? 0, value[1] ?? 0, value[2] ?? 0] : [0, 0, 0];
    case "color":
      return hexToRgb(value);
    case "boolean":
    case "text":
      return null;
    default: {
      const n = Number(value);
      return [Number.isFinite(n) ? n : 0];
    }
  }
}

export function fromComponents(components, valueType) {
  switch (valueType) {
    case "vec3":
    case "euler":
      return [components[0], components[1], components[2]];
    case "color":
      return rgbToHex(components);
    default:
      return components[0];
  }
}

/**
 * The equivalent of `b` closest to `a` on the circle. A key at 350° followed by
 * one at 10° is a 20° turn; without this it is a 340° spin the wrong way, which
 * is the single most common complaint about hand-keyed rotation.
 */
function nearestAngle(a, b) {
  return b + 360 * Math.round((a - b) / 360);
}

/** Shortest-path-adjusted components of key `index`, relative to `ref`. */
function componentsRelativeTo(keys, index, valueType, ref) {
  const raw = toComponents(keys[index]?.v, valueType);
  if (!raw || valueType !== "euler" || !ref) return raw;
  return raw.map((v, i) => nearestAngle(ref[i], v));
}

// --- tangents ---------------------------------------------------------------

/**
 * Auto tangent for key `i`, per component, in value-units per second.
 *
 * Auto-CLAMPED (Blender's default, and Unity's): a key that is a local extremum
 * gets a flat tangent. Plain Catmull-Rom overshoots there, and an overshoot on
 * a door's "closed" key means the door passes through the frame before settling
 * — visible, wrong, and impossible to fix by moving keys around.
 */
function autoTangent(keys, i, valueType, ref) {
  const cur = componentsRelativeTo(keys, i, valueType, ref);
  const prev = i > 0 ? componentsRelativeTo(keys, i - 1, valueType, cur) : null;
  const next = i < keys.length - 1 ? componentsRelativeTo(keys, i + 1, valueType, cur) : null;
  const tPrev = i > 0 ? keys[i - 1].t : keys[i].t;
  const tNext = i < keys.length - 1 ? keys[i + 1].t : keys[i].t;
  return cur.map((value, c) => {
    if (!prev && !next) return 0;
    if (!prev) {
      const dt = tNext - keys[i].t;
      return dt > 0 ? (next[c] - value) / dt : 0;
    }
    if (!next) {
      const dt = keys[i].t - tPrev;
      return dt > 0 ? (value - prev[c]) / dt : 0;
    }
    const rising = next[c] - value;
    const falling = value - prev[c];
    // Local extremum (or a flat neighbour) — clamp.
    if (rising * falling <= 0) return 0;
    const dt = tNext - tPrev;
    return dt > 0 ? (next[c] - prev[c]) / dt : 0;
  });
}

/**
 * Outgoing / incoming tangent of key `i` for the segment being evaluated.
 * `side` is "out" for the left key of a segment, "in" for the right one.
 *
 * Explicit bezier tangents are scalars, so they apply to single-component
 * (number) tracks only; a vec3 or a colour keyed as "bezier" evaluates with
 * auto tangents. Three tangent handles per key is a curve editor's problem, and
 * this is a dope sheet.
 */
function tangentFor(keys, i, valueType, side, ref, segmentSlope) {
  const key = keys[i];
  const auto = () => autoTangent(keys, i, valueType, ref);
  switch (key.interp) {
    case "step":
      return null; // signals "hold"
    case "linear":
      return segmentSlope;
    case "bezier": {
      const t = side === "out" ? key.outT : key.inT;
      if (Number.isFinite(t) && segmentSlope.length === 1) return [t];
      return auto();
    }
    default:
      return auto();
  }
}

// --- evaluation -------------------------------------------------------------

/** Index of the last key at or before `t`, or -1 when `t` precedes every key. */
export function keyIndexAt(keys, t) {
  let lo = 0;
  let hi = keys.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid].t <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/**
 * The value of a property track at `t`.
 *
 * Outside the keyed range the value is held (the first key before, the last key
 * after) rather than extrapolated: a curve that keeps climbing past its last
 * key is never what an author meant, and it turns "the timeline ended" into
 * "the light is now at intensity 400".
 */
export function evaluateKeys(keys, t, valueType = "number") {
  if (!keys?.length) return undefined;
  if (keys.length === 1) return keys[0].v;
  if (t <= keys[0].t) return keys[0].v;
  const last = keys[keys.length - 1];
  if (t >= last.t) return last.v;

  const i = keyIndexAt(keys, t);
  const a = keys[i];
  const b = keys[i + 1];
  if (!b) return a.v;
  if (isSteppedType(valueType) || a.interp === "step") return a.v;

  const span = b.t - a.t;
  if (span <= 0) return b.v;
  const u = clamp01((t - a.t) / span);

  const v0 = toComponents(a.v, valueType);
  const v1 = componentsRelativeTo(keys, i + 1, valueType, v0);
  if (!v0 || !v1) return a.v;

  const slope = v0.map((value, c) => (v1[c] - value) / span);
  // A pair of linear keys is by far the common case; skip the hermite maths so
  // the hot path of a 200-key transform track stays cheap.
  if (a.interp === "linear" && (b.interp === "linear" || b.interp === "step")) {
    return fromComponents(v0.map((value, c) => value + (v1[c] - value) * u), valueType);
  }

  const m0 = tangentFor(keys, i, valueType, "out", v0, slope) ?? slope;
  const m1 = tangentFor(keys, i + 1, valueType, "in", v0, slope) ?? slope;

  const u2 = u * u;
  const u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1;
  const h10 = u3 - 2 * u2 + u;
  const h01 = -2 * u3 + 3 * u2;
  const h11 = u3 - u2;
  const out = v0.map(
    (value, c) => h00 * value + h10 * span * m0[c] + h01 * v1[c] + h11 * span * m1[c],
  );
  return fromComponents(out, valueType);
}

/**
 * Straight interpolation between two authored values — used by the editor when
 * it needs a midpoint (inserting a key on an existing curve keeps its shape,
 * which `evaluateKeys` already gives, but the paste/duplicate paths want this).
 */
export function interpolateValue(a, b, u, valueType = "number") {
  if (isSteppedType(valueType)) return u < 1 ? a : b;
  const ca = toComponents(a, valueType);
  const cb = toComponents(b, valueType);
  if (!ca || !cb) return u < 1 ? a : b;
  const adjusted = valueType === "euler" ? cb.map((v, i) => nearestAngle(ca[i], v)) : cb;
  return fromComponents(ca.map((v, i) => v + (adjusted[i] - v) * clamp01(u)), valueType);
}

/** Deep-equality for keyed values, so a re-key can skip identical writes. */
export function valuesEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-9);
  }
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-9;
  return false;
}
