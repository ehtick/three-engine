import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { createFoliageMaterial, createFoliageSurfaceMaterial, createFoliageUniforms, updateFoliageUniforms } from "../src/modules/foliage/foliageMaterial.js";
import { FOLIAGE_LEAF_ATLAS, FOLIAGE_BROADLEAF_CARDS, FOLIAGE_LEAF_CARDS, foliageLeafVariantCount, getFoliageBroadleafTemplate, getFoliageSurfaceTextures } from "../src/modules/foliage/foliageSurfaceTexture.js";
import { createFoliagePrototype } from "../src/modules/foliage/foliageGeometry.js";
import { createFoliageMatrixSync } from "../src/modules/foliage/foliageWind.js";
import Attributes from "three/src/renderers/common/Attributes.js";
import Textures from "three/src/renderers/common/Textures.js";
import { AttributeType } from "three/src/renderers/common/Constants.js";

const coverage = image => image.data.reduce((count, value, i) => count + (i % 4 === 3 && value >= 128 ? 1 : 0), 0) / (image.width * image.height);
const tile = (image, variant) => {
  const width = image.width / 2, data = new Uint8Array(width * width * 4);
  for (let y = 0; y < width; y++) {
    const start = ((Math.floor(variant / 2) * width + y) * image.width + variant % 2 * width) * 4;
    data.set(image.data.subarray(start, start + width * 4), y * width * 4);
  }
  return { data, width, height: width };
};

// Sample normalized atlas coordinates as a bilinear, clamp-to-edge GPU sampler
// does. A pixel-count-only gate misses loss between surviving alpha texels.
function filteredCoverage(texture, variant, lod = 100) {
  const levels = Textures.prototype.getMipLevels.call({}, texture, texture.image.width, texture.image.height);
  const image = texture.mipmaps[Math.min(lod, levels - 1)], size = 128;
  const alpha = (x, y) => image.data[(Math.max(0, Math.min(image.height - 1, y)) * image.width
    + Math.max(0, Math.min(image.width - 1, x))) * 4 + 3];
  let hits = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const px = (variant % 2 + (x + .5) / size) * .5 * image.width - .5;
    const py = (Math.floor(variant / 2) + (y + .5) / size) * .5 * image.height - .5;
    const ix = Math.floor(px), iy = Math.floor(py), dx = px - ix, dy = py - iy;
    const lower = alpha(ix, iy) * (1 - dx) + alpha(ix + 1, iy) * dx;
    const upper = alpha(ix, iy + 1) * (1 - dx) + alpha(ix + 1, iy + 1) * dx;
    hits += lower * (1 - dy) + upper * dy > 127.5;
  }
  return hits / (size * size);
}

// Append the former full tail. At one texel per variant its original
// round(targetCoverage * texelCount) rule necessarily asks for ZERO leaf
// texels; the subsequent 1x1 mip inherits that loss. Earlier appended levels
// need only box filtering here: their values cannot change this rounding bug.
function withOldMipTail(texture) {
  const mipmaps = texture.mipmaps.slice();
  while (mipmaps.at(-1).width > 1) {
    const source = mipmaps.at(-1), width = source.width / 2, data = new Uint8Array(width * width * 4);
    for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) for (let c = 0; c < 4; c++) {
      const start = (y * 2 * source.width + x * 2) * 4 + c;
      data[(y * width + x) * 4 + c] = Math.round((source.data[start] + source.data[start + 4]
        + source.data[start + source.width * 4] + source.data[start + source.width * 4 + 4]) / 4);
    }
    if (width === 2) for (let variant = 0; variant < 4; variant++) {
      assert.equal(Math.round(coverage(tile(texture.image, variant))), 0, "old one-texel occupancy rounds to zero");
      data[variant * 4 + 3] = 0;
    }
    mipmaps.push({ data, width, height: width });
  }
  return { ...texture, image: texture.image, mipmaps };
}

