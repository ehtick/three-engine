/**
 * What "resize this to 1024" actually means.
 *
 * It means four different things depending on what the picture is, and an
 * editor that only offers one of them makes the other three someone's manual
 * job:
 *
 * - **fit** — scale until it fits inside the box, keeping the image's own
 *   aspect. A selection of mixed-aspect textures comes out at mixed sizes, all
 *   bounded by the box. This is what "make these smaller" almost always means.
 * - **stretch** — resample to exactly this many pixels, aspect ignored. What
 *   you want when the target is a fixed-size slot (a lightmap, an atlas cell).
 * - **cover** — scale until it covers the box, then crop the overflow at an
 *   anchor. Exact output size *and* undistorted, at the cost of losing edges.
 * - **canvas** — don't resample at all; pad or crop the frame around the
 *   pixels at an anchor. Changes the file's size without touching its artwork.
 *
 * `anchor` only has meaning for the two modes that can crop or pad, and the
 * UI hides it for the other two rather than showing a control that does
 * nothing.
 *
 * DOM-free on purpose (same rule as the rest of `texture/`): the sizing
 * arithmetic is the part worth testing headlessly, so it lives here rather than
 * inside the dialog or the op that calls it. See scripts/run-texture-test.mjs.
 */

import { cropBuffer, resizeBuffer, resizeCanvas } from "./pixels.js";
import { cropDocument, resampleDocument, resizeDocumentCanvas } from "./layers.js";

/** Hard ceiling on either dimension — the same one the panel's dialogs use. */
export const MAX_SIZE = 8192;

export const FIT_MODES = [
  { id: "fit", label: "Fit inside", hint: "Scale to fit the box, keeping each image's aspect ratio" },
  { id: "stretch", label: "Stretch", hint: "Resample to exactly this size, aspect ratio ignored" },
  { id: "cover", label: "Crop to fill", hint: "Scale to cover the box, then crop the overflow at the anchor" },
  { id: "canvas", label: "Canvas only", hint: "No resampling — pad or crop the frame around the pixels" },
];

/**
 * `texture.resize` shipped with `mode: "resize"` for the exact-size resample,
 * so that name keeps working; everything new says "stretch".
 */
const MODE_ALIASES = { resize: "stretch", exact: "stretch", contain: "fit", crop: "cover" };

export function normalizeMode(mode) {
  const id = String(mode ?? "fit").toLowerCase();
  const canonical = MODE_ALIASES[id] ?? id;
  return FIT_MODES.some((m) => m.id === canonical) ? canonical : "fit";
}

/** The anchor grid, in reading order. */
export const ANCHOR_ROWS = [
  ["nw", "n", "ne"],
  ["w", "c", "e"],
  ["sw", "s", "se"],
];

const COMPASS = {
  nw: "top-left",
  n: "top",
  ne: "top-right",
  w: "left",
  c: "center",
  e: "right",
  sw: "bottom-left",
  s: "bottom",
  se: "bottom-right",
};

/**
 * Anchor → the 0..1 factors to place the old pixels by inside the new frame.
 *
 * Both vocabularies are accepted: the compass ids the anchor grid stores
 * ("nw", "c") and the words an agent naturally types ("top-left", "center").
 * Refusing one of them would make the op and the dialog disagree about the
 * same control.
 */
export function anchorFactors(anchor) {
  const raw = String(anchor ?? "center").toLowerCase().trim();
  const name = COMPASS[raw] ?? raw;
  const x = name.includes("left") ? 0 : name.includes("right") ? 1 : 0.5;
  const y = name.includes("top") ? 0 : name.includes("bottom") ? 1 : 0.5;
  return [x, y];
}

export const clampSize = (value) => Math.max(1, Math.min(MAX_SIZE, Math.round(Number(value) || 1)));

/**
 * The size `source` ends up at under `spec`, without touching any pixels.
 *
 * `scale` (a percentage) wins over `width`/`height` when given — it is the only
 * way to say "half of whatever each of these is" to a mixed selection.
 *
 * @param {{width: number, height: number}} source
 * @param {{width?: number, height?: number, scale?: number, mode?: string}} spec
 * @returns {{width: number, height: number}}
 */
