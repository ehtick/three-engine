# Radiance Cascades GI — Occupancy/EDT Tracing Backend
## Implementation Instruction for an AI Coding Agent

**Target stack:** Three.js (WebGPU renderer, TSL/WGSL compute), Rust + Tauri desktop shell (asset pipeline / offline bake), TypeScript engine layer.

**Goal:** Replace the current dense mesh-SDF tracing backend with a leak-free, cheap-to-rebake hybrid: **conservative occupancy voxelization → unsigned EDT (empty-space skipping only) → voxel DDA near geometry → radiance voxels for interval shading**, integrated with the existing screen-probe / world-interval Radiance Cascades system. Fix probe-interpolation leaking with RC-native methods (not DDGI machinery).

**Non-goals:** signed distance fields, per-triangle distance evaluation at bake time, DDGI-style probe relocation/classification, sharp mirror reflections through the voxel field.

---

## 0. Architecture Overview

```
                    ┌─────────────── Rust/Tauri (offline, at import) ───────────────┐
                    │  glTF/mesh import → per-mesh conservative occupancy brick set  │
                    │  (local space, watertightness NOT required) → .giocc asset     │
                    └───────────────────────────────┬───────────────────────────────┘
                                                    ▼
   ┌─────────────────────────── GPU, runtime (WGSL compute) ───────────────────────────┐
   │                                                                                    │
   │  [A] Scene Occupancy Clipmap (per cascade level, follows camera)                   │
   │      A1. Splat per-mesh occupancy bricks (static) + voxelize dynamic meshes        │
   │      A2. Dilation pass for thin/two-sided geometry (far levels only)               │
   │                                                                                    │
   │  [B] Unsigned EDT per clipmap level (3 separable passes) — dirty bricks only       │
   │                                                                                    │
   │  [C] Radiance Voxels: albedo/emissive injection + direct light injection           │
   │      (shadow-mapped sun + local lights) + temporal feedback of cascade0 irradiance │
   │                                                                                    │
   │  [D] RC Interval Tracing:                                                          │
   │      cascade 0 near range  → screen-space linear trace (HZB) with voxel fallback   │
   │      all world intervals   → EDT sphere-skip + occupancy DDA → sample radiance     │
   │                                                                                    │
   │  [E] RC Merge + final gather with occupancy-aware interpolation weights            │
   └────────────────────────────────────────────────────────────────────────────────────┘
```

Implement in phases 1→7 below, **in order**. Each phase has acceptance criteria; do not proceed until they pass. Keep the old SDF path behind a flag (`gi.backend = "sdf-legacy" | "occupancy"`) until Phase 6 passes, then delete it.

---

## Phase 1 — Conservative Occupancy Voxelization (GPU)

### 1.1 Data structures

Sparse **brickmap** per clipmap level:

```
Brick        = 8×8×8 voxels, occupancy packed as 16 × u32 (512 bits)
BrickTable   = 3D texture or buffer, gridDim = ceil(levelSize / 8)^3,
               value = brick index (u32) or EMPTY (0xFFFFFFFF) or SOLID (0xFFFFFFFE)
BrickPool    = storage buffer, array<array<u32,16>> — allocated bricks
```

- Clipmap levels: one per RC cascade (5). Level *k* voxel size = `baseVoxel * 2^k`.
  **baseVoxel = 0.10–0.15 m** (not 0.35 — sub-voxel sheets were the root cause of the blob/leak artifacts). At 0.125 m, a 40×12×40 m footprint at level 0 covers only the near clip region (e.g., 16×12×16 m around camera); far levels cover the full scene at coarser voxels. Memory stays bounded because bricks are sparse.
- `SOLID` brick sentinel avoids storing fully-occupied interiors.

### 1.2 Voxelization compute pipeline (no geometry shaders in WebGPU)

Two dispatch chain:

**Pass 1 — Triangle binning.** One thread per triangle:
1. Transform triangle to voxel space of the level.
2. Compute voxel-space AABB, expand by 0.5 voxel (conservative).
3. For each overlapped brick, append `(brickCoord, triangleId)` to a pair list via `atomicAdd` on a counter (two-pass: count, prefix-sum, write — or a single pass with a generously sized buffer and overflow flag).

