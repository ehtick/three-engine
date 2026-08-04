/**
 * Texture editor core — headless.
 *
 * Everything in `src/editor/texture/` is deliberately DOM-free so this file can
 * exercise the parts that decide what the pixels become: compositing, the PNG
 * round trip, the `.tex` container, layer ops, selections, the rasterizers and
 * the undo stack. What is left for a live check is only the panel's wiring.
 */
import assert from "node:assert/strict";

import {
  createBuffer,
  cloneBuffer,
  cropBuffer,
  resizeBuffer,
  flipBuffer,
  rotateBuffer,
  resizeCanvas,
  opaqueBounds,
  parseColor,
  toHex,
  setPixel,
  getPixel,
} from "../src/editor/texture/pixels.js";
import { blendInto, compositeLayers, BLEND_MODES } from "../src/editor/texture/blend.js";
import { encodePng, decodePng, isDecodablePng } from "../src/editor/texture/png.js";
import { encodeTexDoc, decodeTexDoc, isTexDoc, texDocMatches } from "../src/editor/texture/texdoc.js";
import {
  createDocument,
  documentFromBuffer,
  cloneDocument,
  addLayer,
  removeLayer,
  duplicateLayer,
  reorderLayer,
  mergeDown,
  flattenDocument,
  resizeDocumentCanvas,
  resampleDocument,
  cropDocument,
  getLayer,
} from "../src/editor/texture/layers.js";
import {
  createSelection,
  combineSelection,
  invertSelection,
  rectSelection,
  ellipseSelection,
  polygonSelection,
  wandSelection,
  selectionFromAlpha,
  growSelection,
  featherSelection,
  selectionBounds,
  isSelectionEmpty,
} from "../src/editor/texture/selection.js";
import {
  createStroke,
  stampBrush,
  strokeSegment,
  strokeRect,
  strokeEllipse,
  applyStroke,
  floodFill,
  fillGradient,
  pickColor,
} from "../src/editor/texture/draw.js";
import {
  createHistory,
  regionEntry,
  captureRegion,
  restoreRegion,
} from "../src/editor/texture/history.js";
import {
  ADJUSTMENTS,
  adjustmentById,
  brightnessContrast,
  colorize,
  defaultParams,
  grayscale,
  hueSaturation,
  invert as invertColors,
  levels,
  luminance,
  posterize,
  threshold,
} from "../src/editor/texture/adjust.js";
import {
  FILTERS,
  gaussianBlur,
  median,
  noise,
  normalFromHeight,
  offset,
  sharpen,
} from "../src/editor/texture/filters.js";
import {
  alphaFromLuminance,
  bleedAlpha,
  fillChannel,
  packChannels,
  premultiply,
  splitChannels,
  swizzle,
  unpremultiply,
} from "../src/editor/texture/channels.js";
import { trimDocument } from "../src/editor/texture/layers.js";

let failures = 0;
let passes = 0;
const check = (name, fn) => {
  try {
    fn();
    passes++;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${error.message}`);
  }
};
const asyncCheck = async (name, fn) => {
  try {
    await fn();
    passes++;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${error.message}`);
  }
};

const px = (buffer, x, y) => Array.from(getPixel(buffer, x, y));

console.log("\npixels");

check("createBuffer starts fully transparent", () => {
  const b = createBuffer(4, 4);
  assert.deepEqual(px(b, 0, 0), [0, 0, 0, 0]);
  assert.equal(b.data.length, 4 * 4 * 4);
});

check("cropBuffer reads transparent outside the source, not a clamped edge", () => {
  const b = createBuffer(4, 4, [255, 0, 0, 255]);
  const out = cropBuffer(b, -2, -2, 4, 4);
  assert.deepEqual(px(out, 0, 0), [0, 0, 0, 0], "outside stays empty");
  assert.deepEqual(px(out, 3, 3), [255, 0, 0, 255], "overlap is copied");
});

check("nearest resize keeps exact colours (pixel art must not soften)", () => {
  const b = createBuffer(2, 2);
  setPixel(b, 0, 0, [255, 0, 0, 255]);
  setPixel(b, 1, 0, [0, 255, 0, 255]);
  setPixel(b, 0, 1, [0, 0, 255, 255]);
  setPixel(b, 1, 1, [255, 255, 0, 255]);
  const out = resizeBuffer(b, 4, 4, { filter: "nearest" });
  assert.deepEqual(px(out, 0, 0), [255, 0, 0, 255]);
  assert.deepEqual(px(out, 3, 3), [255, 255, 0, 255]);
});

check("bilinear downscale of a sprite on transparency produces no dark halo", () => {
  // The classic straight-alpha averaging bug: a red disc on transparent black
  // shrinks and its edge turns dark because RGB of transparent texels is
  // averaged in. Premultiplied filtering keeps the edge red.
  const b = createBuffer(32, 32);
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      if (Math.hypot(x - 15.5, y - 15.5) < 12) setPixel(b, x, y, [255, 0, 0, 255]);
    }
  }
  const out = resizeBuffer(b, 8, 8, { filter: "bilinear" });
  let worst = 255;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const p = px(out, x, y);
      if (p[3] > 8) worst = Math.min(worst, p[0]);
    }
  }
  assert.ok(worst > 200, `edge texels stayed red (darkest R was ${worst})`);
});

check("flip and rotate are exact inverses of themselves", () => {
  const b = createBuffer(3, 5);
  for (let i = 0; i < 15; i++) b.data[i * 4] = i * 7;
  assert.deepEqual(Array.from(flipBuffer(flipBuffer(b, "horizontal"), "horizontal").data), Array.from(b.data));
  assert.deepEqual(Array.from(rotateBuffer(rotateBuffer(b, 1), 3).data), Array.from(b.data));
});

check("rotate by one turn swaps dimensions and moves the corner clockwise", () => {
  const b = createBuffer(3, 5);
  setPixel(b, 0, 0, [1, 2, 3, 255]);
  const out = rotateBuffer(b, 1);
  assert.equal(out.width, 5);
  assert.equal(out.height, 3);
  assert.deepEqual(px(out, 4, 0), [1, 2, 3, 255]);
});

check("resizeCanvas keeps pixel scale and offsets content", () => {
  const b = createBuffer(2, 2, [9, 9, 9, 255]);
  const out = resizeCanvas(b, 4, 4, 1, 1);
  assert.deepEqual(px(out, 0, 0), [0, 0, 0, 0]);
  assert.deepEqual(px(out, 1, 1), [9, 9, 9, 255]);
});

