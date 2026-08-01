import * as THREE from "three/webgpu";
import {
  Fn,
  abs,
  attribute,
  cameraPosition,
  cameraViewMatrix,
  cameraWorldMatrix,
  clamp,
  cross,
  dot,
  float,
  floor,
  max,
  min,
  normalize,
  positionGeometry,
  positionWorld,
  select,
  step,
  struct,
  texture as tslTexture,
  vec2,
  vec3,
  vec4,
} from "three/tsl";

/**
 * The impostor material (roadmap item 14).
 *
 * One camera-facing quad showing the octahedral atlas baked by
 * `impostorBake.js`: the three views around the current direction, blended, and
 * lit from the baked normal.
 *
 * ## Everything is per-INSTANCE, and that is the point
 *
 * A forest of impostors that costs one draw call per tree is not an
 * optimisation: the LOD mesh it replaces was already being merged into a single
 * instanced draw by `batching.js` (five hundred identical props share a
 * geometry and a material, which is exactly what that system looks for). An
 * impostor that broke out of the batch would trade a thousand vertices for
 * four hundred and ninety-nine extra draw submissions — on a CPU-bound frame,
 * a straight loss.
 *
 * So the billboard is driven entirely by INSTANCED ATTRIBUTES — centre, size
 * and the object's two world axes — and never by the model matrix. One
 * `InstancedBufferGeometry`, one material, one draw call for every impostor
 * sharing an atlas, and no dependency on how three's own instancing rewrites
 * `positionLocal`. The mesh that carries them sits at the scene root with an
 * identity transform, so local space IS world space here; `ImpostorSystem` owns
 * that invariant.
 *
 * ## The billboard is in the vertex stage, and it is a POSITION node
 *
 * Same reason as the VFX ribbons (item 13): the viewport camera, the game
 * camera and every shadow cascade draw the same buffer in the same frame, so a
 * billboard computed on the CPU is correct for at most one of them.
 *
 * What differs here is WHICH node does it. three ships a `billboarding()`
 * helper that returns a clip-space position for `material.vertexNode`, and
 * using it would break this material specifically: `vertexNode` replaces the
 * final position without touching `positionWorld`, which would then still
 * describe the un-billboarded quad — and `positionWorld` is exactly what the
 * fragment stage projects to find its texel. The offset is therefore applied
 * through `positionNode`, so world position, view position, and the lighting
 * that reads them, all agree with where the quad really is.
 *
 * ## Three frames, weighted, premultiplied
 *
 * Sampling only the nearest view makes the whole billboard switch to a
 * different rendering of the object between one frame and the next — about 15°
 * of apparent rotation at eight frames, which reads as the scenery twitching as
 * the player walks. The three surrounding views are blended by their
 * barycentric weights instead (see `octahedral.js`).
 *
 * The blend is premultiplied by alpha and divided out at the end. Straight
 * averaging pulls the empty background of one view into the silhouette of
 * another, which puts a dark fringe around every leaf — the classic "my
 * impostors have a halo", and it comes from the blend, not from the bake.
 */

/** The unit quad every impostor draws. Shared: the per-instance buffers are
 *  what differ, and the vertex data never does. */
let sharedQuad = null;

function impostorQuad() {
  if (!sharedQuad) {
    sharedQuad = new THREE.PlaneGeometry(1, 1);
    sharedQuad.name = "ImpostorQuad";
  }
  return sharedQuad;
}

/** The per-instance channels. Kept in one place because the material reads them
 *  by name and `ImpostorSystem` writes them by name. */
export const IMPOSTOR_ATTRIBUTES = [
  ["aCenter", 3],
  ["aSize", 1],
  ["aAxisX", 3],
  ["aAxisY", 3],
];

/**
 * An instanced quad buffer with room for `capacity` impostors.
 *
 * The vertex attributes are the shared quad's, by reference — a hundred batches
 * do not need a hundred copies of four vertices. Only the instanced channels
 * are allocated per batch.
 */
export function createImpostorGeometry(capacity) {
  const quad = impostorQuad();
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.name = "ImpostorBatch";
  geometry.index = quad.index;
  geometry.setAttribute("position", quad.attributes.position);
  geometry.setAttribute("normal", quad.attributes.normal);
  geometry.setAttribute("uv", quad.attributes.uv);
  for (const [name, size] of IMPOSTOR_ATTRIBUTES) {
    const attributeBuffer = new THREE.InstancedBufferAttribute(
      new Float32Array(capacity * size),
      size,
    );
    attributeBuffer.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute(name, attributeBuffer);
  }
  geometry.instanceCount = 0;
  // Written by the system from the members' real extents. Never computed: the
  // quad's own vertices describe a unit square at the origin, so a computed
  // sphere would cull the whole batch the moment the origin left the frustum.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);
  return geometry;
}

/** Colour, coverage and normal from one blend — returned together so the three
 *  atlas fetches are not run once for the colour node and again for the normal
 *  node. */