**Pass 2 — Per-brick voxel testing.** One workgroup (8×8×8 = 512 threads) per occupied brick; each thread = one voxel:
1. Loop over the brick's triangle list (workgroup-shared staging of triangle data, 32 tris at a time).
2. **Triangle–box overlap test = Separating Axis Theorem** (Akenine-Möller): 3 box axes + 1 triangle normal + 9 cross-product axes. Test against the voxel AABB **expanded by `conservativeEps = 1e-4 * voxelSize`**. This is exact conservative voxelization — every voxel touched by a triangle is set. Do NOT use point-sampled or center-distance tests.
3. Set the voxel bit with `atomicOr` into the brick's u32 words.

Static geometry: run once per level (or splat pre-baked per-mesh bricks, see Phase 7). Dynamic meshes: re-run Pass 1–2 only for dirty bricks intersecting moved objects' previous+current AABBs.

### 1.3 Thin-geometry dilation

Per-mesh flag `giThin: bool` (auto-set at import for materials with `side: DoubleSide` or meshes whose triangles have voxel-space thickness < 1 voxel at level 2).

- Levels ≥ 2: after voxelization, run a 1-voxel 6-neighborhood dilation pass **only for voxels written by thin meshes** (track with a second bit-plane during voxelization, discard after dilation).
- Levels 0–1: **no dilation** (contact darkening under banners would over-thicken; near range is covered by screen-space trace + fine voxels).

### 1.4 Acceptance criteria

- Debug view `occupancy` (add to the existing Debug View dropdown): render DDA hit positions as flat color per level. Sponza banners, chains, and window mullions must be present at level 0–1 with no gaps when viewed against light.
- A 0.2 m test wall placed in the scene must be occupied at every level (dilation covers levels where it is sub-voxel).
- Full static voxelization of Sponza at level 0 ≤ 8 ms on target GPU (one-time cost); dirty-brick update of one moving 1 m object ≤ 0.3 ms.

---

## Phase 2 — Unsigned Distance Field via Separable Exact EDT

Purpose: **empty-space skipping only**. Never used as the hit test. Unsigned — no sign computation, no winding numbers, no watertightness requirement.

### 2.1 Algorithm

Per clipmap level, compute exact squared Euclidean distance transform with the standard three-pass separable method (Saito–Toriwaki / Felzenszwalb–Huttenlocher 1D lower-envelope):

- **Pass X:** one thread per (y,z) row; 1D distance along X from occupancy bits. Output `u16` squared distance (voxel units).
- **Pass Y:** one thread per (x,z) row; 1D lower-envelope parabola scan over Pass X output.
- **Pass Z:** same over Pass Y output.
- Store final as `r16float` distance in **voxel units** (sqrt at the end), in a dense texture per level *or* per-brick with a coarse fallback (dense is fine: 128³ r16f = 4 MiB/level; start dense, optimize later).

Rationale for exact EDT over JFA: JFA is approximate and can **overestimate** distance; an overestimate makes the sphere-skip jump through a wall. Exact separable EDT is O(N) per axis and trivially parallel over rows — cheap at these grid sizes.

Incremental rebake: when only some bricks changed, recompute EDT for the axis-aligned slab of rows passing through dirty bricks, expanded by current max distance in that slab (or simply recompute the whole level — measure first; a 128³ EDT is typically < 1 ms).

### 2.2 Acceptance criteria

- Debug view `edt`: raymarch and display distance as heatmap; verify zero distance exactly on occupied voxels, smooth monotone growth elsewhere.
- Property test (compute shader writing to a readback buffer): for 10k random voxel pairs, `|D(a) − D(b)| ≤ dist(a,b)` (1-Lipschitz in voxel metric). Any violation = fail.

---

## Phase 3 — Radiance Voxels (hit shading source)

Occupancy tells the interval *that* it hit; RC needs *radiance* at the hit. Store it in the same brick structure.

### 3.1 Storage

Per occupied voxel, per level:
- `albedo: rgba8unorm` (a = emissive flag / opacity), injected at voxelization time (Pass 2 writes dominant-triangle albedo via material lookup; last-writer-wins is acceptable).
- `radiance: rgba16float` (rgb = outgoing radiance, a = unused/weight).

Optional upgrade later: 6-face anisotropic radiance (like voxel cone tracing) — **do not implement in v1**, isotropic is sufficient for diffuse RC.

### 3.2 Injection passes (per frame, dirty-region aware)