check("opaqueBounds finds the tight box and reports null when empty", () => {
  const b = createBuffer(8, 8);
  setPixel(b, 2, 3, [255, 255, 255, 255]);
  setPixel(b, 5, 6, [255, 255, 255, 255]);
  assert.deepEqual(opaqueBounds(b), { x: 2, y: 3, width: 4, height: 4 });
  assert.equal(opaqueBounds(createBuffer(4, 4)), null);
});

check("parseColor handles #rgb, #rrggbb and #rrggbbaa", () => {
  assert.deepEqual(parseColor("#f00"), [255, 0, 0, 255]);
  assert.deepEqual(parseColor("#00ff00"), [0, 255, 0, 255]);
  assert.deepEqual(parseColor("#0000ff80"), [0, 0, 255, 128]);
  assert.equal(toHex([255, 128, 0]), "#ff8000");
});

console.log("\nblending");

check("normal blend over an empty backdrop returns the source unchanged", () => {
  const dst = createBuffer(1, 1);
  const src = createBuffer(1, 1, [200, 100, 50, 255]);
  blendInto(dst, src);
  assert.deepEqual(px(dst, 0, 0), [200, 100, 50, 255]);
});

check("multiply over an EMPTY backdrop does not blacken (the (1-ad) term)", () => {
  // Dropping the source-only term of the compositing formula makes a multiply
  // layer paint black wherever nothing is underneath — the single most common
  // way a hand-rolled blend implementation is wrong.
  const dst = createBuffer(1, 1);
  const src = createBuffer(1, 1, [200, 100, 50, 255]);
  blendInto(dst, src, { blend: "multiply" });
  assert.deepEqual(px(dst, 0, 0), [200, 100, 50, 255]);
});

check("multiply over an opaque backdrop multiplies", () => {
  const dst = createBuffer(1, 1, [255, 128, 0, 255]);
  const src = createBuffer(1, 1, [128, 255, 255, 255]);
  blendInto(dst, src, { blend: "multiply" });
  const p = px(dst, 0, 0);
  assert.ok(Math.abs(p[0] - 128) <= 1 && Math.abs(p[1] - 128) <= 1 && p[2] === 0);
});

check("half-opacity source over opaque backdrop lands halfway", () => {
  const dst = createBuffer(1, 1, [0, 0, 0, 255]);
  const src = createBuffer(1, 1, [255, 255, 255, 255]);
  blendInto(dst, src, { opacity: 0.5 });
  const p = px(dst, 0, 0);
  assert.ok(Math.abs(p[0] - 128) <= 1, `got ${p[0]}`);
  assert.equal(p[3], 255);
});

check("every declared blend mode composites without producing NaN", () => {
  for (const mode of BLEND_MODES) {
    const dst = createBuffer(2, 2, [40, 130, 220, 200]);
    blendInto(dst, createBuffer(2, 2, [200, 30, 90, 180]), { blend: mode });
    for (let i = 0; i < dst.data.length; i++) {
      assert.ok(Number.isFinite(dst.data[i]), `${mode} produced ${dst.data[i]}`);
    }
  }
});

check("compositeLayers respects order, visibility and per-layer offset", () => {
  const bottom = createBuffer(4, 1, [255, 0, 0, 255]);
  const middle = createBuffer(4, 1, [0, 255, 0, 255]);
  const top = createBuffer(1, 1, [0, 0, 255, 255]);
  const out = compositeLayers(
    [
      { buffer: bottom },
      { buffer: middle, visible: false },
      { buffer: top, offset: [2, 0] },
    ],
    4,
    1,
  );
  assert.deepEqual(px(out, 0, 0), [255, 0, 0, 255], "hidden layer contributes nothing");
  assert.deepEqual(px(out, 2, 0), [0, 0, 255, 255], "offset places the top layer");
});

console.log("\npng codec");

await asyncCheck("PNG round trip is bit-exact, including partial alpha", async () => {
  const b = createBuffer(37, 11);
  for (let i = 0; i < 37 * 11; i++) {
    b.data[i * 4] = (i * 7) % 256;
    b.data[i * 4 + 1] = (i * 31) % 256;
    b.data[i * 4 + 2] = 255 - (i % 256);
    b.data[i * 4 + 3] = (i * 13) % 256; // includes alpha 1..3, where canvas loses data
  }
  const bytes = await encodePng(b);
  assert.ok(isDecodablePng(bytes));
  const back = await decodePng(bytes);
  assert.equal(back.width, 37);
  assert.equal(back.height, 11);
  assert.deepEqual(Array.from(back.data), Array.from(b.data));
});

await asyncCheck("PNG filtering actually compresses (a flat image is tiny)", async () => {
  const flat = createBuffer(256, 256, [12, 34, 56, 255]);
  const bytes = await encodePng(flat);
  assert.ok(bytes.length < 5000, `flat 256² PNG was ${bytes.length} bytes`);
});

check("isDecodablePng rejects non-PNG and unsupported variants", () => {
  assert.equal(isDecodablePng(new Uint8Array(4)), false);
  const paletted = new Uint8Array(30);
  paletted.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  paletted[24] = 8;
  paletted[25] = 3; // palette
  assert.equal(isDecodablePng(paletted), false);
});

console.log("\n.tex container");

const codec = { encodePng, decodePng };

await asyncCheck(".tex round trip preserves pixels and every layer property", async () => {
  const doc = createDocument({ width: 8, height: 6, background: [10, 20, 30, 255] });
  const second = addLayer(doc, { name: "Detail", blend: "multiply", opacity: 0.4, offset: [2, -1], locked: true });
  setPixel(second.buffer, 3, 3, [7, 8, 9, 200]);
  second.mask = new Uint8Array(8 * 6).fill(128);

  const bytes = await encodeTexDoc(doc, codec);
  assert.ok(isTexDoc(bytes));
  const back = await decodeTexDoc(bytes, codec);

  assert.equal(back.width, 8);
  assert.equal(back.height, 6);
  assert.equal(back.layers.length, 2);
  assert.equal(back.activeId, doc.activeId);
  const restored = back.layers[1];
  assert.equal(restored.name, "Detail");
  assert.equal(restored.blend, "multiply");
  assert.equal(restored.opacity, 0.4);
  assert.equal(restored.locked, true);
  assert.deepEqual(restored.offset, [2, -1]);
  assert.deepEqual(px(restored.buffer, 3, 3), [7, 8, 9, 200]);
  assert.equal(restored.mask[0], 128);
  assert.deepEqual(Array.from(back.layers[0].buffer.data), Array.from(doc.layers[0].buffer.data));
});

