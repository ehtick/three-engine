import * as THREE from "three/webgpu";
import { faceDirection, normalWorld, vec4 } from "three/tsl";
import { frameBasis, frameDirection } from "./octahedral.js";

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
 * A diffuse surface under uniform ambient returns its own colour, which is the
 * definition we want; a metal or a mirror returns something darker, which is
 * the accepted cost of not owning every material's shading model. Tone mapping
 * is switched off for the same reason — a tone-mapped bake would be tone-mapped
 * a second time when the impostor is drawn.
 *
 * ## Why the atlas is read back to a DataTexture
 *
 * The obvious thing is to keep the render target and sample its texture. This
 * reads the pixels back and builds an ordinary `DataTexture` instead, for three
 * reasons: the vertical orientation of a sampled render-target texture is a
 * backend convention (and a silently flipped atlas looks like a modelling
 * error, not a bug); the render targets — including their depth buffers — are
 * freed immediately afterwards; and the atlas becomes plain data, so a test can
 * assert what was baked without a screenshot, and a future version can write it
 * to disk as an asset.
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
  /** Brightness of the neutral ambient the albedo is captured under. */
  ambient: 1,
};

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

/** The override material for the normal pass. One pipeline for the whole bake. */
function createNormalMaterial() {
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
  material.side = THREE.DoubleSide;
  material.colorNode = vec4(normalWorld.mul(faceDirection).mul(0.5).add(0.5), 1);
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
function aimFrameCamera(camera, direction, center, radius) {
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

/**
 * Renders every frame into `target`, tile by tile.
 *
 * One clear for the whole atlas, then `autoClear = false` — a per-tile clear
 * would wipe the tiles already drawn, because a WebGPU render pass clears the
 * whole attachment regardless of the viewport. The scissor is what keeps a
 * frame inside its own cell: a viewport transforms, it does not clip.
 */
function renderTiles(renderer, scene, target, { frames, tile, hemisphere, center, radius }) {
  const camera = new THREE.OrthographicCamera();
  renderer.setRenderTarget(target);
  renderer.setClearColor(0x000000, 0);
  renderer.clear();
  const previousAutoClear = renderer.autoClear;
  renderer.autoClear = false;
  renderer.setScissorTest(true);
  try {
    for (let row = 0; row < frames; row++) {
      for (let col = 0; col < frames; col++) {
        aimFrameCamera(camera, frameDirection(col, row, frames, hemisphere), center, radius);
        target.viewport.set(col * tile, row * tile, tile, tile);
        target.scissor.set(col * tile, row * tile, tile, tile);
        renderer.render(scene, camera);
      }
    }
  } finally {
    renderer.autoClear = previousAutoClear;
    renderer.setScissorTest(false);
    target.viewport.set(0, 0, target.width, target.height);
    target.scissor.set(0, 0, target.width, target.height);
  }
}

/**
 * Reads a render target back as a tightly-packed, BOTTOM-UP atlas.
 *
 * Two corrections, both of the silent kind:
 *
 * **Padding.** WebGPU pads every row of a texture-to-buffer copy up to a
 * multiple of 256 bytes and three hands the mapped buffer over with the padding
 * still in it. Indexing it tightly yields an image that is progressively
 * sheared down the frame — plausible enough to ship, and nothing about the data
 * says so.
 *
 * **Row order, per TILE.** The readback arrives with row 0 at the top of the
 * image, and the viewport that placed each tile also counts from the top — so
 * tile row `r` really is at rows `[r*tile, …)`, but the pixels inside it are
 * upside down relative to `v`. Flipping the WHOLE image would fix the pixels
 * and break the placement (the shader would read frame `frames-1-r`, which is a
 * different view of the same object and therefore still looks like an object —
 * the worst kind of wrong). Flipping within each tile band fixes exactly the
 * one that is wrong, and leaves an atlas whose `v` runs upward, which is what
 * every other line of code here assumes.
 */
async function readAtlas(renderer, target, size, tile) {
  const raw = await renderer.readRenderTargetPixelsAsync(target, 0, 0, size, size);
  const rowBytes = size * 4;
  const paddedRow = Math.ceil(rowBytes / 256) * 256;
  const out = new Uint8Array(rowBytes * size);
  for (let y = 0; y < size; y++) {
    const band = Math.floor(y / tile) * tile;
    const from = (band + tile - 1 - (y - band)) * paddedRow;
    const available = Math.max(0, Math.min(rowBytes, raw.length - from));
    if (available > 0) out.set(raw.subarray(from, from + available), y * rowBytes);
  }
  return out;
}

function makeAtlasTexture(data, size, colorSpace) {
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.colorSpace = colorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  // No mipmaps: a mip chain would blend across tile borders, so the far side of
  // one view would bleed into its neighbour. The impostor is small on screen by
  // definition, which is also why the aliasing that costs is tolerable.
  texture.generateMipmaps = false;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Bakes `source` (an `Object3D` subtree) into an octahedral impostor atlas.
 *
 * Async because of the readback, not because of the rendering: every frame is
 * encoded synchronously into one command stream, and the await is the map of
 * the result. Callers should treat it as a load-time cost — `ImpostorSystem`
 * runs at most one bake per frame for exactly that reason.
 */
export async function bakeImpostorAtlas(renderer, source, options = {}) {
  const settings = { ...IMPOSTOR_BAKE_DEFAULTS, ...options };
  const frames = Math.max(2, Math.min(16, Math.round(settings.frames)));
  const hemisphere = settings.hemisphere !== false;
  let tile = Math.max(16, Math.round(settings.tile));
  tile = Math.min(tile, Math.floor(MAX_ATLAS_SIZE / frames));
  const size = frames * tile;

  if (!renderer) throw new Error("Impostor bake needs a renderer.");
  const root = buildBakeRoot(source);
  if (!hasGeometry(root)) throw new Error("Nothing to bake — the source has no meshes.");
  const bounds = boundsOf(root);
  if (!bounds) throw new Error("Nothing to bake — the source has no extent.");

  const scene = new THREE.Scene();
  scene.add(root);
  // The whole lighting environment of the bake: one white ambient, so what
  // comes out is (approximately) albedo rather than a frozen lighting solution.
  scene.add(new THREE.AmbientLight(0xffffff, settings.ambient));

  const target = new THREE.RenderTarget(size, size, {
    depthBuffer: true,
    stencilBuffer: false,
    generateMipmaps: false,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
  });
  target.texture.colorSpace = THREE.SRGBColorSpace;

  const normalTarget = new THREE.RenderTarget(size, size, {
    depthBuffer: true,
    stencilBuffer: false,
    generateMipmaps: false,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
  });
  normalTarget.texture.colorSpace = THREE.NoColorSpace;

  const normalMaterial = createNormalMaterial();
  const previousTarget = renderer.getRenderTarget();
  const previousToneMapping = renderer.toneMapping;
  const previousClear = new THREE.Color();
  renderer.getClearColor(previousClear);
  const previousClearAlpha = renderer.getClearAlpha();

  try {
    renderer.toneMapping = THREE.NoToneMapping;
    const tileArgs = { frames, tile, hemisphere, center: bounds.center, radius: bounds.radius };
    renderTiles(renderer, scene, target, tileArgs);
    scene.overrideMaterial = normalMaterial;
    renderTiles(renderer, scene, normalTarget, tileArgs);
    scene.overrideMaterial = null;
    renderer.setRenderTarget(previousTarget);

    const albedoData = await readAtlas(renderer, target, size, tile);
    const normalData = await readAtlas(renderer, normalTarget, size, tile);

    return {
      albedo: makeAtlasTexture(albedoData, size, THREE.SRGBColorSpace),
      normal: makeAtlasTexture(normalData, size, THREE.NoColorSpace),
      albedoData,
      normalData,
      size,
      frames,
      tile,
      hemisphere,
      center: bounds.center.clone(),
      radius: bounds.radius,
      dispose() {
        this.albedo.dispose();
        this.normal.dispose();
      },
    };
  } finally {
    renderer.setRenderTarget(previousTarget);
    renderer.toneMapping = previousToneMapping;
    renderer.setClearColor(previousClear, previousClearAlpha);
    scene.overrideMaterial = null;
    normalMaterial.dispose();
    target.dispose();
    normalTarget.dispose();
    // The clone shares geometry and materials with the source — disposing
    // either here would take the real object's buffers with it.
    scene.clear();
  }
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
