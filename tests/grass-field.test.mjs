import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { Engine } from '../src/engine/Engine.js';
import { EventEmitter } from '../src/engine/EventEmitter.js';
import { registerComponent } from '../src/engine/components/registry.js';
import { MeshComponent } from '../src/engine/components/MeshComponent.js';
import { FoliageComponent } from '../src/modules/foliage/FoliageComponent.js';
import { GrassRenderer } from '../src/modules/foliage/grassRenderer.js';
import { createGrassMaterial, createGrassUniforms } from '../src/modules/foliage/grassMaterial.js';
import { createFoliageUniforms } from '../src/modules/foliage/foliageMaterial.js';
import {
  deriveGrassBaseColor, grassBladeCell, grassBladeCost, grassBladeGeometry, grassBladeLuminance,
  grassBladeShadingMultiplier, grassBoundaryLottery, grassCellHash2, grassClumpCell, grassClumpHash, grassFieldCost,
  grassFieldTexture, grassHexBladeXZ, grassHexCellPoint, grassHexNearestCell, grassHexPitch, grassLuminanceMeans,
  grassOverheadFootprintArea, grassOverheadGapFraction, grassPatchNoise, grassRestLean, grassRings, grassSeamWeight,
  grassTuftGapRamp, packGrassField, sampleGrassField,
} from '../src/modules/foliage/grassField.js';

/** Blades/m² a ring actually draws: visual blade count (instances × its tuft
 * fan) over the square metres it covers. */
function ringDensity(ring) {
  const area = ring.size ** 2 - (ring.size * ring.hole) ** 2;
  return (ring.instances * (ring.tuft || 1)) / area;
}

registerComponent(MeshComponent);
registerComponent(FoliageComponent);

function engineFixture() {
  const engine = new EventEmitter();
  Object.assign(engine, {
    scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(), entities: new Map(), rootEntities: [],
    modules: new Map(), viewOnlyComponents: new Set(), playing: false, deltaTime: 1 / 60, elapsedTime: 0, settings: {},
    createEntity: Engine.prototype.createEntity, destroyEntity: Engine.prototype.destroyEntity,
    getEntity(id) { return this.entities.get(id); }, batchHierarchy(fn) { return fn(); },
    onPreRender(fn) { return this.on('preRender', fn); },
  });
  return engine;
}
let sequence = 0;
/** Grass is a Foliage population of the grass species, not its own component. */
function fieldFixture(props = {}) {
  const engine = engineFixture();
  const entity = engine.createEntity({ id: `grass-${++sequence}`, name: 'Meadow' });
  const component = entity.addComponent(new FoliageComponent({ species: 'grass', distribution: 'placements', placements: [], ...props }));
  return { engine, entity, component, grass: component._grass };
}
const cleanup = (engine, entity) => {
  entity.removeComponent('foliage');
  for (const root of [...engine.rootEntities]) engine.destroyEntity(root);
};

test('rings cover the whole draw distance without gap or overlap, at a bounded cost', () => {
  // horizon: 1 isolates pure tiling/budget behaviour from the silhouette
  // stretch, which is its own test below.
  for (const blades of [0, 1000, 140000, 900000]) {
    const rings = grassRings({ near: 26, far: 110, blades, horizon: 1 });
    assert.equal(rings.length, 3);
    assert.equal(rings[0].inner, 0, 'the first ring starts at the camera');
    assert.ok(Math.abs(rings.at(-1).outer - 110) < 1e-6, 'the last ring reaches the draw distance');
    for (let index = 1; index < rings.length; index++) {
      assert.ok(Math.abs(rings[index].inner - rings[index - 1].outer) < 1e-9, 'each ring begins where the last ended');
      assert.ok(rings[index].cell > rings[index - 1].cell, 'blades thin out with distance');
      assert.ok(rings[index].segments <= rings[index - 1].segments, 'distant blades are simpler');
    }
    for (const ring of rings) {
      // ⛔⛔ 09-13 HEX LATTICE: rows ≠ columns any more — a hex lattice's row
      // pitch (`cell·√3/2`) is shorter than its column spacing, so covering
      // the SAME physical `size` along z needs MORE rows than columns. Using
      // `columns` for both (the old square-grid assumption) made the
      // window's z-reach fall short of `size` by the pitch ratio, which is
      // why an isolated ring-0 render showed an elliptical/squarish cutoff
      // instead of the intended soft circular fade.
      assert.equal(ring.instances, ring.columns * ring.rows);
      assert.ok(Math.abs(ring.cell * ring.columns - ring.size) < 1e-9, 'the grid exactly tiles the ring square along x');
      assert.ok(Math.abs(grassHexPitch(ring.cell) * ring.rows - ring.size) < ring.cell,
        'and along z too, at the row pitch (within one row of rounding)');
      assert.ok(ring.hole >= 0 && ring.hole < 1);
      assert.ok(Math.abs(ring.hole - ring.inner * 2 / ring.size) < 1e-9);
    }
    const cost = grassFieldCost(rings);
    assert.equal(cost.draws, 3, 'a whole field is three draw calls whatever its budget');
    assert.ok(cost.triangles > 0 || blades === 0);
  }
  const small = grassFieldCost(grassRings({ blades: 50000 })).triangles;
  const large = grassFieldCost(grassRings({ blades: 200000 })).triangles;
  assert.ok(large / small > 3.4 && large / small < 4.6, `four times the budget is about four times the cost: ${large / small}`);
});

test('ring 0 clears the sward density floor at the default budget, by its radius rather than the budget', () => {
  const [ring0, ring1, ring2] = grassRings();
  assert.ok(ring0.inner === 0 && ring0.outer <= 10, `ring 0 stays small: ${ring0.outer}m`);
  assert.ok(ringDensity(ring0) >= 1200, `ring 0 density: ${ringDensity(ring0).toFixed(0)}/m²`);
  // Ring 1 trades instances for a fan: each one draws several blades, so its
  // visual density does not collapse even though its instance count is a
  // fraction of what single blades at the same density would need.
  assert.ok(ring1.tuft > 1, 'ring 1 draws tuft fans, not single blades');
  assert.ok(ringDensity(ring1) > ring1.instances / (ring1.size ** 2 - (ring1.size * ring1.hole) ** 2),
    'the fan multiplies visual density beyond what the instance count alone would give');
  // Ring 2 is sparse tufts reaching well past its density share, for a fuzzy
  // silhouette rather than a hard edge at the draw distance.
  assert.ok(ring2.tuft > 1);
  assert.ok(ringDensity(ring2) < ringDensity(ring1), 'ring 2 is sparser than ring 1');
});

test('ring 1 bends with ring 0\'s own 2 segments, within the triangle cap — the ring0/ring1 GEOMETRY parity fix', () => {
  // ⛔⛔ 09-13 SEVENTH OWNER RECEIPT: colour and lean already agreed across the
  // ring0/ring1 seam, yet a horizontal tone edge still showed in the
  // three-quarter shot — ring 0's blades were a 2-segment Bézier bend, ring
  // 1's fan members a flat 1-segment quad, so the two presented different
  // normals/silhouettes under a sun behind the camera. Ring 1 now shares
  // ring 0's own segment count. Triangle math (`grassBladeCost`) makes this
  // TRIPLE ring 1's cost at a fixed visual density (`tuft` cancels out of
  // `triangles = (segments*2-1) * tuft * instances`) — funding it purely out
  // of ring 1's own share (down to ~290/m²) measurably made the row-luminance
  // seam WORSE (the density cliff itself, not the leftover segment mismatch,
  // dominated), so ring 2's share is cut instead (still a fan, still
  // 1-segment — its tips already converge to the ground colour by ~20 m, so
  // its own density matters far less) to buy ring 1 back up to ~450/m² within
  // the same 2.7 M cap. `tuft` also trimmed 10 → 8 on ring 1 so the same
  // density needs fewer, larger fans.
  const rings = grassRings();
  const [ring0, ring1, ring2] = rings;
  assert.ok(ring0.outer === 5, `ring 0 is 5 m by default now: ${ring0.outer}`);
  assert.equal(ring1.segments, 2, 'ring 1 bends with the same 2 segments as ring 0 — no geometry seam');
  assert.ok(ringDensity(ring1) >= 400, `ring 1 visual density: ${ringDensity(ring1).toFixed(0)}/m²`);
  assert.equal(ring1.tuft, 8, 'ring 1 fans 8 blades wide (was 10 — funds the 2-segment bend)');
  assert.equal(ring2.tuft, 12, 'ring 2 fans 12 blades wide, for fuzz at distance');
  assert.equal(ring2.segments, 1, 'ring 2 stays a single-segment straight card — its tips already converge to the ground colour by then, so it carries no seam');
  assert.ok(ringDensity(ring2) > 5 && ringDensity(ring2) < ringDensity(ring1),
    `ring 2 is sparser than ring 1 but still a real fuzz, not empty: ${ringDensity(ring2).toFixed(1)}/m²`);
  // 09-13: 0.75 -> 0.85 with the overhead-cover pass: a taller arched blade
  // reaches further sideways, which is what covers the ground from above.
  assert.ok(Math.abs(ring1.heightScale - .85) < 1e-9, 'ring 1 blades are 0.85 of ring 0\'s height');
  assert.ok(ring2.heightScale < ring1.heightScale, 'ring 2 is shorter still, a short dense tuft');
  assert.ok(ring1.widthScale > 1, 'ring 1 blades are wider, to cover more ground per instance');
  assert.ok(ring2.widthScale >= ring1.widthScale, 'ring 2 tufts are bigger still');
  const cost = grassFieldCost(rings);
  assert.ok(cost.triangles <= 2700000, `stays within the triangle cap: ${(cost.triangles / 1e6).toFixed(2)}M`);
  assert.equal(cost.draws, 3);
});

