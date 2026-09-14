import * as THREE from "three/webgpu";
import { Fn, float, floor, max, normalWorld, screenCoordinate, select, step, texture, uniform, vec2, vec3, vec4 } from "three/tsl";
import { frameBasis, frameDirection } from "./octahedral.js";
import { readRenderTargetImage, imageDataToDataUrl } from "../renderTargetImage.js";
import { freeze } from "../freezeLedger.js";

/**
 * Baking an octahedral impostor atlas (roadmap item 14).
 *
 * An impostor is the last LOD level of a prop: past the distance where even a
 * few hundred triangles are more than the silhouette deserves, the object is
 * replaced by ONE camera-facing quad showing a pre-rendered view of it. That is
 * what makes a forest possible — a tree at 200 m costs two triangles and one
 * texture fetch, and five hundred of them batch into a single draw.
 *
 * ## What is in the atlas, and why two of them
 *
 * Each cell holds one view of the object from one octahedral direction:
 *
 *   - **albedo + coverage** — the object's colour, and alpha as the silhouette
 *     mask (an alpha-tested quad, so a tree reads as a tree rather than as a
 *     rectangle),
 *   - **normal** — the surface normal in the object's own space.
 *
 * The normal atlas is what makes the impostor a lit surface rather than a
 * sticker. Baking the LIT appearance instead would be simpler and is wrong in a
 * way that only shows up later: the lighting is frozen at bake time, so the
 * impostor keeps its noon shading at dusk, ignores the shadow it is standing
 * in, and — worst — is lit differently from the LOD level it replaces, so the
 * switch that was supposed to be invisible becomes a brightness pop.
 *
 * ## The neutral bake environment
 *
 * To capture something close to albedo out of arbitrary materials (which may be
 * shader graphs — there is no `material.color` to read), the bake renders the
 * object in its own scene lit by a single white ambient light and nothing else.
 * Three's ambient light supplies irradiance; Lambert diffuse divides that by
 * PI. A unit neutral bake therefore needs PI irradiance to return albedo,
 * rather than baking another 1/PI darkening into the final lit surface. A
 * metal or a mirror returns something darker, which is
 * the accepted cost of not owning every material's shading model. Tone mapping
 * is switched off for the same reason — a tone-mapped bake would be tone-mapped
 * a second time when the impostor is drawn.
 *
 * ## The atlas is a render target, sampled directly — nothing comes back to
 * ## the CPU (09-13 rebuild)
 *
 * An earlier version read the supersampled render back with
 * `readRenderTargetPixelsAsync`, box-filtered and edge-dilated it in JS, and
 * built a `DataTexture` from the result. Even though the readback itself was
 * already async, the CPU work around it — `frames²` synchronous tile renders,
 * then two full passes over `SUPERSAMPLE²` as many pixels as the final atlas —
 * ran as one uninterrupted main-thread task per species, tens of milliseconds
 * to low tens of SECONDS on a boot frame already busy compiling shaders (a
 * bake competing with the World's own generation for the same frame slices —
 * see `FoliageComponent.js#_requestAtlas`'s ordering gate). Both problems are
 * gone the same way: the downsample and the edge dilation are GPU blits (two
 * `THREE.NodeMaterial` + `QuadMesh` passes, `runDownsamplePass`/
 * `runDilatePass` below — the same shape as `editor/frameCopy.js`'s own
 * downsample quad), and `createImpostorBakeJob` renders at most
 * `MAX_VIEWS_PER_STEP` octahedral views per `step()` call instead of all of
 * them in one synchronous sweep. `atlas.albedo`/`atlas.normal` are ordinary
 * render-target textures the impostor material samples like any other; a
 * caller that genuinely needs the bytes on the CPU (serialization, a future
 * on-disk atlas) should read them with `renderer.readRenderTargetPixelsAsync`
 * and await it — never the synchronous call, which blocks exactly the way
 * this rebuild exists to stop.
 */

/** Ceiling on the atlas edge, in texels. Beyond this, tiles shrink instead. */
const MAX_ATLAS_SIZE = 4096;

export const IMPOSTOR_BAKE_DEFAULTS = {
  /** Views per octahedral axis. 8 → 64 frames, ~15° apart. */
  frames: 8,
  /** Edge of one view, in texels. */
  tile: 128,
  /** Upper hemisphere only — right for anything standing on the ground. */
  hemisphere: true,
  /** Neutral albedo gain; 1 supplies PI irradiance to cancel Lambert's 1/PI. */
  ambient: 1,
  /** `null`: bake each surface at its OWN native `alphaTest` (the previous,
   *  only behaviour) — a caller opts into a bake-time OVERRIDE by passing a
   *  number here instead. Foliage does (`FoliageComponent.js`, `0.25`): a card
   *  thinner than a texel needs its partial subsamples to survive the render
   *  so `SUPERSAMPLE` below has fractional coverage left to average, and the
   *  live surface material's own `alphaTest` (0.5 — see `foliageMaterial.js`)
   *  would discard exactly the samples supersampling exists to keep. Left
   *  `null` by default so `ImpostorSystem.js`'s generic prop bake — which
   *  already ties its bake and runtime thresholds together through this same
   *  option — is unaffected by this file gaining the capability. */
  alphaTest: null,
};

/**
 * A texel must resolve the smallest card a species will ever place, or that
 * card's coverage is a coin flip between "sampled" and "gone" depending on
 * where its silhouette happens to fall relative to a texel centre. This is
 * the number of texels the SHORT side of that worst-case card must span.
 */
export const MIN_CARD_TEXELS = 2.5;

/** Tile sizes `chooseImpostorTile` picks from — 4×4 views (`frames: 4`,
 *  `FoliageComponent.js`) at each. Capped at 256: past it a single species'
 *  atlas (frames² tiles, two RGBA8 textures) starts pushing on the 16 MB
 *  per-species memory budget — see the memory comment on `bakeImpostorAtlas`. */
