/**
 * Property tweening on game time.
 *
 * UI is where this shows up first — a menu that snaps between states looks
 * broken in a way that is hard to name — but nothing here is UI-specific: it
 * animates numbers on any object, which covers a door swinging open, a camera
 * FOV punch, and a damage-number floating away.
 *
 * Runs on **game time**, so `setPaused(true)` freezes every tween and a
 * bullet-time `timeScale` slows them with the world. A tween that is meant to
 * survive a pause (a pause *menu's* own fade, most obviously) opts out with
 * `unscaled: true` — without that escape hatch the menu animating the pause
 * would freeze itself halfway through.
 */

const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);

/**
 * The standard easing set. `inOut` variants are the ones worth reaching for by
 * default: a UI element that starts and stops abruptly reads as a jump cut
 * however long the tween is.
 */
export const EASINGS = {
  linear: (t) => t,
  quadIn: (t) => t * t,
  quadOut: (t) => t * (2 - t),
  quadInOut: (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
  cubicIn: (t) => t * t * t,
  cubicOut: (t) => 1 + (t - 1) ** 3,
  cubicInOut: (t) => (t < 0.5 ? 4 * t ** 3 : 1 + 4 * (t - 1) ** 3),
  quartIn: (t) => t ** 4,
  quartOut: (t) => 1 - (t - 1) ** 4,
  quartInOut: (t) => (t < 0.5 ? 8 * t ** 4 : 1 - 8 * (t - 1) ** 4),
  sineIn: (t) => 1 - Math.cos((t * Math.PI) / 2),
  sineOut: (t) => Math.sin((t * Math.PI) / 2),
  sineInOut: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  expoIn: (t) => (t === 0 ? 0 : 2 ** (10 * t - 10)),
  expoOut: (t) => (t === 1 ? 1 : 1 - 2 ** (-10 * t)),
  expoInOut: (t) =>
    t === 0 ? 0 : t === 1 ? 1 : t < 0.5 ? 2 ** (20 * t - 10) / 2 : (2 - 2 ** (-20 * t + 10)) / 2,
  backIn: (t) => 2.70158 * t ** 3 - 1.70158 * t * t,
  backOut: (t) => 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2,
  backInOut: (t) => {
    const c = 1.70158 * 1.525;
    return t < 0.5
      ? ((2 * t) ** 2 * ((c + 1) * 2 * t - c)) / 2
      : ((2 * t - 2) ** 2 * ((c + 1) * (2 * t - 2) + c) + 2) / 2;
  },
  elasticOut: (t) =>
    t === 0 ? 0 : t === 1 ? 1 : 2 ** (-10 * t) * Math.sin(((t * 10 - 0.75) * 2 * Math.PI) / 3) + 1,
  bounceOut: (t) => {
    const n = 7.5625;
    const d = 2.75;
    if (t < 1 / d) return n * t * t;
    if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
    if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
    return n * (t -= 2.625 / d) * t + 0.984375;
  },
};

/** Reads a dotted path (`"position.x"`) off an object. */
function readPath(target, path) {
  let obj = target;
  const parts = path.split(".");
  for (let i = 0; i < parts.length - 1; i++) {
    obj = obj?.[parts[i]];
    if (obj == null) return undefined;
  }
  return obj?.[parts.at(-1)];
}

/** Writes a dotted path, silently ignoring a path that no longer resolves. */
function writePath(target, path, value) {
  let obj = target;
  const parts = path.split(".");
  for (let i = 0; i < parts.length - 1; i++) {
    obj = obj?.[parts[i]];
    if (obj == null) return;
  }
  if (obj) obj[parts.at(-1)] = value;
}

export class Tween {
  constructor(system, target, to, options = {}) {
    this.system = system;
    this.target = target;
    this.to = to ?? {};
    this.from = options.from ?? null;
    this.duration = Math.max(0, options.duration ?? 0.25);
    this.delay = Math.max(0, options.delay ?? 0);
    this.ease = typeof options.ease === "function" ? options.ease : (EASINGS[options.ease] ?? EASINGS.quadInOut);
    this.loop = options.loop ?? 0; // 0 = once, -1 = forever
    this.yoyo = options.yoyo === true;
    this.unscaled = options.unscaled === true;
    this.onUpdate = options.onUpdate ?? null;
    this.onComplete = options.onComplete ?? null;
    this.elapsed = 0;
    this.iteration = 0;
    this.reversed = false;
    this.done = false;
    // Start values are captured on the first tick, not here: a tween created
    // during setup and started a frame later must animate from where the
    // object actually is when it begins, not from where it was when someone
    // wrote the line.
    this.start = null;
    this._resolve = null;
    this.finished = new Promise((resolve) => {
      this._resolve = resolve;
    });
  }

  #capture() {
    this.start = {};
    for (const key of Object.keys(this.to)) {
      const value = this.from?.[key] ?? readPath(this.target, key);
      this.start[key] = typeof value === "number" ? value : 0;
      if (this.from?.[key] !== undefined) writePath(this.target, key, this.start[key]);
    }
  }

  /** Applies the tween at normalized progress `t` (already eased). */
  #apply(t) {
    for (const key of Object.keys(this.to)) {
      const a = this.start[key];
      const b = this.to[key];
      writePath(this.target, key, a + (b - a) * t);
    }
    this.onUpdate?.(t, this.target);
  }

  tick(dt) {
    if (this.done) return;
    if (this.delay > 0) {
      this.delay -= dt;
      if (this.delay > 0) return;
      dt = -this.delay;
      this.delay = 0;
    }
    if (!this.start) this.#capture();
    this.elapsed += dt;

    // A zero-duration tween is a setter with a callback — treat it as one
    // rather than dividing by zero and writing NaN into the target.
    let raw = this.duration > 0 ? this.elapsed / this.duration : 1;
    // Ten ticks of 0.1s sum to 0.9999999999999999, so an exact `>= 1` leaves a
    // tween one frame short of finishing — the value looks right and
    // `onComplete` never fires, which is the sort of bug that surfaces as "the
    // door animation works but the level never continues".
    if (raw >= 1 - 1e-9) raw = Math.max(raw, 1);
    while (raw >= 1 && !this.done) {
      const canLoop = this.loop === -1 || this.iteration < this.loop;
      if (!canLoop) {
        raw = 1;
        break;
      }
      this.iteration++;
      this.elapsed -= this.duration;
      raw = this.duration > 0 ? this.elapsed / this.duration : 1;
      if (this.yoyo) this.reversed = !this.reversed;
    }
    const p = clamp01(raw);
    this.#apply(this.ease(this.reversed ? 1 - p : p));
    if (p >= 1 && this.loop !== -1 && this.iteration >= this.loop) this.#finish();
  }

  #finish() {
    if (this.done) return;
    this.done = true;
    this.system?.remove(this);
    this.onComplete?.(this.target);
    this._resolve?.(this.target);
  }

  /** Stops where it is. The target keeps whatever value it reached. */
  cancel() {
    if (this.done) return;
    this.done = true;
    this.system?.remove(this);
    this._resolve?.(this.target);
  }

  /** Jumps to the end and fires onComplete. */
  complete() {
    if (this.done) return;
    if (!this.start) this.#capture();
    this.#apply(this.ease(1));
    this.#finish();
  }

  /** So `await engine.tween(...)` works. */
  then(onFulfilled, onRejected) {
    return this.finished.then(onFulfilled, onRejected);
  }
}

export class TweenSystem {
  constructor() {
    this.tweens = new Set();
  }

  add(tween) {
    this.tweens.add(tween);
    return tween;
  }

  remove(tween) {
    this.tweens.delete(tween);
  }

  /** Cancels every tween whose target is `target`. */
  cancelOf(target) {
    for (const tween of [...this.tweens]) {
      if (tween.target === target) tween.cancel();
    }
  }

  clear() {
    for (const tween of [...this.tweens]) tween.cancel();
    this.tweens.clear();
  }

  update(dt, unscaledDt) {
    // Snapshot: an onComplete that starts another tween must not have it
    // ticked in the same frame (which would double-advance it).
    for (const tween of [...this.tweens]) {
      tween.tick(tween.unscaled ? unscaledDt : dt);
    }
  }
}
