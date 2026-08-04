# Texture Editor module — design

**Written 2026-08-05.** A raster editor, image processor and sprite/atlas authoring tool
inside the engine, so working with textures never means a round trip through Photoshop.

Not a Photoshop clone. The target is *everything a game needs done to a texture*, which is
a much smaller and differently-shaped set than what a photo editor covers: paint and fix up
an artwork, pack channels, check a tile for seams, cut a sheet into sprites, mark up
nine-slice borders, and build an atlas.

---

## The four decisions that shape everything else

### 1. The PNG stays the asset; the document is a sidecar

Layers have to persist or the tool is a one-shot scratchpad — but the moment a layered
document becomes the *primary* asset, every material, UI image and sprite reference in the
project becomes indirect, and every imported PNG needs a conversion step before it can be
touched.

So: `textures/wall.png` remains exactly what it was and what everything references. Beside
it sits `textures/wall.png.tex`, hidden in the Assets grid, holding the layer stack. Saving
flattens to the PNG *and* writes the sidecar. **A texture with no sidecar opens as a single
layer**, which is what makes every already-imported texture in every existing project
editable on day one rather than after a migration.

This is the same shape as `.meta` and `.basis`, and it inherits their plumbing: the file is
hidden from the grid, follows its image through rename/move/delete, and is never shipped in
a build (see `assetLoader.listAssetsFiltered`, `assetOps`, `exportGame`).

`.tex` is a **binary container**, not JSON:

```
magic "TEXDOC1" | u32 headerLen | headerLen bytes of JSON | layer0 png | layer1 png | ...
```

The header names each layer (`{name, offset, length, visible, opacity, blend, locked, x, y}`);
the payloads are ordinary PNGs, concatenated. Base64 inside a JSON file was the obvious
alternative and is a bad one: it inflates 33%, and a 2K document with six layers becomes a
multi-megabyte *string* that has to be parsed, held twice in memory, and pushed through
Tauri's IPC as text. The container is written with `write_binary_file_raw` (raw bytes, the
path the geometry cache already uses) and every layer inside it is a file a human can
extract with 20 lines of script if the editor ever refuses to open it.

### 2. The image core is pure, and knows nothing about canvas, React or the DOM

Everything that decides *what the pixels become* — compositing, brushes, flood fill,
selections, resampling, adjustments, filters, atlas packing, sprite slicing — operates on a
plain `{ width, height, data: Uint8ClampedArray }` in `src/editor/texture/`. No
`CanvasRenderingContext2D`, no `ImageData`, no imports from React.

Two reasons, and the second is the one that matters. The first is testability: the whole
core runs under `node` in a headless test, which is how this repo tests everything else.
The second is **correctness of the alpha model**. Canvas2D composites in *premultiplied*
alpha with browser-defined rounding, and reading pixels back out of it is lossy — paint a
50%-alpha stroke, read it back, write it again, and the colour drifts. That drift is
invisible for one operation and obvious after a session of work, and it is un-debuggable
through an API that will not tell you what it did. We composite straight-alpha ourselves.

Canvas appears in exactly two places, both at the edges: **decoding** an imported PNG/JPEG
to pixels, and **encoding** back to PNG. Both are injected as a codec pair
(`src/editor/texture/codecPng.js` in the browser, a raw stub in tests) — the same swappable-
hook pattern as `assetResolver` and `setSaveBackend`.

### 3. Sprites and atlases are runtime *core*, not part of this module

The module is the authoring tool. What it authors — `.atlas` files, nine-slice insets,
sprite animations — has to be usable by a shipped game whether or not anyone ever enables an
editor module. Enabling something called "Texture Editor" to make a sprite draw in a build
would be nonsense.

So `src/engine/sprite/` (atlas asset loading, animation playback) and `SpriteComponent` are
core engine, next to decals and trails; `src/modules/texture-editor/` is the module, and it
gates the panel the way `polyhaven` gates its browser.

### 4. One document model, three surfaces

The paint canvas, the atlas builder and the sprite/animation editor are three modes of one
panel over one document, not three panels. They constantly need each other: slicing a sheet
wants to see the alpha you just erased, and fixing a sprite's bleed means painting inside
the atlas you just packed. Splitting them into separate panels means saving and re-opening
between every such step.

---

## Layout

