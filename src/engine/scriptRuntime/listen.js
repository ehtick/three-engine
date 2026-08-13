// @ts-check
/**
 * `@listen` — a script method that subscribes itself.
 *
 *     export default class Health extends Script {
 *       @listen("player-died")
 *       onDied(cause) { ... }
 *
 *       @listen("damaged", { on: "entity" })
 *       onDamaged(amount) { ... }
 *     }
 *
 * Subscribed when the script starts, unsubscribed when it stops. That second
 * half is the point. Unity makes you pair every `+=` in `OnEnable` with a `-=`
 * in `OnDisable`, and a missed one is the single most common leak in a Unity
 * codebase: the handler keeps the destroyed object alive and keeps running
 * against it, usually surfacing as a null-reference from a scene that isn't
 * loaded any more. Godot has the same shape with `connect`/`disconnect`. Here
 * there is nothing to pair, because there is nothing to write.
 *
 * The name is checked against the project's event map, so a typo is a compile
 * error rather than a handler that never fires — see `project-events.d.ts`,
 * generated from the Events panel.
 *
 * Legacy-style decorator (`target, key, descriptor`), matching `autobind.js`
 * and the `experimentalDecorators: true` in every scaffolded project.
 */

/** Where a class's own listen declarations live. Symbol-keyed so it cannot
 *  collide with a game's own field, and per-prototype so a subclass adds to
 *  its own list rather than mutating its parent's. */
const LISTENERS = Symbol.for("three-engine.listeners");

/** Where the live unsubscribes live on an INSTANCE. */
const ACTIVE = Symbol.for("three-engine.activeListeners");

/**
 * Declares that a method listens to `event`.
 *
 * `on` picks the bus: `"engine"` (default) is the global one, `"entity"` is
 * this script's own entity, `"input"` binds an input action's press (or its
 * release with `edge: "released"`).
 *
 * `once` unsubscribes after the first call, like `EventEmitter.once`.
 */
export function listen(event, options = {}) {
  if (typeof event !== "string" || !event) {
    throw new Error('@listen needs an event name: @listen("player-died").');
  }
  return function listenDecorator(target, key, descriptor) {
    if (typeof descriptor?.value !== "function") {
      throw new Error(
        descriptor
          ? `@listen goes on a method — "${String(key)}" is a getter or setter.`
          : `@listen goes on a method — "${String(key)}" is a field. Write it as a method ` +
            `(\`${String(key)}() {}\`), or subscribe by hand in onStart.`,
      );
    }
    // `hasOwnProperty`, not `in`: a subclass must start its own list rather
    // than pushing into the one it inherited, or decorating a method on the
    // child would also subscribe it for every sibling class.
    if (!Object.prototype.hasOwnProperty.call(target, LISTENERS)) {
      Object.defineProperty(target, LISTENERS, {
        value: [],
        writable: true,
        configurable: true,
        enumerable: false,
      });
    }
    target[LISTENERS].push({
      event,
      key,
      on: options.on ?? "engine",
      edge: options.edge ?? "pressed",
      once: !!options.once,
    });
    return descriptor;
  };
}

/**
 * Every `@listen` declaration that applies to `instance`, base class first.
 *
 * Walks the prototype chain so a script extending a base of its own inherits
 * that base's subscriptions — the same expectation any other method carries.
 */
function declarationsFor(instance) {
  const out = [];
  let proto = Object.getPrototypeOf(instance);
  while (proto && proto !== Object.prototype) {
    if (Object.prototype.hasOwnProperty.call(proto, LISTENERS)) out.unshift(...proto[LISTENERS]);
    proto = Object.getPrototypeOf(proto);
  }
  return out;
}

/** Whether a script class declares any `@listen` at all — lets the caller skip
 *  the prototype walk for the overwhelmingly common case of none. */
export function hasListeners(instance) {
  let proto = Object.getPrototypeOf(instance ?? {});
  while (proto && proto !== Object.prototype) {
    if (Object.prototype.hasOwnProperty.call(proto, LISTENERS)) return true;
    proto = Object.getPrototypeOf(proto);
  }
  return false;
}

/**
 * Subscribes every `@listen` method on `instance`.
 *
 * Idempotent: detaches first, so a hot reload or a stop/start cycle cannot
 * leave two subscriptions where the author wrote one. That doubling is
 * invisible until something counts — a score that goes up by two, a sound that
 * plays twice — and it is the failure that makes hand-rolled subscribe-on-start
 * unreliable in the first place.
 */
export function attachListeners(instance) {
  if (!instance) return;
  detachListeners(instance);
  const declarations = declarationsFor(instance);
  if (!declarations.length) return;
  const unsubs = [];
  for (const declaration of declarations) {
    const handler = instance[declaration.key];
    if (typeof handler !== "function") continue;
    // Bound here rather than relying on `@autobind`: the two decorators are
    // independent, and a `@listen` method whose `this` was undefined would fail
    // on its first line with an error pointing at the handler rather than at
    // the missing binding.
    const bound = (...args) => handler.apply(instance, args);
    const unsub = subscribe(instance, declaration, bound);
    if (unsub) unsubs.push(unsub);
  }
  instance[ACTIVE] = unsubs;
}

function subscribe(instance, declaration, handler) {
  const engine = instance.engine;
  if (!engine) return null;
  switch (declaration.on) {
    case "entity": {
      const entity = instance.entity;
      if (!entity) return null;
      return declaration.once
        ? entity.once(declaration.event, handler)
        : entity.on(declaration.event, handler);
    }
    case "input": {
      const input = engine.input;
      if (!input) return null;
      return declaration.edge === "released"
        ? input.onRelease(declaration.event, handler)
        : input.onAction(declaration.event, handler);
    }
    default:
      return declaration.once
        ? engine.once(declaration.event, handler)
        : engine.on(declaration.event, handler);
  }
}

/** Drops every subscription `attachListeners` made. Safe to call twice. */
export function detachListeners(instance) {
  const unsubs = instance?.[ACTIVE];
  if (!unsubs) return;
  for (const unsub of unsubs) {
    try {
      unsub();
    } catch {
      // A bus that is already gone (the entity was destroyed first) is not an
      // error worth surfacing during teardown.
    }
  }
  instance[ACTIVE] = null;
}