export const IMPOSTOR_TILE_SIZES = [64, 128, 256];

/**
 * Smallest tile from `IMPOSTOR_TILE_SIZES` whose texel covers `cardWidth`
 * (metres, the worst-case card an atlas will ever place — see
 * `foliageGeometry.js`'s `leafCardMinWidthMeters`) at least `MIN_CARD_TEXELS`
 * times. `radius` is the same bake-sphere radius `boundsOf` computes: every
 * tile, whatever its resolution, spans exactly `2 * radius` metres, so the
 * texel size at a given tile is `(2 * radius) / tile` regardless of species.
 * Falls back to the ordinary default when either input is unknown (grass and
 * wildflowers carry no `leafCardMinWidthMeters` — their cards are already
 * whole-plant-sized, not a twig's worth of leaves, so the default tile has
 * never been the problem for them).
 */
export function chooseImpostorTile({ cardWidth, radius, minTile = 0 } = {}) {
  if (!(cardWidth > 0) || !(radius > 0)) return Math.max(minTile, IMPOSTOR_BAKE_DEFAULTS.tile);
  // `minTile`: a caller's screen-resolution floor on top of the card rule.
  const needed = Math.max(minTile, (MIN_CARD_TEXELS * 2 * radius) / cardWidth);
  for (const size of IMPOSTOR_TILE_SIZES) if (size >= needed) return size;
  return IMPOSTOR_TILE_SIZES[IMPOSTOR_TILE_SIZES.length - 1];
}

/** Every final texel is the box-filtered average of a SUPERSAMPLE×SUPERSAMPLE
 *  grid of alpha-tested samples — see `runDownsamplePass` below. */
const SUPERSAMPLE = 2;

/** Octahedral views `createImpostorBakeJob#step` renders before yielding.
 *  Four small orthographic draws is comfortably under a frame's budget even
 *  mid shader-compile-wave; the cost that actually froze a boot frame was the
 *  CPU work the OLD version did between draws (see the file-level comment),
 *  which the GPU downsample/dilate passes replace entirely — this cap exists
 *  so a bake also never queues more than a handful of NEW draws (and, on a
 *  cold pipeline, compiles) in one synchronous turn. */
export const MAX_VIEWS_PER_STEP = 4;

/**
 * Objects an impostor cannot represent, skipped with the subtree they head.
 *
 * A skinned mesh's buffer holds the BIND pose, so baking one produces a
 * T-posed copy of the character — the same reason decals skip them (item 13).
 * Anything the impostor system itself made is skipped so re-baking a chain that
 * already has an impostor level does not bake the billboard into the billboard.
 */
function bakeable(object) {
  if (object.isSkinnedMesh) return false;
  if (object.userData?.impostorQuad) return false;
  if (object.userData?.batchProxy) return false;
  return true;
}

/**
 * A copy of `source` with everything unbakeable pruned, keeping its own local
 * transform so the atlas is expressed in the source's PARENT space — which is
 * the space the impostor entity, a sibling under the same LOD group, lives in.
 */
function buildBakeRoot(source) {
  const clone = source.clone(true);
  const drop = [];
  clone.traverse((object) => {
    if (!bakeable(object)) drop.push(object);
  });
  for (const object of drop) object.parent?.remove(object);
  // Lights and cameras inside the source would light the bake scene from
  // inside the object, which is not what a neutral capture means.
  const extra = [];
  clone.traverse((object) => {
    if (object.isLight || object.isCamera) extra.push(object);
  });
  for (const object of extra) object.parent?.remove(object);
  // The source is USUALLY hidden at the moment it is baked — an impostor is the
  // last level of an LOD chain, so the frame where the impostor is asked for is
  // exactly the frame the mesh levels are switched off. `clone()` copies
  // `visible`, so without this the bake renders an empty atlas and the impostor
  // is a transparent quad: a feature that silently does nothing, which is the
  // worst way for it to fail.
  clone.traverse((object) => {
    object.visible = true;
  });
  return clone;
}

/** True when anything under `root` can actually be drawn. */
function hasGeometry(root) {
  let found = false;
  root.traverse((object) => {
    if (object.isMesh || object.isInstancedMesh) found = true;
  });
  return found;
}

/**
 * The sphere the billboard has to cover. Derived from the world-space box
 * rather than from the union of mesh spheres because the box is what an
 * orthographic bake camera frames, and the two must agree exactly or the object
 * is clipped by its own atlas cell.
 */
function boundsOf(root) {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  if (box.isEmpty()) return null;
  const center = box.getCenter(new THREE.Vector3());
  const radius = box.getSize(new THREE.Vector3()).length() * 0.5;
  return { center, radius: radius > 0 ? radius : 1e-3 };
}

/**
 * A clone of `material` with `alphaTest` forced to `value`, for the bake's
 * looser coverage threshold (`IMPOSTOR_BAKE_DEFAULTS.alphaTest`).
 *
 * The bake root's meshes start out sharing the SAME material instances as the
 * live LOD0/LOD1 draws (`FoliageComponent.js#acquireAtlas` builds the source
 * mesh directly from the cached, shared surface material) — mutating
 * `alphaTest` in place would change what every other tree of this species
 * renders at while the bake is in flight. `.clone()` on these NodeMaterials
 * is already known not to carry `alphaTest` across (see
 * `FoliageComponent.js#_buildImpostors`'s own re-assignment after `.clone()`),
 * which costs nothing here since the whole point is to override it anyway.
 */
function withAlphaTest(material, value) {
  const clone = material.clone();
  clone.alphaTest = value;
  return clone;
}

