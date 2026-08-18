/**
 * Character Controller module — the default animated player body.
 *
 * No components of its own: the actual movement is `CharacterControllerComponent`
 * (owned by `physics-rapier`, since a kinematic capsule is a physics primitive)
 * driven by plain script files the feature writes into the project
 * (`scripts/CharacterController.ts` / `CharacterCamera.ts` — see
 * `docs/LEVEL_DESIGN.md`). What THIS module owns is the asset behind
 * `Editor.character.create`'s default visible body: a vendored, rigged,
 * animated humanoid (`characterModel.js` for the `?url`-imported GLB,
 * `characterModelData.js` for the clip names, measured native height, and the
 * hand-authored locomotion graph) plus its raw FBX sources
 * (`assets/source/`) for whoever needs to re-merge a different character.
 *
 * Split out from Level Design on request — a level's blockout geometry and a
 * player's body are unrelated things that happened to ship in the same PR,
 * and a project that only wants one should be able to enable just that one.
 * `characterRig.js` (the editor-side rig-creation code — commandBus, prefab
 * instantiation, none of which a runtime module has business owning) imports
 * from here the same way it always could.
 *
 * Zero components is not unusual — audio-library, texture-editor, draco and
 * several other modules are pure tooling/asset modules with an empty
 * `components` list; the Modules panel is where they all still show up.
 */
export const characterControllerModule = {
  id: "character-controller",
  name: "Character Controller",
  version: "1.0.0",
  category: "World",
  tags: ["character", "controller", "player", "first-person", "third-person", "locomotion", "animation"],
  description:
    "A playable character: a kinematic capsule controller, a real animated " +
    "humanoid body with a working Idle/Run/Jump locomotion graph, a child " +
    "camera, and the two scripts that drive it all — fully editable, not " +
    "hidden behind a component.",
  components: [],
};
