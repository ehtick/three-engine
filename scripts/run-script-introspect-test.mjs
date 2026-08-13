/**
 * The script-source parser behind `getScript`/`dispatch` codegen, the `call`
 * action's method picker, and inserted method stubs.
 *
 * All three of those put this parser's output somewhere it is expensive to be
 * wrong: a fabricated signature in `project-scripts.d.ts` type-checks code that
 * then breaks at runtime, and a bad insertion point writes a method OUTSIDE the
 * class in someone's source file. So the tests here are mostly about the shapes
 * it must REFUSE to guess at, not the ones it handles.
 */
import assert from "node:assert/strict";
import { parseScript, parseScriptMethods } from "../src/editor/scriptIntrospect.js";
import { generateScriptTypes } from "../src/editor/projectScriptTypes.js";

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

const SCRIPT = `
import { Script } from "engine";

export default class Door extends Script {
  onStart() { this.locked = true; }

  open(speed, force = false) {
    this.locked = false;
  }

  async close(delay) {}

  #secret() {}

  get isOpen() { return !this.locked; }
  set isOpen(v) {}

  static make() {}
}
`;

check("parses the class name and its callable methods", () => {
  const parsed = parseScript(SCRIPT);
  assert.equal(parsed.className, "Door");
  const names = parsed.methods.map((m) => m.name);
  assert.deepEqual(names, ["onStart", "open", "close", "make"]);
});

check("a #private method is not reported — nothing outside can call it", () => {
  assert.ok(!parseScriptMethods(SCRIPT).some((m) => m.name === "secret"));
});

check("getters and setters are not reported as callable hooks", () => {
  assert.ok(!parseScriptMethods(SCRIPT).some((m) => m.name === "isOpen"));
});

check("engine lifecycle hooks are flagged so a picker can hide them", () => {
  const methods = parseScriptMethods(SCRIPT);
  assert.equal(methods.find((m) => m.name === "onStart").isHook, true);
  assert.equal(methods.find((m) => m.name === "open").isHook, false);
});

check("static and async are classified, not silently dropped", () => {
  const methods = parseScriptMethods(SCRIPT);
  assert.equal(methods.find((m) => m.name === "make").isStatic, true);
  assert.equal(methods.find((m) => m.name === "close").isAsync, true);
});

check("parameter names and defaults are read", () => {
  const open = parseScriptMethods(SCRIPT).find((m) => m.name === "open");
  assert.deepEqual(open.params.map((p) => p.name), ["speed", "force"]);
  assert.equal(open.params[0].optional, undefined);
  assert.equal(open.params[1].optional, true, "a default value makes it optional");
});

check("a CALL is never mistaken for a declaration", () => {
  // This is the failure that would fill the picker with every function the
  // script invokes. The regex is line-anchored precisely to prevent it.
  const source = `
export default class A extends Script {
  onStart() {
    this.helper(1);
    if (x) { doThing(); }
    while (y) { other(2); }
  }
}
`;
  assert.deepEqual(parseScriptMethods(source).map((m) => m.name), ["onStart"]);
});

check("only the default-exported class is read", () => {
  const source = `
class Helper { helperMethod() {} }

export default class Real extends Script {
  realMethod() {}
}
`;
  const parsed = parseScript(source);
  assert.equal(parsed.className, "Real");
  assert.deepEqual(parsed.methods.map((m) => m.name), ["realMethod"]);
});

check("the `class Foo … export default Foo` spelling works too", () => {
  const source = `
class Later extends Script {
  ping() {}
}
export default Later;
`;
  const parsed = parseScript(source);
  assert.equal(parsed.className, "Later");
  assert.deepEqual(parsed.methods.map((m) => m.name), ["ping"]);
});

check("a file with no default-exported class is not a script", () => {
  assert.equal(parseScript("export function helper() {}"), null);
  assert.equal(parseScript("export default { a: 1 };"), null);
});

check("commented-out methods are not reported", () => {
  const source = `
export default class A extends Script {
  real() {}
  // fake() {}
  /* alsoFake() {} */
}
`;
  assert.deepEqual(parseScriptMethods(source).map((m) => m.name), ["real"]);
});

check("a destructured parameter degrades to unknown rather than being invented", () => {
  // There is no single name to label a tuple element with, and making one up
  // would put a lie in the generated declarations.
  const source = `
export default class A extends Script {
  take({ x, y }, plain) {}
}
`;
  const [method] = parseScriptMethods(source);
  assert.equal(method.name, "take");
  assert.equal(method.params, null, "must report unknown arity, not a wrong one");
});

