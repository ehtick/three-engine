import assert from "node:assert/strict";
import test from "node:test";
import { readRenderTargetImage } from "../src/engine/renderTargetImage.js";

/**
 * The two backend conventions for reading a render target back
 * (`src/engine/renderTargetImage.js`).
 *
 * Run with `node --test tests/render-target-image.test.mjs`.
 *
 * This is worth pinning because both ways of getting it wrong produce an image
 * rather than an error: the wrong row order gives a perfect picture upside
 * down, and the wrong padding gives one progressively sheared. The first
 * shipped — every editor screenshot and every `.geom` thumbnail was inverted on
 * WebGPU, because the WebGL bottom-up flip had been carried across to a backend
 * whose `copyTextureToBuffer` preserves texture order (row 0 = top).
 */

const WIDTH = 3;
const HEIGHT = 4;
const ROW_BYTES = WIDTH * 4;
const PADDED = Math.ceil(ROW_BYTES / 256) * 256;

/** Row `y` filled with the byte `y + 1`, so a row's identity is its value. */
const rowValue = (y) => y + 1;

function fakeRenderer(backend, buffer) {
  return { backend, readRenderTargetPixelsAsync: async () => buffer };
}

/** What the caller must always get back: tight rows, row 0 first. */
function assertTopDown(image) {
  assert.equal(image.length, ROW_BYTES * HEIGHT);
  for (let y = 0; y < HEIGHT; y++) {
    const row = [...image.subarray(y * ROW_BYTES, (y + 1) * ROW_BYTES)];
    assert.deepEqual(row, new Array(ROW_BYTES).fill(rowValue(y)), `row ${y}`);
  }
}

test("WebGPU: unpads 256-byte rows and keeps them top-down", async () => {
  // three sizes the mapped buffer as (height-1)*paddedRow + rowBytes — the
  // final row really is short, so a reader that assumes height*paddedRow
  // over-reads the end of the buffer.
  const raw = new Uint8Array((HEIGHT - 1) * PADDED + ROW_BYTES);
  for (let y = 0; y < HEIGHT; y++) raw.fill(rowValue(y), y * PADDED, y * PADDED + ROW_BYTES);

  assertTopDown(await readRenderTargetImage(fakeRenderer({ isWebGPUBackend: true }, raw), {}, WIDTH, HEIGHT));
});

test("WebGL: unflips gl.readPixels' bottom-up tight rows", async () => {
  const raw = new Uint8Array(ROW_BYTES * HEIGHT);
  // Row 0 of the buffer is the BOTTOM of the image, so it holds the last row.
  for (let y = 0; y < HEIGHT; y++) raw.fill(rowValue(HEIGHT - 1 - y), y * ROW_BYTES, (y + 1) * ROW_BYTES);

  assertTopDown(await readRenderTargetImage(fakeRenderer({ isWebGLBackend: true }, raw), {}, WIDTH, HEIGHT));
});

test("an unrecognised backend is treated as WebGPU, not as WebGL", async () => {
  const raw = new Uint8Array((HEIGHT - 1) * PADDED + ROW_BYTES);
  for (let y = 0; y < HEIGHT; y++) raw.fill(rowValue(y), y * PADDED, y * PADDED + ROW_BYTES);

  assertTopDown(await readRenderTargetImage(fakeRenderer(undefined, raw), {}, WIDTH, HEIGHT));
});

test("a truncated buffer yields black rather than reading past the end", async () => {
  const raw = new Uint8Array(PADDED + ROW_BYTES); // two rows' worth, four asked for
  raw.fill(rowValue(0), 0, ROW_BYTES);
  raw.fill(rowValue(1), PADDED, PADDED + ROW_BYTES);

  const image = await readRenderTargetImage(fakeRenderer({ isWebGPUBackend: true }, raw), {}, WIDTH, HEIGHT);
  assert.equal(image.length, ROW_BYTES * HEIGHT);
  assert.deepEqual([...image.subarray(0, ROW_BYTES)], new Array(ROW_BYTES).fill(1));
  assert.deepEqual([...image.subarray(3 * ROW_BYTES)], new Array(ROW_BYTES).fill(0));
});