await asyncCheck(".tex written by a newer editor is refused, not misread", async () => {
  const doc = createDocument({ width: 2, height: 2 });
  const bytes = await encodeTexDoc(doc, codec);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(11, 11 + new DataView(bytes.buffer).getUint32(7))));
  header.version = 99;
  const json = new TextEncoder().encode(JSON.stringify(header));
  const forged = new Uint8Array(7 + 4 + json.length + (bytes.length - 11 - new DataView(bytes.buffer).getUint32(7)));
  forged.set(bytes.subarray(0, 7));
  new DataView(forged.buffer).setUint32(7, json.length);
  forged.set(json, 11);
  forged.set(bytes.subarray(11 + new DataView(bytes.buffer).getUint32(7)), 11 + json.length);
  await assert.rejects(() => decodeTexDoc(forged, codec), /newer editor/);
});

check("texDocMatches catches a sidecar left behind by an externally replaced image", () => {
  const doc = createDocument({ width: 64, height: 64 });
  assert.equal(texDocMatches(doc, 64, 64), true);
  assert.equal(texDocMatches(doc, 128, 128), false);
});

console.log("\nlayers");

check("documentFromBuffer makes any plain texture editable as one layer", () => {
  const doc = documentFromBuffer(createBuffer(16, 8, [1, 2, 3, 255]));
  assert.equal(doc.layers.length, 1);
  assert.equal(doc.width, 16);
  assert.equal(doc.activeId, doc.layers[0].id);
});

check("the last layer cannot be removed", () => {
  const doc = createDocument({ width: 4, height: 4 });
  assert.equal(removeLayer(doc, doc.activeId), false);
  assert.equal(doc.layers.length, 1);
});

check("add / duplicate / reorder keep the active layer sane", () => {
  const doc = createDocument({ width: 4, height: 4 });
  const a = addLayer(doc, { name: "A" });
  assert.equal(doc.activeId, a.id);
  const copy = duplicateLayer(doc, a.id);
  assert.equal(doc.layers.length, 3);
  assert.equal(copy.name, "A copy");
  assert.equal(reorderLayer(doc, copy.id, +5), false, "already at the top");
  assert.equal(reorderLayer(doc, copy.id, -1), true);
  assert.equal(doc.layers[1].id, copy.id);
  assert.equal(reorderLayer(doc, copy.id, +5), true, "clamps to the top of the stack");
  assert.equal(doc.layers[doc.layers.length - 1].id, copy.id);
  assert.equal(reorderLayer(doc, doc.layers[0].id, -1), false, "already at the bottom");
  removeLayer(doc, doc.activeId);
  assert.ok(getLayer(doc, doc.activeId), "active id still names a real layer");
});

check("mergeDown bakes opacity and blend, and resets them on the result", () => {
  const doc = createDocument({ width: 1, height: 1, background: [0, 0, 0, 255] });
  const top = addLayer(doc, { name: "Top", opacity: 0.5 });
  top.buffer.data.set([255, 255, 255, 255]);
  assert.equal(mergeDown(doc, top.id), true);
  assert.equal(doc.layers.length, 1);
  const merged = doc.layers[0];
  assert.equal(merged.opacity, 1);
  assert.equal(merged.blend, "normal");
  const p = px(merged.buffer, 0, 0);
  assert.ok(Math.abs(p[0] - 128) <= 1, `expected the 50% blend to be baked, got ${p[0]}`);
});

check("mergeDown on the bottom layer is refused", () => {
  const doc = createDocument({ width: 2, height: 2 });
  assert.equal(mergeDown(doc, doc.layers[0].id), false);
});

check("cloneDocument deep-copies pixels (an undo snapshot must not alias)", () => {
  const doc = createDocument({ width: 2, height: 2, background: [1, 1, 1, 255] });
  const copy = cloneDocument(doc);
  doc.layers[0].buffer.data[0] = 200;
  assert.equal(copy.layers[0].buffer.data[0], 1);
});

check("canvas resize, resample and crop move every layer together", () => {
  const doc = createDocument({ width: 4, height: 4, background: [5, 5, 5, 255] });
  addLayer(doc, { name: "B", fill: [9, 9, 9, 255] });
  resizeDocumentCanvas(doc, 8, 8, 2, 2);
  assert.equal(doc.width, 8);
  assert.ok(doc.layers.every((l) => l.buffer.width === 8 && l.buffer.height === 8));
  assert.deepEqual(px(doc.layers[0].buffer, 0, 0), [0, 0, 0, 0]);
  assert.deepEqual(px(doc.layers[0].buffer, 2, 2), [5, 5, 5, 255]);
  resampleDocument(doc, 4, 4);
  assert.equal(doc.width, 4);
  cropDocument(doc, 1, 1, 2, 2);
  assert.equal(doc.width, 2);
  assert.ok(doc.layers.every((l) => l.buffer.width === 2));
});

check("flattenDocument matches what compositing the stack produces", () => {
  const doc = createDocument({ width: 2, height: 2, background: [255, 0, 0, 255] });
  const top = addLayer(doc, { name: "T", opacity: 0.25, fill: [0, 0, 255, 255] });
  void top;
  const flat = flattenDocument(doc);
  const p = px(flat, 0, 0);
  assert.ok(Math.abs(p[0] - 191) <= 2 && Math.abs(p[2] - 64) <= 2, `got ${p}`);
});

console.log("\nselections");

check("rect selection covers exactly the rectangle", () => {
  const mask = rectSelection(8, 8, { x: 2, y: 3, width: 3, height: 2 });
  assert.equal(mask[3 * 8 + 2], 255);
  assert.equal(mask[3 * 8 + 5], 0);
  assert.deepEqual(selectionBounds(mask, 8, 8), { x: 2, y: 3, width: 3, height: 2 });
});

check("ellipse selection is antialiased at the rim and solid at the centre", () => {
  const mask = ellipseSelection(32, 32, { x: 0, y: 0, width: 32, height: 32 });
  assert.equal(mask[16 * 32 + 16], 255);
  assert.equal(mask[0], 0);
  let partial = 0;
  for (const v of mask) if (v > 0 && v < 255) partial++;
  assert.ok(partial > 8, `expected a soft rim, found ${partial} partial texels`);
});

