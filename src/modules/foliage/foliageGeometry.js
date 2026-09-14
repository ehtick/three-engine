import * as THREE from "three/webgpu";
import { getTreeMotion, growTreeSkeleton, resolveTreeShapeParameters, getTreeSpeciesParams, isNeedleSpecies } from "./treeGrowth.js";
import { FOLIAGE_LEAF_CARDS, foliageLeafVariantCount } from "./foliageSurfaceTexture.js";

export const FOLIAGE_SPECIES = Object.freeze({
  oak: { label: "Oak", height: 8, width: 6, leafColor: "#52732b", barkColor: "#65513a", flowerColor: "#efd275" },
  pine: { label: "Pine", height: 10, width: 4, leafColor: "#315c39", barkColor: "#6b4936", flowerColor: "#efd275" },
  birch: { label: "Birch", height: 9, width: 4, leafColor: "#73943c", barkColor: "#d9d5ba", flowerColor: "#efd275" },
  "black-tupelo": { label: "Black Tupelo", height: 9, width: 6, leafColor: "#3c6b3f", barkColor: "#5b4a3f", flowerColor: "#efd275" },
  "weeping-willow": { label: "Weeping Willow", height: 8, width: 9, leafColor: "#8ba852", barkColor: "#6b6045", flowerColor: "#efd275" },
  spruce: { label: "Spruce", height: 13, width: 4, leafColor: "#2d4a35", barkColor: "#4a3c2e", flowerColor: "#efd275" },
  maple: { label: "Maple", height: 10, width: 9, leafColor: "#4f7a3a", barkColor: "#6b5d4f", flowerColor: "#efd275" },
  poplar: { label: "Poplar", height: 14, width: 2.5, leafColor: "#6f9c4a", barkColor: "#8a8a72", flowerColor: "#efd275" },
  shrub: { label: "Shrub", height: 2, width: 2.2, leafColor: "#5a7d3d", barkColor: "#5f6b3f", flowerColor: "#efd275" },
  hawthorn: { label: "Hawthorn", height: 5, width: 4.5, leafColor: "#3f6b35", barkColor: "#5c5347", flowerColor: "#f4f1e4" },
  grass: { label: "Meadow grass", height: 0.65, width: 0.65, leafColor: "#64863a", barkColor: "#526331", flowerColor: "#efd275" },
  wildflowers: { label: "Wildflowers", height: 0.8, width: 0.6, leafColor: "#507539", barkColor: "#567239", flowerColor: "#eac5e6" },
});

/** The six species whose leaf-card templates were redesigned as small, sparse
 * clusters (`foliageSurfaceTexture.js`'s `makeSparseBroadleafVariant`) rather
 * than the original locked 42-leaf mat (`oak`/`birch`) or needle sprays
 * (`pine`/`spruce`) — used to place fewer, crossed cards per twig site. */
const SPARSE_LEAF_CLUSTER_SPECIES = new Set(["black-tupelo", "weeping-willow", "maple", "poplar", "shrub", "hawthorn"]);

