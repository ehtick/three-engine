import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { createHash } from "node:crypto";
import { createFoliagePrototype, FOLIAGE_SPECIES } from "../src/modules/foliage/foliageGeometry.js";
import { getTreeMotion, growTreeSkeleton, TREE_GROWTH_LIMITS } from "../src/modules/foliage/treeGrowth.js";
import { FOLIAGE_LEAF_ATLAS, FOLIAGE_BROADLEAF_CARDS, getFoliageBroadleafTemplate } from "../src/modules/foliage/foliageSurfaceTexture.js";

for (const species of Object.keys(FOLIAGE_SPECIES)) {
  test(`${species}: deterministic usable geometry with decreasing LOD costs`, () => {
    const geometries = [0, 1, 2].map(lod => createFoliagePrototype({ species, seed: 37 }, lod));
    try {
      const counts = geometries.map(g => g.index.count / 3);
      assert.ok(counts[0] > counts[1] && counts[1] > counts[2], `${species} triangle counts: ${counts}`);
      assert.ok(counts[0] <= 24000, "prototype geometry has a fixed practical budget");
      assert.ok(counts[1] <= 6000, "middle LOD is bounded for large-area use");
      const duplicate = createFoliagePrototype({ species, seed: 37 });
      const variant = createFoliagePrototype({ species, seed: 38 });
      assert.deepEqual(geometries[0].attributes.position.array, duplicate.attributes.position.array);
      assert.notDeepEqual(geometries[0].attributes.position.array, variant.attributes.position.array);
      duplicate.dispose(); variant.dispose();
      for (const geometry of geometries) {
        const n = geometry.attributes.position.count;
        for (const name of ["position", "normal", "color", "uv"]) {
          assert.equal(geometry.attributes[name].count, n, `${name} covers every vertex`);
          assert.ok(geometry.attributes[name].array.every(Number.isFinite), `${name} is finite`);
        }
        assert.ok(geometry.index.array.every(i => i >= 0 && i < n));
        const wind = geometry.attributes.foliageWind ?? geometry.attributes.treeBranchAxis;
        assert.equal(wind.count, n);
        for (let i = 0; i < n; i++) {
          const weight = wind.itemSize === 1 ? wind.getX(i) : wind.getW(i);
          assert.ok(weight >= 0 && weight <= 1);
        }
        assert.ok(geometry.boundingSphere.radius > 0);
        assert.ok(geometry.boundingBox.min.y > -0.02, "prototype is anchored at the ground");
        assert.ok(geometry.boundingBox.max.y > FOLIAGE_SPECIES[species].height * 0.5);
        assert.equal(geometry.groups.length, 0, "one material and draw per LOD batch");
        if (species === "pine") {
          let foliageTop = 0;
          const { position, color } = geometry.attributes;
          for (let i = 0; i < position.count; i++) if (color.getY(i) > color.getX(i)) foliageTop = Math.max(foliageTop, position.getY(i));
          assert.ok(foliageTop >= FOLIAGE_SPECIES.pine.height * 0.98, "needle sprays cover the leader, without an exposed bare top");
        }
      }
      if (species !== "grass" && species !== "wildflowers") {
        const near = geometries[0].boundingBox.getSize(new THREE.Vector3());
        const far = geometries[2].boundingBox.getSize(new THREE.Vector3());
        // Far LOD cards are drawn larger to compensate for fewer of them
        // (`lodScale`), which is a bigger fraction of a SMALL plant's own
        // size than a full-grown tree's — an absolute floor keeps a compact
        // species (shrub, ~2 m) from failing on centimetres. Oak/Maple's own
        // `baseSplits: 0` (co-dominant leaders removed — see
        // `treeGrowth.js`'s `HIGH_BOLE_SPECIES`) means far LOD's thickest-
        // first bark budget increasingly favors a few genuinely long main
        // stems rather than many shorter co-dominant ones, letting the far
        // silhouette run a bit wider relative to the near tier than before.
        for (const axis of ["x", "y", "z"]) assert.ok(Math.abs(near[axis] - far[axis]) < Math.max(near[axis] * 0.32, 1.1), `${axis} crown silhouette survives LOD`);
      }
    } finally { geometries.forEach(g => g.dispose()); }
  });
}

