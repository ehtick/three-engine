/**
 * Writing an empty method into a script from the inspector.
 *
 * The half of Godot's Signals dock that makes it worth using: connecting a
 * signal to a method that doesn't exist yet offers to *create* it, so wiring
 * and implementing are one gesture instead of "pick a name, remember it, find
 * the file, scroll to the class, type it again, hope it matches".
 *
 * Deliberately minimal — it inserts a method and nothing else. Anything
 * cleverer (guessing parameters from the event, adding a body) would be
 * guessing at code the author is about to write anyway, and a wrong guess in
 * someone's source file costs more to undo than it saved.
 */
import { defaultExportedClassName } from "./scriptClassSync.js";
import { parseScriptMethods } from "./scriptIntrospect.js";

/**
 * Adds `methodName() {}` to the default-exported class in `path`.
 *
 * Returns true when the file was written, false when it was left alone —
 * because the method already exists (which is success from the caller's point
 * of view: the name is now valid either way), or because the file has no
 * class this can safely edit.
 */
export async function addMethodToScript(path, methodName, { params = [] } = {}) {
  if (!path || !/^[A-Za-z_$][\w$]*$/.test(methodName)) return false;
  const { invoke } = await import("@tauri-apps/api/core");
  let source;
  try {
    source = await invoke("read_text_file", { path });
  } catch (err) {
    console.warn(`Couldn't read ${path}: ${err}`);
    return false;
  }
  if (!defaultExportedClassName(source)) {
    console.warn(`${path} has no default-exported class to add a method to.`);
    return false;
  }
  if (parseScriptMethods(source).some((m) => m.name === methodName)) return true;

  const insertion = findInsertionPoint(source);
  if (insertion === null) {
    console.warn(`Couldn't find where to insert into ${path}.`);
    return false;
  }
  const indent = detectIndent(source);
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const method = `${eol}${indent}${methodName}(${params.join(", ")}) {${eol}${indent}}${eol}`;
  const next = source.slice(0, insertion) + method + source.slice(insertion);
  try {
    await invoke("save_scene", { path, contents: next });
  } catch (err) {
    console.warn(`Couldn't write ${path}: ${err}`);
    return false;
  }
  return true;
}

/**
 * The offset of the default-exported class's CLOSING brace, so the new method
 * lands at the end of the class body.
 *
 * Walks brace depth from the class's opening `{` rather than searching for the
 * last `}` in the file: a script commonly has code after its class (a helper, a
 * registration call), and appending there would produce a method sitting
 * outside the class — syntactically valid enough to save and completely
 * non-functional. String and comment contents are skipped so a `}` inside
 * either can't close the class early.
 */
function findInsertionPoint(source) {
  const decl = /\bexport\s+default\s+(?:abstract\s+)?class\b|\bclass\s+[A-Za-z_$][\w$]*/.exec(source);
  if (!decl) return null;
  const open = source.indexOf("{", decl.index);
  if (open === -1) return null;
  let depth = 0;
  let i = open;
  while (i < source.length) {
    const c = source[i];
    if (c === "/" && source[i + 1] === "/") {
      const nl = source.indexOf("\n", i);
      i = nl === -1 ? source.length : nl;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(source, i);
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return null;
}

/** Index just past the string starting at `start`. */
function skipString(source, start) {
  const quote = source[start];
  let i = start + 1;
  while (i < source.length) {
    if (source[i] === "\\") {
      i += 2;
      continue;
    }
    if (source[i] === quote) return i + 1;
    // A template literal's `${...}` can contain anything, braces included.
    if (quote === "`" && source[i] === "$" && source[i + 1] === "{") {
      let depth = 1;
      i += 2;
      while (i < source.length && depth > 0) {
        if (source[i] === "{") depth++;
        else if (source[i] === "}") depth--;
        i++;
      }
      continue;
    }
    i++;
  }
  return i;
}

/** The file's own indentation, so an inserted method matches what's around it. */
function detectIndent(source) {
  const match = /\n([ \t]+)\S/.exec(source);
  return match ? match[1] : "  ";
}
