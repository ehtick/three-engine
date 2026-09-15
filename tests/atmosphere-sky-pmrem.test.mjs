/**
 * The sky environment PMREM (eight nested renders) is rebuilt when the sky
 * changed perceptibly since the LAST BUILD — never on a timer alone.
 *
 * Each scenario runs the component's publish gate (dome thresholds from
 * `AtmosphereComponent._refreshSky`) over real sky-model output, then asks a
 * rebuild POLICY what to do. The new policy is `skyPmremDue`; the old one —
 * "any publish, at most every 1.2 s" — must FAIL the same fixtures, or the
 * test is not guarding the defect.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { celestialState } from "../src/modules/atmosphere/sunCycle.js";
import { blendWeather, weatherPreset } from "../src/modules/atmosphere/weather.js";
import { measureSky, skyParameters } from "../src/modules/atmosphere/skyModel.js";
import {
  SKY_PMREM_COLOUR_EPSILON, SKY_PMREM_MIN_SECONDS, SKY_PMREM_SETTLE_SECONDS, SKY_PMREM_SUN_EPSILON,
  skyEnvironmentChange, skyPmremDue, skySnapshot,
} from "../src/modules/atmosphere/skyEnvironmentRefresh.js";

const FPS = 20;
const cache = new Map();
function sky(hour, weather = weatherPreset("fair")) {
  const key = `${hour.toFixed(5)}|${JSON.stringify(weather)}`;
  if (cache.has(key)) return cache.get(key);
  const c = celestialState({ hour, dayOfYear: 172, latitude: 45, northOffset: 0 });
  const p = skyParameters({
    sunDirection: c.sun.direction, moonDirection: c.moon.direction, moonIllumination: c.moon.illumination,
    weather, nightLight: 1, intensity: 1,
  });
  measureSky(p);
  const snapshot = skySnapshot(p);
  cache.set(key, snapshot);
  return snapshot;
}

/** The dome gate: publish on first sky, 1.5° of sun, 1.2 % colour, or an edit. */
function domeStale(published, current) {
  if (!published) return true;
  const change = skyEnvironmentChange(published, current);
  let drift = 0;
  for (let c = 0; c < 3; c++) {
    drift += Math.abs(current.irradiance[c] - published.irradiance[c]) / Math.max(0.02, published.irradiance[c]);
    drift += Math.abs(current.horizon[c] - published.horizon[c]) / Math.max(0.02, published.horizon[c]);
  }
  return change.sun > 0.026 || drift / 6 > 0.012 || change.weather > 0.004;
}

const policies = {
  old: ({ published, secondsSincePmrem }) => published && secondsSincePmrem >= 1.2,
  new: ({ state }) => skyPmremDue(state),
};

function run(policyName, { seconds, skyAt, dirtyEvery = Infinity, clockRunning = () => false }) {
  const policy = policies[policyName];
  let current = null, lastPublish = -Infinity, baseline = null, lastPmrem = -Infinity, lastDirty = 0;
  const rebuilds = [];
  const trace = [];
  for (let f = 0; f <= seconds * FPS; f++) {
    const t = f / FPS;
    const now = skyAt(t);
    const dirty = t - lastDirty >= dirtyEvery;
    if (dirty) lastDirty = t;
    let published = false;
    if (dirty || domeStale(current, now)) {
      current = now;
      lastPublish = t;
      published = true;
    }
    const state = {
      baseline, current, secondsSincePmrem: t - lastPmrem, secondsSincePublish: t - lastPublish,
      clockRunning: clockRunning(t),
    };
    if (policy({ published, secondsSincePmrem: t - lastPmrem, state })) {
      lastPmrem = t;
      baseline = current;
      rebuilds.push(t);
    }
    trace.push({ t, baseline, current });
  }
  return { rebuilds, trace, baseline, current };
}

function checkPausedClock(policyName) {
  // Static time of day; an unrelated prop edit re-publishes the same sky every 2 s.
  const r = run(policyName, { seconds: 30, skyAt: () => sky(10.5), dirtyEvery: 2 });
  assert.equal(r.rebuilds.length, 1, `${policyName}: a static sky rebuilds once (got ${r.rebuilds.length})`);
}