// Mirrors src/engine/world/valleyEcology.js's tree/shrub group props exactly
// (that table is private to `valleyEcologySteps`, so the seven populations are
// reproduced here rather than imported). A live receipt from the World found
// `birch-tall` rendering as a bare pole beyond its near LOD: `tree-quality.test.mjs`
// already locks the near tier (LOD0) down for every one of these populations,
// but nothing checked the MID tier (LOD1, the one an on-screen crossfade
// actually switches to first) with these exact authored combinations, nor that
// every tier shares one ground origin — the two gaps this covers.
const VALLEY_ECOLOGY_POPULATIONS = [
  ["oak-wide", { species: "oak", seed: 21, height: 11, width: 8.8, leafDensity: 1.5, leafSize: 1.28, branchDensity: 1.25, crownBase: -.08, crownSpread: .96 }],
  ["oak-elder", { species: "oak", seed: 76, height: 13, width: 10, leafDensity: 1.55, leafSize: 1.24, branchDensity: 1.25, crownBase: -.07, crownSpread: .96 }],
  ["birch-tall", { species: "birch", seed: 53, height: 12, width: 6, leafDensity: 1.5, leafSize: 1.2, branchDensity: 1.2, crownBase: -.05, crownSpread: 1 }],
  ["pine-tall", { species: "pine", seed: 38, height: 14, width: 6.3, leafDensity: 1.35, leafSize: 1.15, branchDensity: 1.1, crownBase: -.05, crownSpread: 1 }],
  ["hazel-study", { species: "oak", seed: 125, height: 1.8, width: 2.9, leafDensity: 1.6, leafSize: 1.35, branchDensity: 1.4, crownBase: -.15, crownSpread: 1.2 }],
  ["young-growth", { species: "birch", seed: 142, height: 2.8, width: 2.6, leafDensity: 1.5, leafSize: 1.25, branchDensity: 1.2, crownBase: -.15, crownSpread: 1.15 }],
  ["accent", { species: "oak", seed: 207, height: 12, width: 7.2, leafDensity: 1.45, leafSize: 1.24, branchDensity: 1.15, crownBase: -.06, crownSpread: .98 }],
];

test("every valleyEcology population keeps real mid-LOD leaf coverage, anchored at the same ground origin as its near LOD", () => {
  for (const [id, props] of VALLEY_ECOLOGY_POPULATIONS) {
    const near = createFoliagePrototype(props, 0), mid = createFoliagePrototype(props, 1);
    try {
      assert.ok(mid.userData.foliage.tree.cardCount >= 150,
        `${id}: mid-LOD leaf cards ${mid.userData.foliage.tree.cardCount} must be at least 150`);
      // FoliageComponent instances only these two tiers ([`geometries[0]`,
      // `geometries[1]`] — the impostor billboard bakes from `geometries[0]`
      // too, never a third tree-shaped mesh); a mismatch here is exactly what
      // reads on screen as the mid-LOD crossfade popping the trunk up or down.
      assert.ok(Math.abs(mid.boundingBox.min.y - near.boundingBox.min.y) <= 0.05,
        `${id}: mid-LOD bbox min y ${mid.boundingBox.min.y} must match near-LOD's ${near.boundingBox.min.y} within 0.05m`);
      assert.ok(Math.abs(near.boundingBox.min.y) <= 0.05, `${id}: near-LOD trunk base ${near.boundingBox.min.y} must sit at y=0`);
    } finally { near.dispose(); mid.dispose(); }
  }
});

test("grass dimensions scale root/tip positions independently without changing topology", () => {
  const base = createFoliagePrototype({ species: "grass", seed: 99, height: 1, width: 1 });
  const scaled = createFoliagePrototype({ species: "grass", seed: 99, height: 2, width: 3 });
  assert.equal(base.attributes.position.count, scaled.attributes.position.count);
  for (let i = 0; i < base.attributes.position.array.length; i++) {
    const t = base.attributes.foliageBlade.getW(Math.floor(i / 3));
    if (t > 0 && t < 1) continue; // Intermediate points refit the physical arc.
    const factor = i % 3 === 1 ? 2 : 3;
    assert.ok(Math.abs(base.attributes.position.array[i] * factor - scaled.attributes.position.array[i]) < 1e-6);
  }
  base.dispose(); scaled.dispose();
});

