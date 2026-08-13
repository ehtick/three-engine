/**
 * End-to-end proof that the two GENERATED declaration files really do type a
 * project's own events, script classes and hooks.
 *
 * Everything else about the Events panel can be unit-tested — but the claim
 * that matters ("declare an event, it is typed everywhere, immediately") rests
 * on a TypeScript module augmentation resolving inside the *user's* project,
 * under the tsconfig the editor scaffolds, from a file at the path the editor
 * writes it to. None of that is observable from the engine repo's own type
 * check, and every part of it fails silently: an augmentation that isn't picked
 * up produces no error, it just means autocomplete quietly knows less.
 *
 * So this builds a throwaway project laid out exactly like a scaffolded one and
 * runs the real compiler over it, once per case:
 *
 *   - a script using a declared event compiles, and a typo'd name, a wrong
 *     argument type or a missing argument does not;
 *   - `getScript("Door")` resolves the project's REAL class, so calling a
 *     method it does not have is an error — the proof that it has not degraded
 *     to `Script` or `unknown`;
 *   - `dispatch` checks the hook name and its arity, while the engine's own
 *     lifecycle hooks stay dispatchable in a project that declares none;
 *   - the SAME declaration under `engine-types/` silently does nothing — which
 *     is why both generators write to the project root, and is the one design
 *     decision here that has no other way to be verified.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { generateEventTypes, normalizeEventCatalog } from "../src/engine/events/catalog.js";
import { parseScript } from "../src/editor/scriptIntrospect.js";
import { generateScriptTypes } from "../src/editor/projectScriptTypes.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const ENGINE_DTS = join(repoRoot, "src/engine/script-types/engine.d.ts");
const TSC = join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");

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

/**
 * The tsconfig the editor scaffolds, trimmed to what this test exercises.
 *
 * `exclude: ["engine-types"]` is copied verbatim from `projectTypes.js` and is
 * the whole point of case 4 — keep the two in step.
 */
const tsconfig = {
  compilerOptions: {
    target: "ES2022",
    module: "ESNext",
    moduleResolution: "bundler",
    lib: ["ES2022", "DOM", "DOM.Iterable"],
    allowJs: true,
    checkJs: false,
    noEmit: true,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    // Suppresses errors *inside* engine.d.ts, which re-exports three's types
    // and has no `three` to resolve here. Same setting a real project gets.
    skipLibCheck: true,
    experimentalDecorators: true,
    useDefineForClassFields: false,
    strict: false,
    paths: {
      engine: ["./engine-types/engine.d.ts"],
    },
  },
  include: ["**/*.ts", "**/*.js", "**/*.tsx", "**/*.jsx"],
  exclude: ["node_modules", "engine-types", "dist"],
};

/**
 * Lays out a scaffolded project, drops `script` in it, and returns tsc's output.
 * `declarationsAt` selects where the generated event declarations are written.
 */
