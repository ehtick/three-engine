// @ts-check
import { EventEmitter } from "../EventEmitter.js";
import { normalizeEventCatalog } from "./catalog.js";

/**
 * `engine.events` — the live view of the project's event catalog, plus the
 * diagnostic tap the Events panel's monitor reads.
 *
 * This is deliberately NOT another bus. `engine.on`/`emit` is still where
 * events are listened to and fired; this object only answers "what events does
 * this project declare" and "what has been firing lately". Adding a fifth
 * emitter would have given every event two plausible places to be sent from,
 * which is the failure mode the typed maps exist to prevent.
 */
export class EventRegistry {
  /** @type {Array<any>} */
  #events = [];
  /** @type {Map<string, any>} */
  #byName = new Map();
  /** @type {Array<any>} */
  #history = [];
  #limit = 500;
  #recording = false;
  #seq = 0;

  /** Replaces the catalog. Invalid entries are dropped; see `normalizeEventCatalog`. */
  load(raw) {
    const { events, errors } = normalizeEventCatalog(raw);
    this.#events = events;
    this.#byName = new Map(events.map((event) => [event.name, event]));
    return { events, errors };
  }

  /** Every declared event, in catalog order. */
  list() {
    return this.#events;
  }

  /** One event's definition, or null. */
  get(name) {
    return this.#byName.get(name) ?? null;
  }

  /** Whether the project declares `name`. */
  has(name) {
    return this.#byName.has(name);
  }

  /* ---- monitor ----------------------------------------------------------- */

  /**
   * Starts or stops recording every emission on every bus.
   *
   * Off by default and not something a game should ship enabled: the tap runs
   * inside `EventEmitter.emit`, so it sits on the hottest path any event system
   * has. Recording is refcount-free on purpose — the panel is the only caller,
   * and a second one silently keeping it alive would be worse than a second one
   * turning it off.
   */
  record(on = true, { limit = 500 } = {}) {
    this.#limit = Math.max(1, limit | 0);
    if (!on) {
      this.#recording = false;
      EventEmitter.monitor = null;
      return;
    }
    if (this.#recording) return;
    this.#recording = true;
    EventEmitter.monitor = (emitter, event, args, listeners) => {
      this.#history.push({
        seq: ++this.#seq,
        t: performance.now(),
        name: String(event),
        source: describeEmitter(emitter),
        listeners,
        args: args.map(summarizeArg),
        declared: this.#byName.has(event),
      });
      // Trim in one splice rather than a shift per push: a busy frame can add
      // hundreds of entries and shift() is O(n) each time.
      if (this.#history.length > this.#limit * 2) {
        this.#history.splice(0, this.#history.length - this.#limit);
      }
    };
  }

  /** Whether the tap is currently armed. */
  get recording() {
    return this.#recording;
  }

  /** Most recent emissions, oldest first, capped at the recording limit. */
  history() {
    if (this.#history.length > this.#limit) {
      this.#history.splice(0, this.#history.length - this.#limit);
    }
    return this.#history;
  }

  /** Drops everything recorded so far. */
  clearHistory() {
    this.#history.length = 0;
  }
}

/**
 * A short label for whichever bus an event came from.
 *
 * Duck-typed rather than `instanceof`, because importing `Engine`/`Entity`/
 * `Component` here would make this module part of a cycle with all three (each
 * of them already reaches the emitter). The shapes are distinctive enough that
 * the checks don't overlap.
 */
function describeEmitter(emitter) {
  if (!emitter || typeof emitter !== "object") return "?";
  // Engine: owns the renderer and the root entity list.
  if ("rootEntities" in emitter && "renderer" in emitter) return "engine";
  // Component: has an owning entity and a static `type`.
  const componentType = /** @type {any} */ (emitter).constructor?.type;
  if (componentType && "entity" in emitter) {
    const owner = /** @type {any} */ (emitter).entity?.name;
    return owner ? `${owner}.${componentType}` : String(componentType);
  }
  // Entity: has an id and a component map.
  if ("id" in emitter && "components" in emitter) {
    return /** @type {any} */ (emitter).name || `entity:${/** @type {any} */ (emitter).id}`;
  }
  if ("activeScheme" in emitter && "schemes" in emitter) return "input";
  return emitter.constructor?.name ?? "?";
}

/**
 * A displayable, *non-retaining* summary of one argument.
 *
 * The history is a ring buffer that can hold a few hundred entries for as long
 * as the panel is open. Keeping the live arguments in it would pin despawned
 * entities, disposed components and whole scene graphs in memory for the rest of
 * the session — the monitor would leak precisely the objects a user is trying to
 * confirm got destroyed. Everything is flattened to a string or a primitive at
 * record time instead.
 */
function summarizeArg(value) {
  if (value === null) return null;
  const type = typeof value;
  if (type === "number" || type === "boolean" || type === "string") return value;
  if (type === "undefined") return undefined;
  if (type === "function") return `ƒ ${value.name || "anonymous"}`;
  if (Array.isArray(value)) return `[${value.length}]`;
  if (type === "object") {
    const obj = /** @type {any} */ (value);
    if ("id" in obj && "components" in obj) return `<${obj.name || obj.id}>`;
    if (typeof obj.isVector3 === "boolean" && obj.isVector3) {
      return `(${obj.x.toFixed(2)}, ${obj.y.toFixed(2)}, ${obj.z.toFixed(2)})`;
    }
    const name = obj.constructor?.name;
    if (name && name !== "Object") return `${name}`;
    const keys = Object.keys(obj);
    if (!keys.length) return "{}";
    return `{${keys.slice(0, 3).join(", ")}${keys.length > 3 ? ", …" : ""}}`;
  }
  return String(value);
}
