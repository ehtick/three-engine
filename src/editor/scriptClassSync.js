/**
 * Helpers for keeping a script's default-exported class name in sync with its
 * filename — in both directions.
 *
 * The pairing is deliberately narrow: a script file may declare as many classes
 * as it likes, and only the DEFAULT-EXPORTED one is the script. Helper classes,
 * data holders and everything else in the file are none of this module's
 * business and are never touched.
 *
 * Renaming the file rewrites that one class (`syncScriptClassNameAfterRename`,
 * used by both the Assets panel's inline rename and the Asset Inspector's name
 * field). Renaming that one class in the editor renames the file back
 * (`filenameForScriptSource`, applied on save by `CodeEditor`). Either way the
 * two names never drift apart, and `retargetScriptPath` moves the references —
 * open tabs, the shared Monaco model, every entity's script slots — so a rename
 * from one side doesn't leave the other pointing at a file that is gone.
 */

/** File stem → PascalCase identifier (e.g. "player_controller" → "PlayerController").
 *  Guarantees the result is a valid JS class name (starts with a letter/_, no
 *  leading digits). Falls back to "NewScript" for purely-symbolic input. */
export function stemToClassName(stem) {
  const parts = stem
    .replace(/\.(ts|js)$/i, "")
    .split(/[\s\-_]+/)
    .filter(Boolean);
  const pascal = parts
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("")
    // Drop anything outside the JS identifier character set (TS/JS identifiers
    // can contain letters, digits, _, $ — but the first char must not be a
    // digit, handled by prepending "Script" if necessary below).
    .replace(/[^A-Za-z0-9_$]/g, "");
  if (!pascal) return "NewScript";
  if (/^[0-9]/.test(pascal)) return `Script${pascal}`;
  return pascal;
}

/**
 * Rewrites a `.ts`/`.js` script so its default-exported class matches the new
 * filename's stem, and (if missing) extends the engine `Script` base class.
 *
 * - `export default class Foo extends Script` → `export default class NewFoo extends Script`
 * - `export default class Foo { ... }`        → `export default class NewFoo extends Script { ... }`
 *
 * Returns the modified source, or `null` if the file isn't a script / has no
 * recognizable default-exported class (in which case the rename still happens
 * but the class name is left as-is).
 */
export async function syncScriptClassName(filePath, newStem) {
  const lower = filePath.toLowerCase();
  if (!lower.endsWith(".ts") && !lower.endsWith(".js")) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  let raw;
  try {
    raw = await invoke("read_text_file", { path: filePath });
  } catch {
    return null;
  }
  // Find the start of `export default class <Name>` (no further parsing yet).
  const classDeclRe = /\bexport\s+default\s+class\s+[A-Za-z_$][\w$]*/g;
  const match = classDeclRe.exec(raw);
  if (!match) return null;

  // Walk forward from end-of-name, tracking nested angle brackets and parens,
  // until we hit the class body open `{` at depth 0. That walks over any
  // generic parameter list (`<T, U>`), the optional `extends <TypeRef>`
  // clause (where TypeRef may itself have generics, e.g. `Base<Props>`), and
  // any implements clause.
  let i = match.index + match[0].length;
  let depth = 0;
  const middleStart = i;
  while (i < raw.length) {
    const c = raw[i];
    if (c === "{" && depth === 0) break;
    if (c === "(" || c === "<" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === ">" || c === "]" || c === "}") depth--;
    i++;
  }
  if (i >= raw.length) return null; // no class body found
  const middle = raw.slice(middleStart, i);
  const body = raw.slice(i);

  // If the script has no `extends` clause, inject `extends Script` so the
  // engine's typed context (`this.entity`, `this.engine`, …) is picked up.
  let newMiddle = middle;
  if (!/\bextends\b/.test(middle)) {
    newMiddle = middle.replace(/(\s*)$/, "") + " extends Script" + (middle.match(/(\s*)$/)?.[1] ?? "");
    if (!/\s$/.test(newMiddle)) newMiddle += " ";
  }

  const newClassName = stemToClassName(newStem);
  const declOpen = `export default class ${newClassName}`;
  return raw.slice(0, match.index) + declOpen + newMiddle + body;
}

/**
 * After a rename on disk, rewrites the script's class name (and injects
 * `extends Script` if missing). Caller is responsible for the actual
 * `rename_path` invocation; this only handles the in-file class-name sync.
 *
 * Safe to call on non-script files — returns null and does nothing.
 */