check("polygon selection fills a triangle by even-odd rule", () => {
  const mask = polygonSelection(16, 16, [[1, 1], [14, 1], [1, 14]]);
  assert.equal(mask[2 * 16 + 2], 255);
  assert.equal(mask[12 * 16 + 12], 0);
});

check("wand: contiguous stops at a barrier, global does not", () => {
  const b = createBuffer(9, 1, [255, 255, 255, 255]);
  setPixel(b, 4, 0, [0, 0, 0, 255]);
  const contiguous = wandSelection(b, 0, 0, { tolerance: 0.01, contiguous: true });
  assert.equal(contiguous[3], 255);
  assert.equal(contiguous[8], 0, "the black pixel blocks the flood");
  const global = wandSelection(b, 0, 0, { tolerance: 0.01, contiguous: false });
  assert.equal(global[8], 255);
});

check("wand treats transparency as far from the same RGB (no bleeding off a sprite)", () => {
  const b = createBuffer(4, 1);
  setPixel(b, 0, 0, [255, 0, 0, 255]);
  setPixel(b, 1, 0, [255, 0, 0, 0]); // same RGB, transparent
  const mask = wandSelection(b, 0, 0, { tolerance: 0.2 });
  assert.equal(mask[1], 0);
});

check("selection combine modes: add / subtract / intersect, and null-base semantics", () => {
  const a = rectSelection(8, 1, { x: 0, y: 0, width: 4, height: 1 });
  const b = rectSelection(8, 1, { x: 2, y: 0, width: 4, height: 1 });
  assert.equal(combineSelection(a, b, "add", 8, 1)[5], 255);
  assert.equal(combineSelection(a, b, "subtract", 8, 1)[2], 0);
  assert.equal(combineSelection(a, b, "subtract", 8, 1)[1], 255);
  assert.equal(combineSelection(a, b, "intersect", 8, 1)[3], 255);
  assert.equal(combineSelection(a, b, "intersect", 8, 1)[0], 0);
  // Subtracting from "no selection" must mean "everything except this".
  assert.equal(combineSelection(null, b, "subtract", 8, 1)[0], 255);
  assert.equal(combineSelection(null, b, "subtract", 8, 1)[3], 0);
});

check("invert, grow, shrink and feather behave", () => {
  const mask = rectSelection(16, 16, { x: 6, y: 6, width: 4, height: 4 });
  assert.equal(invertSelection(mask, 16, 16)[0], 255);
  assert.equal(growSelection(mask, 16, 16, 2)[5 * 16 + 5], 255);
  assert.equal(growSelection(mask, 16, 16, -1)[6 * 16 + 6], 0, "shrink pulls the border in");
  const soft = featherSelection(mask, 16, 16, 2);
  assert.ok(soft[6 * 16 + 6] > 0 && soft[6 * 16 + 6] < 255, "the edge became partial");
});

check("selectionFromAlpha selects the artwork and isSelectionEmpty reports honestly", () => {
  const b = createBuffer(4, 4);
  setPixel(b, 1, 1, [255, 255, 255, 255]);
  const mask = selectionFromAlpha(b);
  assert.equal(mask[1 * 4 + 1], 255);
  assert.equal(isSelectionEmpty(mask), false);
  assert.equal(isSelectionEmpty(createSelection(4, 4)), true);
});

console.log("\ndrawing");

check("a stroke reaches exactly its opacity however many times it is stamped", () => {
  // The reason coverage accumulates with max() and is composited once: fifty
  // overlapping 40%-opacity dabs must still read 40%, not 100%.
  const target = createBuffer(8, 8, [0, 0, 0, 255]);
  const stroke = createStroke(8, 8);
  for (let i = 0; i < 50; i++) stampBrush(stroke, 4, 4, 3, 1);
  applyStroke(target, stroke, { color: [255, 255, 255, 255], opacity: 0.4 });
  const p = px(target, 4, 4);
  assert.ok(Math.abs(p[0] - 102) <= 3, `expected ~40% grey, got ${p[0]}`);
});

check("strokeSegment interpolates between far-apart pointer events", () => {
  const stroke = createStroke(64, 8);
  strokeSegment(stroke, 2, 4, 60, 4, { radius: 2, spacing: 0.25 });
  let covered = 0;
  for (let x = 2; x < 60; x++) if (stroke.coverage[4 * 64 + x] > 0) covered++;
  assert.ok(covered > 55, `expected a continuous line, only ${covered}/58 columns covered`);
});

check("strokeSegment carries leftover distance so spacing does not restart per event", () => {
  const stroke = createStroke(64, 8);
  let carry = 0;
  for (let x = 0; x < 60; x += 3) carry = strokeSegment(stroke, x, 4, x + 3, 4, { radius: 4, spacing: 1, carry });
  assert.ok(carry >= 0 && carry < 8, `carry stayed within one step (${carry})`);
});

check("the eraser removes alpha without pulling colour toward black", () => {
  const target = createBuffer(4, 4, [200, 50, 25, 255]);
  const stroke = createStroke(4, 4);
  strokeRect(stroke, { x: 0, y: 0, width: 4, height: 4 });
  applyStroke(target, stroke, { erase: true, opacity: 0.5 });
  const p = px(target, 1, 1);
  assert.deepEqual(p.slice(0, 3), [200, 50, 25], "RGB survives erasing");
  assert.ok(Math.abs(p[3] - 128) <= 1, `alpha halved, got ${p[3]}`);
});

check("a selection clips painting", () => {
  const target = createBuffer(8, 1);
  const stroke = createStroke(8, 1);
  strokeRect(stroke, { x: 0, y: 0, width: 8, height: 1 });
  applyStroke(target, stroke, {
    color: [255, 255, 255, 255],
    selection: rectSelection(8, 1, { x: 2, y: 0, width: 3, height: 1 }),
  });
  assert.equal(px(target, 1, 0)[3], 0);
  assert.equal(px(target, 3, 0)[3], 255);
});

check("strokeEllipse outlines without filling when asked", () => {
  const stroke = createStroke(32, 32);
  strokeEllipse(stroke, { x: 0, y: 0, width: 32, height: 32 }, { fill: false, lineWidth: 1 });
  assert.equal(stroke.coverage[16 * 32 + 16], 0, "centre is untouched");
  assert.ok(stroke.coverage[16 * 32 + 31] > 0 || stroke.coverage[16 * 32 + 30] > 0, "rim is drawn");
});