const ImpostorSample = struct(
  { color: "vec3", alpha: "float", normal: "vec3" },
  "ImpostorSample",
);

/** Octahedral encode, the TSL twin of `octahedral.js#octEncode`. */
function octEncodeNode(dir, hemisphere) {
  const p = dir.div(max(abs(dir.x).add(abs(dir.y)).add(abs(dir.z)), 1e-6)).toVar();
  if (hemisphere) {
    // Below the horizon, fold onto it rather than wrapping to a frame that was
    // never baked.
    const scale = max(abs(p.x).add(abs(p.z)), 1e-6);
    const folded = vec2(p.x.div(scale), p.z.div(scale));
    const xz = select(p.y.lessThan(0), folded, vec2(p.x, p.z)).toVar();
    return vec2(xz.x.add(xz.y), xz.x.sub(xz.y)).mul(0.5).add(0.5);
  }
  const fx = float(1).sub(abs(p.z)).mul(select(p.x.greaterThanEqual(0), float(1), float(-1)));
  const fz = float(1).sub(abs(p.x)).mul(select(p.z.greaterThanEqual(0), float(1), float(-1)));
  const xz = select(p.y.lessThan(0), vec2(fx, fz), vec2(p.x, p.z)).toVar();
  return xz.mul(0.5).add(0.5);
}

/** Octahedral decode, the TSL twin of `octahedral.js#octDecode`. */
function octDecodeNode(uv, hemisphere) {
  if (hemisphere) {
    const a = uv.x.mul(2).sub(1);
    const b = uv.y.mul(2).sub(1);
    const x = a.add(b).mul(0.5).toVar();
    const z = a.sub(b).mul(0.5).toVar();
    const y = float(1).sub(abs(x)).sub(abs(z));
    return normalize(vec3(x, y, z));
  }
  const x0 = uv.x.mul(2).sub(1).toVar();
  const z0 = uv.y.mul(2).sub(1).toVar();
  const y0 = float(1).sub(abs(x0)).sub(abs(z0)).toVar();
  const fx = float(1).sub(abs(z0)).mul(select(x0.greaterThanEqual(0), float(1), float(-1)));
  const fz = float(1).sub(abs(x0)).mul(select(z0.greaterThanEqual(0), float(1), float(-1)));
  const below = y0.lessThan(0);
  return normalize(vec3(select(below, fx, x0), y0, select(below, fz, z0)));
}

/**
 * The bake camera's basis for a frame, reconstructed. Must match
 * `octahedral.js#frameBasis` exactly — the shader and the bake camera are two
 * implementations of one convention, and a disagreement between them shifts
 * every texel sideways.
 */
function frameBasisNode(dir) {
  const reference = select(abs(dir.y).greaterThan(0.999), vec3(0, 0, 1), vec3(0, 1, 0));
  const right = normalize(cross(reference, dir)).toVar();
  const up = cross(dir, right).toVar();
  return { right, up };
}

/**
 * Builds the impostor material for one baked atlas.
 *
 * Cached per atlas by `ImpostorSystem`, not per component: five hundred trees
 * sharing an atlas must also share the material, or they are five hundred draw
 * calls again and the batching system cannot group them.
 */
