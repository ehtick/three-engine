/**
 * The `.tex` sidecar container — the layer stack that lives beside a texture.
 *
 *   "TEXDOC1" | u32 headerLength | header JSON | payload | payload | ...
 *
 * The header describes the document and gives each layer a byte range into the
 * payload region; every payload is an ordinary PNG. That shape was chosen over
 * "JSON with base64 images" for three reasons: base64 costs 33% on a file that
 * is already the largest thing in the project, a multi-megabyte JSON *string*
 * has to exist twice in memory to be parsed, and — the one that matters when
 * something goes wrong — the layers stay extractable with a few lines of
 * script even if this file is deleted.
 *
 * The PNG codec is injected rather than imported so the container logic stays
 * pure and can be exercised against a stub codec in tests. The editor passes
 * `src/editor/texture/png.js`; nothing else ever should, but the seam is the
 * cheap part.
 */

import { createLayer } from "./layers.js";

const MAGIC = "TEXDOC1";
const MAGIC_BYTES = new TextEncoder().encode(MAGIC);
export const TEX_EXTENSION = "tex";
export const TEXDOC_VERSION = 1;

/** A mask is one channel; it rides in a PNG's alpha so it shares the codec and
 *  compresses like the sparse thing it usually is. */
function maskToBuffer(mask, width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) data[i * 4 + 3] = mask[i];
  return { width, height, data };
}

function bufferToMask(buffer) {
  const mask = new Uint8Array(buffer.width * buffer.height);
  for (let i = 0; i < mask.length; i++) mask[i] = buffer.data[i * 4 + 3];
  return mask;
}

/**
 * @param {import("./layers.js").TextureDocument} doc
 * @param {{ encodePng: (buffer: any) => Promise<Uint8Array> }} codec
 * @returns {Promise<Uint8Array>}
 */
export async function encodeTexDoc(doc, { encodePng }) {
  const payloads = [];
  const layers = [];
  let offset = 0;

  for (const layer of doc.layers) {
    const png = await encodePng(layer.buffer);
    payloads.push(png);
    const entry = {
      id: layer.id,
      name: layer.name,
      visible: layer.visible !== false,
      opacity: layer.opacity ?? 1,
      blend: layer.blend ?? "normal",
      locked: layer.locked === true,
      offset: [layer.offset?.[0] ?? 0, layer.offset?.[1] ?? 0],
      at: offset,
      length: png.length,
    };
    if (layer.effects?.length) entry.effects = layer.effects.map((effect) => ({ ...effect }));
    offset += png.length;
    if (layer.mask) {
      const maskPng = await encodePng(maskToBuffer(layer.mask, layer.buffer.width, layer.buffer.height));
      payloads.push(maskPng);
      entry.maskAt = offset;
      entry.maskLength = maskPng.length;
      offset += maskPng.length;
    }
    layers.push(entry);
  }

  const header = new TextEncoder().encode(
    JSON.stringify({
      version: TEXDOC_VERSION,
      width: doc.width,
      height: doc.height,
      activeId: doc.activeId,
      layers,
    }),
  );

  const out = new Uint8Array(MAGIC_BYTES.length + 4 + header.length + offset);
  out.set(MAGIC_BYTES, 0);
  new DataView(out.buffer).setUint32(MAGIC_BYTES.length, header.length);
  out.set(header, MAGIC_BYTES.length + 4);
  let at = MAGIC_BYTES.length + 4 + header.length;
  for (const payload of payloads) {
    out.set(payload, at);
    at += payload.length;
  }
  return out;
}

export function isTexDoc(bytes) {
  if (!bytes || bytes.length < MAGIC_BYTES.length) return false;
  for (let i = 0; i < MAGIC_BYTES.length; i++) if (bytes[i] !== MAGIC_BYTES[i]) return false;
  return true;
}

/**
 * @param {Uint8Array} bytes
 * @param {{ decodePng: (bytes: Uint8Array) => Promise<any> }} codec
 * @returns {Promise<import("./layers.js").TextureDocument>}
 */
export async function decodeTexDoc(bytes, { decodePng }) {
  if (!isTexDoc(bytes)) throw new Error("Not a .tex document");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = view.getUint32(MAGIC_BYTES.length);
  const headerStart = MAGIC_BYTES.length + 4;
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(headerStart, headerStart + headerLength)));
  if (header.version > TEXDOC_VERSION) {
    throw new Error(`This .tex was written by a newer editor (version ${header.version})`);
  }
  const base = headerStart + headerLength;

  const layers = [];
  for (const entry of header.layers ?? []) {
    const buffer = await decodePng(bytes.subarray(base + entry.at, base + entry.at + entry.length));
    let mask = null;
    if (entry.maskLength) {
      mask = bufferToMask(
        await decodePng(bytes.subarray(base + entry.maskAt, base + entry.maskAt + entry.maskLength)),
      );
    }
    layers.push(
      createLayer({
        id: entry.id,
        name: entry.name,
        visible: entry.visible !== false,
        opacity: entry.opacity ?? 1,
        blend: entry.blend ?? "normal",
        locked: entry.locked === true,
        offset: entry.offset ?? [0, 0],
        buffer,
        mask,
        effects: Array.isArray(entry.effects) ? entry.effects : null,
      }),
    );
  }
  if (!layers.length) throw new Error(".tex document contains no layers");

  const activeId = layers.some((layer) => layer.id === header.activeId)
    ? header.activeId
    : layers[layers.length - 1].id;
  return {
    width: header.width ?? layers[0].buffer.width,
    height: header.height ?? layers[0].buffer.height,
    layers,
    activeId,
  };
}

/**
 * True when the sidecar still describes the image beside it.
 *
 * A `.tex` can go stale in a way nothing else in the project can: someone
 * overwrites the PNG from outside the editor (re-exports it from Blender,
 * copies a new version in, runs a batch script), and the layer stack now
 * describes an image that no longer exists. Opening it would silently discard
 * their new artwork the first time it was saved. Comparing dimensions catches
 * the common case cheaply; the editor asks what to do rather than guessing.
 */
export function texDocMatches(doc, imageWidth, imageHeight) {
  return doc.width === imageWidth && doc.height === imageHeight;
}
