/**
 * ⭐ WEATHER AS ONE BLENDABLE VECTOR, NEVER AS A MODE SWITCH.
 *
 * Every preset here is the SAME set of numbers with different values, and
 * everything downstream (sky, clouds, fog, wind, precipitation, the sun's
 * dimming) reads only from the blended result. That is the whole design, and
 * it buys the two things a mode switch cannot:
 *
 *   1. A transition is a lerp, so "clear → storm over 40 s" is free and looks
 *      like weather arriving rather than like a cut.
 *   2. RAIN AND SNOW ARE SEPARATE CHANNELS, not one enum. Crossing from rain
 *      to snow therefore passes through sleet on its own, and the temperature
 *      model can hold a scene at 1 °C with both channels half-open, which is
 *      exactly what that day looks like out of a window.
 *
 * ⚠ NOTHING HERE KNOWS ABOUT THREE, THE SCENE OR THE CLOCK. It is a pure
 * function of (previous state, dt, season, temperature) so `npm run
 * test:atmosphere` can run a year of simulated weather in a millisecond and
 * assert that a July scene at 45° N never snows and a January one does.
 */

/** Every authored channel, with the units the rest of the module reads. */
const CHANNELS = {
  /** 0…1 fraction of the sky the cumulus layer covers. */
  cloudCover: 0,
  /** 0…1 optical thickness of that layer — the difference between a bright
   *  fair-weather cumulus and the flat grey lid of a rain front. */
  cloudDensity: 0.5,
  /** 0…1 high, thin, wind-stretched ice cloud. Independent of the low layer. */
  cirrus: 0,
  /** Preetham turbidity: 2 = an alpine day, 10 = summer haze over a city. */
  turbidity: 2.4,
  /** Exponential-squared fog density per metre, before the height falloff. */
  fogDensity: 0,
  /** 0…1 extra VALLEY MIST on top of the authored height fog — low banks
   *  pooled in the hollows, where `fogDensity` is the same haze everywhere. */
  mist: 0,
  /** 0…1 rain rate; 1 is a downpour you cannot see through. */
  rain: 0,
  /** 0…1 snow rate. Blends independently of `rain` — see the header. */
  snow: 0,
  /** Steady wind in m/s. */
  wind: 2,
  /** Gust force added on top of the steady wind, m/s. */
  gust: 0.4,
  /** Strikes per minute. 0 for everything that is not a thunderstorm. */
  thunder: 0,
  /** How much of the sun's own light survives the cloud deck, 0…1. */
  sunLight: 1,
};

export const WEATHER_CHANNELS = Object.freeze({ ...CHANNELS });

/**
 * The presets. Ordered roughly by how much sky they take away, because that
 * is the axis the auto-chain walks along — weather does not usually jump from
 * clear to a thunderstorm without going through the cloud in between.
 */
