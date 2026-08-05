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
- [x] Phase 2 — **shipped 2026-08-05**
- [x] Phase 3 — **shipped 2026-08-05**
- [x] Phase 4 — **shipped 2026-08-05**

**All four phases are done.**

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

Tests: `npm run test:texture` and `npm run smoke:texture` (counts under phase 2).

---

## Phase 2 — what landed

Four menus — **Image**, **Adjust**, **Filter**, **Channels** — over three new pure
modules (`adjust.js`, `filters.js`, `channels.js`).

- **Image**: Resize (bilinear or nearest, aspect lock, ½×/2× and power-of-two presets),
  Canvas Size with a 3×3 anchor, Crop to Selection, Trim Transparent Edges, flip, and
  90/180/270 rotation.
- **Adjust**: Brightness/Contrast, Levels, Hue/Saturation/Lightness, Colorize, Threshold,
  Posterize, Desaturate, Invert — all on the active layer, all honouring the selection.
- **Filter**: Blur, Sharpen, Noise, **Offset**, **Normal from Height**, Edge Detect,
  Emboss, Median.
- **Channels**: **Pack Channels**, Swizzle, Split into Layers, Alpha from (Inverted)
  Luminance, Make Opaque, **Bleed Colour into Transparency**, Premultiply/Unpremultiply.

The four that earn their place by being *engine* features rather than editor features:

- **Pack Channels** — four files in, one texture out, because a PBR set arrives as
  separate roughness/metalness/AO/height files and ships as one RGB map. Sources of
  different sizes are resampled rather than refused (a 2K albedo beside a 1K roughness is
  the normal case), a slot with no file takes a constant (metalness is 0 everywhere
  without anyone authoring a black image to say so), and the result is written as a **new
  asset tagged `colorSpace: linear`** — a packed map read as sRGB is wrong everywhere it
  is sampled, and the symptom points at the material rather than at the import setting.
- **Offset** wraps the image, so a tiling texture can be shifted by half its size and the
  seam that was at the edge is now in the middle where it can be painted out. Nothing else
  in the editor can do this, and without it "make this tile" is guesswork.
- **Normal from Height** is Sobel over luminance, **wrapping by default** (the input is
  almost always a tiling surface, and clamping puts a seam in the normal map of a seamless
  height map) with an Invert Y for DirectX-convention assets.
- **Bleed Colour into Transparency** fills transparent texels with neighbouring colour and
  leaves alpha at zero — the fix for the dark or white fringe every sprite atlas has,
  caused by filtering averaging in RGB nobody can see.

Decisions worth recording:

- **Curves is deliberately not implemented.** It is a photo-retouching tool; everything a
  texture needs from it, Levels does with five numbers that can be typed and reproduced.
- **Adjustments never write alpha.** Brightening a sprite must not thicken its edge.
- **A selection blends an operation, not clips it** — a feathered selection produces a
  feathered adjustment, not a hard-edged one with soft sides.
- **Anything that averages colour works premultiplied** (blur, resample), or a sprite on
  transparency gets a dark halo.
- **Noise is seeded, never `Math.random()`** — "a bit less noise" must not re-roll the
  grain you already liked.
- Resize and Canvas Size are two dialogs on purpose. Same two numbers, completely
  different consequences; merging them is how someone eventually destroys artwork with a
  radio button.
- Dialogs preview by writing into the **live layer** and restoring from a snapshot on
  every change and on Cancel — so what you see is literally what Apply commits. Apply
  re-runs from the snapshot, not on top of the preview, or a blur previewed three times
  would be applied three times.

One bug this shipped with and then didn't: previewing re-renders the panel, which hands
the dialog a fresh `onPreview` callback; with that callback as an effect dependency the
dialog re-previews forever and burns a core for as long as it is open, with no symptom a
screenshot would show. The smoke now samples the dialog's busy marker over a second and
fails if an idle dialog is still scheduling work — verified by reintroducing the bug
(8/10 samples busy) and removing it again (0/10).