test("broadleaf templates carry small independently turned leaves on six connected lateral shoots", () => {
  for (const species of ["oak", "birch"]) for (let variant = 0; variant < 4; variant++) {
    const card = FOLIAGE_BROADLEAF_CARDS[species], template = getFoliageBroadleafTemplate(species, variant);
    assert.equal(template.shoots.length, 6);
    assert.equal(template.leaves.length, 42);
    assert.ok(Object.isFrozen(template) && Object.isFrozen(template.leaves));
    const directions = new Set(), lengths = [];
    const leaderX = y => .5 + Math.sin(y * 2.9) * (variant % 2 ? -.065 : .065) + y * (variant - 1.5) * .013;
    for (const branch of template.shoots) assert.ok(Math.abs(branch.x - leaderX(branch.y)) < 1e-12, "every side shoot joins its leader");
    for (const blade of template.leaves) {
      const length = Math.hypot(blade.dx, blade.dy);
      lengths.push(length);
      assert.ok(length <= (species === "oak" ? .105 : .078) && length > card.leafLength * .4, "actual physical blades retain species scale");
      assert.ok(blade.width * 2 <= (species === "oak" ? .058 : .052), "a larger cluster cannot conceal giant individual leaves");
      assert.ok(blade.width * 2 < length, "simple blades remain longer than wide");
      assert.ok(blade.attachment > 0 && blade.attachment < 1);
      const branch = template.shoots[blade.shoot];
      const root = branch ? [branch.x + branch.dx * blade.attachment, branch.y + branch.dy * blade.attachment]
        : [leaderX(blade.attachment), blade.attachment];
      assert.ok(Math.hypot(blade.x - root[0], blade.y - root[1]) < 1e-12, "every actual leaf has a supporting twig, not a floating filler");
      directions.add(Math.floor((Math.atan2(blade.dy, blade.dx) + Math.PI) / (Math.PI / 4)));
    }
    assert.ok(directions.size >= 6, "leaves turn through several directions rather than repeating parallel fern rows");
    assert.ok(Math.max(...lengths) / Math.min(...lengths) > 1.2, "leaf sizes vary within each connected cluster");
    for (let shoot = -1; shoot < 6; shoot++) assert.equal(template.leaves.filter(blade => blade.shoot === shoot).length, 6);
  }
});

test("tree twig variants retain separate silhouettes and per-tile coverage through useful mips", () => {
  assert.deepEqual(FOLIAGE_LEAF_ATLAS, { columns: 2, rows: 2, tileSize: 256, variants: 4 });
  for (const species of ["oak", "birch", "pine"]) {
    const { leaves, bark } = getFoliageSurfaceTextures(species);
    assert.equal(leaves.image.width, 512);
    const bases = Array.from({ length: 4 }, (_, variant) => tile(leaves.image, variant));
    for (const [variant, base] of bases.entries()) {
      const fraction = coverage(base), alpha = (x, y) => base.data[(y * base.width + x) * 4 + 3];
      assert.ok(fraction > .15 && fraction < .45, `${species} tile ${variant}: a twig contains open air, not a solid card`);
      if (species === "pine") {
        let innerPixels = 0, innerOpaque = 0;
        for (let y = 51; y < 204; y++) for (let x = 102; x < 153; x++) { innerPixels++; if (alpha(x, y) >= 128) innerOpaque++; }
        assert.ok(innerOpaque / innerPixels < .65, "fascicle bases leave gaps instead of a continuous opaque broadleaf-like core");
      }
      for (const mip of leaves.mipmaps.filter(image => image.width >= 16)) {
        assert.ok(Math.abs(coverage(tile(mip, variant)) - fraction) < .035, `${species} tile ${variant}, ${mip.width / 2}px: cutout coverage survives minification`);
      }
      for (let i = 0; i < base.width; i++) {
        assert.equal(alpha(i, 0), 0); assert.equal(alpha(i, base.width - 1), 0);
        assert.equal(alpha(0, i), 0); assert.equal(alpha(base.width - 1, i), 0);
      }
      if (variant > 0) {
        let differences = 0;
        for (let i = 3; i < base.data.length; i += 4) differences += (base.data[i] >= 128) !== (bases[0].data[i] >= 128);
        assert.ok(differences > base.width * base.width * .035, `${species}: changing atlas tiles changes actual silhouettes`);
      }
    }
    assert.equal(coverage(bark.image), 1, "tree trunks stay solid");
    assert.equal(leaves.wrapS, THREE.ClampToEdgeWrapping);
    assert.equal(bark.wrapS, THREE.RepeatWrapping);
    assert.notEqual(leaves, bark, "bark and foliage cannot bleed into each other at distant mip levels");
    assert.equal(getFoliageSurfaceTextures(species).leaves, leaves, "different tree instances share the same small texture");
    assert.ok(new Set([...bark.image.data].filter((_, i) => i % 4 === 0)).size > 30, "bark has actual visible surface variation");
  }
});

