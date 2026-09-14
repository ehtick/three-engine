import { STYLE_IDS, normalizeStyleParams } from "./styles/catalog.js";

/** Reactive architectural masses. Coordinates are local to the model root. */
export const DEFAULT_FORM_COLOR = "#ddc7a5";
export const FORM_ROOFS = Object.freeze(["auto", "hip", "gable", "flat", "none", "shed", "dome"]);
export const OPENING_HEAD_CHOICES = Object.freeze(["auto", "flat", "round", "pointed", "segment"]);
const numeric = (value, fallback, min, max) => {
  const n = Number(value);
  return Math.max(min, Math.min(max, Number.isFinite(n) ? n : fallback));
};
const vector = (value, defaults, min, max) => defaults.map((fallback, i) => numeric(value?.[i], fallback, min, max));
const color = value => typeof value === "string" && /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(value) ? value : DEFAULT_FORM_COLOR;
const colorOrNull = value => typeof value === "string" && /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(value) ? value : null;
const pick = (value, choices, fallback) => choices.includes(value) ? value : fallback;

/** `model.style = { id, seed, palette?, params? }`. An unknown id falls back to `timber-medieval`;
 * a missing seed defaults to 1. Absent `style` means unstyled massing and the key is omitted. */
function normalizeStyle(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const id = typeof value.id === "string" && STYLE_IDS.includes(value.id) ? value.id : "timber-medieval";
  const seedNumber = Number(value.seed);
  const style = { id, seed: Number.isFinite(seedNumber) ? seedNumber : 1 };
  if (value.palette && typeof value.palette === "object" && !Array.isArray(value.palette)) style.palette = { ...value.palette };
  const params = normalizeStyleParams(value.params);
  if (params) style.params = params;
  return style;
}
const list = (value, max, label) => {
  if (!Array.isArray(value)) return [];
  if (value.length > max) throw new Error(`Architecture supports up to ${max} ${label}.`);
  return value;
};
const identifier = (value, prefix, i) => typeof value === "string" && value.trim() ? value.slice(0, 100) : `${prefix}-${i + 1}`;

export function normalizeArchitectureModel(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const forms = list(source.forms, 256, "forms").map((form, i) => {
    const out = {
      id: identifier(form?.id, "form", i), shape: pick(form?.shape, ["box", "round"], "box"),
      position: vector(form?.position, [0, 0, 0], -100000, 100000),
      size: vector(form?.size, [3, 3, 3], .3, 500),
      rotationY: numeric(form?.rotationY, 0, -Math.PI * 20000, Math.PI * 20000),
      color: color(form?.color), roof: pick(form?.roof, FORM_ROOFS, "hip"),
      roofAxis: pick(form?.roofAxis, ["x", "z"], null), roofColor: colorOrNull(form?.roofColor),
      roofHeight: form?.roofHeight === null || form?.roofHeight === "auto" ? null : numeric(form?.roofHeight, 1.2, .1, 50), windows: form?.windows !== false,
    };
    if (form?.kind === "wall") out.kind = "wall";
    return out;
  });
  const ids = new Set(forms.map(form => form.id));
  if (ids.size !== forms.length) throw new Error("Architecture form IDs must be unique.");
  let pointCount = 0;
  const paths = list(source.paths, 64, "paths").map((path, i) => {
    const points = list(path?.points, 64, "points per path").map(point => vector(point, [0, 0], -100000, 100000));
    pointCount += points.length;
    return { id: identifier(path?.id, "path", i), points, width: numeric(path?.width, 2, .3, 30), elevation: numeric(path?.elevation, 0, -100000, 100000) };
  }).filter(path => path.points.length >= 2);
  if (pointCount > 2048) throw new Error("Architecture paths support up to 2,048 points in total.");
  const openings = list(source.openings, 512, "openings").map((opening, i) => {
    const n = vector(opening?.normal, [0, 0, -1], -1, 1), length = Math.hypot(n[0], n[2]);
    const out = { id: identifier(opening?.id, "opening", i), formId: opening?.formId,
      position: vector(opening?.position, [0, 1.5, 0], -100000, 100000), normal: length > 1e-6 ? [n[0] / length, 0, n[2] / length] : [0, 0, -1],
      width: numeric(opening?.width, 1, .15, 100), height: numeric(opening?.height, 1.2, .15, 100),
      kind: pick(opening?.kind, ["window", "door", "arch"], "window"),
    };
    const head = pick(opening?.head, OPENING_HEAD_CHOICES, "auto");
    if (head !== "auto") out.head = head;
    return out;
  }).filter(opening => ids.has(opening.formId));
  if (new Set(paths.map(path => path.id)).size !== paths.length) throw new Error("Architecture path IDs must be unique.");
  if (new Set(openings.map(opening => opening.id)).size !== openings.length) throw new Error("Architecture opening IDs must be unique.");
  const style = normalizeStyle(source.style);
  return { version: 1, cellSize: numeric(source.cellSize, 3, .25, 50), forms, paths, openings, ...(style ? { style } : {}) };
}

