# GI Shadows — Review and the Analytic-Width Plan

*2026-08-06 FOURTH PASS — ⚠️ THE EXHAUSTION DISCOVERY (read before any further shadow work): the
verdict-kind map shows ⅓ of all direct-shadow rays fail-closed on BUDGET EXHAUSTION at
t ≈ 0.3m, angle-independently, in a trivial one-wall scene — most of the visible umbra, a bogus
blocker distance (which is what defeated the wide-pass radius), and the per-emissive fps cliff
are all this one defect. Finding why `traceHybridPlane` burns 160 macro steps within ~3 voxels
of the origin is the top-priority next investigation. Shipped meanwhile: the direct arm gets the
same exhaustion→width-probe fallback as the emitter arm (degrades to "approximately right",
never black — which also makes budget cuts safe), emitter march tier halved (48-96) + emitter
pass at half the shadow pixel budget (~4× emitter cost cut vs. the morning's split), and the
`__giWideRadiusDebug` factor-paint ladder. The 90° Blender-parity verdict still needs a
crate-scale rig + Blender reference (§9's SSIM bar) — the 5m-wall probe rig is legitimately
dark at 90°.*

*2026-08-06 THIRD PASS (user verdict on the emitter fix: "much better" — remaining: tiny leaks,
per-emitter cost scaling, blocky low presets, and a hard edge inside large-sourceAngle penumbras):*

- ***EMITTER SHADOW PASS SPLIT** — the emitter traces left the resolve kernel for their own
  compute at the shadow-channel pixel budget (the direct arm's 22→5.4ms move): shared estimator
  `emitterSlotShadow` (giLight), raw target + the SAME edge-aware bilateral the direct channel
  has (the emitter channel had NO spatial filter before — probe grain 0.066 → 0.020), texture
  now at shadow res (materials sample by UV; finally matches `giScreenTexel`). Cost is bounded
  by 4 slots × the shadow budget instead of × the resolve's 1.6M. Resolve + hit-shading sample
  the filtered texture; the bvh hit path still traces inline (different world point).*
- ***PCSS DISC DEFAULT-ON*** (`__giPcssDisc = false` to disable): the min-ratio width only
  softens the MISS side — the central-ray hit boundary stayed binary, the user's "hard edge
  inside the smoothed penumbra" at sourceAngle ~30°. The disc reconstructs width symmetrically
  from blocker distance; its historic rejection was the stochastic input's boiling, which is
  gone.*
- ***WIDE-PENUMBRA PASS*** (`createGiLightShadowWidePass`, `__giShadowWidePass = false` to
  disable) after the user re-reported the hard edge at 90°: the material disc's radius is
  capped at 24 half-res texels while a 90° sun wants 3-4× that, and more material taps cost
  every lit pixel. The wide blur now happens ONCE in the shadow channel (analytic+PCSS chain:
  trace → raw → bilateral → MID → wide → lightShadow): per-pixel radius = tan(half-angle) ×
  blocker distance (4-tap max search extends it past the silhouette), 16-tap IGN-rotated
  golden spiral, per-channel radii off one spiral, receiver-plane validity, cap
  RESOLUTION-PROPORTIONAL at 10% of frame height (a fixed texel cap shrinks proportionally
  on real scenes — exactly why the first fix didn't read at 90°). Probe-measured: edge
  transition tracks the cap; sub-texel radii keep 0° bit-exact. Point lights still radius 0
  (per-pixel angular size — open).*
- *Leak guard: `run-gi-emitter-shadow-probe` gained a SLAB arm (thin 0.08m wall, projected-strip
  metric) — record arm reads 0.2893 vs sphere arm 0.2895 (equal = no new thin-wall leak class;
  the number itself is legitimate penumbra in the strip). The user's "tiny leaks" specks remain
  open — need their scene.*

*2026-08-06 LATER THE SAME DAY: **ANALYTIC-WIDTH IS NOW THE DEFAULT** (user call after eyeballing
the direct arm live: "those look awesome"). `__giShadowAnalyticWidth = false` restores the
stochastic sun-disc + temporal arm (it remains the reference instrument). Also shipped on top of
v1:*

- *Optimizations: the width probe runs LAZILY (umbra pixels — central-ray hits — skip all 12
  taps), and the temporal trio (`lightShadowAccum`/`Hist`/`HistPos`, ~22MB with the rgba32float
  history position) is created on demand only when a stochastic build asks
  (`targets.ensureShadowTemporal()`), so the default footprint drops by ~22MB — the §5 number.*
- ***EMITTER SHADOWS UNIFIED (§6, the "wonky emissive" report)**: the RESOLVE-side emitter shadow
  now runs record-march admission × near pen × the width probe (`#buildEmitterRecordTrace`,
  resolve-only — the in-material fallback keeps the sphere arm so the bits buffer never enters
  fragment shaders; `__giEmitterRecordShadows = false` restores the sphere arm). Three
  emitter-specific ingredients, each probe-measured on the new
  `scripts/run-gi-emitter-shadow-probe.mjs` rig (panel + crate + big floor): (1) LAMP EXCLUSION —
  the probe's tap range pulls back by maxT/k (the lamp's own effective radius; its D-footprint
  darkened EVERY ray's last taps to near-black — the floor-wide waffle); (2) own-plane
  PROPORTIONAL gate `d < 0.6·planeHeight` + planeCut 3.5 voxels (hugging rays live inside D's
  ~25-30% undershoot band forever); (3) EXHAUSTION (verdict kind 4) falls back to the probe's
  verdict instead of fail-closed black (grazing emitter rays are the common case, not the
  pathological one). Field-side emitter block (cascadeGather) still sphere-stable — open.*
- *Diagnostic instruments added: `__giEmitterShadowKindDebug` (verdict-kind map for the emitter
  channel) and `__giWidthProbeDebugTap` (argmin-tap map — locates WHERE along rays a darkening
  lives; this is what convicted the lamp-proximal taps after two plausible-but-wrong fixes moved
  nothing).*

*Earlier same day. Status: **§5 v1 IMPLEMENTED behind `__giShadowAnalyticWidth`** (build-time hatch;
stochastic path stays the default until measured against the full §9 bars). What shipped:*

- *`createWidthProbeFn` (giField.js) — the §5 mid term: min over 12 log-spaced trilinear
  `distanceTexture` taps of `k·D/t`, width-only (capCut saturation + the createShadowTrace-family
  own-plane test sized off the occupancy voxel). Exposed as `volume.createWidthProbe()`;
  `__giShadowWidthTaps` overrides the count.*
- *Screen arm (GISystem `#buildLightShadow` + giScreen): central ray (disc jitter skipped), the
  probe multiplied into both marcher arms' `hit×pen`, `cosRayNormal` threaded through, angle cap
  0.35 → 0.78 under the hatch. Temporal machinery skipped at build: no frame/prevVP/weight
  uniforms, no history/accum/post passes — trace → ONE 21-tap bilateral → `lightShadow`.
  Resize path derives the topology from the history pass's existence so it can't flip arms.*
- *Field arm (§6): the same probe multiplies the feedback `lightShadow` closure's verdict
  (distanceTexture was already bound there — zero new bindings).*
- *Harness arms: gpu-smoke `&analytic=1` (marcher string, width-probe WGSL compile gate, no
  temporal passes, still exactly 8 storage bindings — PASS, 11 kernels vs 13) and
  `run-gi-shadow-motion` `ARM=analytic`.*

*Measured (2026-08-06, splitroom-style wall rig, sourceAngle 12°, high): analytic raw is
EXACTLY deterministic (2 consecutive grabs differ by 0.000000 vs the stochastic arm's animated
dither at max 0.59) with a real, narrower, harder-edged penumbra — the predicted min-ratio
half-width trade. Instrument caveat: `run-gi-shadow-motion`'s grain number is dominated by a
PRE-EXISTING voxel-lattice etching present in BOTH arms' raw (0.602 both, PNG-verified —
`scripts/gi-diag-shadow-{analytic,stochastic}-{raw,final}.png`); the temporal chain's three
smoothing stages blur it more (final 0.019) than the single retained bilateral (0.040), which is
the §9.5 banding class, not estimator noise. Remaining §9 items are OPEN: Blender A/B at
5/20/45/90°, splitroom leak rows under the hatch, cost timestamps, point-light eyeball —
plus the lattice-etching hunt (shared with the stochastic arm) before default flip.*

*Original review (unchanged below). Written after a full read of the
shadow path (giScreen.js, GISystem.js traceDda closure, occupancyField.js trace/oracle machinery,
giField.js createShadowTrace, cascadeGather feedback) against the user's brief: "grainy and not
good with moving lights; we want smooth GI shadows from emissive, indirect, and direct light at
interactive framerate."*

---

## 1. Where every shadow comes from today

The module runs **three different occlusion estimators**, and their smoothness under motion
divides exactly along one line — whether the per-frame estimate is deterministic:

| Light class | Estimator | Deterministic? | Smooth under motion? |
|---|---|---|---|
| **Indirect / bounce** | Cascade interval traces + merge visibility + gather cuts, EMA'd in world space (`fieldSmoothing` 0.95, `probeNoiseAlpha` 0.25) | yes (per frame) | yes — world-anchored, interpolated |
| **Emissive (4 emitter slots)** | Analytic sphere-trace `min(k·d/t)` with closest-approach interpolation over the composited `distanceTexture` (`createShadowTrace`, giField.js:737) | **yes** | **yes — no filter, no history, no temporal anything** |
| **Direct (4 gi-light slots)** | **1-spp stochastic sun-disc jitter** over the record march / DDA (`traceDda`, GISystem.js:1890), then a 5-stage repair chain | **no** | **no — the user's complaint** |

The repair chain behind the direct path, per frame (queue order GISystem.js:3348-3377):

1. trace → `lightShadowRaw` (one jittered disc direction per pixel, animated IGN)
2. 21-tap plane-aware cross-bilateral **+ reprojected temporal EMA** (velocity-scaled weight
   0.86–0.94, 3×3 silhouette rescue) → `lightShadowAccum`
3. history copy pass → `lightShadowHist` + `lightShadowHistPos` (rgba32float)
4. a second, history-free 21-tap bilateral → `lightShadow` (presentation filter)
5. material side: 4-tap position-validated bilateral upsample, optional 12-tap IGN-rotated
   PCSS disc driven by the trace's blocker distance

Three compute passes, five shadow-side targets (~29 MB at the 900k budget, the float32 history
position alone is 14.4 MB), and a material-side disc — all downstream of a coin flip.

## 2. Why it is grainy under moving lights — structural, not a tuning miss

A 1-spp binary visibility sample has variance `p(1−p)` — maximal mid-penumbra, where every pixel
is literally a coin flip. Converting that ensemble into a smooth penumbra requires averaging:
spatially (21 taps ≈ too few for wide penumbras, and blotches at kernel scale — session 27 part 2c
found exactly this) or temporally. Temporal averaging and instant response to a moving light are
**mutually exclusive by construction**: the velocity-scaled memory (6f64dbf) is the honest
endpoint of that tradeoff — ~32 effective sun samples when static, **~7 when the sun drags**, and
√7 ≈ 2.6× the noise σ of the static case is exactly the "still grainy under motion" verdict.

The design bar set in session 27 part 2d — *every shadow-quality feature is judged under
continuous light motion first* — cannot be met by ANY accumulation-based scheme. Three successive
rounds of denoiser surgery (fdbdb21 → 0879d67 → 3a909a3 → 6f64dbf) each improved constants and
each ended with "still grainy/dirty"; that is empirical confirmation, not bad luck. An SVGF-class
denoiser would improve constants again and fail the same bar the same way.

Secondary structural costs of the stochastic design:

- **Wall leaks**: the jittered disc rays wander sideways into the origin dead zone
  (1.5-voxel normal lift + 1-voxel tMin + ~2-voxel penumbra gate; RayHitConfig.js:61-66 records
  the box-arm variant of exactly this). A deterministic central ray does not wander.
- **Complexity tax**: the temporal machinery exists only to repair the estimator — reprojection
  row conventions, history races, rescue rings, light-motion hashes, four instrument traps
  (session 27 part 2's hour of false diagnosis).
- **No half-rate lever**: an unconverged signal cannot be run at half rate and interpolated;
  a converged one can.

## 3. The decisive code fact: the analytic penumbra already half-exists

Both marchers already return `hit × pen` where `pen` is an **analytic cone term**:

- `traceOccupancy` (occupancyField.js:1801-1811): `pen = min over steps of k·freeRadius(mid)/t`
  — but the oracle is called with `maxLevel 0`, i.e. the 3×3×3 near field only. **Usable reach
  ≈ 1.5 voxels (~0.18 m at ultra).**
- `traceHybridPlane` (occupancyField.js:2954-3003): `pen = min over rejected record planes of
  k·d_perp/t` — continuous, sub-voxel, geometry-true… but a plane is only tested when the ray
  **enters that occupied cell**. An occluder the ray passes 30 cm away from contributes nothing.

So the analytic term can only see geometry within ~1–2 voxels of the ray. With `k = 1/angle`,
`pen` saturates to 1 whenever `t > k·d_max ≈ 3·0.18/0.35 ≈ 0.5–1.5 m`. **Penumbras wider than a
couple of voxels are unrepresentable analytically today** — that reach starvation is the entire
reason the stochastic sun-disc arm exists. The grain is the shadow of a missing mid-range
distance oracle.

## 4. Why the two previous analytic arms failed (recorded, do not re-propose as-is)

- **Density cone** (`traceOccupancyCone`, hatched behind `__giConeShadowDensity`): treats the
  density pyramid's *fraction of set voxels* as opacity. Congenital diseases per the user's 15°
  screenshots (GISystem.js:1902-1919): a thin solid roof in a coarse cell reads density ~1/8 →
  dappled **light leaks**; dense clusters + the fail-dark clamp → **collapse to black**; boost
  trades one for the other. Root cause: **density is not opacity** — admission decided from an
  aggregate is wrong for hard geometry in both directions.
- **Sphere/SDF arm** (session 24): binary occluder **admission** against a ~12 cm voxel medium
  flips with lattice phase → white-speckle silhouette dithering that no k smooths
  ("k-insensitive artifacts are admission artifacts", GISystem.js:2027-2034).

Both failures are **admission** failures — *what counts as an occluder* decided from coarse or
aggregate data. Neither is a failure of *analytic width* — using a continuous distance to size
the penumbra of an occluder that exact geometry already admitted. The record march (sessions
23-26) now provides exactly that exact admission: fitted planes, coverage masks, exact triangles,
dynamic refit for movers, silhouette fattening 486→0. The ingredient that was missing in
session 24 exists now.

## 5. The recommendation: deterministic analytic-width shadows

One estimator, three sources of information, zero randomness:

```
visibility(ray) =
    hard:   record march admission (unchanged — planes, coverage, exact triangles,
            fail-closed clamp, origin-plane exclusion, burial gate)
  × near:   min over rejected record planes of  k · d_perp / t        (unchanged)
  × mid:    min over ~8–12 stratified t_i of    k · D(o + dir·t_i) / t_i   ← THE NEW TERM
```

Where `D` is the **composited `distanceTexture`** (giField.js — Storage3DTexture rgba8,
`r = distance/capWorld`, hardware-trilinear, already rebuilt per composite from the occupancy
oracle + analytic slot shapes, already survives on the web path since it needs no bake):

- It is **continuous** (trilinear) — the property the quantized far-field free-radius ladder
  lacks, and the reason stable mode refuses that ladder today.
- It is used **only for width, never admission** — a melty or coarse `D` softens a penumbra by a
  few percent; it can never leak (admission stays with records) and never blacken (min-ratio ≥ 0
  saturates lit, and the record march still owns the umbra).
- Reach: `capWorld = 16 field cells ≈ 5–6 m` — penumbras up to metres wide become representable;
  beyond the cap the estimator degrades to a slightly-hard edge instead of noise.
- Sampling: fixed log-spaced `t_i` in `[penumbraGate, maxT]`, ~12 trilinear taps — negligible
  next to the 96–192-macro-step march, and independent of DDA internals (no coupling to the
  coarse ride; a march-coupled variant is a later optimization, not the v1).

Because every term is deterministic, **each frame is already the converged answer**. What that
deletes from the critical path:

- the sun-disc jitter (both IGN channels, the animated phase, the golden-ratio walk)
- the temporal accumulation: history pass, `lightShadowAccum`/`Hist`/`HistPos` targets
  (~22 MB back), the velocity-scaled memory, the light-motion hash, the reprojection + rescue
  machinery and its four instrument traps
- one of the two 21-tap bilateral instances (keep exactly one as banding insurance —
  rgba8 quantization of `D` and record-plane seams are the residual risks)

What it keeps: the record march and all its session-23-26 correctness, the burial gate, the
fail-closed clamp, blocker-distance output, the material-side position-validated upsample, and
the PCSS disc — which becomes **default-on candidate** once its input stops boiling (it is
deterministic width-from-blocker-distance, i.e. philosophically the same move at the sampling
end, and its off-by-default status was about artifacts of the noisy input).

Moving lights under this design: the shadow tracks the light **exactly, every frame, at full
sharpness** — the failure mode "grainy while moving, converges on release" ceases to exist
because there is no convergence process. This is the same reason Unreal's distance-field shadows
are famously stable under a dragged sun: min-ratio cone over a continuous distance, no temporal
state. Ours substitutes records for the near field (they are *more* exact than a true SDF there)
and the composited field for the mid field.

### Angle range

The current `angle` clamp `[0.0005, 0.35]` caps the analytic k; with real mid-field width the
top clamp should lift toward the true half-angle (the 0.35 cap partly existed because the
starved estimator made wide k meaningless — the "90° looks like 20°" bug class). At extreme
sourceAngle (→90°) a single-ray min-ratio degrades gracefully to "openness along the light
axis", which is perceptually right for a half-sky source; the PCSS disc supplies the visual
width on top. The bar is the Blender A/B at 5°/20°/45°/90° (the session-27 PCSS bar).

### Point lights for free

`k = dist/srcRadius` per pixel is already plumbed (slot `srcRadius`). The analytic estimator
needs nothing else — point/spot soft shadows (an open item since session 24) fall out of the
same change, with no per-light disc frame to build.

## 6. Unification — the actual ask ("emissive, indirect, and direct")

This proposal makes the module converge on **one estimator family** instead of three:

- **Direct, screen**: the analytic-width march above.
- **Direct, in-field** (bounce feedback, cascadeGather.js:957-1049): the same closure family —
  today it runs `traceOccupancy hit×pen` with the same starved reach, so wide-sun BOUNCE shadows
  dither too. Swapping the same estimator in fixes field-side direct occlusion in the same
  motion-stable way. (It already runs per-cell per-frame; cost unchanged.)
- **Emissive**: already analytic over `distanceTexture` + record-aware near field — i.e. already
  this architecture. Longer term the emitter arm and the light arm become one `sharedFn` (the
  emitter keeps its OBB self-exclusion); no user-visible change expected.
- **Indirect**: cascades + probe/field EMAs are already the right answer (world-anchored
  accumulation is motion-stable — camera motion measured innocent in session 22). Contact-scale
  indirect occlusion is the AO oracle's job (fixed in session 27; default-off is a look choice).
  Sharper indirect shadows would be a field-resolution knob, not new machinery.

## 7. Follow-ups this unlocks (separate, measurable, not part of v1)

- **Lift/tMin shrink** (open item): a deterministic central ray cannot wander into the origin
  dead zone, and the record-aware origin distance can replace part of the fixed 1.5-voxel lift.
  Attack with the `__giShadowLift` A/B after v1 lands.
- **Half-rate shadows**: a converged signal can trace at half rate and interpolate — a real
  cost lever toward the 120 fps campaign that the stochastic design forbade.
- **`>32-tri` cells / static-cells-in-mover-bricks**: unchanged known limits of the record
  march; they bound silhouette exactness, not smoothness.

## 8. Rejected alternatives (so they are not re-proposed)

- **Better denoising** (SVGF, à-trous ladder, variance guidance): fights variance at the wrong
  end; the accumulation-vs-motion contradiction is invariant. Three shipped rounds are the
  evidence.
- **Multi-spp**: the trace is the module's most expensive per-pixel work (~5-7 ns/px); 4-8×
  is not interactive, and under motion even 8 spp still dithers.
- **ReSTIR-style reservoirs**: reservoir buffers against the 8-storage wall, still temporally
  lagged under a rotating sun, and this module's ReSTIR history (deleted 2026-07-16) stands.
- **Hybrid shadow maps for direct**: surrenders the unification (emissive/indirect cannot map)
  and the no-map wins (no cascades, no peter-panning, authored angular size) — the reasons this
  feature exists (giScreen.js:242-249).
- **Light-space traced maps** (trace into a light-view texture, filter there): motion-stable
  filtering without reprojection, but re-imports map-resolution aliasing and bias at contact —
  the PCSS disc already covers the same ground from screen space without those.
- **Density cone as-is**: see §4 — its diseases are congenital (density ≠ opacity). Note the
  distinction that survives it: aggregate data for *width* is safe, for *admission* is not.

## 9. Validation plan (module rule: no fix ships on read-the-code evidence)

Build behind `__giShadowAnalyticWidth` (build-time hatch like every arm here), stochastic path
stays default until measured. The stochastic arm is also the **reference instrument**: its
256-frame static accumulation is unbiased ground truth.

1. **Penumbra fidelity**: splitroom + sponza rigs, sourceAngle 5/20/45/90, static camera —
   SSIM / per-pixel delta of analytic vs accumulated-stochastic reference; Blender renders as
   the external bar (session-27 PCSS methodology).
2. **The design case**: scripted continuous sun rotation, `run-gi-flicker-frame` rev/px
   (mover pose on the camera ray — the [7.9,1.4,0.2] lesson). Expectation: analytic ≈ static
   noise floor while rotating; stochastic reads its known motion penalty.
3. **Leak baselines**: splitroom sealed-room rows must hold; the `__giShadowLift` A/B for the
   dead-zone follow-up.
4. **Cost**: gpu-smoke timestamp medians (the harness drives resolveTimestampsAsync itself —
   session-21 instrument), lightshadow arm at 8 bindings; expect ≈ trace cost + ~12 texture3D
   taps − jitter math − 2 kernels − 1 history pass.
5. **Banding hunt**: penumbra-gradient monotonicity scan across a canonical edge (the artifact
   class this design trades grain for); the retained bilateral is the insurance, `D`'s rgba8
   step (~2 cm over the 5.6 m cap, trilinear-smoothed) is the suspect to instrument first.

Binding budget check (from the current kernel audit): the shadow pass binds 1 storage buffer
(`bits` — pyramid + records + triangles all live in it), 2 sampled textures, 1-2 storage
textures. Adding `distanceTexture` is +1 sampled texture3D and its world-uniform bundle —
well inside every wall that matters (the 12-uniform composite kernel is not this kernel).