test("leaf cutout padding preserves authored brightness and bounded normals without adding coverage", () => {
  for (const species of ["oak", "birch", "pine"]) {
    const image = getFoliageSurfaceTextures(species).leaves.image;
    for (let variant = 0; variant < 4; variant++) {
      const { data } = tile(image, variant);
      let min = 255, max = 0, transparent = 0;
      const normals = new Set();
      for (let i = 0; i < data.length; i += 4) if (data[i + 3] >= 128) {
        min = Math.min(min, data[i]); max = Math.max(max, data[i]);
        normals.add(data[i + 1]); normals.add(data[i + 2]);
      }
      assert.ok(min > 140 && max - min > 12, `${species}: retained leaf albedo has useful restrained variation`);
      assert.ok(normals.size > 8, `${species}: blade/vein relief is present`);
      for (let i = 0; i < data.length; i += 4) if (data[i + 3] === 0) {
        transparent++;
        assert.ok(data[i] >= min && data[i] <= max, "empty RGB copies a leaf/needle from its own tile, avoiding dark filtered outlines");
      }
      assert.ok(transparent > data.length / 8, "RGB padding does not fill transparent coverage");
    }
  }
});

test("extreme tree minification retains filtered leaf coverage without opaque tile borders; old tail fails", () => {
  for (const species of ["oak", "birch", "pine"]) {
    const { leaves, bark } = getFoliageSurfaceTextures(species), terminal = leaves.mipmaps.at(-1);
    assert.equal(leaves.generateMipmaps, false, "the renderer uploads the deliberately bounded explicit chain");
    assert.equal(bark.mipmaps.at(-1).width, 1, "solid bark still uses the complete mip chain");
    for (let level = 1; level < leaves.mipmaps.length; level++) assert.equal(leaves.mipmaps[level].width * 2, leaves.mipmaps[level - 1].width);
    const old = withOldMipTail(leaves);
    for (let variant = 0; variant < 4; variant++) {
      const assertSurvives = texture => {
        const fraction = filteredCoverage(texture, variant);
        assert.ok(fraction > .10 && fraction < .40, `${species} variant ${variant}: distant twig retains sparse filtered leaves`);
      };
      assertSurvives(leaves);
      assert.throws(() => assertSurvives(old), /distant twig retains sparse filtered leaves/);
      assert.equal(filteredCoverage(old, variant), 0, "the former allocated tail erases the entire canopy");
      const edge = tile(terminal, variant), alpha = (x, y) => edge.data[(y * edge.width + x) * 4 + 3];
      for (let i = 0; i < edge.width; i++) {
        assert.equal(alpha(i, 0), 0); assert.equal(alpha(i, edge.width - 1), 0);
        assert.equal(alpha(0, i), 0); assert.equal(alpha(edge.width - 1, i), 0);
      }
    }
  }
});

