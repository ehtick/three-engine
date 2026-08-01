import * as THREE from "three/webgpu";

/**
 * Runtime signed-distance-field font atlases.
 *
 * The UI used to rasterize text into a canvas sized to the element's on-screen
 * pixels. That is genuinely sharp for a HUD that never moves, and hopeless the
 * moment anything scales: a world-space label gets blurry as you walk toward
 * it, a tweened scale re-rasterizes and re-uploads a texture every frame, and
 * anything past 2048 physical pixels is simply clamped. An SDF is generated
 * once per glyph and is sharp at every size — which is the only thing that
 * makes world-space UI and animated text usable.
 *
 * Single-channel SDF (the tiny-sdf approach: rasterize the glyph, run a
 * Euclidean distance transform over the coverage), not multi-channel MSDF.
 * MSDF preserves hard corners slightly better at extreme magnification, but it
 * needs glyph *outlines* — which canvas does not expose — so it means shipping
 * a font-outline parser and a pre-baked atlas pipeline. Single-channel keeps
 * this to arithmetic over a canvas the browser already knows how to draw, and
 * works with any font the user's system has. The visible cost is a very
 * slightly rounded corner on hard-cornered typefaces at large sizes.
 *
 * The distance-transform half of this file is pure and runs in Node — see
 * `npm run test:ui`.
 */

const INF = 1e20;

/**
 * Felzenszwalb & Huttenlocher's exact 1-D squared distance transform.
 *
 * `f` is the input row, `d` the output, `v`/`z` scratch (parabola indices and
 * their intersection boundaries). Linear time — the naive O(n²) version is
 * fast enough for one glyph and hopeless for a whole atlas.
 */
export function edt1d(f, d, v, z, n) {
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  let k = 0;
  for (let q = 1; q < n; q++) {
    let s;
    do {
      const r = v[k];
      s = (f[q] - f[r] + q * q - r * r) / (q - r) / 2;
    } while (s <= z[k] && --k > -1);
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const r = v[k];
    d[q] = (q - r) * (q - r) + f[r];
  }
}

/** 2-D squared distance transform, in place, by rows then columns. */
export function edt2d(data, width, height, f, d, v, z) {
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) f[y] = data[y * width + x];
    edt1d(f, d, v, z, height);
    for (let y = 0; y < height; y++) data[y * width + x] = d[y];
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) f[x] = data[y * width + x];
    edt1d(f, d, v, z, width);
    for (let x = 0; x < width; x++) data[y * width + x] = d[x];
  }
}

/**
 * Turns a coverage bitmap (0..1 per pixel) into a distance field byte per
 * pixel, where 0.5 (128) is the glyph edge and the field spans ±`radius`
 * pixels.
 *
 * The half-open treatment of partially covered pixels — seeding the transform
 * with `(0.5 - alpha)²` rather than 0 or INF — is what keeps the field
 * sub-pixel accurate. Without it the field quantises to whole pixels and small
 * text looks like it was drawn with a chisel.
 */
export function coverageToSdf(alpha, width, height, { radius = 8, cutoff = 0.25 } = {}) {
  const n = width * height;
  const gridOuter = new Float64Array(n);
  const gridInner = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = alpha[i];
    if (a === 0) {
      gridOuter[i] = INF;
      gridInner[i] = 0;
    } else if (a === 1) {
      gridOuter[i] = 0;
      gridInner[i] = INF;
    } else {
      const outer = Math.max(0, 0.5 - a);
      const inner = Math.max(0, a - 0.5);
      gridOuter[i] = outer * outer;
      gridInner[i] = inner * inner;
    }
  }
  const size = Math.max(width, height);
  const f = new Float64Array(size);
  const d = new Float64Array(size);
  const v = new Int16Array(size);
  const z = new Float64Array(size + 1);
  edt2d(gridOuter, width, height, f, d, v, z);
  edt2d(gridInner, width, height, f, d, v, z);

  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const dist = Math.sqrt(gridOuter[i]) - Math.sqrt(gridInner[i]);
    out[i] = Math.max(0, Math.min(255, Math.round(255 - 255 * (dist / radius + cutoff))));
  }
  return out;
}

/** Atlas resolution the glyphs are rasterized at. Higher = finer field. */
const GLYPH_SIZE = 48;
/** Padding around each glyph, so the field has room to fall off (outlines). */
const GLYPH_BUFFER = 8;
const SDF_RADIUS = 8;
const SDF_CUTOFF = 0.25;

/**
 * The field value AT the glyph edge.
 *
 * Not 0.5. The encoding is `v = 1 - cutoff - d/radius`, so d = 0 lands on
 * `1 - cutoff`; the asymmetry buys more of the byte range for the *outside* of
 * the glyph, which is where outlines and glows live. Getting this constant
 * wrong shifts every glyph's weight — text comes out uniformly too fat or too
 * thin, which reads as "the font is wrong" rather than "a threshold is off".
 */