/** One normal pass material per source surface, with the same visible pixels. */
function createNormalMaterial(source) {
  const material = new THREE.MeshBasicNodeMaterial();
  material.name = "Impostor normal";
  // Same trap the GI gbuffer hit: MeshBasicNodeMaterial ships with
  // `lights = true`, so an override that shades nothing still builds the whole
  // scene lighting node — including any module's screen-space lighting, whose
  // textures this pass has no business binding.
  material.lights = false;
  // Foliage is modelled as single-sided cards seen from both sides; rendering
  // the normal pass front-side-only would leave holes exactly where the albedo
  // pass has coverage, and a hole in a normal atlas is a black leaf.
  material.side = source.side ?? THREE.DoubleSide;
  material.positionNode = source.positionNode ?? null;
  material.opacity = source.opacity ?? 1;
  material.opacityNode = source.opacityNode ?? null;
  material.alphaMap = source.alphaMap ?? null;
  material.alphaTest = source.alphaTest ?? 0;
  material.alphaTestNode = source.alphaTestNode ?? null;
  material.maskNode = source.maskNode ?? null;
  material.normalNode = source.normalNode ?? null;
  material.normalMap = source.normalMap ?? null;
  material.normalMapType = source.normalMapType ?? THREE.TangentSpaceNormalMap;
  material.normalScale = source.normalScale?.clone() ?? new THREE.Vector2(1, 1);
  // MeshBasic's own setupNormal ignores normalNode and normalMap.
  material.setupNormal = THREE.NodeMaterial.prototype.setupNormal;
  const colorAlpha = source.colorNode ? vec4(source.colorNode).a : source.map ? texture(source.map).a : float(1);
  // normalWorld already includes Three's DoubleSide back-face correction.
  // Undoing it would point the rear view's normals away from its visible face:
  // the same grass card would be lit nearby and completely black as an impostor.
  material.colorNode = vec4(normalWorld.mul(0.5).add(0.5), colorAlpha);
  return material;
}

/**
 * Positions `camera` for one octahedral frame.
 *
 * The camera's `up` is the SAME reference vector `frameBasis` uses, which is
 * what makes the shader's reconstruction of this basis exact. Left to its own
 * devices, `lookAt` nudges the matrix by an epsilon when the view direction is
 * parallel to `up` (straight down at a prop from directly above — a frame every
 * hemispherical atlas contains), and the shader has no way to know which way it
 * was nudged.
 */
// Exported (also) for `foliage-impostor-bake.test.mjs`: a pure geometric
// function, cheap to call directly to assert the bake camera's basis agrees
// with `octahedral.js#frameBasis`/`impostorMaterial.js#frameBasisNode` for
// every view a real bake will ever render — the one thing a fake-renderer
// unit test CAN check without a GPU, since nothing here touches the renderer.
export function aimFrameCamera(camera, direction, center, radius) {
  const basis = frameBasis(direction);
  camera.up.set(basis.reference[0], basis.reference[1], basis.reference[2]);
  camera.position.set(
    center.x + direction[0] * radius * 2,
    center.y + direction[1] * radius * 2,
    center.z + direction[2] * radius * 2,
  );
  camera.lookAt(center);
  camera.left = -radius;
  camera.right = radius;
  camera.top = radius;
  camera.bottom = -radius;
  // The near plane sits at the sphere's near side and the far plane past its
  // far side: an ortho frustum tight to the sphere, so depth precision is spent
  // entirely on the object.
  camera.near = radius;
  camera.far = radius * 3;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
}

/** Renders one octahedral view into its tile of `target`. The caller owns
 *  clearing the target once and enabling the scissor before the first view of
 *  a pass (`beginPass` below) — a per-tile clear would wipe the tiles already
 *  drawn, because a render pass clears the whole attachment regardless of the
 *  viewport; the scissor is what keeps a view inside its own cell, since a
 *  viewport transforms but does not clip. */
function renderOneView(renderer, scene, camera, target, tile, col, row, center, radius, frames, hemisphere) {
  aimFrameCamera(camera, frameDirection(col, row, frames, hemisphere), center, radius);
  target.viewport.set(col * tile, row * tile, tile, tile);
  target.scissor.set(col * tile, row * tile, tile, tile);
  renderer.render(scene, camera);
}

/**
 * ── GPU DOWNSAMPLE + EDGE DILATION ─────────────────────────────────────────
 *
 * Two ordinary fullscreen blits — the same shape as `editor/frameCopy.js`'s
 * own downsample quad and `engine/vfx/gpuMipmaps.js`'s mip blitter — replace
 * the JS `downsampleAtlas`/`padAtlasEdges` this file used to run on the CPU.
 * Each is a `THREE.NodeMaterial` (no lighting pipeline to opt out of, unlike
 * `MeshBasicNodeMaterial` — see `createNormalMaterial`'s comment on that trap)
 * rendered by a shared `QuadMesh`, built ONCE per colour space and reused for
 * every bake by reassigning a `texture()` node's `.value` — the exact trick
 * `frameCopy.js` uses for its own resized frame texture.
 *
 * `colorNode`, not `fragmentNode`: sampling a texture always decodes it from
 * its own `colorSpace` into the working (linear) space first — that is
 * `TextureNode`'s job, unconditional on which node consumes it — and
 * `colorNode` (unlike `fragmentNode`, which exists specifically to skip this —
 * see `frameCopy.js`) keeps the matching OUTPUT transform, re-encoding the
 * filtered linear result back into whatever `colorSpace` the destination
 * target declares. So the albedo chain (`SRGBColorSpace` throughout) filters
 * in linear light and stores sRGB bytes, the normal chain
 * (`NoColorSpace` throughout) never converts anything, and neither pass
 * contains a line of manual gamma math. A material built against one colour
 * space must only ever be fed textures tagged with that SAME colour space
 * (the conversion is fixed when the shader is first generated) — hence one
 * cached quad per colour space below, never one shared across both chains.
 */
