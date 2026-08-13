/**
 * `@autobind` — methods whose `this` survives being passed around.
 *
 * A script's methods live on the prototype, so the moment one is passed as a
 * value the receiver is lost:
 *
 *     this.engine.time.every(0.25, this.updateFps);   // `this` is undefined inside
 *     this.engine.time.every(0.25, this.updateFps.bind(this));  // the manual fix
 *
 * `.bind(this)` at every call site is the fix everyone knows and nobody
 * remembers, and it is worse than merely verbose: `bind` returns a NEW function
 * each call, so `off(this.onHit.bind(this))` can never unsubscribe the handler
 * `on(this.onHit.bind(this))` registered. This decorator removes both problems.
 *
 *     @autobind
 *     export default class FpsCounter extends Script {
 *       onStart() { this.engine.time.every(0.25, this.updateFps); }
 *       updateFps() { this.text.text = `FPS: ${this.engine.stats.fps}`; }
 *     }
 *
 * Three placements, all legal:
 *
 *     @autobind         class Foo {}   // every method on the class
 *     @autobind()       class Foo {}   // same, called form
 *     class Foo { @autobind onHit() {} }   // just this one
 *
 * ## How
 *
 * The prototype method is replaced by a getter. The first time an INSTANCE
 * reads it, the getter binds the function to that instance and installs the
 * result as an own property, so every later read is a plain property load with
 * no getter, no `bind`, and — the part that matters for `off()` — the same
 * function identity every time:
 *
 *     script.updateFps === script.updateFps   // true
 *
 * Binding is per instance and lazy, so two entities running the same script
 * each get their own bound function, and a method that is never read costs
 * nothing.
 *
 * ## What it does NOT cover
 *
 * - Only the decorated class's OWN prototype methods. If gameplay code sits in
 *   a base class of your own, decorate that class too — `@autobind` on the
 *   subclass deliberately does not reach up and rewrite methods declared
 *   somewhere else.
 * - Getters and setters are left alone (binding one would mean invoking it at
 *   decoration time, on the prototype).
 * - Class fields are already instance-owned; a field initialised with an arrow
 *   function (`onHit = () => {}`) is bound by the language, and `@autobind` on
 *   one throws rather than pretending to do something.
 */

/**
 * True when `obj` is some class's `.prototype` rather than an instance.
 *
 * Load-bearing for subclasses. The naive guard is `receiver === proto`, which
 * misses `Derived.prototype` — and binding THAT would install an own data
 * property on `Derived.prototype`, permanently shadowing the accessor for
 * every instance of `Derived` with a function bound to the prototype object.
 * One subclass would silently break the decorator for all of its instances.
 */
function isPrototypeObject(obj) {
  const ctor = Object.getOwnPropertyDescriptor(obj, "constructor")?.value;
  return typeof ctor === "function" && ctor.prototype === obj;
}

/**
 * Method descriptor -> lazily-binding accessor descriptor. `home` is what the
 * method was declared on: a prototype for an instance method, the constructor
 * itself for a static one.
 */
function bindOnAccess(home, key, descriptor) {
  const fn = descriptor.value;
  // A static method's receiver IS its declaring object (the class, or a
  // subclass of it), so the prototype guards below must not fire for one —
  // they would hand back the unbound function every time.
  const isStatic = typeof home === "function";
  return {
    configurable: true,
    enumerable: descriptor.enumerable,
    get() {
      // Reached with a prototype as the receiver (`Foo.prototype.m`, a
      // `super.m` lookup on a class object, a `Object.keys`-style walk): hand
      // back the raw function. There is no instance to bind to yet.
      if (this == null) return fn;
      if (!isStatic && (this === home || isPrototypeObject(this))) return fn;
      const bound = fn.bind(this);
      // Shadow the accessor with the bound function, so identity is stable and
      // later reads skip this getter entirely. Non-enumerable to match the
      // method it replaces — a bound method must not show up in a
      // `for...in`/spread of the instance, or it would land in save data.
      Object.defineProperty(this, key, {
        value: bound,
        configurable: true,
        writable: true,
        enumerable: false,
      });
      return bound;
    },
    set(value) {
      // Assigning over the method (a test double, a runtime patch) has to keep
      // working — without a setter, the accessor would make it a silent no-op
      // in sloppy mode and a TypeError in strict mode.
      Object.defineProperty(this, key, {
        value,
        configurable: true,
        writable: true,
        enumerable: true,
      });
    },
  };
}

/** Rewrites every own prototype method of `cls` to bind on first access. */
function bindClass(cls) {
  const proto = cls?.prototype;
  if (typeof cls !== "function" || !proto) {
    throw new Error("@autobind goes on a class or a method.");
  }
  for (const key of Reflect.ownKeys(proto)) {
    if (key === "constructor") continue;
    const descriptor = Object.getOwnPropertyDescriptor(proto, key);
    // Skip accessors (including methods an earlier `@autobind` already
    // converted) and anything sealed against redefinition.
    if (!descriptor?.configurable || typeof descriptor.value !== "function") continue;
    Object.defineProperty(proto, key, bindOnAccess(proto, key, descriptor));
  }
  return cls;
}

/**
 * The decorator itself. Dispatches on how it was applied — see the module
 * comment for the three legal placements.
 */
export function autobind(target, key, descriptor) {
  // Called form: `@autobind()`. The same function, one hop later.
  if (target === undefined) return autobind;

  // Class form: a class decorator is handed the constructor and nothing else.
  if (key === undefined) return bindClass(target);

  // Method form. A legacy property decorator gets no descriptor at all, which
  // is how a field lands here; getters/setters arrive with no `.value`.
  if (typeof descriptor?.value !== "function") {
    throw new Error(
      descriptor
        ? `@autobind goes on a method — "${String(key)}" is a getter or setter, and ` +
          `binding one would mean calling it on the prototype at load time.`
        : `@autobind goes on a method or a class — "${String(key)}" is a field. ` +
          `A field is already instance-owned: write \`${String(key)} = () => {}\` ` +
          `and it is bound by the language.`,
    );
  }
  return bindOnAccess(target, key, descriptor);
}