export const SDF_EDGE = 1 - SDF_CUTOFF;

/**
 * Converts an outline width in rendered UI pixels into field units.
 *
 * Beyond ~`GLYPH_BUFFER` atlas pixels the field is saturated and the outline
 * simply stops growing, so this clamps rather than letting a large number look
 * like it did nothing.
 */
export function outlineToField(px, fontSize) {
  if (!(px > 0) || !(fontSize > 0)) return 0;
  const field = (px / fontSize) * (GLYPH_SIZE / SDF_RADIUS);
  return Math.min(field, SDF_EDGE - 0.05);
}

/**
 * A lazily-filled SDF atlas for one (family, weight) pair. Glyphs are
 * rasterized on first use — a game that only ever shows digits pays for
 * digits.
 */
export class SdfFont {
  constructor({ fontFamily = "system-ui, sans-serif", fontWeight = "400", atlasSize = 512 } = {}) {
    this.fontFamily = fontFamily;
    this.fontWeight = fontWeight;
    this.atlasSize = atlasSize;
    this.glyphs = new Map(); // char -> metrics (em units) + atlas uv rect
    this.data = new Uint8Array(atlasSize * atlasSize);
    this.texture = new THREE.DataTexture(this.data, atlasSize, atlasSize, THREE.RedFormat);
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;
    // Shelf packing: a row at a time, tallest glyph sets the row height.
    this.penX = 0;
    this.penY = 0;
    this.rowHeight = 0;
    this.full = false;

    this.canvas = typeof document !== "undefined" ? document.createElement("canvas") : null;
    this.ctx = this.canvas?.getContext("2d", { willReadFrequently: true }) ?? null;
    if (this.ctx) {
      this.canvas.width = GLYPH_SIZE * 3;
      this.canvas.height = GLYPH_SIZE * 3;
      this.ctx.font = `${fontWeight} ${GLYPH_SIZE}px ${fontFamily}`;
      this.ctx.textBaseline = "alphabetic";
      this.ctx.textAlign = "left";
      this.ctx.fillStyle = "#fff";
      const m = this.ctx.measureText("Mg");
      // Line box in em units, from the font's own metrics rather than a
      // guess — the difference shows up as text sitting visibly high or low
      // in its box for fonts with unusual ascenders.
      this.ascent = (m.fontBoundingBoxAscent ?? GLYPH_SIZE * 0.8) / GLYPH_SIZE;
      this.descent = (m.fontBoundingBoxDescent ?? GLYPH_SIZE * 0.2) / GLYPH_SIZE;
    } else {
      this.ascent = 0.8;
      this.descent = 0.2;
    }
  }

  /**
   * Metrics for `char`, rasterizing it into the atlas on first ask. All
   * distances are in em (multiples of the rendered font size), so the caller
   * never sees the atlas resolution.
   *
   * Returns null when the glyph has no ink (space) or the atlas is full — both
   * of which the layout treats as "advance the pen, draw nothing".
   */
  glyph(char) {
    const cached = this.glyphs.get(char);
    if (cached !== undefined) return cached;
    const metrics = this.#rasterize(char);
    this.glyphs.set(char, metrics);
    return metrics;
  }

  /** Horizontal advance in em, including for glyphs with no ink. */
  advance(char) {
    const g = this.glyph(char);
    if (g) return g.advance;
    return this.advances?.get(char) ?? 0;
  }

  #rasterize(char) {
    const ctx = this.ctx;
    if (!ctx) return null;
    if (!this.advances) this.advances = new Map();

    const m = ctx.measureText(char);
    const advance = m.width / GLYPH_SIZE;
    this.advances.set(char, advance);

    const left = m.actualBoundingBoxLeft ?? 0;
    const right = m.actualBoundingBoxRight ?? m.width;
    const ascent = m.actualBoundingBoxAscent ?? GLYPH_SIZE * 0.8;
    const descent = m.actualBoundingBoxDescent ?? 0;
    const inkW = Math.ceil(left + right);
    const inkH = Math.ceil(ascent + descent);
    if (!(inkW > 0) || !(inkH > 0)) return null; // whitespace

    const w = inkW + GLYPH_BUFFER * 2;
    const h = inkH + GLYPH_BUFFER * 2;
    if (w > this.canvas.width || h > this.canvas.height) return null;

    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.fillText(char, GLYPH_BUFFER + left, GLYPH_BUFFER + ascent);
    const pixels = ctx.getImageData(0, 0, w, h).data;
    const coverage = new Float64Array(w * h);
    for (let i = 0; i < w * h; i++) coverage[i] = pixels[i * 4 + 3] / 255;
    const sdf = coverageToSdf(coverage, w, h, { radius: SDF_RADIUS, cutoff: SDF_CUTOFF });

