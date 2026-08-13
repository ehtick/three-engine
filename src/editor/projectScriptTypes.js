/**
 * Generates `<project>/project-scripts.d.ts` — the project's own script classes
 * and hook names, as types.
 *
 * This closes the last hole the no-strings rule left open. `getScript("Health")`
 * and `dispatch("onDamaged", 10)` were the two calls that stayed stringly typed,
 * documented as an accepted gap because class names and hook names are authored
 * per PROJECT and cannot be known from the engine repo. That was true of the
 * engine repo and false of the editor, which has the project open: the names are
 * sitting in the project's own script files, and reading them is what this does.
 *
 * Same placement rule and same reason as `project-events.d.ts` — project ROOT,
 * because the scaffolded tsconfig excludes `engine-types/` and a module
 * augmentation only applies when the file is part of the program. See
 * `projectEventTypes.js` for the full version of that trap.
 *
 * ## Parameter types come from the CLASS, not from this file
 *
 * The obvious approach — parse each parameter's annotation and write it out —
 * cannot work. A script's annotations name types from its own module scope
 * (`amount: DamageInfo`, imported from a sibling file), and none of those
 * resolve from a declaration file sitting at the project root. Writing them
 * anyway produces a file full of unresolved names, which `skipLibCheck` then
 * quietly degrades to `any` — the exact silent-degradation this whole mechanism
 * exists to prevent.
 *
 * So the generated file never states a parameter type. It says
 * `ScriptHookArgs<ScriptMap["Health"], "damage">` and lets TypeScript read the
 * signature off the class, which is referenced by
 * `import("./scripts/Health").default` — inside that module, where every type
 * in it already resolves. The result is the REAL types, imported ones included,
 * and this file never has to understand any of them.
 */
import { listProjectScripts, ENGINE_HOOKS } from "./scriptIntrospect.js";

export const PROJECT_SCRIPTS_DTS = "project-scripts.d.ts";

/**
 * Which script classes declare each hook name.
 *
 * Several scripts declaring the same hook is not a conflict — it is what a hook
 * IS, several handlers for one message. Each contributes its own signature and
 * the emitted type is their union, so `dispatch` accepts what any one of them
 * would accept. That is strictly better than the arity-only check this replaced,
 * which threw the signature away entirely as soon as two scripts disagreed.
 */
function mergeHooks(scripts) {
  const hooks = new Map();
  for (const script of scripts) {
    for (const method of script.methods) {
      if (method.isStatic) continue;
      if (!hooks.has(method.name)) hooks.set(method.name, []);
      hooks.get(method.name).push(script.className);
    }
  }
  return hooks;
}

/** A project-relative module specifier for `import("...")`, no extension. */
function specifierFor(rootPath, path) {
  const root = String(rootPath).replaceAll("\\", "/").replace(/\/+$/, "");
  const file = String(path).replaceAll("\\", "/");
  const relative = file.toLowerCase().startsWith(`${root.toLowerCase()}/`)
    ? file.slice(root.length + 1)
    : file;
  return `./${relative.replace(/\.(ts|js)$/i, "")}`;
}

const BANNER = `// GENERATED — do not edit.
//
// Three Engine rewrites this file from the project's own script files whenever
// the project is opened or a script is saved.
//
// It is what makes \`getScript\` and \`dispatch\` type-checked: the class names
// and hook names below come from your scripts, so a typo is a compile error and
// autocomplete offers the real names instead of nothing.
`;

/** The full text of `project-scripts.d.ts` for a parsed script list. */
export function generateScriptTypes(rootPath, scripts) {
  const named = scripts.filter((s) => s.className);
  const classLines = named
    .map(
      (s) =>
        `    ${s.className}: import(${JSON.stringify(specifierFor(rootPath, s.path))}).default;`,
    )
    .join("\n");

  const hooks = mergeHooks(named);
  const hookLines = [...hooks.entries()]
    // Engine lifecycle hooks are declared on the base interface in engine.d.ts —
    // re-declaring one here with a project script's shape would be a duplicate
    // member, which breaks every declaration in the file.
    .filter(([name]) => !ENGINE_HOOKS.has(name))
    .map(([name, owners]) => {
      const doc = `    /** ${owners.length === 1 ? `Declared by ${owners[0]}.` : `Declared by ${owners.length} scripts: ${owners.slice(0, 4).join(", ")}${owners.length > 4 ? ", …" : ""}.`} */`;
      // A union across every script that declares it: `dispatch` should accept
      // what any one of the handlers accepts.
      const type = owners
        .map((owner) => `ScriptHookArgs<ScriptMap[${JSON.stringify(owner)}], ${JSON.stringify(name)}>`)
        .join(" | ");
      return `${doc}\n    ${JSON.stringify(name)}: ${type};`;
    })
    .join("\n");

  const blocks = [];
  if (classLines) blocks.push(`  interface ScriptMap {\n${classLines}\n  }`);
  if (hookLines) blocks.push(`  interface ScriptHookMap {\n${hookLines}\n  }`);
  if (!blocks.length) {
    return `${BANNER}\n// No scripts with a default-exported class yet.\n\nexport {};\n`;
  }
  return `${BANNER}\ndeclare module "engine" {\n${blocks.join("\n\n")}\n}\n\nexport {};\n`;
}

/**
 * Reads the project's scripts and writes the declarations.
 *
 * Never throws: a project whose types can't be written still runs, and taking
 * down a save for it would be worse. Returns the generated source so the caller
 * can also feed the embedded Monaco, which builds its program from libraries in
 * memory rather than from disk.
 */
export async function writeProjectScriptTypes(rootPath) {
  if (!rootPath) return null;
  const scripts = await listProjectScripts(rootPath).catch(() => []);
  const contents = generateScriptTypes(rootPath, scripts);
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("save_scene", { path: `${rootPath}/${PROJECT_SCRIPTS_DTS}`, contents });
  } catch (err) {
    console.warn(
      `Couldn't write ${PROJECT_SCRIPTS_DTS} — getScript/dispatch won't autocomplete: ${err}`,
    );
  }
  return contents;
}

/** Feeds the generated declarations to the embedded code editor. */
export async function syncProjectScriptTypesToMonaco(contents) {
  if (contents == null) return;
  try {
    const { registerExtraLib } = await import("./code/monaco.js");
    await registerExtraLib(contents, "file:///project-scripts.d.ts");
  } catch (err) {
    console.warn(`Couldn't refresh the code editor's script declarations: ${err}`);
  }
}
