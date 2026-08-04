export class EventEmitter {
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
    if (!set) return;
    for (const fn of [...set]) fn(...args);
  }

  async emitAsync(event, ...args) {
    const set = this.#listeners.get(event);
    if (!set) return;
    await Promise.all([...set].map((fn) => fn(...args)));
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
