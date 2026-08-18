import { getComponentClass } from "../engine/components/registry.js";

/**
 * The shape of a player rig, as data.
 *
 * Split from `characterRig.js` because that module reaches the filesystem (it
 * writes the scripts) and the project store, which drags in React components
 * and Tauri — none of which a test of "where does the capsule sit" should have
 * to boot. The same split `blockoutDraw.js` makes for the same reason.
 */

/** True when the Rapier module is on, so the rig can carry a real controller. */
export function characterPhysicsAvailable() {
  return !!getComponentClass("charactercontroller");
}

/** The rig's own defaults, exported so `characterRig.js` can compute the
 *  default body model's scale from the SAME numbers this function defaults to
 *  when a caller doesn't pass height/radius — one source of truth instead of
 *  two literals that could drift apart. */
export const CHARACTER_DEFAULT_HEIGHT = 1;
export const CHARACTER_DEFAULT_RADIUS = 0.3;

/**
 * The entity spec for a player rig.
 *
 * ## The origin is at the character's FEET
 *
 * The Character Controller's capsule is centred on its `offset`, so the rig
 * pushes the capsule up by half its own height instead of leaving it centred
 * on the entity. Everything downstream depends on that choice: a player is
 * placed on a floor at that floor's elevation (not floating half a body above
 * it), "Eye Height 1.6" means what it says, and crouching shrinks the capsule
 * toward the ground rather than lifting the feet through it.
 *
 * The stand-in mesh and the camera are CHILDREN for the same reason — a mesh
 * component has no offset of its own — and the camera in particular, because a
 * camera parented elsewhere outlives the player it belonged to and keeps
 * rendering the scene from a dead body's eyes.
 */
export function characterRigSpec({
  name = "Player",
  view = "third",
  scripts = null,
  position = [0, 0, 0],
  height = CHARACTER_DEFAULT_HEIGHT,
  radius = CHARACTER_DEFAULT_RADIUS,
  withMesh = true,
  physics = null,
} = {}) {
  const components = [];
  const centre = height / 2 + radius; // capsule centre above the feet
  const wantPhysics = physics ?? characterPhysicsAvailable();
  if (wantPhysics) {
    components.push({
      type: "charactercontroller",
      props: {
        height,
        radius,
        offset: [0, centre, 0],
        slopeClimbAngle: 50,
        autostep: true,
        autostepHeight: 0.35,
        snapToGround: true,
      },
    });
  }
  if (scripts) {
    components.push({
      type: "script",
      props: {
        // Order is execution order: the body moves, then the camera reacts to
        // where it ended up. Reversed, the camera trails one frame behind and
        // the whole rig reads as laggy.
        scripts: [
          { path: scripts.controller, enabled: true, attributes: {} },
          { path: scripts.camera, enabled: true, attributes: { view } },
        ],
      },
    });
  }

  // `withMesh` is the CAPSULE fallback, not "does the rig get a visible body" —
  // `characterRig.js` normally attaches a real animated model as a separate
  // "Body" child of its own (a prefab instance, which this pure data function
  // has no business building), and only asks for the capsule when the model
  // couldn't be set up (offline first unpack failing, a headless test with no
  // canvas) or when a caller explicitly wants the plain primitive.
  const children = [];
  if (withMesh) {
    children.push({
      name: "Body",
      // The capsule primitive is radius 0.5 with a 1-unit cylinder section, so
      // scaling by (r/0.5, h, r/0.5) reproduces the collider exactly.
      transform: { position: [0, centre, 0], scale: [radius / 0.5, height, radius / 0.5] },
      components: [{ type: "mesh", props: { geometry: "capsule", castShadow: true, receiveShadow: true } }],
    });
  }
  children.push({
    name: "Camera",
    // First person parks it at eye height, third person behind the shoulder.
    // The camera script moves it every frame anyway — this is only what the
    // editor shows before Play, and where a scene without the scripts renders
    // from.
    transform: { position: [0, view === "first" ? 1.6 : 1.5, view === "first" ? 0 : 4] },
    components: [{ type: "camera", props: { fov: 60 } }],
  });

  return {
    name,
    transform: { position, rotation: [0, 0, 0], scale: [1, 1, 1] },
    components,
    children,
  };
}
