/**
 * The layered document model.
 *
 * A layer's buffer is the full canvas size, plus a non-destructive integer
 * `offset` applied at composite time. That combination is deliberate: a
 * full-size buffer means every drawing operation writes in document
 * coordinates and never has to grow or reallocate mid-stroke, while the offset
 * makes the Move tool free and reversible — dragging a layer around is a pair
 * of numbers, not a resample, so moving it back leaves the pixels bit-identical
 * rather than progressively softened.
 *
 * Offsets are baked in on flatten and on merge, which is the only point at
 * which they can affect stored pixels.
 */

import { compositeLayers } from "./blend.js";
import {
  cloneBuffer,
  createBuffer,
  cropBuffer,
  flipBuffer,
  opaqueBounds,
  resizeBuffer,
  resizeCanvas,
  rotateBuffer,
} from "./pixels.js";

/**
 * @typedef {import("./pixels.js").PixelBuffer} PixelBuffer
 * @typedef {{ id: string, name: string, visible: boolean, opacity: number,
 *             blend: string, locked: boolean, offset: [number, number],
 *             buffer: PixelBuffer, mask: Uint8Array|null }} Layer
 * @typedef {{ width: number, height: number, layers: Layer[], activeId: string }} TextureDocument
 */

let idCounter = 0;
/** Ids only have to be unique within one open document, never persisted across
 *  projects — a counter is enough and keeps `.tex` diffs readable. */
export function nextLayerId() {
  idCounter += 1;
  return `l${idCounter}`;
}

export function createLayer({
  name = "Layer",
  width,
  height,
  buffer = null,
  fill = null,
  visible = true,
  opacity = 1,
  blend = "normal",
  locked = false,
  offset = [0, 0],
  mask = null,
  id = null,
} = {}) {
  return {
    id: id ?? nextLayerId(),
    name,
    visible,
    opacity,
    blend,
    locked,
    offset: [offset[0] ?? 0, offset[1] ?? 0],
    buffer: buffer ?? createBuffer(width, height, fill),
    mask,
  };
}

/**
 * `background` of `null` creates a transparent document — the right default
 * for sprites and UI art, which is most of what gets authored here. A tiling
 * surface texture wants an opaque base and asks for one.
 */
export function createDocument({ width = 512, height = 512, background = null, name = "Background" } = {}) {
  const layer = createLayer({ name, width, height, fill: background });
  return { width: layer.buffer.width, height: layer.buffer.height, layers: [layer], activeId: layer.id };
}

/** Wraps an already-decoded image as a one-layer document — the path every
 *  texture with no `.tex` sidecar takes when it is opened. */
export function documentFromBuffer(buffer, name = "Background") {
  const layer = createLayer({ name, buffer });
  return { width: buffer.width, height: buffer.height, layers: [layer], activeId: layer.id };
}

export function cloneDocument(doc) {
  return {
    width: doc.width,
    height: doc.height,
    activeId: doc.activeId,
    layers: doc.layers.map((layer) => ({
      ...layer,
      offset: [layer.offset[0], layer.offset[1]],
      buffer: cloneBuffer(layer.buffer),
      mask: layer.mask ? new Uint8Array(layer.mask) : null,
    })),
  };
}

export function layerIndex(doc, id) {
  return doc.layers.findIndex((layer) => layer.id === id);
}

export function getLayer(doc, id) {
  return doc.layers.find((layer) => layer.id === id) ?? null;
}

/** The layer edits are written to, or null when the active one is locked or
 *  hidden — callers must check, because silently painting into a locked layer
 *  is worse than doing nothing. */
export function activeLayer(doc) {
  return getLayer(doc, doc.activeId);
}

/** Inserts directly above `aboveId` (default: above the active layer). */
export function addLayer(doc, options = {}, aboveId = undefined) {
  const layer = createLayer({ width: doc.width, height: doc.height, ...options });
  const anchor = aboveId === undefined ? doc.activeId : aboveId;
  const at = layerIndex(doc, anchor);
  doc.layers.splice(at < 0 ? doc.layers.length : at + 1, 0, layer);
  doc.activeId = layer.id;
  return layer;
}

/** Removing the last layer is refused: a document with no layers has no size
 *  to draw into and every tool would have to special-case it. */
export function removeLayer(doc, id) {
  if (doc.layers.length <= 1) return false;
  const at = layerIndex(doc, id);
  if (at < 0) return false;
  doc.layers.splice(at, 1);
  if (doc.activeId === id) doc.activeId = doc.layers[Math.min(at, doc.layers.length - 1)].id;
  return true;
}

export function duplicateLayer(doc, id) {
  const at = layerIndex(doc, id);
  if (at < 0) return null;
  const source = doc.layers[at];
  const copy = createLayer({
    ...source,
    id: nextLayerId(),
    name: `${source.name} copy`,
    buffer: cloneBuffer(source.buffer),
    mask: source.mask ? new Uint8Array(source.mask) : null,
  });
  doc.layers.splice(at + 1, 0, copy);
  doc.activeId = copy.id;
  return copy;
}

/** `delta` of +1 moves the layer one step up the stack (later in the array). */
export function reorderLayer(doc, id, delta) {
  const at = layerIndex(doc, id);
  if (at < 0) return false;
  const to = Math.max(0, Math.min(doc.layers.length - 1, at + delta));
  if (to === at) return false;
  const [layer] = doc.layers.splice(at, 1);
  doc.layers.splice(to, 0, layer);
  return true;
}

/**
 * Merges a layer into the one below it, baking opacity, blend mode, mask and
 * offset into the result — which is why the merged layer always comes out
 * `normal` at full opacity: those settings have already been applied, and
 * leaving them set would apply them a second time.
 */