check("a parameter default containing a comma does not mis-split", () => {
  const source = `
export default class A extends Script {
  go(opts = { a: 1, b: 2 }, second) {}
}
`;
  const [method] = parseScriptMethods(source);
  assert.deepEqual(method.params.map((p) => p.name), ["opts", "second"]);
});

check("TypeScript annotations and rest parameters are read", () => {
  const source = `
export default class A extends Script {
  hit(amount: number, source?: Entity, ...rest: string[]) {}
}
`;
  const [method] = parseScriptMethods(source);
  assert.deepEqual(method.params.map((p) => p.name), ["amount", "source", "rest"]);
  assert.equal(method.params[1].optional, true);
  assert.equal(method.params[2].variadic, true);
});

/* -------------------------------------------------------------------------- */
/* Codegen                                                                     */
/* -------------------------------------------------------------------------- */

const ROOT = "C:/proj";
const scripts = [
  {
    path: "C:/proj/scripts/Door.ts",
    className: "Door",
    methods: [
      { name: "onStart", params: [], isHook: true },
      { name: "open", params: [{ name: "speed" }, { name: "force", optional: true }], isHook: false },
    ],
  },
  {
    path: "C:/proj/scripts/Health.js",
    className: "Health",
    methods: [{ name: "damage", params: [{ name: "amount" }], isHook: false }],
  },
];

check("generated types map class names to their real modules", () => {
  const dts = generateScriptTypes(ROOT, scripts);
  assert.match(dts, /interface ScriptMap \{/);
  assert.match(dts, /Door: import\("\.\/scripts\/Door"\)\.default;/);
  // The extension is dropped — a `.ts` specifier is not resolvable.
  assert.match(dts, /Health: import\("\.\/scripts\/Health"\)\.default;/);
  assert.doesNotMatch(dts, /\.ts"\)/);
  assert.match(dts, /declare module "engine"/);
  assert.match(dts, /export \{\};/);
});

check("hooks read their signature off the class rather than restating it", () => {
  // Restating a parameter's type here cannot work: a script's annotations name
  // types from its own module scope. Referencing the class instead gets the
  // REAL types, imported ones included, resolved where they were declared.
  const dts = generateScriptTypes(ROOT, scripts);
  assert.match(dts, /"open": ScriptHookArgs<ScriptMap\["Door"\], "open">;/);
  assert.match(dts, /"damage": ScriptHookArgs<ScriptMap\["Health"\], "damage">;/);
  assert.doesNotMatch(dts, /speed: any/, "no hand-written parameter types");
});

check("engine lifecycle hooks are NOT re-declared", () => {
  // They are on the base `ScriptHookMap` in engine.d.ts; a second declaration
  // is a duplicate interface member, which breaks the whole generated file.
  const dts = generateScriptTypes(ROOT, scripts);
  assert.doesNotMatch(dts, /"onStart"/);
});

check("a hook several scripts declare becomes the UNION of their signatures", () => {
  // Several handlers for one message is what a hook IS, not a conflict —
  // dispatch should accept what any one of them accepts. The old behaviour
  // threw the signature away entirely as soon as two scripts disagreed.
  const shared = [
    { path: "C:/proj/A.ts", className: "A", methods: [{ name: "go", params: [{ name: "x" }] }] },
    {
      path: "C:/proj/B.ts",
      className: "B",
      methods: [{ name: "go", params: [{ name: "x" }, { name: "y" }] }],
    },
  ];
  const dts = generateScriptTypes(ROOT, shared);
  assert.match(
    dts,
    /"go": ScriptHookArgs<ScriptMap\["A"\], "go"> \| ScriptHookArgs<ScriptMap\["B"\], "go">;/,
  );
  assert.match(dts, /Declared by 2 scripts: A, B/);
});

check("a static method is not dispatchable", () => {
  const statics = [
    {
      path: "C:/proj/A.ts",
      className: "A",
      methods: [{ name: "make", params: [], isStatic: true }, { name: "go", params: [] }],
    },
  ];
  const dts = generateScriptTypes(ROOT, statics);
  assert.doesNotMatch(dts, /"make"/, "dispatch reaches instances, not the class");
  assert.match(dts, /"go"/);
});

check("an empty project still generates a valid module", () => {
  const dts = generateScriptTypes(ROOT, []);
  assert.doesNotMatch(dts, /declare module/);
  assert.match(dts, /export \{\};/);
});

console.log(failures ? `\n${failures} failing` : "\nall script introspection checks passed");
process.exit(failures ? 1 : 0);
