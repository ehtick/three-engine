## STATUS 2026-08-03: Phase 1 SHIPPED, default fieldSmoothing=0.95

Field-side radiance EMA implemented in `createBounceFeedback`
(cascadeGather.js) exactly per Phase 1 below, wired through GISystem.js as a
live uniform (`__giFieldSmoothing`, default 0.95). User confirmed live in
their own editor session that 0.95 kills the object-motion flicker without
visible light-response lag — promoted to default immediately on that call,
superseding the "tune via instrument first" plan below.

Instrument built: `scripts/run-gi-flicker.mjs` (animates the scene's test
sphere, measures per-tile temporal *reversal count* on surrounding geometry —
raw stddev alone conflates real flicker with the mover's own smooth
brightness ramp, don't use stddev alone as the metric). Measured finding,
for the record: in that synthetic sphere test, fieldSmoothing's OWN
contribution was modest (~15-20% fewer reversals) next to probeSmoothing's —
the user's direct eye judgment at 0.95 overrides that synthetic result, but
it means the remaining flicker (if any resurfaces) likely lives in the
receiver-side visibility cuts (Phase 2 below), not the field feedback.
Not yet re-verified: sponza chroma/leak baselines (chroma ≈ 0.099, leak
1-2%) unchanged with the new default — worth a quick `run-gi-sponza.mjs`
pass next session before considering this fully closed.

# GI Object-Motion Flicker — Plan of Record (prepared 2026-08-03, for next session)

The user's requirement: **a real fix, not masking**. Smoothing-based masking is
explicitly rejected — it trades flicker for unacceptable light-response lag.

## What we know (measured / user-confirmed, 2026-08-03 session)

- **Freeze bisect (user-run):** with `__giFreeze = "field"` the flicker is
  *smaller but not gone* → the majority is born in the FIELD UPDATE (the
  bounce-feedback's per-cell direct light + bounce), a residual lives on the
  trace/gather side. Both pulse in lockstep with one root: a moving object
  re-voxelizes every frame and its **binary voxel footprint snaps in whole
  voxels** (0.12–0.16 m).
- **The field has NO temporal integrator.** `radianceBuffer` is rewritten from
  scratch every feedback pass; the probe EMA downstream is the *only*
  accumulator in the pipeline and it demonstrably cannot absorb field-scale
  churn (probeSmoothing high = slow light; low = flicker — the user's exact
  complaint).
- **Failed experiment — do not redo:** sub-voxel jitter of the voxelization
  grid (`__giVoxelJitter`) made flicker WORSE. The shift is global (every
  static surface's bits re-roll, not just the mover's) and nothing integrates
  the dither. Grid jitter is only viable AFTER the field has its own
  accumulator; even then it may be unnecessary.
- Already shipped this session (kept, they are correctness fixes, not masks):
  deterministic `cellAttr` attribution (atomicMax — last-write-wins re-rolled
  seam colours every re-voxelize), continuous probe burial (binary bit →
  free-radius ramp), adaptive probe hysteresis (`__giProbeSnap`), whole-volume
  composite on pyramid content arrival (the "dark until I move the model" bug).

## Phase 1 — FIELD-SIDE TEMPORAL ACCUMULATION (the bisect's majority arm)

Give the feedback pass an EMA **at the source**: blend each cell's freshly
computed direct+bounce against its previous value, so every binary flip
(shadow ray grazing a voxel edge, DDA hit appearing/disappearing) becomes an
integrable signal instead of a step the whole room inherits.

Implementation notes (createBounceFeedback, cascadeGather.js):

- `radianceBuffer[cell]` is read anyway is NOT true — the pass currently
  *assigns*. Read prev BEFORE the write (same thread, same cell — no race),
  then `final = mix(fresh, prev, fieldSmoothing)`.
- **Hard state changes must stay hard:**
  - the empty-clear (geometry disappeared → cell radiance must zero the SAME
    frame) stays unconditional — fading it is a light leak;
  - a cell whose `occupied` flag flips 0→1 takes `fresh` outright (no fade-in
    from black through half-lit);
  - the ingest of `staging`/base emissive stays as is.
- **Checker cadence interaction:** at low/medium a cell is rewritten every
  other frame; the EMA alpha applies per WRITE, so effective time constant
  doubles — either scale alpha by cadence or accept it (document which).
- **Zero-flicker-when-static rule (session 15c) must hold:** inputs are
  deterministic when nothing moves, so the EMA converges to a constant —
  verify bit-stability with smoothing off via the instrument below.
- Knob: `fieldSmoothing` live uniform, `__giFieldSmoothing`, DEFAULT 0 for
  the A/B, promoted to a tuned default only after the instrument + user eye
  agree. This is an accumulator at the source, not a mask: the probe EMA can
  then be RELAXED (faster light response) because its input is already smooth.
- Watch the 12-uniform / 10-storage walls: the feedback kernel is the
  >8-storage one already; this adds NO new buffers (in-place read of
  radianceBuffer).

## Phase 2 — GATHER RESIDUAL: per-probe depth moments (DDGI chebyshev)

Replace the binary-ish receiver-side cuts (distance proxy against a single
ray `w`, tight plane cut) with variance shadow-map style visibility:

- `c0.rays` already stores per-direction hit distance in `.w` — integrate
  mean depth and mean depth² per probe FACE alongside the existing ambient
  cube (createProbeIrradiance already loops those rays; the marginal cost is
  two MACs per ray).
- Storage: probeIrradiance is 6 vec4/probe (rgb + openness in w). Depth
  moments need 2 floats × 6 faces — either a second buffer (check the
  resolve's storage budget: it binds gather+emitters+lights and sits at the
  documented limits) or pack μ,σ² as two halves of one float each face
  (precision test needed).
- Gather: weight = chebyshev(μ, σ², |probe→P|) replacing the binary proxy;
  keep the plane cut only as the thin-wall backstop (it exists for a measured
  leak — see cascadeGather comments — do not delete without re-running the
  splitroom + sponza leak baselines).

## Phase 0 — INSTRUMENT FIRST (module hard rule; screenshots cannot see flicker)

`scripts/run-gi-flicker.mjs`, driving the REAL project via tauriShim
(clone run-gi-sponza's boot; its camera pose and saved-sun handling are
verified — see that file's comments for the four instrument traps):

- Fixed camera at the verified nave pose. Animate the test sphere
  (`entity.setTransform`, sinusoid along x, ~1 m amplitude, ~0.5 Hz) for N
  seconds; ALSO a static arm (no motion) for the bit-stability check.
- Capture ~30 consecutive `viewport.screenshot`s per arm at a fixed cadence.
- Metric: mean per-pixel temporal stddev over tiles that the sphere's screen
  path never covers (right half of the frame — the sphere moves in the left
  aisle; STATE THE GEOMETRY in the output). Report: static-arm stddev (must
  be ~0 with all smoothing off), moving-arm stddev (the flicker number).
- Baselines to record BEFORE any Phase 1 code: current defaults, and
  `probeSmoothing` 0.02 / 0.35 arms.
- Acceptance: moving-arm stddev drops materially (target: ≥3×) at a
  probeSmoothing LOW enough that light response is subjectively instant;
  static-arm stays bit-stable; sponza chroma/leak baselines unchanged
  (chroma ≈ 0.099, leak 1–2%).

## Order of work next session

1. Phase 0 instrument + record baselines (no engine edits before baselines).
2. Phase 1 field EMA behind `__giFieldSmoothing`, A/B with the instrument,
   then tune + promote defaults and RELAX probeSmoothing accordingly.
3. Phase 2 only if the moving-arm residual is still visible after Phase 1 —
   it is the bigger surgery and the bisect says it is the minority share.
