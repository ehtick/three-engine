/**
 * Generates `<project>/project-events.d.ts` from the project's event catalog.
 *
 * This is the file that makes "create an event in the Events panel" mean "the
 * event is typed in every script, everywhere, immediately". Without it a game's
 * own events need a hand-written `declare module "engine"` merge that the user
 * has to author and keep in sync — which is exactly the kind of thing the
 * no-strings rule exists to remove.
 *
 * ## Why the project ROOT and not `engine-types/`
 *
 * Every other generated declaration lives in `<project>/engine-types/`. This one
 * cannot: the tsconfig we scaffold says
 *
 *     include: ["**\/*.ts", "**\/*.js", ...]
 *     exclude: ["node_modules", "engine-types", "dist"]
 *
 * and the exclusion is deliberate — `engine-types/` is reached through `paths`,
 * and having it in `include` as well makes TypeScript resolve those declarations
 * twice. But a module *augmentation* only applies if the file is part of the
 * program, and `paths` alone never pulls one in. Written under `engine-types/`
 * this file would be excluded, compile as nothing, and the user would see
 * autocomplete simply not know their events — with no error anywhere to explain
 * it. That is the same silent-degradation failure `projectTypes.js` documents
 * for three's declarations, and it is worth being just as loud about.
 *
 * So: project root, where `include` picks it up, with a "generated" banner on
 * line 1 because it is now a file the user can see.
 */
import { generateEventTypes, normalizeEventCatalog } from "../engine/events/catalog.js";

/** Where the generated declarations live, relative to the project root. */
export const PROJECT_EVENTS_DTS = "project-events.d.ts";

/**
 * Writes the declarations for `events` (the raw `project.json` block) into the
 * project.
 *
 * Returns the generated source so callers that also feed the embedded Monaco —
 * which reads declarations from memory, not from disk — don't have to rebuild
 * it. Never throws: a project whose types can't be written still runs, the user
 * just loses autocomplete, and taking down a save because of it would be worse.
 */
export async function writeProjectEventTypes(projectRoot, events) {
  if (!projectRoot) return null;
  const { events: normalized } = normalizeEventCatalog(events);
  const contents = generateEventTypes(normalized);
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("save_scene", {
      path: `${projectRoot}/${PROJECT_EVENTS_DTS}`,
      contents,
    });
  } catch (err) {
    console.warn(
      `Couldn't write ${PROJECT_EVENTS_DTS} — your project's events won't autocomplete in scripts: ${err}`,
    );
  }
  return contents;
}

/**
 * Feeds the generated declarations to the embedded code editor.
 *
 * Monaco builds its program from libraries registered in memory, not from the
 * project on disk, so writing the file is only half the job — without this the
 * in-editor Code panel would be the one place a project's own events *don't*
 * autocomplete. Re-registering the same URI replaces the previous version, so
 * this is safe to call on every catalog change.
 */
export async function syncProjectEventTypesToMonaco(contents) {
  if (contents == null) return;
  try {
    const { registerExtraLib } = await import("./code/monaco.js");
    await registerExtraLib(contents, "file:///project-events.d.ts");
  } catch (err) {
    console.warn(`Couldn't refresh the code editor's event declarations: ${err}`);
  }
}