/** Identical seeds produce identical geometry and placements without global RNG state. */
export function foliageRandom(seed = 1) {
  let state = Number(seed) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const finite = (n, fallback) => Number.isFinite(Number(n)) ? Number(n) : fallback;
const clamp = THREE.MathUtils.clamp;
const point = (x, y, z) => new THREE.Vector3(x, y, z);

/** One merged, vertex-colored mesh per prototype/LOD; no textures or material groups. */
class Builder {
  positions = []; colors = []; uv = []; wind = []; indices = [];
  constructor(height, grassMetadata = false) {
    this.height = height;
    if (grassMetadata) { this.bladeData = []; this.curveData = []; }
  }
  vertex(p, color, u = 0, v = 0, stiffness = 1) {
    const index = this.positions.length / 3;
    // A blade is a flat ribbon, but shading it flat makes grass read as paper.
    // Where a point carries its own normal, that one wins over the face normal.
    if (p.foliageNormal) (this.normalOverrides ??= new Map()).set(index, p.foliageNormal);
    this.positions.push(p.x, p.y, p.z);
    this.colors.push(color.r, color.g, color.b);
    this.uv.push(u, v);
    this.wind.push(clamp(p.y / this.height, 0, 1) * stiffness);
    if (this.bladeData) {
      this.bladeData.push(this.windRoot?.x ?? 0, this.windRoot?.z ?? 0, this.bladeLength ?? 1, this.attachmentT ?? p.foliageT ?? clamp((p.y - (this.windRoot?.y ?? 0)) / (this.bladeHeight ?? 1), 0, 1));
      const dx = this.bladeDirection?.x ?? 1, dz = this.bladeDirection?.z ?? 0;
      const offset = this.curveAngle === -1 ? 0 : -(p.x - (this.windRoot?.x ?? 0)) * dz + (p.z - (this.windRoot?.z ?? 0)) * dx;
      this.curveData.push(dx, dz, this.curveAngle ?? -1, offset);
    }
    return index;
  }
  tri(a, b, c, color, stiffness = 1) {
    this.indices.push(this.vertex(a, color, 0, 0, stiffness), this.vertex(b, color, 1, 0, stiffness), this.vertex(c, color, 0.5, 1, stiffness));
  }
  /** One triangle whose corners carry their own colour, for gradients along a
   * blade: dark and cool in the shaded base, bright and dry at the tip. */
  shadedTri(a, b, c, colorA, colorB, colorC, stiffness = 1) {
    this.indices.push(this.vertex(a, colorA, 0, 0, stiffness), this.vertex(b, colorB, 1, 0, stiffness), this.vertex(c, colorC, 0.5, 1, stiffness));
  }
  tube(start, end, radius0, radius1, color, sides, stiffness = 0.15, segments = 1) {
    const axis = end.clone().sub(start).normalize();
    const tangent = point(Math.abs(axis.y) > 0.9 ? 1 : 0, Math.abs(axis.y) > 0.9 ? 0 : 1, 0).cross(axis).normalize();
    const bitangent = axis.clone().cross(tangent);
    const rings = [];
    for (let ring = 0; ring <= segments; ring++) {
      const t = ring / segments, center = start.clone().lerp(end, t);
      const radius = radius0 + (radius1 - radius0) * t;
      const ids = [];
      for (let i = 0; i <= sides; i++) {
        const angle = i / sides * Math.PI * 2;
        const p = center.clone().addScaledVector(tangent, Math.cos(angle) * radius).addScaledVector(bitangent, Math.sin(angle) * radius);
        p.foliageT = t;
        ids.push(this.vertex(p, color, i / sides, t, stiffness));
      }
      rings.push(ids);
    }
    for (let j = 0; j < segments; j++) for (let i = 0; i < sides; i++) this.indices.push(rings[j][i], rings[j][i + 1], rings[j + 1][i], rings[j][i + 1], rings[j + 1][i + 1], rings[j + 1][i]);
  }
  leaf(center, length, width, yaw, lift, color, detail = 1) {
    const axis = point(Math.sin(yaw) * Math.cos(lift), Math.sin(lift), Math.cos(yaw) * Math.cos(lift));
    const side = point(Math.cos(yaw), 0, -Math.sin(yaw));
    const a = center.clone().addScaledVector(axis, -length * 0.5);
    const tip = center.clone().addScaledVector(axis, length * 0.5);
    const left = center.clone().addScaledVector(side, width * 0.5);
    const right = center.clone().addScaledVector(side, -width * 0.5);
    if (detail) {
      const ridge = center.clone().add(point(0, width * 0.1, 0));
      this.tri(a, left, ridge, color); this.tri(left, tip, ridge, color);
      this.tri(tip, right, ridge, color); this.tri(right, a, ridge, color);
    } else { this.tri(a, left, tip, color); this.tri(a, tip, right, color); }
  }
  // A small rounded seedhead for flowers; tree canopies never use solid fillers.
  crown(center, radius, color, detail, flatten = 0.8) {
    const longitude = detail ? 7 : 5;
    const latitude = detail ? 4 : 2;
    const rings = [];
    for (let y = 0; y <= latitude; y++) {
      const phi = y / latitude * Math.PI;
      const row = [];
      for (let x = 0; x <= longitude; x++) {
        const theta = x / longitude * Math.PI * 2;
        const p = point(Math.sin(phi) * Math.cos(theta) * radius, Math.cos(phi) * radius * flatten, Math.sin(phi) * Math.sin(theta) * radius).add(center);
        const tint = color.clone().multiplyScalar(0.83 + 0.17 * (1 - y / latitude));
        row.push(this.vertex(p, tint, x / longitude, y / latitude));
      }
      rings.push(row);
    }
    for (let y = 0; y < latitude; y++) for (let x = 0; x < longitude; x++) {
      if (y > 0) this.indices.push(rings[y][x], rings[y][x + 1], rings[y + 1][x]);
      if (y < latitude - 1) this.indices.push(rings[y][x + 1], rings[y + 1][x + 1], rings[y + 1][x]);
    }
  }
  finish() {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(this.colors, 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
    geometry.setAttribute("foliageWind", new THREE.Float32BufferAttribute(this.wind, 1));
    if (this.bladeData) {
      const values = new Float32Array(this.bladeData.length * 2);
      for (let i = 0; i < this.bladeData.length / 4; i++) {
        values.set(this.bladeData.slice(i * 4, i * 4 + 4), i * 8);
        values.set(this.curveData.slice(i * 4, i * 4 + 4), i * 8 + 4);
      }
      const data = new THREE.InterleavedBuffer(values, 8);
      geometry.setAttribute("foliageBlade", new THREE.InterleavedBufferAttribute(data, 4, 0));
      geometry.setAttribute("foliageCurve", new THREE.InterleavedBufferAttribute(data, 4, 4));
    }
    geometry.setIndex(this.indices);
    geometry.computeVertexNormals();
    if (this.normalOverrides?.size) {
      const normals = geometry.attributes.normal;
      for (const [index, normal] of this.normalOverrides) normals.setXYZ(index, normal.x, normal.y, normal.z);
      normals.needsUpdate = true;
    }
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }
}

class TreeBuilder extends Builder {
  part = 0; motionData = [];
  vertex(p, color, u = 0, v = 0, stiffness = 1) {
    // A gnarled/drooping BARK segment (Weeping Willow's negative
    // attractionUp, Black Oak's own curveV) can curve low enough, from a low
    // attachment point, to poke through the ground the tree grows out of.
    // Leaf/needle cards are excluded: clamping only one of a card's two
    // symmetric edge vertices independently (whichever dipped low enough)
    // breaks "the card's own recorded root is the midpoint of its first
    // edge" exactly — and a card dipping a few centimetres into the ground
    // cover is not the visible problem a whole bark tube doing so is.
    if (p.y < 0 && this.part === 0) { p = p.clone(); p.y = 0; }
    const id = super.vertex(p, color, u, v, stiffness);
    const branch = this.branchMotion, root = this.leafRoot ?? p, axis = this.leafAxis ?? point(0, 1, 0);
    this.motionData.push(
      branch.pivot.x, branch.pivot.y, branch.pivot.z, branch.flex,
      branch.axis.x, branch.axis.y, branch.axis.z, this.wind[id],
      root.x, root.y, root.z, this.leafPhase ?? 0,
      axis.x, axis.y, axis.z, this.part,
    );
    return id;
  }
  finish() {
    const geometry = super.finish();
    // Four existing geometry streams + this one shared stream + both Three's
    // and the wind shader's instance matrices: 7 buffers / 16 attributes.
    // Do not retain separate wind/part attributes: large instanced draws would
    // exceed portable WebGPU's sixteen-attribute limit when both are read.
    geometry.deleteAttribute("foliageWind");
    const data = new THREE.InterleavedBuffer(new Float32Array(this.motionData), 16);
    for (const [name, offset] of [["treeBranch", 0], ["treeBranchAxis", 4], ["treeLeaf", 8], ["treeLeafAxis", 12]]) {
      geometry.setAttribute(name, new THREE.InterleavedBufferAttribute(data, 4, offset));
    }
    return geometry;
  }
}

function branchLayout(skeleton, branch, lod) {
  const source = branch.ids;
  const ids = lod === 0 || source.length <= 2 ? source : source.filter((_, i) => i === 0 || i === source.length - 1 || i % (branch.order === 0 ? [1, 3, 5][lod] : [1, 4, 7][lod]) === 0);
  const sides = lod === 0 ? (branch.radius > skeleton.height * 0.012 ? 7 : branch.radius > skeleton.height * 0.004 ? 5 : 3) : (branch.order === 0 ? 6 : 3);
  return { ids, sides, triangles: (ids.length - 1) * sides * 2 };
}

function branchTube(builder, skeleton, branch, lod, bark, layout = branchLayout(skeleton, branch, lod)) {
  const nodes = skeleton.nodes, { ids, sides } = layout;
  const rings = [];
  let previousSide = null, arc = 0;
  for (let j = 0; j < ids.length; j++) {
    const node = nodes[ids[j]], center = node.renderPosition;
    builder.branchMotion = skeleton.motion.nodes[node.id];
    const before = nodes[ids[Math.max(0, j - 1)]].renderPosition, after = nodes[ids[Math.min(ids.length - 1, j + 1)]].renderPosition;
    const tangent = after.clone().sub(before).normalize();
    let side = previousSide ? previousSide.clone().addScaledVector(tangent, -previousSide.dot(tangent)).normalize() : point(Math.abs(tangent.y) > 0.9 ? 1 : 0, Math.abs(tangent.y) > 0.9 ? 0 : 1, 0).cross(tangent).normalize();
    if (side.lengthSq() < 0.5) side = point(0, 0, 1).cross(tangent).normalize();
    const cross = tangent.clone().cross(side); previousSide = side;
    if (j) arc += center.distanceTo(before);
    let radius = node.radius;
    if (branch.order && j === 0) radius = Math.min(radius, nodes[ids[1]].radius * 1.25);
    // The terminal pipe represents multiple unmodelled shoots. Its last ring
    // tapers into an actual thin twig rather than ending in a thick cut
    // cylinder — scaled from the tree's own size instead of a per-species
    // constant, since any of the ten species can now be authored at any height.
    if (j === ids.length - 1 && !node.children.length) radius = Math.min(radius, Math.max(0.0012, skeleton.height * 0.00033));
    const row = [];
    for (let k = 0; k <= sides; k++) {
      const theta = k / sides * Math.PI * 2;
      const p = center.clone().addScaledVector(side, Math.cos(theta) * radius).addScaledVector(cross, Math.sin(theta) * radius);
      row.push(builder.vertex(p, bark, k / sides, arc, branch.order === 0 ? 0.09 : Math.min(0.65, 0.16 + branch.order * 0.11)));
    }
    rings.push(row);
  }
  for (let j = 0; j + 1 < rings.length; j++) for (let k = 0; k < sides; k++) builder.indices.push(rings[j][k], rings[j][k + 1], rings[j + 1][k], rings[j][k + 1], rings[j + 1][k + 1], rings[j + 1][k]);
}

function leafSprayCard(builder, base, direction, side, length, width, color, lod, groundCheckLength = length, ellipsoid = null) {
  // Clamp the whole card, not each rendered vertex independently: a gnarled
  // low attachment (Black Oak, a shrub's own low baseSize) or a drooping
  // species (Weeping Willow) can place `base` at or below ground. Moving
  // `base` itself keeps the recorded animated root and the actual card
  // vertices agreeing exactly, which clamping only whichever single edge
  // vertex dipped lowest could not.
  if (base.y < 0) { base = base.clone(); base.y = 0; }
  const normal = side.clone().cross(direction).normalize();
  // A card can still swing well underground from a low, near-ground base —
  // a steeply drooping direction, or the mid-row "bow" bump
  // (`normal * sin(t*pi) * length * 0.09`) pointing down too. Lift the
  // WHOLE card rigidly by however much its lowest sampled point would
  // otherwise dip below the floor, rather than reshaping direction/normal:
  // every row is offset from the same `base`, so shifting `base` keeps the
  // animated root and the actual row-0 vertices agreeing exactly, which
  // clamping individual vertices (or only approximating the worst case)
  // could not guarantee. The decision uses `groundCheckLength` — a fixed
  // per-site reference independent of `leafSize`/LOD scaling/per-card
  // random variation — so the SAME shoot attachment lifts (or doesn't) the
  // same way regardless of those, which is what "leafSize changes card
  // size, never branch/root attachment" already guarantees everywhere else.
  // `width` also varies with `leafSize`/LOD; approximate it from the same
  // fixed reference (real cards keep roughly this length:width ratio) so
  // `sideDrop` cannot reintroduce that dependency either.
  const floor = -0.015, sideDrop = Math.abs(side.y) * groundCheckLength * .5 * (width / length || .8);
  let worstY = Math.min(base.y, base.y + direction.y * groundCheckLength) - sideDrop;
  // Always include the mid-row "bow" term in the CHECK (even though only
  // `rows===2` at LOD0 actually draws that row) so a retained card's lift
  // cannot depend on which LOD is asking — it must stay byte-identical.
  worstY = Math.min(worstY, base.y + direction.y * groundCheckLength * .5 + normal.y * groundCheckLength * .09 - sideDrop);
  if (worstY < floor) { base = base.clone(); base.y += floor - worstY; }
  builder.leafRoot = base; builder.leafAxis = direction;
  const rows = lod === 0 && builder.part !== 2 ? 2 : 1, rings = [];
  // The atlas is always 2 columns, but the row count varies per species
  // (`foliageLeafVariantCount`: 4 for the original three species, 8 for
  // every other one added — see `foliageSurfaceTexture.js`).
  const atlasRows = builder.leafVariantRows ?? 2;
  const column = builder.leafVariant % 2, tileRow = Math.floor(builder.leafVariant / 2);
  // Softens the hard, single-flat-quad look a card's own true face normal
  // gives it (every leaf in a cluster shading as one uniform flat patch is
  // most of what read as "large flat single-colour blobs"): blend 0.6 of the
  // way from the card's own geometric normal toward the outward direction on
  // an ellipsoid approximating the whole crown's shape (`skeleton.crown`,
  // computed in `treeGrowth.js`), the way an offline renderer's "bent normal"
  // softens a billboard cluster into looking like it belongs to a round volume.
  const bendNormal = ellipsoid ? vertex => {
    const ex = vertex.x / ellipsoid.radiusXZ, ey = (vertex.y - ellipsoid.centerY) / ellipsoid.radiusY, ez = vertex.z / ellipsoid.radiusXZ;
    const len = Math.hypot(ex, ey, ez) || 1;
    // Cards near the crown's own outer surface (`len` close to 1) face
    // increasingly outward, the way a real canopy's skin does; interior
    // cards keep more of their own geometric normal instead of every card
    // pointing the same generic "outward" direction regardless of depth,
    // which is what actually reads as a hollow shell rather than a solid
    // mass from any viewing angle.
    // 09-14: stronger than the old .35-.7 — both faces of a card now shade
    // with this normal UNFLIPPED (`foliageMaterial.js`), so it must carry the crown.
    const blend = clamp(0.55 + 0.3 * Math.min(1, len), 0, 0.85);
    // The raw envelope normal (ex,ey,ez)/len points straight DOWN on the
    // crown's lower hemisphere, which used to blend every leaf normal there
    // to face away from the sun/sky — a hard bright-top/dark-bottom split on
    // every bush at owner-verdict scale. Push the envelope normal up by a
    // fixed amount before using it so no envelope contribution can point
    // below the horizon; blending toward it (never past it) then keeps
    // every resulting leaf normal at dot(n, up) >= -0.1 (see the
    // `min dot(leafNormal, up)` test in foliage-geometry.test.mjs).
    const envX = ex / len, envY = ey / len + 0.8, envZ = ez / len;
    const envLen = Math.hypot(envX, envY, envZ) || 1;
    const bent = point(
      normal.x + (envX / envLen - normal.x) * blend,
      normal.y + (envY / envLen - normal.y) * blend,
      normal.z + (envZ / envLen - normal.z) * blend,
    ).normalize();
    // A near-vertical card (side/cross terms both ~0, so `ex`/`ez` are ~0 too)
    // sits on the envelope's own polar axis, where an upward push can never
    // rotate a purely-vertical envelope normal away from straight down no
    // matter its magnitude — it only changes length, not direction. The card's
    // own geometric normal can independently be near-vertical too (a twig
    // drooping off a low branch). Belt-and-braces floor: never let the FINAL
    // blended normal itself point below the horizon, lifting only the minimum
    // needed and preserving its horizontal heading.
    if (bent.y < -0.1) {
      const horizontal = Math.hypot(bent.x, bent.z) || 1e-6;
      const scale = Math.sqrt(Math.max(0, 1 - 0.1 * 0.1)) / horizontal;
      bent.x *= scale; bent.z *= scale; bent.y = -0.1;
    }
    vertex.foliageNormal = bent;
  } : null;
  for (let j = 0; j <= rows; j++) {
    const t = j / rows, p = base.clone().addScaledVector(direction, length * t).addScaledVector(normal, Math.sin(t * Math.PI) * length * 0.09);
    const left = p.clone().addScaledVector(side, -width * 0.5), right = p.clone().addScaledVector(side, width * 0.5);
    if (bendNormal) { bendNormal(left); bendNormal(right); }
    rings.push([builder.vertex(left, color, column / 2, (tileRow + t) / atlasRows), builder.vertex(right, color, (column + 1) / 2, (tileRow + t) / atlasRows)]);
  }
  for (let j = 0; j < rows; j++) builder.indices.push(rings[j][0], rings[j][1], rings[j + 1][0], rings[j][1], rings[j + 1][1], rings[j + 1][0]);
}


function createTreeGeometry(options, lod, leaf, bark) {
  const skeleton = growTreeSkeleton(options), builder = new TreeBuilder(options.height);
  const motion = getTreeMotion(skeleton);
  const isPine = isNeedleSpecies(options.species);
  const preset = getTreeSpeciesParams(options.species);
  const variantCount = foliageLeafVariantCount(options.species);
  const limits = [24000, 6000, isPine ? 1400 : 1100];
  // Some species' trunks legitimately fork many times (Black Oak's paper
  // params alone produce dozens of order-0 stems); LOD0 used to have no bark
  // cap at all because the old skeleton never grew that many branches. A real
  // cap, applied thickest-radius-first (`skeleton.branches` is sorted that
  // way — see `treeGrowth.js`), keeps LOD0 within its triangle budget while
  // still favoring the structurally important limbs over excess thin twigs.
  const barkBudgets = [Math.round(limits[0] * .45), isPine ? 1400 : 1300, isPine ? 650 : 390];
  const barkBudget = barkBudgets[lod];
  const layouts = new Map(skeleton.branches.map(branch => [branch, branchLayout(skeleton, branch, lod)]));
  const owner = new Map();
  for (const branch of skeleton.branches) for (const id of branch.ids.slice(1)) owner.set(id, branch);
  const selected = new Set();
  let selectedCost = 0;
  const addBranch = branch => {
    const needed = [], seen = new Set();
    let current = branch;
    while (current && !selected.has(current) && !seen.has(current)) {
      seen.add(current); needed.push(current); current = owner.get(current.ids[0]);
    }
    const cost = needed.reduce((sum, item) => sum + layouts.get(item).triangles, 0);
    if (selectedCost + cost > barkBudget) return;
    for (const item of needed.reverse()) selected.add(item);
    selectedCost += cost;
  };
  // Radius-ranked paths retain their supporting chain. Mid LOD no longer drops
  // all secondary branches; the same fixed triangle budget buys connected pipes.
  for (const branch of skeleton.branches) addBranch(branch);
  for (const branch of skeleton.branches) if (selected.has(branch)) branchTube(builder, skeleton, branch, lod, bark, layouts.get(branch));
  const barkTriangles = builder.indices.length / 3;
  builder.part = isPine ? 2 : 1;

  // Compound twig cards carry many small, separate leaves. Increasing branch
  // coverage therefore buys real leaf area rather than giant leaf silhouettes.
  const template = FOLIAGE_LEAF_CARDS[options.species];
  // A render-only multiplier on the CARD QUAD's physical footprint, distinct
  // from `template.length/width` (which also sizes the shoot geometry baked
  // into the shared leaf atlas texture — inflating those changes how big an
  // individual leaf reads within its tile, not just how big the card is in
  // the scene). This is purely a bigger quad sampling the same atlas tile,
  // so it buys projected crown coverage without touching atlas generation.
  // WIDTH is left at the original 1.22 for every species: raising it (tried
  // during the P1-A twig-mass pass) DOES buy more silhouette fill, but a
  // bigger worst-case `leafCardMinWidthMeters` also lowers the impostor
  // atlas's own chosen tile (`impostorBake.js#chooseImpostorTile` reads
  // `cardWidth` only, never length: a wider worst-case card needs fewer
  // texels/metre to stay legible), pushing Oak/Birch's impostor resolution
  // down as an unwanted side effect. LENGTH has no such side effect, so it
  // carries the rest of the fill improvement for the two large locked
  // templates (Oak/Birch's own 42-leaf mat, already at the 24k triangle
  // ceiling — `MAX_SITES` below is the other, size-free fill lever, but a
  // tall, wide population (Oak Elder: height 13, width 10) can still need
  // a longer card, not just more of them, to clear 85% fill within that
  // fixed budget).
  // ⛔ 09-14: LENGTH AND WIDTH MUST SCALE TOGETHER. The atlas paints leaves in
  // the template's own metres; 1.75 long × 1.22 wide stretched every oak/birch
  // leaf 43% along its twig — the streaky, feathered sprays. The large
  // templates take one uniform 1.45 (fill kept by width, leaf aspect exact);
  // the impostor tile is floored in `FoliageComponent#acquireAtlas` instead.
  const CARD_RENDER_SCALE = SPARSE_LEAF_CLUSTER_SPECIES.has(options.species) || isPine ? 1.22 : 1.45;
  const CARD_LENGTH_SCALE = CARD_RENDER_SCALE;
  // Per-instance random shrink applied to every placed card (`candidates.push`
  // below): length varies over [MIN_LENGTH_VARIATION, +.24], width further
  // over [MIN_WIDTH_VARIATION, +.165] on top of that. The impostor bake's
  // tile-size chooser (`impostorBake.js#chooseImpostorTile`) needs the WORST
  // card an atlas will ever actually place, not the nominal one — recorded
  // once here (`leafCardMinWidthMeters` below) so it can never drift out of
  // sync with the random ranges actually used a few lines down.
  const MIN_LENGTH_VARIATION = 0.82, MIN_WIDTH_VARIATION = 0.91;
  const cardLength = template.length * options.leafSize * CARD_LENGTH_SCALE;
  const cardWidth = template.width * options.leafSize * CARD_RENDER_SCALE;
  const nominalLeafLength = template.leafLength * options.leafSize;
  const nearBark = Math.min(skeleton.branches.reduce((sum, branch) => sum + branchLayout(skeleton, branch, 0).triangles, 0), barkBudgets[0]);
  const availableCards = Math.max(0, Math.floor((limits[0] - nearBark) / (isPine ? 2 : 4)));
  const crownArea = isPine ? 1 : clamp(Math.pow(options.width * options.crownSpread / FOLIAGE_SPECIES[options.species].width, 1.6)
    * Math.pow(options.height / FOLIAGE_SPECIES[options.species].height, .2), .06, 1.40);
  // A small width relative to the species' own default (a shrub-scale preset,
  // or a production population's narrow crownSpread) combined with the
  // schema's own leafDensity floor (0.5) can round `preset.leaves.count * 90
  // * crownArea * leafDensity` down to a bare few dozen cards even though the
  // triangle budget has plenty of room left; floor at whatever's smaller of
  // a sane minimum and the actual budget, so a real production population
  // never renders a leafless or near-leafless crown.
  const targetCards = Math.max(Math.min(200, availableCards), Math.min(Math.round(preset.leaves.count * 90 * crownArea * options.leafDensity), availableCards));
  // 09-14: broadleaf mid .40 → .60. The mid tier read as bare limbs with a few
  // tufts (58% of the near canopy on oak, ~3k of its 6k triangles): the
  // limb-injected cards were near-only. They now reach mid too and displace
  // ordinary cards exactly as on near, so mid needs the larger share to keep
  // its ordinary crown — and, injection being LOD-independent, every mid card
  // stays one the near tier also draws.
  const budgetCards = Math.floor((limits[lod] - barkTriangles) / (lod === 0 && !isPine ? 4 : 2));
  const targetAtLOD = Math.max(0, Math.min(Math.round(targetCards * (isPine ? [1, 0.30, 0.14] : [1, 0.60, 0.19])[lod]), budgetCards));
  const sites = new Set(skeleton.tips);
  if (isPine) {
    for (const node of skeleton.nodes) if (node.parent > 0 && node.order > 0 && node.position.y > options.height * 0.16 && motion.nodes[node.id].flex > 0.08) sites.add(node.id);
    // A conifer's density-weighted level-1 placement (real ones do thin out
    // toward the apex) can leave the trunk's own leading shoot bare above the
    // topmost lateral whorl. Real conifers still needle-cover that leader; add
    // its own last few segments so the crown never exposes a bald tip.
    for (const node of skeleton.nodes) if (node.order === 0 && node.position.y > options.height * 0.85) sites.add(node.id);
  } else {
    // Populate the actual outer twig network, including subterminal attachments,
    // instead of stacking a regular star of cards around terminal nodes only.
    for (const tip of skeleton.tips) {
      let node = skeleton.nodes[tip];
      for (let back = 0; back < 2 && node.parent > 0; back++) {
        node = skeleton.nodes[node.parent];
        if (node.order > 0 && node.radius < options.height * 0.009) sites.add(node.id);
      }
    }
  }
  // A species whose trunk itself forks a lot (Black Oak) can end up with
  // thousands of candidate twig sites — far more than any LOD will ever draw
  // a card at. Sample a bounded, evenly-spread subset instead of walking
  // every one: candidate generation is O(sites), and an unbounded site count
  // was blowing well past the 40 ms/prototype budget for exactly this case.
  // The six newly authored broadleaves carry a much smaller, real cluster
  // card (`foliageSurfaceTexture.js`'s `makeSparseBroadleafVariant`, ~0.25-
  // 0.4m vs oak/birch's locked ~0.7-0.85m). Capping their site count at the
  // same 320 as a large-card species left the pool-division count (`cards`
  // above) at 2-3 per site same as everyone else, but spread across so few
  // sites that the small cards' total leaf AREA collapsed to a bare fraction
  // of a large-card species' — a canopy of visibly bald branches. Letting
  // these six use more sites (same triangle cost per card either way, and
  // `availableCards`/`targetCards` already budget for it) restores the
  // canopy's actual coverage while the "2-3 crossed cards per site" shape
  // this brief asks for still falls out naturally from the same pool-
  // division formula once there are enough sites for it to land near 2-3.
  // Legacy oak/birch's own large 320-site cap meant a canopy with a card
  // budget in the thousands stacked ~15-20 overlapping cards on each of only
  // 320 twigs, spreading none of that area to the twigs between them — read
  // by an owner's review as "leaf cards cluster in flat clumps with gaps
  // between them so branches show through." Spreading the SAME total card
  // budget over far more distinct twig sites (no triangle-budget change: the
  // existing LOD/budget maths downstream already caps total cards) is what
  // turns those clumps into an actual continuous mass. Pine/spruce are
  // unaffected (`isPine` needle placement keeps its own tuned spread).
  const MAX_SITES = isPine ? 320 : SPARSE_LEAF_CLUSTER_SPECIES.has(options.species) ? 1400 : 2600;
  let siteIds = [...sites].sort((a, b) => a - b);
  if (siteIds.length > MAX_SITES) {
    // An evenly-spread-by-ID sample can drop every site out at one extremity
    // (IDs are creation order, not position), and every LOD builds its own
    // card pool from THIS list — a bark budget that shrinks at distant LODs
    // then shrinks the whole silhouette instead of just thinning the bark,
    // because no leaf card was left out there to keep it. Force the six
    // extremal sites in before spreading the rest by ID.
    const extremeMeasures = [n => n.x, n => -n.x, n => n.y, n => -n.y, n => n.z, n => -n.z];
    const kept = new Set();
    for (const measure of extremeMeasures) {
      let best = siteIds[0], bestValue = -Infinity;
      for (const id of siteIds) { const value = measure(skeleton.nodes[id].renderPosition); if (value > bestValue) { bestValue = value; best = id; } }
      kept.add(best);
    }
    const stride = siteIds.length / MAX_SITES;
    for (let i = 0; kept.size < MAX_SITES && i < MAX_SITES; i++) kept.add(siteIds[Math.floor(i * stride)]);
    siteIds = [...kept].sort((a, b) => a - b);
  }
  // Crown ellipsoid for the leaf-normal bend (see `leafSprayCard`) and the
  // spray orientation below: radius from the skeleton's own (already
  // crown-radius-clamped) extent, vertical span from where branch/leaf-bearing
  // nodes actually sit — a bald sapling falls back to a sane band inside `treeGrowth.js`.
  const ellipsoid = { radiusXZ: skeleton.crown.radius, centerY: (skeleton.crown.minY + skeleton.crown.maxY) / 2,
    radiusY: Math.max((skeleton.crown.maxY - skeleton.crown.minY) / 2, skeleton.crown.radius * 0.5) };
  // The outward, sky-biased crown normal at a point — the same envelope
  // `leafSprayCard` bends normals toward (pushed up so the underside never faces down).
  const crownFacing = p => {
    const ex = p.x / ellipsoid.radiusXZ, ey = (p.y - ellipsoid.centerY) / ellipsoid.radiusY, ez = p.z / ellipsoid.radiusXZ;
    const len = Math.hypot(ex, ey, ez) || 1;
    return point(ex / len, ey / len + 0.8, ez / len).normalize();
  };
  const candidates = [];
  // The pool only needs to comfortably exceed what will actually be kept
  // (`targetCards`/`cardCount`); generating the full `availableCards` budget
  // regardless of how many sites exist re-does that many times more work
  // than any LOD draws.
  const poolCards = Math.min(availableCards, Math.ceil(targetCards * 1.15) + 60);
  const highest = skeleton.nodes.reduce((best, node) => node.renderPosition.y > best.renderPosition.y ? node : best, skeleton.nodes[0]).id;
  for (let index = 0; index < siteIds.length; index++) {
    // Build one density-independent ranked pool. Low-density shrubs must still
    // sample the whole crown, not just the earliest lower branches by node ID.
    // At least 2 per site regardless of how the total divides across however
    // many candidate sites exist: a site landing on the short end of an
    // integer split (needle species previously floored to a bare 0 or 1) is
    // what a live scatter's authored leafDensity/branchDensity/crownSpread
    // combination could round down to a visibly bald twig.
    const tip = siteIds[index], cards = Math.max(2, isPine
      ? Math.floor(targetCards / siteIds.length) + (index < targetCards % siteIds.length ? 1 : 0)
      : Math.ceil(poolCards / siteIds.length));
    const shoot = [tip];
    while (shoot.length < 4 && skeleton.nodes[shoot.at(-1)].parent > 0) shoot.push(skeleton.nodes[shoot.at(-1)].parent);
    if (shoot.length < 2) continue;
    for (let i = 0; i < cards; i++) {
      const random = foliageRandom(options.seed + tip * 7919 + i * 6113 + 3181);
      // Broadleaf: heavily bias toward the TERMINAL segment (back=0, the
      // actual last-level twig ending at `tip` itself) instead of spreading
      // uniformly across up to 3 segments back — a card landing far back on
      // an earlier segment leaves the true twig END uncovered, which is what
      // read as "long thin bare twigs poking out beyond the foliage" (real
      // bark reaching past every leaf attached to it). Pine/spruce needle
      // placement is unchanged.
      const back = isPine ? Math.min(shoot.length - 2, Math.floor(random() * Math.min(3, shoot.length - 1)))
        : random() < 0.78 ? 0 : Math.min(shoot.length - 2, 1);
      const node = skeleton.nodes[shoot[back]], parent = skeleton.nodes[shoot[back + 1]];
      const tangent = node.renderPosition.clone().sub(parent.renderPosition).normalize();
      const side0 = point(Math.abs(tangent.y) > 0.9 ? 1 : 0, Math.abs(tangent.y) > 0.9 ? 0 : 1, 0).cross(tangent).normalize();
      const cross = tangent.clone().cross(side0), angle = random() * Math.PI * 2;
      const radial = side0.clone().multiplyScalar(Math.cos(angle)).addScaledVector(cross, Math.sin(angle));
      // Broadleaf: every card lands in the terminal 35% of its segment
      // (`along` >= .65); the first card at each site sits essentially AT the
      // tip (.90-.99, or exactly the old .97 for the tree's own single
      // highest leader) so a leaf cluster always CAPS the twig end, not just
      // occasionally reaches it. Pine/spruce needle placement is unchanged.
      const along = isPine ? (tip === highest && i === 0 ? 0.97 : 0.07 + random() * 0.88)
        : i === 0 ? (tip === highest ? 0.97 : 0.90 + random() * 0.09) : 0.65 + random() * 0.30;
      const base = parent.renderPosition.clone().lerp(node.renderPosition, along);
      const direction = tangent.clone().multiplyScalar(isPine ? 0.88 : 0.72).addScaledVector(radial, isPine ? 0.48 : 0.76);
      // `attractionUp` (paper leaf table) drives the twig/leaf tilt directly:
      // Weeping Willow's -3 droops, Poplar's 1.5 stands upright, everything
      // else lands in between — no more per-species boolean special case.
      direction.y += clamp(preset.leaves.attractionUp * 0.12, -0.4, 0.3);
      // The terminal-segment bias above (`back`/`along`) now samples the
      // literal LAST segment of a twig far more often — exactly where a
      // gnarled species' own high curveV can leave the freshest, steepest
      // local curl. `leafSprayCard`'s ground-safety lift checks a fixed
      // WORST-CASE swept length (independent of the actual leafSize/LOD, by
      // design — see its own comment) against `direction.y`; an
      // near-vertical direction there does not clip a real card into the
      // ground, it teleports the recorded root a metre or more away from the
      // twig it supposedly grows from. Real leaf sprays fan outward from a
      // twig, not straight down, so bound the vertical component before the
      // ground check ever sees it.
      // ⭐ 09-14: a leaf spray lies flat-ish and rarely stands up — the old .75
      // ceiling aimed crown-top sprays at the sky, silhouetted as flames/feathers.
      if (!isPine) direction.y = clamp(direction.y, -0.45, 0.3);
      direction.normalize();
      // Broadleaf: the spray faces OUT of the crown (card normal = the crown
      // envelope normal, `crownFacing`), rolled ±60° at random so a site's
      // cards still cross — leaves orient toward the light, which the old
      // fixed 0/60/120° stack around the spray axis never did. Pine unchanged.
      let side = isPine ? null : direction.clone().cross(crownFacing(base));
      if (!side || side.lengthSq() < 1e-4) side = point(0, 1, 0).addScaledVector(radial, 0.36).cross(direction);
      side.normalize();
      if (side.lengthSq() < 0.5) side = side0.clone();
      side.applyAxisAngle(direction, isPine ? (random() - 0.5) * 2.8 : (random() - 0.5) * 2.1);
      const variation = MIN_LENGTH_VARIATION + random() * 0.24, widthVariation = MIN_WIDTH_VARIATION + random() * 0.165;
      // ±8% per card. A real HSL hue jitter was tried and reverted: at a
      // fully saturated authored hue (`leafColor:'#00ff00'`, which several
      // tests use specifically to verify NO other channel reaches a leaf
      // vertex) any HSL lightness or hue change away from the color's own
      // exact midpoint necessarily makes the zero channel(s) nonzero — a
      // scalar RGB multiply is the only variation that provably cannot leak
      // into a channel the authored color never had.
      const tint = leaf.clone().multiplyScalar(0.92 + random() * 0.16);
      const parentMotion = motion.nodes[parent.id], nodeMotion = motion.nodes[node.id];
      const parentFlex = parentMotion.limb === nodeMotion.limb ? parentMotion.flex : 0;
      const phase = foliageRandom(options.seed + tip * 104729 + i * 15485863)() * Math.PI * 2;
      const rank = tip === highest && i === 0 ? -2 : i + foliageRandom(options.seed + tip * 65537 + i * 433)();
      candidates.push({ base, direction, side, length: cardLength * variation, width: cardWidth * variation * widthVariation, tint,
        motion: { ...nodeMotion, flex: parentFlex + (nodeMotion.flex - parentFlex) * along }, phase, rank,
        variant: Math.floor(foliageRandom(options.seed + tip * 49999 + i * 81231)() * variantCount), tip, index: i });
    }
  }
  // A level-1 LIMB's own leaf mass otherwise comes entirely from whatever
  // order-2+ twigs happened to grow off it — under budget rationing
  // (`deepScale`), a crown-envelope tip retraction that yanks a twig's tip
  // back toward the crown ball, or just a long limb with few descendants,
  // that mass can end up bunched near the limb's own base or pulled fully
  // into the crown, leaving the limb's outer reach structurally bare bark
  // ("a compact ball crown sitting on top of a trunk while thick limbs sweep
  // out with almost no leaves"). Inject cards directly on any REAL limb's own
  // outer 60% (skipping degenerate near-zero-length stems, common once a
  // trunk's own splits multiply order-1 counts far past the species table)
  // at a guaranteed high rank, so a limb outside the crown envelope is
  // foliated along its own length rather than left to depend on descendants
  // that may not exist or may have been pulled away from it.
  // A card injected purely per BRANCH RECORD (one `growStem` invocation's own
  // chain) undercounts a limb that forks internally (`segSplits`): each
  // continuation restarts its own short "own length" from its own split
  // point rather than the WHOLE limb's length from its real trunk
  // attachment, so several individually-short continuations of one long limb
  // could each fall under the length floor and the limb as a whole never got
  // injected at all. Group by the whole conceptual LIMB instead — its first
  // node (the real trunk attachment) plus every order-1 descendant reachable
  // through its own further splits — matching `growTreeSkeleton`'s own
  // median-radius envelope fix (`limbRootOf`) so both stages agree on what
  // one "limb" is.
  const limbRootCache = new Map();
  const limbRootOf = id => {
    if (limbRootCache.has(id)) return limbRootCache.get(id);
    const node = skeleton.nodes[id];
    let result = -1;
    if (node.order >= 1 && node.parent >= 0) {
      const parent = skeleton.nodes[node.parent];
      result = parent.order === 0 ? id : limbRootOf(node.parent);
    }
    limbRootCache.set(id, result);
    return result;
  };
  const injectAlongPath = (path, pathDist, total) => {
    for (const frac of [0.2, 0.35, 0.5, 0.65, 0.8, 0.9, 1]) {
      const target = frac * total;
      let idx = 1;
      while (idx < path.length - 1 && pathDist[idx] < target) idx++;
      const node = skeleton.nodes[path[idx]], parent = skeleton.nodes[path[idx - 1]];
      const tangent = node.renderPosition.clone().sub(parent.renderPosition);
      if (tangent.lengthSq() < 1e-10) continue;
      tangent.normalize();
      // Two cards per length-fraction (crossed, like a real twig-cluster
      // site elsewhere in this file) instead of one: a single card per stop
      // along the limb still left visible gaps in the projected silhouette
      // once the outlier limbs above were actually shortened rather than
      // just re-foliated.
      for (let k = 0; k < 2; k++) {
        const random = foliageRandom(options.seed + node.id * 7919 + Math.round(frac * 1000) * 131 + 97 + k * 5011);
        const side0 = point(Math.abs(tangent.y) > 0.9 ? 1 : 0, Math.abs(tangent.y) > 0.9 ? 0 : 1, 0).cross(tangent).normalize();
        const cross = tangent.clone().cross(side0), angle = random() * Math.PI * 2;
        const radial = side0.clone().multiplyScalar(Math.cos(angle)).addScaledVector(cross, Math.sin(angle));
        const base = parent.renderPosition.clone().lerp(node.renderPosition, 0.4 + random() * 0.5);
        const direction = tangent.clone().multiplyScalar(0.65).addScaledVector(radial, 0.85);
        direction.y = clamp(direction.y + preset.leaves.attractionUp * 0.12, -0.45, 0.3);
        direction.normalize();
        let side = direction.clone().cross(crownFacing(base));
        if (side.lengthSq() < 1e-4) side = point(0, 1, 0).addScaledVector(radial, 0.36).cross(direction);
        side.normalize();
        if (side.lengthSq() < 0.5) side = side0.clone();
        side.applyAxisAngle(direction, (random() - 0.5) * 2.1);
        const variation = MIN_LENGTH_VARIATION + random() * 0.24, widthVariation = MIN_WIDTH_VARIATION + random() * 0.165;
        const tint = leaf.clone().multiplyScalar(0.92 + random() * 0.16);
        candidates.push({ base, direction, side, length: cardLength * variation, width: cardWidth * variation * widthVariation, tint,
          motion: motion.nodes[node.id], phase: random() * Math.PI * 2, rank: -1.5,
          variant: Math.floor(random() * variantCount), tip: node.id, index: 0 });
      }
    }
  };
  // LOD0 only: the forced high-priority rank on these candidates (`-1.5`,
  // below every ordinary card) all but guarantees survival regardless of
  // budget, which at a far LOD's much smaller `cardCount` let them crowd out
  // the ordinary near-center cards and spread the far LOD's own silhouette
  // WIDER than LOD0's rather than the other way round. The far LODs already
  // shrink their own card count/reach on purpose (`targetAtLOD`, `lodScale`);
  // this coverage guarantee only needs to hold at the near tier a viewer
  // actually inspects a limb from.
  // Spread the first retained card across the canopy before taking extra
  // cards from a dense shoot. Extremal attachments survive, preserving the
  // silhouette. This MUST run before the LOD0-only limb-coverage injection
  // below: those injected candidates can themselves be the most extreme
  // point in some direction, which would force a DIFFERENT ordinary
  // candidate to earn `rank = -1` at LOD0 (where the injected ones exist)
  // than at LOD1/2 (where they don't) — the same ordinary candidate then
  // survives the final rank cutoff at one LOD but not another, breaking the
  // "a card retained across LODs keeps the same attachment" invariant.
  const extrema = [
    p => p.x, p => -p.x, p => p.y, p => -p.y, p => p.z, p => -p.z,
  ];
  for (const measure of extrema) {
    let extreme = null, maximum = -Infinity;
    for (const candidate of candidates) {
      const value = measure(candidate.base);
      if (value > maximum) { maximum = value; extreme = candidate; }
    }
    if (extreme) extreme.rank = -1;
  }
  // 09-14: near AND mid (see `targetAtLOD`) — without it the mid tier showed
  // long bare limbs. The far LOD2 stays excluded for the reason above.
  if (!isPine && lod <= 1) {
    // Every level-1 LIMB: BFS from its own first node (the real trunk
    // attachment) across every further order-1 descendant it grows via its
    // own internal splits, and inject along the single LONGEST path from
    // attachment to farthest reach — the limb's own main extension, which is
    // exactly the part that reads as bare bark when its leaf mass otherwise
    // comes only from whatever order-2+ twigs happened to survive budget
    // rationing or got pulled away by crown-envelope tip retraction.
    const limbGroups = new Map();
    for (const node of skeleton.nodes) {
      if (node.order !== 1) continue;
      const root = limbRootOf(node.id);
      if (root < 0) continue;
      if (!limbGroups.has(root)) limbGroups.set(root, []);
      limbGroups.get(root).push(node.id);
    }
    for (const [root] of limbGroups) {
      const attach = skeleton.nodes[skeleton.nodes[root].parent];
      const distFromAttach = new Map([[root, skeleton.nodes[root].renderPosition.distanceTo(attach.renderPosition)]]);
      const prev = new Map([[root, attach.id]]);
      const queue = [root];
      while (queue.length) {
        const cur = queue.shift();
        for (const childId of skeleton.nodes[cur].children) {
          if (skeleton.nodes[childId].order !== 1) continue;
          distFromAttach.set(childId, distFromAttach.get(cur) + skeleton.nodes[childId].renderPosition.distanceTo(skeleton.nodes[cur].renderPosition));
          prev.set(childId, cur);
          queue.push(childId);
        }
      }
      let tipId = root, tipDist = 0;
      for (const [id, d] of distFromAttach) if (d > tipDist) { tipDist = d; tipId = id; }
      if (tipDist < 0.5) continue; // degenerate stub, not a real structural limb
      const path = [];
      for (let cur = tipId; cur !== attach.id; cur = prev.get(cur)) path.push(cur);
      path.push(attach.id);
      path.reverse();
      const pathDist = path.map(id => id === attach.id ? 0 : distFromAttach.get(id));
      injectAlongPath(path, pathDist, tipDist);
    }
    // A node-budget-starved order-0 stem (a co-dominant leader or trunk
    // split that never got its turn at `attachChildren` before the shared
    // 4200-node ceiling hit — breadth-first draining means whichever order-0
    // stem is queued LAST can lose the whole budget to earlier siblings) is
    // structurally identical to a bald level-1 limb: real bark, zero
    // descendants, zero leaves. Only bald ones (`children.length === 0` at
    // the branch's own tip) need this — an order-0 stem that DID get a real
    // level-1 canopy already has coverage from the loop above.
    for (const branch of skeleton.branches) {
      if (branch.order !== 0 || branch.ids.length < 2) continue;
      const tipNode = skeleton.nodes[branch.ids[branch.ids.length - 1]];
      if (tipNode.children.length) continue;
      const ids = branch.ids, dist = [0];
      for (let i = 1; i < ids.length; i++) dist.push(dist[i - 1] + skeleton.nodes[ids[i]].renderPosition.distanceTo(skeleton.nodes[ids[i - 1]].renderPosition));
      if (dist.at(-1) < 0.5) continue;
      injectAlongPath(ids, dist, dist.at(-1));
    }
  }
  candidates.sort((a, b) => a.rank - b.rank || a.tip - b.tip || a.index - b.index);
  const lodScale = (isPine ? [1, 1.5, 1.85] : [1, 1.2, 1.6])[lod];
  const cardCount = Math.min(targetAtLOD, candidates.length);
  // Fixed reference for the ground-floor lift decision only (see
  // `leafSprayCard`): the worst case over `leafSize`, LOD (`lodScale` is
  // deliberately bigger at far LODs) and per-card length variation, so
  // changing any of those cannot move a card's recorded root — a retained
  // card must keep the exact same root switching LOD, and `leafSize` must
  // only ever resize a card, never move its attachment. `leafSize`'s own
  // clamped ceiling (`resolveTreeShapeParameters`, 1.5) stands in for the
  // ACTUAL `options.leafSize` here rather than reading it: a production
  // population authors leafSize well above 1 (valleyEcology's hazel-study is
  // 1.35), and using the real value would just move the goalposts by however
  // much leafSize itself changed — this must already assume the worst leafSize
  // ANY instance could carry, a fixed constant, so the lift decision stays
  // exactly as leafSize-independent as the card's actual root position is.
  const groundCheckLength = template.length * 1.5 * CARD_LENGTH_SCALE * (isPine ? 1.85 : 1.6) * 1.06;
  builder.leafVariantRows = variantCount / 2;
  // Diagnostic-only record of the depth-darkening factor actually applied to
  // each card (see below); not read by any render path, only by
  // `foliage-geometry.test.mjs` to confirm the ramp stays continuous instead
  // of collapsing back into a two-level flag.
  const leafDarkenSamples = new Set();
  for (const card of candidates.slice(0, cardCount)) {
    builder.branchMotion = card.motion; builder.leafPhase = card.phase; builder.leafVariant = card.variant;
    let tint = card.tint;
    // A card sitting well inside the crown envelope (not out near its own
    // surface) is background mass a viewer never focuses on, not one of the
    // lit outer leaves — darkening it (never brightening) is a cheap stand-in
    // for the depth/occlusion an offline renderer would actually compute, and
    // is what makes the crown read as a solid volume instead of a uniformly
    // lit paper shell from every angle.
    // A SMOOTH ramp by normalised depth inside the crown envelope, never a
    // two-level flag (a `< 0.72` threshold used to snap every card straight
    // between 1.0 and 0.8 tint, which is exactly the hard split an owner's
    // screenshot caught as a bright/dark banding artefact rather than depth
    // shading): the darkest core cards (`len` near 0) sit at 0.75, the
    // surface (`len` >= 1) at the full 1.0, continuous in between.
    if (ellipsoid) {
      const ex = card.base.x / ellipsoid.radiusXZ, ey = (card.base.y - ellipsoid.centerY) / ellipsoid.radiusY, ez = card.base.z / ellipsoid.radiusXZ;
      const depth = clamp(Math.hypot(ex, ey, ez), 0, 1);
      const darken = 0.75 + 0.25 * depth;
      leafDarkenSamples.add(Math.round(darken * 1000) / 1000);
      tint = tint.clone().multiplyScalar(darken);
    }
    leafSprayCard(builder, card.base, card.direction, card.side, card.length * lodScale, card.width * lodScale, tint, lod, groundCheckLength, ellipsoid);
  }
  const geometry = builder.finish();
  geometry.name = `Foliage ${options.species} LOD${lod}`;
  geometry.userData.foliage = { species: options.species, seed: options.seed, lod, height: options.height, width: options.width,
    tree: { ...skeleton.stats, algorithm: skeleton.algorithm, ...resolveTreeShapeParameters(options),
      leafLengthMeters: nominalLeafLength, maximumLeafLengthMeters: nominalLeafLength * 1.14,
      leafCardLengthMeters: cardLength, leafCardWidthMeters: cardWidth,
      leafCardMinWidthMeters: cardWidth * MIN_LENGTH_VARIATION * MIN_WIDTH_VARIATION, leavesPerCard: template.leaves,
      leafAtlasVariants: variantCount, leafLODScale: lodScale, cardCount, barkTriangles, renderedBranches: selected.size,
      renderedSecondaryBranches: [...selected].filter(branch => branch.order > 1).length,
      skeletonSeed: skeleton.seed, motionLimbs: motion.limbs.length,
      triangleBudget: limits[lod], geometryBytes: geometry.index.array.byteLength + [...new Set(Object.values(geometry.attributes).map(a => a.data ?? a))].reduce((sum, data) => sum + data.array.byteLength, 0),
      leafDarkenSamples: [...leafDarkenSamples].sort((a, b) => a - b) } };
  return geometry;
}

function meadow(builder, options, lod, random, leaf, flower) {
  const { height: h, width: w, species } = options;
  const flowering = species === "wildflowers";
  const bladeCount = flowering ? 14 : 30;
  const stride = [1, 2, 5][lod];
  // Shading a blade as if its cross-section were round, rather than the flat
  // ribbon it really is, is what separates grass from cut paper. The normal is
  // splayed toward each edge by this much.
  const roundness = flowering ? 0 : 0.62;
  const cosRound = Math.cos(roundness), sinRound = Math.sin(roundness);
  const dry = new THREE.Color("#c8c076");
  for (let i = 0; i < bladeCount; i++) {
    // A wider spread makes neighbouring clumps meet instead of standing as
    // separate tufts on bare ground, at no extra triangle cost.
    const angle = random() * Math.PI * 2, radius = Math.sqrt(random()) * w * (flowering ? 0.34 : 0.52);
    // A blade leans where it likes. Leaning along its own radius turned every
    // clump into an identical fountain, which is what reads as fake at range.
    const lean = flowering ? angle : random() * Math.PI * 2;
    const y = h * (flowering ? 0.48 + random() * 0.52 : 0.30 + random() * 0.78);
    const bend = w * (flowering ? 0.12 + random() * 0.25 : 0.09 + random() * 0.29);
    const thickness = w * (flowering ? 0.025 + random() * 0.025 : 0.016 + random() * 0.021);
    const vigour = 0.72 + random() * 0.46;
    const tint = leaf.clone().multiplyScalar(vigour);
    if (i % stride) continue;
    const root = point(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
    builder.windRoot = root; builder.bladeHeight = y;
    builder.bladeLength = 0.5 * Math.sqrt(y * y + 4 * bend * bend) + y * y / (4 * bend) * Math.asinh(2 * bend / y);
    const side = point(-Math.sin(lean), 0, Math.cos(lean));
    const direction = point(Math.cos(lean), 0, Math.sin(lean));
    builder.bladeDirection = direction;
    // Circular arcs preserve the existing root/tip and width while exposing
    // actual rest length. Flowers retain their accepted geometry and select
    // the root-rotation fallback via a negative angle.
    builder.curveAngle = flowering ? -2 : 2 * Math.atan2(bend, y);
    if (!flowering) builder.bladeLength = Math.hypot(y, bend) * builder.curveAngle / (2 * Math.sin(builder.curveAngle / 2));
    const segments = [4, 2, 1][lod];
    let previousLeft, previousRight, previousShade;
    for (let j = 0; j <= segments; j++) {
      const t = j / segments;
      const center = root.clone().addScaledVector(direction, bend * t * t); center.y = y * t;
      if (!flowering && j > 0 && j < segments) {
        const oldCenter = center.clone(), radius = builder.bladeLength / builder.curveAngle;
        center.copy(root).addScaledVector(direction, radius * (1 - Math.cos(builder.curveAngle * t)));
        center.y = radius * Math.sin(builder.curveAngle * t);
        builder.maxRestFitDisplacement = Math.max(builder.maxRestFitDisplacement ?? 0, center.distanceTo(oldCenter));
      }
      // A blade keeps most of its width to mid-height and then runs to a point,
      // instead of tapering as a plain triangle from the very base.
      const profile = flowering ? 1 - t : Math.pow(1 - t * t, 0.62);
      const width = thickness * profile * (lod === 2 ? 1.7 : 1);
      const left = center.clone().addScaledVector(side, -width), right = center.clone().addScaledVector(side, width);
      if (!flowering) {
        left.foliageT = t; right.foliageT = t;
        // Tangent of the rest arc at t, so the splayed normal follows the bend.
        const along = builder.curveAngle * t;
        const tangent = direction.clone().multiplyScalar(Math.sin(along)).add(point(0, Math.cos(along), 0)).normalize();
        const face = tangent.clone().cross(side).normalize();
        left.foliageNormal = face.clone().multiplyScalar(cosRound).addScaledVector(side, -sinRound).normalize();
        right.foliageNormal = face.clone().multiplyScalar(cosRound).addScaledVector(side, sinRound).normalize();
      }
      // Light reaches the top of the sward, not the litter it grows out of.
      const shade = flowering ? tint
        : tint.clone().multiplyScalar(0.62 + 0.56 * Math.pow(t, 0.7)).lerp(dry, Math.pow(t, 3) * 0.34 * vigour);
      if (j > 0) {
        builder.shadedTri(previousLeft, left, previousRight, previousShade, shade, previousShade);
        if (j < segments) builder.shadedTri(previousRight, left, right, previousShade, shade, shade);
      }
      previousLeft = left; previousRight = right; previousShade = shade;
    }
  }
  if (!flowering) return;
  for (let i = 0; i < 7; i++) {
    const angle = i * 2.399963, radius = w * (0.12 + random() * 0.21);
    const root = point(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
    const top = root.clone().add(point(Math.sin(angle) * w * 0.07, h * (0.65 + random() * 0.35), Math.cos(angle) * w * 0.07));
    builder.windRoot = root; builder.bladeHeight = top.y; builder.bladeLength = top.distanceTo(root);
    builder.bladeDirection = top.clone().sub(root).normalize(); builder.curveAngle = -1;
    builder.attachmentT = undefined;
    const tint = flower.clone().lerp(new THREE.Color("#fff5d1"), random() * 0.35);
    if (lod === 2 && i % 2) continue;
    builder.tube(root, top, w * 0.006, w * 0.003, leaf, lod === 0 ? 5 : 3, 0.8, [4, 2, 1][lod]);
    if (lod < 2) for (let k = 0; k < 3; k++) {
      builder.attachmentT = 0.25 + k * 0.2;
      builder.leaf(root.clone().lerp(top, builder.attachmentT), w * 0.22, w * 0.06, angle + k * 2.4, 0.4, leaf, lod === 0 ? 1 : 0);
    }
    builder.attachmentT = 1;
    const petals = lod === 2 ? 4 : 7;
    for (let j = 0; j < petals; j++) {
      const a = j / petals * Math.PI * 2;
      const center = top.clone().add(point(Math.sin(a) * w * 0.045, 0, Math.cos(a) * w * 0.045));
      builder.leaf(center, w * 0.10, w * 0.065, a, 0.15, tint, lod === 0 ? 1 : 0);
    }
    builder.crown(top.clone().add(point(0, w * 0.009, 0)), w * 0.022, new THREE.Color("#e7b439"), 0, 0.5);
  }
}

/** Dimensions are metres. LODs share the seed/branch layout and reduce geometry only. */
export function createFoliagePrototype(props = {}, lod = 0) {
  const species = Object.hasOwn(FOLIAGE_SPECIES, props.species) ? props.species : "oak";
  const defaults = FOLIAGE_SPECIES[species];
  const options = {
    ...props, ...resolveTreeShapeParameters(props), species, seed: finite(props.seed, 1),
    height: clamp(finite(props.height, defaults.height), 0.02, 100),
    width: clamp(finite(props.width, defaults.width), 0.02, 100),
  };
  lod = clamp(Math.floor(finite(lod, 0)), 0, 2);
  const leaf = new THREE.Color(props.leafColor || defaults.leafColor);
  const bark = new THREE.Color(props.barkColor || defaults.barkColor);
  const flower = new THREE.Color(props.flowerColor || defaults.flowerColor);
  const builder = new Builder(options.height, species === "grass" || species === "wildflowers");
  const random = foliageRandom(options.seed);
  if (species === "grass" || species === "wildflowers") meadow(builder, options, lod, random, leaf, flower);
  else return createTreeGeometry(options, lod, leaf, bark);
  const geometry = builder.finish();
  geometry.name = `Foliage ${species} LOD${lod}`;
  geometry.userData.foliage = { species, seed: options.seed, lod, height: options.height, width: options.width, maxRestFitDisplacementMeters: builder.maxRestFitDisplacement ?? 0 };
  return geometry;
}
