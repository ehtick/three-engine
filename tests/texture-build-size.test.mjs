// Gate: build-time texture size cap (build/textureBuildSize.js) — target size
// from source dimensions + `.meta` `maxSize` + build default, and the header
// parser that supplies the dimensions.
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MAX_TEXTURE_SIZE,
  resolveTextureCap,
  textureBuildSize,
  imageDimensions,
  basisBuildCacheName,
} from "../src/editor/build/textureBuildSize.js";

const size = (w, h, meta, max) => {
  const s = textureBuildSize({ width: w, height: h }, meta, max);
  return s && [s.width, s.height, s.resized];
};

test("default cap is 2048 and applies to the largest side", () => {
  assert.equal(DEFAULT_MAX_TEXTURE_SIZE, 2048);
  assert.deepEqual(size(4096, 4096), [2048, 2048, true]);
  assert.deepEqual(size(2048, 2048), [2048, 2048, false]);
  assert.deepEqual(size(1024, 512), [1024, 512, false]);
});

test("power-of-two sources stay power-of-two and keep aspect", () => {
  assert.deepEqual(size(8192, 2048), [2048, 512, true]);
  assert.deepEqual(size(1024, 4096), [512, 2048, true]);
  // A non-POT cap floors to POT for POT sources rather than producing 3000.
  assert.deepEqual(size(4096, 4096, null, 3000), [2048, 2048, true]);
  assert.deepEqual(size(4096, 1, null, 2048), [2048, 1, true]);
});

test("NPOT sources scale to the cap exactly", () => {
  assert.deepEqual(size(3000, 1500), [2048, 1024, true]);
  assert.deepEqual(size(2500, 1000, null, 1000), [1000, 400, true]);
});

test("meta maxSize overrides the build default; 0 opts out", () => {
  assert.deepEqual(size(4096, 4096, { maxSize: 0 }), [4096, 4096, false]);
  assert.deepEqual(size(4096, 4096, { maxSize: 4096 }), [4096, 4096, false]);
  assert.deepEqual(size(4096, 4096, { maxSize: 1024 }), [1024, 1024, true]);
  assert.deepEqual(size(4096, 4096, {}, 0), [4096, 4096, false]);
  assert.deepEqual(size(4096, 4096, {}, 1024), [1024, 1024, true]);
  // Garbage falls back instead of disabling the cap.
  assert.equal(resolveTextureCap({ maxSize: "big" }, undefined), 2048);
  assert.equal(resolveTextureCap({ maxSize: -5 }, 512), 512);
  assert.equal(resolveTextureCap(null, "nope"), 2048);
});

test("negative control: the meta override really is consulted", () => {
  // If maxSize were ignored, the hero opt-out would be resampled.
  assert.notDeepEqual(size(4096, 4096, { maxSize: 0 }), size(4096, 4096, {}));
});

test("unusable dimensions answer null", () => {
  assert.equal(textureBuildSize({ width: 0, height: 10 }), null);
  assert.equal(textureBuildSize({}), null);
});

test("PNG and JPEG headers yield dimensions", () => {
  const png = new Uint8Array(33);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(png.buffer).setUint32(16, 3000);
  new DataView(png.buffer).setUint32(20, 1500);
  assert.deepEqual(imageDimensions(png), { width: 3000, height: 1500 });

  // SOI, APP0 (len 16), fill byte, SOF2 progressive: h=600 w=800.
  const jpeg = Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0),
    0xff, 0xff, 0xc2, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03,
  ]);
  assert.deepEqual(imageDimensions(jpeg), { width: 800, height: 600 });
  assert.equal(imageDimensions(Uint8Array.from([1, 2, 3, 4])), null);
});

test("cache name changes with anything that changes the encoded bytes", () => {
  const base = { mtime: 1, width: 2048, height: 2048, mode: "srgb" };
  const name = basisBuildCacheName("C:/p/tex/wood color.png", base);
  assert.match(name, /^wood_color-2048x2048-[0-9a-f]{8}\.basis$/);
  assert.equal(basisBuildCacheName("C:\\p\\tex\\wood color.png", base), name, "separator-insensitive");
  for (const change of [{ mtime: 2 }, { width: 1024, height: 1024 }, { mode: "linear" }]) {
    assert.notEqual(basisBuildCacheName("C:/p/tex/wood color.png", { ...base, ...change }), name);
  }
});
