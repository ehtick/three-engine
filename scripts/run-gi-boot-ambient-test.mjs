// GI BOOT AMBIENT — the lifecycle test for src/modules/gi/bootAmbient.js.
//
// This exists because of a bug that had no way to announce itself. The cold-boot
// placeholder hemisphere faded only when `state.statsLogged` flipped, and
// `statsLogged` is the latch for the occupancy STATS LOG, not a rendering
// signal — #maybeLogStats bails unless the entry list is non-empty AND every
// entry is resident in the atlas. A scene that composited GI perfectly but
// tripped either condition kept a 0.6 blue-grey hemisphere over it forever, and
// since the light is a raw three.js object rather than an entity it had no
// outliner row, no Inspector control and no log line. It was reported as "there
// is some weird ambient to the GI ... yet scene does not have any ambient".
//
// So the property under test is not "the fade math is right". It is:
//
//     THE LIGHT ALWAYS LEAVES.
//
// Case (D) is the regression test proper: it drives a field that NEVER
// composites, for longer than the cap, and requires release. Under the old
// single-gate design that case runs forever. Case (H) generalises it — an
// exhaustive sweep over every combination of the boolean inputs, each run past
// the cap, asserting none of them can hold a light indefinitely.

import {
  GI_BOOT_AMBIENT_CUTOFF,
  GI_BOOT_AMBIENT_FADE,
  GI_BOOT_AMBIENT_INTENSITY,
  GI_BOOT_AMBIENT_MAX_TICKS,
  bootAmbientStep,
} from "../src/modules/gi/bootAmbient.js";

let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

/**
 * Drives the state machine the way GISystem#update does, so the test exercises
 * the same feedback loop rather than a hand-fed sequence: the light's existence
 * and intensity come back from the previous step, not from the scenario.
 *
 * @param {object} scenario
 * @param {number} maxTicks how long to run before giving up
 * @returns {{releasedAt: number|null, ticksHeld: number, peak: number,
 *            everCreated: boolean, expiredAt: number|null}}
 */
function run(scenario, maxTicks = GI_BOOT_AMBIENT_MAX_TICKS + 200) {
  let hasLight = false;
  let everComposited = false;
  let intensity = 0;
  let ticks = 0;
  let releasedAt = null;
  let expiredAt = null;
  let everCreated = false;
  let peak = 0;
  let held = 0;

  for (let t = 0; t < maxTicks; t++) {
    const step = bootAmbientStep({
      enabled: scenario.enabled(t),
      hasState: scenario.hasState(t),
      hasLight,
      composited: scenario.composited(t),
      everComposited,
      ticks,
      intensity,
    });
    if (step.action === "create") {
      hasLight = true;
      everCreated = true;
    }
    if (step.action !== "none") {
      ticks = step.ticks;
      intensity = step.intensity;
      peak = Math.max(peak, intensity);
    }
    if (hasLight) held++;
    if (step.expired && expiredAt === null) expiredAt = t;
    if (step.action === "release") {
      hasLight = false;
      everComposited = true;
      if (releasedAt === null) releasedAt = t;
    }
  }
  return { releasedAt, ticksHeld: held, peak, everCreated, expiredAt };
}

const always = (v) => () => v;
const after = (n) => (t) => t >= n;

console.log("gi-boot-ambient:");

// (A) THE DEFAULT. The prop ships off, and off must mean no light ever touches
// the scene — this is the whole point of the default flip.
{
  const r = run({ enabled: always(false), hasState: always(false), composited: always(false) });
  check(
    "default off never creates a light",
    !r.everCreated && r.ticksHeld === 0,
    `created=${r.everCreated} held=${r.ticksHeld}`,
  );
}

// (B) THE NORMAL PATH. Enabled, GI builds and composites — the light must
// appear and then be gone shortly after.
{
  const composite = 50;
  const r = run({
    enabled: always(true),
    hasState: after(composite),
    composited: after(composite),
  });
  check("enabled + composite creates a light", r.everCreated && r.peak === GI_BOOT_AMBIENT_INTENSITY,
    `peak=${r.peak}`);
  check(
    "released promptly after the composite",
    r.releasedAt !== null && r.releasedAt - composite < 60,
    `composited at ${composite}, released at ${r.releasedAt}`,
  );
  // ~39 ticks of ×0.9 from 0.6 to below 0.01 — assert the fade is a fade and
  // not a snap, since the snap is what the recompile-wave note forbids.
  const expected = Math.ceil(
    Math.log(GI_BOOT_AMBIENT_CUTOFF / GI_BOOT_AMBIENT_INTENSITY) / Math.log(GI_BOOT_AMBIENT_FADE),
  );
  check(
    "the fade is gradual, not a snap",
    r.releasedAt !== null && Math.abs((r.releasedAt - composite) - expected) <= 2,
    `took ${r.releasedAt === null ? "never" : r.releasedAt - composite}, analytic ${expected}`,
  );
}