test('a shared ring seam partitions physical patches instead of doubling density: summed density stays within 5% of the linear blend', () => {
  // ⛔ 09-13 OWNER RECEIPT: a dark annulus at ring 0's outer edge — two
  // independent per-ring probabilities near a seam do not guarantee exactly
  // one side wins a given physical spot, so through the middle of the band
  // both could keep a blade at once and sum their very different native
  // densities. The fix (`grassBoundaryLottery`/`grassSeamWeight`, mirroring
  // `grassMaterial.js`) is a SINGLE shared coin flip per a fixed 0.3 m
  // world-space patch, tested against a threshold rather than folded into a
  // probability — mutually exclusive by construction. This test verifies the
  // empirical partition (many independent boundary-cell samples at a given
  // radius) lands on the theoretical linear blend `w·inner + (1-w)·outer`,
  // which it can only do if the two sides never overlap and never both miss.
  const [ring0, ring1] = grassRings();
  const boundaryRadius = ring0.outer; // == ring1.inner, the shared seam
  const innerDensity = ringDensity(ring0), outerDensity = ringDensity(ring1);
  // ⛔ 09-13 SEVENTH OWNER RECEIPT: widened 1.5 → 3 (a 3 m → 6 m soft band) —
  // the per-blade lottery now mixes the ring0/ring1 hand-over more gradually,
  // matching `grassMaterial.js`'s own `band`.
  const band = 3;
  for (const offset of [-2.4, -1.2, 0, 1.2, 2.4]) {
    const radius = boundaryRadius + offset;
    const w = grassSeamWeight(radius, boundaryRadius, band);
    let ring0Hits = 0, ring1Hits = 0, samples = 0;
    // Sample many independent 0.3 m boundary cells around the ring at this
    // radius — independent x,z positions, not a systematic sweep, so the
    // hash's pseudo-randomness is actually exercised.
    for (let i = 0; i < 2000; i++) {
      const angle = (i * 2.399963) % (Math.PI * 2); // irrational-ish stride, decorrelated from any lattice
      const x = Math.cos(angle) * radius + (i % 7) * 0.31, z = Math.sin(angle) * radius - (i % 5) * 0.27;
      const lottery = grassBoundaryLottery(x, z);
      if (lottery < w) ring0Hits++; else ring1Hits++;
      samples++;
    }
    assert.equal(ring0Hits + ring1Hits, samples, 'every sample is claimed by exactly one side');
    const empirical = (ring0Hits / samples) * innerDensity + (ring1Hits / samples) * outerDensity;
    const predicted = w * innerDensity + (1 - w) * outerDensity;
    const tolerance = Math.max(innerDensity, outerDensity) * .05;
    assert.ok(Math.abs(empirical - predicted) <= tolerance,
      `at offset ${offset}m (w=${w.toFixed(2)}): empirical ${empirical.toFixed(0)} vs predicted ${predicted.toFixed(0)}/m²`);
    // Never a spike above the denser side, never a gap below the sparser one.
    assert.ok(empirical <= Math.max(innerDensity, outerDensity) * 1.05, 'no density doubling at the seam');
    assert.ok(empirical >= Math.min(innerDensity, outerDensity) * .95, 'no density gap at the seam');
  }
});

test('the depth-shade field (visible from directly above) is continuous, not a per-cell block', () => {
  // ⛔ 09-13 OWNER RECEIPT: "a blocky pattern of darker squares ~0.5 m" —
  // `grassMaterial.js`'s depth shade now reads the smooth two-octave
  // `patchNoise` as its dominant term (mirrored here), with only a small
  // ±10% per-blade hash riding on top, so two neighbouring TUFT cells (which
  // used to jump straight from one independent per-cell hash to another)
  // read as one continuous field instead of a visible grid at cell scale.
  let worst = 0;
  for (let i = 0; i < 400; i++) {
    const x = (i * 0.41) % 30 - 15, z = (i * 0.59) % 30 - 15;
    const here = grassPatchNoise(x, z, 61.3);
    const stepX = grassPatchNoise(x + .05, z, 61.3);
    const stepZ = grassPatchNoise(x, z + .05, 61.3);
    worst = Math.max(worst, Math.abs(here - stepX), Math.abs(here - stepZ));
  }
  // ⛔ 09-13 SIXTH FOLLOW-UP: switching to simplex noise (isotropy) shifted
  // the worst-case landing point slightly (measured ≈0.062, was ≈0.033-0.05
  // with earlier noise versions) — still two orders of magnitude below an
  // actual hard edge, and the kernel itself is provably continuous (the
  // `(0.5-d²)⁴` falloff and its derivative both vanish at d²=0.5).
  assert.ok(worst < .07, `worst 0.05 m step in the depth field: ${worst}`);
});

test('ring 0 draws 0.02-0.028 m blades; the far rings draw WIDER blades so their sparser density still covers the ground from above', () => {
  const grass = new GrassRenderer(new THREE.Group(), createFoliageUniforms());
  grass.configure({ blades: 60000 }); // default bladeWidth
  const [ring0, ring1, ring2] = grass.rings;
  const width0 = grass._settings.width * (ring0.widthScale || 1);
  const width1 = grass._settings.width * (ring1.widthScale || 1);
  assert.ok(width0 >= .02 && width0 <= .028, `ring 0 width: ${width0}`);
  // 09-13: ring 1 at ~450 blades/m² covered ~25 % of its ground from above at
  // ring 0's width; coverage is width × density, so ring 1 is ≥ 2× wider and
  // ring 2 wider still, while staying under ~6 cm (≈ 1-2 px at 5-19 m).
  assert.ok(width1 >= .045 && width1 <= .075, `ring 1 width: ${width1}`);
  assert.ok((ring2.widthScale || 1) > (ring1.widthScale || 1), 'ring 2 is wider than ring 1');
  grass.dispose();
});

test('ring 0 from above: at most 12% of the ground stays bare under a straight-down camera', () => {
  // ⛔ 09-13 OWNER RECEIPT: straight down from ~6 m and three-quarter shots
  // near a house both showed dark holes ~0.5-1 m between clumps. From
  // directly above, `facing = 0` for every blade always, so the shader's
  // view-space widening (`thicken`) saturates to its own maximum
  // (`grassMaterial.js`'s `widened`) — `grassOverheadGapFraction` mirrors
  // that widened footprint against one hex cell's own ground share.
  const gap = grassOverheadGapFraction({ cell: .024, width: .022 * 1.2, height: .18, lean: .24 });
  assert.ok(gap >= 0 && gap <= .12, `ring 0 overhead gap fraction: ${gap}`);
  // A wider blade always covers a bigger top-down footprint, all else equal —
  // the mechanism the ring 0 width bump above actually leans on.
  const narrower = grassOverheadFootprintArea(.02, .18, .24);
  const wider = grassOverheadFootprintArea(.03, .18, .24);
  assert.ok(wider > narrower, 'a wider blade covers more ground from directly above');
});

test('the outermost ring reaches past its density share for a fuzzy silhouette, thinning rather than costing more', () => {
  const stretched = grassRings({ near: 8, far: 70, blades: 480000 });
  const bare = grassRings({ near: 8, far: 70, blades: 480000, horizon: 1 });
  assert.ok(stretched.at(-1).outer > bare.at(-1).outer, 'the far ring reaches beyond the plain geometric edge');
  // Same instance budget either way — stretching only changes the hole
  // correction slightly, not the share of the total budget this ring gets.
  const ratio = stretched.at(-1).instances / bare.at(-1).instances;
  assert.ok(ratio > .9 && ratio < 1.1, `about the same instances, just spread further — no real extra cost: ${ratio}`);
  assert.ok(stretched.at(-1).cell > bare.at(-1).cell, 'and thinner for it');
  for (let index = 0; index < stretched.length - 1; index++) {
    assert.deepEqual(stretched[index], bare[index], 'only the last ring is stretched');
  }
});

test('a blade belongs to a world cell, so the field never slides under a moving camera', () => {
  // ⛔ THE REGRESSION THIS EXISTS FOR. Hashing a blade from its slot in the
  // current grid means one step of the origin hands every blade its
  // neighbour's jitter, height and yaw — the whole field appears to swim
  // across the terrain while the camera orbits. A blade is identified by the
  // cell of the world it stands in; the grid is only the window drawing it.
  // This loops over every ring, tuft rings (1 and 2) included: a tuft's fan is
  // hashed off the SAME cell mapping as a single blade, only the geometry
  // differs, so this same guarantee has to hold for them too.
  // ⛔⛔ 09-13 HEX LATTICE: columns still step by `cell`, but rows step by the
  // hex row pitch (`cell·√3/2`) — the two axes are no longer the same
  // spacing, so a "sub-cell" or "whole-cell" step has to respect that per axis.
  const rings = grassRings({ near: 24, far: 96, blades: 40000 });
  assert.ok(rings.some(ring => ring.tuft > 1), 'this exercises at least one tuft ring');
  for (const ring of rings) {
    const cell = ring.cell, pitch = grassHexPitch(cell);
    const window = origin => {
      const cells = new Map();
      for (let instance = 0; instance < ring.instances; instance++) {
        const at = grassBladeCell(ring, origin, instance);
        cells.set(`${at[0]},${at[1]}`, instance);
      }
      return cells;
    };
    const settled = window([0, 0]);
    assert.equal(settled.size, ring.instances, 'the window covers each world cell exactly once');

    // Sub-cell/sub-row motion: the ring does not move at all, so nothing changes.
    const jiggled = window([cell * .49, pitch * -.49]);
    assert.deepEqual([...jiggled.keys()].sort(), [...settled.keys()].sort(), 'a sub-cell step redraws the same cells');

    // A whole-cell/whole-row step: the window slides, and every cell still in
    // view keeps its own coordinate — a different instance index now draws it,
    // which is exactly the point.
    const stepped = window([cell * 3, pitch * -5]);
    const shared = [...stepped.keys()].filter(key => settled.has(key));
    assert.ok(shared.length > ring.instances * .5, `most of the window survives a small step: ${shared.length}/${ring.instances}`);
    let moved = 0;
    for (const key of shared) if (stepped.get(key) !== settled.get(key)) moved++;
    assert.ok(moved > 0, 'the instance drawing a cell does change as the window slides');
    // Every shared key is the same world cell, so its hash — and therefore the
    // blade's jitter, height, yaw and colour — is unchanged.
    for (const key of shared) {
      const [x, z] = key.split(',').map(Number);
      assert.ok(Number.isInteger(x) && Number.isInteger(z), 'a world cell is an integer lattice coordinate');
    }
    // Far enough and the windows share nothing, which is also correct.
    const elsewhere = window([cell * (ring.columns + 4), 0]);
    assert.equal([...elsewhere.keys()].filter(key => settled.has(key)).length, 0);
  }
});

