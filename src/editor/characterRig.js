import { engine } from "./engineInstance.js";
import { commandBus } from "./commands/CommandBus.js";
import { CreateEntityCommand } from "./commands/entityCommands.js";
import { SetTransformCommand } from "./commands/transformCommands.js";
import { useProjectStore } from "./store/projectStore.js";
import { useSelectionStore } from "./store/selectionStore.js";
import { invoke } from "./assetOps.js";
import { writeBinaryFile } from "./assetLoader.js";
import { unpackGlb } from "./glbImport.js";
import { instantiatePrefab } from "./prefab.js";
import {
  CHARACTER_DEFAULT_HEIGHT,
  CHARACTER_DEFAULT_RADIUS,
  characterPhysicsAvailable,
  characterRigSpec,
} from "./characterRigSpec.js";
import {
  CHARACTER_CAMERA_FILE,
  CHARACTER_CAMERA_SOURCE,
  CHARACTER_CONTROLLER_FILE,
  CHARACTER_CONTROLLER_SOURCE,
} from "./templates/characterScripts.js";
import {
  CHARACTER_LOCOMOTION_ANIM,
  CHARACTER_MODEL_ATTRIBUTION,
  CHARACTER_MODEL_GLB_URL,
  CHARACTER_MODEL_HEIGHT,
} from "../modules/character-controller/characterModel.js";

/**
 * Creating a playable character: the entity rig, its default animated body,
 * and the two scripts that drive both.
 *
 * The scripts are written into the project as ordinary source files rather
 * than hidden inside a component, because a character controller is the part
 * of a game that every project rewrites. Owning the file is the difference
 * between "tune the numbers we thought of" and "add a dodge roll".
 *
 * Existing files are REUSED, never overwritten or duplicated. Adding a second
 * player, or re-adding one after deleting the entity, must not silently
 * discard edits made to the first — and must not leave a project with
 * CharacterController.ts, CharacterController 1.ts and no idea which is live.
 * The same rule applies to the body model below: a second player joins the
 * first one's `Character/` folder rather than unpacking a second copy.
 */

const CHARACTER_MODEL_FOLDER = "Character";
const CHARACTER_MODEL_STEM = "CharacterModel";

/** Where a fresh rig's scripts land. */
function scriptsDirectory() {
  const root = useProjectStore.getState().rootPath;
  return root ? `${root}/scripts` : null;
}