1. **Direct light:** one thread per occupied voxel (iterate brick pool): sample sun shadow map (CSM) + local light shadow maps at voxel center + `0.5 * voxel * normal-ish offset` (use gradient of EDT as pseudo-normal), accumulate `albedo/π * NdotL * lightColor * visibility` into `radiance`.
2. **Emissive:** add `emissive` directly (this backs the existing "Emissive Shadows" toggle).
3. **Multibounce feedback:** add `albedo/π * irradianceFromCascades(voxelCenter)` sampled from **last frame's** merged cascade output, scaled by `bounceEnergy` (existing UI param). Temporal exponential blend `radiance = mix(prevRadiance, newRadiance, 0.15)` to keep feedback stable.
4. Downsample radiance to coarser levels (max/avg blend of children, weighted by occupancy count) so far intervals sample prefiltered radiance.

### 3.3 Acceptance criteria

- Debug view `radiance`: DDA from camera, display hit voxel radiance. Sponza floor lit by the sun shaft must show correct red/green bleed from banners after 2–3 frames of feedback.
- Toggling a light off decays GI smoothly (no stuck energy after 1 s).

---

## Phase 4 — Hybrid Interval Tracing (the core replacement)

WGSL function used by all world-space RC intervals:

```wgsl
struct Hit { hit: bool, t: f32, radiance: vec3f }

fn traceInterval(origin: vec3f, dir: vec3f, tMin: f32, tMax: f32, level: u32) -> Hit {
  var t = tMin;
  let h = voxelSize(level);
  let SAFETY = 0.8660254; // half voxel diagonal, voxel units
  loop {
    if (t >= tMax) { return miss(); }
    let p = origin + dir * t;
    if (outsideClip(p, level)) { /* fall through to coarser level or sky */ }
    let dVox = sampleEDT_nearest(p, level);      // NEAREST, not trilinear
    if (dVox > 2.0) {
      // empty-space skip; never overestimate:
      t += max(h, (dVox - SAFETY) * h);
    } else {
      // exact traversal: Amanatides–Woo DDA over occupancy bits
      let dda = ddaTrace(p, dir, min(tMax - t, 4.0 * h), level);
      if (dda.hit) {
        return Hit(true, t + dda.t, sampleRadiance(dda.voxel, level));
      }
      t += dda.t + 0.25 * h;
    }
  }
}
```

Hard rules:
- **The EDT is never the hit test.** Hits come only from occupancy bits via DDA. No `sdf < epsilon` anywhere.
- Sample EDT with **nearest** filtering (trilinear filtering of a distance grid can overestimate free space near thin features). The DDA handoff at `dVox ≤ 2` makes fine stepping unnecessary anyway.
- The `SAFETY` subtraction accounts for distance being measured to voxel centers.
- Cascade *k* traces its interval `[t_k, t_{k+1}]` against clipmap level `min(k, maxLevel)`; radiance sampled from that level's prefiltered radiance. This preserves RC's "coarser occlusion farther away" property and keeps far intervals cheap despite linear DDA.

### 4.1 Cascade 0 near range

For the shortest interval (screen probes): **screen-space linear trace against the HZB first** (existing depth pyramid), fall back to `traceInterval` at level 0 on miss/off-screen. This is what actually kills visible contact leaking; fine voxels alone cannot.

### 4.2 Acceptance criteria

- Leak test scene: closed 0.2 m-wall box containing an emissive cube, camera outside → **zero** interior light visible outside at all camera distances (exercises every cascade level). Automate as a screenshot-diff test.
- Sponza: no light bleeding through the second-floor walls into the atrium shadows (the failure visible in the original screenshots).
- Interval trace cost budget: total RC tracing ≤ 4 ms @ 1080p on the current target GPU (measure with timestamp queries; expose in the FPS panel).

---

## Phase 5 — RC-Native Interpolation Leak Fixes

Do **not** port DDGI probe relocation / classification / Chebyshev visibility — they break RC's regular-grid merge invariants. Use RC-native fixes:

