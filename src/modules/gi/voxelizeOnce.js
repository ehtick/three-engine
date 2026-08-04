// GI shared helpers that survived the SDF/voxel-bake deletion (2026-08-02).
//
// This file used to be the legacy CPU voxel medium (bakeCore rasterize + EDT
// + streaming bake worker). That pipeline is gone; what remains are the pure
// pieces the occupancy backend still consumes:
//   · resolveMaterialSurface / serializeMeshForBake — material → albedo/
//     emissive resolution and mesh serialization (GISystem, occupancy field);
//   · createVoxelSceneTrace — the TSL Amanatides-Woo DDA;
//   · createTrilinearRadianceSampler — the side-aware trilinear field read
//     every transport hit shades through (giField).
import * as THREE from "three/webgpu";
import { Break, If, Loop, float, floor, instancedArray, step, texture3D, vec3, vec4 } from "three/tsl";

/**
 * Evaluates a TSL node subtree to a constant RGB if possible, else null.
 * Handles ColorNode/uniform (.value Color), float constants (as grey),
 * constant ×/+ chains (the shader graph's `color × strength` emission), and
 * wrapper nodes (VarNode & co. keep the real expression in `.node` — this
 * three version auto-wraps operator chains in VarNode, which made every
 * graph-authored emissive look unresolvable and bake black).
 */
function constantColorOf(node, depth = 0) {
  if (!node || depth > 8) return null;
  const value = node.value;
  if (value && typeof value === "object" && typeof value.r === "number") return value;
  if (typeof value === "number") return { r: value, g: value, b: value };
  if ((node.op === "*" || node.op === "+") && node.aNode && node.bNode) {
    const a = constantColorOf(node.aNode, depth + 1);
    const b = constantColorOf(node.bNode, depth + 1);
    if (a && b) {
      return node.op === "*"
        ? { r: a.r * b.r, g: a.g * b.g, b: a.b * b.b }
        : { r: a.r + b.r, g: a.g + b.g, b: a.b + b.b };
    }
  }
  if (node.node) return constantColorOf(node.node, depth + 1);
  return null;
}

/** First THREE.Texture found in a node subtree (the shader graph's albedo
 *  sample), or null. Same bounded wrapper-walk as constantColorOf. */
function textureValueOf(node, depth = 0) {
  if (!node || depth > 8) return null;
  if (node.value?.isTexture) return node.value;
  for (const child of [node.aNode, node.bNode, node.node]) {
    const found = child ? textureValueOf(child, depth + 1) : null;
    if (found) return found;
  }
  return null;
}

/**
 * Mean LINEAR color of a texture, from an 8×8 downsample of its source
 * image. This is what keeps a TEXTURED mesh from baking into the field —
 * and reflecting — as flat WHITE: the SDF slot carries one albedo, and
 * `material.color` for a textured model is white ("the reflection from a
 * model is white" report). GPU-compressed sources (KTX2) have no drawable
 * image → cached null → the scalar color fallback stands.
 */
