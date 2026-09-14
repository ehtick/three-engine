import * as THREE from "three/webgpu";
import {
  Fn,
  abs,
  attribute,
  cameraPosition,
  cameraProjectionMatrix,
  cameraViewMatrix,
  cameraWorldMatrix,
  clamp,
  cross,
  dot,
  float,
  floor,
  fract,
  length,
  max,
  min,
  normalize,
  positionGeometry,
  positionWorld,
  screenCoordinate,
  select,
  smoothstep,
  step,
  struct,
  texture as tslTexture,
  uniform,
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
 * describe the un-billboarded quad. The offset is therefore applied through
 * `positionNode`, so world position, view position, and lighting agree with
 * where the quad really is. Atlas projection retains the original billboard
 * position separately: vertex animation must carry the texture with the quad,
 * while lighting and GI continue to see its deformed world position.
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
/** How far, as a fraction of the billboard's size, the shadow caster is pushed
 *  away from the light — see `castShadowPositionNode` in `createImpostorMaterial`. */
export const IMPOSTOR_SHADOW_PUSH = 0.35;

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
 * ── THE IMPOSTOR TIER'S OWN CROSSFADE (P1-B) ──────────────────────────────
 *
 * The same complementary-smoothstep formula as `foliageLod.js`'s
 * `foliageTierWeights` / `foliageMaterial.js`'s tree-and-grass draws, kept as
 * three independent copies on purpose: this file stays renderer-only (no
 * import of the foliage module) and a GPU shader cannot import CPU math at
 * all. `far`/`maxDistance` are per-COMPONENT state even though this material
 * is shared per ATLAS (several components can share one bake), so they ride
 * as per-object state exactly like `aCenter`'s sibling `foliageLodFar`/
 * `foliageLodEnd` in `foliageMaterial.js` — `.onObjectUpdate` re-reads
 * `object.userData` before every object's draw; `FoliageComponent.update()`
 * writes them once a frame on the shared impostor render mesh. The arrival
 * ramp (`foliageImpostorRamp`, `foliageApplyImpostorRamp` in `foliageLod.js`)
 * defaults to "fully arrived" (1) here: `FoliageComponent` promotes a chunk
 * to this tier the instant the bake exists rather than waiting on a ramp,
 * because the live commit path (`foliageBatchOrder.js`) assigns a whole
 * chunk to exactly one tier — there is no SECOND tier left drawing whatever
 * the ramp would have held back. The formula still agrees exactly with the
 * mid tier's at `lodFar`, so that promotion is a detail-geometry swap, never
 * a coverage pop; this uniform is wired for the day a chunk can live in two
 * tiers' render meshes at once and something actually drives it below 1.
 */
function impostorLodBand(threshold) { return max(threshold.mul(.25), 6); }
function impostorCrossfade(edge, band, distance) { return smoothstep(edge.sub(band.mul(.5)), edge.add(band.mul(.5)), distance); }

/** Same interleaved-gradient-noise screen-door dither as the tree/grass
 * material — a stable per-pixel value, never animated per frame. */
function impostorDitherNoise() {
  return fract(float(52.9829189).mul(fract(screenCoordinate.x.mul(.06711056).add(screenCoordinate.y.mul(.00583715)))));
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

  // See the file-level comment above `impostorLodBand`. `size` already bakes
  // in `atlas.radius * 2 * instanceScale` (`FoliageComponent._writeImpostor`)
  // — divide the constant back out to recover the same per-instance scale the
  // tree/grass draw normalizes its own distance by.
  const lodFar = uniform(0).onObjectUpdate(({ object }) => object.userData.foliageLodFar ?? 0);
  const lodEnd = uniform(0).onObjectUpdate(({ object }) => object.userData.foliageLodEnd ?? 0);
  const lodRamp = uniform(1).onObjectUpdate(({ object }) => object.userData.foliageImpostorRamp ?? 1);
  // ⭐ THE SHADOW-SIDE HANDOFF — where this tier's SHADOW starts, written as
  // `userData.foliageShadowLodFar` by `FoliageComponent.update()` (resolved by
  // `foliageLod.js#foliageShadowFar`, clamped at or below `far − band(far)` so
  // every instance this tier is asked to shadow is one the commit path actually
  // gave it). Falls back to the colour `far`, which makes the shadow pass
  // replay the colour decision — every impostor outside the foliage feature,
  // and every foliage component without the prop, lands on that fallback.
  const lodShadowFar = uniform(0).onObjectUpdate(({ object }) => object.userData.foliageShadowLodFar ?? object.userData.foliageLodFar ?? 0);
  // ⛔ NEVER TSL's builtin `cameraPosition` here (09-13, fixed): that is the
  // world position of whichever camera is rendering the CURRENT PASS, which
  // in the shadow-map pass is the light's orthographic camera, not the
  // viewer. Every instance's distance-from-light then reads as huge, this
  // fade collapses to 0, and the impostor vanishes from its own shadow while
  // still drawing fine in the color pass. `lodViewerPosition` is the exact
  // twin of `foliageMaterial.js`'s `lod.viewerPosition`: a per-object uniform
  // fed every frame from `FoliageComponent`'s own `engine.camera` read
  // (`mesh.userData.foliageViewerPosition`), identical across every pass.
  // The octahedral VIEW-DIRECTION selection below (`toCamera`) deliberately
  // keeps using the pass camera instead — picking the baked frame that
  // matches whichever camera is actually looking (the light, in a shadow
  // pass) is what gives that pass a correctly shaped silhouette.
  const lodViewerPosition = uniform(new THREE.Vector3()).onObjectUpdate(({ object }, self) => object.userData.foliageViewerPosition ?? self.value);
  const instanceScale = max(size.div(Math.max(atlas.radius * 2, 1e-4)), 1e-4);
  const lodDistance = length(center.sub(lodViewerPosition)).div(instanceScale);
  const fadeFar = impostorCrossfade(lodFar, impostorLodBand(lodFar), lodDistance);
  const fadeEnd = impostorCrossfade(lodEnd, impostorLodBand(lodEnd), lodDistance);
  // The complementary twin of `foliageMaterial.js`'s `midWeight`: only the
  // ramped share of the raw impostor weight actually draws here, so the mid
  // mesh's leftover exactly covers what this tier has not yet faded into.
  const fadeWeight = fadeFar.mul(float(1).sub(fadeEnd)).mul(lodRamp).toVar();
  // The SAME weight folded against the shadow handoff (`lodShadowFar`) instead
  // of the colour `far`. Consumed only by `maskShadowNode` below; the colour
  // pass keeps `fadeWeight`, so with the handoff unset the two agree exactly.
  const fadeFarShadow = impostorCrossfade(lodShadowFar, impostorLodBand(lodShadowFar), lodDistance);
  const fadeWeightShadow = fadeFarShadow.mul(float(1).sub(fadeEnd)).mul(lodRamp).toVar();

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
  const billboard = center
    .add(cameraRight.mul(positionGeometry.x.mul(size)))
    .add(cameraUp.mul(positionGeometry.y.mul(size)));
  // Weight 0 collapses the whole quad onto `center` — a real point, so no
  // projective singularity — instead of paying to rasterize and shade a
  // billboard the fragment stage would only discard anyway.
  material.positionNode = select(fadeWeight.lessThanEqual(1e-3), center, billboard);
  // ⭐ AN IMPOSTOR MUST NOT SHADOW ITSELF (09-14). The shadow pass draws this
  // quad facing the LIGHT through the object's centre; the colour pass draws it
  // facing the VIEWER through the same centre — so the half of the view quad
  // behind the light-facing one always lands in its own shadow, and far trees
  // read as dark olive blots. Push the caster away from the light (the shadow
  // camera's forward) so the view quad sits in front of it. A directional
  // light projects along that same axis, so the shadow on the ground does not
  // move; only the depth it is tested at does.
  //
  // ⛔ BUT NOT THE BOTTOM EDGE (09-14). A uniform push of 0.35×size (metres on
  // a real tree) sank the card's lower half under the terrain, so each shadow
  // lost its base along a straight line and floated off its trunk ("flat
  // bottomed blocks"). The push grows from 0 at the card's bottom edge to full
  // at its top: the base still meets the ground, the crown still clears the
  // view quad.
  const passForward = cameraWorldMatrix.mul(vec4(0, 0, -1, 0)).xyz;
  const pushWeight = positionGeometry.y.add(.5).clamp(0, 1);
  material.castShadowPositionNode = select(fadeWeightShadow.lessThanEqual(1e-3), center,
    billboard.add(passForward.mul(size.mul(IMPOSTOR_SHADOW_PUSH).mul(pushWeight))));
  // ⛔ THE UNCOLLAPSED BILLBOARD, NEVER `material.positionNode` (09-14). That
  // node collapses onto `center` by the COLOUR fade, and the shadow pass draws
  // `castShadowPositionNode` with the SHADOW fade — between `shadowFar` and
  // `far` the caster quad is live while this varying reads `center` on every
  // vertex, so `local` is zero, the whole quad samples the crown's opaque
  // centre texel and `maskShadowNode` passes everywhere: every tree in that
  // band cast a solid rectangle ("rects casted from impostors", high camera).
  // A collapsed colour quad is degenerate and never reaches the fragment stage,
  // so reading the billboard here changes nothing it draws.
  const atlasPosition = billboard.toVarying();
  const fadeWeightVarying = fadeWeight.toVarying();
  const fadeWeightShadowVarying = fadeWeightShadow.toVarying();

  // ---- fragment: pick three frames and blend them --------------------------
  const albedoTexture = tslTexture(atlas.albedo);
  const normalTexture = tslTexture(atlas.normal);
  const n = float(Math.max(1, frames - 1));
  const tiles = float(frames);
  const inset = 0.5 / atlas.tile;

  const sampleImpostor = Fn(() => {
    const axisZ = cross(axisX, axisY).toVar();
    const toWorld = atlasPosition.sub(center).toVar();
    // Into the object's own space, where the atlas was baked. Three dot
    // products rather than an inverse matrix: the axes are orthonormal, so the
    // transpose IS the inverse, and a per-instance matrix would be nine floats
    // of instance data instead of six.
    const local = vec3(dot(toWorld, axisX), dot(toWorld, axisY), dot(toWorld, axisZ)).toVar();
    // ⛔ AN ORTHOGRAPHIC PASS LOOKS ALONG ITS AXIS, NOT FROM A POINT (09-14).
    // The sun's shadow camera sits ~50 m behind the viewer, so for a tree off
    // to the side `cameraPosition - center` is nearly horizontal: the shadow
    // drew the tree's SIDE view on a light-facing card with mismatched axes,
    // and every impostor cast a long black strip. Ortho projections carry 1 in
    // element [3][3] (perspective 0); there the view direction is the camera's
    // own backward axis for every instance.
    const orthographic = cameraProjectionMatrix.element(3).w.greaterThan(.5);
    const toCamera = select(orthographic, cameraWorldMatrix.mul(vec4(0, 0, 1, 0)).xyz, cameraPosition.sub(center));
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
      // ⛔ 09-13 "tree impostors are upside down": the atlas became a render
      // target sampled directly (no CPU readback / DataTexture). Its rows are
      // stored top-down — the baked view's top is texel row 0 of the tile —
      // while `tileUv.y` grows with the object's UP. The frame's row index
      // already addresses the tile grid top-down, so only the V INSIDE a tile
      // has to be flipped; flipping the whole atlas would also pick the wrong
      // frame row.
      const atlasUv = corner.add(vec2(safe.x, float(1).sub(safe.y))).div(tiles);
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
  // Fold the dither into the ALPHA VALUE (multiply toward 0) so the existing
  // `alphaTest` above does the discarding, exactly like the tree/grass draw
  // (`foliageMaterial.js`). This is also what lets the impostor's shadow
  // carry the fade: `setupFoliageImpostorMaterial` (`foliageWind.js`) rebuilds
  // `maskShadowNode` from this SAME `opacityNode` after wrapping it for wind,
  // so a discard baked into a separate imperative statement here would never
  // reach it — the alpha value is the only channel that does.
  //
  // ⭐⭐ THE COMPLEMENTARY (FAR-SIDE) RULE (P1-B follow-up, 09-13) — the exact
  // twin of `foliageLod.js#foliageTierKeeps`'s tier-2 case and
  // `foliageMaterial.js#foliageDitherSurvivesFromThreshold`'s far branch. This tier is
  // ALWAYS the far side of its one boundary (mid/impostor) — never the near
  // side of a second one — so it unconditionally keeps `noise >= 1 - weight`,
  // the complement of the mid mesh's own `noise < weight` there. The previous
  // `noise < weight` here duplicated the near-tier rule on the FAR tier of the
  // boundary, which is exactly the hole/double-draw bug: two tiers agreeing on
  // "keep the low end of noise" instead of splitting the noise domain between
  // them leaves the high end kept by neither. `fadeWeight` already folds in
  // the maxDistance fade-out (`fadeEnd`) and the arrival ramp, so this same
  // rule thins the impostor to nothing at both ends without a separate case.
  const ditherSurvives = select(impostorDitherNoise().greaterThanEqual(float(1).sub(fadeWeightVarying)), float(1), float(0));
  material.opacityNode = sampled.get("alpha").mul(ditherSurvives);
  // ⭐ THE SHADOW SIDE of the same rule, replayed against the SHADOW handoff
  // weight: the impostor's shadow starts at `userData.foliageShadowLodFar`
  // rather than at the colour `far`, which is what lets the mid tier stop
  // carrying shadow geometry below the colour threshold without a gap — the
  // mid mesh's shadow fades OUT over this tier's band as it fades IN here
  // (both sides compare the same noise domain, so the handoff stays
  // complementary). Built HERE rather than by `setupFoliageImpostorMaterial`'s
  // opacity-node rebuild because that rebuild can only replay the COLOUR
  // decision, and because `NodeMaterial.copy` carries node slots by reference —
  // the foliage impostor's cloned material inherits this node as-is. With the
  // handoff unset it equals the colour decision above, which is also exactly
  // what the rebuild would have produced.
  // ⛔ Not dithered in the shadow pass (09-14): see `foliageMaterial.js`'s
  // `maskShadowNode` — the impostor card and the mid mesh are different
  // silhouettes, so a split dither thinned the handoff band's shadow to holes.
  // Any shadow weight casts the full silhouette; occluders union.
  material.maskShadowNode = sampled.get("alpha").greaterThan(alphaTest || .35).and(fadeWeightShadowVarying.greaterThan(1e-3));
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
  // Exposed for diagnostics/tests: identity-checkable without deep-comparing
  // node graphs (three's node materials are not diffable at any real scene
  // scale — see `foliageMaterial.js`'s sharing scheme for why).
  material.userData.impostorLod = { far: lodFar, end: lodEnd, ramp: lodRamp, viewerPosition: lodViewerPosition, atlasPosition };
  return material;
}