test("rooted grass stays fixed while blade tips carry wind deformation", () => {
  const geometry = createFoliagePrototype({ species: "grass", height: 1 });
  const { position, foliageWind } = geometry.attributes;
  let roots = 0, tips = 0;
  for (let i = 0; i < position.count; i++) {
    if (position.getY(i) === 0) { assert.equal(foliageWind.getX(i), 0); roots++; }
    if (position.getY(i) > 0.7) { assert.ok(foliageWind.getX(i) > 0.7); tips++; }
  }
  assert.ok(roots > 20 && tips > 10);
  geometry.dispose();
});

test("tree trunk normals point outward and authored colors reach actual vertices", () => {
  const geometry = createFoliagePrototype({ species: "pine", leafColor: "#00ff00", barkColor: "#ff0000" });
  const { position, normal, color } = geometry.attributes;
  // The pine's first vertices are its circular trunk rings; inverted winding
  // makes a sunlit stem shade as if its entire surface faced inward.
  for (let i = 0; i < 8; i++) assert.ok(position.getX(i) * normal.getX(i) + position.getZ(i) * normal.getZ(i) > 0);
  assert.equal(color.getX(0), 1); assert.equal(color.getY(0), 0);
  assert.ok(Array.from({ length: color.count }, (_, i) => color.getY(i)).some(value => value > 0.5));
  geometry.dispose();
});

test("invalid dimensions and LOD cannot produce NaN or unbounded geometry", () => {
  const geometry = createFoliagePrototype({ species: "unknown", height: Infinity, width: -8, seed: NaN }, Infinity);
  assert.equal(geometry.userData.foliage.species, "oak");
  assert.ok(geometry.attributes.position.array.every(Number.isFinite));
  assert.ok(geometry.index.count <= 36000);
  geometry.dispose();
});

test("tree foliage uses small irregular twig templates, never giant leaves or solid crowns", () => {
  // The first screenshot exposed solid green balls inside the leaf clouds.
  // Folded cards carry distinct physical leaves on connected small shoots. Species style
  // must come from the atlas silhouette, never an opaque crown or one large leaf.
  for (const species of ["oak", "birch"]) for (const lod of [0, 1, 2]) {
    const geometry = createFoliagePrototype({ species, leafColor: "#00ff00", barkColor: "#ff0000" }, lod);
    const { position, color } = geometry.attributes;
    const meta = geometry.userData.foliage.tree;
    assert.equal(meta.leavesPerCard, FOLIAGE_BROADLEAF_CARDS[species].leaves);
    assert.equal(meta.leavesPerCard, 42, "six lateral shoots and their leader carry many small leaves within the existing card budget");
    for (let variant = 0; variant < FOLIAGE_LEAF_ATLAS.variants; variant++) {
      assert.equal(getFoliageBroadleafTemplate(species, variant).leaves.length, meta.leavesPerCard, "metadata describes the actual rasterized template");
    }
    assert.equal(meta.leafAtlasVariants, FOLIAGE_LEAF_ATLAS.variants);
    assert.equal(meta.leafAtlasVariants, 4, "four genuine templates break up repeated twig silhouettes");
    assert.ok(meta.leafLengthMeters <= (species === "oak" ? 0.11 : 0.085));
    assert.ok(meta.maximumLeafLengthMeters <= (species === "oak" ? 0.125 : 0.095));
    assert.equal(geometry.attributes.treeLeafAxis.count, position.count);
    const edges = new Map(), neighbors = [];
    const vertexKey = i => `${position.getX(i)},${position.getY(i)},${position.getZ(i)}`;
    for (let i = 0; i < geometry.index.count; i += 3) {
      const indices = [0, 1, 2].map(offset => geometry.index.getX(i + offset));
      if (!indices.every(index => color.getY(index) > 0 && color.getX(index) === 0)) continue;
      const triangle = neighbors.length; neighbors.push([]);
      for (let edge = 0; edge < 3; edge++) {
        const key = [vertexKey(indices[edge]), vertexKey(indices[(edge + 1) % 3])].sort().join("|");
        const existing = edges.get(key);
        if (existing !== undefined) { neighbors[triangle].push(existing); neighbors[existing].push(triangle); }
        else edges.set(key, triangle);
      }
    }
    const seen = new Set();
    let fragments = 0;
    for (let i = 0; i < neighbors.length; i++) {
      if (seen.has(i)) continue;
      const stack = [i]; let count = 0;
      while (stack.length) {
        const triangle = stack.pop();
        if (seen.has(triangle)) continue;
        seen.add(triangle); count++; stack.push(...neighbors[triangle]);
      }
      assert.equal(count, lod === 0 ? 4 : 2, `${species} LOD${lod} fragment is a folded/flat alpha card`); fragments++;
    }
    assert.ok(fragments > 100);
    geometry.dispose();
  }
});