1. **Bilinear fix / forked rays at merge:** when merging cascade *k* with *k+1*, instead of interpolating cascade *k+1* interval results, trace cascade *k*'s ray segment from each of the 8 parent probe positions toward the parent's direction bin start ("forked" intervals), then bilinearly combine. This makes interpolation geometry-aware by construction. (This is the standard RC bilinear-fix; implement per Sannikov's RC paper / radiance-cascades.com reference implementations.)
2. **Occupancy-aware final gather:** when the shaded pixel samples cascade 0 probes, weight each probe by a short DDA visibility check probe→pixel (cheap: ≤ 4 voxel steps at level 0) plus the usual normal weighting `max(0, dot(n, probeDir))^1`. Reject probes behind walls.
3. **Self-bias:** offset interval origins by `0.5 * voxel * geometricNormal` and start `t` at `0.25 * voxel`.

Acceptance: thin-wall test room — a probe grid straddling a 0.2 m wall must show no interior light on the exterior side with probe spacing up to 1.25 m.

---

## Phase 6 — Integration, Flags, and Cleanup

- Wire to existing UI: `Voxel Size` now = level-0 voxel (default 0.125), `Cascades`, `Bounce Energy`, `Bake Smoothing` (repurpose as radiance temporal blend), `GI Reflections` (rough reflections = cone through radiance mips; **Exact Reflections stays SSR/BVH, out of scope here**), `Emissive Shadows`, `Auto Re-bake` (dirty-brick tracking), `Debug View` gains `occupancy | edt | radiance | cascades | intervals`.
- Public API:

```ts
mesh.gi = {
  mode: "auto" | "proxy" | "disabled",  // "proxy" uses mesh.giProxy geometry instead
  thin: "auto" | true | false,          // dilation behavior, see Phase 1.3
};
```

- Delete the legacy signed-SDF bake path once all acceptance tests pass under `backend: "occupancy"`.

---

## Phase 7 — Rust/Tauri Offline Bake (asset pipeline)

Purpose: static meshes shouldn't pay runtime voxelization. Bake per-mesh occupancy in local space at import.

- Rust crate `gi-bake` inside the Tauri backend:
  - Input: glTF/GLB path. For each mesh: conservative SAT voxelization (same algorithm as Phase 1.2, CPU, rayon-parallel over bricks) at a resolution chosen so voxel ≈ `max(meshExtent/64, 0.05 m)`, into the same 8³ brick format + per-voxel `albedo rgba8`.
  - Output: `.giocc` sidecar file — header (grid dims, voxel size, brick count) + brick table + brick pool, LE binary, zstd-compressed. Expose Tauri command `bake_gi_occupancy(path) -> GioccMeta`; run automatically on asset import with progress events to the editor UI.
- Runtime: a **splat compute pass** rasterizes each instance's local bricks into the scene clipmap under the instance transform (conservative: expand by 0.5 scene voxel; for rotated instances, test transformed brick AABB overlap then re-test occupied source voxels against destination voxels). Falls back to runtime voxelization when no `.giocc` exists or the mesh is skinned/morphing.
- Acceptance: importing Sponza produces `.giocc` files; scene load rebuilds clipmaps from splats only, ≤ 2 ms; byte-identical occupancy vs. runtime voxelization within 1-voxel conservative tolerance (automated compare test in Rust).

---

## Implementation Order & Test Discipline (for the agent)

1. Phase 1 → 2 → 4 first with **constant white radiance on hit** (skip Phase 3) — validates occlusion in isolation. Run the closed-box leak test here.
2. Phase 3, re-run all tests.
3. Phase 4.1 screen trace, then Phase 5, then 6, then 7.
4. Every phase: add its debug view *before* the feature, keep timestamp-query GPU timings in the FPS panel, and add its acceptance test as an automated case (headless WebGPU via the existing test harness, or screenshot diff in the Tauri shell).
5. WGSL constraints to respect: no geometry shaders (use compute), storage-texture format limits (prefer storage buffers for bricks), 256-byte uniform alignment, `atomicOr/atomicAdd` only on u32/i32 storage.

## Known Trade-offs (accepted)

- Over-occlusion bias instead of leaking (conservative voxelization + dilation): correct choice for diffuse GI.
- Isotropic radiance voxels: slight energy smearing at grazing angles; acceptable, upgrade path to 6-face exists.
- Linear DDA for far intervals is more steps than sphere tracing, but runs on coarse levels; measured budget in Phase 4 gates this.
- Sharp reflections intentionally excluded — SSR + (later) software BVH; do not attempt through voxels.

## Future Watch (do not implement now)

- **Split Radiance Cascades** (Freeman & Sannikov, arXiv:2607.20384, 2026): sparse hashmap world probes + ray splitting from visible surfaces. If the clipmap approach hits memory/quality walls, this is the redesign path; the occupancy/EDT/DDA tracer built here remains reusable as its intersection backend.
