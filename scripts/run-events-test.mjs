/**
 * EventEmitter runtime behavior — the super-events-style additions
 * (once/emitAsync/callAll/callAllAsync/callFirst/callFirstAsync/clear) on
 * top of the original sync on/off/emit. `Engine` and `InputManager` both
 * extend this class and get all of it for free, so testing the base class
 * directly covers both without booting a full engine.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "../src/engine/EventEmitter.js";

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
const asyncCheck = async (name, fn) => {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${error.message}`);
  }
};

check("on/emit delivers args to every listener", () => {
  const e = new EventEmitter();
  const seen = [];
  e.on("x", (a, b) => seen.push([a, b]));
  e.on("x", (a, b) => seen.push([a, b]));
  e.emit("x", 1, 2);
  assert.deepEqual(seen, [[1, 2], [1, 2]]);
});

check("off removes a listener registered via on", () => {
  const e = new EventEmitter();
  let calls = 0;
  const fn = () => calls++;
  e.on("x", fn);
  e.off("x", fn);
  e.emit("x");
  assert.equal(calls, 0);
});

check("the Unsub returned by on() removes it", () => {
  const e = new EventEmitter();
  let calls = 0;
  const unsub = e.on("x", () => calls++);
  unsub();
  e.emit("x");
  assert.equal(calls, 0);
});

check("once fires exactly once", () => {
  const e = new EventEmitter();
  let calls = 0;
  e.once("x", () => calls++);
  e.emit("x");
  e.emit("x");
  e.emit("x");
  assert.equal(calls, 1);
});

check("once's Unsub cancels it before it ever fires", () => {
  const e = new EventEmitter();
  let calls = 0;
  const unsub = e.once("x", () => calls++);
  unsub();
  e.emit("x");
  assert.equal(calls, 0);
});

check("off(event, originalFn) also removes a once-registered listener", () => {
  const e = new EventEmitter();
  let calls = 0;
  const fn = () => calls++;
  e.once("x", fn);
  e.off("x", fn);
  e.emit("x");
  assert.equal(calls, 0);
});

check("callAll collects return values in registration order", () => {
  const e = new EventEmitter();
  e.on("x", () => 1);
  e.on("x", () => 2);
  e.on("x", () => 3);
  assert.deepEqual(e.callAll("x"), [1, 2, 3]);
});

check("callAll on an event with no listeners returns []", () => {
  const e = new EventEmitter();
  assert.deepEqual(e.callAll("nope"), []);
});

check("callAll throws if a listener returns a Promise", () => {
  const e = new EventEmitter();
  e.on("x", async () => 1);
  assert.throws(() => e.callAll("x"), /callAllAsync/);
});

check("callFirst returns the first non-nullish return value", () => {
  const e = new EventEmitter();
  e.on("x", () => null);
  e.on("x", () => undefined);
  e.on("x", () => 42);
  e.on("x", () => 99);
  assert.equal(e.callFirst("x"), 42);
});

check("callFirst returns undefined when every listener returns nullish", () => {
  const e = new EventEmitter();
  e.on("x", () => null);
  e.on("x", () => undefined);
  assert.equal(e.callFirst("x"), undefined);
});

check("callFirst throws if a listener returns a Promise", () => {
  const e = new EventEmitter();
  e.on("x", async () => 1);
  assert.throws(() => e.callFirst("x"), /callFirstAsync/);
});

check("clear(event) removes only that event's listeners", () => {
  const e = new EventEmitter();
  let xCalls = 0;
  let yCalls = 0;
  e.on("x", () => xCalls++);
  e.on("y", () => yCalls++);
  e.clear("x");
  e.emit("x");
  e.emit("y");
  assert.equal(xCalls, 0);
  assert.equal(yCalls, 1);
});

check("clear() with no argument removes every listener on every event", () => {
  const e = new EventEmitter();
  let calls = 0;
  e.on("x", () => calls++);
  e.on("y", () => calls++);
  e.clear();
  e.emit("x");
  e.emit("y");
  assert.equal(calls, 0);
});

await asyncCheck("emitAsync awaits every async listener before resolving", async () => {
  const e = new EventEmitter();
  const order = [];
  e.on("x", async () => {
    await new Promise((r) => setTimeout(r, 10));
    order.push("slow");
  });
  e.on("x", () => order.push("fast"));
  await e.emitAsync("x");
  assert.ok(order.includes("slow") && order.includes("fast"), "both listeners ran");
  assert.equal(order.length, 2, "emitAsync did not resolve early");
});

await asyncCheck("callAllAsync collects resolved values in registration order", async () => {
  const e = new EventEmitter();
  e.on("x", async () => {
    await new Promise((r) => setTimeout(r, 10));
    return "slow";
  });
  e.on("x", () => "fast");
  const results = await e.callAllAsync("x");
  assert.deepEqual(results, ["slow", "fast"]);
});

await asyncCheck("callFirstAsync returns the first non-nullish resolved value", async () => {
  const e = new EventEmitter();
  e.on("x", async () => null);
  e.on("x", async () => 7);
  e.on("x", async () => 8);
  const first = await e.callFirstAsync("x");
  assert.equal(first, 7);
});

await asyncCheck("callFirstAsync returns undefined when every listener resolves nullish", async () => {
  const e = new EventEmitter();
  e.on("x", async () => null);
  e.on("x", async () => undefined);
  const first = await e.callFirstAsync("x");
  assert.equal(first, undefined);
});

console.log(failures ? `\n${failures} failing` : "\nall events checks passed");
process.exit(failures ? 1 : 0);