test("growth is deterministic, bounded and shared across LOD generation", () => {
  for (const species of ["oak", "birch", "pine", "weeping-willow", "maple"]) {
    const props = { species, ...FOLIAGE_SPECIES[species], seed: 53 };
    const skeleton = growTreeSkeleton(props), again = growTreeSkeleton(props);
    assert.equal(skeleton, again, "material/LOD callers reuse one skeleton");
    assert.ok(skeleton.stats.nodes <= TREE_GROWTH_LIMITS.nodes);
    assert.ok(skeleton.stats.branches > 10, "crown is a branched skeleton, not disconnected radial sticks");
    for (const node of skeleton.nodes.slice(1)) {
      assert.ok(node.parent >= 0 && node.parent < node.id, "one acyclic rooted topology");
      const parent = skeleton.nodes[node.parent];
      assert.ok(parent.children.includes(node.id));
      assert.ok(parent.radius >= node.radius - 1e-9, "supporting pipe cannot be narrower than its branch");
      assert.ok(node.position.distanceTo(parent.position) > 1e-6);
      assert.ok(node.position.toArray().every(Number.isFinite));
    }
    const changed = growTreeSkeleton({ ...props, seed: 54 });
    assert.notDeepEqual(skeleton.nodes.map(n => n.position.toArray()), changed.nodes.map(n => n.position.toArray()));
    for (const lod of [0, 1, 2]) {
      const geometry = createFoliagePrototype(props, lod);
      assert.equal(geometry.userData.foliage.tree.nodes, skeleton.stats.nodes);
      assert.equal(geometry.userData.foliage.tree.skeletonSeed, 53);
      geometry.dispose();
    }
  }
});

// Weber-Penn (1995) parametric stems replaced the old space-colonization
// skeleton; a species' silhouette now comes from its published/authored
// parameter table (`treeGrowth.js`) rather than a hand-written scaffold.
test("species skeletons preserve oak forks, birch/aspen fluttering crown and pine apical whorls", () => {
  const oak = growTreeSkeleton({ species: "oak", height: 8, width: 6, seed: 41 });
  const fork = oak.nodes.find(n => n.order === 0 && n.children.filter(id => oak.nodes[id].order === 0).length >= 2);
  assert.ok(fork, "Black Oak's baseSplits/segSplits produce co-dominant trunk forks");
  assert.ok(fork.position.y < 8 * 0.6, "oak divides low, below most of its spreading crown");
  const birch = growTreeSkeleton({ species: "birch", height: 9, width: 4, seed: 41 });
  assert.ok(birch.stats.level1Branches > 20, "Quaking Aspen's level-1 branches fan out along most of the trunk");
  const pine = growTreeSkeleton({ species: "pine", height: 10, width: 4, seed: 41 });
  let apex = pine.nodes[0];
  for (const node of pine.nodes) if (node.order === 0 && node.position.y > apex.position.y) apex = node;
  assert.ok(apex.position.y > 10 * 0.97, "pine retains its apical leader near the full authored height");
  // A whorl is several level-1 boughs clustered at close to the same trunk
  // height, not literally sharing one node — the density-weighted placement
  // spreads their attachment continuously along the trunk the way the paper
  // itself does, so bin by height band instead of by exact shared parent.
  const boughHeights = pine.nodes.filter(n => n.order === 1 && n.parent >= 0 && pine.nodes[n.parent].order === 0)
    .map(n => pine.nodes[n.parent].position.y);
  const band = 10 * 0.05, bins = new Map();
  for (const y of boughHeights) { const key = Math.round(y / band); bins.set(key, (bins.get(key) ?? 0) + 1); }
  const whorls = [...bins.values()].filter(count => count >= 3).length;
  assert.ok(whorls >= 4, "lateral boughs cluster into whorls along the trunk");
});

