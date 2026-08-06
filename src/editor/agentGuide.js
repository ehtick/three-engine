// @ts-check
/**
 * The orientation note an AI agent finds in the user's project folder.
 *
 * ## Why a file in the project, and not just tool descriptions
 *
 * An agent connecting to the `three-engine` MCP server sees a list of ~95 tools
 * and nothing else. It knows what each one does and not one thing about where it
 * is: that this folder is a game, that a live editor has it open right now, that
 * the `.scene` file is generated and should be edited through tools rather than
 * as JSON, that `Library/` is a derived cache. Agents that read a file before
 * acting (Claude Code, Codex, Cursor — all of them look for AGENTS.md or
 * CLAUDE.md in the working directory) get that context for free, and the ones
 * that don't still get the shorter version through the MCP server's own
 * `instructions` field.
 *
 * ## Why only on connect
 *
 * Writing this into every project the moment it opens would put a file about AI
 * assistants in the folder of someone who has never used one — clutter with an
 * opinion in it. So it is scaffolded the first time an assistant actually dials
 * the bridge, which is the moment the file becomes true.
 *
 * ## Why it never overwrites
 *
 * The whole point is that the user can edit it — project-specific conventions,
 * "don't touch the boss arena", the tone they want. A scaffold that rewrites on
 * every connect would silently delete that. New engine versions therefore do not
 * update an existing guide; deleting it and reconnecting is the way to get the
 * current one.
 */
import { useProjectStore } from "./store/projectStore.js";
import { invoke } from "./assetOps.js";

const GUIDE_FILE = "AGENTS.md";
const CLAUDE_FILE = "CLAUDE.md";

/**
 * Deliberately free of anything that goes stale.
 *
 * No tool list, no module list, no scene names — those change, and a document
 * that confidently describes last week's project is worse than no document. It
 * says where things live and which tool ANSWERS each question, so the agent
 * reads the live state from the editor instead of from a file.
 */
function guideText(projectName) {
  return `# ${projectName} — notes for an AI assistant

You are working in a **game project** built with Three Engine, a three.js/WebGPU
game editor. This folder is the game: its scenes, scripts, materials, textures
and audio.

**A live editor has this folder open right now.** That is the important part.
You are not editing files in isolation — there is a running application holding
this project in memory, rendering it, with an undo stack and a person watching.
You reach it through the \`three-engine\` MCP server.

## Your purpose here

Help the person make and ship this game. In practice that means building and
adjusting scenes, writing gameplay scripts, sourcing and processing assets, and
getting builds out — the things they would otherwise do by hand in the editor.

## Start here, every session

Call these three before doing anything else. They cost nothing and they are the
difference between working on this project and working on your idea of it:

- \`editor_status\` — is the editor actually connected? If not, nothing else here
  will work and you should say so rather than writing files and hoping.
- \`scene_get\` and \`entity_list\` — what is in the scene right now.
- \`module_list\` — which engine modules this project has enabled. Many tools are
  gated on their module and will refuse with a message naming it; enabling one is
  \`module_setEnabled\`, and it is a real decision about what the project ships,
  so ask before turning something on.

\`component_types\` lists every component and its properties. Read it rather than
guessing property names — it is generated from the component classes, so it is
never out of date.

## Two ways to change things — and when each is right

**Prefer the MCP tools.** An edit made through a tool goes through the editor's
command bus: it appears in the viewport immediately, it lands on the undo stack
(the person can press Ctrl+Z on your work, which is the whole safety story), and
it marks the project dirty so it saves correctly.

**Editing files directly is fine for scripts** — they are ordinary TypeScript and
that is how they are meant to be written. The editor watches the folder and picks
up outside changes on its own.

**Do not hand-edit \`.scene\` files.** They are a serialization format, not a
source format: ids, component props and prefab overrides are cross-referenced,
and the editor already has that scene loaded in memory. Your edit will either be
overwritten by the next save or produce a scene that loads with pieces missing.
Use \`entity_*\` and \`component_*\` instead.

If you do write project files with your own tools and want to be certain the
editor has noticed, call \`asset_refresh\`. \`asset_watchStatus\` tells you whether
the folder is being watched at all.

## Version control

Call \`git_status\` early. If this project is a git repository, that changes what
"careful" means here: a commit is the only undo that survives closing the editor,
and the undo stack does not.

- Before a large or risky change — a refactor across scenes, a bulk asset
  operation, anything you would not want to unpick by hand — commit what is
  there first, so the person can get back to it.
- Commit your own work when a piece of it is finished, with a message saying what
  changed and why. Do not batch an afternoon into one commit.
- \`git_discard\` deletes uncommitted work permanently. Never call it to "clean
  up"; ask first, every time. \`git_stash\` is the reversible version.
- Do not commit on someone's behalf without saying so, and do not push unless
  you were asked to. Pushing is visible to other people.

If \`git_status\` reports no repository, do not create one uninvited — offer it.

## What is in this folder

- \`scenes/\` — \`.scene\` files. The one open in the editor is reported by
  \`scene_get\`.
- \`scripts/\` — gameplay scripts (TypeScript). See below.
- \`materials/\`, \`textures/\`, \`models/\`, \`audio/\`, \`prefabs/\` — assets. Exact
  names vary by project; \`asset_list\` is authoritative.
- \`engine-types/\` — **generated.** TypeScript declarations for the \`engine\` and
  \`editor\` modules, rewritten by the editor on every open. Never edit; read it
  freely, it is the best documentation of the scripting API there is.
- \`Library/\` — **derived cache** (baked data, thumbnails). Never edit, never
  commit, and do not reason about the game from its contents.
- \`project.json\` — project settings, including the enabled module list and build
  settings. Change it through \`build_setSettings\` / \`module_setEnabled\` rather
  than by hand.

## Making art, not just placing it

You can author textures and edit meshes here — the same editors a person uses,
driven as tools.

**Textures** are documents of layers saved as a flat PNG plus a \`.tex\` sidecar.
\`texture_create\` makes one, \`texture_draw\` puts shapes and gradients on it,
\`texture_generate\` fills a layer with noise or a checker, \`texture_process\`
applies anything \`texture_effects\` lists, and \`texture_addLayer\` /
\`texture_setLayer\` stack them. A texture that is data rather than colour — a
roughness or normal map — needs \`texture_setMeta\` with \`colorSpace: "linear"\`,
or it will be read as sRGB and be quietly wrong everywhere it is sampled.

**Meshes** work like Blender's Edit Mode, because they are the same model:
\`geometry_beginEdit\` opens an entity's mesh, \`geometry_select\` chooses what to
work on, \`geometry_edit\` runs an operator from \`geometry_operations\` (extrude,
inset, bevel, subdivide, dissolve, bridge…), and \`geometry_commit\` writes it
back. Two things worth knowing before you start:

- **Nothing is saved until you commit.** A session left open changes nothing; a
  cancelled one throws the edits away.
- **Describe the selection, don't index it.** \`box\`, \`trait\`, \`similar\` and
  \`linked\` survive an operator rebuilding the topology. Element indices do not —
  they mean something different after every extrude.

## Writing scripts

Scripts are TypeScript classes extending \`Script\`, imported from \`"engine"\`:

\`\`\`ts
import { Script } from "engine";

export default class Spinner extends Script {
  speed = 1;

  onUpdate(dt: number) {
    this.entity.rotate(0, this.speed * dt, 0);
  }
}
\`\`\`

The API is fully typed through \`engine-types/\` — **if you find yourself passing a
magic string, you are probably using the wrong call.** Check the declarations
before inventing an API. \`asset_createScript\` scaffolds a new one with the right
shape; hot reload picks up your edits without a restart.

## Things worth knowing before you break one

- **Undo covers editor commands, not file writes.** \`entity_*\`, \`component_*\` and
  friends are undoable. \`asset_write\`, \`asset_delete\` and the build tools are
  not — \`asset_delete\` in particular is a filesystem delete of the user's work.
  Ask first.
- **\`batch\` is one undo step.** Building a five-entity rig as five calls gives the
  person five things to undo; as one \`batch\` it is one, and it is also one round
  trip.
- **Check your work by looking at it.** \`viewport_screenshot\` returns a real
  image of the scene, \`entity_getBounds\` gives extents you cannot infer from
  transforms, and \`console_read\` shows the errors the editor logged. Building 3D
  scenes without looking at them produces confident nonsense.
- **Some tools take minutes.** \`build_export\`, \`asset_compressAllTextures\` and
  library imports are slow by nature, not hung.
- **\`build_publish\` opens a browser window** for the user to log in the first
  time. Tell them to expect it; it cannot complete unattended.

## When you are stuck

\`editor_status\` first — a disconnected editor explains most failures. After that,
tool errors here are written to be read: an op that refuses names the module to
enable, the parameter that was wrong, or the path that was outside the project.
`;
}

