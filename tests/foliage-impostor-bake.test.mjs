import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import {
  aimFrameCamera, chooseImpostorTile, createImpostorBakeJob, ensureDilateQuad, ensureDownsampleQuad, impostorBakeMaterialCount,
  IMPOSTOR_BAKE_DEFAULTS, IMPOSTOR_TILE_SIZES, MAX_VIEWS_PER_STEP, MIN_CARD_TEXELS,
} from "../src/engine/lod/impostorBake.js";
import { frameBasis, frameDirection, tileOrigin } from "../src/engine/lod/octahedral.js";
import { createFoliagePrototype } from "../src/modules/foliage/foliageGeometry.js";

/** The exact tree/shrub/accent groups `valleyEcology.js` (lines 70-95) plants,
 * so this test tracks the real population rather than a synthetic stand-in.
 * `common` mirrors that file's own shared block. */
const common = { distribution: "placements", castShadow: true, receiveShadow: true, wind: true, windStrength: .14, interaction: false };
const VALLEY_GROUPS = {
  "oak-wide": { ...common, species: "oak", seed: 21, height: 11, width: 8.8, leafDensity: 1.5, leafSize: 1.28, branchDensity: 1.25, crownBase: -.08, crownSpread: .96 },
  "oak-elder": { ...common, species: "oak", seed: 76, height: 13, width: 10, leafDensity: 1.55, leafSize: 1.24, branchDensity: 1.25, crownBase: -.07, crownSpread: .96 },
  "birch-tall": { ...common, species: "birch", seed: 53, height: 12, width: 6, leafDensity: 1.5, leafSize: 1.2, branchDensity: 1.2, crownBase: -.05, crownSpread: 1 },
  "pine-tall": { ...common, species: "pine", seed: 38, height: 14, width: 6.3, leafDensity: 1.35, leafSize: 1.15, branchDensity: 1.1, crownBase: -.05, crownSpread: 1 },
  "hazel-study": { ...common, species: "oak", seed: 125, height: 1.8, width: 2.9, leafDensity: 1.6, leafSize: 1.35, branchDensity: 1.4, crownBase: -.15, crownSpread: 1.2 },
  "young-growth": { ...common, species: "birch", seed: 142, height: 2.8, width: 2.6, leafDensity: 1.5, leafSize: 1.25, branchDensity: 1.2, crownBase: -.15, crownSpread: 1.15 },
  accent: { ...common, species: "oak", seed: 207, height: 12, width: 7.2, leafDensity: 1.45, leafSize: 1.24, branchDensity: 1.15, crownBase: -.06, crownSpread: .98 },
};

/** Same bounding-box-diagonal/2 `impostorBake.js#boundsOf` computes on the
 * cloned bake root — `FoliageComponent.js#acquireAtlas` reads it the same way
 * off the un-cloned LOD0 geometry before the bake even starts. */
function boundsRadius(geometry) {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  const dx = box.max.x - box.min.x, dy = box.max.y - box.min.y, dz = box.max.z - box.min.z;
  return Math.hypot(dx, dy, dz) * 0.5;
}

// Expected tile per group, hand-verified against the formula
// `tile >= MIN_CARD_TEXELS * 2 * radius / cardWidth` for each group's actual
// generated geometry (see the task's own measurement pass). Trees/accent with
// oak- or birch-scale cards land on 128; the needle-clustered pine (much
// narrower cards on a similarly large crown) needs the full 256; the two
// shrubs are small enough that even 64 already clears the bar.
// P1-D: the intended-crown-radius envelope (`treeGrowth.js`'s "Intended-
// crown-radius envelope") deliberately targets a real oak's/maple's actual
// width/height proportions (a broad dome, not a column) — oak-wide,
// oak-elder and accent are all genuinely wider now (radius ~11.7-13.9m on a
// height 11-13m tree), so their worst-case card needs the 128 tile like
// birch-tall, not 64.
// 09-14: oak/birch cards are 1.45× uniform (was 1.75 long × 1.22 wide — it
// stretched every leaf), so their worst card is wider and the CARD rule alone
// lands oak-wide/birch-tall/accent back on 64. The foliage runtime floors
// every bake at 128 for on-screen resolution (`minTile`, tested below).
const EXPECTED_TILE = {
  "oak-wide": 64, "oak-elder": 128, "birch-tall": 64, "pine-tall": 256,
  "hazel-study": 64, "young-growth": 64, accent: 64,
};