const textureAverageCache = new WeakMap(); // texture -> {r,g,b} | null (tried, undrawable)
// Fingerprint scans revisit the same materials for the lifetime of a scene.
// A diagnostic that cannot change until the material graph changes should not
// flood the editor console/store on every scan.
const warnedUnresolvedEmissive = new WeakSet();
function textureAverageColor(texture) {
  if (!texture) return null;
  if (textureAverageCache.has(texture)) return textureAverageCache.get(texture);
  const image = texture.image;
  if (!image || !(image.width > 0) || !(image.height > 0)) return null; // not loaded yet — retry next scan
  if (image.complete === false) return null;
  try {
    // 128, not 8 (2026-08-04, Blender-parity): drawImage downsamples in sRGB
    // space, and an sRGB block-average decoded to linear UNDERESTIMATES the
    // true linear mean of the block (Jensen — a 50/50 black/white block reads
    // 0.21 instead of 0.5). At 8×8 each "texel" averaged an enormous block of
    // a contrasty texture, so every textured mesh's bounce albedo was biased
    // DARK and GRAY — compounding per bounce, which is a whole-room fill
    // deficit. At 128×128 the per-block variance (and so the bias) is small;
    // the per-texel decode below is unchanged. One-time cost per texture
    // (cached): a 64KB readback.
    const size = 128;
    const canvas =
      typeof OffscreenCanvas !== "undefined"
        ? new OffscreenCanvas(size, size)
        : Object.assign(document.createElement("canvas"), { width: size, height: size });
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(image, 0, 0, size, size);
    const data = ctx.getImageData(0, 0, size, size).data;
    let r = 0, g = 0, b = 0, w = 0;
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3] / 255;
      // Albedo images are sRGB-encoded — average in LINEAR, alpha-weighted.
      r += Math.pow(data[i] / 255, 2.2) * a;
      g += Math.pow(data[i + 1] / 255, 2.2) * a;
      b += Math.pow(data[i + 2] / 255, 2.2) * a;
      w += a;
    }
    const result = w > 1e-3 ? { r: r / w, g: g / w, b: b / w } : null;
    textureAverageCache.set(texture, result);
    return result;
  } catch {
    textureAverageCache.set(texture, null); // undrawable source — permanent
    return null;
  }
}

/**
 * Resolves the bake-relevant surface of a material. Engine material assets
 * carry their real color/emissive in colorNode/emissiveNode (top-level
 * `.color` can sit at stale white, `.emissive` at black) — same reason the
 * editor swatch walks colorNode. Texture-driven color multiplies in the
 * texture's MEAN color (see textureAverageColor).
 */
export function resolveMaterialSurface(materialInput, meshName = "") {
  const material = Array.isArray(materialInput) ? materialInput[0] : materialInput;
  const white = { r: 1, g: 1, b: 1 };
  const black = { r: 0, g: 0, b: 0 };
  let color = constantColorOf(material?.colorNode) ?? material?.color ?? white;
  // A/B escape hatch, dev/harness only.
  const mapAverage = globalThis.__giNoTextureTint
    ? null
    : textureAverageColor(material?.map ?? textureValueOf(material?.colorNode));
  if (mapAverage) {
    color = { r: color.r * mapAverage.r, g: color.g * mapAverage.g, b: color.b * mapAverage.b };
  }
  const emissiveTexture = textureValueOf(material?.emissiveNode);
  // An SDF slot stores ONE emissive color for the whole mesh. Replacing a
  // spatial mask with its average turns a building/room mesh into a giant
  // area light and washes every material toward white. Keep imported
  // texture-masked emission in the raster material only; GI emission remains
  // available for constant-color nodes and dedicated emissive geometry.
  const emissiveResolved = emissiveTexture ? null : constantColorOf(material?.emissiveNode);
  const emissive = emissiveResolved ?? material?.emissive ?? black;
  const emissiveIntensity = emissiveResolved ? 1 : (material?.emissiveIntensity ?? 1);
  // A texture-backed expression may simply be waiting for its image. Retry on
  // the next fingerprint scan without claiming that it is unsupported.
  if (material?.emissiveNode && !emissiveResolved && !emissiveTexture) {
    const fallbackDark =
      (emissive.r ?? 0) * emissiveIntensity < 0.01 &&
      (emissive.g ?? 0) * emissiveIntensity < 0.01 &&
      (emissive.b ?? 0) * emissiveIntensity < 0.01;
    if (fallbackDark && material && !warnedUnresolvedEmissive.has(material)) {
      warnedUnresolvedEmissive.add(material);
      console.warn(
        `[gi] "${meshName || "mesh"}": emissiveNode is not a constant color×intensity expression — ` +
          `this emitter bakes BLACK and won't light the GI. Use a flat emissive color/intensity, ` +
          `or report the graph shape so the resolver can learn it.`,
      );
    }
  }
  return { color, emissive, emissiveIntensity };
}

/**
 * Serializes a THREE.Mesh into the plain, structured-cloneable record
 * bakeCore consumes (safe to postMessage to the bake worker). Arrays are
 * copied — the live geometry stays untouched.
 */
const geometryCopyCache = new WeakMap(); // geometry -> { version, positions, index }

