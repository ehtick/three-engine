/**
 * What a project's script files declare, read from their source.
 *
 * Two features need the same answer and neither can get it from the running
 * engine: the `call` action's method picker (which must offer real methods on
 * a target entity's scripts, even ones that have never been loaded), and the
 * generated `project-scripts.d.ts` that closes `dispatch`/`getScript` over the
 * project's own class and hook names.
 *
 * ## Why source text and not the loaded class
 *
 * `Object.getOwnPropertyNames(cls.prototype)` would be exact — and useless
 * here. A script is only loaded once its entity is in the open scene and Play
 * has run; the editor needs the method list while the author is *authoring*,
 * for scripts on entities they have not touched, and the codegen needs it for
 * every script in the project including ones no scene references yet. Reading
 * the file is the only thing that works before the code has ever run.
 *
 * ## What that costs, and the rule that follows
 *
 * This is a regex pass, not a parser. It will miss things (computed method
 * names, methods added by a mixin, anything behind a build step) and it must
 * never be *wrong* about what it does report — a fabricated signature in the
 * generated types is worse than no signature at all, because it type-checks
 * code that then fails at runtime. So: when the shape is not clearly
 * recognisable, this reports the method with unknown parameters rather than
 * guessing, and callers degrade to `any[]`.
 */

/** Block and line comments blanked, so a commented-out method isn't reported.
 *  Newlines are preserved so nothing shifts line-wise. */
function withoutComments(source) {
  return String(source ?? "")
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));
}

/**
 * Lifecycle hooks the engine itself calls. Reported so callers can hide them
 * from a "which method should this button call" picker — offering `onUpdate`
 * there is offering a footgun, since the engine already calls it every frame.
 */
export const ENGINE_HOOKS = new Set([
  "onStart",
  "onUpdate",
  "onLateUpdate",
  "onDestroy",
  "onHotReload",
  "onEditorUpdate",
  "onEnable",
  "onDisable",
  "onCollisionEnter",
  "onCollisionExit",
  "onTriggerEnter",
  "onTriggerExit",
  "onClick",
  "onPointerEnter",
  "onPointerExit",
  "onFocus",
  "onBlur",
  "onLoad",
  "constructor",
]);

/**
 * Splits a parameter list on top-level commas.
 *
 * Naive splitting breaks on the things people really write — `foo(a = { x: 1 },
 * b)`, `bar(items: Array<[number, string]>)` — and a mis-split produces a
 * signature that is confidently wrong, which is the one outcome this module is
 * not allowed to produce. Returns null when the text doesn't balance, so the
 * caller degrades instead.
 */
function splitParams(text) {
  const params = [];
  let depth = 0;
  let current = "";
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote && text[i - 1] !== "\\") quote = null;
      current += c;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      current += c;
      continue;
    }
    if (c === "(" || c === "[" || c === "{" || c === "<") depth++;
    else if (c === ")" || c === "]" || c === "}" || c === ">") depth--;
    if (depth < 0) return null;
    if (c === "," && depth === 0) {
      params.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  if (depth !== 0 || quote) return null;
  if (current.trim()) params.push(current);
  return params;
}

/**
 * One parameter's name and (for TypeScript sources) its annotated type.
 *
 * Returns null for anything not a plain identifier — a destructured
 * `{ x, y }` or an array pattern has no single name to label a tuple element
 * with, and inventing one would put a lie in the generated types.
 */
function parseParam(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  // Strip a default value first: everything after the first top-level `=`.
  let head = trimmed;
  let optional = false;
  const eq = topLevelIndexOf(head, "=");
  if (eq !== -1) {
    head = head.slice(0, eq).trim();
    optional = true;
  }
  const rest = head.startsWith("...") ? head.slice(3).trim() : head;
  const variadic = head.startsWith("...");
  const colon = topLevelIndexOf(rest, ":");
  const name = (colon === -1 ? rest : rest.slice(0, colon)).trim().replace(/\?$/, "");
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return null;
  if (colon !== -1 && rest.endsWith("?")) optional = true;
  const type = colon === -1 ? null : rest.slice(colon + 1).trim() || null;
  return {
    name,
    ...(type ? { type } : {}),
    ...(optional || /\?\s*:/.test(rest) ? { optional: true } : {}),
    ...(variadic ? { variadic: true } : {}),
  };
}