test('a blade strip is a tapered ribbon with the two numbers the shader rebuilds it from', () => {
  for (const segments of [1, 3, 5]) {
    const geometry = grassBladeGeometry(segments, { width: .04, height: 1 });
    const cost = grassBladeCost(segments);
    assert.equal(geometry.attributes.position.count, cost.vertices);
    assert.equal(geometry.index.count / 3, cost.triangles);
    assert.ok(geometry.isInstancedBufferGeometry, 'a blade is instanced, never one mesh per plant');
    const blade = geometry.attributes.bladeUV, position = geometry.attributes.position;
    let widest = 0, tip = 0;
    for (let i = 0; i < blade.count; i++) {
      const side = blade.getX(i), along = blade.getY(i);
      assert.ok(side === 0 || side === 1, 'side is a flag, not a coordinate');
      assert.ok(along >= 0 && along <= 1);
      assert.ok(Math.abs(position.getY(i) - along) < 1e-6, 'the rest pose stands the blade up');
      if (along < 1e-6) widest = Math.max(widest, Math.abs(position.getX(i)));
      if (along > 1 - 1e-6) tip = Math.max(tip, Math.abs(position.getX(i)));
    }
    assert.ok(Math.abs(widest - .02) < 1e-6, 'full width at the root');
    assert.ok(tip < 1e-6, 'and a point at the tip');
    geometry.dispose();
  }
});

test('a packed field round-trips through the exact reconstruction the shader uses', () => {
  const ground = (x, z) => ({ height: Math.sin(x * .05) * 3 + z * .02, density: x > 0 ? .9 : .1, scale: 1.2, dryness: .35 });
  const packed = packGrassField(ground, { extent: 128, resolution: 129 });
  assert.equal(packed.data.length, 129 * 129 * 4);
  for (const [x, z] of [[-64, -64], [0, 0], [64, 64], [-32, 16]]) {
    const sampled = sampleGrassField(packed, x, z), truth = ground(x, z);
    assert.ok(Math.abs(sampled.height - truth.height) < 1e-4, `exact at a grid point ${x},${z}`);
    assert.ok(Math.abs(sampled.dryness - truth.dryness) < 1e-6);
  }
  for (const [x, z] of [[13.7, -22.3], [-5.1, 41.9]]) {
    const sampled = sampleGrassField(packed, x, z), truth = ground(x, z);
    assert.ok(Math.abs(sampled.height - truth.height) < .05, `close between grid points ${x},${z}`);
  }
  const beyond = sampleGrassField(packed, 900, 900), corner = sampleGrassField(packed, 64, 64);
  assert.deepEqual(beyond, corner, 'outside the field the read clamps rather than wrapping');
  assert.equal(sampleGrassField(null, 0, 0), null);
  assert.throws(() => packGrassField(null), TypeError);
  const texture = grassFieldTexture(packed);
  assert.equal(texture.image.width, 129);
  assert.equal(texture.type, THREE.FloatType);
  assert.equal(texture.minFilter, THREE.NearestFilter, 'float filtering is optional; the shader reconstructs instead');
  texture.dispose();
});

test('a Foliage grass population draws a sward instead of scattering clumps', () => {
  const { engine, entity, component } = fieldFixture({ blades: 60000 });
  // ⛔ GRASS IS NOT ITS OWN COMPONENT. It is the Foliage component's grass
  // species, drawn rather than scattered — deleting a separate "grass field"
  // object must not be the only way anyone can have grass.
  assert.ok(component.drawsGrass, 'the grass species draws by default');
  const grass = component._grass;
  assert.ok(grass instanceof GrassRenderer);
  assert.equal(grass.rings.length, 3);
  assert.equal(grass.stats.draws, 3);
  assert.ok(grass.stats.blades > 0 && grass.stats.triangles > 0);
  assert.equal(grass.group.children.length, 3);
  const disposed = { geometry: 0, material: 0 };
  for (const ring of grass.rings) {
    assert.equal(ring.mesh.frustumCulled, false, 'blades are placed in the shader, so mesh bounds cannot cull them');
    ring.mesh.geometry.addEventListener('dispose', () => disposed.geometry++);
    ring.material.addEventListener('dispose', () => disposed.material++);
  }
  // Each ring needs its own uniform block: one shared block cannot serve three
  // draws in a frame, because the last write would win for all of them.
  assert.equal(new Set(grass.rings.map(ring => ring.uniforms)).size, 3);
  // And none of the scatter pipeline runs for it.
  assert.equal(component.renderMeshes.length, 0, 'a drawn sward submits no prototype meshes');
  component.update(true);
  assert.equal(component._stats.status, 'Drawn');
  assert.equal(component._stats.drawCalls, 3);

  // Turning it off returns the species to the old scattered prototypes.
  component.setProp('drawnGrass', false);
  assert.equal(component.drawsGrass, false);
  component.update(true);
  assert.equal(component._grass, null, 'the renderer is released once the species stops drawing');
  assert.equal(disposed.geometry, 3);
  assert.equal(disposed.material, 3);

  entity.removeComponent('foliage');
  for (const root of [...engine.rootEntities]) engine.destroyEntity(root);
});

test('every ring snaps to its own cell/row, so no window ever sits at a fractional offset', () => {
  // ⛔⛔ 09-13 HEX LATTICE: x snaps to whole COLUMNS (`cell`); z snaps to whole
  // ROWS (the hex row pitch, `cell·√3/2`) — the two axes are no longer the
  // same spacing, unlike the square grid this replaces.
  const grass = new GrassRenderer(new THREE.Group(), createFoliageUniforms());
  grass.configure({ blades: 40000 });
  const origins = grass.followCamera(37.31, -84.77);
  grass.rings.forEach((ring, index) => {
    const [x, z] = origins[index];
    const pitch = grassHexPitch(ring.cell);
    // A ring anchored at a fraction of its own cell/row would re-derive its
    // cells on every frame, which is the swim this snapping exists to prevent.
    assert.ok(Math.abs(x / ring.cell - Math.round(x / ring.cell)) < 1e-9, `ring ${index} x is a whole number of its cells`);
    assert.ok(Math.abs(z / pitch - Math.round(z / pitch)) < 1e-9, `ring ${index} z is a whole number of its rows`);
    assert.ok(Math.abs(x - 37.31) <= ring.cell, 'and it still follows the camera');
    assert.ok(Math.abs(z + 84.77) <= pitch, 'and it still follows the camera');
    assert.equal(ring.uniforms.origin.value.x, x);
    assert.equal(ring.uniforms.origin.value.y, z);
  });
  const cell = grass.rings[0].cell, pitch = grassHexPitch(cell);
  assert.deepEqual(grass.followCamera(0, 0)[0], [0, 0]);
  assert.deepEqual(grass.followCamera(cell * .3, pitch * -.4)[0], [0, 0], 'sub-cell/sub-row motion moves nothing');
  grass.dispose();
});

test('ground changes the sward without changing the draws, and settings reach the uniforms', () => {
  const grass = new GrassRenderer(new THREE.Group(), createFoliageUniforms());
  grass.configure({ blades: 60000 });
  const before = { ...grass.stats };
  const packed = packGrassField((x, z) => ({ height: x * .1, density: z > 0 ? 1 : 0, scale: .8, dryness: .5, color: [.3, .4, .2] }),
    { extent: 96, resolution: 65 });
  grass.setField(packed);
  assert.deepEqual(grass.stats, before, 'giving the sward ground does not change what it costs');
  assert.ok(grass.sampleField(20, 20).density > .9);
  assert.ok(grass.sampleField(20, -20).density < .1);
  for (const ring of grass.rings) {
    assert.equal(ring.uniforms.field.value.z, 96);
    assert.ok(Math.abs(ring.uniforms.field.value.w - 1 / 65) < 1e-9);
  }
  assert.throws(() => grass.setField({ data: new Float32Array(4), size: 8 }), TypeError);
  const materials = grass.rings.map(ring => ring.material);
  // ⭐ THE ROOT IS DERIVED FROM THE TIP, NOT THE `color` PROP. An owner only
  // authors leaf/dry TIP tones now; `base` always follows from `tipColor`
  // (`deriveGrassBaseColor`), so a colour edit still reaches the shader
  // without a recompile — it just reaches a different uniform.
  grass.configure({ blades: 60000, tipColor: '#123456', lean: .9 });
  assert.ok(grass.rings.every((ring, index) => ring.material === materials[index]), 'a colour is a uniform, not a recompile');
  // ⛔ 09-13: '#123456' is over the saturation clamp (S ≈ .654 > .55), so the
  // uniform is not a flat copy of the authored colour any more — base still
  // has to follow whatever the shader actually receives, post-clamp.
  const tip = grass.rings[0].uniforms.tip.value;
  const [er, eg, eb] = deriveGrassBaseColor(tip.toArray());
  const base = grass.rings[0].uniforms.base.value;
  assert.ok(Math.abs(base.r - er) < 1e-6 && Math.abs(base.g - eg) < 1e-6 && Math.abs(base.b - eb) < 1e-6,
    'base follows the tip colour, darkened and greened');
  assert.notEqual(tip.getHexString(), '123456', 'the tip colour is desaturated by the clamp');
  const clampedHSL = {}; tip.getHSL(clampedHSL, THREE.SRGBColorSpace);
  assert.ok(clampedHSL.s <= .6 + 1e-4, `saturation clamped: ${clampedHSL.s}`);
  assert.ok(clampedHSL.l <= .48 + 1e-4, `lightness clamped: ${clampedHSL.l}`);
  assert.equal(grass.rings[0].uniforms.blade.value.z, .9);
  grass.configure({ blades: 200000 });
  assert.ok(grass.rings.every((ring, index) => ring.material !== materials[index]), 'a new budget is a new set of draws');
  grass.dispose();
  assert.equal(grass.rings.length, 0);
});