// ⛔ `clear` MEANS ZERO CLOUD, not "almost none". At 0.03 the threshold still
// let a handful of isolated blobs through — big, soft and lit by whatever the
// sun was doing, which the user reported twice as "random colour spots in the
// sky". A clear sky is the one weather with nothing in it.
export const WEATHER_PRESETS = Object.freeze({
  clear: { cloudCover: 0, cloudDensity: 0.35, cirrus: 0.04, turbidity: 2.2, fogDensity: 0, mist: 0, rain: 0, snow: 0, wind: 1.6, gust: 0.3, thunder: 0, sunLight: 1 },
  fair: { cloudCover: 0.38, cloudDensity: 0.45, cirrus: 0.22, turbidity: 2.8, fogDensity: 0.0006, mist: 0, rain: 0, snow: 0, wind: 2.6, gust: 1.2, thunder: 0, sunLight: 0.92 },
  cloudy: { cloudCover: 0.68, cloudDensity: 0.6, cirrus: 0.35, turbidity: 3.6, fogDensity: 0.0012, mist: 0, rain: 0, snow: 0, wind: 4, gust: 2.2, thunder: 0, sunLight: 0.62 },
  // ⚠ `sunLight` IS "ARE THERE SHADOWS", and under a real overcast there are
  // none. The first pass had 0.34 here and the scene still cast a crisp sun
  // shadow through a lid of cloud, which is the tell that says "a slider
  // moved" rather than "the weather changed".
  overcast: { cloudCover: 0.97, cloudDensity: 0.82, cirrus: 0.1, turbidity: 4.6, fogDensity: 0.002, mist: 0.15, rain: 0, snow: 0, wind: 4.5, gust: 2, thunder: 0, sunLight: 0.08 },
  fog: { cloudCover: 0.55, cloudDensity: 0.6, cirrus: 0, turbidity: 6.5, fogDensity: 0.022, mist: 0.8, rain: 0, snow: 0, wind: 0.7, gust: 0.2, thunder: 0, sunLight: 0.12 },
  drizzle: { cloudCover: 0.9, cloudDensity: 0.78, cirrus: 0.05, turbidity: 5, fogDensity: 0.005, mist: 0.35, rain: 0.22, snow: 0, wind: 3.4, gust: 1.6, thunder: 0, sunLight: 0.1 },
  rain: { cloudCover: 0.98, cloudDensity: 0.9, cirrus: 0, turbidity: 5.6, fogDensity: 0.008, mist: 0.2, rain: 0.62, snow: 0, wind: 6, gust: 3.5, thunder: 0.15, sunLight: 0.05 },
  storm: { cloudCover: 1, cloudDensity: 1, cirrus: 0, turbidity: 7, fogDensity: 0.012, mist: 0.2, rain: 1, snow: 0, wind: 12, gust: 9, thunder: 2.4, sunLight: 0.02 },
  snow: { cloudCover: 0.93, cloudDensity: 0.8, cirrus: 0.05, turbidity: 4.2, fogDensity: 0.007, mist: 0, rain: 0, snow: 0.55, wind: 2.4, gust: 1.4, thunder: 0, sunLight: 0.1 },
  blizzard: { cloudCover: 1, cloudDensity: 0.95, cirrus: 0, turbidity: 5.5, fogDensity: 0.03, mist: 0.3, rain: 0, snow: 1, wind: 15, gust: 10, thunder: 0, sunLight: 0.03 },
});

export const WEATHER_NAMES = Object.freeze(Object.keys(WEATHER_PRESETS));

/** A preset filled out with every channel, so a blend never reads undefined. */
export function weatherPreset(name) {
  const preset = WEATHER_PRESETS[name] ?? WEATHER_PRESETS.clear;
  return { ...CHANNELS, ...preset };
}

// ⚠ THE PRECISE FORM, not `a + (b - a) * t`. At t = 1 the naive lerp returns
// 0.9000000000000001 where the target said 0.9, so a finished transition never
// exactly equals the weather it arrived at — and every downstream equality
// ("are we still in the preset the user chose?") is then quietly false.
const lerp = (a, b, t) => (1 - t) * a + t * b;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Channel-wise blend. `t` is already eased by the caller. */
export function blendWeather(from, to, t) {
  const mix = clamp01(t);
  const out = {};
  for (const key of Object.keys(CHANNELS)) out[key] = lerp(from[key] ?? CHANNELS[key], to[key] ?? CHANNELS[key], mix);
  return out;
}

/**
 * ⚠ SCALING SEVERITY IS NOT SCALING EVERY CHANNEL TOWARDS ZERO. Turbidity's
 * zero is not "no weather" (it is an impossibly clear sky) and `sunLight`'s
 * is pitch black, so a naive multiply makes "rain at 20 %" darker than rain.
 * Intensity therefore blends towards CLEAR, which is what a weaker version of
 * any weather actually is.
 */
export function scaleWeather(weather, intensity) {
  return blendWeather(weatherPreset("clear"), weather, clamp01(intensity));
}