test("foliage inherits live scene wind with legacy scalar compatibility and zero-force calm", () => {
  const uniforms = createFoliageUniforms();
  const props = { wind: true, windStrength: .8, windGustStrength: .6, windDirection: 180, windSpeed: 9 };
  updateFoliageUniforms(uniforms, props, 42);
  assert.deepEqual(uniforms.direction.value.toArray(), [0, 0, 1]);
  assert.equal(uniforms.strength.value, .8); assert.equal(uniforms.speed.value, 1); assert.equal(uniforms.time.value, 42);
  updateFoliageUniforms(uniforms, props, 50, { vector: [-3, 4, 0], gust: 5, gustFrequency: .25 });
  assert.ok(uniforms.direction.value.distanceTo(new THREE.Vector3(-.6, .8, 0)) < 1e-12);
  assert.equal(uniforms.strength.value, 4); assert.equal(uniforms.speed.value, .25); assert.equal(uniforms.gustStrength.value, .3);
  updateFoliageUniforms(uniforms, props, 55, { vector: -4, gust: 0, gustFrequency: 2 });
  assert.deepEqual(uniforms.direction.value.toArray(), [0, 0, -1]);
  updateFoliageUniforms(uniforms, props, 60, { vector: [0, 0, 0], gust: 0 });
  assert.equal(uniforms.strength.value, 0); assert.ok(uniforms.direction.value.toArray().every(Number.isFinite));
});

test("tree atlas source retains leaf masks and normals while grass retains its original fragment path", () => {
  for (const species of ["oak", "birch", "pine"]) {
    const surface = createFoliageSurfaceMaterial({ species });
    const living = createFoliageMaterial(createFoliageUniforms(), { species });
    assert.equal(surface.positionNode, null, "atlas plants must not freeze a passing gust into their silhouette");
    assert.ok(surface.opacityNode && surface.normalNode && surface.colorNode);
    assert.ok(surface.maskShadowNode, "the shadow pass cannot rely on Three forwarding opacityNode");
    assert.equal(surface.alphaTest, living.alphaTest);
    assert.equal(surface.emissiveNode, null, "leaf backscatter must not become unlit emissive foliage");
    assert.ok(living.positionNode);
    surface.dispose(); living.dispose();
  }
  for (const species of ["grass", "wildflowers"]) {
    const surface = createFoliageSurfaceMaterial({ species });
    assert.equal(surface.opacityNode, null); assert.equal(surface.normalNode, null); assert.equal(surface.colorNode, null);
    assert.equal(surface.alphaTest, 0);
    assert.equal(getFoliageSurfaceTextures(species), null);
    surface.dispose();
  }
});