test("tree regeneration is exact and retained twig templates keep their limb attachments across LODs", () => {
  for (const species of ["oak", "birch", "pine"]) {
    const options = { ...FOLIAGE_SPECIES[species], species, seed: 37 }, skeleton = growTreeSkeleton(options), motion = getTreeMotion(skeleton);
    assert.equal(getTreeMotion(skeleton), motion, "no repeated hierarchy work when building another LOD");
    assert.ok(motion.limbs.length >= 4);
    for (const node of skeleton.nodes) {
      const m = motion.nodes[node.id];
      assert.ok(m.flex >= 0 && m.flex <= 1);
      assert.ok(Math.abs(m.axis.length() - 1) < 1e-6);
      if (m.limb < 0) assert.equal(m.flex, 0, "trunk has no secondary limb rotation");
      else {
        assert.ok(m.pivot.distanceTo(skeleton.nodes[skeleton.nodes[m.limb].parent].renderPosition) < 1e-9, "pivot is a real supporting joint");
        const parent = motion.nodes[node.parent];
        if (m.limb === parent.limb) {
          assert.equal(m.axis, parent.axis); assert.equal(m.pivot, parent.pivot);
          assert.ok(m.flex >= parent.flex, "limb flexibility increases continuously away from its attachment");
        }
      }
    }
    const nearCards = new Map();
    for (const lod of [0, 1, 2]) {
      const geometry = createFoliagePrototype(options, lod), attrs = geometry.attributes, n = attrs.position.count;
      const packed = [attrs.treeBranch, attrs.treeBranchAxis, attrs.treeLeaf, attrs.treeLeafAxis];
      assert.ok(packed.every(a => a.isInterleavedBufferAttribute && a.data === packed[0].data && a.count === n));
      assert.ok(packed[0].data.array.every(Number.isFinite));
      assert.equal(Object.keys(attrs).length + 8, 16, "both matrix attribute inputs fit portable WebGPU");
      assert.equal(new Set(Object.values(attrs).map(a => a.data ?? a)).size + 2, 7, "both matrix buffers fit portable WebGPU");
      // Compare real regenerated output rather than pinning the previous visual
      // design. An intervening build catches accidental shared RNG state; all
      // attributes (including packed motion), topology and bounds must be exact.
      const unrelated = createFoliagePrototype({ ...options, seed: options.seed + 1, leafColor: "#ff00aa" }, (lod + 1) % 3);
      unrelated.dispose();
      const duplicate = createFoliagePrototype({ ...options }, lod);
      try {
        assert.deepEqual(Object.keys(duplicate.attributes).sort(), Object.keys(attrs).sort());
        const checked = new Set();
        for (const [key, attribute] of Object.entries(attrs)) {
          const other = duplicate.attributes[key];
          assert.equal(other.count, attribute.count); assert.equal(other.itemSize, attribute.itemSize);
          assert.equal(other.normalized, attribute.normalized);
          assert.equal(other.offset, attribute.offset); assert.equal(other.data?.stride, attribute.data?.stride);
          const array = attribute.data?.array ?? attribute.array;
          if (checked.has(array)) continue;
          checked.add(array);
          assert.deepEqual(other.data?.array ?? other.array, array, `${species} LOD${lod} ${key} regenerates exactly`);
        }
        assert.deepEqual(duplicate.index.array, geometry.index.array, "regeneration preserves exact topology");
        assert.deepEqual(duplicate.boundingBox, geometry.boundingBox);
        assert.deepEqual(duplicate.boundingSphere, geometry.boundingSphere);
      } finally { duplicate.dispose(); }
      const cardVertices = lod === 0 && species !== "pine" ? 6 : 4;
      const atlasTiles = new Set();
      for (let i = 0; i < n;) {
        if (attrs.treeLeafAxis.getW(i) === 0) { i++; continue; }
        const values = packed.map(a => [a.getX(i), a.getY(i), a.getZ(i), a.getW(i)]);
        const key = values[2].join(",");
        for (let j = 1; j < cardVertices; j++) for (const a of packed) {
          for (const field of ["getX", "getY", "getZ"]) assert.equal(a[field](i + j), a[field](i), "card shares one pivot, axis and branch transform");
        }
        const uv = Array.from({ length: cardVertices }, (_, j) => [attrs.uv.getX(i + j), attrs.uv.getY(i + j)]);
        const minU = Math.min(...uv.map(value => value[0])), maxU = Math.max(...uv.map(value => value[0]));
        const minV = Math.min(...uv.map(value => value[1])), maxV = Math.max(...uv.map(value => value[1]));
        const column = Math.round(minU * FOLIAGE_LEAF_ATLAS.columns), row = Math.round(minV * FOLIAGE_LEAF_ATLAS.rows);
        assert.ok(column >= 0 && column < FOLIAGE_LEAF_ATLAS.columns && row >= 0 && row < FOLIAGE_LEAF_ATLAS.rows);
        assert.equal(minU, column / FOLIAGE_LEAF_ATLAS.columns); assert.equal(minV, row / FOLIAGE_LEAF_ATLAS.rows);
        assert.equal(maxU, (column + 1) / FOLIAGE_LEAF_ATLAS.columns); assert.equal(maxV, (row + 1) / FOLIAGE_LEAF_ATLAS.rows);
        const tile = row * FOLIAGE_LEAF_ATLAS.columns + column;
        atlasTiles.add(tile);
        const root = new THREE.Vector3().fromBufferAttribute(attrs.position, i)
          .add(new THREE.Vector3().fromBufferAttribute(attrs.position, i + 1)).multiplyScalar(.5);
        const tip = new THREE.Vector3().fromBufferAttribute(attrs.position, i + cardVertices - 2)
          .add(new THREE.Vector3().fromBufferAttribute(attrs.position, i + cardVertices - 1)).multiplyScalar(.5);
        assert.ok(root.distanceTo(new THREE.Vector3(...values[2].slice(0, 3))) < 1e-6, "twig starts at its actual animated attachment");
        if (lod === 0) {
          const meta = geometry.userData.foliage.tree;
          assert.ok(tip.distanceTo(root) <= meta.leafCardLengthMeters * 1.14 + 1e-6, "actual near twig length respects physical leaf scale");
          const width = new THREE.Vector3().fromBufferAttribute(attrs.position, i)
            .distanceTo(new THREE.Vector3().fromBufferAttribute(attrs.position, i + 1));
          assert.ok(width <= meta.leafCardWidthMeters * 1.14 + 1e-6, "actual near twig width respects physical leaf scale");
        }
        const attachment = [...values[0], ...values[1].slice(0, 3), ...values[3]];
        if (lod === 0) nearCards.set(key, { attachment, tile });
        else {
          assert.deepEqual(attachment, nearCards.get(key)?.attachment, "retained LOD cards keep their branch and flutter phase");
          assert.equal(tile, nearCards.get(key)?.tile, "retained cards must keep the same leaf silhouette template");
        }
        i += cardVertices;
      }
      assert.equal(atlasTiles.size, FOLIAGE_LEAF_ATLAS.variants, "every geometric LOD uses all leaf templates");
      geometry.dispose();
    }
  }
});