const downsampleQuads = new Map();
/**
 * `supersample` MUST be the caller's actual runtime factor, not the module
 * constant `SUPERSAMPLE` — `createImpostorBakeJob` caps its own `supersample`
 * below `SUPERSAMPLE` whenever `MAX_ATLAS_SIZE` would otherwise be exceeded
 * (a large `frames`×`tile` atlas). A shader built with the CONSTANT unrolled
 * into its sample loop, fed a source texture that is only 1× oversampled,
 * reads `dst * SUPERSAMPLE` — texel coordinates up to `SUPERSAMPLE`× past the
 * real source's edge — which `ClampToEdgeWrapping` turns into a smear of the
 * source's own border pixel (background, alpha 0) rather than the tile's
 * actual content: exactly a bake that comes back dark/empty for no visible
 * reason on a species big enough to trip the cap. Keying the cache by
 * `supersample` too (not just `colorSpace`) gives every distinct factor its
 * own correctly-unrolled loop.
 */
// Exported for `foliage-impostor-bake.test.mjs` to assert the straight-alpha
// blend fix (`transparent`/`blending`/`premultipliedAlpha`) without a GPU —
// building the material needs no renderer, only three's TSL graph builder.
export function ensureDownsampleQuad(colorSpace, supersample) {
  const key = `${colorSpace}:${supersample}`;
  let entry = downsampleQuads.get(key);
  if (entry) return entry;
  const placeholder = new THREE.Texture();
  placeholder.colorSpace = colorSpace;
  const source = texture(placeholder);
  const sourceSize = uniform(new THREE.Vector2(1, 1));
  // Pure expression tree, no `toVar`/`addAssign`: those imperative constructs need a
  // builder stack and an eagerly evaluated `Fn(...)()` at construction time has none
  // ("THREE.TSL: No stack defined for assign operation", owner receipt 09-13).
  const dst = floor(screenCoordinate.xy);
  const base = dst.mul(supersample);
  let colorSum = null, alphaSum = null;
  // `supersample` is a fixed JS number for this cached entry, so this is still
  // unrolled at graph-build time — just against the REAL factor this entry
  // was built for, rather than the module ceiling.
  for (let dy = 0; dy < supersample; dy++) {
    for (let dx = 0; dx < supersample; dx++) {
      const suv = base.add(vec2(dx + 0.5, dy + 0.5)).div(sourceSize);
      const s = source.sample(suv);
      const term = s.rgb.mul(s.a);
      colorSum = colorSum ? colorSum.add(term) : term;
      alphaSum = alphaSum ? alphaSum.add(s.a) : s.a;
    }
  }
  const colorNode = vec4(colorSum.div(max(alphaSum, 1e-6)), alphaSum.div(supersample * supersample));
  const material = new THREE.NodeMaterial();
  material.name = `impostorBake:downsample:${key}`;
  material.depthTest = false;
  material.depthWrite = false;
  material.fog = false;
  // An opaque NodeMaterial forces the fragment alpha to 1 (NodeMaterial.setupDiffuseColor),
  // which turned every atlas texel opaque and drew impostors as black rectangles (owner
  // receipt 09-13). `transparent` keeps the computed alpha; `NoBlending` writes it as-is.
  material.transparent = true;
  material.blending = THREE.NoBlending;
  material.premultipliedAlpha = false;
  material.colorNode = colorNode;
  entry = { quad: new THREE.QuadMesh(material), material, source, sourceSize };
  downsampleQuads.set(key, entry);
  return entry;
}

/** GPU blit: `sourceTexture` (a `sourceSize`×`sourceSize`, `supersample`-times
 *  oversampled render) box-filtered down into `destTarget`, alpha-weighted
 *  exactly like the old `downsampleAtlas` — see the section comment above for
 *  why colour space conversion needs no code here at all. `supersample` MUST
 *  be the job's own runtime factor (see `ensureDownsampleQuad`'s comment). */
function runDownsamplePass(renderer, sourceTexture, sourceSize, destTarget, supersample) {
  const { quad, source, sourceSize: sourceSizeUniform } = ensureDownsampleQuad(destTarget.texture.colorSpace, supersample);
  source.value = sourceTexture;
  sourceSizeUniform.value.set(sourceSize, sourceSize);
  const previousTarget = renderer.getRenderTarget();
  const previousAutoClear = renderer.autoClear;
  try {
    renderer.setRenderTarget(destTarget);
    renderer.autoClear = true;
    quad.render(renderer);
  } finally {
    renderer.setRenderTarget(previousTarget);
    renderer.autoClear = previousAutoClear;
  }
}

const dilateQuads = new Map();
// Exported for the same test-only reason as `ensureDownsampleQuad` above.
export function ensureDilateQuad(colorSpace) {
  let entry = dilateQuads.get(colorSpace);
  if (entry) return entry;
  const placeholder = new THREE.Texture();
  placeholder.colorSpace = colorSpace;
  const source = texture(placeholder);
  const size = uniform(1);
  const tileSize = uniform(1);
  // Pure expression tree (see `ensureDownsampleQuad`).
  const px = floor(screenCoordinate.xy);
  const centerTexel = source.sample(px.add(0.5).div(size));
  const tileOrigin = floor(px.div(tileSize)).mul(tileSize);
  let colorSum = null, weight = null;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const npx = px.add(vec2(dx, dy));
      // Both the atlas edge AND the tile edge bound a valid neighbour — the
      // first keeps sampling on the texture, the second is what
      // `padAtlasEdges` used to enforce by hand ("work within each tile so
      // unrelated views never leak into one another").
      const inBounds = step(0, npx.x).mul(step(npx.x, size.sub(1)))
        .mul(step(0, npx.y)).mul(step(npx.y, size.sub(1)))
        .mul(step(tileOrigin.x, npx.x)).mul(step(npx.x, tileOrigin.x.add(tileSize).sub(1)))
        .mul(step(tileOrigin.y, npx.y)).mul(step(npx.y, tileOrigin.y.add(tileSize).sub(1)));
      const neighbor = source.sample(npx.add(0.5).div(size));
      const w = neighbor.a.mul(inBounds);
      const term = neighbor.rgb.mul(w);
      colorSum = colorSum ? colorSum.add(term) : term;
      weight = weight ? weight.add(w) : w;
    }
  }
  const filled = vec4(colorSum.div(max(weight, 1e-6)), centerTexel.a);
  // A texel that already has coverage keeps its own colour untouched; only
  // a fully transparent one borrows from covered neighbours — alpha itself
  // is never changed, exactly like `padAtlasEdges`.
  const colorNode = select(centerTexel.a.greaterThan(0), centerTexel, filled);
  const material = new THREE.NodeMaterial();
  material.name = `impostorBake:dilate:${colorSpace}`;
  material.depthTest = false;
  material.depthWrite = false;
  material.fog = false;
  // An opaque NodeMaterial forces the fragment alpha to 1 (NodeMaterial.setupDiffuseColor),
  // which turned every atlas texel opaque and drew impostors as black rectangles (owner
  // receipt 09-13). `transparent` keeps the computed alpha; `NoBlending` writes it as-is.
  material.transparent = true;
  material.blending = THREE.NoBlending;
  material.premultipliedAlpha = false;
  material.colorNode = colorNode;
  entry = { quad: new THREE.QuadMesh(material), material, source, size, tileSize };
  dilateQuads.set(colorSpace, entry);
  return entry;
}

