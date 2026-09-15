// @ts-check
/**
 * ⭐ WHEN THE SKY'S PREFILTERED ENVIRONMENT (PMREM) IS REBUILT — the pure half.
 *
 * A rebuild is eight nested `renderer.render` calls inside the frame that asks
 * for it (see `AtmosphereComponent._publishSky`), so it used to be paced by a
 * wall clock alone: every 1.2 s while ANY dome refresh landed. The dome refresh
 * thresholds are sized for the background the eye looks straight at (1.5° of
 * sun, 1.2 % of colour); image-based lighting is a blurred integral of that
 * dome and cannot show changes that small. So the IBL is compared against the
 * sky it was LAST BUILT FROM, and rebuilt only when:
 *
 *   - the change since then is perceptual for lighting (`SIGNIFICANT`), or
 *   - a smaller but real change has STOPPED (the clock is not running and no
 *     new dome has been published for `SETTLE_SECONDS`) — a finished weather
 *     transition or a released time-of-day scrub still lands exactly;
 *
 * and never more often than `MIN_SECONDS`. An unchanged sky (a paused clock, a
 * refill after re-enable, an unrelated prop edit) rebuilds nothing.
 *
 * This decides only WHEN; how the PMREM is produced is untouched.
 */

/** Floor between two rebuilds, seconds. */
export const SKY_PMREM_MIN_SECONDS = 1.2;
/** Quiet time after the last dome publish before a small change is flushed. */
export const SKY_PMREM_SETTLE_SECONDS = 1.2;
/** Radians of sun (or moon) travel that is visible in lighting: 3°. */
export const SKY_PMREM_SUN_EPSILON = 0.052;
/** Mean relative change of irradiance / horizon / cloud light: 3 %. */
export const SKY_PMREM_COLOUR_EPSILON = 0.03;
/** Summed change of the atmospheric scalars (coverage, density, …). */
export const SKY_PMREM_WEATHER_EPSILON = 0.02;
/** Below this on every channel two skies are the same sky. */
const IDENTICAL = 1e-6;

/**
 * @typedef {{
 *   sun: number[], moon: number[], irradiance: number[], horizon: number[],
 *   cloudLight: number[], scalars: number[],
 * }} SkySnapshot
 */

/**
 * Everything `fillSkyEquirect` paints from, reduced to what can change the
 * picture. Copies, so a later frame mutating `parameters` cannot alias it.
 * @param {any} p `skyParameters` output after `measureSky`
 * @returns {SkySnapshot}
 */
export function skySnapshot(p) {
  const three = (v) => [Number(v?.[0]) || 0, Number(v?.[1]) || 0, Number(v?.[2]) || 0];
  return {
    sun: three(p.sunDirection),
    moon: three(p.moonDirection),
    irradiance: three(p.irradiance),
    horizon: three(p.horizon),
    cloudLight: three(p.cloudLight),
    // Turbidity runs 1.8…12, so a tenth of it weighs like the 0…1 channels.
    scalars: [
      (Number(p.turbidity) || 0) / 10, Number(p.coverage) || 0, Number(p.density) || 0,
      Number(p.nightLight) || 0, Number(p.intensity) || 0, Number(p.moonTerm) || 0,
    ],
  };
}

const angle = (a, b) => {
  const la = Math.hypot(a[0], a[1], a[2]) || 1;
  const lb = Math.hypot(b[0], b[1], b[2]) || 1;
  const cos = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (la * lb);
  return Math.acos(Math.min(1, Math.max(-1, cos)));
};

/**
 * How far `current` has moved from `baseline`, per perceptual channel.
 * @param {SkySnapshot} baseline
 * @param {SkySnapshot} current
 */
export function skyEnvironmentChange(baseline, current) {
  let colour = 0;
  for (const key of /** @type {const} */ (["irradiance", "horizon", "cloudLight"])) {
    for (let c = 0; c < 3; c++) {
      colour += Math.abs(current[key][c] - baseline[key][c]) / Math.max(0.02, Math.abs(baseline[key][c]));
    }
  }
  let weather = 0;
  for (let i = 0; i < current.scalars.length; i++) weather += Math.abs(current.scalars[i] - baseline.scalars[i]);
  return {
    sun: angle(baseline.sun, current.sun),
    moon: angle(baseline.moon, current.moon),
    colour: colour / 9,
    weather,
  };
}

/**
 * Whether the PMREM should be rebuilt now from the published sky.
 * @param {{
 *   baseline: SkySnapshot | null,   // the sky the current PMREM was built from
 *   current: SkySnapshot | null,    // the sky the texture holds now
 *   secondsSincePmrem: number,
 *   secondsSincePublish: number,
 *   clockRunning: boolean,
 * }} state
 */
export function skyPmremDue({ baseline, current, secondsSincePmrem, secondsSincePublish, clockRunning }) {
  if (!current) return false;
  if (!baseline) return true;                                  // the first sky
  if (!(secondsSincePmrem >= SKY_PMREM_MIN_SECONDS)) return false;
  const change = skyEnvironmentChange(baseline, current);
  if (change.sun <= IDENTICAL && change.moon <= IDENTICAL && change.colour <= IDENTICAL && change.weather <= IDENTICAL) {
    return false;
  }
  if (change.sun > SKY_PMREM_SUN_EPSILON || change.moon > SKY_PMREM_SUN_EPSILON
    || change.colour > SKY_PMREM_COLOUR_EPSILON || change.weather > SKY_PMREM_WEATHER_EPSILON) {
    return true;
  }
  // Small and real: flush once it has stopped moving. A running clock never
  // stops, and its residual reaches SIGNIFICANT on its own.
  return !clockRunning && secondsSincePublish >= SKY_PMREM_SETTLE_SECONDS;
}