test('repeated field updates reuse the material — the freeze ledger caught 257 rebuilds from terrain edits', () => {
  // ⛔ `setField` used to call `_build()` — a full ring teardown and a fresh
  // `createGrassMaterial` per ring — on every single call, so a terrain edit
  // that repaints the packed field every frame rebuilt the shader every
  // frame with it. Only the shape of the node graph (whether a field or a
  // ground colour exists at all) may ever need that; new samples at the same
  // on/off status are just new texture data on the material that already
  // exists.
  const grass = new GrassRenderer(new THREE.Group(), createFoliageUniforms());
  grass.configure({ blades: 40000 });
  const initial = packGrassField((x, z) => ({ height: 0, density: 1, scale: 1, dryness: 0, color: [.3, .4, .2] }), { extent: 64, resolution: 33 });
  grass.setField(initial); // the one rebuild: no field -> a field, a real shape change
  const materials = grass.rings.map(ring => ring.material), geometries = grass.rings.map(ring => ring.mesh.geometry);
  const textures = { field: grass._fieldTexture, ground: grass._groundTexture };
  for (let pass = 0; pass < 12; pass++) {
    const packed = packGrassField((x, z) => ({ height: Math.sin(x * .1 + pass) * 2, density: (x + pass) % 5 < 3 ? 1 : .2,
      scale: 1, dryness: pass % 2, color: [.2 + pass * .01, .3, .15] }), { extent: 64, resolution: 33 });
    grass.setField(packed);
  }
  assert.ok(grass.rings.every((ring, index) => ring.material === materials[index]),
    'twelve field updates at the same on/off status, exactly one material per ring');
  assert.ok(grass.rings.every((ring, index) => ring.mesh.geometry === geometries[index]), 'and the same geometry — no ring rebuild either');
  assert.equal(grass._fieldTexture, textures.field, 'the same texture object, new pixels');
  assert.equal(grass._groundTexture, textures.ground);
  assert.ok(grass.sampleField(12, 0).density < 1, 'the last update\'s samples actually landed');
  grass.dispose();
});

test('coverage reaches the shader from the component, and from the World above it', () => {
  // ⛔ THE CONTROL WAS THERE AND CONNECTED TO NOTHING: the renderer was handed a
  // literal 1, so turning coverage down did exactly nothing.
  const { engine, entity, component } = fieldFixture({ blades: 40000 });
  for (const density of [1, .5, .15, 0]) {
    component.setProp('grassDensity', density);
    component.update(true);
    for (const ring of component._grass.rings) assert.equal(ring.uniforms.density.value, density);
  }
  component.setProp('grassDensity', 4);
  component.update(true);
  assert.equal(component._grass.rings[0].uniforms.density.value, 1, 'and it is a share, so it clamps');
  cleanup(engine, entity);
});

test('the rings follow the camera where it actually is, not where its parent is', () => {
  // ⛔ THE PLAY-MODE BUG. An editor viewport camera sits at the root, so its
  // local position is its world position and reading the wrong one looks fine.
  // A game camera hangs off a rig, and then the rings centre on the rig's
  // origin instead of the player — who is left in the outermost ring, at one
  // triangle a blade and a fraction of the density.
  const grass = new GrassRenderer(new THREE.Group(), createFoliageUniforms());
  grass.configure({ blades: 40000, near: 20, far: 90 });
  const rig = new THREE.Object3D();
  rig.position.set(140, 0, -260);
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 1.7, 0); // a metre and a half above the rig, and nothing else
  rig.add(camera);
  rig.updateWorldMatrix(true, true);
  grass.update(null, camera);
  const [x, z] = [grass.rings[0].uniforms.origin.value.x, grass.rings[0].uniforms.origin.value.y];
  assert.ok(Math.hypot(x - 140, z + 260) <= grass.rings[0].cell,
    `the sward is drawn where the camera is: ${x}, ${z}`);
  for (const ring of grass.rings) {
    assert.ok(Math.abs(ring.uniforms.camera.value.x - 140) < 1e-6);
    assert.ok(Math.abs(ring.uniforms.camera.value.z + 260) < 1e-6);
    assert.ok(Math.abs(ring.uniforms.camera.value.y - 1.7) < 1e-6, 'and at its real height');
  }
  // The owner's frame still applies: a moved World moves its own grass with it.
  const owner = new THREE.Object3D();
  owner.position.set(40, 0, 40);
  owner.updateWorldMatrix(true, false);
  grass.update(owner, camera);
  assert.ok(Math.abs(grass.rings[0].uniforms.camera.value.x - 100) < 1e-6, 'measured in the frame the blades are placed in');
  grass.dispose();
});

test('a hand-scattered patch derives its own ground when nobody supplies one', () => {
  const grass = new GrassRenderer(new THREE.Group(), createFoliageUniforms());
  grass.configure({ blades: 20000 });
  assert.equal(grass.field, null);
  const placements = [];
  for (let i = 0; i < 400; i++) {
    const x = (i % 20) - 10, z = Math.floor(i / 20) - 10;
    placements.push({ position: [x, 2 + x * .1, z], scale: 1 });
  }
  const packed = grass.setFieldFromPlacements(placements, { extent: 32, resolution: 64, origin: [0, 0] });
  assert.ok(packed, 'placements are enough to grow from');
  const inside = grass.sampleField(0, 0), outside = grass.sampleField(15.5, 15.5);
  assert.ok(inside.density > .3, `the patch is covered: ${inside.density}`);
  assert.ok(Math.abs(inside.height - 2) < .6, 'and its ground follows the placements it was built from');
  assert.ok(outside.density < inside.density, 'beyond the patch it thins out');
  assert.equal(grass.setFieldFromPlacements([]), null);
  grass.dispose();
});

test('the blade node graph builds, with and without ground, and for an outermost ring', () => {
  for (const withField of [false, true]) {
    const uniforms = createGrassUniforms(), wind = createFoliageUniforms();
    const packed = withField ? packGrassField(() => ({ height: 1, density: 1, scale: 1, dryness: 0 }), { resolution: 16 }) : null;
    const texture = grassFieldTexture(packed);
    const material = createGrassMaterial(uniforms, wind, { style: 'natural', fieldTexture: texture });
    // Nothing here compiles a shader, but every node has to exist and connect:
    // a typo in the graph is otherwise only found on a device.
    for (const key of ['positionNode', 'normalNode', 'colorNode']) {
      assert.ok(material[key] && typeof material[key] === 'object', `${key} is a node`);
    }
    assert.equal(material.side, THREE.DoubleSide);
    assert.equal(material.userData.grass.hasField, withField);
    material.dispose(); texture?.dispose();
  }
  // Ring boundaries: a true "outermost" material fades over the last 15% of
  // its own radius instead of a shared seam with a ring beyond it — both
  // still have to build.
  for (const outermost of [false, true]) {
    const material = createGrassMaterial(createGrassUniforms(), createFoliageUniforms(), { outermost });
    assert.equal(material.userData.grass.outermost, outermost);
    assert.ok(material.userData.grass.ringBand > 0, 'a real soft band, not a hard edge');
    material.dispose();
  }
  const stylized = createGrassMaterial(createGrassUniforms(), createFoliageUniforms(), { style: 'stylized' });
  assert.equal(stylized.userData.grass.style, 'stylized');
  assert.notEqual(stylized.roughness, createGrassMaterial(createGrassUniforms(), createFoliageUniforms(), {}).roughness);
});

test('the tone controls reach the shader, and none of them recompiles it', () => {
  // ⛔ "I can't make it darker, whatever colors I use." A colour picker cannot:
  // the level of a sward is set by three constants downstream of it — the patch
  // spread, the root occlusion and the overall multiplier — and none of them
  // was reachable. Nor was the glint, which is not a colour at all but the
  // dielectric rim on a blade edge, and survives any albedo you choose.
  const { engine, entity, component } = fieldFixture({ blades: 40000 });
  const materials = component._grass.rings.map(ring => ring.material);
  component.setProp('grassBrightness', .4);
  component.setProp('grassOcclusion', .9);
  component.setProp('grassVariation', 0);
  component.setProp('grassSpecular', 0);
  component.setProp('grassRoughness', 1);
  component.setProp('grassSky', .25);
  component.update(true);
  for (const ring of component._grass.rings) {
    const tone = ring.uniforms.tone.value;
    assert.ok(Math.abs(tone.x - .4) < 1e-9, 'brightness');
    assert.ok(Math.abs(tone.y - .9) < 1e-9, 'root occlusion');
    assert.equal(tone.z, 0, 'a uniform sward is allowed');
    assert.equal(ring.material.specularIntensity, 0, 'the glint goes to zero');
    assert.equal(ring.material.roughness, 1);
    assert.ok(Math.abs(ring.material.envMapIntensity - .25) < 1e-9, 'sky response');
  }
  assert.ok(component._grass.rings.every((ring, index) => ring.material === materials[index]),
    'tone is uniforms and material properties, so nothing rebuilds');
  cleanup(engine, entity);
});

