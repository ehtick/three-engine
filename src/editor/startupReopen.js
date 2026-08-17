/**
 * Picking up where the last session left off.
 *
 * Two things land here, because they are the same thing at different scales:
 *
 *   1. **Launching the app** reopens the project that was open when it was last
 *      closed, and the scene `project.json` names, without stopping at the
 *      picker. The hub is a decision — "which project?" — and re-asking it every
 *      launch of a tool someone uses on one project for weeks is a toll, not a
 *      choice. The hub is still one click away (File → Close Project), and
 *      closing a project deliberately is what makes the next launch start there.
 *   2. **Reloading** — F5, or the `editor.reload` op — comes back to the same
 *      project AND the exact scene that was open, which is not always the one
 *      `project.json` names. That extra precision is the handoff below.
 *
 * ⚠ WHY THIS IS ITS OWN MODULE, LOADED FROM `main.jsx`.
 *
 * The reload hook used to live in `api/ops/editorState.js`, next to the op that
 * writes the handoff — which reads well and could never work. That module is
 * reached only through `installEditorApi()`, which `engineInstance.js`
 * dynamically imports from inside `loadEngine()`. No project open means no
 * engine, which means the ops module is never imported, which means the hook
 * that exists to REOPEN THE PROJECT never runs. The reload therefore always
 * stranded the editor on the project hub — the one state the hook cannot
 * recover from is the only state it was ever asked to handle.
 *
 * So the handoff is split: the op stashes (it already has an engine by
 * definition), and this module — imported unconditionally by the app entry,
 * before anything decides whether to render the hub or the shell — consumes.
 * Nothing here may import the engine, the ops registry, or EditorShell, or the
 * bug comes straight back.
 */
import { useProjectStore, lastProjectPath } from "./store/projectStore.js";

const REOPEN_KEY = "engine.mcpReloadReopen";

/**
 * Opt-out for automated runs. ~160 puppeteer harnesses in `scripts/` drive the
 * hub directly — most click "Skip the project", and the GI/blackframe family
 * seeds a recent list and clicks a row — so a launch that walks past the hub
 * would hang them on a selector that never appears. `installTauriShim` sets
 * this by default, which is the honest reading of the flag: a shimmed Tauri is
 * a test harness, and a test harness wants the picker it was written against.
 */
const autoOpenDisabled = () => globalThis.__editorNoAutoOpen === true;

/**
 * Record where to come back to. Called by the `editor.reload` op immediately
 * before it reloads the page.
 *
 * sessionStorage, not localStorage: this is a handoff across one reload, and it
 * must not outlive the tab. The last-project memory that DOES outlive it is
 * `projectStore`'s own, which is a different fact with a different lifetime.
 */
export function stashReopenTarget(project, scene) {
  if (!project || typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(REOPEN_KEY, JSON.stringify({ project, scene: scene ?? null }));
  } catch {
    // Private mode / no storage — the reload still works, it just falls back to
    // the ordinary "reopen the last project" path. Not worth failing the op over.
  }
}

/** Reads and clears the one-shot reload handoff. */
function takeHandoff() {
  if (typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(REOPEN_KEY);
    // Removed BEFORE it is acted on: a handoff that throws must not be retried
    // on the next reload, or a bad path wedges every future boot.
    if (raw) sessionStorage.removeItem(REOPEN_KEY);
    // Tolerates the pre-JSON format (a bare path) so a reload issued by an
    // older build still lands in its project rather than throwing here.
    if (!raw) return null;
    return raw.startsWith("{") ? JSON.parse(raw) : { project: raw, scene: null };
  } catch {
    return null;
  }
}

/**
 * Reopen a specific scene, once the boot has finished choosing its own.
 *
 * ⚠ THIS IS A REPAIR, NOT THE NORMAL PATH. `restoreLastScene` already reopens
 * the right scene almost always: `lastScene` is written to project.json on
 * every open (sceneIO.js), and the boot prefers it. But it runs from
 * EditorChrome's mount effect, ASYNCHRONOUSLY, so `currentScenePath()` is still
 * null when this resolves. Comparing against null and opening "because it
 * differs" loaded the scene a SECOND time on top of the first: 3064 entities
 * for a 1532-mesh project, with every draw call and triangle doubled.
 *
 * So: wait for the boot to declare itself, and only act if it genuinely landed
 * somewhere else.
 */
async function reopenScene(scene) {
  // Imported here, not at module scope: this pulls in scene IO and its engine
  // dependencies, and the whole point of this module is that it loads before
  // any of that exists. By now a project is open.
  const sceneIO = await import("./sceneIO.js");
  const norm = (p) => (p ?? "").replace(/\\/g, "/").toLowerCase();
  const deadline = performance.now() + 20000;
  while (!sceneIO.sceneBooted && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!sceneIO.sceneBooted) return; // never booted — opening now would race it
  if (norm(sceneIO.currentScenePath()) === norm(scene)) return;
  await sceneIO.openScenePath(scene);
}

/**
 * Decide, synchronously, whether this launch is going to the hub.
 *
 * Called from `main.jsx` BEFORE the first render, so the splash is already up
 * when React paints — the folder check that follows is asynchronous, and the
 * hub painting for those few frames looks like a glitch rather than a decision.
 * Returns the project it intends to open, or null.
 */
function plannedProject() {
  if (autoOpenDisabled()) return null;
  // The store already having a root means something else opened a project
  // during module evaluation; their choice wins.
  if (useProjectStore.getState().rootPath) return null;
  try {
    const raw = typeof sessionStorage === "undefined" ? null : sessionStorage.getItem(REOPEN_KEY);
    if (raw) return raw.startsWith("{") ? (JSON.parse(raw).project ?? null) : raw;
  } catch {
    // fall through to the durable memory
  }
  return lastProjectPath();
}

/**
 * Reopen the last project (and, after a reload, the exact scene).
 *
 * Deferred to a macrotask so the rest of the module graph finishes evaluating
 * first — `openProject` resets the engine and loads a scene, and driving that
 * from inside an import is asking for a half-built module to be observed
 * mid-reset.
 */
export function installStartupReopen() {
  const planned = plannedProject();
  if (!planned) return;
  useProjectStore.setState({ restoring: planned });

  setTimeout(async () => {
    const pending = takeHandoff();
    const project = pending?.project ?? lastProjectPath();
    const store = useProjectStore.getState();
    try {
      // Re-checked rather than trusted: `plannedProject` ran before the first
      // paint, and a user who got to the hub some other way (a failed probe on
      // a previous tick, a harness calling openProject directly) has already
      // said what they want.
      if (!project || store.rootPath) return;
      const opened =
        project === lastProjectPath()
          ? await store.restoreLastFolder()
          : await store.openProject(project);
      if (!opened) return;
      // An explicit handoff scene wins. Without one there is nothing to do:
      // EditorChrome's `restoreLastScene()` already reopens project.json's
      // `lastScene`, which is the scene this project was last looking at.
      if (pending?.scene) await reopenScene(pending.scene);
    } catch (err) {
      console.warn(`Couldn't reopen "${project}": ${err?.message ?? err}`);
    } finally {
      // Clearing this is what drops the splash. On success the shell is
      // already rendering (rootPath is set); on failure it reveals the hub.
      useProjectStore.setState({ restoring: false });
    }
  }, 0);
}