export function serializeMeshForBake(mesh) {
  const position = mesh.geometry?.attributes?.position;
  if (!position) return null;
  mesh.updateWorldMatrix(true, false);
  const surface = resolveMaterialSurface(mesh.material, mesh.name);
  // Vertex/index copies cached per geometry (big character models cost real
  // milliseconds to slice per request; a drag only changes the matrix).
  let cached = geometryCopyCache.get(mesh.geometry);
  const version = position.version ?? 0;
  if (!cached || cached.version !== version) {
    cached = {
      version,
      positions: position.array.slice(0, position.count * 3),
      index: mesh.geometry.index ? mesh.geometry.index.array.slice() : null,
    };
    geometryCopyCache.set(mesh.geometry, cached);
  }
  return {
    // Identity for the worker's incremental diffing + geometry cache: the
    // key changes when geometry content does, so edits re-ship exactly once.
    id: mesh.id,
    geometryKey: `${mesh.geometry.id}:${version}`,
    positions: cached.positions,
    index: cached.index,
    matrix: [...mesh.matrixWorld.elements],
    color: { r: surface.color.r, g: surface.color.g, b: surface.color.b },
    emissive: { r: surface.emissive.r, g: surface.emissive.g, b: surface.emissive.b },
    emissiveIntensity: surface.emissiveIntensity,
  };
}

const toRecords = (meshesOrRecords) =>
  meshesOrRecords.map((entry) => (entry?.isMesh ? serializeMeshForBake(entry) : entry)).filter(Boolean);

const toPlainLights = (light) => {
  const list = Array.isArray(light) ? light : light ? [light] : [];
  return list.map((entry) => ({
    type: entry.type === "directional" ? "directional" : "point",
    position: entry.position ? { x: entry.position.x, y: entry.position.y, z: entry.position.z } : undefined,
    direction: entry.direction
      ? { x: entry.direction.x, y: entry.direction.y, z: entry.direction.z }
      : undefined,
    color: { r: entry.color.r, g: entry.color.g, b: entry.color.b },
    intensity: entry.intensity,
  }));
};

/**
 * @param {Array} meshes THREE meshes OR pre-serialized bake records
 * @param {{min: THREE.Vector3, max: THREE.Vector3}} bounds
 * @param {{x: number, y: number, z: number}} res grid cells per axis
 * @param {object|Array} light light(s) for the direct bake
 */
// (voxelizeOnce — the legacy CPU whole-field voxel baker, its streaming
// bake worker and the mesh-SDF request worker — was deleted 2026-08-02 with
// the rest of the SDF pipeline. The pure helpers around it stay: material
// surface resolution, mesh serialization, the voxel DDA and the trilinear
// radiance sampler are all consumed by the occupancy backend.)

/**
 * TSL DDA over the baked grid: (origin, dir, tMaxWorld) → { rad, t }, t < 0
 * = miss. tMaxWorld is a JS number — it bounds the step count at build time.
 * (Exported for giField.js — the voxel-free medium reuses the exact same
 * cascade-ray DDA and trilinear radiance sampler over its own buffers.)
 *
 * `normalBuffer` (optional) makes hits DIRECTION-AWARE: a cell stores ONE
 * outgoing radiance but a thin wall has two faces — a ray arriving from the
 * cell normal's own side (front) reads the radiance, a ray arriving from
 * behind reads BLACK (the far side's energy is not visible through matter).
 * Without this, single-cell-thin roofs/walls showed the bright interior as
 * blotchy patches when viewed from OUTSIDE.
 */