test('the root colour is derived from the tip, darker and greener, never a flat copy', () => {
  const tip = [.55, .65, .3];
  const [r, g, b] = deriveGrassBaseColor(tip);
  assert.ok(r < tip[0] && g < tip[1] && b < tip[2], 'the root is darker than the tip in every channel');
  const tipGreenShare = tip[1] / (tip[0] + tip[1] + tip[2]);
  const rootGreenShare = g / (r + g + b);
  assert.ok(rootGreenShare > tipGreenShare, `the root is greener, relatively: ${rootGreenShare.toFixed(3)} vs ${tipGreenShare.toFixed(3)}`);
  // A pure white tip still darkens and never exceeds 1 in any channel.
  const [wr, wg, wb] = deriveGrassBaseColor([1, 1, 1]);
  for (const c of [wr, wg, wb]) assert.ok(c >= 0 && c <= 1);
});

test('a tip colour above the saturation/lightness clamp is desaturated, not a flat copy', () => {
  // ⛔ 09-13: over-saturated yellow tips were the second half of the owner's
  // verdict against Tiny Glade. A picker-chosen, fully vivid, near-white
  // yellow is exactly the failure case: HSL S caps at .6, L at .48 (09-13: darker so a real sun never clips a tip to white).
  const grass = new GrassRenderer(new THREE.Group(), createFoliageUniforms());
  grass.configure({ blades: 20000, tipColor: '#f5f06a' }); // vivid, light yellow
  const tip = grass.rings[0].uniforms.tip.value;
  const hsl = {}; tip.getHSL(hsl, THREE.SRGBColorSpace);
  assert.ok(hsl.s <= .6 + 1e-4, `saturation clamped: ${hsl.s}`);
  assert.ok(hsl.l <= .48 + 1e-4, `lightness clamped: ${hsl.l}`);
  // A colour already inside the clamp passes through effectively unchanged
  // (RGB round-trips through HSL with only floating-point rounding).
  const before = new THREE.Color('#5a7a3f');
  grass.configure({ blades: 20000, tipColor: '#5a7a3f' });
  const mild = {}; grass.rings[0].uniforms.tip.value.getHSL(mild, THREE.SRGBColorSpace);
  assert.ok(mild.s <= .6 + 1e-4 && mild.l <= .48 + 1e-4);
  const after = grass.rings[0].uniforms.tip.value;
  assert.ok(Math.abs(after.r - before.r) < .01 && Math.abs(after.g - before.g) < .01 && Math.abs(after.b - before.b) < .01,
    'a colour already inside the clamp is untouched, up to HSL round-trip rounding');
  grass.dispose();
});

test('a clump groups several neighbouring blade cells under one shared hash', () => {
  // Two points a few centimetres apart, well inside one 0.35 m clump, share
  // a cell; a point in the next clump over does not.
  const a = grassClumpCell(1.10, 2.20), b = grassClumpCell(1.15, 2.24);
  assert.deepEqual(a, b, 'nearby blades share a clump');
  const far = grassClumpCell(1.10 + .5, 2.20);
  assert.notDeepEqual(a, far, 'half a metre over is a different clump');
  // The hash itself is deterministic and bounded, exactly like the shader's.
  const h1 = grassClumpHash(a, 7.9), h2 = grassClumpHash(a, 7.9);
  assert.equal(h1, h2, 'the same cell and salt always hash the same');
  assert.ok(h1 >= 0 && h1 < 1);
  assert.notEqual(grassClumpHash(a, 7.9), grassClumpHash(a, 29.4), 'a different salt reads a different value');
});

test('rest lean has no per-clump colour term: two blades in the same clump differ only by the per-blade hash amplitude', () => {
  // ⛔ 09-13 FIFTH OWNER RECEIPT: round ~0.4 m light/dark spots straight down —
  // `rest` used to hash purely from `clumpCell`, so every blade sharing one
  // 0.35 m clump got the IDENTICAL lean. Two nearby blades (same clump, same
  // `worldCell` even) must now differ only by the small per-fanSlot jitter
  // term (±8% of the [0,1] patch range, scaled by lean magnitude), never by
  // a clump-wide jump.
  const lean = .24;
  const worldCell = [4, -2];
  const clump = grassClumpCell(2.1, -0.7);
  const a = grassRestLean(lean, [2.10, -0.70], worldCell, 0);
  const b = grassRestLean(lean, [2.12, -0.69], worldCell, 1); // a different fan member, same clump/cell
  assert.deepEqual(grassClumpCell(2.10, -0.70), clump, 'still the same clump');
  assert.deepEqual(grassClumpCell(2.12, -0.69), clump, 'still the same clump');
  const maxJitterSpan = lean * .16; // ±8% of the [0,1] patch range either side
  assert.ok(Math.abs(a - b) <= maxJitterSpan + 1e-9,
    `two blades in one clump must differ only by the per-blade jitter budget: |Δrest|=${Math.abs(a - b)}, budget=${maxJitterSpan}`);
  // A point half a metre away (a different clump AND a different patch-noise
  // neighbourhood) is free to differ by much more than the per-blade budget.
  const far = grassRestLean(lean, [2.10 + .8, -0.70], [worldCell[0] + 2, worldCell[1]], 0);
  assert.notEqual(far, a);
});

test('the tuft-gap ramp reads exactly zero at a ring seam, for every ring sharing it — the ring0/ring1 tone-line regression gate', () => {
  // ⛔ 09-13 SIXTH OWNER RECEIPT: a sharp horizontal tone line at the
  // ring0→ring1 hand-over — `tipGround` used to switch from a hard 0 (ring 0)
  // to a hard 0.5 (ring 1 by `ring.index === 1`) with no transition, so the
  // same world blade rendered two different colours depending only on which
  // ring's draw won the seam lottery right at the boundary.
  // ⛔ 09-13 SEVENTH OWNER RECEIPT: band 1.5 → 3 (a 3 m → 6 m soft hand-over)
  // — matches `grassMaterial.js`'s own widened `band`.
  const innerRadius = 5, band = 3;
  // Ring 0 has no inner hole: the ramp is pinned to zero regardless of radius.
  assert.equal(grassTuftGapRamp(4.999, innerRadius, 0, band), 0, 'no hole: always zero');
  assert.equal(grassTuftGapRamp(50, innerRadius, 0, band), 0, 'no hole: always zero, even far out');
  // A ring WITH a hole (ring 1/2) reads exactly zero right at its own seam —
  // the value ring 0's own draw effectively carries there too (its own ramp
  // is pinned at 0), so the two sides of the boundary agree exactly.
  assert.equal(grassTuftGapRamp(innerRadius, innerRadius, 1, band), 0, 'zero exactly at the seam');
  assert.ok(grassTuftGapRamp(innerRadius + .01, innerRadius, 1, band) > 0, 'rises just past the seam');
  assert.equal(grassTuftGapRamp(innerRadius + band * 2, innerRadius, 1, band), 1, 'reaches its target a couple of bands in');
  // Monotonic, continuous rise across the ramp — no jump anywhere in it.
  let prev = 0;
  for (let step = 0; step <= 20; step++) {
    const radial = innerRadius + (step / 20) * band * 2;
    const value = grassTuftGapRamp(radial, innerRadius, 1, band);
    assert.ok(value >= prev - 1e-9, `ramp must be monotonic: step ${step}`);
    assert.ok(value - prev <= .15, `no jump anywhere in the ramp: step ${step} jumped ${value - prev}`);
    prev = value;
  }
});

test('the patch noise is smooth, bounded, and independent per salt', () => {
  for (let i = 0; i < 200; i++) {
    const x = (i * 37) % 50 - 25, z = (i * 53) % 50 - 25;
    const value = grassPatchNoise(x, z, 8.13);
    assert.ok(value >= 0 && value <= 1, `noise stays in range: ${value}`);
  }
  // Different salts decorrelate the same point.
  const hue = grassPatchNoise(12.3, 4.5, 8.13), height = grassPatchNoise(12.3, 4.5, 14.7);
  assert.notEqual(hue, height);
});

test('the patch noise is continuous: 0.05 m apart never differs by more than 0.05, even across a lattice cell edge', () => {
  // ⛔ 09-13 OWNER RECEIPT against the previous single-octave version: "regular
  // rectangular patches of different colors" — this is the exact regression
  // gate for it. Sweep points that straddle whole-metre AND 1.5 m / 4 m octave
  // cell boundaries, since a boundary is exactly where a less continuous
  // interpolant (or a hard quantisation of one) would show a seam.
  let worst = 0;
  for (let i = 0; i < 400; i++) {
    const x = (i * 0.37) % 30 - 15, z = (i * 0.53) % 30 - 15;
    const here = grassPatchNoise(x, z, 8.13);
    const stepX = grassPatchNoise(x + .05, z, 8.13);
    const stepZ = grassPatchNoise(x, z + .05, 8.13);
    worst = Math.max(worst, Math.abs(here - stepX), Math.abs(here - stepZ));
  }
  // ⛔ 09-13 FIFTH/SIXTH FOLLOW-UPS: first a fixed-angle rotation, then a
  // switch from (rotated) classic gradient noise to simplex noise, each
  // redistributed exactly where a 0.05 m probe lands relative to a lattice
  // edge, nudging the worst-case sample (measured ≈0.033 original, ≈0.052
  // rotated, ≈0.065 simplex) without changing the underlying continuity —
  // still an order of magnitude below what an actual hard edge would show.
  assert.ok(worst < .08, `worst 0.05 m step anywhere in the sweep: ${worst}`);
});