for (const [name, props] of Object.entries(VALLEY_GROUPS)) {
  test(`impostor tile choice: ${name} matches its own worst-case card`, () => {
    const geometry = createFoliagePrototype(props, 0);
    const radius = boundsRadius(geometry);
    const cardWidth = geometry.userData.foliage.tree.leafCardMinWidthMeters;
    assert.ok(cardWidth > 0, "tree species record a worst-case card width");
    assert.ok(radius > 1, "a tree/shrub has real extent");
    const tile = chooseImpostorTile({ cardWidth, radius });
    assert.equal(tile, EXPECTED_TILE[name], `${name}: radius=${radius.toFixed(2)}m cardWidth=${cardWidth.toFixed(3)}m`);
    // The chosen tile must actually clear the bar it was chosen for — this is
    // the whole point, not an incidental property of the lookup table above.
    const texelSize = (2 * radius) / tile;
    assert.ok(cardWidth / texelSize >= MIN_CARD_TEXELS - 1e-9, `${name}'s worst card must span >= ${MIN_CARD_TEXELS} texels at tile=${tile}`);
    // Per-species atlas memory: two RGBA8 (frames=4)^2-tile textures.
    const size = 4 * tile, bytes = size * size * 4 * 2;
    assert.ok(bytes < 16 * 1024 * 1024, `${name}'s atlas must stay under the 16MB/species budget (was ${(bytes / 1e6).toFixed(2)}MB)`);
    geometry.dispose();
  });
}

test("impostor tile choice: birch always lands at 128px or above", () => {
  for (const name of ["birch-tall", "young-growth"]) {
    const geometry = createFoliagePrototype(VALLEY_GROUPS[name], 0);
    const radius = boundsRadius(geometry);
    const cardWidth = geometry.userData.foliage.tree.leafCardMinWidthMeters;
    // The foliage runtime's own call (`FoliageComponent.js#acquireAtlas`, `minTile: 128`).
    const tile = chooseImpostorTile({ cardWidth, radius, minTile: 128 });
    geometry.dispose();
    assert.ok(tile >= 128, `${name} must clear the old fixed 64px default (got ${tile})`);
  }
});

test("chooseImpostorTile: pure boundary behaviour", () => {
  // Comfortably resolved at the smallest tile already.
  assert.equal(chooseImpostorTile({ cardWidth: 1, radius: 1 }), IMPOSTOR_TILE_SIZES[0]);
  // `needed = MIN_CARD_TEXELS * 2 * radius / cardWidth` landing EXACTLY on a
  // tile boundary must still accept that tile (`>=`, not `>`).
  for (const size of IMPOSTOR_TILE_SIZES) {
    const radius = size / (MIN_CARD_TEXELS * 2); // cardWidth = 1 => needed === size
    assert.equal(chooseImpostorTile({ cardWidth: 1, radius }), size, `needed lands exactly on ${size}px`);
  }
  // Needs more than every available tile: capped at the largest, never thrown.
  assert.equal(chooseImpostorTile({ cardWidth: 1e-4, radius: 1000 }), IMPOSTOR_TILE_SIZES.at(-1));
  // Unknown inputs (grass/wildflowers carry no leaf-card metadata) fall back
  // to the ordinary default rather than crashing or picking an arbitrary tile.
  assert.equal(chooseImpostorTile({}), IMPOSTOR_BAKE_DEFAULTS.tile);
  assert.equal(chooseImpostorTile({ cardWidth: 0, radius: 5 }), IMPOSTOR_BAKE_DEFAULTS.tile);
  assert.equal(chooseImpostorTile({ cardWidth: 1, radius: 0 }), IMPOSTOR_BAKE_DEFAULTS.tile);
  assert.equal(chooseImpostorTile(), IMPOSTOR_BAKE_DEFAULTS.tile);
});

// ── The stepped GPU bake (09-13): never a synchronous pixel readback, and ──
// never more than `MAX_VIEWS_PER_STEP` octahedral views rendered in one turn.

/** A source cheap enough to bake in a Node test in milliseconds — a real
 * `THREE.Mesh` with real geometry (so `boundsOf`/`Box3.setFromObject` have
 * something to measure), an ordinary (non-node) material so `withAlphaTest`/
 * `createNormalMaterial` exercise their fallback paths, exactly like a prop
 * that never had a shader-graph material to begin with. */
function fakeBakeSource() {
  return new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff }));
}

/**
 * A renderer double narrow enough to prove two things without a real GPU:
 * (1) nothing in the bake path ever calls the SYNCHRONOUS
 * `readRenderTargetPixels` — the exact call the boot receipt blamed for
 * stalling the main thread while the GPU queue was full of shader compiles —
 * and (2) `readRenderTargetPixelsAsync`, if it were ever called, would be
 * awaited rather than assumed instant. Every renderer method the bake path
 * touches is implemented; none of them do real GPU work.
 */