/** GPU blit: extends colour into the fully-transparent one-texel border a
 *  bilinear footprint can touch, from covered neighbours within the SAME
 *  tile only — see `ensureDilateQuad`. */
function runDilatePass(renderer, sourceTexture, destSize, tile, destTarget) {
  const { quad, source, size, tileSize } = ensureDilateQuad(destTarget.texture.colorSpace);
  source.value = sourceTexture;
  size.value = destSize;
  tileSize.value = tile;
  const previousTarget = renderer.getRenderTarget();
  const previousAutoClear = renderer.autoClear;
  try {
    renderer.setRenderTarget(destTarget);
    renderer.autoClear = true;
    quad.render(renderer);
  } finally {
    renderer.setRenderTarget(previousTarget);
    renderer.autoClear = previousAutoClear;
  }
}

/** A `size`×`size` RGBA8 render target for the blit chain — an intermediate
 *  (Nearest, exact-texel-fetched by the dilate pass) or the truly final atlas
 *  (Linear, for the impostor material's own runtime blend). */
function createAtlasTarget(size, colorSpace, filter) {
  const target = new THREE.RenderTarget(size, size, {
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    minFilter: filter,
    magFilter: filter,
  });
  target.texture.colorSpace = colorSpace;
  // No mipmaps: a mip chain would blend across tile borders, so the far side
  // of one view would bleed into its neighbour. The impostor is small on
  // screen by definition, which is also why the aliasing that costs is
  // tolerable.
  target.texture.generateMipmaps = false;
  target.texture.wrapS = THREE.ClampToEdgeWrapping;
  target.texture.wrapT = THREE.ClampToEdgeWrapping;
  return target;
}

/**
 * A stepped octahedral bake: `step()` renders at most `MAX_VIEWS_PER_STEP`
 * views and returns `{ done: false }`, or — once every view is in — runs the
 * GPU downsample/dilate passes and returns `{ done: true, atlas }`. Driving it
 * is the caller's job: `bakeImpostorAtlas` below awaits a real animation frame
 * between steps for callers that only want the finished atlas
 * (`ImpostorSystem.js`); `FoliageComponent.js#acquireAtlas` drives it directly
 * so it can count how many frames its own bake actually spanned.
 *
 * Nothing here ever calls `readRenderTargetPixels[Async]` — every step is a
 * normal `renderer.render()`/`QuadMesh.render()` call, and the finished atlas
 * is sampled straight off its render target (see the file-level comment).
 */
/**
 * ⭐ BAKE MATERIALS OUTLIVE THE JOB (09-14, the Complex scene's post-open stall).
 *
 * The alpha-test clone and the normal-pass material were minted per JOB and
 * disposed when it finished. Each is its own NodeMaterial, so every bake —
 * including a re-bake of an atlas the foliage cache had just dropped —
 * compiled a fresh `Foliage · surface` and `Impostor normal` pipeline: their
 * ids climbed 211 → 261 through four minutes of 10-25 s GPU-process stalls.
 * They are cached on the SOURCE material instead, keyed by what shapes them
 * (the alpha threshold; the normal pass has one shape), rebuilt when the
 * source's `version` moves (an edited material must not bake through a stale
 * snapshot) and disposed with the source. `__impostorBakeReuseMaterials =
 * false` restores per-job materials.
 */
const sharedBakeMaterials = new WeakMap();

function sharedBakeMaterial(source, key, create) {
  let cache = sharedBakeMaterials.get(source);
  if (!cache) {
    const entries = cache = new Map();
    sharedBakeMaterials.set(source, entries);
    const release = () => {
      source.removeEventListener?.("dispose", release);
      if (sharedBakeMaterials.get(source) === entries) sharedBakeMaterials.delete(source);
      for (const entry of entries.values()) entry.material.dispose();
      entries.clear();
    };
    source.addEventListener?.("dispose", release);
  }
  let entry = cache.get(key);
  if (entry && entry.version !== source.version) { entry.material.dispose(); entry = null; }
  if (!entry) { entry = { version: source.version, material: create() }; cache.set(key, entry); }
  return entry.material;
}

/** Receipt for tests: how many bake materials `source` currently holds. */
export function impostorBakeMaterialCount(source) {
  return sharedBakeMaterials.get(source)?.size ?? 0;
}