/** A free-standing wall: authored with the Wall gesture, or a legacy thin roofless form. */
export function isBoundaryForm(form) {
  return form.kind === "wall" || (form.roof === "none" && form.windows === false && Math.min(form.size[0], form.size[2]) <= 1.25);
}

/** The concrete roof a form builds with: `auto` follows the style (box → style.roof.box, round →
 * cone/dome/flat), and a missing `roofHeight` follows the style's pitch. `style` is a resolved
 * catalogue record or null (unstyled: gable box / cone tower at 40°). */
export function resolveArchitectureForm(form, style = null) {
  const boundary = isBoundaryForm(form);
  let roof = form.roof;
  if (roof === "auto") {
    if (boundary) roof = "none";
    else if (form.shape === "round") { const r = style?.roof.round ?? "cone"; roof = r === "dome" ? "dome" : r === "flat" ? "flat" : "hip"; }
    else roof = style?.roof.box ?? "gable";
  }
  if (form.shape === "round" && (roof === "gable" || roof === "shed")) roof = "hip";
  if (form.shape !== "round" && roof === "dome") roof = "hip";
  let roofHeight = form.roofHeight;
  if (!(roofHeight > 0)) {
    const pitch = style?.roof.pitch ?? 40 * Math.PI / 180;
    const [w, , d] = form.size;
    if (form.shape === "round") roofHeight = roof === "dome" ? Math.min(w, d) * .45 : Math.min(w, d) / 2 * Math.tan(Math.max(pitch, 55 * Math.PI / 180));
    else if (roof === "shed") roofHeight = (form.roofAxis === "z" ? w : d) * Math.tan(pitch * .5);
    else roofHeight = Math.min(w, d) / 2 * Math.tan(pitch);
    roofHeight = Math.max(.3, Math.min(30, roofHeight));
  }
  return roof === form.roof && roofHeight === form.roofHeight ? form : { ...form, roof, roofHeight };
}

/** Counter-clockwise XZ ring, matching the faceted circular shell exactly. */
export function getArchitectureFormFootprint(form) {
  const [width, , depth] = form.size, [x, , z] = form.position;
  const c = Math.cos(form.rotationY || 0), s = Math.sin(form.rotationY || 0);
  const points = form.shape === "round"
    ? Array.from({ length: 24 }, (_, i) => [Math.cos(i * Math.PI / 12) * width / 2, Math.sin(i * Math.PI / 12) * depth / 2])
    : [[-width / 2, -depth / 2], [width / 2, -depth / 2], [width / 2, depth / 2], [-width / 2, depth / 2]];
  return points.map(([px, pz]) => [x + px * c + pz * s, z - px * s + pz * c]);
}

export function architectureFormBounds(form, includeRoof = true) {
  const ring = getArchitectureFormFootprint(form), resolved = resolveArchitectureForm(form);
  const pitched = ["hip", "gable", "shed", "dome"].includes(resolved.roof);
  return { min: [Math.min(...ring.map(p => p[0])), form.position[1], Math.min(...ring.map(p => p[1]))],
    max: [Math.max(...ring.map(p => p[0])), form.position[1] + form.size[1] + (includeRoof && pitched ? resolved.roofHeight : 0), Math.max(...ring.map(p => p[1]))] };
}