check("flood fill stops at a colour boundary and respects a selection", () => {
  const target = createBuffer(9, 1, [255, 255, 255, 255]);
  setPixel(target, 4, 0, [0, 0, 0, 255]);
  const open = floodFill(target, 0, 0, { tolerance: 0.01 });
  assert.ok(open.coverage[3] > 0);
  assert.equal(open.coverage[5], 0);
  const clipped = floodFill(target, 0, 0, {
    tolerance: 0.01,
    selection: rectSelection(9, 1, { x: 0, y: 0, width: 2, height: 1 }),
  });
  assert.equal(clipped.coverage[2], 0, "the flood is bounded by the selection");
});

check("flood fill in global mode recolours every matching pixel", () => {
  const target = createBuffer(9, 1, [255, 255, 255, 255]);
  setPixel(target, 4, 0, [0, 0, 0, 255]);
  const stroke = floodFill(target, 0, 0, { tolerance: 0.01, contiguous: false });
  assert.ok(stroke.coverage[8] > 0);
  assert.equal(stroke.coverage[4], 0);
});

check("linear gradient hits both endpoint colours", () => {
  const target = createBuffer(16, 1);
  fillGradient(target, { x0: 0, y0: 0, x1: 16, y1: 0, from: [0, 0, 0, 255], to: [255, 255, 255, 255], dither: false });
  assert.ok(px(target, 0, 0)[0] < 12);
  assert.ok(px(target, 15, 0)[0] > 243);
});

check("radial gradient is centred on its origin", () => {
  const target = createBuffer(16, 16);
  fillGradient(target, {
    type: "radial", x0: 8, y0: 8, x1: 16, y1: 8,
    from: [255, 255, 255, 255], to: [0, 0, 0, 255], dither: false,
  });
  // Sampled at texel centres, so the origin texel sits half a texel out along
  // both axes rather than exactly at t=0.
  assert.ok(px(target, 8, 8)[0] > 225, `centre was ${px(target, 8, 8)[0]}`);
  assert.ok(px(target, 0, 8)[0] < 40, `rim was ${px(target, 0, 8)[0]}`);
});

check("pickColor reads the pixel and refuses out-of-bounds", () => {
  const b = createBuffer(2, 2, [11, 22, 33, 255]);
  assert.deepEqual(pickColor(b, 1, 1), [11, 22, 33, 255]);
  assert.equal(pickColor(b, 5, 0), null);
});

console.log("\nhistory");

check("undo and redo walk the stack and report their labels", () => {
  const history = createHistory();
  let value = 0;
  history.push({ label: "one", undo: () => (value = 0), redo: () => (value = 1), bytes: 4 });
  value = 1;
  history.push({ label: "two", undo: () => (value = 1), redo: () => (value = 2), bytes: 4 });
  value = 2;
  assert.equal(history.undoLabel(), "two");
  history.undo();
  assert.equal(value, 1);
  history.undo();
  assert.equal(value, 0);
  assert.equal(history.canUndo(), false);
  history.redo();
  assert.equal(value, 1);
  assert.equal(history.redoLabel(), "two");
});

check("a new edit discards the redo branch and reclaims its bytes", () => {
  const history = createHistory();
  history.push({ label: "a", undo() {}, redo() {}, bytes: 100 });
  history.push({ label: "b", undo() {}, redo() {}, bytes: 100 });
  history.undo();
  history.push({ label: "c", undo() {}, redo() {}, bytes: 50 });
  assert.equal(history.canRedo(), false);
  assert.equal(history.bytes, 150);
});

check("coalescing keeps the FIRST undo and the LAST redo", () => {
  const history = createHistory();
  let value = 0;
  history.push({ label: "opacity", undo: () => (value = 0), redo: () => (value = 1), coalesceKey: "op", now: 1000 });
  history.push({ label: "opacity", undo: () => (value = 1), redo: () => (value = 2), coalesceKey: "op", now: 1100 });
  history.push({ label: "opacity", undo: () => (value = 2), redo: () => (value = 3), coalesceKey: "op", now: 1200 });
  assert.equal(history.length, 1);
  value = 3;
  history.undo();
  assert.equal(value, 0, "one Ctrl+Z rewinds the whole gesture");
  history.redo();
  assert.equal(value, 3);
});

check("coalescing stops once the window has passed", () => {
  const history = createHistory();
  history.push({ label: "x", undo() {}, redo() {}, coalesceKey: "k", now: 0 });
  history.push({ label: "x", undo() {}, redo() {}, coalesceKey: "k", now: 5000 });
  assert.equal(history.length, 2);
});

check("the stack trims by depth and by total bytes, oldest first", () => {
  const byDepth = createHistory({ limit: 3 });
  for (let i = 0; i < 10; i++) byDepth.push({ label: `${i}`, undo() {}, redo() {}, bytes: 1 });
  assert.equal(byDepth.length, 3);

  const byBytes = createHistory({ limit: 100, byteLimit: 1000 });
  for (let i = 0; i < 10; i++) byBytes.push({ label: `${i}`, undo() {}, redo() {}, bytes: 400 });
  assert.ok(byBytes.bytes <= 1000, `bytes stayed under the cap (${byBytes.bytes})`);
});

check("a region entry restores only the rectangle it captured", () => {
  const buffer = createBuffer(8, 8, [10, 10, 10, 255]);
  const rect = { x0: 2, y0: 2, x1: 5, y1: 5 };
  const before = captureRegion(buffer, rect);
  for (let y = 2; y < 5; y++) for (let x = 2; x < 5; x++) setPixel(buffer, x, y, [200, 0, 0, 255]);
  setPixel(buffer, 7, 7, [1, 2, 3, 255]);
  const entry = regionEntry(buffer, rect, before, "Brush");
  entry.undo();
  assert.deepEqual(px(buffer, 3, 3), [10, 10, 10, 255], "the region came back");
  assert.deepEqual(px(buffer, 7, 7), [1, 2, 3, 255], "everything else was left alone");
  entry.redo();
  assert.deepEqual(px(buffer, 3, 3), [200, 0, 0, 255]);
});

check("region capture/restore survives a full-canvas rectangle", () => {
  const buffer = createBuffer(5, 5, [1, 2, 3, 255]);
  const rect = { x0: 0, y0: 0, x1: 5, y1: 5 };
  const snap = captureRegion(buffer, rect);
  buffer.data.fill(0);
  restoreRegion(buffer, rect, snap);
  assert.deepEqual(px(buffer, 4, 4), [1, 2, 3, 255]);
});

