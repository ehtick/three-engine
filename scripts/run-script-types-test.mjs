/**
 * Guards the hand-written script-facing type surface (`src/engine/script-types/
 * engine.d.ts`) against the one failure mode TypeScript cannot report.
 *
 * `Entity.getComponent` has overloads keyed on `ComponentMap` (string or class
 * token) and a `<T = unknown>(type: string)` fallback for custom components.
 * That fallback means a WRONG map key is not a type error — it just quietly
 * stops resolving, and `getComponent("charactercontroller")` starts returning
 * `unknown` with no autocomplete and no diagnostic anywhere. (That exact typo
 * — `character` for `charactercontroller` — shipped and went unnoticed.)
 *
 * So: every ComponentMap key must be a real registered `static type` string,
 * and every key must also have a matching class token const on `"engine"`
 * (so `import { MeshComponent } from "engine"` stays complete).
 * The reverse is deliberately NOT required — plenty of internal components
 * (`bone`, `skinnedmesh`, `__missing__`) have no business in a script's
 * autocomplete.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DTS = fileURLToPath(new URL("../src/engine/script-types/engine.d.ts", import.meta.url));

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${error.message}`);
  }
};

const { registerBuiltInComponents } = await import("../src/engine/index.js");
const { getComponentTypes } = await import("../src/engine/components/registry.js");
const { physicsRapierModule } = await import("../src/modules/physics-rapier/index.js");
const { navigationModule } = await import("../src/modules/navigation/index.js");
const { terrainModule } = await import("../src/modules/terrain/index.js");
const { postprocessingModule } = await import("../src/modules/postprocessing/index.js");
const { polyhavenModule } = await import("../src/modules/polyhaven/index.js");
const { ambientcgModule } = await import("../src/modules/ambientcg/index.js");
const { giModule } = await import("../src/modules/gi/index.js");

registerBuiltInComponents();
// Module components register only when their module is enabled, so pull their
// type strings straight off the classes each module declares. Modules whose
// types appear in `ComponentMap` have to be listed here — a missing one reads
// as "you typo'd the key", which is the failure this test exists to catch.
const registered = new Set([
  ...getComponentTypes(),
  ...physicsRapierModule.components.map((c) => c.type),
  ...navigationModule.components.map((c) => c.type),
  ...terrainModule.components.map((c) => c.type),
  ...postprocessingModule.components.map((c) => c.type),
  ...polyhavenModule.components.map((c) => c.type),
  ...ambientcgModule.components.map((c) => c.type),
  ...giModule.components.map((c) => c.type),
]);

const source = readFileSync(DTS, "utf8");

console.log("script types — ComponentMap");

const body = source.match(/export interface ComponentMap\s*\{([\s\S]*?)\n\s*\}/)?.[1];
check("ComponentMap is still declared in engine.d.ts", () => {
  assert.ok(body, "could not find `export interface ComponentMap { ... }`");
});

const keys = [...(body ?? "").matchAll(/^\s*(?:([A-Za-z_$][\w$]*)|"([^"]+)")\s*[?]?:/gm)]
  .map((m) => m[1] ?? m[2]);
check("ComponentMap has entries", () => assert.ok(keys.length > 5, `found ${keys.length}`));

for (const key of keys) {
  check(`"${key}" is a registered component type`, () => {
    assert.ok(
      registered.has(key),
      `ComponentMap key "${key}" matches no component's \`static type\`. ` +
        `Registered: ${[...registered].sort().join(", ")}`,
    );
  });
}

// Interfaces referenced by the map must actually exist, or the map entry
// resolves to `any` under a d.ts that `skipLibCheck` never validates.
console.log("script types — referenced interfaces");
for (const [, key, iface] of (body ?? "").matchAll(/^\s*([A-Za-z_$][\w$]*)\s*[?]?:\s*([A-Za-z_$][\w$]*)/gm)) {
  check(`${key} → ${iface} is declared`, () => {
    assert.match(source, new RegExp(`export interface ${iface}\\b`), `no \`export interface ${iface}\``);
  });
}

// Every ComponentMap key needs a class token whose `type` literal matches,
// otherwise `getComponent(MeshComponent)` cannot resolve through the map.
console.log("script types — engine component tokens");
const tokenByType = new Map(
  [...source.matchAll(/export const (\w+):\s*ComponentClass<"([^"]+)">/g)].map(
    (m) => [m[2], m[1]],
  ),
);
check("engine.d.ts declares component class tokens", () => {
  assert.ok(tokenByType.size > 5, `found ${tokenByType.size}`);
});
for (const key of keys) {
  check(`"${key}" has an engine class token`, () => {
    assert.ok(
      tokenByType.has(key),
      `ComponentMap key "${key}" has no \`export const …: ComponentClass<"${key}">\` in engine.d.ts`,
    );
  });
}
for (const [type, name] of tokenByType) {
  check(`token ${name} type "${type}" is in ComponentMap`, () => {
    assert.ok(keys.includes(type), `orphan token ${name} type "${type}" not in ComponentMap`);
  });
}

// ---------------------------------------------------------------------------
// editor.d.ts vs the real Editor facade.
//
// Same failure mode as ComponentMap above, one module over: `editor.d.ts` is
// hand-written alongside `src/editor/api/index.js`, and nothing made them
// agree. They drifted badly — the declarations described 9 namespaces while the
// facade had 22, so two thirds of `Editor.*` (viewport, materials, prefabs,
// modules, audio, library, textures, geometry, pipeline, git, build, batch,
// console) was an error in the app's own code editor despite working fine at
// runtime. `skipLibCheck` guarantees nothing reports that on its own.
//
// Checked BOTH ways on purpose. A facade method with no declaration is
// invisible to autocomplete, so in practice it does not exist; a declaration
// with no facade method is worse, because it type-checks and then throws.
// ---------------------------------------------------------------------------
console.log("script types — Editor facade");

const FACADE = fileURLToPath(new URL("../src/editor/api/index.js", import.meta.url));
const EDITOR_DTS = fileURLToPath(new URL("../src/engine/script-types/editor.d.ts", import.meta.url));

/** Comments carry prose that looks like members ("`entities.create(...)`"). */
const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

