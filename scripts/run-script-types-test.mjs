/**
 * Guards the hand-written script-facing type surface (`src/engine/script-types/
 * engine.d.ts`) against the one failure mode TypeScript cannot report.
 *
 * `Entity.getComponent` has two overloads: a typed one keyed on `ComponentMap`
 * and a `<T = unknown>(type: string)` fallback for module/custom components.
 * That fallback means a WRONG map key is not a type error — it just quietly
 * stops resolving, and `getComponent("charactercontroller")` starts returning
 * `unknown` with no autocomplete and no diagnostic anywhere. (That exact typo
 * — `character` for `charactercontroller` — shipped and went unnoticed.)
 *
 * So: every ComponentMap key must be a real registered `static type` string.
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

registerBuiltInComponents();
// Module components register only when their module is enabled, so pull their
// type strings straight off the classes each module declares. Modules whose
// types appear in `ComponentMap` have to be listed here — a missing one reads
// as "you typo'd the key", which is the failure this test exists to catch.
const registered = new Set([
  ...getComponentTypes(),
  ...physicsRapierModule.components.map((c) => c.type),
  ...navigationModule.components.map((c) => c.type),
]);

const source = readFileSync(DTS, "utf8");

console.log("script types — ComponentMap");

const body = source.match(/export interface ComponentMap\s*\{([\s\S]*?)\n\s*\}/)?.[1];
check("ComponentMap is still declared in engine.d.ts", () => {
  assert.ok(body, "could not find `export interface ComponentMap { ... }`");
});

const keys = [...(body ?? "").matchAll(/^\s*([A-Za-z_$][\w$]*)\s*[?]?:/gm)].map((m) => m[1]);
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

if (failures) {
  console.error(`\n${failures} script-type check(s) failed`);
  process.exit(1);
}
console.log("\nall script-type checks passed");
