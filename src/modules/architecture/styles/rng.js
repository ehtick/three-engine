/** Deterministic seeded RNG shared by every style decorator (mulberry32).
 * Same seed -> same sequence, so a building's style detail is reproducible
 * across reloads and across a headless test and the live editor alike. */
export function createRng(seed = 0) {
  let state = (Number.isFinite(seed) ? Math.floor(seed) : 0) >>> 0;
  if (state === 0) state = 0x9e3779b9;
  function next() {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  return {
    /** Next value in [0, 1). */
    next,
    /** Next value in [min, max). */
    range(min, max) { return min + next() * (max - min); },
    /** Next integer in [min, max], inclusive of both ends. */
    int(min, max) { return Math.floor(min + next() * (max - min + 1)); },
    /** One element of `array`, or undefined for an empty array. */
    pick(array) { return array.length ? array[Math.floor(next() * array.length)] : undefined; },
    /** true with probability `p` (0..1). */
    chance(p) { return next() < p; },
  };
}