export function mergeDown(doc, id) {
  const at = layerIndex(doc, id);
  if (at <= 0) return false;
  const upper = doc.layers[at];
  const lower = doc.layers[at - 1];
  const merged = compositeLayers(
    [
      { ...lower, visible: true },
      { ...upper, visible: upper.visible },
    ],
    doc.width,
    doc.height,
  );
  lower.buffer = merged;
  lower.offset = [0, 0];
  lower.opacity = 1;
  lower.blend = "normal";
  lower.mask = null;
  doc.layers.splice(at, 1);
  doc.activeId = lower.id;
  return true;
}

/** @returns {PixelBuffer} the document as the PNG on disk will look. */
export function flattenDocument(doc) {
  return compositeLayers(doc.layers, doc.width, doc.height);
}

export function flattenToLayer(doc, name = "Flattened") {
  const buffer = flattenDocument(doc);
  doc.layers = [createLayer({ name, buffer })];
  doc.activeId = doc.layers[0].id;
  return doc;
}

/** Canvas size change: pixels keep their scale, the frame around them moves. */
export function resizeDocumentCanvas(doc, width, height, offsetX = 0, offsetY = 0) {
  for (const layer of doc.layers) {
    layer.buffer = resizeCanvas(layer.buffer, width, height, offsetX, offsetY);
    if (layer.mask) layer.mask = resizeMask(layer.mask, doc.width, doc.height, width, height, offsetX, offsetY);
  }
  doc.width = doc.layers[0].buffer.width;
  doc.height = doc.layers[0].buffer.height;
  return doc;
}

/** Image size change: every layer is resampled, offsets scale with it. */
export function resampleDocument(doc, width, height, { filter = "nearest" } = {}) {
  const sx = width / doc.width;
  const sy = height / doc.height;
  for (const layer of doc.layers) {
    layer.buffer = resizeBuffer(layer.buffer, width, height, { filter });
    layer.offset = [Math.round(layer.offset[0] * sx), Math.round(layer.offset[1] * sy)];
    if (layer.mask) {
      layer.mask = resampleMask(layer.mask, doc.width, doc.height, layer.buffer.width, layer.buffer.height, filter);
    }
  }
  doc.width = doc.layers[0].buffer.width;
  doc.height = doc.layers[0].buffer.height;
  return doc;
}

export function cropDocument(doc, x, y, width, height) {
  for (const layer of doc.layers) {
    layer.buffer = cropBuffer(layer.buffer, x, y, width, height);
    if (layer.mask) layer.mask = resizeMask(layer.mask, doc.width, doc.height, width, height, -x, -y);
  }
  doc.width = doc.layers[0].buffer.width;
  doc.height = doc.layers[0].buffer.height;
  return doc;
}

/**
 * Bakes every layer's non-destructive offset into its pixels.
 *
 * Anything that changes the document's shape has to do this first: an offset is
 * a vector in document space, and there is no correct way to carry "shifted 12
 * right" through a 90° rotation without deciding whether it means 12 right or
 * 12 down. Baking answers the question by making it moot.
 */
export function bakeOffsets(doc) {
  for (const layer of doc.layers) {
    const [x, y] = layer.offset;
    if (!x && !y) continue;
    layer.buffer = resizeCanvas(layer.buffer, doc.width, doc.height, x, y);
    layer.offset = [0, 0];
  }
  return doc;
}

export function flipDocument(doc, axis) {
  bakeOffsets(doc);
  for (const layer of doc.layers) layer.buffer = flipBuffer(layer.buffer, axis);
  return doc;
}

export function rotateDocument(doc, turns) {
  bakeOffsets(doc);
  for (const layer of doc.layers) layer.buffer = rotateBuffer(layer.buffer, turns);
  doc.width = doc.layers[0].buffer.width;
  doc.height = doc.layers[0].buffer.height;
  return doc;
}

/**
 * Crops away the fully transparent border.
 *
 * Measured against the FLATTENED document, not the active layer: trimming to
 * one layer's extent would silently cut off everything the layers below it
 * cover. Returns the rectangle that was kept, or null when there was nothing to
 * trim (or nothing opaque at all — trimming an empty document to a 1×1 is not
 * a useful interpretation of the request).
 */
export function trimDocument(doc, { threshold = 0 } = {}) {
  const bounds = opaqueBounds(compositeLayers(doc.layers, doc.width, doc.height), threshold);
  if (!bounds) return null;
  if (bounds.x === 0 && bounds.y === 0 && bounds.width === doc.width && bounds.height === doc.height) {
    return null;
  }
  cropDocument(doc, bounds.x, bounds.y, bounds.width, bounds.height);
  return bounds;
}

/** Masks are a single channel, so they get their own tiny resamplers rather
 *  than round-tripping through an RGBA buffer. */
function resizeMask(mask, oldW, oldH, newW, newH, offsetX, offsetY) {
  const out = new Uint8Array(newW * newH);
  for (let y = 0; y < newH; y++) {
    const sy = y - Math.round(offsetY);
    if (sy < 0 || sy >= oldH) continue;
    for (let x = 0; x < newW; x++) {
      const sx = x - Math.round(offsetX);
      if (sx < 0 || sx >= oldW) continue;
      out[y * newW + x] = mask[sy * oldW + sx];
    }
  }
  return out;
}

function resampleMask(mask, oldW, oldH, newW, newH) {
  const out = new Uint8Array(newW * newH);
  for (let y = 0; y < newH; y++) {
    const sy = Math.min(oldH - 1, Math.floor(((y + 0.5) * oldH) / newH));
    for (let x = 0; x < newW; x++) {
      const sx = Math.min(oldW - 1, Math.floor(((x + 0.5) * oldW) / newW));
      out[y * newW + x] = mask[sy * oldW + sx];
    }
  }
  return out;
}
