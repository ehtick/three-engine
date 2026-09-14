/**
 * World, as ops (09-14). Authored World settings are the component's
 * `document` prop and go through `component.setProp`; what is here is the
 * DERIVED half an agent cannot read back from props:
 *
 *   · `world.streamingStatus` — what chunk streaming has actually built right
 *     now (tiles, pending builds, triangles, streamed stone, live colliders),
 *     plus an optional downward ray at a probe point that proves streamed
 *     ground collides while playing, without moving anything in the scene.
 */
import { defineOp } from "../registry.js";
import { engine } from "../../engineInstance.js";
import { useModulesStore } from "../../modules.js";

function findWorld(entityId) {
  if (!useModulesStore.getState().enabled.includes("world")) {
    throw new Error('The "world" module is not enabled for this project. Enable it with module.setEnabled.');
  }
  if (entityId) {
    const entity = engine.getEntity(entityId);
    const component = entity?.getComponent?.("world");
    if (!component) throw new Error(`Entity "${entityId}" has no World component.`);
    return { entity, component };
  }
  const hosts = [...engine.entities.values()].filter((entity) => entity.getComponent?.("world"));
  if (!hosts.length) throw new Error("No World component in the scene.");
  if (hosts.length > 1) throw new Error(`${hosts.length} Worlds in the scene — pass entityId (${hosts.map((e) => e.id).join(", ")}).`);
  return { entity: hosts[0], component: hosts[0].getComponent("world") };
}

defineOp({
  name: "world.streamingStatus",
  readOnly: true,
  description:
    "What a World's chunk streaming has built right now: whether it is on, chunk size and radii, loaded tiles vs desired, pending builds, streamed ground triangles, streamed rocks and their draws, whether the rock library is ready, and the live heightfield colliders on streamed ground (colliders only exist in Play). Pass `probe: [x, z]` (world metres) to cast a ray straight down there through the physics world while playing: it reports the hit point and which entity owns the ground — the World for streamed chunks — which is how to prove a player can walk off the authored region without moving anything.",
  params: {
    entityId: { type: "string", description: "The World entity. Omit for the scene's only one." },
    probe: { type: "array", description: "[x, z] world position to raycast straight down (Play only)." },
  },
  run: ({ entityId, probe }) => {
    const { entity, component } = findWorld(entityId);
    const status = { entityId: entity.id, playing: !!engine.playing, ...component.streamingStatus() };
    if (Array.isArray(probe) && probe.length >= 2) {
      const [x, z] = probe.map(Number);
      if (!engine.physics?.world) {
        status.probe = { x, z, hit: null, note: "No physics world — enter Play (play.set) to probe collisions." };
      } else {
        const hit = engine.physics.raycast([x, 5000, z], [0, -1, 0], 10000);
        status.probe = hit
          ? { x, z, hit: true, y: +hit.point[1].toFixed(3), owner: hit.entity?.id ?? null, ownerName: hit.entity?.name ?? null, streamedGround: hit.entity === entity }
          : { x, z, hit: false };
      }
    }
    return status;
  },
});