test("meadow motion metadata shares one portable buffer and pins roots", () => {
  for (const species of ["grass", "wildflowers"]) for (const lod of [0, 1, 2]) {
    const geometry = createFoliagePrototype({ species, seed: 37 }, lod);
    const { position, foliageBlade, foliageCurve } = geometry.attributes;
    assert.equal(foliageBlade.count, position.count); assert.equal(foliageBlade.itemSize, 4);
    assert.equal(foliageCurve.data, foliageBlade.data);
    assert.ok(foliageBlade.array.every(Number.isFinite));
    assert.equal(Object.keys(geometry.attributes).length + 8, 15);
    assert.equal(new Set(Object.values(geometry.attributes).map(a => a.data ?? a)).size + 2, 8);
    let roots = 0, tips = 0;
    for (let i = 0; i < position.count; i++) {
      assert.ok(foliageBlade.getZ(i) > 0);
      if (position.getY(i) === 0) { assert.equal(foliageBlade.getW(i), 0); roots++; }
      if (foliageBlade.getW(i) > 0.99) tips++;
    }
    assert.ok(roots > 2 && tips > 2);
    geometry.dispose();
  }
});

test("grass rest arcs retain accepted roots/tips, widths, colors and topology", () => {
  const expected = ["7d20f11987753496ea82028d2565d881816f78ccb5a4a54e17b35c0dc66f0a0d", "8d19dfb27e6516c8a9cb12546e9eb9ed1b5497326b6f9a54af84b7040d959dc1", "82bd27e6bb6601a7b3a1e8db23ae52a14a5051cde75e60bb5c1b87f5f79460fd"];
  for (const lod of [0, 1, 2]) {
    const geometry = createFoliagePrototype({ species: "grass", seed: 37 }, lod), hash = createHash("sha256");
    const { position, foliageBlade: blade, foliageCurve: curve } = geometry.attributes, ends = [];
    for (const key of ["color", "uv"]) { hash.update(key); hash.update(Buffer.from(geometry.attributes[key].array.buffer)); }
    hash.update(Buffer.from(geometry.index.array.buffer));
    for (let i = 0; i < position.count; i++) {
      const angle = curve.getZ(i), t = blade.getW(i), radius = blade.getZ(i) / angle;
      const root = new THREE.Vector3(blade.getX(i), 0, blade.getY(i)), direction = new THREE.Vector3(curve.getX(i), 0, curve.getY(i));
      const side = new THREE.Vector3(-direction.z, 0, direction.x);
      const rest = root.addScaledVector(direction, radius * (1 - Math.cos(angle * t))).addScaledVector(side, curve.getW(i));
      rest.y = radius * Math.sin(angle * t);
      const original = new THREE.Vector3().fromBufferAttribute(position, i);
      assert.ok(rest.distanceTo(original) < 1e-6, "shader rest-arc reconstruction agrees with the actual mesh");
      if (t === 0 || t === 1) ends.push(original.x, original.y, original.z);
    }
    hash.update(Buffer.from(new Float32Array(ends).buffer)); assert.equal(hash.digest("hex"), expected[lod]);
    assert.ok(geometry.userData.foliage.maxRestFitDisplacementMeters <= .04, "approved rest fit stays within four centimetres at default size");
    // A blade is a flat ribbon whose normals are splayed toward its edges, so it
    // shades like a round stem instead of a slip of paper.
    const { normal, color } = geometry.attributes;
    let splay = 0, corners = 0, base = 0, baseCount = 0, tip = 0, tipCount = 0;
    for (let i = 0; i < position.count; i++) {
      assert.ok(Math.abs(Math.hypot(normal.getX(i), normal.getY(i), normal.getZ(i)) - 1) < 1e-5, "authored blade normals stay unit length");
      const luminance = color.getX(i) * .3 + color.getY(i) * .6 + color.getZ(i) * .1;
      if (blade.getW(i) < .05) { base += luminance; baseCount++; }
      if (blade.getW(i) > .95) { tip += luminance; tipCount++; }
    }
    for (let t = 0; t < geometry.index.count; t += 3) {
      const [a, b, c] = [0, 1, 2].map(k => new THREE.Vector3().fromBufferAttribute(position, geometry.index.getX(t + k)));
      const face = b.clone().sub(a).cross(c.clone().sub(a));
      if (face.lengthSq() < 1e-16) continue;
      face.normalize();
      for (let k = 0; k < 3; k++) {
        const vertex = new THREE.Vector3().fromBufferAttribute(normal, geometry.index.getX(t + k));
        splay += Math.acos(Math.min(1, Math.abs(vertex.dot(face)))); corners++;
      }
    }
    assert.ok(corners && splay / corners > .3, `blade normals are splayed off the ribbon plane, not flat: ${(splay / corners).toFixed(3)} rad`);
    assert.ok(baseCount && tipCount && tip / tipCount > base / baseCount * 1.8, "blades are darker in the sward and brighter at the tip");
    geometry.dispose();
  }
});