function checkRunningClock(policyName) {
  // 1 game day per 20 real minutes, late afternoon: 0.3°/s of sun.
  const hourAt = (t) => 16 + t * (24 / (20 * 60));
  const r = run(policyName, { seconds: 60, skyAt: (t) => sky(hourAt(t)), clockRunning: () => true });
  for (let i = 1; i < r.rebuilds.length; i++) {
    assert.ok(r.rebuilds[i] - r.rebuilds[i - 1] >= SKY_PMREM_MIN_SECONDS - 1e-9, "never faster than the floor");
  }
  // Staleness bound: once the floor has passed, the IBL is within the epsilon
  // (+ one frame of travel) of the sky the texture holds.
  const step = (0.3 * Math.PI / 180) / FPS;
  for (const { baseline, current } of r.trace) {
    if (!baseline) continue;
    const change = skyEnvironmentChange(baseline, current);
    assert.ok(change.sun <= SKY_PMREM_SUN_EPSILON + step + 0.03, `sun lag ${change.sun}`);
  }
  // Measured: new 6, old 12 over this minute (a 5-min day is ~40 for both —
  // the sky really does move perceptibly every second there).
  assert.ok(r.rebuilds.length <= 8, `${policyName}: a slow clock rebuilds only on perceptual change (got ${r.rebuilds.length})`);
}

function checkScrub(policyName) {
  // Editor scrub 10.5 → 17 h over one second, then released.
  const hourAt = (t) => (t < 5 ? 10.5 : t < 6 ? 10.5 + (t - 5) * 6.5 : 17);
  const r = run(policyName, { seconds: 20, skyAt: (t) => sky(hourAt(t)) });
  const after = r.rebuilds.filter((t) => t >= 5);
  assert.ok(after.length >= 1 && after[0] <= 5 + 2 / FPS, `${policyName}: the scrub lands promptly`);
  const last = r.rebuilds[r.rebuilds.length - 1];
  assert.ok(last <= 6 + SKY_PMREM_MIN_SECONDS + SKY_PMREM_SETTLE_SECONDS + 2 / FPS, "the released value is flushed");
  const change = skyEnvironmentChange(r.baseline, r.current);
  assert.ok(change.sun < 1e-9 && change.colour < 1e-9, `${policyName}: the final IBL is the final sky`);
}

function checkWeather(policyName) {
  // Frozen clock, fair → storm over 20 s; then held.
  const from = weatherPreset("fair"), to = weatherPreset("storm");
  const weatherAt = (t) => (t >= 20 ? to : blendWeather(from, to, Math.round((t / 20) * FPS * 20) / (FPS * 20)));
  const r = run(policyName, { seconds: 30, skyAt: (t) => sky(12, weatherAt(t)) });
  assert.ok(r.rebuilds.some((t) => t > 0 && t < 20), "rebuilds during the transition");
  const change = skyEnvironmentChange(r.baseline, r.current);
  assert.ok(change.colour < 1e-9 && change.weather < 1e-9, `${policyName}: the finished weather is what the IBL shows`);
  assert.ok(r.rebuilds[r.rebuilds.length - 1] <= 20 + SKY_PMREM_MIN_SECONDS + SKY_PMREM_SETTLE_SECONDS + 2 / FPS);
}

test("paused clock / static time of day: zero rebuilds after the first", () => checkPausedClock("new"));
test("running clock: rebuilt on perceptual change, rate-floored, bounded staleness", () => checkRunningClock("new"));
test("editor time scrub lands promptly and the released value is flushed exactly", () => checkScrub("new"));
test("weather transition updates during and lands exactly after", () => checkWeather("new"));

test("negative control: the old 1.2 s timer policy fails the paused and running fixtures", () => {
  assert.throws(() => checkPausedClock("old"), /static sky rebuilds once/);
  assert.throws(() => checkRunningClock("old"), /slow clock rebuilds only on perceptual change/);
});

test("skyPmremDue: first sky, floor, identical sky, significant, settle", () => {
  const a = sky(10.5), b = sky(10.5), far = sky(13), near = sky(10.52);
  const base = { secondsSincePmrem: 5, secondsSincePublish: 5, clockRunning: false };
  assert.equal(skyPmremDue({ ...base, baseline: null, current: a }), true);
  assert.equal(skyPmremDue({ ...base, baseline: a, current: null }), false);
  assert.equal(skyPmremDue({ ...base, baseline: a, current: b }), false, "identical sky");
  assert.equal(skyPmremDue({ ...base, baseline: a, current: far, secondsSincePmrem: 1 }), false, "floor");
  assert.equal(skyPmremDue({ ...base, baseline: a, current: far }), true, "significant");
  const small = skyEnvironmentChange(a, near);
  assert.ok(small.sun < SKY_PMREM_SUN_EPSILON && small.colour < SKY_PMREM_COLOUR_EPSILON && small.sun > 0);
  assert.equal(skyPmremDue({ ...base, baseline: a, current: near, secondsSincePublish: 0.5 }), false, "still moving");
  assert.equal(skyPmremDue({ ...base, baseline: a, current: near }), true, "settled");
  assert.equal(skyPmremDue({ ...base, baseline: a, current: near, clockRunning: true }), false, "a running clock never settles");
});