export function createVoxelSceneTrace(radianceBuffer, bounds, res, cell, normalBuffer = null) {
  const minCell = Math.min(cell.x, cell.y, cell.z);

  return (origin, dir, tMaxWorld) => {
    const maxSteps = Math.min(256, Math.ceil(tMaxWorld / minCell) + 2);

    const rad = vec3(0).toVar();
    const t = float(-1).toVar();

    const gx = origin.x.sub(bounds.min.x).div(cell.x).toVar();
    const gy = origin.y.sub(bounds.min.y).div(cell.y).toVar();
    const gz = origin.z.sub(bounds.min.z).div(cell.z).toVar();
    const ix = floor(gx).toVar();
    const iy = floor(gy).toVar();
    const iz = floor(gz).toVar();

    const stepX = step(0, dir.x).mul(2).sub(1).toVar();
    const stepY = step(0, dir.y).mul(2).sub(1).toVar();
    const stepZ = step(0, dir.z).mul(2).sub(1).toVar();
    // sign() is 0 at 0 — use a step-based sign (0 → +1) to avoid div-by-0.
    const safe = (component) => step(0, component).mul(2).sub(1).mul(component.abs().max(1e-8));
    const tDeltaX = float(cell.x).div(safe(dir.x)).abs().toVar();
    const tDeltaY = float(cell.y).div(safe(dir.y)).abs().toVar();
    const tDeltaZ = float(cell.z).div(safe(dir.z)).abs().toVar();
    const boundOf = (frac, stepSign) => stepSign.mul(0.5).add(0.5).add(stepSign.mul(frac.negate()));
    const tMaxX = boundOf(gx.sub(ix), stepX).mul(tDeltaX).toVar();
    const tMaxY = boundOf(gy.sub(iy), stepY).mul(tDeltaY).toVar();
    const tMaxZ = boundOf(gz.sub(iz), stepZ).mul(tDeltaZ).toVar();
    const travelled = float(0).toVar();

    Loop({ start: 0, end: maxSteps, name: "vox" }, () => {
      If(
        ix.lessThan(0)
          .or(iy.lessThan(0))
          .or(iz.lessThan(0))
          .or(ix.greaterThanEqual(res.x))
          .or(iy.greaterThanEqual(res.y))
          .or(iz.greaterThanEqual(res.z))
          .or(travelled.greaterThan(tMaxWorld)),
        () => {
          Break();
        },
      );

      const cellIdx = iz.mul(res.y).add(iy).mul(res.x).add(ix);
      const voxel = radianceBuffer.element(cellIdx.toInt()).toVar();
      If(voxel.w.greaterThan(0.5), () => {
        if (normalBuffer) {
          // Back-side hit → the cell blocks but emits nothing this way.
          const n = normalBuffer.element(cellIdx.toInt()).xyz;
          rad.assign(voxel.xyz.mul(step(dir.dot(n), 0)));
        } else {
          rad.assign(voxel.xyz);
        }
        t.assign(travelled.max(1e-4));
        Break();
      });

      If(tMaxX.lessThanEqual(tMaxY).and(tMaxX.lessThanEqual(tMaxZ)), () => {
        travelled.assign(tMaxX);
        tMaxX.addAssign(tDeltaX);
        ix.addAssign(stepX);
      })
        .ElseIf(tMaxY.lessThanEqual(tMaxZ), () => {
          travelled.assign(tMaxY);
          tMaxY.addAssign(tDeltaY);
          iy.addAssign(stepY);
        })
        .Else(() => {
          travelled.assign(tMaxZ);
          tMaxZ.addAssign(tDeltaZ);
          iz.addAssign(stepZ);
        });
    });

    return { rad, t };
  };
}

/**
 * Occupancy-weighted trilinear sample of the live radiance field:
 * (p) → { rad: vec3, coverage: float }. Used to shade MIRROR ray hits —
 * the DDA's single-cell radiance paints flat voxel-sized patches; sampling
 * the 8 surrounding occupied cells makes reflected surfaces shade smoothly
 * (the reference's mirrors read its continuous probe field the same way).
 * Empty cells carry no radiance and are excluded by weight; `coverage` → 0
 * means the neighborhood is degenerate and the caller should fall back.
 */