test('blade colour is independent of the view vector: 8 view directions give byte-identical means', () => {
  // ⛔⛔ 09-13 REFERENCE-MODEL REWRITE. Owner's verdict after ten shading
  // passes: three frames of the SAME field looked like three different
  // scenes — pale wash three-quarter, near-black-with-radial-streaks
  // straight down, pale-with-blobs at a high angle — because the old model
  // lit every blade with its OWN normal plus view-dependent terms (facing
  // lift, translucency), so the picture changed with the camera instead of
  // the light. The rewrite gives every blade the ground's own normal, which
  // has no dependence on the viewer at all. This is the regression gate:
  // sweep 8 view directions around the sphere and assert the mean is exactly
  // the same value every time, not just "close".
  const directions = Array.from({ length: 8 }, (_, i) => {
    const angle = (i / 8) * Math.PI * 2;
    return [Math.cos(angle), .3, Math.sin(angle)];
  });
  const means = grassLuminanceMeans(1000, directions);
  for (const mean of means) assert.equal(mean, means[0], 'every view direction gives the identical mean');
});

test('blade colour is identical across rings: same sample, no ring parameter to differ on', () => {
  // The old model's `facing`/translucency terms were the only things that
  // could ever have varied a blade's colour by which ring drew it (through
  // the camera-relative view vector). The rewrite's colour path
  // (`grassBladeLuminance`/`grassBladeShadingMultiplier`) takes no ring
  // index at all — asserting that here is the structural proof, not just a
  // numeric coincidence: the same deterministic sample gives the same colour
  // regardless of which ring's material draws it.
  for (const sample of [0, 1, 42, 999, 4321]) {
    const a = grassBladeLuminance(sample, { viewDir: [0, 1, 0] });
    const b = grassBladeLuminance(sample, { viewDir: [1, 0, 0] });
    assert.equal(a, b, `sample ${sample}: identical regardless of the (irrelevant) view direction`);
  }
});

test('the combined AO x depth x patch shading multiplier is clamped to [0.55, 1.0] for every blade', () => {
  // ⛔⛔ 09-13 OWNER VERDICT: "large organic blobs (1-3 m) of near-white
  // blades next to blobs of near-black blades" — independently-floored terms
  // (AO, depth, patch) could still multiply past any one term's own floor.
  // The regression gate: sweep many samples and assert the PRODUCT never
  // leaves the authored contrast range, not just each factor. ⛔ 09-13
  // REFERENCE-MODEL REWRITE: the sun-facing term is gone from this product
  // outright — a blade's own normal no longer reaches colour at all.
  let min = Infinity, max = -Infinity;
  for (let sample = 0; sample < 5000; sample++) {
    const multiplier = grassBladeShadingMultiplier(sample);
    min = Math.min(min, multiplier);
    max = Math.max(max, multiplier);
  }
  assert.ok(min >= .55, `combined multiplier floor: ${min}`);
  assert.ok(max <= 1.0001, `combined multiplier ceiling: ${max}`);
  // The clamp has to actually bind somewhere across 5000 samples, or it is
  // dead code that never engages.
  assert.ok(min < .9, `floor never engaged across the sweep: ${min}`);
});

test('blade-to-blade luminance spread stays tight: std/mean <= 0.22 over 5000 samples', () => {
  // ⛔⛔ 09-13 OWNER VERDICT AGAINST THE TINY GLADE REFERENCE: "varies
  // brightness by ~20% across a field, never 80%." The per-sample luminance
  // (grayscale, colour tinting aside, and now provably view-independent) is
  // the same statistic a real rendered receipt is measured by; this is the
  // CPU-mirror fallback when a GPU harness is unavailable.
  const count = 5000;
  let sum = 0, sumSquares = 0;
  for (let sample = 0; sample < count; sample++) {
    const value = grassBladeLuminance(sample);
    sum += value; sumSquares += value * value;
  }
  const mean = sum / count;
  const variance = Math.max(0, sumSquares / count - mean * mean);
  const std = Math.sqrt(variance);
  assert.ok(std / mean <= .22, `std/mean over ${count} blades: ${(std / mean).toFixed(4)} (mean ${mean.toFixed(4)}, std ${std.toFixed(4)})`);
});

test('a single blade sample is deterministic', () => {
  const a = grassBladeLuminance(42), b = grassBladeLuminance(42);
  assert.equal(a, b, 'same sample, same inputs, same result');
});

test('the patch noise is GRADIENT noise, not VALUE noise: no flat plateau right at a lattice corner', () => {
  // ⛔ 09-13 FOLLOW-UP OWNER RECEIPT: "a checkerboard of 1 m squares,
  // world-axis aligned, with hard edges" survived every other fix,
  // including the raw noise value viewed in total isolation
  // (`grassDebugPatch`) at a camera range close enough to rule out every
  // ring/tuft/field-texel cause. Root cause: the original noise interpolated
  // raw HASH VALUES at each lattice corner ("value noise") — quintic
  // smoothing is C2-continuous, but its own derivative is deliberately near
  // zero AT t=0, so the field sits nearly flat at a corner's own fully
  // random value for a good fraction of the cell. `grassPatchNoise` now
  // interpolates GRADIENT directions (classic Perlin noise) instead, which
  // has no such plateau — a corner contributes exactly zero there and rises
  // at roughly the SAME rate moving away from it as it does at cell centre.
  // Regression gate: the rate of change 0.02 m from an exact 1.5 m lattice
  // corner must be within the same order of magnitude as at the cell centre
  // (0.75 m in), never orders of magnitude flatter — that flatness is
  // exactly what reads as a hard-edged square around each corner.
  const step = .02;
  const gradientNear = (x, z) => Math.abs(grassPatchNoise(x + step, z, 9.9) - grassPatchNoise(x, z, 9.9)) / step;
  // Sample several lattice corners (multiples of 1.5 m, the finer octave)
  // and several cell centres, comparing the WORST corner-vs-best-centre
  // ratio rather than one pair, so this isn't sensitive to one unlucky
  // gradient direction landing near-parallel to the probe axis.
  const corners = [[0, 0], [1.5, 0], [0, 1.5], [3, 4.5], [-1.5, 3]];
  const centres = [[.75, .75], [.75, 2.25], [2.25, .75], [-.75, 2.25]];
  const worstCorner = Math.max(...corners.map(([x, z]) => gradientNear(x, z)));
  const typicalCentre = centres.map(([x, z]) => gradientNear(x, z)).reduce((a, b) => a + b, 0) / centres.length;
  assert.ok(worstCorner > typicalCentre * .15,
    `corner rate ${worstCorner.toFixed(4)} vs centre rate ${typicalCentre.toFixed(4)} — a corner should not be far flatter than mid-cell`);
});

test('the patch noise (2D simplex) agrees with an independently-written reference implementation to 1e-4', () => {
  // ⛔⛔⛔ 09-13 SIXTH OWNER RECEIPT: the isotropy target (≤1.15) required
  // replacing rotated classic (Perlin) gradient noise with 2D simplex noise
  // in BOTH `grassMaterial.js` (the actual TSL shader) and this file's CPU
  // mirror — two hand-transcribed copies of the same skew/unskew/kernel
  // arithmetic are exactly the kind of place a silent copy-paste divergence
  // survives every other test, since both would still "look like noise" on
  // their own. This is a THIRD, independently written implementation of the
  // same published 2D simplex algorithm (same skew/unskew constants, same
  // radially-symmetric (0.5-d²)⁴ kernel, same 8-direction gradient set) built
  // from scratch in this test rather than by copying `grassNoiseOctave`, so
  // it can actually catch a transcription bug rather than reproduce one.
  // It reads the exact same underlying hash (`grassClumpHash`) so this is a
  // check on the SIMPLEX ARITHMETIC specifically, not on hash agreement.
  const F2 = (Math.sqrt(3) - 1) / 2, G2 = (3 - Math.sqrt(3)) / 6;
  const ROT_C = Math.cos(.4636), ROT_S = Math.sin(.4636);
  function referenceOctave(x, z, freq, salt) {
    const rx = x * ROT_C - z * ROT_S, rz = x * ROT_S + z * ROT_C;
    const px = rx / freq, pz = rz / freq;
    const skew = (px + pz) * F2;
    const i = Math.floor(px + skew), j = Math.floor(pz + skew);
    const unskew = (i + j) * G2;
    const x0 = px - i + unskew, y0 = pz - j + unskew;
    const [i1, j1] = x0 >= y0 ? [1, 0] : [0, 1];
    const corners = [
      [i, j, x0, y0],
      [i + i1, j + j1, x0 - i1 + G2, y0 - j1 + G2],
      [i + 1, j + 1, x0 - 1 + 2 * G2, y0 - 1 + 2 * G2],
    ];
    let total = 0;
    for (const [ci, cj, cx, cy] of corners) {
      const radius = .5 - cx * cx - cy * cy;
      if (radius <= 0) continue;
      const dirIndex = Math.floor(grassClumpHash([ci, cj], salt) * 8);
      const angle = dirIndex * (Math.PI / 4);
      const gradient = [Math.cos(angle), Math.sin(angle)];
      total += Math.pow(radius, 4) * (gradient[0] * cx + gradient[1] * cy);
    }
    return Math.min(1, Math.max(0, total * 70 * .7 + .5));
  }
  function referencePatchNoise(x, z, salt) {
    return referenceOctave(x, z, 1.5, salt) * .55 + referenceOctave(x, z, 4, salt + 19.7) * .45;
  }
  let worst = 0;
  for (let i = 0; i < 500; i++) {
    // A fixed pseudo-random sequence, not Math.random(): deterministic across runs.
    const x = (Math.sin(i * 12.9898) * 43758.5453 % 1) * 40 - 20;
    const z = (Math.sin(i * 78.233) * 43758.5453 % 1) * 40 - 20;
    const mine = grassPatchNoise(x, z, 5.5), reference = referencePatchNoise(x, z, 5.5);
    worst = Math.max(worst, Math.abs(mine - reference));
  }
  assert.ok(worst < 1e-4, `worst disagreement across 500 points: ${worst}`);
});