```
src/editor/texture/          pure image core — no DOM, no React, headless-testable
  pixels.js       PixelBuffer: create/clone/crop/resize/flip/rotate/blit
  blend.js        straight-alpha blend modes + layer compositing
  layers.js       document model: layer list, ops, flatten
  draw.js         brush/line/rect/ellipse/flood fill/gradient rasterizers
  selection.js    selection mask: rect/ellipse/wand/invert/grow/feather
  adjust.js       brightness/contrast/HSV/levels/curves/invert/threshold/posterize
  filters.js      blur/sharpen/emboss/edge/noise/offset/normal-from-height
  channels.js     swizzle/split/merge/premultiply/alpha-from-luminance
  texdoc.js       .tex container encode/decode (codec injected)
  history.js      undo stack with coalescing
  packer.js       MaxRects atlas packing
  slice.js        grid + alpha-connected-component slicing
  codecPng.js     the browser codec pair (the only DOM file here)
src/editor/panels/TextureEditorPanel.jsx    the panel (paint / atlas / sprite modes)
src/engine/sprite/                          runtime: atlas asset + animation playback
src/engine/components/SpriteComponent.js    runtime: world-space sprite
src/modules/texture-editor/index.js         the module definition
```

---

## Phases

- **Phase 1 — document model + paint.** `.tex` container, layers, blend modes, the paint
  tools, selections, undo, the panel with zoom/pan/checkerboard/tiling preview, New Texture,
  Edit Texture entry points, save, and the sidecar plumbing (hide / rename / move / delete /
  never export). Test: `npm run test:texture`.
- **Phase 2 — processing.** Resize, canvas size, crop, flip, rotate, trim; adjustments;
  filters; channel packing (roughness/metalness/AO into one RGB map — the single most
  frequent texture chore in a PBR pipeline); seamless offset for tiling work;
  normal-from-height.
- **Phase 3 — atlas and sprites.** `.atlas` format, MaxRects packing with padding and
  extrusion, grid and alpha slicing, region pivots, nine-slice guides with a live resize
  preview, animation timeline with playback, unpack-to-PNGs.
- **Phase 4 — runtime.** `SpriteComponent`, atlas/region/animation on `UiImageComponent`,
  scene preload following `.atlas` → image, `exportGame` shipping atlases with rewritten
  paths, script typings, plus the headless and smoke tests for all of it.

Status is tracked per phase below as it lands.

- [x] Phase 1 — **shipped 2026-08-05**
- [ ] Phase 2
- [ ] Phase 3
- [ ] Phase 4

---

## Phase 1 — what landed

The image core (`src/editor/texture/`), the `.tex` container, the panel, and the
sidecar plumbing.

- **Tools**: brush and eraser (size, hardness, opacity, spacing-interpolated strokes),
  paint bucket, linear/radial gradient, line, rectangle and ellipse (filled or outlined),
  rectangle/ellipse/lasso/magic-wand selection with replace–add–subtract–intersect,
  eyedropper, and a non-destructive layer move.
- **Layers**: add, duplicate, reorder, delete, merge down, rename, per-layer visibility,
  lock, opacity and 14 blend modes; per-layer masks exist in the model and the container
  (the UI for them is phase 2 work).
- **Undo** is local to the panel and **costs what the edit costs**: a brush dab stores the
  rectangle it touched, not the document. Structural edits snapshot; strokes never do.
- **View**: zoom about the pointer, pan, fit, a screen-space transparency checkerboard,
  a true-size brush ring, a marching-ants selection outline, and a 3×3 **tiling preview**
  — the fastest way to see whether a surface texture seams.
- Entry points: double-click any image in Assets, *Edit Texture* in its context menu,
  *New Texture* in the create menu, or Window ▸ Texture Editor.

Three decisions inside the panel that are load-bearing:

- **The document lives in a ref, not React state.** A 2K layer is 16MB; putting it in
  state means React holding and comparing tens of megabytes on every pointer move.
- **A live stroke re-rasterizes only the segment just drawn**, restoring that rectangle
  from a pre-stroke copy first. Restoring is what keeps `max()`-accumulated coverage
  correct (a 40% brush must read 40% however many dabs overlapped); clipping to the
  segment is what stops a long stroke getting slower the longer it gets.
- **Uploads to the display canvas are dirty-rect**, so brush latency scales with brush
  size rather than document size, and panning re-uploads nothing at all.

Nothing was needed in `exportGame`: it ships assets *referenced by scenes* plus explicit
`.meta`/`.basis` sidecars, and a `.tex` is neither. It is hidden from the Assets grid and
follows its image through rename, move and delete, like `.meta`.

Tests: `npm run test:texture` (56 headless checks over compositing, the PNG round trip,
the container, layer ops, selections, the rasterizers and the undo stack) and
`npm run smoke:texture` (26 checks driving the real panel — painting reaches the saved
PNG, undo rewinds the *pixels*, and a two-layer document reopens as two layers rather
than one flattened one, which is the failure that would cost a session's work).