test("foliage matrix mirrors synchronize before Three uploads static attributes, including partial repacks", () => {
  function fixture(lateSync = false) {
    const source = new THREE.InstancedBufferAttribute(new Float32Array(1100 * 16), 16);
    const mirrors = [0, 1].map(() => new THREE.InstancedInterleavedBuffer(source.array, 16, 1));
    const unrelated = new THREE.InstancedInterleavedBuffer(new Float32Array(source.array.length), 16, 1);
    const compiled = [], sync = createFoliageMatrixSync(source, compiled);
    // The list is populated AFTER the material's TSL function creates its hook.
    for (const mirror of [...mirrors, unrelated]) for (let column = 0; column < 4; column++) compiled.push({ node: { attribute: new THREE.InterleavedBufferAttribute(mirror, 4, column * 4) } });
    const uploaded = new WeakMap(); let writes = 0;
    const attributes = new Attributes({
      createAttribute(attribute) { uploaded.set(attribute.data, attribute.data.array.slice()); },
      updateAttribute(attribute) {
        writes++;
        const mirror = attribute.data, destination = uploaded.get(mirror);
        if (mirror.updateRanges.length) for (const range of mirror.updateRanges) destination.set(mirror.array.subarray(range.start, range.start + range.count), range.start);
        else destination.set(mirror.array);
        mirror.clearUpdateRanges();
      },
    }, { createAttribute() {} });
    const draw = () => {
      if (!lateSync) sync(); // renderer.nodes.updateBefore()
      for (const mirror of mirrors) attributes.update(compiled.find(entry => entry.node.attribute.data === mirror).node.attribute, AttributeType.VERTEX);
      if (lateSync) sync(); // renderer.nodes.updateForRender(): OLD ordering
    };
    draw();
    const repack = (start, count, value) => {
      source.array.fill(value, start, start + count); source.clearUpdateRanges(); source.addUpdateRange(start, count); source.needsUpdate = true;
      draw();
    };
    return { source, mirrors, unrelated, uploaded, repack, draw, get writes() { return writes; } };
  }
  const actual = fixture();
  actual.repack(0, actual.source.array.length, 3);
  for (const mirror of actual.mirrors) assert.deepEqual(actual.uploaded.get(mirror), actual.source.array, "both position and blade-root mirrors see the repack in its FIRST draw");
  actual.repack(0, 3 * 16, 7);
  for (const mirror of actual.mirrors) {
    const values = actual.uploaded.get(mirror);
    assert.equal(values[0], 7); assert.equal(values[3 * 16 - 1], 7); assert.equal(values[3 * 16], 3);
    assert.deepEqual(values, actual.source.array, "partial prefix updates preserve the untouched instance tail");
  }
  assert.equal(actual.unrelated.version, 0, "array ownership excludes unrelated vertex buffers");
  assert.deepEqual(actual.source.updateRanges, [{ start: 0, count: 48 }], "one mirror's upload cannot consume the other mirror's source ranges");
  const writes = actual.writes;
  for (let frame = 0; frame < 20; frame++) actual.draw();
  assert.equal(actual.writes, writes, "unchanged static matrices produce no additional uploads");
  const old = fixture(true);
  old.repack(0, old.source.array.length, 9);
  for (const mirror of old.mirrors) assert.equal(old.uploaded.get(mirror)[0], 0, "the old late hook demonstrably misses the same-frame upload");
});

// P1-A gave the six added broadleaves (plus spruce) an 8-tile atlas (2 columns
// x 4 rows) while oak/birch/pine stayed locked at the original 4 (2x2) — a
// geometry/texture split that, if the two files ever disagreed on columns,
// rows, or which tile a card's UV picks, would sample empty atlas texels and
// alphaTest would discard every leaf silently, at every distance, for
// whichever species drifted. The test above already locks oak/birch/pine
// byte-exact; this one checks EVERY species' atlas layout and every actual
// leaf-card UV a real tree emits, generically, so a future species (or a
// change to either file) cannot reintroduce that split unnoticed.
test("every species' leaf cards sample a tile its own atlas actually painted", () => {
  for (const species of Object.keys(FOLIAGE_LEAF_CARDS)) {
    const variants = foliageLeafVariantCount(species), columns = FOLIAGE_LEAF_ATLAS.columns, rows = variants / columns;
    const { leaves } = getFoliageSurfaceTextures(species);
    assert.equal(leaves.image.width, FOLIAGE_LEAF_ATLAS.tileSize * columns, `${species}: atlas width disagrees with its own declared variant count`);
    assert.equal(leaves.image.height, FOLIAGE_LEAF_ATLAS.tileSize * rows, `${species}: atlas height disagrees with its own declared variant count`);

    // The painter's own coverage per tile, independent of any geometry. Real
    // authored species range from ~8% (Weeping Willow's narrow lanceolate
    // leaves) to ~23% (Black Tupelo) — nowhere near zero, but also nowhere
    // near uniform, so the gate is "clearly painted", not one fixed
    // percentage every species must clear.
    for (let variant = 0; variant < variants; variant++) {
      const fraction = coverage(tile(leaves.image, variant));
      assert.ok(fraction > .05, `${species} tile ${variant}: painted coverage ${(fraction * 100).toFixed(1)}% reads as an effectively empty tile`);
    }

    // Build a real tree and read every actual leaf-card vertex's UV back
    // against that same layout: the geometry side must never pick a
    // column/row the texture side never painted.
    const geometry = createFoliagePrototype({ species }, 0);
    const uv = geometry.attributes.uv, leafAxis = geometry.attributes.treeLeafAxis;
    let leafVertices = 0;
    for (let i = 0; i < uv.count; i++) {
      if (leafAxis.getW(i) === 0) continue; // bark vertex, not a leaf/needle card
      leafVertices++;
      const u = uv.getX(i), v = uv.getY(i);
      assert.ok(u >= -1e-6 && u <= 1 + 1e-6, `${species}: leaf UV.u ${u} escapes the atlas`);
      assert.ok(v >= -1e-6 && v <= 1 + 1e-6, `${species}: leaf UV.v ${v} escapes the atlas`);
      const tileCol = Math.min(columns - 1, Math.floor(u * columns)), tileRow = Math.min(rows - 1, Math.floor(v * rows));
      const variant = tileRow * columns + tileCol;
      assert.ok(variant >= 0 && variant < variants, `${species}: leaf card picked tile ${variant}, outside the ${variants} tiles the atlas painted`);
    }
    assert.ok(leafVertices > 100, `${species}: geometry produced no leaf/needle cards to check`);
  }
});