Tests: `npm run test:texture` and `npm run smoke:texture` (counts under phase 3).

---

## Phase 3 — what landed

`.atlas` assets, both directions of the round trip, and an Atlas mode in the panel.

**The format** (`src/engine/sprite/atlasAsset.js`) is JSON beside the image, holding no
pixels — same shape as `.cubemap` and `.mat`, so the sheet stays an ordinary editable
texture and can still be referenced directly by anything wanting the whole thing.

- **One coordinate convention, and it is image space**: every rect is in texture pixels,
  top-left origin, Y down. Pivots are normalised into that same space, so `[0.5, 1]` is
  bottom-centre — where a character standing on the ground wants its origin. The pull to
  store pivots Y-up (what a quad in a Y-up world needs) is resisted deliberately: two
  conventions in one file is how you get a sprite that is correct until it is flipped.
  **The Y flip happens in exactly one function**, `regionUv`, at the UV boundary.
- Nine-slice borders are texture pixels — a property of the artwork, not of what it is
  stretched over — which is the same numbers `UiImageComponent` already takes.
- `normalizeAtlas` degrades rather than throws: a region with no pivot gets a centred one,
  an animation naming a frame that no longer exists loses that frame. An atlas that
  refuses to load takes every sprite in the scene with it.
- A non-looping animation **holds its last frame**. Vanishing on the final frame is the
  usual bug and nobody wants it.

**Packing** (`packer.js`) is MaxRects/best-short-side-fit rather than a shelf packer,
because sprites are wildly non-uniform — a UI set is a dozen 16px icons and three 400px
panels, and a shelf packer wastes a whole row's height on the tall one, routinely 30–40%
of the sheet. It is **deterministic**: same sprites, same sheet, regardless of input
order, so a rebuild isn't a gratuitous re-upload for anything caching the result.
Overflow is **reported by name**, never silently dropped — an atlas missing three sprites
looks like it worked until something renders empty.

**Padding and extrusion are both offered because they solve different problems.** Padding
puts space between sprites so a neighbour can't bleed in; extrusion repeats a sprite's own
edge texels outward so the *empty space* can't bleed in when a mipmap or a half-texel
offset samples past the rect. An atlas with padding and no extrusion still fringes at
distance.

**Slicing** (`slice.js`) covers the two kinds of sheet that exist. Grid, for anything
exported from an animation tool — a cell that would run off the edge is **dropped, not
clipped**, because a clipped last column looks like a working slice and yields one frame
subtly squashed. And by transparency, 8-connected so an antialiased diagonal join doesn't
split a sprite, then merging **overlapping** boxes so a sprite whose parts don't touch
stays one region. Overlap, not proximity: proximity would fuse neighbours on a packed
sheet, which is the more common sheet.

**Re-slicing preserves names positionally** when the region count is unchanged, so editing
a sheet's artwork and re-slicing doesn't break every animation that references a frame by
name. Pivots and borders come along with them.

**The panel** gained Paint / Atlas tabs over one sheet, because the two are used in the
same breath — slice what you just erased, paint inside the atlas you just packed. Atlas
mode has region rects you can drag, resize and create, **draggable nine-slice guides** on
the canvas (tested before the move gesture, or the border could only ever be typed), a
pivot cross, a nine-cell schematic showing which parts stretch, and an animation list with
a live preview playing at its real frame rate on wall-clock time. Assets panel: select
several textures → **Pack N into Atlas…**; in the editor, **Export Sprites** writes every
region back out as its own PNG.

Two bugs the tests caught, both mine: the packer sized its first guess without clamping to
`maxSize`, so a single oversized sprite produced a sheet exceeding the cap and packed
happily — failing at upload rather than where it could be reported. And two test premises
were wrong about my own merge rule, which is how the "overlap, not proximity" trade above
came to be stated explicitly rather than assumed.