export async function syncScriptClassNameAfterRename(newPath, newStem) {
  const lower = newPath.toLowerCase();
  if (!lower.endsWith(".ts") && !lower.endsWith(".js")) return;
  const { invoke } = await import("@tauri-apps/api/core");
  const updated = await syncScriptClassName(newPath, newStem);
  if (updated !== null) {
    try {
      await invoke("save_scene", { path: newPath, contents: updated });
    } catch (err) {
      console.warn(`Renamed file but couldn't sync class name: ${err}`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* The other direction: the class in the file names the file                   */
/* -------------------------------------------------------------------------- */

/** Line and block comments, blanked so a commented-out declaration can't win. */
function withoutComments(source) {
  return String(source ?? "")
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));
}

/**
 * The name of the class this file exports as its script, or null.
 *
 * Both spellings people actually write are recognised:
 *
 *   export default class Player extends Script { }
 *   class Player extends Script { }  …  export default Player
 *
 * A file with several classes is the normal case, not an edge case — only the
 * default-exported one is returned, and `export default` of anything that is
 * not a class declared in the file (an object, a function, an instance) gives
 * null so nothing gets renamed on its account.
 */
export function defaultExportedClassName(source) {
  const text = withoutComments(source);
  const inline = /\bexport\s+default\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(text);
  if (inline) return inline[1];
  const byName = /\bexport\s+default\s+([A-Za-z_$][\w$]*)\s*(?:;|$)/m.exec(text);
  if (!byName) return null;
  const name = byName[1];
  // Only when that identifier is a class declared here. `export default foo`
  // where foo is a function or a value is not a script class.
  const declared = new RegExp(`\\b(?:abstract\\s+)?class\\s+${name}\\b`).test(text);
  return declared ? name : null;
}

/**
 * The filename this script should have, given its source — or null when it
 * already matches (or there is nothing to match against).
 *
 * The comparison runs through `stemToClassName` in the same direction the other
 * flow does, so "player_controller.ts" holding `class PlayerController` is
 * already in sync and does NOT get renamed to "PlayerController.ts". Only a
 * class name that no longer corresponds to the stem at all moves the file.
 */
export function filenameForScriptSource(filePath, source) {
  const lower = String(filePath ?? "").toLowerCase();
  if (!lower.endsWith(".ts") && !lower.endsWith(".js")) return null;
  const className = defaultExportedClassName(source);
  if (!className) return null;
  const name = String(filePath).replaceAll("\\", "/").split("/").pop() ?? "";
  const ext = name.slice(name.lastIndexOf("."));
  const stem = name.slice(0, name.length - ext.length);
  if (stemToClassName(stem) === className) return null;
  const dir = String(filePath).slice(0, String(filePath).length - name.length);
  return `${dir}${className}${ext}`;
}

/* -------------------------------------------------------------------------- */
/* Moving the references with the file                                         */
/* -------------------------------------------------------------------------- */

const samePath = (a, b) =>
  String(a ?? "").replaceAll("\\", "/").toLowerCase() ===
  String(b ?? "").replaceAll("\\", "/").toLowerCase();

/**
 * Points everything that referred to `oldPath` at `newPath`.
 *
 * A rename that only moves the file leaves the editor lying to the user: the
 * Code panel still shows a tab for a path that no longer exists, the shared
 * Monaco model still answers to the old URI (so a save writes the deleted name
 * back), and every entity whose Scripts component named the old file silently
 * stops running its behaviour. This moves all three.
 *
 * The component edits go through the command bus like every other component
 * change, so the scene is marked dirty and the inspector re-renders. Undo of
 * one of them would point a slot back at a filename that is gone — renaming
 * again is the way back, and that is still better than a scene that quietly
 * lost its scripts.
 */
export async function retargetScriptPath(oldPath, newPath) {
  // Exact comparison, not `samePath`: a case-only rename is a real rename here
  // (the tab label and the model URI both carry the old spelling) even though
  // every path comparison below treats the two as the same file.
  if (!oldPath || !newPath || oldPath === newPath) return;

  const [{ useCodeStore }, { disposeModel }] = await Promise.all([
    import("./codeStore.js"),
    import("./code/monaco.js"),
  ]);

  const { engine } = await import("./engineInstance.js");
  const { commandBus } = await import("./commands/CommandBus.js");
  const { SetComponentPropCommand } = await import("./commands/componentCommands.js");

  for (const rootEntity of engine.rootEntities ?? []) {
    rootEntity.traverse((entity) => {
      const slots = entity.getComponent?.("script")?.props?.scripts;
      if (!Array.isArray(slots) || !slots.some((slot) => samePath(slot?.path, oldPath))) return;
      const next = slots.map((slot) =>
        samePath(slot?.path, oldPath) ? { ...slot, path: newPath } : slot,
      );
      commandBus.execute(
        new SetComponentPropCommand(entity.id, "script", "scripts", next, "Rename script"),
      );
    });
  }

  const before = useCodeStore.getState();
  if (before.files.includes(oldPath)) {
    const wasActive = before.activePath === oldPath;
    const previouslyActive = before.activePath;
    // `close` drops the shared model itself once no tab shows the file, which
    // is also what keeps the still-mounted editor from being pulled out from
    // under React mid-render.
    before.close(oldPath);
    useCodeStore.getState().open(newPath);
    // `open` activates what it opens — right when the renamed file was the one
    // being edited, wrong when it was a background tab.
    if (!wasActive) useCodeStore.getState().activate(previouslyActive);
  } else {
    // No tab held it, but the Inspector's inline editor may have created the
    // model anyway. It is keyed by the old URI and its contents now belong to
    // a file under a different name, so leaving it means two documents for one
    // file — and a save from the stale one recreates the old filename.
    await disposeModel(oldPath).catch(() => {});
  }
}

/**
 * Renames a script file so its name matches the class it exports, if they have
 * drifted apart. Returns the new path, or null when nothing needed to move.
 *
 * Refuses rather than clobbers: if a file already sits at the target name, the
 * rename is skipped and the mismatch stays. Silently overwriting somebody
 * else's script because two classes were given the same name is not a trade
 * worth making for a convenience feature.
 */
export async function renameScriptToMatchClass(filePath, source) {
  const target = filenameForScriptSource(filePath, source);
  if (!target) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    // A case-only change is this same file on Windows, so `stat_file` finding
    // something there proves nothing — renaming "playerx.ts" to "PlayerX.ts"
    // must still be allowed.
    if (!samePath(filePath, target)) {
      let taken = true;
      try {
        await invoke("stat_file", { path: target });
      } catch {
        taken = false;
      }
      if (taken) {
        console.warn(`Not renaming to ${target.split(/[\\/]/).pop()} — a file with that name exists.`);
        return null;
      }
    }
    await invoke("rename_path", { from: filePath, to: target });
  } catch (err) {
    console.warn(`Couldn't rename script to match its class: ${err?.message ?? err}`);
    return null;
  }
  await retargetScriptPath(filePath, target);
  return target;
}