/** Deterministic PRNG — a scene must replay its weather exactly. */
export function makeRandom(seed = 1) {
  let a = (Math.imul(Math.round(Number(seed) || 1), 0x9e3779b9) >>> 0) || 0x6d2b79f5;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * How long each weather tends to last, in minutes of game time. A storm that
 * hangs around for two hours is a different game from one that passes in
 * fifteen minutes, and this is the only place that decides.
 */
const DWELL_MINUTES = {
  clear: 300, fair: 240, cloudy: 200, overcast: 260, fog: 120,
  drizzle: 100, rain: 150, storm: 50, snow: 200, blizzard: 80,
};

/**
 * Which weather can follow which, before the season has its say. Only
 * neighbours — the chain reaches a blizzard from a clear sky, but it has to
 * cloud over first, and that is what makes an unattended sky look plausible.
 */
const TRANSITIONS = {
  clear: { clear: 3, fair: 4, cloudy: 1, fog: 0.6 },
  fair: { clear: 3, fair: 2, cloudy: 3, drizzle: 0.5 },
  cloudy: { fair: 3, cloudy: 2, overcast: 3, drizzle: 1.5, rain: 0.8, snow: 0.8, fog: 0.5 },
  overcast: { cloudy: 3, overcast: 2, rain: 2.5, drizzle: 2, snow: 2, fog: 0.8, storm: 0.6 },
  fog: { fog: 2, overcast: 2, cloudy: 2, clear: 1.5 },
  drizzle: { drizzle: 1.5, rain: 2, overcast: 3, cloudy: 2, snow: 0.8 },
  rain: { rain: 2, storm: 1.2, drizzle: 2.5, overcast: 3, snow: 0.6 },
  storm: { storm: 1.5, rain: 4, overcast: 2 },
  snow: { snow: 2.5, blizzard: 0.8, overcast: 3, cloudy: 1.5, drizzle: 0.4 },
  blizzard: { blizzard: 1.5, snow: 4, overcast: 1.5 },
};

/** Frozen precipitation needs cold air; liquid needs air above it. */
const FREEZING = 1.5;

/**
 * The season's and the thermometer's veto over the raw transition weights.
 *
 * Kept as multipliers on the table above rather than as a second table per
 * season, because the interesting cases are the CONTINUOUS ones: sleet at
 * 1 °C, a thunderstorm that is merely unlikely in November rather than
 * impossible, a fog that only forms when the air is calm and near its dew
 * point. A per-season table cannot express any of those.
 */
export function transitionWeights(from, { temperature = 12, seasonPhase = 0.25, hour = 12 } = {}) {
  const base = TRANSITIONS[from] ?? TRANSITIONS.clear;
  // 0 at 3 °C and above, 1 at 0 °C and below.
  const frozen = clamp01((FREEZING + 1.5 - temperature) / 3);
  // Convection needs heat: thunder is a summer-afternoon animal.
  const summer = clamp01((temperature - 14) / 12);
  const afternoon = clamp01(1 - Math.abs(hour - 15) / 6);
  // Radiation fog forms overnight and burns off by mid-morning.
  const fogHours = clamp01(1 - Math.abs(((hour + 3) % 24) - 6) / 5);
  const weights = {};
  for (const [name, weight] of Object.entries(base)) {
    let w = weight;
    if (name === "snow" || name === "blizzard") w *= frozen;
    // Liquid precipitation is REMOVED below freezing, not merely discouraged:
    // the phase split downstream would turn it to snow anyway, and leaving a
    // 15 % chance of "rain" in a -8 °C forecast makes every reader of the
    // state — a script, a UI, a test — read the wrong word.
    if (name === "rain" || name === "drizzle") w *= 1 - frozen;
    if (name === "storm") w *= (0.25 + 1.75 * summer * (0.35 + 0.65 * afternoon)) * (1 - frozen);
    if (name === "fog") w *= 0.2 + 1.8 * fogHours;
    if (w > 0) weights[name] = w;
  }
  // A dead row (deep winter with only rain to move to) must still move.
  if (!Object.keys(weights).length) weights[from] = 1;
  return weights;
}

function pickWeighted(weights, random) {
  let total = 0;
  for (const w of Object.values(weights)) total += w;
  let roll = random() * total;
  for (const [name, w] of Object.entries(weights)) {
    roll -= w;
    if (roll <= 0) return name;
  }
  return Object.keys(weights)[0];
}

/**
 * One tick of the unattended sky.
 *
 * `state` is owned by the caller and mutated in place — this runs every frame
 * and allocating a state object per frame is exactly the kind of per-frame
 * garbage that shows up as a sawtooth in a profile.
 *
 * @param {object} state   { current, next, blend, dwell, elapsed, random }
 * @param {number} dtHours elapsed GAME time in hours, not seconds
 */
export function stepAutoWeather(state, dtHours, context = {}) {
  state.random ??= makeRandom(context.seed ?? 1);
  state.current ??= "fair";
  state.next ??= state.current;
  state.blend ??= 1;
  state.elapsed = (state.elapsed ?? 0) + Math.max(0, dtHours);
  // The dwell is drawn once per arrival, jittered ±50 %, so two scenes with
  // the same seed agree and one scene does not tick like a metronome.
  if (state.dwell == null) state.dwell = dwellHours(state.current, state.random);
  if (state.blend < 1) return state;
  if (state.elapsed < state.dwell) return state;
  const weights = transitionWeights(state.current, context);
  const chosen = pickWeighted(weights, state.random);
  state.elapsed = 0;
  state.dwell = dwellHours(chosen, state.random);
  if (chosen !== state.current) {
    state.previous = state.current;
    state.current = chosen;
    state.changed = true;
  }
  return state;
}

function dwellHours(name, random) {
  const minutes = DWELL_MINUTES[name] ?? 60;
  return (minutes * (0.5 + random())) / 60;
}

/**
 * ⭐ THE THERMOMETER DECIDES THE PHASE, THE WEATHER DECIDES THE AMOUNT.
 *
 * Mutates `weather` in place: the total precipitation stays exactly what the
 * preset asked for, and only its split between the two channels moves. A
 * "rain" preset at -6 °C therefore falls as snow, and at 1 °C it falls as
 * both — which is what sleet is, and which is why there is no `sleet` preset
 * and no winter twin of every rainy one.
 */
export function applyThermalPhase(weather, temperature) {
  const total = (weather.rain ?? 0) + (weather.snow ?? 0);
  const frozen = clamp01((FREEZING - temperature) / 3 + 0.5);
  weather.snow = total * frozen;
  weather.rain = total * (1 - frozen);
  return weather;
}

/**
 * Precipitation that has landed, as two slow accumulators.
 *
 * `wetness` is what a surface shader would darken and gloss with; `snowDepth`
 * is metres of settled snow. Both are integrators rather than copies of the
 * current rate, because the visible difference between "it rained" and "it is
 * raining" is entirely in how long the ground stays dark afterwards.
 *
 * Melting is driven by temperature, so a snow field that survives a cold
 * night and goes on surviving a cold day is the correct behaviour, not a
 * missing timer.
 */
export function stepAccumulation(accumulation, dtHours, { rain = 0, snow = 0, temperature = 12, sunLight = 1 } = {}) {
  const dt = Math.max(0, dtHours);
  const wet = accumulation.wetness ?? 0;
  const depth = accumulation.snowDepth ?? 0;
  // Wetting is fast (minutes), drying is slow and needs warmth and sun.
  const wetting = clamp01(rain + snow * 0.3) * dt * 12;
  const drying = dt * (0.25 + 0.09 * Math.max(0, temperature) * (0.3 + 0.7 * sunLight));
  accumulation.wetness = clamp01(wet + wetting - drying * clamp01(wet));
  // ⚠ COMPRESSED, DELIBERATELY. Real heavy snow settles ~5 cm/h, which means a
  // player would watch a white world arrive over an afternoon. At 0.35 m/h a
  // steady fall covers the ground in about fifteen game minutes, which is what
  // "it started snowing" has to look like in a game. Melting is compressed to
  // match, so a thaw is also something you can watch.
  const settling = snow * dt * 0.35;
  const melt = temperature > 0 ? dt * temperature * 0.05 * (0.4 + 0.6 * sunLight) : 0;
  accumulation.snowDepth = Math.max(0, Math.min(2, depth + settling - melt));
  return accumulation;
}
