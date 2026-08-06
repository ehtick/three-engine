import { createStroke } from "./draw.js";

/**
 * Text, drawn into a texture layer.
 *
 * The rest of this editor composites through *coverage strokes* — an
 * 8-bit-per-texel mask that `applyStroke` then colours, blends, clips to the
 * selection and honours opacity with. Text goes through the same path rather
 * than blitting coloured pixels, and that is the whole design decision here:
 * it means typed text respects the active selection, the layer's blend mode,
 * the opacity slider and the eraser exactly the way a brush stroke does, with
 * no second implementation of any of it. The alternative — canvas-composite
 * the glyphs and copy RGBA in — would have been shorter and would have quietly
 * ignored every one of those.
 *
 * Rasterization itself is canvas 2D, which is the only way to get the
 * platform's hinting and shaping for an arbitrary font. The alpha channel of
 * what it draws IS the coverage mask.
 */

/** Offscreen canvas used for every rasterization, grown as needed. */
let scratch = null;

function ensureScratch(width, height) {
  if (typeof document === "undefined") return null;
  if (!scratch) {
    scratch = document.createElement("canvas");
    scratch.width = width;
    scratch.height = height;
  } else if (scratch.width < width || scratch.height < height) {
    scratch.width = Math.max(scratch.width, width);
    scratch.height = Math.max(scratch.height, height);
  }
  return scratch;
}

/**
 * The `ctx.font` shorthand for a text style.
 *
 * Order is fixed by the CSS spec — style, weight, size, family — and getting it
 * wrong doesn't throw: the assignment is silently ignored and you get 10px
 * sans-serif, which looks like the font failed to load.
 */
export function fontShorthand({ italic, bold, fontSize, fontFamily }) {
  const style = italic ? "italic " : "";
  const weight = bold ? "700 " : "400 ";
  return `${style}${weight}${Math.max(1, Math.round(fontSize))}px ${fontFamily}`;
}

/** Splits on explicit newlines only — wrapping is the caller's business. */
const linesOf = (text) => String(text ?? "").split("\n");

/**
 * Measures a block of text without rasterizing it: `{ width, height, lines }`
 * in texels. Used to place the caret box and to size the stamp.
 */
export function measureText(style) {
  const canvas = ensureScratch(8, 8);
  if (!canvas) return { width: 0, height: 0, lines: [], lineHeight: 0, ascent: 0 };
  const ctx = canvas.getContext("2d");
  ctx.font = fontShorthand(style);
  const lines = linesOf(style.text);
  const metrics = ctx.measureText("Mg");
  const ascent = metrics.fontBoundingBoxAscent ?? style.fontSize * 0.8;
  const descent = metrics.fontBoundingBoxDescent ?? style.fontSize * 0.2;
  const lineHeight = Math.max(1, Math.round(style.fontSize * (style.lineHeight ?? 1.2)));
  let width = 0;
  for (const line of lines) width = Math.max(width, ctx.measureText(line).width);
  return {
    width: Math.ceil(width),
    height: lineHeight * lines.length,
    lines,
    lineHeight,
    ascent,
    descent,
  };
}

/**
 * Rasterizes `style.text` into a coverage stroke over a `width × height`
 * document, anchored at `(x, y)`.
 *
 * `x`/`y` is the *baseline start* of the first line, adjusted by `align`, which
 * is what makes clicking on the canvas put the text where the caret was rather
 * than offset by an ascender.
 *
 * Returns null when there is nothing to draw (empty string, or the whole block
 * falls outside the document) so callers can skip the composite entirely.
 */
export function rasterizeTextStroke(width, height, { x, y, ...style }) {
  const measured = measureText(style);
  if (!measured.lines.some((line) => line.length > 0)) return null;

  const outline = Math.max(0, style.outlineWidth ?? 0);
  // The stamp is drawn at document size rather than into a tight box: the
  // arithmetic for clipping a tight box against the document (and against the
  // stroke's dirty rect) is where an off-by-one shows up as text sheared by a
  // pixel, and a document-sized canvas is a few megabytes we already spend on
  // every layer.
  const canvas = ensureScratch(width, height);
  if (!canvas) return null;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.font = fontShorthand(style);
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = style.align ?? "left";
  // Coverage only — the colour comes from `applyStroke`, so drawing in flat
  // white keeps the alpha channel a pure mask instead of premultiplied ink.
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "#ffffff";
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;

  let baseline = y + measured.ascent;
  for (const line of measured.lines) {
    if (line) {
      if (outline > 0) {
        // Stroked first and twice as wide: canvas strokes centred on the
        // outline, so half of it would eat into the glyph if the fill came
        // first, and the letterforms would come out visibly thin.
        ctx.lineWidth = outline * 2;
        ctx.strokeText(line, x, baseline);
      }
      ctx.fillText(line, x, baseline);
    }
    baseline += measured.lineHeight;
  }

  const pixels = ctx.getImageData(0, 0, width, height).data;
  const stroke = createStroke(width, height);
  const coverage = stroke.coverage;
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  for (let index = 0; index < width * height; index++) {
    const alpha = pixels[index * 4 + 3];
    if (!alpha) continue;
    coverage[index] = alpha;
    const px = index % width;
    const py = (index - px) / width;
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  }
  if (minX > maxX) return null; // every glyph landed off-canvas
  stroke.dirty = { x0: minX, y0: minY, x1: maxX + 1, y1: maxY + 1 };
  return stroke;
}

/**
 * The document-space box the text occupies, for drawing the placement guide
 * while typing. Same anchor rules as `rasterizeTextStroke`.
 */
export function textBounds({ x, y, ...style }) {
  const measured = measureText(style);
  const align = style.align ?? "left";
  const left = align === "center" ? x - measured.width / 2 : align === "right" ? x - measured.width : x;
  return { x: left, y, width: measured.width, height: measured.height };
}