async function fileExists(path) {
  try {
    await invoke("read_text_file", { path });
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensures both character scripts exist in `<root>/scripts` and returns their
 * absolute paths (the same form the inspector's script slots hold).
 *
 * Throws when no project is open — writing a controller into nowhere is not a
 * recoverable situation, and the caller can say so in one place.
 */
export async function ensureCharacterScripts() {
  const directory = scriptsDirectory();
  if (!directory) throw new Error("Open a project before creating a Character Controller.");
  await invoke("create_dir", { path: directory }).catch(() => {});

  const written = [];
  const paths = {};
  for (const [file, source] of [
    [CHARACTER_CONTROLLER_FILE, CHARACTER_CONTROLLER_SOURCE],
    [CHARACTER_CAMERA_FILE, CHARACTER_CAMERA_SOURCE],
  ]) {
    const path = `${directory}/${file}`;
    if (!(await fileExists(path))) {
      await invoke("save_scene", { path, contents: source });
      written.push(file);
    }
    paths[file] = path;
  }
  if (written.length) await useProjectStore.getState().refresh();
  return {
    controller: paths[CHARACTER_CONTROLLER_FILE],
    camera: paths[CHARACTER_CAMERA_FILE],
    written,
  };
}

/**
 * Ensures the default body model exists at `<root>/Character/CharacterModel/`
 * and returns `{ prefabPath, nativeHeight }`.
 *
 * The model ships vendored inside the editor bundle (`characterModel.js`,
 * `?url`-imported like the Draco codec) rather than fetched live from Poly
 * Pizza: that provider needs a saved API key with no anonymous read tier, so
 * fetching it at creation time would make "add a Character Controller" fail
 * on any project that hasn't configured one. Unpacking it runs the SAME
 * pipeline a Poly Pizza import does (`unpackGlb` — `.geom`/`.mat` extraction,
 * skinned-mesh + bone entities, a generated `.anim`), so the result is
 * indistinguishable from a model the user imported themselves, except its
 * generated animator gets replaced with a real locomotion graph before
 * anything reads it — see `CHARACTER_LOCOMOTION_ANIM`'s docs.
 */
export async function ensureCharacterModel() {
  const root = useProjectStore.getState().rootPath;
  if (!root) throw new Error("Open a project before creating a Character Controller.");
  const folder = `${root}/${CHARACTER_MODEL_FOLDER}`;
  // Predicted, not discovered: `unpackGlb` names a fresh folder after its stem
  // with no suffix (`uniqueChildName` only appends one on a COLLISION), so on
  // the first run this is exactly the path it is about to create — which is
  // what lets the second Character Controller in a project find it here
  // without asking `unpackGlb` anything.
  const modelFolder = `${folder}/${CHARACTER_MODEL_STEM}`;
  const prefabPath = `${modelFolder}/${CHARACTER_MODEL_STEM}.prefab`;
  if (await fileExists(prefabPath)) return { prefabPath, nativeHeight: CHARACTER_MODEL_HEIGHT };

  await invoke("create_dir", { path: folder }).catch(() => {});
  const glbPath = `${folder}/${CHARACTER_MODEL_STEM}.glb`;
  const bytes = new Uint8Array(await (await fetch(CHARACTER_MODEL_GLB_URL)).arrayBuffer());
  await writeBinaryFile(glbPath, bytes);
  const unpackedFolder = await unpackGlb(glbPath, { assetStem: CHARACTER_MODEL_STEM });
  if (!unpackedFolder) throw new Error("Couldn't unpack the default character model.");
  // Overwrite unpackGlb's generated stub — one state per clip, no transitions
  // — with the real locomotion graph. Same filename, so the `animation`
  // component it already wired up needs no changes.
  await invoke("save_scene", {
    path: `${unpackedFolder}/${CHARACTER_MODEL_STEM}.anim`,
    contents: JSON.stringify(CHARACTER_LOCOMOTION_ANIM, null, 2),
  });
  await invoke("save_scene", { path: `${unpackedFolder}/ATTRIBUTION.md`, contents: CHARACTER_MODEL_ATTRIBUTION });
  await useProjectStore.getState().refresh();
  return { prefabPath: `${unpackedFolder}/${CHARACTER_MODEL_STEM}.prefab`, nativeHeight: CHARACTER_MODEL_HEIGHT };
}

/**
 * Writes the scripts and the body model if needed, then creates the rig as
 * ONE undo entry — Ctrl+Z after "Add Character Controller" removes the whole
 * rig, body included, not just the empty shell the entity commands see.
 * Returns `{ entityId, cameraId, bodyId, scripts }`.
 */
export async function createCharacterRig(options = {}) {
  const scripts = await ensureCharacterScripts();
  // `withMesh: false` keeps meaning "no visible body at all" (a caller
  // building its own rig), not "use the capsule instead of the model" — so
  // the model is only attempted when a mesh was wanted in the first place.
  const wantMesh = options.withMesh ?? true;
  let model = null;
  if (wantMesh) {
    try {
      model = await ensureCharacterModel();
    } catch (err) {
      // Never let a missing/broken default body block the one thing this
      // function must do — a capsule with working movement beats no rig at all.
      console.warn(
        `Character Controller: couldn't set up the default body (${err.message ?? err}) — using a capsule instead.`,
      );
    }
  }

  const mark = commandBus.markGroup();
  const spec = characterRigSpec({ ...options, scripts, withMesh: wantMesh && !model });
  const command = new CreateEntityCommand(
    options.parentId ? { ...spec, parentId: options.parentId } : spec,
  );
  commandBus.execute(command);

  let bodyId = null;
  if (model) {
    // The model's own origin is already at its feet (verified against its
    // bind-pose bounds), unlike the capsule primitive it replaces — so the
    // body sits at the rig's origin with no vertical offset, scaled uniformly
    // so its authored height matches this rig's capsule (height + 2×radius).
    const height = options.height ?? CHARACTER_DEFAULT_HEIGHT;
    const radius = options.radius ?? CHARACTER_DEFAULT_RADIUS;
    const scale = (height + radius * 2) / model.nativeHeight;
    bodyId = await instantiatePrefab(model.prefabPath, null, command.entityId);
    if (bodyId) {
      const bodyEntity = engine.getEntity(bodyId);
      if (bodyEntity) bodyEntity.name = "Body";
      commandBus.execute(
        new SetTransformCommand(bodyId, {
          position: [0, 0, 0],
          // The source model is authored facing +Z; the rig's forward
          // convention (CharacterController.updateFacing, CharacterCamera's
          // yaw) is -Z, matching the third-person camera sitting at +Z behind
          // the player. Confirmed by screenshot — without this the character
          // faces the camera instead of away from it.
          rotation: [0, Math.PI, 0],
          scale: [scale, scale, scale],
        }),
      );
    }
  }
  commandBus.collapseFrom(mark, "Create Character Controller");
  useSelectionStore.getState().select(command.entityId);

  if (!characterPhysicsAvailable()) {
    console.warn(
      "Character Controller: the Physics (Rapier) module is off, so the rig has no collider and " +
        "will fall through the floor. Enable it in the Modules panel and re-add the component.",
    );
  }
  const entity = engine.getEntity(command.entityId);
  const camera = (entity?.children ?? []).find((child) => child.getComponent("camera"));
  return {
    entityId: command.entityId,
    cameraId: camera?.id ?? null,
    bodyId,
    scripts,
  };
}

export { characterPhysicsAvailable, characterRigSpec };