const claudeText = `See [AGENTS.md](./AGENTS.md) — the orientation notes for this project apply to
Claude Code too.

@AGENTS.md
`;

/** Resolves true if the file already exists in the project. */
async function exists(path) {
  try {
    await invoke("read_text_file", { path });
    return true;
  } catch {
    return false;
  }
}

/**
 * Writes the guide into the open project, unless it is already there.
 *
 * Never throws: this runs off the back of an MCP connection, and a project
 * folder that happens to be read-only is not a reason to fail the connection the
 * user was waiting for. Returns what it wrote, for the tests and the log line.
 *
 * @param {string | null} [root] project folder; defaults to the open project
 * @returns {Promise<string[]>} paths written (empty when nothing was needed)
 */
export async function ensureAgentGuide(root = useProjectStore.getState().rootPath) {
  if (!root) return [];
  const written = [];
  try {
    const guidePath = `${root}/${GUIDE_FILE}`;
    if (!(await exists(guidePath))) {
      const name = useProjectStore.getState().projectMeta?.name || root.split(/[\\/]/).pop() || "This project";
      await invoke("save_scene", { path: guidePath, contents: guideText(name) });
      written.push(guidePath);
    }
    // A separate file rather than one document, because the two are read by
    // different tools and only one of them supports the `@` import. Claude Code
    // reads CLAUDE.md; Codex and Cursor read AGENTS.md. Pointing one at the
    // other keeps a single source of truth for the user to edit.
    const claudePath = `${root}/${CLAUDE_FILE}`;
    if (!(await exists(claudePath))) {
      await invoke("save_scene", { path: claudePath, contents: claudeText });
      written.push(claudePath);
    }
  } catch (err) {
    console.warn(`Couldn't write the assistant guide into the project: ${err}`);
    return written;
  }
  if (written.length) {
    console.log(`An assistant connected — wrote ${written.map((p) => p.split("/").pop()).join(" and ")} to orient it.`);
    useProjectStore.getState().refresh().catch(() => {});
  }
  return written;
}