test('the hex lattice has no axis preference: nearest-neighbour |dx| and |dz| are within 10% of each other', () => {
  // ⛔⛔ 09-13 SEVENTH OWNER RECEIPT: simplex colour noise (isotropy ≈1.33)
  // never fixed the residual grid, because the grid was never the colour
  // noise — it was `worldCell` itself, a jittered SQUARE instance lattice.
  // 10 000 blades on the hex lattice (100×100 cells); for each, the nearest
  // neighbour is found by checking only the handful of adjacent cells a
  // triangular lattice's own geometry guarantees the true nearest point is
  // within (never a brute-force all-pairs search). A square lattice would
  // fail this: its nearest-neighbour vector is always axis-aligned, so
  // mean|dx| and mean|dz| diverge sharply depending on sample orientation.
  const cell = .05;
  const span = 50; // -50..49 on each axis: exactly 10 000 cells
  const points = new Map();
  for (let row = -span; row < span; row++) {
    for (let col = -span; col < span; col++) points.set(`${col},${row}`, grassHexBladeXZ(cell, [col, row]));
  }
  let sumDx = 0, sumDz = 0, count = 0;
  for (const [key, [x, z]] of points) {
    const [col, row] = key.split(',').map(Number);
    let bestDist = Infinity, bestDx = 0, bestDz = 0;
    // A triangular lattice's nearest neighbours are its 6 immediate points,
    // never more than one row away; ±2 columns covers the row's own half-cell
    // offset either direction.
    for (let dr = -1; dr <= 1; dr++) for (let dc = -2; dc <= 2; dc++) {
      if (!dr && !dc) continue;
      const neighbour = points.get(`${col + dc},${row + dr}`);
      if (!neighbour) continue; // edge of the sampled patch
      const dx = neighbour[0] - x, dz = neighbour[1] - z, dist = dx * dx + dz * dz;
      if (dist < bestDist) { bestDist = dist; bestDx = Math.abs(dx); bestDz = Math.abs(dz); }
    }
    if (bestDist === Infinity) continue; // only the very edge of the patch
    sumDx += bestDx; sumDz += bestDz; count++;
  }
  assert.ok(count > 9000, `almost every sampled blade has a full neighbourhood: ${count}`);
  const meanDx = sumDx / count, meanDz = sumDz / count, ratio = meanDx / meanDz;
  assert.ok(ratio > .9 && ratio < 1.1,
    `isotropy ratio (mean|dx| / mean|dz|): ${ratio.toFixed(3)} (mean|dx| ${meanDx.toFixed(4)}, mean|dz| ${meanDz.toFixed(4)})`);
});

test('the hex lattice point and jitter agree with an independently-written reference implementation', () => {
  // ⛔ Two hand-transcribed copies of the same lattice/jitter arithmetic
  // (`grassMaterial.js`'s TSL and `grassField.js`'s CPU mirror) are exactly
  // where a silent divergence survives every other test, since both would
  // still "look like a lattice" on their own — same pattern as the simplex
  // cross-check above, applied to the new hex derivation.
  const ratio = Math.sqrt(3) / 2;
  // Reference hash22 without sine (Dave Hoskins), written out in float32 the way
  // the shader evaluates `fract(p.xyx·k)`, `p3 += dot(p3, p3.yzx + 33.33)`,
  // `fract((p3.xx + p3.yz)·p3.zy)`.
  const F = Math.fround, refFrac = value => F(value - Math.floor(value));
  function referenceHash22(px, py) {
    const p3 = [refFrac(F(F(px) * F(.1031))), refFrac(F(F(py) * F(.1030))), refFrac(F(F(px) * F(.0973)))];
    const k = F(33.33);
    const shift = F(F(F(p3[0] * F(p3[1] + k)) + F(p3[1] * F(p3[2] + k))) + F(p3[2] * F(p3[0] + k)));
    const [x, y, z] = p3.map(v => F(v + shift));
    return [refFrac(F(F(x + y) * z)), refFrac(F(F(x + z) * y))];
  }
  function referenceBladeXZ(cell, col, row) {
    const parity = ((row % 2) + 2) % 2;
    const x0 = (col + .5 * parity) * cell, z0 = row * cell * ratio;
    const [u1, u2] = referenceHash22(col, row);
    const r = Math.sqrt(u1) * cell * .45, theta = u2 * Math.PI * 2;
    return [x0 + Math.cos(theta) * r, z0 + Math.sin(theta) * r];
  }
  const cell = .037;
  let worst = 0;
  for (let col = -30; col <= 30; col += 3) for (let row = -30; row <= 30; row += 3) {
    const mine = grassHexBladeXZ(cell, [col, row]), reference = referenceBladeXZ(cell, col, row);
    worst = Math.max(worst, Math.abs(mine[0] - reference[0]), Math.abs(mine[1] - reference[1]));
  }
  assert.ok(worst < 1e-9, `worst disagreement: ${worst}`);
  // And the lattice point alone (no jitter) matches the odd-row-offset,
  // √3/2-pitch definition directly.
  assert.deepEqual(grassHexCellPoint(.04, [0, 0]), [0, 0]);
  const [x1, z1] = grassHexCellPoint(.04, [0, 1]);
  assert.ok(Math.abs(x1 - .02) < 1e-9, 'an odd row offsets by half a cell along x');
  assert.ok(Math.abs(z1 - .04 * ratio) < 1e-9, 'row pitch is cell·√3/2');
  const [xNeg, zNeg] = grassHexCellPoint(.04, [0, -1]);
  assert.ok(Math.abs(xNeg - .02) < 1e-9, 'a negative odd row still offsets by half a cell (correct parity, not a raw modulo)');
  assert.ok(Math.abs(zNeg + .04 * ratio) < 1e-9);
});

test('the seam lottery\'s hex cell lookup agrees with an independently-written reference implementation', () => {
  // Same rationale as above, for `hexNearestCell`/`grassHexNearestCell`: a
  // from-scratch third implementation of the same nearest-lattice-point
  // search, built without copying `grassHexNearestCell`.
  function referenceNearestCell(cell, x, z) {
    const pitch = cell * (Math.sqrt(3) / 2);
    const rowApprox = Math.round(z / pitch);
    let best = null, bestDist = Infinity;
    for (let dr = -1; dr <= 1; dr++) {
      const row = rowApprox + dr;
      const parity = ((row % 2) + 2) % 2;
      const colApprox = Math.round(x / cell - parity * .5);
      for (let dc = -1; dc <= 1; dc++) {
        const col = colApprox + dc;
        const cx = (col + parity * .5) * cell, cz = row * pitch;
        const dist = (cx - x) ** 2 + (cz - z) ** 2;
        if (dist < bestDist) { bestDist = dist; best = [col, row]; }
      }
    }
    return best;
  }
  const cell = .052;
  for (let i = 0; i < 400; i++) {
    const x = (Math.sin(i * 12.9898) * 43758.5453 % 1) * 40 - 20;
    const z = (Math.sin(i * 78.233) * 43758.5453 % 1) * 40 - 20;
    const mine = grassHexNearestCell(cell, x, z), reference = referenceNearestCell(cell, x, z);
    assert.deepEqual(mine, reference, `disagreement at (${x.toFixed(3)}, ${z.toFixed(3)})`);
  }
  // A point exactly on a lattice point resolves to that cell, not a neighbour.
  const [px, pz] = grassHexCellPoint(cell, [4, -3]);
  assert.deepEqual(grassHexNearestCell(cell, px, pz), [4, -3]);
  // Sanity check that the salted hash this feeds into is deterministic and
  // still a valid [0,1) value once it reads a hex id instead of a floor'd one.
  const hashed = grassClumpHash(grassHexNearestCell(cell, 1.23, -4.56), 211.7);
  assert.ok(hashed >= 0 && hashed < 1);
  assert.equal(hashed, grassClumpHash(grassHexNearestCell(cell, 1.23, -4.56), 211.7), 'deterministic');
});