export function createImpostorBakeJob(renderer, source, options = {}) {
  const settings = { ...IMPOSTOR_BAKE_DEFAULTS, ...options };
  const frames = Math.max(2, Math.min(16, Math.round(settings.frames)));
  const hemisphere = settings.hemisphere !== false;
  let tile = Math.max(16, Math.round(settings.tile));
  tile = Math.min(tile, Math.floor(MAX_ATLAS_SIZE / frames));
  const size = frames * tile;
  // The whole bake renders at SUPERSAMPLE× this resolution and is filtered
  // back down (`runDownsamplePass`) — the atlas itself, `tile`/`size`
  // included, stays exactly the resolution every caller already expects.
  // Capped so the INTERMEDIATE render target never exceeds `MAX_ATLAS_SIZE`
  // either — a caller already asking for a large final atlas (many frames, a
  // big tile) falls back toward ordinary single-sample rendering rather than
  // requesting a render target several times `MAX_ATLAS_SIZE` on a side.
  const supersample = Math.max(1, Math.min(SUPERSAMPLE, Math.floor(MAX_ATLAS_SIZE / size)));
  const ssTile = tile * supersample, ssSize = size * supersample;
  const bakeAlphaTest = Number.isFinite(settings.alphaTest) ? settings.alphaTest : null;

  if (!renderer) throw new Error("Impostor bake needs a renderer.");
  const root = buildBakeRoot(source);
  if (!hasGeometry(root)) throw new Error("Nothing to bake — the source has no meshes.");
  const bounds = boundsOf(root);
  if (!bounds) throw new Error("Nothing to bake — the source has no extent.");

  const scene = new THREE.Scene();
  scene.add(root);
  // The whole lighting environment of the bake: one white ambient, so what
  // comes out is (approximately) albedo rather than a frozen lighting solution.
  scene.add(new THREE.AmbientLight(0xffffff, Math.PI * settings.ambient));
  const camera = new THREE.OrthographicCamera();

  const ssTarget = new THREE.RenderTarget(ssSize, ssSize, {
    depthBuffer: true,
    stencilBuffer: false,
    generateMipmaps: false,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
  });
  ssTarget.texture.colorSpace = THREE.SRGBColorSpace;

  const ssNormalTarget = new THREE.RenderTarget(ssSize, ssSize, {
    depthBuffer: true,
    stencilBuffer: false,
    generateMipmaps: false,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
  });
  ssNormalTarget.texture.colorSpace = THREE.NoColorSpace;

  // Materials cloned for this bake only — see `withAlphaTest` and
  // `createNormalMaterial`'s file comments for why neither can mutate the
  // source's own (possibly shared, possibly live) material in place.
  const reuseMaterials = globalThis.__impostorBakeReuseMaterials !== false;
  const bakeMaterials = new Map();
  const albedoFor = sourceMaterial => {
    if (bakeAlphaTest == null) return sourceMaterial;
    if (reuseMaterials) return sharedBakeMaterial(sourceMaterial, `alpha:${bakeAlphaTest}`, () => withAlphaTest(sourceMaterial, bakeAlphaTest));
    let material = bakeMaterials.get(sourceMaterial);
    if (!material) { material = withAlphaTest(sourceMaterial, bakeAlphaTest); bakeMaterials.set(sourceMaterial, material); }
    return material;
  };
  const normalMaterials = new Map();
  const normalFor = sourceMaterial => {
    if (reuseMaterials) return sharedBakeMaterial(sourceMaterial, "normal", () => createNormalMaterial(sourceMaterial));
    let material = normalMaterials.get(sourceMaterial);
    if (!material) { material = createNormalMaterial(sourceMaterial); normalMaterials.set(sourceMaterial, material); }
    return material;
  };

  // Alpha-test overrides are a pure JS material swap on our OWN detached bake
  // root — no renderer involved — so it happens once, right here, rather than
  // needing to be sequenced around the per-step renderer borrow below. The
  // normal pass reads `object.material` right after ITS OWN swap (in
  // `renderViewBatch`), so `createNormalMaterial` sees the same overridden
  // threshold for free — the two passes must agree on which texels exist at
  // all, or a hole in one atlas but not the other lights a texel with no real
  // surface data.
  if (bakeAlphaTest != null) {
    root.traverse(object => {
      if (!object.isMesh || !object.material) return;
      object.material = Array.isArray(object.material) ? object.material.map(albedoFor) : albedoFor(object.material);
    });
  }

  // Every view this bake needs to render, albedo pass first (as before) then
  // the normal pass — a flat list so `step()` can slice `MAX_VIEWS_PER_STEP`
  // off the front regardless of where a pass boundary falls (odd `frames`
  // does not divide evenly by the step size).
  const views = [];
  for (let row = 0; row < frames; row++) for (let col = 0; col < frames; col++) views.push({ target: ssTarget, row, col });
  for (let row = 0; row < frames; row++) for (let col = 0; col < frames; col++) views.push({ target: ssNormalTarget, row, col });

  let cursor = 0;
  let finished = false;
  let materialsSwapped = false;
  const clearedTargets = new Set();

  function disposeBakeResources() {
    for (const material of normalMaterials.values()) material.dispose();
    for (const material of bakeMaterials.values()) material.dispose();
    ssTarget.dispose();
    ssNormalTarget.dispose();
    // The clone shares geometry and materials with the source — disposing
    // either here would take the real object's buffers with it.
    scene.clear();
  }

  /**
   * Renders up to `MAX_VIEWS_PER_STEP` views, BORROWING the renderer's global
   * state (render target, tone mapping, clear colour, `autoClear`, the
   * scissor toggle) for exactly this call and handing it back before
   * returning — never across the `await` a caller puts between steps. A bake
   * that spans real frames (the whole point of stepping it) shares the
   * renderer with the engine's ordinary draws on every frame it does NOT
   * render a view; leaving any of this set when `step()` returns would draw
   * every one of those frames tone-mapped wrong, with a stuck `autoClear` or
   * a leftover tile's scissor rect.
   */
  function renderViewBatch() {
    const savedTarget = renderer.getRenderTarget();
    const savedToneMapping = renderer.toneMapping;
    const savedColor = renderer.getClearColor(new THREE.Color());
    const savedAlpha = renderer.getClearAlpha();
    const savedAutoClear = renderer.autoClear;
    try {
      renderer.toneMapping = THREE.NoToneMapping;
      for (let n = 0; n < MAX_VIEWS_PER_STEP && cursor < views.length; n++, cursor++) {
        const view = views[cursor];
        if (view.target === ssNormalTarget && !materialsSwapped) {
          // A blind scene override loses alpha/normal nodes. The bake root is
          // a private clone, so replace its materials for the normal pass
          // without mutating the source or relying on callbacks
          // `Object3D.clone` drops.
          root.traverse(object => {
            if (!object.isMesh || !object.material) return;
            object.material = Array.isArray(object.material) ? object.material.map(normalFor) : normalFor(object.material);
          });
          materialsSwapped = true;
        }
        renderer.setRenderTarget(view.target);
        if (!clearedTargets.has(view.target)) {
          // One clear for the whole atlas, THEN `autoClear = false` — a
          // per-tile clear would wipe the tiles already drawn, because a
          // render pass clears the whole attachment regardless of the
          // viewport. `clearedTargets` makes this a one-time-per-target
          // action across every step that touches it, not just this one.
          renderer.setClearColor(0x000000, 0);
          renderer.clear();
          clearedTargets.add(view.target);
        }
        renderer.autoClear = false;
        renderer.setScissorTest(true);
        renderOneView(renderer, scene, camera, view.target, ssTile, view.col, view.row, bounds.center, bounds.radius, frames, hemisphere);
      }
    } finally {
      renderer.setRenderTarget(savedTarget);
      renderer.toneMapping = savedToneMapping;
      renderer.setClearColor(savedColor, savedAlpha);
      renderer.autoClear = savedAutoClear;
      renderer.setScissorTest(false);
    }
  }

  /** The two GPU blit passes, also run with tone mapping off for the same
   *  reason the view renders are: a tone-mapped bake would be tone-mapped a
   *  second time when the impostor is drawn. Finishes inside one `step()`
   *  call (no awaits), so — unlike `renderViewBatch` — one save/restore
   *  around the whole thing is enough; `runDownsamplePass`/`runDilatePass`
   *  already scope their own render target and `autoClear`. */
  function finalize() {
    const savedToneMapping = renderer.toneMapping;
    renderer.toneMapping = THREE.NoToneMapping;
    try {
      // Downsample BEFORE the edge-dilation pass: dilation only fills texels
      // that are still fully transparent after downsampling, which is exactly
      // the set supersampling could not recover any coverage for at all.
      const dsAlbedo = createAtlasTarget(size, THREE.SRGBColorSpace, THREE.NearestFilter);
      const dsNormal = createAtlasTarget(size, THREE.NoColorSpace, THREE.NearestFilter);
      runDownsamplePass(renderer, ssTarget.texture, ssSize, dsAlbedo, supersample);
      runDownsamplePass(renderer, ssNormalTarget.texture, ssSize, dsNormal, supersample);

      const finalAlbedo = createAtlasTarget(size, THREE.SRGBColorSpace, THREE.LinearFilter);
      const finalNormal = createAtlasTarget(size, THREE.NoColorSpace, THREE.LinearFilter);
      runDilatePass(renderer, dsAlbedo.texture, size, tile, finalAlbedo);
      runDilatePass(renderer, dsNormal.texture, size, tile, finalNormal);
      dsAlbedo.dispose();
      dsNormal.dispose();

      return {
        albedo: finalAlbedo.texture,
        normal: finalNormal.texture,
        // The targets themselves, for receipts that need the bytes (the impostor
        // smoke reads them with `readRenderTargetImage`); nothing else uses them.
        albedoTarget: finalAlbedo,
        normalTarget: finalNormal,
        size,
        frames,
        tile,
        hemisphere,
        center: bounds.center.clone(),
        radius: bounds.radius,
        dispose() {
          finalAlbedo.dispose();
          finalNormal.dispose();
        },
      };
    } finally {
      renderer.toneMapping = savedToneMapping;
      disposeBakeResources();
    }
  }

  return {
    /** Total octahedral views this bake renders (both passes together). */
    viewCount: views.length,
    /** Render steps, plus one for the finishing GPU downsample/dilate pair. */
    stepCount: Math.ceil(views.length / MAX_VIEWS_PER_STEP) + 1,
    async step() {
      if (finished) return { done: true };
      if (cursor < views.length) {
        renderViewBatch();
        return { done: false };
      }
      try {
        const atlas = finalize();
        finished = true;
        return { done: true, atlas };
      } catch (error) {
        finished = true;
        disposeBakeResources();
        throw error;
      }
    },
    /** Frees GPU resources for a bake abandoned mid-flight (e.g. the owning
     *  component detached before its atlas arrived). Safe to call more than
     *  once, and a no-op once `step()` has already finished normally. Never
     *  touches renderer state — `renderViewBatch` never leaves any borrowed,
     *  so there is nothing here to give back. */
    cancel() {
      if (finished) return;
      finished = true;
      disposeBakeResources();
    },
  };
}