/** The body lines of the `{ … }` opened on `openLine`, and where it closes. */
function blockEnd(lines, openIndex, indent) {
  const close = new RegExp(`^ {${indent}}\\}`);
  for (let i = openIndex + 1; i < lines.length; i++) if (close.test(lines[i])) return i;
  return lines.length;
}

/**
 * Dotted member paths of an object/interface body — `entities.create`,
 * `textures.atlas.pack`. Nested literals recurse; everything else is a leaf.
 *
 * Deliberately structural (indentation + the shape of a member line) rather
 * than a real parser: both files are formatted by the same tooling, and a
 * reformat that breaks this fails the test loudly instead of silently checking
 * nothing.
 */
function memberPaths(lines, start, end, indent, prefix, out) {
  const member = new RegExp(`^ {${indent}}(?:get\\s+|readonly\\s+)?([A-Za-z_$][\\w$]*)\\??\\s*[(:,]`);
  for (let i = start; i < end; i++) {
    const found = member.exec(lines[i]);
    if (!found) continue;
    const path = prefix ? `${prefix}.${found[1]}` : found[1];
    // `foo: {` opens a nested namespace; `foo(` / `foo: value` is a leaf.
    if (/[:=]\s*\{\s*$/.test(lines[i])) {
      const close = blockEnd(lines, i, indent);
      memberPaths(lines, i + 1, close, indent + 2, path, out);
      i = close;
    } else {
      out.add(path);
    }
  }
  return out;
}

/** Members of the block that `header` opens, at `indent` + 2. */
function membersOf(source, header, indent) {
  const lines = stripComments(source).split(/\r?\n/);
  const open = lines.findIndex((line) => line.includes(header));
  if (open < 0) return null;
  return memberPaths(lines, open + 1, blockEnd(lines, open, indent), indent + 2, "", new Set());
}

const facade = membersOf(readFileSync(FACADE, "utf8"), "export const EditorApi = {", 0);
const declared = membersOf(readFileSync(EDITOR_DTS, "utf8"), "export interface EditorApi {", 2);

check("EditorApi is still declared in api/index.js", () => assert.ok(facade, "no `export const EditorApi = {`"));
check("EditorApi is still declared in editor.d.ts", () => assert.ok(declared, "no `export interface EditorApi {`"));
check("the facade has many members", () => assert.ok((facade?.size ?? 0) > 50, `found ${facade?.size}`));

for (const path of facade ?? []) {
  check(`Editor.${path} is declared in editor.d.ts`, () => {
    assert.ok(
      declared?.has(path),
      `\`Editor.${path}\` exists in api/index.js but not in editor.d.ts — ` +
        `it has no autocomplete and type-checks as an error in the Code panel.`,
    );
  });
}
for (const path of declared ?? []) {
  check(`editor.d.ts's Editor.${path} exists in the facade`, () => {
    assert.ok(
      facade?.has(path),
      `\`Editor.${path}\` is declared in editor.d.ts but api/index.js has no such member — ` +
        `calling it type-checks and then throws at runtime.`,
    );
  });
}

if (failures) {
  console.error(`\n${failures} script-type check(s) failed`);
  process.exit(1);
}
console.log("\nall script-type checks passed");