// Owner receipt: "all leaves look like they have metalness on them,
// characteristic metallic lighting when the camera rotates, plus a bluish
// reflection from the sky." A low roughness floor (.64/.72/.76) combined with
// a full-intensity envMap put a tight, glossy specular lobe and a mirrored
// sky tint on what should be a matte leaf surface, and a full-strength normal
// map swept that lobe hard across the leaf on every small rotation. Locks the
// fix: roughness never dips below .88, the sky's contribution is capped, and
// the per-leaf bump is only applied at half strength.
function findConstNumber(node, depth = 0) {
  if (!node || depth > 20) return null;
  if (typeof node.value === "number") return node.value;
  if (node.bNode) { const v = findConstNumber(node.bNode, depth + 1); if (v !== null) return v; }
  if (node.node) return findConstNumber(node.node, depth + 1);
  if (node.aNode) return findConstNumber(node.aNode, depth + 1);
  return null;
}
function findVector2(node, depth = 0) {
  if (!node || depth > 20) return null;
  if (node.value && typeof node.value === "object" && "x" in node.value && "y" in node.value && !("z" in node.value)) return node.value;
  if (node.scaleNode) { const v = findVector2(node.scaleNode, depth + 1); if (v) return v; }
  if (node.bNode) { const v = findVector2(node.bNode, depth + 1); if (v) return v; }
  if (node.node) return findVector2(node.node, depth + 1);
  if (node.aNode) return findVector2(node.aNode, depth + 1);
  return null;
}

test("leaf roughness never dips below .88, leaves carry no specular, and the normal map is half-strength (no metallic sky sheen)", () => {
  for (const species of ["oak", "pine", "birch", "shrub", "hawthorn"]) {
    const material = createFoliageSurfaceMaterial({ species });
    if (!material.roughnessNode) continue; // species with no surface textures
    const leafRoughness = findConstNumber(material.roughnessNode.ifNode);
    assert.ok(leafRoughness !== null, `${species}: could not locate the leaf roughness literal in the node graph`);
    assert.ok(leafRoughness >= 0.88, `${species}: leaf roughness ${leafRoughness} must be >= .88`);
    // envMapIntensity is ignored by three under scene.environment; the leaf
    // lighting zeroes F0/F90 in setupSpecular and cuts all direct specular.
    assert.ok(Object.hasOwn(material, "setupSpecular"), `${species}: leaf specular must be overridden (F0/F90 -> 0)`);
    assert.equal(material.metalness, 0, `${species}: leaves must stay dielectric (metalness 0)`);
    // Leaves read the unflipped canopy normal (09-14); the map lives on the bark branch.
    const scale = findVector2(material.normalNode.elseNode ?? material.normalNode);
    assert.ok(scale, `${species}: could not locate the normal map scale in the node graph`);
    assert.ok(scale.x <= 0.5 && scale.y <= 0.5, `${species}: normal map scale ${scale.x},${scale.y} must be half-strength or less`);
  }
});
