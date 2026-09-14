// Streamed-chunk colliders against the REAL Rapier build the editor ships
// (@dimforge/rapier3d-compat): the fake in world-streaming.test.mjs checks the
// bookkeeping, this checks that a heightfield built from a streamed tile is
// oriented and centred so a ray lands on the landscape surface.
import test from 'node:test';
import assert from 'node:assert/strict';
import RAPIER from '@dimforge/rapier3d-compat';
import { getLandscape } from '../src/engine/terrain/landscapeGenerator.js';
import { buildTerrainTile } from '../src/modules/terrain/terrainTile.js';
import { WorldStreamPhysics } from '../src/modules/world/worldStreamPhysics.js';

test('a streamed chunk collider puts ray hits on the landscape surface', async () => {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const physics = {
    world, RAPIER, disposed: false, colliderEntity: new Map(), colliderLayer: new Map(),
    layers: { indexOf: name => name === 'Default' ? 0 : -1, groupsFor: () => 0xffffffff },
    forgetCollider(handle) { this.colliderEntity.delete(handle); this.colliderLayer.delete(handle); },
  };
  const landscape = getLandscape({ style: 'highlands', seed: 11, extent: 1024 });
  const x0 = 192, z0 = -288, size = 96, resolution = 64;
  const tile = buildTerrainTile(landscape, { x0, z0, size, resolution });
  const cols = resolution + 1, heights = new Float32Array(cols * cols);
  for (let i = 0; i < heights.length; i++) heights[i] = tile.positions[i * 3 + 1];
  const colliders = new WorldStreamPhysics({ entity: { id: 'world' } });
  colliders.offset = [0, 0, 0];
  colliders.setTile('probe', { heights, resolution, size, x0, z0 });
  colliders.build(physics);
  world.step();

  let checked = 0, worst = 0;
  const step = size / resolution;
  for (const [u, v] of [[.1, .1], [.9, .15], [.5, .5], [.2, .85], [.77, .63], [.33, .41]]) {
    const x = x0 + u * size, z = z0 + v * size;
    // Bilinear read of the tile grid, which is what the collider triangulates.
    const gc = (x - x0) / step, gr = (z - z0) / step, c = Math.floor(gc), r = Math.floor(gr), tc = gc - c, tr = gr - r;
    const at = (rr, cc) => heights[rr * cols + cc];
    const grid = (at(r, c) * (1 - tc) + at(r, c + 1) * tc) * (1 - tr) + (at(r + 1, c) * (1 - tc) + at(r + 1, c + 1) * tc) * tr;
    const ray = new RAPIER.Ray({ x, y: 2000, z }, { x: 0, y: -1, z: 0 });
    const hit = world.castRay(ray, 5000, true);
    assert.ok(hit, `the ray at ${x.toFixed(1)},${z.toFixed(1)} hits streamed ground`);
    const y = 2000 - (hit.timeOfImpact ?? hit.toi);
    // A cell's two triangles differ from the bilinear surface by at most the cell's twist.
    const twist = Math.abs(at(r, c) - at(r, c + 1) - at(r + 1, c) + at(r + 1, c + 1));
    worst = Math.max(worst, Math.abs(y - grid) - twist / 2);
    checked++;
  }
  assert.equal(checked, 6);
  assert.ok(worst < .05, `ray hits sit on the tile surface (worst excess ${worst.toFixed(3)} m)`);

  // Outside the chunk there is nothing to hit.
  const miss = world.castRay(new RAPIER.Ray({ x: x0 - 20, y: 2000, z: z0 + 40 }, { x: 0, y: -1, z: 0 }), 5000, true);
  assert.equal(miss, null, 'the collider covers its chunk and no more');

  colliders.clear();
  assert.equal(world.bodies.len(), 0, 'Stop frees the body');
  world.free();
});