Tests: `npm run test:texture` (116 headless checks) and `npm run smoke:texture` (65 checks
driving the real editor — packing three sprites and verifying **each region holds its own
sprite's pixels** (a packer that reports plausible rects while blitting to the wrong place
looks fine until something renders), that the gutter really is extruded, that a border and
pivot set in the UI reach disk, and that unpacking returns sprites at their original size
and colour).

---

## Phase 4 — what landed

The runtime. Everything the editor authors is now drawable by a shipped game, and none
of it requires the module to be enabled — sprites are core engine, next to decals and
trails, for the reason in decision 3 above.

**`SpriteComponent`** (`sprite`) — a textured quad from an atlas region or a plain image.

- **A sprite's size comes from its pixels.** `pixelsPerUnit` is the only scale knob, and
  it is the same number that converts the nine-slice border, so a sprite and its border
  can never disagree about scale. Two frames of one animation trimmed to different sizes
  don't change size on screen; a 64px icon beside a 128px one is half as big with no
  per-sprite scale factor to maintain.
- **Animation runs on game time**, so bullet time slows it and a pause menu freezes it —
  the rule the particle sim and the trails already follow. Playback position is
  `resetOnStop` state, or leaving Play would strand the sprite on whatever frame it
  reached. A non-looping animation fires `sprite-animation-end` **once**, at the moment
  it finishes, not every frame it spends holding its last pose.
- Script API: `play` / `pause` / `resume` / `stop` / `setRegion`, plus `isPlaying`,
  `frame` and `regionNames`.
- **Billboarding is CPU-side and that limitation is stated, not hidden**: each sprite owns
  its mesh, so facing `engine.camera` is one quaternion per sprite per frame — but with
  two cameras in one frame only the active one is faced. `"y"` (cylindrical) keeps the
  sprite upright and only yaws, which is what a tree or a health bar wants; `"full"` also
  pitches. `"none"` never writes to the transform at all, so a sprite laid flat as a
  ground marker can't snap upright.
- The bounding sphere is **written, never computed** — the buffers are over-allocated for
  the nine-slice case, so a computed sphere would measure the stale tail past the live
  vertices. Same trap the ribbons hit; it presents as "the sprite sometimes disappears".
- Its mesh is marked `noBatch`: the vertices are rewritten whenever the frame changes.

**`UiImageComponent`** gained `atlas` + `region`. The region's pixel size drives the
nine-slice maths (so a region behaves exactly like a lone file), and **the region's own
authored border wins over the element's insets** — the border belongs to the artwork, and
retyping it on every element that shows the sprite is what the atlas exists to stop. In
the shader the region remap happens *after* the slice maths, in region-relative space;
doing it first would make the insets fractions of the whole sheet.

**Pipeline**: scene preload follows a `.atlas` to its image the way it already follows a
`.mat` to its textures (a level starting before the sheet arrives is a screen of blank
quads), and `exportGame` re-emits each `.atlas` with its image path rewritten into the
build's asset namespace — dropping each region's `source`, which is an authoring path
that would otherwise drag every loose sprite along with the sheet.

Also: the Inspector learned `vec2` (one component handling both axis counts rather than a
near-identical twin).

One bug the tests caught, and it is the one worth remembering: **the pivot's Y was mapped
backwards**. A pivot is normalised in image space, so `[0.5, 1]` is the image's *bottom*
row and must land at y = 0 with the sprite standing above it — a character's feet at its
transform. The inverted version hangs every sprite below its entity, which looks perfectly
plausible right up until something has to stand on the ground.

Tests: `npm run test:texture` (124 headless checks — the sprite geometry additions assert
the thing nine-slice exists for: widening a panel from 1 to 4 units leaves its corners
exactly 0.08 units wide) and `npm run smoke:texture` (74 checks; the runtime section walks
a real `SpriteComponent` through every frame of a real atlas animation, wraps it, and
measures the built quad at 0.08 × 0.30 world units from an 8×30px region).