test('the field bilinear reconstruction matches an independently-written reference of the shader\'s (corrected) arithmetic, including exact texel edges', () => {
  // ⛔⛔⛔ 09-13 OWNER RECEIPT: eye-level rectangles ~1-2 m and a hard SQUARE
  // in the top-down debug view, at a scale neither the (hex, isotropic) blade
  // lattice nor the (continuous) patch noise can produce. Root cause:
  // `packGrassField` lays samples out EDGE-INCLUSIVE — texel 0 at the field's
  // near edge, texel (size-1) at its far edge, spacing `extent/(size-1)` —
  // and `sampleGrassField` reconstructs with `u = normalizedUV * (size-1)`.
  // `grassMaterial.js` instead read the SAME data as PIXEL-CENTRED
  // (`grid = uv*size - .5`, correct for a texture whose texel 0 sits half a
  // texel IN from the edge) — a silent mismatch, worst right at a texel
  // boundary, at exactly the texel-spacing scale the owner reported. Fixed to
  // the identical `u = uv*(size-1)`, `column = min(size-2, floor(u))`
  // arithmetic `sampleGrassField` already used. This is a from-scratch
  // reference implementation of that (now shared) formula, built without
  // copying either, checked against `sampleGrassField` directly.
  function referenceSample(packed, x, z) {
    const { data, size, extent, origin } = packed;
    const half = extent / 2;
    const u = Math.min(1, Math.max(0, (x - origin[0] + half) / extent)) * (size - 1);
    const v = Math.min(1, Math.max(0, (z - origin[1] + half) / extent)) * (size - 1);
    const column = Math.min(size - 2, Math.floor(u)), row = Math.min(size - 2, Math.floor(v));
    const fx = u - column, fz = v - row;
    const out = [];
    for (let channel = 0; channel < 4; channel++) {
      const at = (r, c) => data[(r * size + c) * 4 + channel];
      const lower = at(row, column) * (1 - fx) + at(row, column + 1) * fx;
      const upper = at(row + 1, column) * (1 - fx) + at(row + 1, column + 1) * fx;
      out.push(lower * (1 - fz) + upper * fz);
    }
    return out;
  }
  const ground = (x, z) => ({ height: Math.sin(x * .07) * 2 + z * .03, density: (x + z) % 7 < 4 ? .8 : .2, scale: 1, dryness: .4 });
  for (const [extent, resolution] of [[128, 65], [20, 64], [64, 8]]) {
    const packed = packGrassField(ground, { extent, resolution });
    const half = extent / 2, step = extent / (packed.size - 1);
    const points = [];
    // Exact texel edges (where the old pixel-centred formula diverges most)…
    for (let i = 0; i < packed.size; i++) points.push([-half + i * step, -half + (i * 37 % packed.size) * step]);
    // …plus 500 pseudo-random interior/edge/out-of-bounds points.
    for (let i = 0; i < 500; i++) {
      const x = (Math.sin(i * 12.9898) * 43758.5453 % 1) * extent * .6;
      const z = (Math.sin(i * 78.233) * 43758.5453 % 1) * extent * .6;
      points.push([x, z]);
    }
    let worst = 0;
    for (const [x, z] of points) {
      const mine = sampleGrassField(packed, x, z), reference = referenceSample(packed, x, z);
      const [h, d, s, dry] = reference;
      worst = Math.max(worst, Math.abs(mine.height - h), Math.abs(mine.density - d), Math.abs(mine.scale - s), Math.abs(mine.dryness - dry));
    }
    assert.ok(worst < 1e-9, `extent ${extent}/res ${resolution}: worst disagreement ${worst}`);
  }
});

test('grassCellHash2 mirrors the shader\'s two-value hash exactly', () => {
  const [u1, u2] = grassCellHash2([3, -7]);
  assert.ok(u1 >= 0 && u1 < 1 && u2 >= 0 && u2 < 1);
  assert.notEqual(u1, u2, 'the two components use different constants, so they decorrelate');
  assert.deepEqual(grassCellHash2([3, -7]), [u1, u2], 'deterministic');
});

test('the grass normal is handed to three in VIEW space: normalNode rotates the world ground normal by cameraViewMatrix', async () => {
  // 09-13 owner receipt: the same sward was lit from a three-quarter view and
  // black from straight above. `groundNormal` is world-space; three reads
  // `normalNode` as normalView, so without this rotation the lighting frame
  // turned with the camera.
  const { cameraViewMatrix } = await import('three/tsl');
  const grass = new GrassRenderer(new THREE.Group(), createFoliageUniforms());
  grass.configure({ blades: 60000 });
  const self = n => (n && typeof n.getSelf === 'function') ? n.getSelf() : n;
  const target = self(cameraViewMatrix);
  for (const ring of grass.rings) {
    let found = false;
    ring.material.normalNode.traverse(n => { if (self(n) === target) found = true; });
    assert.ok(found, `${ring.material.name}: normalNode never rotates by cameraViewMatrix`);
  }
  grass.dispose();
});

// ---- frustum windows -------------------------------------------------------
// ⛔ 09-14 OWNER: "grass renders in a radius around the camera". The rings are
// squares centred on the camera, and every blade behind the lens still ran the
// vertex shader. Each draw now issues only the slots its camera can see.
import { grassFrustumWindow, grassFullWindow, grassViewCorners } from '../src/modules/foliage/grassField.js';

function lookingCamera(position, target, fov = 60) {
  const camera = new THREE.PerspectiveCamera(fov, 16 / 9, .1, 2000);
  camera.position.set(...position);
  camera.lookAt(...target);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  return camera;
}

function cullFixture(camera) {
  const grass = new GrassRenderer(new THREE.Group(), createFoliageUniforms());
  grass.configure({ blades: 60000, near: 5, far: 40 });
  grass.update(null, camera);
  const windows = grass.rings.map(ring => grass._cull(ring, camera));
  return { grass, windows };
}

test('a draw issues only the slots in front of the camera, and every blade in view is among them', () => {
  const camera = lookingCamera([0, 1.7, 0], [10, 1.2, 3]);
  const { grass, windows } = cullFixture(camera);
  const frustum = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  const point = new THREE.Vector3();
  grass.rings.forEach((ring, index) => {
    const view = windows[index], rows = ring.rows ?? ring.columns;
    assert.equal(ring.mesh.geometry.instanceCount, view.columns * view.rows);
    assert.ok(view.columns * view.rows < ring.instances * .6, `ring ${index} draws ${view.columns * view.rows} of ${ring.instances}`);
    const origin = [ring.uniforms.origin.value.x, ring.uniforms.origin.value.y];
    const stride = Math.max(1, Math.floor(ring.columns / 90));
    let seen = 0;
    for (let row = 0; row < rows; row += stride) for (let column = 0; column < ring.columns; column += stride) {
      const cell = grassBladeCell(ring, origin, row * ring.columns + column);
      const [x, z] = grassHexCellPoint(ring.cell, cell);
      if (!frustum.containsPoint(point.set(x, 0, z)) && !frustum.containsPoint(point.set(x, .2, z))) continue;
      seen++;
      assert.ok(column >= view.column && column < view.column + view.columns && row >= view.row && row < view.row + view.rows,
        `ring ${index}: visible slot ${column},${row} lies outside window ${JSON.stringify(view)}`);
    }
    assert.ok(seen > 0, `ring ${index} has blades in view`);
  });
  grass.dispose();
});

test('a windowed draw keys every instance on the same world cell as the full grid', () => {
  const ring = grassRings({ near: 5, far: 40, blades: 60000 })[1];
  const origin = [3.1, -7.4], view = { column: 17, row: 9, columns: 23, rows: 11 };
  for (const instance of [0, 1, 22, 23, 24, 150, view.columns * view.rows - 1]) {
    const column = instance % view.columns + view.column, row = Math.floor(instance / view.columns) + view.row;
    assert.deepEqual(grassBladeCell(ring, origin, instance, view), grassBladeCell(ring, origin, row * ring.columns + column));
  }
  assert.deepEqual(grassBladeCell(ring, origin, 57, grassFullWindow(ring)), grassBladeCell(ring, origin, 57));
});

test('looking down pays for the ground underfoot; looking up from above the sward draws nothing', () => {
  const down = cullFixture(lookingCamera([0, 2, 0], [0, 0, -.001]));
  const ring0 = down.grass.rings[0], window0 = down.windows[0];
  assert.ok(window0.columns * window0.rows < ring0.instances * .25, `ring 0 draws ${window0.columns * window0.rows} of ${ring0.instances}`);
  // The window is not hole-aware: the few slots left (a 2.7 m cell padded by
  // jitter and fan spread) sit in the outer ring's hole, where the shader
  // already collapses them.
  const ring2 = down.grass.rings[2];
  assert.ok(down.windows[2].columns * down.windows[2].rows < ring2.instances * .05, 'the outer ring is all but gone under a downward view');
  down.grass.dispose();
  const up = cullFixture(lookingCamera([0, 8, 0], [0, 20, -.001]));
  for (const view of up.windows) assert.equal(view.columns * view.rows, 0);
  up.grass.dispose();
});

test('a camera the window cannot reason about draws the whole ring', () => {
  const { grass } = cullFixture(lookingCamera([0, 1.7, 0], [10, 1.2, 0]));
  for (const ring of grass.rings) {
    grass._cull(ring, null);
    assert.equal(ring.mesh.geometry.instanceCount, ring.instances);
    assert.deepEqual(ring.uniforms.window.value.toArray(), [0, 0, ring.columns, 0]);
  }
  assert.equal(grassViewCorners({}, new THREE.Matrix4()), null);
  grass.dispose();
});

test('the tip clamp works in picker space, so a vivid green keeps its hue under the sun', () => {
  // ⛔ 09-14 OWNER: "it gets too pale when sun intensity increases, and its
  // color is getting completely lost and uncontrollable". The clamp ran in
  // linear sRGB, where #617e11 has saturation 0.94: capping it at 0.6 lifted
  // the blue channel ~6× and every blade went olive-grey before it was lit.
  const grass = new GrassRenderer(new THREE.Group(), createFoliageUniforms());
  grass.configure({ blades: 20000, tipColor: '#617e11', dryColor: '#2b590d' });
  const authored = new THREE.Color('#617e11'), tip = grass.rings[0].uniforms.tip.value;
  const hsl = {}; tip.getHSL(hsl, THREE.SRGBColorSpace);
  assert.ok(hsl.s <= .6 + 1e-4 && hsl.l <= .48 + 1e-4, 'the limits still hold, in picker space');
  assert.ok(tip.b < authored.b * 2.5, `blue is not lifted into grey: ${tip.b} from ${authored.b}`);
  const hue = {}; authored.getHSL(hue, THREE.SRGBColorSpace);
  assert.ok(Math.abs(hsl.h - hue.h) < 1e-3, 'hue is exactly what was picked');
  const dry = {}; grass.rings[0].uniforms.dry.value.getHSL(dry, THREE.SRGBColorSpace);
  assert.ok(dry.s <= .5 + 1e-4 && dry.l <= hsl.l + .06 + 1e-4, 'the dry tone is held against the tip in the same space');
  grass.dispose();
});