// (C) THE LIVE KILL SWITCH. Unticking the Inspector box must drop the light
// even though GI has not composited — otherwise "turn it off" queues behind
// the very event that may never arrive.
{
  const off = 100;
  const r = run({
    enabled: (t) => t < off,
    hasState: always(false),
    composited: always(false),
  });
  check(
    "unticking the prop releases without a composite",
    r.releasedAt !== null && r.releasedAt < off + 60,
    `released at ${r.releasedAt}`,
  );
}

// (D) THE REGRESSION. The reported bug, reproduced as its own case: GI never
// composites — an empty entry list, an atlas entry that never becomes resident,
// a build that never lands. The old design holds the light forever here.
// The ordering matters: the light can only be created while there is no state,
// so the scenario has to boot cold (state arrives at 50) and then simply never
// reach a composite. That is precisely the reported shape.
{
  const r = run({
    enabled: always(true),
    hasState: after(50),
    composited: always(false),
  });
  check(
    "a field that NEVER composites still releases the light",
    r.everCreated && r.releasedAt !== null,
    r.everCreated ? "held indefinitely — this is the reported bug" : "scenario never created a light",
  );
  check(
    "and it releases via the tick cap",
    r.expiredAt !== null && r.releasedAt !== null && r.releasedAt > GI_BOOT_AMBIENT_MAX_TICKS,
    `expired at ${r.expiredAt}, released at ${r.releasedAt}, cap ${GI_BOOT_AMBIENT_MAX_TICKS}`,
  );
}

// (E) NO SECOND FLASH. A rebuild must not put a hemisphere back over an
// already-lit scene: `everComposited` latches and the create branch is
// cold-boot only.
{
  const r = run(
    {
      enabled: always(true),
      // state drops away again (a rebuild), which would re-satisfy `!hasState`
      hasState: (t) => t >= 50 && t < 400,
      composited: (t) => t >= 50 && t < 400,
    },
    900,
  );
  const second = run(
    { enabled: always(true), hasState: always(false), composited: always(false) },
    5,
  );
  check("a rebuild does not create a second light", r.peak === GI_BOOT_AMBIENT_INTENSITY, `peak=${r.peak}`);
  check(
    "everComposited latches the create branch shut",
    bootAmbientStep({
      enabled: true, hasState: false, hasLight: false,
      composited: false, everComposited: true, ticks: 0, intensity: 0,
    }).action === "none" && second.everCreated,
    "a fresh boot must still create one",
  );
}

// (F) THE CREATE PRECONDITION. Once GI has state there is no cold boot to
// cover, so a late attach must not flash a light.
{
  const r = run({ enabled: always(true), hasState: always(true), composited: always(false) }, 5);
  check("no light is created once GI already has state", !r.everCreated);
}

// (G) MONOTONIC. Intensity must never rise once the fade starts — a re-brighten
// would read as a flicker over the scene.
{
  let hasLight = false; let everComposited = false;
  let intensity = 0; let ticks = 0; let prev = Infinity; let rose = false;
  for (let t = 0; t < 400; t++) {
    const step = bootAmbientStep({
      enabled: true, hasState: t >= 30, hasLight,
      composited: t >= 30, everComposited, ticks, intensity,
    });
    if (step.action === "create") hasLight = true;
    if (step.action !== "none") { ticks = step.ticks; intensity = step.intensity; }
    if (hasLight && intensity > prev + 1e-12) rose = true;
    if (hasLight) prev = intensity;
    if (step.action === "release") { hasLight = false; everComposited = true; }
  }
  check("intensity never rises once fading", !rose);
}

// (H) EXHAUSTIVE. The property, over every combination of the boolean inputs
// held constant past the cap. This is the one that would have caught the
// original bug without anyone having to guess which predicate was wrong.
// Each input gets THREE trajectories, not two: constant-false, constant-true,
// and arrives-at-50. The arrives-later ones are the load-bearing additions —
// a sweep over constant booleans alone is half vacuous, because the create
// branch needs `!hasState` and so no `hasState: true` row can ever produce a
// light to get stuck. That vacuity is what let case (D) pass a first draft of
// this test while reproducing nothing.
{
  const TRAJECTORIES = { off: always(false), on: always(true), late: after(50) };
  const stuck = [];
  let created = 0;
  for (const [en, enabled] of Object.entries(TRAJECTORIES)) {
    for (const [hs, hasState] of Object.entries(TRAJECTORIES)) {
      for (const [co, composited] of Object.entries(TRAJECTORIES)) {
        const r = run({ enabled, hasState, composited });
        if (r.everCreated) created++;
        // Never created is fine; created-and-never-released is the failure.
        if (r.everCreated && r.releasedAt === null) {
          stuck.push(`enabled=${en} hasState=${hs} composited=${co}`);
        }
      }
    }
  }
  check(
    "no input trajectory can hold the light past the cap",
    stuck.length === 0,
    stuck.join("; "),
  );
  // Guard against the sweep silently going vacuous again if the create
  // precondition is ever tightened.
  check("the sweep actually creates lights to get stuck", created >= 9, `only ${created}/27 created one`);
}

if (failures) {
  console.error(`gi-boot-ambient: ${failures} case(s) FAILED`);
  process.exit(1);
}
console.log("gi-boot-ambient: all cases PASS");