check("a brush dab's undo cost is proportional to the dab, not the canvas", () => {
  const buffer = createBuffer(1024, 1024);
  const rect = { x0: 500, y0: 500, x1: 520, y1: 520 };
  const before = captureRegion(buffer, rect);
  const entry = regionEntry(buffer, rect, before, "Brush");
  assert.ok(entry.bytes < 4000, `a 20² dab cost ${entry.bytes} bytes on a 1024² document`);
});

console.log("\nadjustments");

check("every registered adjustment runs from its own defaults", () => {
  for (const spec of ADJUSTMENTS) {
    const b = createBuffer(4, 4, [90, 140, 200, 180]);
    spec.apply(b, defaultParams(spec));
    for (let i = 0; i < b.data.length; i++) assert.ok(Number.isFinite(b.data[i]), `${spec.id} produced NaN`);
  }
  assert.equal(adjustmentById("levels")?.label, "Levels");
});

check("adjustments never touch alpha (brightening must not thicken an edge)", () => {
  const b = createBuffer(2, 2, [100, 100, 100, 77]);
  brightnessContrast(b, { brightness: 0.5 });
  hueSaturation(b, { saturation: 1 });
  levels(b, { black: 20, white: 200, gamma: 0.6 });
  assert.equal(px(b, 0, 0)[3], 77);
});

check("brightness raises, contrast pivots on mid-grey", () => {
  const up = createBuffer(1, 1, [100, 100, 100, 255]);
  brightnessContrast(up, { brightness: 0.2 });
  assert.ok(px(up, 0, 0)[0] > 140, String(px(up, 0, 0)[0]));

  const dark = createBuffer(1, 1, [64, 64, 64, 255]);
  const light = createBuffer(1, 1, [192, 192, 192, 255]);
  brightnessContrast(dark, { contrast: 0.5 });
  brightnessContrast(light, { contrast: 0.5 });
  assert.ok(px(dark, 0, 0)[0] < 64, "darks got darker");
  assert.ok(px(light, 0, 0)[0] > 192, "lights got lighter");

  const mid = createBuffer(1, 1, [128, 128, 128, 255]);
  brightnessContrast(mid, { contrast: 0.8 });
  assert.ok(Math.abs(px(mid, 0, 0)[0] - 128) <= 1, "mid-grey is the pivot");
});

check("levels remaps the input window onto the output window", () => {
  const b = createBuffer(3, 1);
  setPixel(b, 0, 0, [50, 50, 50, 255]);
  setPixel(b, 1, 0, [150, 150, 150, 255]);
  setPixel(b, 2, 0, [250, 250, 250, 255]);
  levels(b, { black: 50, white: 250, gamma: 1 });
  assert.ok(px(b, 0, 0)[0] <= 1, `black point mapped to 0 (${px(b, 0, 0)[0]})`);
  assert.ok(px(b, 2, 0)[0] >= 254, `white point mapped to 255 (${px(b, 2, 0)[0]})`);
  assert.ok(Math.abs(px(b, 1, 0)[0] - 128) <= 3, `midpoint stretched (${px(b, 1, 0)[0]})`);
});

check("levels gamma brightens without moving the endpoints", () => {
  const b = createBuffer(3, 1);
  setPixel(b, 0, 0, [0, 0, 0, 255]);
  setPixel(b, 1, 0, [128, 128, 128, 255]);
  setPixel(b, 2, 0, [255, 255, 255, 255]);
  levels(b, { gamma: 2 });
  assert.equal(px(b, 0, 0)[0], 0);
  assert.equal(px(b, 2, 0)[0], 255);
  assert.ok(px(b, 1, 0)[0] > 150, String(px(b, 1, 0)[0]));
});

check("hue rotation moves red toward green and keeps it saturated", () => {
  const b = createBuffer(1, 1, [255, 0, 0, 255]);
  hueSaturation(b, { hue: 120 });
  const p = px(b, 0, 0);
  assert.ok(p[1] > 240 && p[0] < 15 && p[2] < 15, p.join());
});

check("desaturating uses luma, not a channel average", () => {
  // Pure green is far brighter than pure blue; an average would call them equal.
  const green = createBuffer(1, 1, [0, 255, 0, 255]);
  const blue = createBuffer(1, 1, [0, 0, 255, 255]);
  grayscale(green, {});
  grayscale(blue, {});
  assert.ok(px(green, 0, 0)[0] > px(blue, 0, 0)[0] + 100, `${px(green, 0, 0)[0]} vs ${px(blue, 0, 0)[0]}`);
  assert.ok(Math.abs(px(green, 0, 0)[0] - luminance(0, 255, 0)) <= 1);
});

check("colorize keeps the source's luminance structure", () => {
  const b = createBuffer(2, 1);
  setPixel(b, 0, 0, [40, 40, 40, 255]);
  setPixel(b, 1, 0, [200, 200, 200, 255]);
  colorize(b, { color: [255, 0, 0, 255], strength: 1 });
  assert.ok(px(b, 1, 0)[0] > px(b, 0, 0)[0] + 100, "the bright texel stayed brighter");
  assert.ok(px(b, 1, 0)[1] < 20 && px(b, 1, 0)[2] < 20, "and took the tint's hue");
});

check("threshold and posterize quantise as advertised", () => {
  const b = createBuffer(2, 1);
  setPixel(b, 0, 0, [10, 10, 10, 255]);
  setPixel(b, 1, 0, [240, 240, 240, 255]);
  threshold(b, { level: 128 });
  assert.deepEqual(px(b, 0, 0).slice(0, 3), [0, 0, 0]);
  assert.deepEqual(px(b, 1, 0).slice(0, 3), [255, 255, 255]);

  const ramp = createBuffer(256, 1);
  for (let x = 0; x < 256; x++) setPixel(ramp, x, 0, [x, x, x, 255]);
  posterize(ramp, { steps: 4 });
  const distinct = new Set();
  for (let x = 0; x < 256; x++) distinct.add(px(ramp, x, 0)[0]);
  assert.equal(distinct.size, 4, [...distinct].join());
});

check("invert is its own inverse", () => {
  const b = createBuffer(4, 4, [12, 200, 77, 255]);
  const before = Array.from(b.data);
  invertColors(b);
  invertColors(b);
  assert.deepEqual(Array.from(b.data), before);
});