// Owner verdict (screenshots): World bushes (hazel-study, young-growth, and
// species shrub/oak at small scale) showed a hard horizontal split — dark
// lower half, bright upper half, sharp seam at the equator. Root cause: the
// crown-envelope normal a leaf's own normal is blended toward (see
// `leafSprayCard`) points straight DOWN below the crown's equator, so every
// blended leaf normal there faced away from the sun/sky. Fixed by pushing the
// envelope normal up before blending; these two checks hold it in place.
test("valleyEcology leaf normals never point below the horizon, and depth darkening is a continuous ramp", () => {
  const up = new THREE.Vector3(0, 1, 0);
  for (const [id, props] of VALLEY_ECOLOGY_POPULATIONS) {
    for (const lod of [0, 1]) {
      const geometry = createFoliagePrototype(props, lod);
      try {
        const { normal, treeLeafAxis } = geometry.attributes;
        let minDot = 1, leafVertices = 0;
        for (let i = 0; i < normal.count; i++) {
          if (treeLeafAxis.getW(i) < 0.5) continue; // bark vertex
          leafVertices++;
          const n = new THREE.Vector3().fromBufferAttribute(normal, i);
          minDot = Math.min(minDot, n.dot(up));
        }
        assert.ok(leafVertices > 0, `${id} LOD${lod}: geometry has leaf vertices`);
        assert.ok(minDot >= -0.1 - 1e-6, `${id} LOD${lod}: min dot(leafNormal, up) = ${minDot.toFixed(6)}, must be >= -0.1`);

        const samples = geometry.userData.foliage.tree.leafDarkenSamples;
        assert.ok(samples.length >= 6, `${id} LOD${lod}: only ${samples.length} distinct darkening levels, need >= 6 for a continuous ramp`);
        for (const value of samples) assert.ok(value >= 0.75 - 1e-6 && value <= 1.0 + 1e-6, `${id} LOD${lod}: darkening sample ${value} out of [0.75, 1.0]`);
        // A real two-level flag would produce exactly two clustered values no
        // matter how many cards; assert the samples actually spread across
        // the band rather than bunching at the two old endpoints.
        const spread = samples[samples.length - 1] - samples[0];
        assert.ok(spread > 0.15, `${id} LOD${lod}: darkening samples span only ${spread.toFixed(3)}, too narrow for a ramp`);
      } finally { geometry.dispose(); }
    }
  }
});