function fakeBakeRenderer() {
  const calls = { render: 0, readSync: 0, readAsync: 0, scissorTest: [] };
  let currentTarget = null;
  const renderer = {
    calls,
    toneMapping: "sentinel-tone-mapping",
    autoClear: true,
    getRenderTarget() { return currentTarget; },
    setRenderTarget(target) { currentTarget = target ?? null; },
    getClearColor(target) { return target.setRGB(0, 0, 0); },
    getClearAlpha() { return 1; },
    setClearColor() {},
    clear() {},
    setScissorTest(value) { calls.scissorTest.push(value); },
    render() { calls.render++; },
    // Present but must never be reached by the main bake path.
    readRenderTargetPixels() { calls.readSync++; return new Uint8Array(4); },
    async readRenderTargetPixelsAsync() { calls.readAsync++; return new Uint8Array(4); },
  };
  return renderer;
}

/** Drives a job to completion, recording how many views each `step()` call
 * (before the finishing one) actually rendered — the direct check that
 * `MAX_VIEWS_PER_STEP` is a real cap, not just a constant nobody reads. */
async function drainJob(job, renderer) {
  const viewsPerStep = [];
  let result = { done: false };
  while (!result.done) {
    const before = renderer.calls.render;
    result = await job.step();
    viewsPerStep.push(renderer.calls.render - before);
  }
  return { atlas: result.atlas, viewsPerStep };
}

test("⭐ bake materials outlive the job: re-baking one source mints no new materials", async () => {
  // 09-14, Complex scene: per-job alpha-test clones and normal-pass materials
  // gave every bake new pipelines (`Foliage · surface` / `Impostor normal`
  // ids 211 → 261 through minutes of GPU-process stalls).
  const source = fakeBakeSource();
  const runs = [];
  for (let run = 0; run < 2; run++) {
    const renderer = fakeBakeRenderer();
    const materials = new Set();
    renderer.render = (scene) => {
      renderer.calls.render++;
      scene?.traverse?.(object => { if (object.isMesh && object.material) materials.add(object.material); });
    };
    const { atlas } = await drainJob(createImpostorBakeJob(renderer, source, { frames: 2, tile: 16, alphaTest: .25 }), renderer);
    atlas.dispose();
    runs.push(materials);
  }
  assert.ok(runs[0].size >= 2, "the fixture must see the bake's own materials");
  for (const material of runs[1]) assert.ok(runs[0].has(material), `${material.name || material.type} was minted again by the second bake`);
  assert.equal(impostorBakeMaterialCount(source.material), 1, "one alpha-test clone per (source, threshold)");
  const clone = [...runs[0]].find(material => material.alphaTest === .25 && material.name !== "Impostor normal");
  assert.ok(clone, "the albedo pass draws through the alpha-test clone");
  assert.equal(impostorBakeMaterialCount(clone), 1, "one normal-pass material per clone");
  let cloneDisposed = false;
  clone.addEventListener("dispose", () => { cloneDisposed = true; });
  source.material.dispose();
  assert.equal(impostorBakeMaterialCount(source.material), 0, "disposing the source releases its bake materials");
  assert.equal(cloneDisposed, true);
});

test("createImpostorBakeJob: exposes a step generator (view count / steps)", () => {
  const renderer = fakeBakeRenderer();
  const job = createImpostorBakeJob(renderer, fakeBakeSource(), { frames: 2, tile: 16 });
  // frames=2 => 4 tiles per pass, albedo + normal => 8 views total.
  assert.equal(job.viewCount, 8);
  assert.equal(typeof job.step, "function");
  assert.equal(typeof job.cancel, "function");
  // Render steps (8 views / 4 per step = 2) plus one finishing step.
  assert.equal(job.stepCount, Math.ceil(8 / MAX_VIEWS_PER_STEP) + 1);
  job.cancel();
});