export function createImpostorMaterial(atlas, { alphaTest = 0.5, lit = true, roughness = 0.9 } = {}) {
  const frames = atlas.frames;
  const hemisphere = atlas.hemisphere !== false;
  // Per instance: where the billboard is, how big, and the object's own axes —
  // the atlas was baked in object space, so the frame lookup has to be done
  // there, and these two axes (plus their cross product) are that rotation.
  const center = attribute("aCenter", "vec3");
  const size = attribute("aSize", "float");
  const axisX = attribute("aAxisX", "vec3");
  const axisY = attribute("aAxisY", "vec3");

  const MaterialClass = lit ? THREE.MeshStandardNodeMaterial : THREE.MeshBasicNodeMaterial;
  const material = new MaterialClass({
    // Alpha TEST, not alpha blending: an impostor stands in for solid geometry,
    // so it has to write depth (a forest of order-dependent transparent quads
    // sorts wrong from every angle) and has to cast a shadow.
    transparent: false,
    alphaTest,
    side: THREE.DoubleSide,
  });
  material.name = "Impostor";
  if (lit) {
    material.roughness = roughness;
    material.metalness = 0;
  }

  // ---- vertex: face the camera ---------------------------------------------
  // The batch mesh sits at the scene root with an identity transform, so the
  // position node's "local" space is world space. Building the quad from the
  // camera's own axes is what makes it face the viewer — and doing it here,
  // per camera, is what makes the same buffer correct in the viewport, in the
  // game view and in every shadow cascade at once.
  const cameraRight = cameraWorldMatrix.mul(vec4(1, 0, 0, 0)).xyz;
  const cameraUp = cameraWorldMatrix.mul(vec4(0, 1, 0, 0)).xyz;
  material.positionNode = center
    .add(cameraRight.mul(positionGeometry.x.mul(size)))
    .add(cameraUp.mul(positionGeometry.y.mul(size)));

  // ---- fragment: pick three frames and blend them --------------------------
  const albedoTexture = tslTexture(atlas.albedo);
  const normalTexture = tslTexture(atlas.normal);
  const n = float(Math.max(1, frames - 1));
  const tiles = float(frames);
  const inset = 0.5 / atlas.tile;

  const sampleImpostor = Fn(() => {
    const axisZ = cross(axisX, axisY).toVar();
    const toWorld = positionWorld.sub(center).toVar();
    // Into the object's own space, where the atlas was baked. Three dot
    // products rather than an inverse matrix: the axes are orthonormal, so the
    // transpose IS the inverse, and a per-instance matrix would be nine floats
    // of instance data instead of six.
    const local = vec3(dot(toWorld, axisX), dot(toWorld, axisY), dot(toWorld, axisZ)).toVar();
    const toCamera = cameraPosition.sub(center);
    // The view direction is taken from the object's CENTRE, not per fragment:
    // which frame to show is a property of the object, and letting it vary
    // across the quad puts a seam down the middle of every impostor where the
    // two halves picked different views.
    const viewDir = normalize(
      vec3(dot(toCamera, axisX), dot(toCamera, axisY), dot(toCamera, axisZ)),
    ).toVar();
    const grid = clamp(octEncodeNode(viewDir, hemisphere), 0, 1).mul(n).toVar();
    const cell = min(floor(grid), n.sub(1)).toVar();
    const frac = grid.sub(cell).toVar();
    // The cell is split along its anti-diagonal; which half the direction falls
    // in decides the third corner and all three weights.
    const lower = frac.x.add(frac.y).lessThan(1);

    const corners = [
      select(lower, cell, cell.add(vec2(1, 1))),
      cell.add(vec2(1, 0)),
      cell.add(vec2(0, 1)),
    ];
    const weights = [
      select(lower, float(1).sub(frac.x).sub(frac.y), frac.x.add(frac.y).sub(1)),
      select(lower, frac.x, float(1).sub(frac.y)),
      select(lower, frac.y, float(1).sub(frac.x)),
    ];

    const colorSum = vec3(0).toVar();
    const normalSum = vec3(0).toVar();
    const alphaSum = float(0).toVar();

    for (let i = 0; i < 3; i++) {
      const corner = corners[i].toVar();
      const dir = octDecodeNode(corner.div(n), hemisphere).toVar();
      const { right, up } = frameBasisNode(dir);
      // Where this fragment lands in that view: its offset from the centre,
      // measured on the view's own axes. Exact for anything on the plane
      // through the centre, which is all a depth-less impostor claims.
      const tileUv = vec2(dot(local, right), dot(local, up)).div(size).add(0.5).toVar();
      // Outside the baked view there is nothing. Clamping instead would smear
      // the edge texel across the rest of the quad.
      const inside = step(0, tileUv.x)
        .mul(step(tileUv.x, 1))
        .mul(step(0, tileUv.y))
        .mul(step(tileUv.y, 1));
      const safe = clamp(tileUv, inset, 1 - inset);
      const atlasUv = corner.add(safe).div(tiles);
      const texel = albedoTexture.sample(atlasUv).toVar();
      const weight = max(weights[i], 0).mul(inside).mul(texel.a).toVar();
      colorSum.addAssign(texel.rgb.mul(weight));
      alphaSum.addAssign(weight);
      normalSum.addAssign(normalTexture.sample(atlasUv).rgb.mul(2).sub(1).mul(weight));
    }

    return ImpostorSample(
      colorSum.div(max(alphaSum, 1e-4)),
      alphaSum,
      normalize(normalSum.add(vec3(0, 0, 1e-5))),
    );
  });

  const sampled = sampleImpostor().toVar();
  material.colorNode = vec4(sampled.get("color"), 1);
  material.opacityNode = sampled.get("alpha");
  if (lit) {
    // The atlas stores normals in the object's own space, so the impostor of a
    // tree rotated 90° is lit as a tree rotated 90° rather than as a flat card.
    // Rotated back through the instance's axes, then into view space by hand:
    // `transformNormalToView` would use the model's normal matrix, and the
    // model here is a batch proxy at the origin that knows nothing about which
    // instance a fragment belongs to.
    const normalLocal = sampled.get("normal");
    const normalWorldSpace = axisX
      .mul(normalLocal.x)
      .add(axisY.mul(normalLocal.y))
      .add(cross(axisX, axisY).mul(normalLocal.z));
    material.normalNode = normalize(cameraViewMatrix.mul(vec4(normalWorldSpace, 0)).xyz);
  }
  material.userData.impostorAtlas = atlas;
  return material;
}
