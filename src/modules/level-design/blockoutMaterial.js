// @ts-check
import * as THREE from "three/webgpu";

/**
 * The greybox look: one shared 1 m grid texture, tinted per shape.
 *
 * Two things make this worth a file of its own.
 *
 * **Sharing.** A blockout is hundreds of small meshes, and the engine's
 * same-material merging (engine/merging.js) can only batch meshes that hold
 * the *same material instance*. A `new MeshStandardNodeMaterial` per piece
 * would silently cost a draw call each — the exact failure mode recorded in
 * the same-material-merging notes — so materials are interned by colour and
 * reference-counted. Ten thousand walls share one material object.
 *
 * **The grid itself.** Pieces emit UVs in metres, so a single 1 m tile makes
 * every surface read at true scale: you can count the squares to measure a
 * room, which is the whole point of a blockout. The texture is drawn once into
 * a canvas rather than shipped as an asset, so the module has no files to
 * resolve and works in an exported build and a headless test alike (no
 * `document` → no map, just the flat tint; nothing throws).
 */

const CELL = 256; // px per metre in the generated tile
let gridTexture; // lazily built, shared by every blockout material
let gridTextureTried = false;

/** The 1 m tile: white ground, a strong cell border and quarter-metre hairlines
 *  so a piece reads as measurable at any distance. */
function makeGridTexture() {
  if (gridTextureTried) return gridTexture;
  gridTextureTried = true;
  if (typeof document === "undefined" || !document.createElement) return null;
  const canvas = document.createElement("canvas");
  // A headless harness stubs `document.createElement` with a plain object —
  // no 2D context, and no error until something calls a method on undefined.
  if (typeof canvas?.getContext !== "function") return null;
  canvas.width = canvas.height = CELL;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, CELL, CELL);
  ctx.strokeStyle = "rgba(0, 0, 0, 0.10)";
  ctx.lineWidth = 2;
  for (let i = 1; i < 4; i++) {
    const p = (i / 4) * CELL;
    ctx.beginPath();
    ctx.moveTo(p, 0); ctx.lineTo(p, CELL);
    ctx.moveTo(0, p); ctx.lineTo(CELL, p);
    ctx.stroke();
  }
  // The metre border is drawn as an inset rectangle rather than a line on the
  // seam: half of a seam-straddling stroke lands in the next tile, which turns
  // into a double-width line wherever two pieces meet.
  ctx.strokeStyle = "rgba(0, 0, 0, 0.42)";
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, CELL - 6, CELL - 6);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  texture.colorSpace = THREE.SRGBColorSpace;
  gridTexture = texture;
  return texture;
}

/** colour (lowercased hex) -> { material, users } */
const cache = new Map();

/**
 * A shared greybox material for `color`. Every caller with the same colour gets
 * the same instance — release it with {@link releaseBlockoutMaterial} when the
 * piece changes colour or detaches.
 */
export function acquireBlockoutMaterial(color = "#9aa7b8", { transparent = false, opacity = 1 } = {}) {
  const key = `${String(color).toLowerCase()}|${transparent ? opacity : 1}`;
  const hit = cache.get(key);
  if (hit) {
    hit.users++;
    return hit.material;
  }
  const material = new THREE.MeshStandardNodeMaterial({
    color: new THREE.Color(color),
    map: makeGridTexture(),
    roughness: 0.92,
    metalness: 0,
    transparent,
    opacity,
    // A ghost must not write depth or it hides the geometry it is previewing.
    depthWrite: !transparent,
  });
  material.name = `Blockout ${key}`;
  cache.set(key, { material, users: 1, key });
  return material;
}

/** Drops one reference; disposes the material when the last piece lets go. */
export function releaseBlockoutMaterial(material) {
  if (!material) return;
  for (const entry of cache.values()) {
    if (entry.material !== material) continue;
    entry.users--;
    if (entry.users > 0) return;
    cache.delete(entry.key);
    material.dispose();
    return;
  }
}

/** Test/teardown hook: forget every interned material. Not called by the
 *  runtime — pieces release what they acquire. */
export function disposeBlockoutMaterials() {
  for (const entry of cache.values()) entry.material.dispose();
  cache.clear();
  gridTexture?.dispose();
  gridTexture = undefined;
  gridTextureTried = false;
}