check("a selection blends an adjustment rather than clipping it", () => {
  const b = createBuffer(3, 1, [100, 100, 100, 255]);
  const mask = createSelection(3, 1);
  mask[0] = 255;
  mask[1] = 128;
  mask[2] = 0;
  brightnessContrast(b, { brightness: 0.5 }, mask);
  const full = px(b, 0, 0)[0];
  const half = px(b, 1, 0)[0];
  const none = px(b, 2, 0)[0];
  assert.equal(none, 100, "unselected is untouched");
  assert.ok(full > half && half > none, `${full} > ${half} > ${none}`);
});

console.log("\nfilters");

check("every registered filter runs from its own defaults", () => {
  for (const spec of FILTERS) {
    const b = createBuffer(8, 8, [90, 140, 200, 255]);
    spec.apply(b, defaultParams(spec));
    for (let i = 0; i < b.data.length; i++) assert.ok(Number.isFinite(b.data[i]), `${spec.id} produced NaN`);
  }
});

check("blur spreads a dot and conserves roughly its energy", () => {
  const b = createBuffer(17, 17);
  setPixel(b, 8, 8, [255, 255, 255, 255]);
  gaussianBlur(b, { radius: 3 });
  assert.ok(px(b, 8, 8)[3] < 255, "the centre softened");
  assert.ok(px(b, 8, 10)[3] > 0, "it reached its neighbours");
  let sum = 0;
  for (let i = 3; i < b.data.length; i += 4) sum += b.data[i];
  assert.ok(sum > 200 && sum < 400, `alpha roughly conserved (${sum} vs 255)`);
});

check("blurring a sprite on transparency does NOT darken its edge", () => {
  // The straight-alpha averaging bug again, in its other common disguise.
  const b = createBuffer(16, 16);
  for (let y = 4; y < 12; y++) for (let x = 4; x < 12; x++) setPixel(b, x, y, [255, 40, 40, 255]);
  gaussianBlur(b, { radius: 3 });
  let worstRed = 255;
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const p = px(b, x, y);
      if (p[3] > 30) worstRed = Math.min(worstRed, p[0]);
    }
  }
  assert.ok(worstRed > 200, `the softened edge stayed red (darkest R ${worstRed})`);
});

check("sharpen raises local contrast at an edge", () => {
  const b = createBuffer(16, 1);
  for (let x = 0; x < 16; x++) setPixel(b, x, 0, x < 8 ? [90, 90, 90, 255] : [160, 160, 160, 255]);
  const before = px(b, 8, 0)[0] - px(b, 7, 0)[0];
  sharpen(b, { amount: 1.5, radius: 2 });
  assert.ok(px(b, 8, 0)[0] - px(b, 7, 0)[0] > before, "the step got steeper");
});

check("offset wraps, and offsetting all the way round is a no-op", () => {
  const b = createBuffer(8, 4);
  setPixel(b, 0, 0, [1, 2, 3, 255]);
  offset(b, { dx: 3, dy: 1 });
  assert.deepEqual(px(b, 3, 1), [1, 2, 3, 255]);
  offset(b, { dx: 5, dy: 3 });
  assert.deepEqual(px(b, 0, 0), [1, 2, 3, 255], "back where it started");
});

check("offset by half the size puts the tiling seam in the middle", () => {
  const b = createBuffer(8, 8, [10, 10, 10, 255]);
  for (let y = 0; y < 8; y++) setPixel(b, 0, y, [250, 250, 250, 255]); // the seam column
  offset(b, { dx: 4, dy: 0 });
  assert.equal(px(b, 4, 3)[0], 250, "the edge column is now central and paintable");
  assert.equal(px(b, 0, 3)[0], 10);
});

check("normal from height produces a unit-ish normal, flat where the height is flat", () => {
  const flat = createBuffer(8, 8, [128, 128, 128, 255]);
  normalFromHeight(flat, { strength: 2 });
  const p = px(flat, 4, 4);
  assert.ok(Math.abs(p[0] - 128) <= 2 && Math.abs(p[1] - 128) <= 2, `flat normal points up (${p.join()})`);
  assert.ok(p[2] > 240, `and its Z is near +1 (${p[2]})`);
  assert.equal(p[3], 255);

  const ramp = createBuffer(16, 16);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) setPixel(ramp, x, y, [x * 16, x * 16, x * 16, 255]);
  normalFromHeight(ramp, { strength: 4, wrap: false });
  assert.ok(px(ramp, 8, 8)[0] < 120, "a slope along X tilts the normal in X");
});

check("normal from height flips green for the DirectX convention", () => {
  const make = () => {
    const b = createBuffer(16, 16);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) setPixel(b, x, y, [y * 16, y * 16, y * 16, 255]);
    return b;
  };
  const gl = make();
  const dx = make();
  normalFromHeight(gl, { strength: 4, wrap: false, invertY: false });
  normalFromHeight(dx, { strength: 4, wrap: false, invertY: true });
  assert.ok(Math.abs(px(gl, 8, 8)[1] - 128) > 5, "the ramp really does tilt Y");
  assert.ok((px(gl, 8, 8)[1] - 128) * (px(dx, 8, 8)[1] - 128) < 0, "and the two conventions disagree in sign");
});

check("noise is deterministic for a seed and different across seeds", () => {
  const a = createBuffer(8, 8, [128, 128, 128, 255]);
  const b = createBuffer(8, 8, [128, 128, 128, 255]);
  const c = createBuffer(8, 8, [128, 128, 128, 255]);
  noise(a, { amount: 0.5, seed: 7 });
  noise(b, { amount: 0.5, seed: 7 });
  noise(c, { amount: 0.5, seed: 8 });
  assert.deepEqual(Array.from(a.data), Array.from(b.data), "same seed, same grain");
  assert.notDeepEqual(Array.from(a.data), Array.from(c.data));
});

check("median removes a lone speckle but keeps a solid edge", () => {
  const b = createBuffer(8, 8, [100, 100, 100, 255]);
  setPixel(b, 4, 4, [255, 255, 255, 255]);
  median(b, {});
  assert.equal(px(b, 4, 4)[0], 100, "the speckle is gone");

  const edge = createBuffer(8, 8, [0, 0, 0, 255]);
  for (let y = 0; y < 8; y++) for (let x = 4; x < 8; x++) setPixel(edge, x, y, [255, 255, 255, 255]);
  median(edge, {});
  assert.equal(px(edge, 5, 4)[0], 255, "the edge survived");
  assert.equal(px(edge, 2, 4)[0], 0);
});

console.log("\nchannels");

