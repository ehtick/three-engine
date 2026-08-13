export class EventEmitter {
  /**
   * Diagnostic tap, called as `monitor(emitter, event, args, listenerCount)`
   * before every `emit`/`emitAsync` fans out. `null` disables it, which is the
   * default and costs one property read per emit.
   *
   * Static, so one tap covers every bus at once — `Engine`, every `Entity`,
   * every `Component` and `InputManager` all extend this class, and a monitor
   * that only saw the global bus would miss exactly the events people get
   * stuck on. The Events panel arms it while it is open (see
   * `engine.events.record`) and disarms it on unmount.
   *
   * Called BEFORE the no-listener early return on purpose: "I emitted it and
   * nothing happened" is the single most common thing to be debugging, and a
   * tap that only fires when somebody is already listening cannot answer it.
   */
  static monitor = null;

  #listeners = new Map();

  on(event, fn) {
    if (!this.#listeners.has(event)) this.#listeners.set(event, new Set());
    this.#listeners.get(event).add(fn);
    return () => this.off(event, fn);
  }

  once(event, fn) {
    const wrapper = (...args) => {
      this.off(event, wrapper);
      return fn(...args);
    };
    wrapper.listener = fn;
    this.on(event, wrapper);
    return () => this.off(event, wrapper);
  }

  off(event, fn) {
    const set = this.#listeners.get(event);
    if (!set) return;
    if (set.delete(fn)) return;
    for (const candidate of set) {
      if (candidate.listener === fn) {
        set.delete(candidate);
        return;
      }
    }
  }

  emit(event, ...args) {
    const set = this.#listeners.get(event);
    if (EventEmitter.monitor) EventEmitter.monitor(this, event, args, set?.size ?? 0);
    if (!set) return;
    for (const fn of [...set]) fn(...args);
  }

  async emitAsync(event, ...args) {
    const set = this.#listeners.get(event);
    if (EventEmitter.monitor) EventEmitter.monitor(this, event, args, set?.size ?? 0);
    if (!set) return;
    await Promise.all([...set].map((fn) => fn(...args)));
  }

  /** How many listeners `event` currently has — what the Events panel's
   *  "listeners" column reads, and the cheapest way for a script to check
   *  whether emitting is worth the argument construction. */
  listenerCount(event) {
    return this.#listeners.get(event)?.size ?? 0;
  }

  /**
   * Waits for the next `event` and resolves with its arguments as an array.
   *
   * Godot's `await some_signal`, which `once` could not express: it hands back
   * an unsubscribe, so the only way to wait for an event was a callback and a
   * hand-rolled Promise at every call site.
   *
   *     const [cause] = await this.engine.waitFor("player-died");
   *     await this.engine.waitFor("scene-loaded");
   *
   * Always an array, even for a one-argument event — a shape that changes with
   * the payload cannot be destructured the same way twice, and `[]` for a
   * no-argument event is still truthy, which is what makes the timeout below
   * distinguishable without a try/catch.
   *
   * `timeout` is in SECONDS and resolves `null` rather than rejecting. It is
   * wall-clock (the emitter has no engine to ask for game time), so a pause
   * does not extend it — for a timeout that respects pausing, race this against
   * `engine.time.after(...)`.
   */
  waitFor(event, { timeout } = {}) {
    return new Promise((resolve) => {
      let timer = null;
      const off = this.once(event, (...args) => {
        if (timer !== null) clearTimeout(timer);
        resolve(args);
      });
      if (timeout > 0) {
        timer = setTimeout(() => {
          off();
          resolve(null);
        }, timeout * 1000);
      }
    });
  }

  callAll(event, ...args) {
    const set = this.#listeners.get(event);
    if (!set) return [];
    return [...set].map((fn) => {
      const result = fn(...args);
      if (result instanceof Promise) {
        throw new Error(`callAll("${event}"): a listener returned a Promise — use callAllAsync instead.`);
      }
      return result;
    });
  }

  async callAllAsync(event, ...args) {
    const set = this.#listeners.get(event);
    if (!set) return [];
    return Promise.all([...set].map((fn) => fn(...args)));
  }

  callFirst(event, ...args) {
    const set = this.#listeners.get(event);
    if (!set) return undefined;
    for (const fn of set) {
      const result = fn(...args);
      if (result instanceof Promise) {
        throw new Error(`callFirst("${event}"): a listener returned a Promise — use callFirstAsync instead.`);
      }
      if (result !== null && result !== undefined) return result;
    }
    return undefined;
  }

  async callFirstAsync(event, ...args) {
    const set = this.#listeners.get(event);
    if (!set) return undefined;
    for (const fn of set) {
      const result = await fn(...args);
      if (result !== null && result !== undefined) return result;
    }
    return undefined;
  }

  clear(event) {
    if (event === undefined) this.#listeners.clear();
    else this.#listeners.delete(event);
  }
}