test("createImpostorBakeJob: never a sync readback; renders at most MAX_VIEWS_PER_STEP views per step", async () => {
  const renderer = fakeBakeRenderer();
  const job = createImpostorBakeJob(renderer, fakeBakeSource(), { frames: 2, tile: 16, alphaTest: .25 });
  const { atlas, viewsPerStep } = await drainJob(job, renderer);

  assert.equal(renderer.calls.readSync, 0, "readRenderTargetPixels (sync) must never be called");
  // readRenderTargetPixelsAsync is allowed but not required — this bake never
  // needs it, since the atlas is sampled straight off its render target.
  assert.ok(renderer.calls.readAsync >= 0);

  // Every render-only step (all but the last, which does the GPU blits)
  // stayed within the per-step view cap.
  const renderSteps = viewsPerStep.slice(0, -1);
  assert.ok(renderSteps.length >= 1, "the job took at least one render step");
  for (const count of renderSteps) assert.ok(count > 0 && count <= MAX_VIEWS_PER_STEP, `step rendered ${count} views, cap is ${MAX_VIEWS_PER_STEP}`);
  assert.equal(renderSteps.reduce((a, b) => a + b, 0), 8, "all 8 views were rendered across the steps");
  // The finishing step's `renderer.render()` calls are the four GPU blit
  // passes (downsample × 2, dilate × 2) — quad draws, not gated by
  // `MAX_VIEWS_PER_STEP` (that cap is about octahedral TILE views only).
  assert.equal(viewsPerStep.at(-1), 4);

  assert.ok(atlas, "the job resolves an atlas");
  assert.ok(atlas.albedo?.isTexture, "atlas.albedo is a real texture the impostor material can sample directly");
  assert.ok(atlas.normal?.isTexture, "atlas.normal is a real texture the impostor material can sample directly");
  assert.equal(atlas.size, 2 * 16);
  assert.equal(atlas.frames, 2);
  atlas.dispose();
});

test("createImpostorBakeJob: never leaves the renderer's shared state borrowed across a yield", async () => {
  const renderer = fakeBakeRenderer();
  const job = createImpostorBakeJob(renderer, fakeBakeSource(), { frames: 2, tile: 16 });
  // A step that renders views must give the renderer back exactly as it found
  // it: a bake spans many real animation frames now, and every frame in
  // between belongs to the engine's own ordinary draws sharing this renderer.
  const result = await job.step();
  assert.equal(result.done, false);
  assert.equal(renderer.toneMapping, "sentinel-tone-mapping", "tone mapping must not leak past a single step");
  assert.equal(renderer.autoClear, true, "autoClear must not stay false between steps");
  assert.equal(renderer.calls.scissorTest.at(-1), false, "the scissor test must be switched back off before yielding");
  job.cancel();
});

test("createImpostorBakeJob: cancel() disposes without throwing before completion", () => {
  const renderer = fakeBakeRenderer();
  const job = createImpostorBakeJob(renderer, fakeBakeSource(), { frames: 2, tile: 16 });
  assert.doesNotThrow(() => job.cancel());
  assert.doesNotThrow(() => job.cancel(), "cancel is safe to call twice");
});

// ── Dark-blob triage (09-13): the four invariants the bug report asked for ──

test("downsample/dilate quads output straight, non-premultiplied alpha", () => {
  // The exact regression this codebase already hit once (owner receipt
  // 09-13, see the comments beside these two materials): an opaque
  // NodeMaterial forces its fragment alpha to 1, which turns every
  // partially-covered atlas texel fully opaque and draws the impostor as a
  // dark/black rectangle — a "slab", not a tree. `transparent: true` +
  // `NoBlending` + `premultipliedAlpha: false` is what keeps the computed
  // straight alpha intact instead.
  const downsample = ensureDownsampleQuad(THREE.SRGBColorSpace, 2).material;
  const dilate = ensureDilateQuad(THREE.SRGBColorSpace).material;
  for (const material of [downsample, dilate]) {
    assert.equal(material.transparent, true, `${material.name}: must be transparent to keep computed alpha`);
    assert.equal(material.blending, THREE.NoBlending, `${material.name}: NoBlending writes alpha as-is`);
    assert.equal(material.premultipliedAlpha, false, `${material.name}: output alpha must be straight, not premultiplied`);
  }
});

test("downsample quad rebuilds its sample loop for the ACTUAL runtime supersample factor", () => {
  // A quad cached for a smaller `supersample` than the job actually used
  // reads `dst * supersample` texels past the real (1x) source's edge,
  // which `ClampToEdgeWrapping` turns into a smear of empty border pixels —
  // a bake that comes back empty/dark for a large atlas with no visible
  // cause. Different `supersample` values must not collide on one cached
  // material.
  const a = ensureDownsampleQuad(THREE.NoColorSpace, 1);
  const b = ensureDownsampleQuad(THREE.NoColorSpace, 2);
  assert.notEqual(a.material, b.material, "supersample=1 and supersample=2 must not share a cached quad");
});