/** Hands the frame back between render steps — the same fallback chain
 *  `WorldComponent.js`'s own `frame()` helper uses, so a bake yields a real
 *  animation frame in a browser and an immediate macrotask under Node/tests. */
function nextBakeFrame() {
  return new Promise(resolve => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}

/**
 * Bakes `source` (an `Object3D` subtree) into an octahedral impostor atlas,
 * spending at most `MAX_VIEWS_PER_STEP` views per animation frame and
 * finishing with two GPU blits — see `createImpostorBakeJob`. Kept as a
 * single `Promise<atlas>` for callers that only want the result
 * (`ImpostorSystem.js`'s one-bake-at-a-time queue); `FoliageComponent.js`
 * drives the job directly instead, so it can report its own frame count.
 */
export async function bakeImpostorAtlas(renderer, source, options = {}) {
  const job = createImpostorBakeJob(renderer, source, options);
  let result = { done: false };
  while (!result.done) {
    // Each step renders its views and reads pixels back — both park on the
    // GPU wire behind whatever the queue holds. Span it (the boot ledger's
    // biggest "(unattributed)" rows were exactly these waits).
    const stepSpan = freeze.begin("impostorBake:step");
    try {
      result = await job.step();
    } finally {
      freeze.end(stepSpan);
    }
    if (!result.done) await nextBakeFrame();
  }
  return result.atlas;
}

/** `width×height` RGBA → `[width:u32le][height:u32le][tight top-down RGBA]`,
 *  the sidecar `analyze-impostor-atlas.mjs` reads without a PNG decoder — a
 *  bake-quality bug lives in exact per-texel alpha/colour, which a lossless
 *  raw dump preserves and a re-encoded PNG round-trip does not risk. */
function rawAtlasBuffer(image, width, height) {
  const out = new Uint8Array(8 + image.length);
  new DataView(out.buffer).setUint32(0, width, true);
  new DataView(out.buffer).setUint32(4, height, true);
  out.set(image, 8);
  return out;
}

/** data:image/png;base64,... → raw PNG bytes, the same decode
 *  `viewportScreenshot.js#pngBytesFromDataUrl` does for its own capture. */
function pngBytesFromDataUrl(dataUrl) {
  const binary = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * ⛔ DEBUG ONLY — never called on the ordinary bake path. Reads a finished
 * atlas's two render targets back to the CPU with
 * `renderer.readRenderTargetPixelsAsync` (via `readRenderTargetImage`, which
 * also fixes up the WebGPU row-padding/order the raw call leaves broken —
 * see `renderTargetImage.js`) and writes four files under `dir`:
 * `impostor-albedo.png` / `impostor-normal.png` (for a human to open) and
 * their `.raw` twins plus `impostor-meta.json` (for
 * `scripts/analyze-impostor-atlas.mjs`, which has no PNG decoder available in
 * plain Node). Gated behind `globalThis.__impostorDumpDir` by the CALLER
 * (`FoliageComponent.js#acquireAtlas`) — this function itself takes no global
 * state, so a test can call it directly with a fake renderer/writer.
 *
 * The editor-only file-write API is imported dynamically so this engine-layer
 * module never pulls the editor into a shipped runtime bundle merely by
 * existing; the import only actually happens when a caller opts in.
 */
export async function debugSaveAtlas(renderer, atlas, dir) {
  if (!renderer || !atlas || !dir) return null;
  const size = atlas.size;
  const [albedoImage, normalImage] = await Promise.all([
    readRenderTargetImage(renderer, { textures: [atlas.albedo] }, size, size),
    readRenderTargetImage(renderer, { textures: [atlas.normal] }, size, size),
  ]);
  const { writeBinaryFile } = await import("../../editor/assetLoader.js");
  const { joinPath } = await import("../../editor/assetOps.js");
  const write = async (name, bytes) => {
    const filePath = joinPath(dir, name);
    await writeBinaryFile(filePath, bytes);
    return filePath;
  };
  const meta = { size, frames: atlas.frames, tile: atlas.tile, hemisphere: atlas.hemisphere !== false };
  const [albedoPngPath, normalPngPath] = await Promise.all([
    write("impostor-albedo.png", pngBytesFromDataUrl(imageDataToDataUrl(albedoImage, size, size))),
    write("impostor-normal.png", pngBytesFromDataUrl(imageDataToDataUrl(normalImage, size, size))),
  ]);
  await Promise.all([
    write("impostor-albedo.raw", rawAtlasBuffer(albedoImage, size, size)),
    write("impostor-normal.raw", rawAtlasBuffer(normalImage, size, size)),
    write("impostor-meta.json", new TextEncoder().encode(JSON.stringify(meta, null, 2))),
  ]);
  return { dir, albedoPngPath, normalPngPath, meta };
}

/** Matrix elements rounded to a micrometre, so two props placed by the same
 *  authoring step do not miss each other's atlas over floating-point dust. */
function format(matrix) {
  let out = "";
  for (const value of matrix.elements) out += `${Math.round(value * 1e6) / 1e6},`;
  return out;
}

/**
 * A stable key for "these two props can share an atlas".
 *
 * Five hundred instances of one tree must bake ONCE. Geometry and material
 * identity is what decides that — two entities pointing at the same loaded
 * assets produce the same pixels — and the bake settings ride along because a
 * 4-frame atlas and a 16-frame atlas of the same tree are different objects.
 */
export function impostorCacheKey(source, settings = {}) {
  const parts = [];
  // The bake happens in the source's PARENT space, so that is the space the key
  // has to describe. Reading each mesh's own `matrix` instead would miss both
  // the source root's transform and any group between — and the resulting bug
  // is subtle in the worst way: two props that differ only by a scale share an
  // atlas, and half the forest comes out the wrong size.
  source.updateWorldMatrix(true, true);
  const toBakeSpace = new THREE.Matrix4();
  if (source.parent) toBakeSpace.copy(source.parent.matrixWorld).invert();
  const relative = new THREE.Matrix4();
  source.traverse((object) => {
    if (!object.isMesh && !object.isInstancedMesh) return;
    if (!bakeable(object)) return;
    const material = Array.isArray(object.material)
      ? object.material.map((m) => m?.uuid).join("+")
      : object.material?.uuid;
    relative.multiplyMatrices(toBakeSpace, object.matrixWorld);
    parts.push(`${object.geometry?.uuid}:${material}:${format(relative)}`);
  });
  const merged = { ...IMPOSTOR_BAKE_DEFAULTS, ...settings };
  return `${parts.join("|")}#${merged.frames}x${merged.tile}${merged.hemisphere ? "h" : "s"}@${merged.ambient}`;
}
