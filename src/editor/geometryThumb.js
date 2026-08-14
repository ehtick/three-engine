/**
 * Shared offscreen WebGPU renderer for `.geom` Assets-panel thumbnails.
 *
 * One renderer for the whole app, renders serialized through a queue, captures
 * via a RenderTarget readback (WebGPU swapchain pixels are not reliably
 * readable from the canvas — see `api/ops/viewport.js`), and caches the PNG
 * data URL until the asset is overwritten.
 */
import * as THREE from "three/webgpu";
import { loadGeometryAsset } from "../engine/geometryAsset.js";
import { renderTargetToDataUrl } from "../engine/renderTargetImage.js";
import { onAssetInvalidated, extOf } from "./assetLoader.js";
import { samePath } from "./assetReveal.js";

const SIZE = 160;
/** Bumped when framing/lighting changes so stale close-up thumbs are dropped. */
const CACHE_VERSION = 2;

/** path → data URL string, or an in-flight Promise resolving to one. */
const cache = new Map();

let state = null; // { renderer, scene, camera, material, target, _center, _size }
let queue = Promise.resolve();
let subscribed = false;

function cacheKey(path) {
  return `${CACHE_VERSION}:${path}`;
}

function ensureInvalidationHook() {
  if (subscribed) return;
  subscribed = true;
  onAssetInvalidated((path) => {
    if (extOf(path) !== "geom") return;
    invalidateGeometryThumb(path);
  });
}

async function ensure() {
  if (state) return state;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SIZE;
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, alpha: true });
  renderer.setSize(SIZE, SIZE, false);
  renderer.setClearColor(0x000000, 0);
  await renderer.init();

  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x2a2e36, 0.95));
  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(3, 5, 4);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xa8b8ff, 0.7);
  fill.position.set(-3, 1, -2);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffffff, 0.45);
  rim.position.set(-1, 2, 3);
  scene.add(rim);

  const material = new THREE.MeshStandardNodeMaterial({
    color: 0xb8bec8,
    roughness: 0.45,
    metalness: 0.08,
    side: THREE.DoubleSide,
  });
  // Wider FOV reads better at thumbnail size than a telephoto fit.
  const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100);
  const target = new THREE.RenderTarget(SIZE, SIZE, {
    type: THREE.UnsignedByteType,
    colorSpace: THREE.SRGBColorSpace,
  });

  state = {
    renderer,
    scene,
    camera,
    material,
    target,
    _center: new THREE.Vector3(),
    _size: new THREE.Vector3(),
  };
  return state;
}

/**
 * Frames `camera` on the geometry so the whole mesh fits with margin.
 * Matches AssetInspector's model-preview framing (radius × ~2.4 orbit).
 */
function frameCamera(camera, geometry, scratch) {
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  if (!geometry.boundingSphere) geometry.computeBoundingSphere();
  const center = geometry.boundingBox.getCenter(scratch._center);
  const size = geometry.boundingBox.getSize(scratch._size);
  // Prefer the larger of sphere radius and half-diagonal — three's sphere can
  // undershoot on some authored meshes, which is what produced the extreme
  // close-ups in the Assets grid.
  const radius = Math.max(
    geometry.boundingSphere.radius,
    size.length() * 0.5,
    1e-4,
  );
  const halfFov = (camera.fov * Math.PI) / 360;
  // Exact sphere fit is radius/sin(halfFov); pad so corners aren't clipped at
  // the elevated 3/4 angle.
  const dist = (radius / Math.sin(halfFov)) * 1.35;
  const elev = 0.48;
  const azim = 0.7;
  const cosE = Math.cos(elev);
  camera.near = Math.max(dist / 100, 0.001);
  camera.far = dist + radius * 8;
  camera.position.set(
    center.x + Math.sin(azim) * dist * cosE,
    center.y + dist * Math.sin(elev),
    center.z + Math.cos(azim) * dist * cosE,
  );
  camera.lookAt(center);
  camera.updateProjectionMatrix();
}

/**
 * Renders the current scene into `target` and returns a PNG data URL.
 * Row padding and row ORDER are the readback helper's business — this used to
 * carry its own copy of the WebGL bottom-up flip, which produced thumbnails
 * that were upside down on WebGPU.
 */
async function capture({ renderer, scene, camera, target }) {
  const prev = renderer.getRenderTarget();
  try {
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    renderer.setRenderTarget(prev);
    return await renderTargetToDataUrl(renderer, target, SIZE, SIZE);
  } finally {
    renderer.setRenderTarget(prev);
  }
}

async function renderOne(path) {
  const geometry = await loadGeometryAsset(path);
  const s = await ensure();
  let mesh = null;
  try {
    mesh = new THREE.Mesh(geometry, s.material);
    s.scene.add(mesh);
    frameCamera(s.camera, geometry, s);
    return await capture(s);
  } finally {
    if (mesh) s.scene.remove(mesh);
    geometry.dispose();
  }
}

/**
 * Returns a PNG data URL for `path`, or `null` if load/render fails.
 * Concurrent callers for the same path share one in-flight render.
 */
export function requestGeometryThumb(path) {
  ensureInvalidationHook();
  const key = cacheKey(path);
  const hit = cache.get(key);
  if (hit !== undefined) return Promise.resolve(hit);

  let settle;
  const promise = new Promise((resolve) => {
    settle = resolve;
  });
  cache.set(key, promise);

  queue = queue
    .then(async () => {
      // Dropped from the cache (overwrite / invalidate) while waiting — skip.
      if (cache.get(key) !== promise) {
        settle(null);
        return;
      }
      try {
        const url = await renderOne(path);
        if (cache.get(key) === promise) cache.set(key, url);
        settle(url);
      } catch (err) {
        if (cache.get(key) === promise) cache.delete(key);
        console.warn(`Geometry thumb failed for ${path}: ${err?.message ?? err}`);
        settle(null);
      }
    })
    .catch(() => {});

  return promise;
}

/** Drops a cached thumb so the next request re-renders from disk. */
export function invalidateGeometryThumb(path) {
  cache.delete(cacheKey(path));
  // Paths may differ only by separator/case across listings vs writers.
  for (const key of [...cache.keys()]) {
    const cachedPath = key.slice(String(CACHE_VERSION).length + 1);
    if (samePath(cachedPath, path)) cache.delete(key);
  }
}