export function plannedSize(source, spec = {}) {
  const sw = Math.max(1, Math.round(source?.width ?? 1));
  const sh = Math.max(1, Math.round(source?.height ?? 1));

  if (spec.scale != null && spec.scale !== "") {
    const factor = Number(spec.scale) / 100;
    if (!Number.isFinite(factor) || factor <= 0) return { width: sw, height: sh };
    return { width: clampSize(sw * factor), height: clampSize(sh * factor) };
  }

  // A missing dimension is "unbounded", not "keep the old one": `fit` with only
  // a width is a legitimate "no wider than 1024, however tall that makes it".
  const w = spec.width == null || spec.width === "" ? Infinity : clampSize(spec.width);
  const h = spec.height == null || spec.height === "" ? Infinity : clampSize(spec.height);
  if (!Number.isFinite(w) && !Number.isFinite(h)) return { width: sw, height: sh };

  if (normalizeMode(spec.mode) === "fit") {
    const factor = Math.min(Number.isFinite(w) ? w / sw : Infinity, Number.isFinite(h) ? h / sh : Infinity);
    return { width: clampSize(sw * factor), height: clampSize(sh * factor) };
  }
  return { width: Number.isFinite(w) ? w : sw, height: Number.isFinite(h) ? h : sh };
}

/** How the source is placed inside the planned frame, for the cropping modes. */
function coverPlacement(source, target, anchor) {
  const factor = Math.max(target.width / source.width, target.height / source.height);
  // Round up: a covering size that rounds *down* leaves a transparent seam
  // along one edge, which is exactly what "crop to fill" promises not to do.
  const width = Math.max(target.width, Math.ceil(source.width * factor));
  const height = Math.max(target.height, Math.ceil(source.height * factor));
  const [ax, ay] = anchorFactors(anchor);
  return {
    width,
    height,
    x: Math.round((width - target.width) * ax),
    y: Math.round((height - target.height) * ay),
  };
}

/**
 * Applies `spec` to a raw pixel buffer. Returns a new buffer; the input is
 * left alone.
 *
 * @param {import("./pixels.js").PixelBuffer} buffer
 * @param {{width?: number, height?: number, scale?: number, mode?: string,
 *          anchor?: string, filter?: "bilinear"|"nearest"}} spec
 */
export function fitBuffer(buffer, spec = {}) {
  const mode = normalizeMode(spec.mode);
  const filter = spec.filter === "nearest" ? "nearest" : "bilinear";
  const target = plannedSize(buffer, spec);

  if (mode === "canvas") {
    const [ax, ay] = anchorFactors(spec.anchor);
    return resizeCanvas(
      buffer,
      target.width,
      target.height,
      Math.round((target.width - buffer.width) * ax),
      Math.round((target.height - buffer.height) * ay),
    );
  }
  if (mode === "cover") {
    const place = coverPlacement(buffer, target, spec.anchor);
    const scaled = resizeBuffer(buffer, place.width, place.height, { filter });
    return cropBuffer(scaled, place.x, place.y, target.width, target.height);
  }
  // `fit` and `stretch` differ only in the size plannedSize already returned.
  return resizeBuffer(buffer, target.width, target.height, { filter });
}

/**
 * Same thing for a layered document, **in place**.
 *
 * Layers survive: a resize is a size change, not a reason to lose someone's
 * layer stack. (`texture.process` flattens because an effect's result genuinely
 * replaces the stack; resizing has no such excuse.)
 *
 * @param {import("./layers.js").TextureDocument} doc
 * @returns the same document
 */
export function fitDocument(doc, spec = {}) {
  const mode = normalizeMode(spec.mode);
  const filter = spec.filter === "nearest" ? "nearest" : "bilinear";
  const source = { width: doc.width, height: doc.height };
  const target = plannedSize(source, spec);

  if (mode === "canvas") {
    const [ax, ay] = anchorFactors(spec.anchor);
    return resizeDocumentCanvas(
      doc,
      target.width,
      target.height,
      Math.round((target.width - source.width) * ax),
      Math.round((target.height - source.height) * ay),
    );
  }
  if (mode === "cover") {
    const place = coverPlacement(source, target, spec.anchor);
    resampleDocument(doc, place.width, place.height, { filter });
    return cropDocument(doc, place.x, place.y, target.width, target.height);
  }
  return resampleDocument(doc, target.width, target.height, { filter });
}