function compile(script, { declarationsAt = "root" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "three-engine-events-"));
  try {
    mkdirSync(join(dir, "engine-types"), { recursive: true });
    copyFileSync(ENGINE_DTS, join(dir, "engine-types", "engine.d.ts"));
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));

    const { events } = normalizeEventCatalog([
      { name: "player-died", description: "Ran out of health.", params: [{ name: "cause", type: "string" }] },
      { name: "score-changed", params: [{ name: "total", type: "number" }] },
      { name: "damaged", scope: "entity", params: [{ name: "amount", type: "number" }] },
    ]);
    const dts = generateEventTypes(events);
    const target =
      declarationsAt === "root"
        ? join(dir, "project-events.d.ts")
        : join(dir, "engine-types", "project-events.d.ts");
    writeFileSync(target, dts);
    writeFileSync(join(dir, "Test.ts"), script);

    try {
      execFileSync(TSC, ["--noEmit", "-p", join(dir, "tsconfig.json")], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        shell: process.platform === "win32",
      });
      return "";
    } catch (err) {
      // tsc exits non-zero with the diagnostics on stdout.
      return `${err.stdout ?? ""}${err.stderr ?? ""}`;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const scriptUsing = (body) => `
import { Script } from "engine";

export default class Test extends Script {
  onStart() {
${body}
  }
}
`;

check("a declared event is typed on emit AND on, with inferred argument types", () => {
  const out = compile(
    scriptUsing(`
    this.engine.emit("player-died", "fell");
    this.engine.emit("score-changed", 10);
    this.engine.on("player-died", (cause) => {
      // Inferred as string from the catalog — calling a string method proves it
      // is not \`any\`, which is what a non-applied augmentation would give.
      const upper: string = cause.toUpperCase();
      void upper;
    });
    this.entity.emit("damaged", 5);
`),
  );
  assert.equal(out.trim(), "", `expected a clean compile, got:\n${out}`);
});

check("a typo'd event name is a compile error, not a silent no-op", () => {
  const out = compile(scriptUsing(`    this.engine.emit("player-dyed", "fell");`));
  assert.match(out, /player-dyed/, `expected an error naming the typo, got:\n${out || "(none)"}`);
});

check("the wrong argument type is a compile error", () => {
  const out = compile(scriptUsing(`    this.engine.emit("score-changed", "ten");`));
  assert.notEqual(out.trim(), "", "passing a string where the catalog says number must fail");
  assert.match(out, /string|number/);
});

check("a missing argument is a compile error", () => {
  const out = compile(scriptUsing(`    this.engine.emit("player-died");`));
  assert.notEqual(out.trim(), "", "an event declared with a parameter must require it");
});

check("an entity-scoped event is NOT on the engine bus", () => {
  // The scope field has to mean something: putting a per-entity event on
  // `engine.emit` should fail the same way a typo does.
  const out = compile(scriptUsing(`    this.engine.emit("damaged", 5);`));
  assert.match(out, /damaged/, `expected the engine bus to reject it, got:\n${out || "(none)"}`);
});

check("declarations under engine-types/ are silently ignored — hence the project root", () => {
  // The failure this guards is invisible in every other way: no error, no
  // warning, autocomplete simply stops knowing the project's own events. If
  // this check ever starts passing with a clean compile, the tsconfig's
  // `exclude` changed and `projectEventTypes.js` can be simplified.
  const out = compile(scriptUsing(`    this.engine.emit("player-died", "fell");`), {
    declarationsAt: "engine-types",
  });
  assert.match(
    out,
    /player-died/,
    "the augmentation was picked up from engine-types/ — projectEventTypes.js's placement rationale is stale",
  );
});


/* -------------------------------------------------------------------------- */
/* project-scripts.d.ts — getScript / dispatch                                  */
/* -------------------------------------------------------------------------- */

/**
 * The same harness, for the OTHER generated declaration file. A door script is
 * written into the project, its types generated from the parser, and the test
 * script then tries to use them the way a game would.
 */
const DOOR_SOURCE = `
import { Script } from "engine";

export default class Door extends Script {
  onStart() {}
  open(speed: number, force?: boolean) {}
  close() {}
}
`;

function compileWithScripts(script) {
  const dir = mkdtempSync(join(tmpdir(), "three-engine-scripts-"));
  try {
    mkdirSync(join(dir, "engine-types"), { recursive: true });
    mkdirSync(join(dir, "scripts"), { recursive: true });
    copyFileSync(ENGINE_DTS, join(dir, "engine-types", "engine.d.ts"));
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));
    writeFileSync(join(dir, "scripts", "Door.ts"), DOOR_SOURCE);

    const parsed = parseScript(DOOR_SOURCE);
    const dts = generateScriptTypes(dir.replaceAll("\\", "/"), [
      { path: `${dir.replaceAll("\\", "/")}/scripts/Door.ts`, ...parsed },
    ]);
    writeFileSync(join(dir, "project-scripts.d.ts"), dts);
    writeFileSync(join(dir, "Test.ts"), script);

    try {
      execFileSync(TSC, ["--noEmit", "-p", join(dir, "tsconfig.json")], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        shell: process.platform === "win32",
      });
      return "";
    } catch (err) {
      return `${err.stdout ?? ""}${err.stderr ?? ""}`;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

check("getScript returns the project's REAL class, with its real methods", () => {
  const out = compileWithScripts(
    scriptUsing(`
    const door = this.entity.getScript("Door");
    door?.open(2, true);
    door?.close();
`),
  );
  assert.equal(out.trim(), "", `expected a clean compile, got:\n${out}`);
});

check("a method the class does not have is a compile error", () => {
  // The proof that `getScript` resolves the real type rather than degrading to
  // `Script` or `unknown` — a fallback would let this through.
  const out = compileWithScripts(scriptUsing(`    this.entity.getScript("Door")?.explode();`));
  assert.match(out, /explode/, `expected an error naming the missing method, got:\n${out || "(none)"}`);
});

check("a misspelled script name is a compile error, not a silent null", () => {
  const out = compileWithScripts(scriptUsing(`    this.entity.getScript("Doar");`));
  assert.match(out, /Doar|not assignable/, `expected a typo error, got:\n${out || "(none)"}`);
});

check("dispatch checks the hook name and its arity", () => {
  const ok = compileWithScripts(
    scriptUsing(`
    this.entity.dispatch("open", 2, true);
    this.entity.dispatch("close");
    this.entity.dispatch("onClick");
`),
  );
  assert.equal(ok.trim(), "", `expected a clean compile, got:\n${ok}`);

  const typo = compileWithScripts(scriptUsing(`    this.entity.dispatch("opne", 2);`));
  assert.notEqual(typo.trim(), "", "a misspelled hook name must not compile");

  const missing = compileWithScripts(scriptUsing(`    this.entity.dispatch("open");`));
  assert.notEqual(missing.trim(), "", "a required argument must not be omittable");
});

check("dispatch now carries the script's REAL parameter types, not any", () => {
  // The point of reading signatures off the class instead of restating them:
  // `open(speed: number, force?: boolean)` means a string is rejected. Writing
  // the types textually into the generated file could never achieve this,
  // because a script's annotations resolve only in its own module.
  const wrong = compileWithScripts(scriptUsing(`    this.entity.dispatch("open", "fast");`));
  assert.notEqual(wrong.trim(), "", "a string where the script says number must fail");
  assert.match(wrong, /string|number/);

  const right = compileWithScripts(
    scriptUsing(`
    this.entity.dispatch("open", 2);
    this.entity.dispatch("open", 2, true);
`),
  );
  assert.equal(right.trim(), "", `expected a clean compile, got:
${right}`);
});

check("engine lifecycle hooks stay dispatchable without any project script", () => {
  // The engine itself sends these; they live on the base ScriptHookMap so a
  // project that declares none of its own can still receive them.
  const out = compileWithScripts(
    scriptUsing(`
    this.entity.dispatch("onCollisionEnter", this.entity);
    this.entity.dispatch("onTriggerExit", this.entity);
`),
  );
  assert.equal(out.trim(), "", `expected a clean compile, got:\n${out}`);
});

console.log(failures ? `\n${failures} failing` : "\nall generated-type checks passed");
process.exit(failures ? 1 : 0);