/** Index of `char` at bracket depth 0, or -1. */
function topLevelIndexOf(text, char) {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "(" || c === "[" || c === "{" || c === "<") depth++;
    else if (c === ")" || c === "]" || c === "}" || c === ">") depth--;
    else if (c === char && depth === 0) return i;
  }
  return -1;
}

/**
 * Matches a method declaration at the start of a class-body line.
 *
 * Anchored to the line so a CALL (`this.open(x)`) can never be mistaken for a
 * declaration — that mistake would fill the picker with every function the
 * script invokes. Leading `async`, `static`, `get`/`set` and a `#private` name
 * are recognised so they can be classified rather than silently skipped.
 */
const METHOD_RE =
  /^[ \t]*(?<modifiers>(?:(?:public|private|protected|static|async|\*)\s+)*)(?<accessor>get|set)?\s*(?<name>[#A-Za-z_$][\w$]*)\s*\((?<params>[^)]*)\)\s*(?::[^{;]*)?\{/gm;

/**
 * Every method a script source declares.
 *
 * `params` is null when the list could not be read confidently (an unbalanced
 * or destructured signature); callers must treat that as "unknown arity", not
 * as "no parameters".
 */
export function parseScriptMethods(source) {
  const text = withoutComments(source);
  // Only look inside the default-exported class body, so helper classes and
  // module-level functions in the same file aren't reported as script methods.
  const body = defaultExportedClassBody(text);
  if (body === null) return [];
  const methods = [];
  const seen = new Set();
  METHOD_RE.lastIndex = 0;
  let match;
  while ((match = METHOD_RE.exec(body)) !== null) {
    const { name, params, accessor, modifiers } = match.groups;
    if (name === "constructor" || name === "if" || name === "for" || name === "while" || name === "switch" || name === "catch") {
      continue;
    }
    // `#private` is unreachable from outside the class, so nothing can call it.
    if (name.startsWith("#")) continue;
    if (accessor) continue; // a getter/setter is a property, not a callable hook
    if (seen.has(name)) continue;
    seen.add(name);
    const parsed = params.trim() ? splitParams(params) : [];
    const list = parsed === null ? null : parsed.map(parseParam);
    methods.push({
      name,
      params: list === null || list.includes(null) ? null : list,
      isHook: ENGINE_HOOKS.has(name),
      isStatic: /\bstatic\b/.test(modifiers ?? ""),
      isAsync: /\basync\b/.test(modifiers ?? ""),
    });
  }
  return methods;
}

/**
 * The source of the default-exported class's body, or null when the file has
 * no default-exported class (in which case it is not a script).
 *
 * Walks brace depth from the class's opening `{` rather than regexing for the
 * close, because a class body contains braces in every line of it.
 */
function defaultExportedClassBody(text) {
  const inline = /\bexport\s+default\s+(?:abstract\s+)?class\s+[A-Za-z_$][\w$]*/.exec(text);
  let start;
  if (inline) {
    start = inline.index + inline[0].length;
  } else {
    // `class Foo … export default Foo` — the other spelling people write.
    const byName = /\bexport\s+default\s+([A-Za-z_$][\w$]*)\s*(?:;|$)/m.exec(text);
    if (!byName) return null;
    const decl = new RegExp(`\\b(?:abstract\\s+)?class\\s+${byName[1]}\\b`).exec(text);
    if (!decl) return null;
    start = decl.index + decl[0].length;
  }
  const open = text.indexOf("{", start);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return null; // unbalanced — better to report nothing than half a class
}

/** The class name and methods of one script source. */
export function parseScript(source) {
  const text = withoutComments(source);
  const inline = /\bexport\s+default\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(text);
  const byName = inline ? null : /\bexport\s+default\s+([A-Za-z_$][\w$]*)\s*(?:;|$)/m.exec(text);
  const className = inline?.[1] ?? (byName && new RegExp(`\\bclass\\s+${byName[1]}\\b`).test(text) ? byName[1] : null);
  if (!className) return null;
  return { className, methods: parseScriptMethods(source) };
}

/* -------------------------------------------------------------------------- */
/* Project-wide                                                                */
/* -------------------------------------------------------------------------- */

const SCRIPT_EXTENSIONS = [".js", ".ts"];
const isScript = (path) => SCRIPT_EXTENSIONS.some((ext) => path.toLowerCase().endsWith(ext));
const isGenerated = (path) => {
  const lower = path.replaceAll("\\", "/").toLowerCase();
  return lower.includes("/engine-types/") || lower.endsWith(".d.ts");
};

/**
 * Every script class in the project, as `[{ path, className, methods }]`.
 *
 * Cached per project root and invalidated by `invalidateScriptCache` — the
 * method picker asks for this on every inspector render, and re-reading every
 * script file per keystroke would make the panel unusable in a project with a
 * hundred of them.
 */
let cache = { root: null, scripts: null, promise: null };

export function invalidateScriptCache() {
  cache = { root: null, scripts: null, promise: null };
}

/**
 * The cached script list, or null when it has not been read yet.
 *
 * Exists for the graph node renderer, which builds its option lists inside a
 * synchronous `describe()` call and has nowhere to await project I/O. The graph
 * panel warms this on mount; until it resolves the method field falls back to a
 * plain text input rather than an empty dropdown, because an empty dropdown
 * looks like "this script has no methods" instead of "not loaded yet".
 */
export function cachedProjectScripts(rootPath) {
  return cache.root === rootPath ? cache.scripts : null;
}

/** Methods callable on `entity`'s scripts, from the cache only. Null when cold. */
export function cachedMethodsForEntity(entity, rootPath) {
  const scripts = cachedProjectScripts(rootPath);
  if (!scripts) return null;
  const slots = entity?.getComponent?.("script")?.props?.scripts ?? [];
  if (!slots.length) return [];
  const byPath = new Map(scripts.map((s) => [s.path.replaceAll("\\", "/").toLowerCase(), s]));
  const out = [];
  const seen = new Set();
  for (const slot of slots) {
    const parsed = byPath.get(String(slot?.path ?? "").replaceAll("\\", "/").toLowerCase());
    for (const method of parsed?.methods ?? []) {
      if (method.isHook || method.isStatic || seen.has(method.name)) continue;
      seen.add(method.name);
      out.push({ ...method, script: parsed.className });
    }
  }
  return out;
}

export async function listProjectScripts(rootPath) {
  if (!rootPath) return [];
  if (cache.root === rootPath && cache.scripts) return cache.scripts;
  if (cache.root === rootPath && cache.promise) return cache.promise;
  const promise = (async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const { listProjectEntries } = await import("./assetLoader.js");
    const entries = await listProjectEntries(rootPath).catch(() => []);
    const files = entries.filter((e) => !e.is_dir && isScript(e.path) && !isGenerated(e.path));
    const scripts = [];
    for (const file of files) {
      let source;
      try {
        source = await invoke("read_text_file", { path: file.path });
      } catch {
        continue;
      }
      const parsed = parseScript(source);
      if (parsed) scripts.push({ path: file.path, ...parsed });
    }
    cache = { root: rootPath, scripts, promise: null };
    return scripts;
  })();
  cache = { root: rootPath, scripts: null, promise };
  return promise;
}

/**
 * The methods callable on whatever scripts are attached to `entity`.
 *
 * Falls back to the LOADED instance's prototype when the file could not be
 * parsed, so a script using a shape the regex doesn't recognise still offers
 * its methods once it has run at least once.
 */
export async function methodsForEntity(entity, rootPath) {
  const slots = entity?.getComponent?.("script")?.props?.scripts ?? [];
  if (!slots.length) return [];
  const scripts = await listProjectScripts(rootPath);
  const byPath = new Map(scripts.map((s) => [s.path.replaceAll("\\", "/").toLowerCase(), s]));
  const out = [];
  const seen = new Set();
  for (const slot of slots) {
    if (!slot?.path) continue;
    const parsed = byPath.get(String(slot.path).replaceAll("\\", "/").toLowerCase());
    const methods = parsed?.methods ?? prototypeMethods(entity, slot.path);
    for (const method of methods) {
      if (seen.has(method.name)) continue;
      seen.add(method.name);
      out.push({ ...method, script: parsed?.className ?? stemOf(slot.path) });
    }
  }
  return out;
}

const stemOf = (path) => String(path).split(/[\\/]/).pop()?.replace(/\.(ts|js)$/i, "") ?? "";

/** Method names off a loaded instance, for sources the regex couldn't read. */
function prototypeMethods(entity, path) {
  const component = entity?.getComponent?.("script");
  const slot = component?.slots?.find?.((s) => s.path === path);
  const instance = slot?.instance;
  if (!instance) return [];
  const proto = Object.getPrototypeOf(instance);
  if (!proto) return [];
  return Object.getOwnPropertyNames(proto)
    .filter((name) => name !== "constructor" && typeof instance[name] === "function")
    .map((name) => ({ name, params: null, isHook: ENGINE_HOOKS.has(name) }));
}
