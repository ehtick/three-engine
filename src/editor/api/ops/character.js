/**
 * Building a playable character, as an op.
 *
 * Split out of `ops/level.js` when the Character Controller became its own
 * module (`character-controller`, separate from `level-design` — a level's
 * blockout geometry and a player's body are unrelated things that happened to
 * ship together at first). One op, because creating the whole rig — capsule
 * controller, animated body, camera, both scripts — is one atomic thing an
 * agent asks for; tuning afterward goes through `component.setProp` on the
 * script attributes or straight file edits, not more ops here.
 */
import { defineOp } from "../registry.js";
import { useModulesStore } from "../../modules.js";

function requireCharacterModule() {
  if (!useModulesStore.getState().enabled.includes("character-controller")) {
    throw new Error(
      'The "character-controller" module is not enabled for this project. Enable it with module.setEnabled.',
    );
  }
}

defineOp({
  name: "character.create",
  undoable: true,
  description:
    "Create a playable character: an entity with a kinematic Character Controller, an animated humanoid body with a working Idle/Walk/Run/Jump locomotion graph (a real CC0 model + a hand-authored .anim, unpacked into <root>/Character/ the first time and reused after), a child camera, and the two scripts that drive it all (CharacterController.ts and CharacterCamera.ts, written into scripts/ if they are not there yet). The entity's origin is at the character's FEET, so place it at a floor's elevation. Tune it with component.setProp on the script attributes, or edit the files. `withMesh: false` skips the body entirely (neither the model nor a capsule) rather than forcing the plain capsule — that only happens automatically if the default model can't be set up.",
  params: {
    name: { type: "string", default: "Player", description: "Entity name." },
    view: { type: "string", default: "third", description: "first | third — which view the camera starts in." },
    position: { type: "array", description: "World position [x, y, z] of the character's feet." },
    height: { type: "number", default: 1, description: "Capsule collider cylinder height in metres (total height adds 2 × radius) — the visible body is scaled to match it." },
    radius: { type: "number", default: 0.3, description: "Capsule collider radius in metres." },
    withMesh: { type: "boolean", default: true, description: "Give the rig a visible body — the animated default model, or a capsule primitive if the model couldn't be set up. False adds neither." },
    parentId: { type: "string", description: "Parent entity id." },
  },
  async run(args) {
    requireCharacterModule();
    const { createCharacterRig } = await import("../../characterRig.js");
    const rig = await createCharacterRig({
      name: args.name ?? "Player",
      view: args.view === "first" ? "first" : "third",
      position: args.position ?? [0, 0, 0],
      height: args.height ?? 1,
      radius: args.radius ?? 0.3,
      withMesh: args.withMesh ?? true,
      parentId: args.parentId ?? null,
    });
    return {
      entityId: rig.entityId,
      cameraId: rig.cameraId,
      bodyId: rig.bodyId,
      scripts: { controller: rig.scripts.controller, camera: rig.scripts.camera },
      wrote: rig.scripts.written,
      physics: useModulesStore.getState().enabled.includes("physics-rapier"),
    };
  },
});