    const rect = this.#pack(w, h);
    if (!rect) {
      this.full = true;
      return null;
    }
    for (let y = 0; y < h; y++) {
      this.data.set(sdf.subarray(y * w, y * w + w), (rect.y + y) * this.atlasSize + rect.x);
    }
    this.texture.needsUpdate = true;

    const s = this.atlasSize;
    return {
      advance,
      // Quad geometry in em, relative to the pen position on the baseline.
      // `top` is above the baseline (positive up), matching how a font thinks.
      x: (-left - GLYPH_BUFFER) / GLYPH_SIZE,
      top: (ascent + GLYPH_BUFFER) / GLYPH_SIZE,
      w: w / GLYPH_SIZE,
      h: h / GLYPH_SIZE,
      u0: rect.x / s,
      v0: rect.y / s,
      u1: (rect.x + w) / s,
      v1: (rect.y + h) / s,
    };
  }

  #pack(w, h) {
    if (this.penX + w > this.atlasSize) {
      this.penX = 0;
      this.penY += this.rowHeight;
      this.rowHeight = 0;
    }
    if (this.penY + h > this.atlasSize) return null;
    const rect = { x: this.penX, y: this.penY };
    this.penX += w;
    this.rowHeight = Math.max(this.rowHeight, h);
    return rect;
  }

  dispose() {
    this.texture.dispose();
    this.glyphs.clear();
  }
}

const fontCache = new Map();

/** Shared atlas per (family, weight) — one texture for every label using it. */
export function getSdfFont(fontFamily, fontWeight) {
  const key = `${fontWeight}|${fontFamily}`;
  let font = fontCache.get(key);
  if (!font) {
    font = new SdfFont({ fontFamily, fontWeight });
    fontCache.set(key, font);
  }
  return font;
}

/** Test/teardown hook — drops every cached atlas. */
export function disposeSdfFonts() {
  for (const font of fontCache.values()) font.dispose();
  fontCache.clear();
}

/**
 * Breaks `text` into lines that fit `maxWidth` (UI px), honouring explicit
 * newlines. `measure` returns the width of a string in UI px.
 *
 * A single word longer than the line is broken per character rather than
 * allowed to overflow — a 40-character German compound in a fixed-width panel
 * should wrap, not run off the edge and disappear under the clip rect.
 */
export function wrapText(text, maxWidth, measure, wrap = true) {
  const paragraphs = String(text ?? "").split("\n");
  if (!wrap || !(maxWidth > 0)) return paragraphs;
  const lines = [];
  for (const para of paragraphs) {
    const words = para.split(" ");
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (measure(candidate) <= maxWidth || !line) {
        // A word that alone exceeds the width has to be split.
        if (!line && measure(word) > maxWidth) {
          let chunk = "";
          for (const ch of word) {
            if (chunk && measure(chunk + ch) > maxWidth) {
              lines.push(chunk);
              chunk = ch;
            } else {
              chunk += ch;
            }
          }
          line = chunk;
          continue;
        }
        line = candidate;
      } else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

/**
 * Places every glyph of `text` inside a `w × h` box, in UI px with y down
 * (the UI's coordinate system), ready to become quads.
 *
 * Advances are summed per glyph, so kerning pairs are not applied — canvas
 * only exposes kerning through measuring a whole run, which cannot be
 * reconciled with a per-glyph atlas without a shaping engine.
 *
 * Returns `{ quads, width, height, lines }`.
 */
export function layoutGlyphs(font, w, h, style) {
  const size = Math.max(0.01, style.fontSize ?? 16);
  const lineHeight = size * (style.lineHeight ?? 1.25);
  const measure = (s) => {
    let total = 0;
    for (const ch of s) total += font.advance(ch) * size;
    return total;
  };
  const lines = wrapText(style.text, w, measure, style.wrap !== false);
  const blockH = lines.length * lineHeight;

  const valign = style.valign ?? "middle";
  let top = valign === "top" ? 0 : valign === "bottom" ? h - blockH : (h - blockH) / 2;

  const align = style.align ?? "center";
  const quads = [];
  let maxLineW = 0;
  for (const line of lines) {
    const lineW = measure(line);
    maxLineW = Math.max(maxLineW, lineW);
    let penX = align === "left" ? 0 : align === "right" ? w - lineW : (w - lineW) / 2;
    // Baseline within the line box, from the font's own ascent so lines of
    // mixed content sit on a common baseline.
    const baseline = top + (lineHeight - (font.ascent + font.descent) * size) / 2 + font.ascent * size;
    for (const ch of line) {
      const g = font.glyph(ch);
      if (g) {
        quads.push({
          x: penX + g.x * size,
          y: baseline - g.top * size,
          w: g.w * size,
          h: g.h * size,
          u0: g.u0,
          v0: g.v0,
          u1: g.u1,
          v1: g.v1,
        });
      }
      penX += font.advance(ch) * size;
    }
    top += lineHeight;
  }
  return { quads, width: maxLineW, height: blockH, lines };
}