test("dilate pass tile layout: OPEN-grid tile origins (col*tile) agree with octahedral.js#tileOrigin", () => {
  // `impostorBake.js`'s dilate shader computes each pixel's own tile origin
  // as `floor(px / tileSize) * tileSize` against a `size = frames * tile`
  // atlas — the OPEN grid `octahedral.js#tileOrigin` documents (as opposed
  // to the CLOSED grid `frameUv`/`frameDirection` use for the DIRECTION a
  // tile was baked from). The two must describe the SAME square in the
  // atlas, or a fragment's neighbour-search wanders into a neighbouring
  // view's content — a corrupted, jumbled silhouette rather than a clean one.
  for (const frames of [2, 4, 8]) {
    for (const tile of [64, 128, 256]) {
      const size = frames * tile;
      for (let row = 0; row < frames; row++) {
        for (let col = 0; col < frames; col++) {
          const [u, v] = tileOrigin(col, row, frames);
          const originX = Math.round(u * size), originY = Math.round(v * size);
          assert.equal(originX, col * tile, `frames=${frames} tile=${tile} col=${col}: x origin`);
          assert.equal(originY, row * tile, `frames=${frames} tile=${tile} row=${row}: y origin`);
          // Every pixel actually inside this tile must floor-divide back to
          // this exact origin — the identity the dilate shader relies on.
          for (const px of [originX, originX + tile - 1]) {
            assert.equal(Math.floor(px / tile) * tile, originX, `x=${px} must floor back into tile col=${col}`);
          }
        }
      }
    }
  }
});

test("bake camera basis per view matches octahedral.js#frameBasis exactly", () => {
  // `aimFrameCamera` hands the camera `frameBasis(direction).reference` as
  // `camera.up` specifically so `lookAt`'s own basis construction reproduces
  // `frameBasis` bit-for-bit — the shader (`impostorMaterial.js`'s
  // `frameBasisNode`) reconstructs the SAME basis independently, with no way
  // to know about a mismatch. A camera whose right/up axes disagree with the
  // shader's own reconstruction bakes a view the runtime samples sideways or
  // upside down — a jumbled, unrecognisable silhouette.
  const camera = new THREE.OrthographicCamera();
  const center = new THREE.Vector3(1.5, 2.5, -3.5); // an off-origin centre, so this also proves translation-independence
  const radius = 4;
  for (const hemisphere of [true, false]) {
    for (let frames = 2; frames <= 5; frames++) {
      for (let row = 0; row < frames; row++) {
        for (let col = 0; col < frames; col++) {
          const direction = frameDirection(col, row, frames, hemisphere);
          aimFrameCamera(camera, direction, center, radius);
          const basis = frameBasis(direction);
          const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
          const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
          const forward = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 2);
          const label = `hemisphere=${hemisphere} frames=${frames} col=${col} row=${row}`;
          assert.ok(right.distanceTo(new THREE.Vector3(...basis.right)) < 1e-5, `${label}: right axis`);
          assert.ok(up.distanceTo(new THREE.Vector3(...basis.up)) < 1e-5, `${label}: up axis`);
          // The camera's local +Z is `direction` itself — `THREE.Object3D.lookAt`'s
          // convention `octahedral.js`'s own file comment documents.
          assert.ok(forward.distanceTo(new THREE.Vector3(...direction)) < 1e-5, `${label}: forward (+Z) axis is the bake direction`);
        }
      }
    }
  }
});

test("finished atlas: albedo/normal targets keep the colour spaces the material expects", () => {
  // `impostorMaterial.js` samples `atlas.albedo`/`atlas.normal` with an
  // ordinary `texture()` node, which decodes from whatever `colorSpace` the
  // texture itself declares. Albedo must round-trip through sRGB bytes
  // (`createFoliageSurfaceMaterial`'s output is linear-lit colour); the
  // normal atlas must never be colour-managed at all, or a decode meant for
  // colour silently distorts a direction vector.
  const renderer = fakeBakeRenderer();
  const job = createImpostorBakeJob(renderer, fakeBakeSource(), { frames: 2, tile: 16 });
  const drain = async () => {
    let result = { done: false };
    while (!result.done) result = await job.step();
    return result.atlas;
  };
  return drain().then((atlas) => {
    assert.equal(atlas.albedo.colorSpace, THREE.SRGBColorSpace, "albedo atlas must be sRGB-tagged");
    assert.equal(atlas.normal.colorSpace, THREE.NoColorSpace, "normal atlas must carry no colour-space conversion");
    atlas.dispose();
  });
});
