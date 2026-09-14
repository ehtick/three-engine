// GI foliage seating policy (2026-09-13): a mesh tagged `giTrace: "none"`
// must never claim an atlas slot / SDF bake / static-BVH triangle, and
// `userData.giInstanceCap` must narrow (never widen) an InstancedMesh's seat
// count. `giSeatPlanOf` (src/modules/gi/dynamicObjects.js) is the pure
// decision GISystem.js#placementsOf defers to — this is what makes that
// private method's policy testable at all.
import test from "node:test";
import assert from "node:assert/strict";
import { giSeatPlanOf, giTraceOf } from "../src/modules/gi/dynamicObjects.js";

const HARD_CAP = 256;

function fakeInstancedMesh(count, userData = {}) {
  return { isInstancedMesh: true, count, userData };
}
function fakeMesh(userData = {}) {
  return { isInstancedMesh: false, userData };
}

test("giTraceOf reads the explicit \"none\" tag", () => {
  assert.equal(giTraceOf(fakeMesh({ giTrace: "none" })), "none");
  assert.equal(giTraceOf(fakeInstancedMesh(10, { giTrace: "none" })), "none");
  // Untagged still defaults to "auto" — "none" must never be a fallback.
  assert.equal(giTraceOf(fakeMesh({})), "auto");
});

test("giTrace:\"none\" seats nothing, on an InstancedMesh or a plain mesh", () => {
  const ring = fakeMesh({ giTrace: "none", giMobility: "static" }); // grass ring
  const impostorBatch = fakeInstancedMesh(20000, { giTrace: "none", giMobility: "static" });
  assert.deepEqual(giSeatPlanOf(ring, HARD_CAP), { seats: 0, cap: 0, isInstanced: false });
  assert.deepEqual(giSeatPlanOf(impostorBatch, HARD_CAP), { seats: 0, cap: 0, isInstanced: true });
});

test("a plain (non-instanced) mesh always seats exactly 1, ignoring giInstanceCap", () => {
  const plan = giSeatPlanOf(fakeMesh({ giInstanceCap: 5 }), HARD_CAP);
  assert.equal(plan.seats, 1);
  assert.equal(plan.isInstanced, false);
});

test("an untagged InstancedMesh seats up to the hard cap", () => {
  assert.equal(giSeatPlanOf(fakeInstancedMesh(100), HARD_CAP).seats, 100);
  const over = giSeatPlanOf(fakeInstancedMesh(4000), HARD_CAP);
  assert.equal(over.seats, HARD_CAP);
  assert.equal(over.cap, HARD_CAP);
});

test("giInstanceCap narrows the per-mesh seat budget (tree mid tier)", () => {
  const midTier = fakeInstancedMesh(4000, { giInstanceCap: 48 });
  const plan = giSeatPlanOf(midTier, HARD_CAP);
  assert.equal(plan.cap, 48);
  assert.equal(plan.seats, 48);
});

test("giInstanceCap can never widen past the hard cap", () => {
  const greedy = fakeInstancedMesh(4000, { giInstanceCap: 100000 });
  const plan = giSeatPlanOf(greedy, HARD_CAP);
  assert.equal(plan.cap, HARD_CAP);
  assert.equal(plan.seats, HARD_CAP);
});

test("giInstanceCap above the live instance count seats only what is live", () => {
  const smallPopulation = fakeInstancedMesh(10, { giInstanceCap: 48 });
  const plan = giSeatPlanOf(smallPopulation, HARD_CAP);
  assert.equal(plan.seats, 10);
});

test("before/after seat count for the World's foliage populations (measured)", () => {
  // Models the 7 scattered tree/shrub populations (near/mid/impostor tiers,
  // 4000 instances each — a representative dense stand) + the 3 grass rings
  // (single non-instanced draw each) the World boots with. BEFORE this
  // policy every InstancedMesh tier seated up to MAX_INSTANCES_PER_MESH
  // (256); AFTER, only the mid tier keeps a (48-seat) presence.
  const POPULATIONS = 7;
  const INSTANCES_PER_TIER = 4000;
  const GRASS_RINGS = 3;

  const beforeUntagged = () => fakeInstancedMesh(INSTANCES_PER_TIER);
  const beforeSeatsPerPopulation =
    giSeatPlanOf(beforeUntagged(), HARD_CAP).seats * 3; // near + mid + impostor, all seated
  const beforeGrassSeats = 1 * GRASS_RINGS; // a plain Mesh always seats 1 pre-tag
  const beforeTotal = beforeSeatsPerPopulation * POPULATIONS + beforeGrassSeats;

  const afterNear = fakeInstancedMesh(INSTANCES_PER_TIER, { giTrace: "none" });
  const afterMid = fakeInstancedMesh(INSTANCES_PER_TIER, { giInstanceCap: 48 });
  const afterImpostor = fakeInstancedMesh(INSTANCES_PER_TIER, { giTrace: "none" });
  const afterSeatsPerPopulation =
    giSeatPlanOf(afterNear, HARD_CAP).seats +
    giSeatPlanOf(afterMid, HARD_CAP).seats +
    giSeatPlanOf(afterImpostor, HARD_CAP).seats;
  const afterGrassRing = fakeMesh({ giTrace: "none" });
  const afterGrassSeats = giSeatPlanOf(afterGrassRing, HARD_CAP).seats * GRASS_RINGS;
  const afterTotal = afterSeatsPerPopulation * POPULATIONS + afterGrassSeats;

  assert.equal(beforeTotal, 256 * 3 * POPULATIONS + GRASS_RINGS); // 5379
  assert.equal(afterSeatsPerPopulation, 48); // 0 + 48 + 0
  assert.equal(afterTotal, 48 * POPULATIONS); // 336
  console.log(
    `[gi-foliage-seating] seats claimed: before ${beforeTotal}, after ${afterTotal} ` +
      `(${POPULATIONS} populations x 3 tiers @ ${INSTANCES_PER_TIER} instances + ${GRASS_RINGS} grass rings)`,
  );
});
