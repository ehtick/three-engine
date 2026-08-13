/**
 * Finding — and renaming — an event name across a project's scripts.
 *
 * Renaming an event is a refactor, not a text edit. The catalog entry is the
 * one place the name is *declared*, but every `engine.on("player-died", …)` in
 * every script is a place it is *used*, and a rename that only touches the
 * declaration leaves the generated declarations disagreeing with the code: the
 * new name has no listeners, the old name is a compile error, and neither
 * failure points at the rename that caused it. Godot doesn't do this for
 * signals and it is a known misery there.
 *
 * The match is a quoted string literal holding exactly the event name. That is
 * deliberately syntactic rather than clever: event names travel as strings, a
 * real parse would need the whole TS grammar for a feature whose entire job is
 * to be predictable, and the panel shows every hit before anything is written.
 * False positives are possible (an unrelated string that happens to equal the
 * name) — which is exactly why the user confirms a list rather than a count.
 */
import { listProjectEntries } from "./assetLoader.js";

/** Files worth scanning: the ones a script can be written in. */
const SCRIPT_EXTENSIONS = [".js", ".ts", ".jsx", ".tsx", ".mjs"];

const isScript = (path) => SCRIPT_EXTENSIONS.some((ext) => path.toLowerCase().endsWith(ext));

/** Escapes a name for use inside a RegExp. Event names allow `-`, which is
 *  inert in a character-free context, but this costs nothing and survives the
 *  name rules being loosened later. */
const escapeRe = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A regex matching `"name"`, `'name'` or `` `name` `` — the three ways an event
 * name reaches an `on`/`emit` call. The quote style is captured and required to
 * match on both sides so `"foo'` isn't a hit.
 */
function literalRe(name, flags = "g") {
  return new RegExp(`(['"\`])${escapeRe(name)}\\1`, flags);
}

/**
 * Every place `name` appears as a string literal in the project's scripts.
 *
 * Returns `[{ path, line, column, text }]`, `text` being the trimmed source
 * line so the panel can show it without a second read. Generated declarations
 * are skipped — `project-events.d.ts` is rewritten from the catalog anyway, and
 * listing it as a "usage" would imply the user has to do something about it.
 */
export async function findEventUsages(rootPath, name) {
  if (!rootPath || !name) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  const entries = await listProjectEntries(rootPath).catch(() => []);
  const files = entries.filter(
    (entry) => !entry.is_dir && isScript(entry.path) && !isGenerated(entry.path),
  );
  const hits = [];
  for (const file of files) {
    let source;
    try {
      source = await invoke("read_text_file", { path: file.path });
    } catch {
      continue; // unreadable (locked, binary, gone) — not this feature's problem
    }
    // Cheap reject before the per-line walk: most files won't mention it at all.
    if (!source.includes(name)) continue;
    const lines = source.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const re = literalRe(name);
      let match;
      while ((match = re.exec(lines[i])) !== null) {
        hits.push({
          path: file.path,
          line: i + 1,
          column: match.index + 1,
          text: lines[i].trim(),
        });
      }
    }
  }
  return hits;
}

/** True for files this system generates and therefore must not report or edit. */
function isGenerated(path) {
  const lower = path.replaceAll("\\", "/").toLowerCase();
  return lower.endsWith("/project-events.d.ts") || lower.includes("/engine-types/");
}

/**
 * Rewrites every `"oldName"` string literal to `"newName"` across the project's
 * scripts, preserving each site's original quote style.
 *
 * Returns `{ files, occurrences }`. Writes nothing when there is nothing to
 * change, so calling it after a rename that no script referenced is free.
 */
export async function renameEventInScripts(rootPath, oldName, newName) {
  if (!rootPath || !oldName || !newName || oldName === newName) {
    return { files: 0, occurrences: 0 };
  }
  const { invoke } = await import("@tauri-apps/api/core");
  const entries = await listProjectEntries(rootPath).catch(() => []);
  const files = entries.filter(
    (entry) => !entry.is_dir && isScript(entry.path) && !isGenerated(entry.path),
  );
  let changedFiles = 0;
  let occurrences = 0;
  for (const file of files) {
    let source;
    try {
      source = await invoke("read_text_file", { path: file.path });
    } catch {
      continue;
    }
    if (!source.includes(oldName)) continue;
    let count = 0;
    // `$1` twice keeps the site's own quotes — rewriting a template literal as
    // a double-quoted string would be a gratuitous diff, and rewriting a
    // single-quoted one would fight whatever formatter the user runs.
    const next = source.replace(literalRe(oldName), (_m, quote) => {
      count++;
      return `${quote}${newName}${quote}`;
    });
    if (!count) continue;
    try {
      await invoke("save_scene", { path: file.path, contents: next });
    } catch (err) {
      console.warn(`Couldn't rewrite ${file.path}: ${err}`);
      continue;
    }
    changedFiles++;
    occurrences += count;
  }
  return { files: changedFiles, occurrences };
}