export function createTrilinearRadianceSampler(radianceBuffer, bounds, res, cell, normalBuffer = null) {
  return (p, sideNormal = null) => {
    const fx = p.x.sub(bounds.min.x).div(cell.x).sub(0.5).toVar();
    const fy = p.y.sub(bounds.min.y).div(cell.y).sub(0.5).toVar();
    const fz = p.z.sub(bounds.min.z).div(cell.z).sub(0.5).toVar();
    const bx = floor(fx).toVar();
    const by = floor(fy).toVar();
    const bz = floor(fz).toVar();
    const wx = fx.sub(bx);
    const wy = fy.sub(by);
    const wz = fz.sub(bz);
    const acc = vec3(0).toVar();
    const weightAcc = float(0).toVar();
    Loop({ start: 0, end: 8, name: "radTri" }, ({ radTri }) => {
      const cf = radTri.toFloat();
      const cx = cf.mod(2);
      const cy = floor(cf.div(2)).mod(2);
      const cz = floor(cf.div(4));
      const ix = bx.add(cx).clamp(0, res.x - 1);
      const iy = by.add(cy).clamp(0, res.y - 1);
      const iz = bz.add(cz).clamp(0, res.z - 1);
      const w = cx
        .mul(wx)
        .add(cx.oneMinus().mul(wx.oneMinus()))
        .mul(cy.mul(wy).add(cy.oneMinus().mul(wy.oneMinus())))
        .mul(cz.mul(wz).add(cz.oneMinus().mul(wz.oneMinus())));
      const cellIdx = iz.mul(res.y).add(iy).mul(res.x).add(ix);
      const voxel = radianceBuffer.element(cellIdx.toInt()).toVar();
      If(voxel.w.greaterThan(0.5), () => {
        // SIDE-AWARE weighting: a sub-cell-thick wall keeps one shell
        // layer per side, each carrying its own side's radiance. A plain
        // trilinear at a hit on side A averages in side B's (possibly
        // brightly lit) cells — light "shines through" thin partitions in
        // the transport. Cells whose stored normal opposes the hit side
        // are the OTHER face: weight them out.
        const side =
          normalBuffer && sideNormal
            ? normalBuffer.element(cellIdx.toInt()).xyz.dot(sideNormal).max(0)
            : float(1);
        acc.addAssign(voxel.xyz.mul(w).mul(side));
        weightAcc.addAssign(w.mul(side));
      });
    });
    return { rad: acc.div(weightAcc.max(1e-4)), coverage: weightAcc };
  };
}

/**
 * SDF sphere-traced soft shadow: (origin, dir, maxT, k, cosRayNormal) →
 * float penumbra in [0, 1]. Tracks the closest approach via the trilinear
 * distance field: penumbra = min(k·d/t) — smooth area shadows, zero noise.
 * Estimator notes: plain min(d/t) only (iq's refinement is unsafe on a
 * non-smooth field), 0.85 safety factor, step clamp ≤ 8 voxels, and
 * plane-aware self-exclusion (samples whose distance ≈ the ray's height
 * above the RECEIVER'S OWN plane are the receiver surface, not a blocker —
 * without this, grazing rays paint terraced false-shadow rings).
 *
 * The field carries EXACT sub-voxel distances near surfaces (bakeCore's
 * narrow band), so around thin geometry the d < contact region can be as
 * thin as the geometry itself — the minimum step (0.35·voxel) is what
 * guarantees a crossing ray still samples inside it (worst case a steep
 * crossing samples d ≤ step/2 ≈ 0.18·voxel < the 0.25·voxel contact cut).
 *
 * `lift` = the caller's ray-origin normal offset in world units. The
 * self-exclusion needs it exactly: with an exact field the receiver's own
 * plane reports dRaw == lift + t·cos, so "occluder" is dRaw meaningfully
 * BELOW that height. (The old version guessed the lift as 2·minCell and
 * compared the 0.85-scaled d — with exact distances that made every
 * receiver's own plane an "occluder" past t·cos ≈ 1.5 voxels → false
 * radial shadow rings across open floors/ceilings.)
 *
 * `meshSdf` (optional) = a SlotRegistry: per-mesh high-res local distance
 * fields min()ed against the scene field each step. Promoted meshes are
 * excluded from the scene field's seeds, so near them the crisp local data
 * is the only (and correct) contributor — this is what turns a thin-winged
 * character's blocky voxel shadow into a clean one.
 */
// (createSDFShadowTrace — the legacy per-mesh-atlas soft shadow — deleted
// 2026-08-02 with the bake pipeline; giField.js owns the live shadow trace.)