check("swizzle rearranges channels and can invert them", () => {
  const b = createBuffer(1, 1);
  setPixel(b, 0, 0, [10, 20, 30, 40]);
  swizzle(b, { r: "b", g: "r", b: "g", a: "a" });
  assert.deepEqual(px(b, 0, 0), [30, 10, 20, 40]);
  swizzle(b, {}, { invert: { r: true } });
  assert.equal(px(b, 0, 0)[0], 225);
});

check("swizzle reads all four sources at once, not one at a time", () => {
  // The trap: writing r first and then reading it back for g. Swapping two
  // channels has to work.
  const b = createBuffer(1, 1);
  setPixel(b, 0, 0, [10, 200, 0, 255]);
  swizzle(b, { r: "g", g: "r" });
  assert.deepEqual(px(b, 0, 0).slice(0, 2), [200, 10]);
});

check("packChannels builds one map from four sources", () => {
  const rough = createBuffer(4, 4, [60, 60, 60, 255]);
  const metal = createBuffer(4, 4, [200, 200, 200, 255]);
  const ao = createBuffer(4, 4, [30, 30, 30, 255]);
  const packed = packChannels({
    width: 4,
    height: 4,
    channels: {
      r: { buffer: rough, source: "luminance" },
      g: { buffer: metal, source: "luminance" },
      b: { buffer: ao, source: "luminance" },
      a: { constant: 255 },
    },
  });
  const p = px(packed, 2, 2);
  assert.ok(Math.abs(p[0] - 60) <= 1 && Math.abs(p[1] - 200) <= 1 && Math.abs(p[2] - 30) <= 1, p.join());
  assert.equal(p[3], 255);
});

check("packChannels resamples mismatched sources instead of refusing them", () => {
  const big = createBuffer(8, 8, [255, 255, 255, 255]);
  const small = createBuffer(2, 2, [128, 128, 128, 255]);
  const packed = packChannels({
    width: 8,
    height: 8,
    channels: { r: { buffer: big, source: "luminance" }, g: { buffer: small, source: "luminance" } },
  });
  assert.equal(packed.width, 8);
  assert.ok(Math.abs(px(packed, 6, 6)[1] - 128) <= 2, "the 2x2 source was scaled up");
});

check("packChannels uses a constant for an absent source", () => {
  const packed = packChannels({ width: 2, height: 2, channels: { g: { constant: 90 } } });
  assert.deepEqual(px(packed, 0, 0), [0, 90, 0, 255]);
});

check("splitChannels round-trips through packChannels", () => {
  const source = createBuffer(4, 4);
  for (let i = 0; i < 16; i++) {
    source.data[i * 4] = i * 3;
    source.data[i * 4 + 1] = 255 - i * 3;
    source.data[i * 4 + 2] = i * 7;
    source.data[i * 4 + 3] = 200;
  }
  const parts = splitChannels(source);
  const rebuilt = packChannels({
    width: 4,
    height: 4,
    channels: {
      r: { buffer: parts.r, source: "r" },
      g: { buffer: parts.g, source: "r" },
      b: { buffer: parts.b, source: "r" },
      a: { buffer: parts.a, source: "r" },
    },
  });
  assert.deepEqual(Array.from(rebuilt.data), Array.from(source.data));
});

check("premultiply and unpremultiply invert each other away from alpha 0", () => {
  const b = createBuffer(1, 1, [200, 100, 50, 128]);
  premultiply(b);
  assert.ok(px(b, 0, 0)[0] < 110, "colour was scaled down");
  unpremultiply(b);
  const p = px(b, 0, 0);
  assert.ok(Math.abs(p[0] - 200) <= 3 && Math.abs(p[1] - 100) <= 3, p.join());
});

check("alphaFromLuminance turns a white background into transparency", () => {
  const b = createBuffer(2, 1);
  setPixel(b, 0, 0, [255, 255, 255, 255]);
  setPixel(b, 1, 0, [0, 0, 0, 255]);
  alphaFromLuminance(b, { invert: true });
  assert.equal(px(b, 0, 0)[3], 0, "white became transparent");
  assert.equal(px(b, 1, 0)[3], 255);
});

check("fillChannel can force a texture opaque", () => {
  const b = createBuffer(2, 2, [10, 10, 10, 0]);
  fillChannel(b, "a", 255);
  assert.equal(px(b, 0, 0)[3], 255);
});

check("alpha bleed fills transparent texels with neighbouring colour, alpha untouched", () => {
  const b = createBuffer(8, 8);
  for (let y = 3; y < 5; y++) for (let x = 3; x < 5; x++) setPixel(b, x, y, [255, 40, 40, 255]);
  bleedAlpha(b, { distance: 2 });
  const p = px(b, 2, 3);
  assert.ok(p[0] > 200 && p[1] < 80, `the border took the sprite's colour (${p.join()})`);
  assert.equal(p[3], 0, "and stayed invisible");
});

console.log("\ndocument trimming");

check("trim crops to the opaque content and reports the kept rectangle", () => {
  const doc = createDocument({ width: 16, height: 16 });
  for (let y = 4; y < 9; y++) for (let x = 5; x < 11; x++) setPixel(doc.layers[0].buffer, x, y, [1, 2, 3, 255]);
  const kept = trimDocument(doc);
  assert.deepEqual(kept, { x: 5, y: 4, width: 6, height: 5 });
  assert.equal(doc.width, 6);
  assert.equal(doc.height, 5);
  assert.deepEqual(px(doc.layers[0].buffer, 0, 0), [1, 2, 3, 255]);
});

check("trim measures the FLATTENED document, not one layer", () => {
  // Trimming to the active layer's extent would cut away everything below it.
  const doc = createDocument({ width: 16, height: 16 });
  setPixel(doc.layers[0].buffer, 1, 1, [9, 9, 9, 255]);
  const top = addLayer(doc, { name: "Top" });
  setPixel(top.buffer, 12, 12, [8, 8, 8, 255]);
  const kept = trimDocument(doc);
  assert.deepEqual(kept, { x: 1, y: 1, width: 12, height: 12 });
});

check("trim on a full or empty document does nothing rather than something odd", () => {
  const full = createDocument({ width: 8, height: 8, background: [1, 1, 1, 255] });
  assert.equal(trimDocument(full), null);
  assert.equal(full.width, 8);
  const empty = createDocument({ width: 8, height: 8 });
  assert.equal(trimDocument(empty), null);
  assert.equal(empty.width, 8, "an empty document is not collapsed to nothing");
});

console.log(`\n${passes} passed, ${failures} failed\n`);
process.exit(failures ? 1 : 0);
