// `@autobind` — the script-facing decorator that makes a method keep its
// instance when it is passed as a callback.
//
//   npm run test:autobind
//
// Node-only, no browser: the decorator is plain JS with no engine dependency.
// But it is NOT tested by calling `autobind(...)` by hand — the TypeScript
// source below goes through the exact esbuild options `transpileScript()` uses
// (`loader: "ts"`, `experimentalDecorators: true`), because what is actually
// under test is how esbuild's `__decorateClass` helper calls the decorator:
// one argument for a class, three for a method. A decorator that dispatches on
// its own arity is only correct if that calling convention holds.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

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

const AUTOBIND_URL = pathToFileURL(
  new URL("../src/engine/scriptRuntime/autobind.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
).href;

// The user script under test, written the way a gameplay script would be.
const USER_SCRIPT = `
import { autobind } from ${JSON.stringify(AUTOBIND_URL)};

/** Whole-class form. */
@autobind
export class Counter {
  name = "counter";
  hits = 0;

  bump() { this.hits++; return this.name; }
  who() { return this.name; }

  get label() { throw new Error("a getter must not be invoked at decoration time"); }

  static create() { return new this(); }
}

/** Called form — same decorator, one hop later. */
@autobind()
export class Called {
  name = "called";
  who() { return this.name; }
}

/** Per-method form: only \`bound\` is decorated. */
export class Mixed {
  name = "mixed";
  @autobind bound() { return this.name; }
  loose() { return this.name; }
}

/** A subclass of a decorated class, plus an override that calls super. */
export class Derived extends Counter {
  name = "derived";
  who() { return "derived:" + super.who(); }
}

/** Static methods are methods too. */
export class Statics {
  static tag = "statics";
  @autobind static read() { return this.tag; }
}
`;

const dir = mkdtempSync(join(tmpdir(), "autobind-"));
let mod;
try {
  const esbuild = await import("esbuild-wasm");
  const { code } = await esbuild.transform(USER_SCRIPT, {
    loader: "ts",
    tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
  });
  const file = join(dir, "script.mjs");
  writeFileSync(file, code, "utf8");
  mod = await import(pathToFileURL(file).href);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const { Counter, Called, Mixed, Derived, Statics } = mod;
const { autobind } = await import(AUTOBIND_URL);

console.log("autobind — class form");

check("a method passed as a bare callback keeps its instance", () => {
  const c = new Counter();
  const callback = c.bump; // the whole point: no `.bind(this)` here
  assert.equal(callback(), "counter");
  assert.equal(c.hits, 1);
});

check("identity is stable, so an off() can undo its on()", () => {
  const c = new Counter();
  assert.equal(c.who, c.who, "two reads returned different functions");
  // The failure this guards: `.bind()` hands back a new function every call,
  // so a handler registered with `on(this.m.bind(this))` can never be removed.
  const listeners = new Set();
  listeners.add(c.who);
  listeners.delete(c.who);
  assert.equal(listeners.size, 0);
});

check("binding is per instance", () => {
  const a = new Counter();
  const b = new Counter();
  b.name = "b";
  assert.notEqual(a.who, b.who);
  assert.equal(a.who(), "counter");
  assert.equal(b.who(), "b");
});

check("the bound method is cached as an own, non-enumerable property", () => {
  const c = new Counter();
  void c.who;
  assert.ok(Object.hasOwn(c, "who"), "not cached on the instance");
  // Enumerable would put a function into `{...entity}` spreads and save data.
  assert.ok(!Object.keys(c).includes("who"), "bound method leaked into Object.keys");
});

check("getters are left alone (not invoked at decoration time)", () => {
  const descriptor = Object.getOwnPropertyDescriptor(Counter.prototype, "label");
  assert.equal(typeof descriptor.get, "function");
});

check("reading the method off the prototype yields the unbound function", () => {
  assert.equal(typeof Counter.prototype.who, "function");
  assert.equal(Counter.prototype.who.call({ name: "borrowed" }), "borrowed");
});

check("assignment over a bound method still works", () => {
  const c = new Counter();
  void c.who;
  c.who = () => "patched";
  assert.equal(c.who(), "patched");
  const fresh = new Counter();
  fresh.who = () => "patched-before-read";
  assert.equal(fresh.who(), "patched-before-read");
});

check("@autobind() (called form) behaves identically", () => {
  const c = new Called();
  const callback = c.who;
  assert.equal(callback(), "called");
});

console.log("autobind — per-method form");

check("only the decorated method is bound", () => {
  const m = new Mixed();
  assert.equal(m.bound(), "mixed");
  const bound = m.bound;
  assert.equal(bound(), "mixed");
  const loose = m.loose;
  assert.throws(() => loose(), /undefined|Cannot read/);
});

check("a static method binds to the class", () => {
  const read = Statics.read;
  assert.equal(read(), "statics");
});

console.log("autobind — subclassing");

check("a subclass of a decorated class binds to the INSTANCE, not the prototype", () => {
  // The trap: a naive `receiver === proto` guard misses `Derived.prototype`,
  // so touching the method through the subclass prototype installs a function
  // bound to that prototype and every Derived instance inherits it — one
  // shared `this` for all of them, and the accessor never runs again.
  void Derived.prototype.bump;
  const a = new Derived();
  const b = new Derived();
  b.name = "other";
  const bumpA = a.bump;
  const bumpB = b.bump;
  bumpA();
  bumpB();
  bumpB();
  assert.equal(a.hits, 1, "instances shared a `this`");
  assert.equal(b.hits, 2, "instances shared a `this`");
  assert.equal(bumpB(), "other");
});

check("an override can still call super", () => {
  const d = new Derived();
  assert.equal(d.who(), "derived:derived");
});

console.log("autobind — misuse");

check("on a field: throws, naming the arrow-function alternative", () => {
  assert.throws(
    () => autobind({}, "handler", undefined),
    /is a field/,
    "a field decorator should be refused, not silently ignored",
  );
});

check("on a getter: throws", () => {
  assert.throws(() => autobind({}, "label", { get() {} }), /getter or setter/);
});

console.log(failures ? `\n${failures} failure(s)` : "\nall passed");
process.exit(failures ? 1 : 0);