test("flowers keep accepted head geometry with rigid attachment weights and flexible stem rings", () => {
  const expected = ["fbbe739dc095d9740ccd708652bef8786e6aa22f8ce225f30afb8c6ee8eed6ff", "99018b2bdfff0b3a60f4228682bcee8516ba6c37a723b1c89f9a7f7e724aa0b7", "17f923a06823ad1028549ccb49fc0119c79cd49ed779e4fee904bb97274cbf09"];
  for (const lod of [0, 1, 2]) {
    const geometry = createFoliagePrototype({ species: "wildflowers", seed: 37 }, lod), attrs = geometry.attributes, hash = createHash("sha256"), stemRings = new Set();
    for (const key of ["position", "color", "uv"]) {
      const a = attrs[key], values = [];
      for (let i = 0; i < a.count; i++) if (attrs.color.getX(i) > attrs.color.getY(i)) {
        for (let j = 0; j < a.itemSize; j++) values.push(a.array[i * a.itemSize + j]);
        assert.equal(attrs.foliageBlade.getW(i), 1, "every head vertex inherits one whole stem-tip transform");
        assert.equal(attrs.foliageCurve.getZ(i), -1);
      }
      hash.update(key); hash.update(Buffer.from(new Float32Array(values).buffer));
    }
    assert.equal(hash.digest("hex"), expected[lod]);
    for (let i = 0; i < attrs.position.count; i++) if (attrs.foliageCurve.getZ(i) === -1) {
      const t = attrs.foliageBlade.getW(i);
      if (attrs.uv.getY(i) === t) stemRings.add(t);
      assert.ok(Math.hypot(attrs.foliageCurve.getX(i), attrs.foliageCurve.getY(i)) < .2, "tilted stem axis is encoded rather than a horizontal blade direction");
    }
    assert.ok(stemRings.size >= [5, 3, 2][lod]);
    geometry.dispose();
  }
});
