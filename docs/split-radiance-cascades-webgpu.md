# Split Radiance Cascades (SRC) — WebGPU Implementation Guide

**Target:** Real-time 3D diffuse global illumination in the browser via WebGPU (WGSL), integrable with a Three.js `WebGPURenderer` engine that already has a voxel occupancy + EDT/SDF + DDA tracing pipeline.

**Paper:** Rouli Freeman, Alexander Sannikov — *Split Radiance Cascades: Real-Time Global Illumination via Sparse Radiance Probes*, arXiv:2607.20384 (cs.GR), submitted 22 Jul 2026. 13 pages, 17 figures. License CC BY-SA 4.0.
PDF: https://arxiv.org/pdf/2607.20384

---

## 0. Provenance disclaimer — read this first

This guide is written against the paper's **abstract and public coverage**, plus the established Radiance Cascades (RC) literature (Sannikov 2023; Osborne & Sannikov 2024; Freeman, Sannikov & Margel 2025 "Holographic RC"). The following facts are **confirmed from the paper itself**:

1. SRC adapts RC to **full 3D world space** (not 2D, not screenspace).
2. Probes are stored **sparsely in a hashmap** to make volumetric radiance storage affordable.
3. **Ray splitting**: rays are traced **from visible surfaces**, and each ray's radiance contribution is assigned to cascade radiance intervals **based on its hit distance**.
4. The method works **single-frame** (no temporal history required for a usable result) and improves with **temporal accumulation**.
5. The goal is detail at all scales without noise or aliasing — the classic RC promise, now volumetric.

Everything else in this document (exact branching factors, encoding formats, merge math, WGSL kernels, buffer layouts, scheduling) is a **reconstruction**: standard RC machinery plus sound GPU engineering, arranged the way the abstract implies. Before shipping, read the actual PDF and reconcile — especially §"Ray splitting" details (how misses are handled, whether visibility terms are stored per interval, and the exact probe placement rule). Where I'm inferring, I say so inline with **[inferred]**.

---

## 1. Why SRC exists — the problem it solves

### 1.1 Classic RC recap (needed to understand the "split")

Radiance Cascades exploit the observation that the radiance field needs **high angular resolution only for distant light** and **high spatial resolution only for nearby light** (the penumbra condition). So you build a hierarchy of cascades:

- **Cascade 0**: dense probes, few directions, short ray interval `[t0_start, t0_end]` near the probe.
- **Cascade i**: probes spaced ×2 farther apart per axis, ×4 more directions, ray interval pushed farther out and ×4 longer.
- Each probe in cascade *i* stores, per direction, a **radiance interval**: the light arriving from within `[t_i, t_{i+1}]` only, plus a **visibility/transmittance term** telling the merge step whether farther cascades can "shine through" this interval.
- **Merging** runs top-down: cascade *i* pulls from cascade *i+1* via spatial interpolation (trilinear in 3D) and angular averaging, compositing `L = L_near + T_near * L_far`.

In 2D this is cheap. In 3D a **dense** probe grid explodes: a 256³ cascade-0 grid with even 16 directions × RGBA16F is gigabytes. That's why prior 3D RC work retreated to screenspace probes (flat 2D probe layouts anchored to pixels), which lose world-space stability and off-screen light.

### 1.2 What SRC changes

Two ideas, per the paper:

**A. Sparse world-space probe storage (hashmap).** You don't need probes everywhere — only near **visible surfaces** (and optionally a small shell around them for disocclusion robustness). A GPU hashmap keyed on quantized world position (+ cascade level) stores only allocated probes. Memory drops from "volume of the world" to "area of visible surfaces × cascade count", which is roughly screen-proportional. This is the same philosophical move as sparse voxel brickmaps, applied to probes.

**B. Ray splitting.** Classic RC traces each cascade's interval **separately**: cascade 0 traces short rays, cascade 1 traces medium rays starting where cascade 0 ended, etc. That means N cascades ⇒ N tracing passes with disjoint `[t_min, t_max]` clipping, and the expensive far intervals are traced at high angular counts. SRC instead traces **full-length rays from visible surfaces** and then **splits** each ray's result across the cascade hierarchy analytically: a hit at distance `d` contributes radiance to the cascade whose interval contains `d`, and contributes **occlusion** (transmittance = 0 beyond `d`) to that interval, while all nearer intervals along that direction record "no hit, fully transparent" **[inferred mechanics; the assignment-by-hit-distance is confirmed]**. One trace feeds every level. This amortizes the tracing cost that made 3D RC prohibitive and is the headline trick of the paper.

The consequence: tracing cost is decoupled from cascade count. You pay for rays roughly like a screen-space GI method (rays from visible surfaces), but you get RC's noise-free, multi-scale reconstruction because the results are *stored and merged* through the cascade hierarchy instead of being averaged stochastically.

---

## 2. System architecture

```
Frame graph (compute-dominated):

 [1] G-Buffer render (depth, normal, albedo, motion)          — render pass
 [2] Probe anchor pass: quantize visible-surface positions
     per cascade level → hash insert (atomics)                — compute
 [3] Probe compaction: build dense probe list + indirect args — compute (prefix sum)
 [4] Ray generation: for each cascade-0 probe × direction,
     emit ray records (origin, dir, level mask)               — compute
 [5] Trace + split: DDA/SDF march full rays; scatter radiance
     + visibility into cascade interval storage by hit dist.  — compute
 [6] Radiance injection at hits: sample direct light / emissive
     / previous-frame irradiance at hit point (multi-bounce)  — folded into [5]
 [7] Merge: for level = N-1 … 0: composite level+1 into level — compute × N
 [8] Final gather: per pixel, trilinear-sample cascade-0
     probes around the surface, cosine-weight → irradiance    — compute or fragment
 [9] Temporal accumulation of probe radiance (optional but
     recommended) + irradiance history reprojection           — compute
[10] Composite: irradiance × albedo + specular path            — render pass
```

Passes [2]–[9] are all `GPUComputePass` work; batch them in as few command encoders as possible and use `dispatchWorkgroupsIndirect` wherever counts come from the GPU (probe counts, ray counts).

---

## 3. Cascade configuration

Standard RC scaling adapted to 3D. **[inferred defaults — tune against the paper's numbers when you have them]**

| Parameter | Cascade 0 | Scaling per level | Typical N |
|---|---|---|---|
| Probe spacing (world) | 0.25–0.5 m (match your voxel base, e.g. 2–4× your 0.125 m voxel) | ×2 | 5–6 levels |
| Directions per probe | 8 (octahedral 2×2… see below) | ×4 (octahedral res ×2 per axis) | — |
| Interval start `t_i` | 0 | `t_{i+1} = t_i + len_i` | — |
| Interval length `len_i` | ≈ probe spacing × k (k≈1–2) | ×4 | last level → ∞ (sky) |

Direction sets: use **octahedral mapping** per probe. Cascade 0 = 2×2 octahedral texels (4–8 dirs), cascade 1 = 4×4, cascade 2 = 8×8, etc. Octahedral gives you uniform-ish coverage, trivial direction↔texel mapping in WGSL, and hardware-friendly 2D layouts inside a probe atlas.

Note the beautiful property that makes RC affordable: probe count shrinks ×8 per level (2³) while direction count grows ×4, so **total ray/storage cost per level shrinks ×2** — the hierarchy sums to ≈2× the cost of cascade 0 alone. With sparse allocation the shrink is even better in practice because higher cascades cover surfaces with far fewer probes.

---

## 4. Data structures (WGSL)

### 4.1 Probe hashmap

Open-addressing hashmap in a storage buffer. Key = quantized world cell + level. One hashmap for all levels (level folded into the key) keeps binding simple.

```wgsl
struct ProbeSlot {
    key: atomic<u32>,   // packed hash key, 0 = empty (reserve 0)
    index: u32,         // index into dense probe array after compaction
};

struct ProbeHashMap {
    slots: array<ProbeSlot>,
};

// Quantize an anchor position to a probe cell at `level`.
fn probe_cell(p: vec3f, level: u32, origin: vec3f, base_spacing: f32) -> vec3i {
    let spacing = base_spacing * f32(1u << level);
    return vec3i(floor((p - origin) / spacing));
}

// PCG-based key hash (Jarzynski & Olano 2020 — the family the RC
// community already uses for GPU hashing).
fn hash_key(cell: vec3i, level: u32) -> u32 {
    var h = u32(cell.x) * 73856093u
          ^ u32(cell.y) * 19349663u
          ^ u32(cell.z) * 83492791u
          ^ (level * 2654435761u);
    h = h ^ (h >> 16u); h = h * 0x7feb352du;
    h = h ^ (h >> 15u); h = h * 0x846ca68bu;
    h = h ^ (h >> 16u);
    return max(h, 1u); // keep 0 as the empty sentinel
}

fn hashmap_insert(key: u32, capacity: u32) -> u32 {
    var slot = key % capacity;
    for (var i = 0u; i < 64u; i++) {           // bounded probe count
        let prev = atomicCompareExchangeWeak(&hashmap.slots[slot].key, 0u, key);
        if (prev.old_value == 0u || prev.old_value == key) {
            return slot;                        // inserted or already present
        }
        slot = (slot + 1u) % capacity;          // linear probing
    }
    return 0xffffffffu;                         // table full — grow next frame
}
```

Size the table at ≥2× expected probe count (load factor ≤0.5). Expected cascade-0 probes ≈ unique surface cells visible on screen; for 1080p and 0.25 m spacing expect low hundreds of thousands worst case, tens of thousands typically. Start with capacity 2²⁰ slots and telemetry the load factor.

**Persistence across frames [inferred, strongly recommended]:** keep the hashmap alive between frames and age probes (last-seen frame index). Probes that stay resident give you temporal accumulation for free and stability under camera motion. Evict by age with a compaction pass every K frames.

### 4.2 Probe payload / radiance interval storage

Each allocated probe at level *L* owns a small octahedral tile of interval data:

```wgsl
// Per-direction radiance interval.
// rgb = radiance arriving from within [t_L, t_{L+1}]
// a   = transmittance of the interval (1 = nothing hit inside it)
// Store as rgba16float in a large 2D texture atlas; probes get
// tile slots by their compacted index (slots per row = atlasW / tileW).
```

Atlas per cascade level (or one atlas with level offsets). Tile sizes: 2×2, 4×4, 8×8, 16×16, 32×32 for levels 0–4. With rgba16float that's 8 B/texel; a 4096×4096 atlas holds 4 M texels = 128 MB… so budget carefully: sparse allocation is what keeps this sane. Track high-water marks per level.

For merging you also want a small per-probe header buffer: world cell, level, age, and a flag for "freshly allocated this frame" (fresh probes must be fully traced; resident probes can be partially retraced — see §8).

### 4.3 Ray records

```wgsl
struct RayRecord {
    origin: vec3f,     // probe center (or surface anchor, see §6.1)
    dir_oct: u32,      // packed octahedral direction + level info
    probe_index: u32,  // dense index of the *cascade-0* probe that spawned it
};
```

---

## 5. Phase-by-phase implementation

### Phase 1 — G-buffer

Nothing exotic: depth, octahedral-encoded normal, albedo, motion vectors. From depth+camera you reconstruct world position in later passes. If your engine is deferred already, reuse it; if forward, add a thin prepass (depth + normal is enough for probe anchoring; albedo only needed at composite).

### Phase 2 — Probe anchoring (visible-surface driven)

One thread per screen tile (e.g. 8×8 pixels — you don't need per-pixel anchoring):

1. Load a representative depth/normal for the tile (min-depth or checkerboard sample).
2. Reconstruct world position `P`, offset slightly along the normal (`P + n * 0.5 * spacing0`) to avoid self-intersection **[inferred]**.
3. For each cascade level `L` in `0..N`: compute `probe_cell(P, L)` and `hashmap_insert`. Because higher levels quantize coarser, many tiles collapse into the same higher-level probes — atomics dedupe them.
4. Optionally also insert the 7 neighboring cells needed for trilinear interpolation at final gather (the 2×2×2 cell corner set around `P`) — otherwise gather must handle missing probes (fallback weights). Inserting corners is simpler and costs ~2–4× probes at level 0 only; do it for level 0 and let higher levels rely on fallback.

### Phase 3 — Compaction

Standard stream compaction: scan the hashmap (or a per-frame "newly inserted" append buffer, which is cheaper), assign dense indices, write `index` back into slots, fill indirect dispatch buffers with `(probeCount_L * dirsPerProbe_L + wg - 1) / wg` style args via a tiny 1-thread kernel. WebGPU has no `atomicAdd` on indirect buffers from the CPU side — do it all GPU-side.

### Phase 4 — Ray generation, and where the "split" changes everything

**Classic RC would do:** for every level L, for every probe, for every direction, trace `[t_L, t_{L+1}]`. Total rays = Σ probes_L × dirs_L.

**SRC does [confirmed in principle, mechanics inferred]:** trace **full-length rays from visible surfaces / cascade-0 anchors** at the *highest* angular resolution you need, once, and let a single ray serve every level along its direction:

- A ray with direction `ω` traced from probe anchor `P` to distance `d_hit`:
  - For every level L whose interval `[t_L, t_{L+1}]` lies **entirely before** `d_hit`: this ray reports `radiance = 0, transmittance = 1` for that interval (it saw nothing there).
  - For the level L* whose interval **contains** `d_hit`: report `radiance = L_hit, transmittance = 0` (or partial for translucency).
  - Levels beyond L* along this ray are occluded — they receive nothing from this ray, which is correct because the merge composites through the L* interval's zero transmittance.
- The per-level, per-direction interval texel accumulates contributions from all rays that map to that probe/direction bin. A cascade-L direction bin covers 4^(L) cascade-0 directions, so far intervals are averaged over many primary rays — this is exactly how SRC gets high effective angular resolution far away without extra traces, and it's what "calculating their contribution to cascades based on their hit distance" means operationally.

Practical scatter strategy: since higher-level probes are shared by many cascade-0 anchors, contributions must be **atomically accumulated** (WebGPU has no float atomics — accumulate into `atomic<u32>` fixed-point, e.g. radiance × 1024 packed per channel in separate u32 buffers, then a resolve pass converts to rgba16float and divides by the sample count). Alternatively, gather instead of scatter: for each level-L probe/direction texel, loop over the primary rays binned to it. Scatter is simpler first; gather is the optimization.

Angular budget: emit rays at the direction resolution of your **top** cascade projected down (e.g. 32×32 oct = 1024 dirs) *per level-0 probe* is too much. The sane compromise **[inferred]**: emit at cascade-0 anchors with a mid-level resolution (e.g. 8×8 = 64 rays/probe) and jitter direction per frame within each bin; temporal accumulation fills in the top level's angular detail. Single-frame mode = higher ray count, no jitter.

### Phase 5 — Tracing backend

WebGPU has **no ray tracing API**, so tracing is software in compute. Options, best-first for your setup:

1. **Voxel DDA over sparse occupancy brickmaps + SDF sphere-trace acceleration** — you already have conservative occupancy voxelization, exact EDT, and DDA. Reuse it verbatim: sphere-trace through the EDT to skip empty space, drop to fine DDA near surfaces. Radiance at hit = sample your injected radiance voxels (direct light + emissive), which also gives you infinite-bounce feedback if injection includes last frame's irradiance.
2. **Two-level BVH in storage buffers** (TLAS over meshes, cached BLAS) with stackless traversal — more precise hits and material sampling, significantly more WGSL complexity and worse divergence.
3. **Hybrid**: screen-space march first (HZB), fall back to voxels on miss — cheap primary detail, matches your existing HZB cascade-0 plan.

Distance-dependent LOD is natural with voxels: once the marched distance passes `t_L`, step up a mip of the occupancy/radiance volume — far intervals tolerate coarse geometry (this mirrors what the paper needs for its far cascades to be cheap **[inferred]**).

```wgsl
// Sketch: full-length trace with on-the-fly splitting.
fn trace_and_split(origin: vec3f, dir: vec3f, probe0: u32, dir0_bin: u32) {
    var t = T_MIN_BIAS;
    let hit = trace_scene(origin, dir, /*t_max=*/ t_top_end); // your SDF+DDA
    let d = select(1e30, hit.t, hit.valid);

    for (var L = 0u; L < NUM_LEVELS; L++) {
        let t0 = interval_start(L);
        let t1 = interval_end(L);
        if (d >= t1) {
            // interval fully empty along this ray
            accumulate(L, probe0, dir0_bin, vec3f(0.0), /*trans=*/1.0);
        } else if (d >= t0) {
            let radiance = shade_hit(hit);   // radiance voxels / direct light
            accumulate(L, probe0, dir0_bin, radiance, /*trans=*/0.0);
            break;                           // farther intervals occluded
        } else {
            break;                           // d < t0: nearer level already took it
        }
    }
    // Miss entirely: top level gets sky radiance with trans handling per your sky model.
}
```

`accumulate` maps `(probe0, dir0_bin, L)` → the level-L probe containing this anchor and the level-L direction bin containing `dir` (just `dir0_bin >> (2*L)` in octahedral index space if resolutions halve cleanly), then does the fixed-point atomic add + sample counter.

### Phase 6 — Radiance at hits (bounce chain)

At a hit, shade with: shadow-mapped/analytic direct lighting × albedo (from your radiance voxel injection, so it's a texture fetch, not a shading graph), plus emissive, plus **previous frame's cascade-0 irradiance sampled at the hit point** for multi-bounce **[standard RC/DDGI practice, inferred for SRC]**. The hashmap makes the last part easy: hash the hit position, fetch probe, cosine-integrate. If no probe exists there (off-screen surface), fall back to radiance voxels only.

### Phase 7 — Merge (top-down)

For `L = N-2 … 0`, one thread per (probe_L, direction_L):

1. Find the 8 level-(L+1) probes surrounding this probe's center via hashmap lookups; compute trilinear weights. Missing probes → renormalize weights over found ones (sparse world = merge must be lookup-tolerant).
2. For each of the 4 level-(L+1) direction bins that refine into this direction bin's parent — careful: it's the reverse; each L-direction has **4 children at L+1**? No: going *up* the hierarchy directions get finer. Merging pulls from L+1 whose bins are **finer**: average the 4 child bins of L+1 that subdivide this L bin. So: `far = avg over 4 finer dirs of trilerp over 8 probes`.
3. Composite: `out.rgb = near.rgb + near.a * far.rgb; out.a = near.a * far.a`.
4. Apply the **bilinear/vanilla-fix correction** you already know from 2D RC (merge *before* interpolate vs interpolate *before* merge — do "merge rings": interpolate the *pre-merged* upper cascade, i.e., process levels strictly top-down so level L+1 is already fully merged when L reads it; plus directional-first ordering to avoid the classic ringing).

Because probes are sparse, merge is hashmap-lookup-heavy. Cache-friendly trick: during compaction, store for each probe the 8 parent probe indices (resolved once) in the header, so merge does direct indexed reads.

### Phase 8 — Final gather

Per pixel: reconstruct `P`, hash the level-0 cell corner set (or reuse the tile's precomputed probe indices), trilinear weights × normal-cosine-weighted integration over the probe's octahedral tile (which after merging holds *full-range* radiance, not just the near interval). Add a chebyshev/normal-offset guard against light leaking through thin walls (you know this pain from your SDF work; probe-side fix: anchor probes offset along normals, gather-side fix: weight by `max(0, dot(n, dirToProbe))` plane test like DDGI).

Output is diffuse irradiance; multiply by albedo in composite. Specular: either sample the top cascades along the reflection vector (cheap glossy) or keep your existing SSR/HZB path.

### Phase 9 — Temporal accumulation

Two independent accumulators, per the paper's two evaluation modes:

- **Probe-space accumulation** (the important one): resident probes exponential-average their interval texels across frames (`α ≈ 0.05–0.15`), with per-frame direction jitter inside bins. World-space probes make this trivially stable under camera motion — no reprojection needed, which is a major advantage over screenspace RC. Invalidate on local lighting change (compare injected radiance voxel checksum per region, or just use a faster α).
- **Screen-space irradiance history** (optional polish): standard motion-vector reprojection + neighborhood clamp on the final gather output to smooth probe-grid crawl during motion.

---

## 6. WebGPU-specific constraints & tactics

- **No float atomics.** Fixed-point `atomic<u32>` accumulation (split RGB across 3 u32s or pack 2×16b with saturation care), plus a resolve pass. Or restructure scatter→gather.
- **No bindless / few storage textures per stage.** Use one big atlas texture per payload kind + storage buffers for headers/hashmap. `texture_storage_2d<rgba16float, write>` for resolve outputs; sampled reads elsewhere.
- **Buffer size limits.** `maxStorageBufferBindingSize` is commonly 128 MB–1 GB; check `device.limits` and request higher `requiredLimits` at device creation. Split the hashmap and atlases across bindings if needed.
- **Workgroups.** 64 threads (8×8 or 64×1) is the safe sweet spot across Apple/NVIDIA/Intel/Adreno. Merge and trace kernels are divergence-heavy — keep them simple, avoid giant übershaders, specialize per level via pipeline constants (`override` in WGSL) instead of runtime branching.
- **Indirect everything.** Probe/ray counts live on GPU; use `dispatchWorkgroupsIndirect`. Zero the counters with `queue.writeBuffer` or a clear kernel at frame start.
- **Timestamps.** `"timestamp-query"` feature for per-pass timing; Chrome exposes it behind capable adapters. Budget target on a desktop GPU: anchor+compact <0.2 ms, trace 2–5 ms (dominant), merge <1 ms, gather <0.5 ms at 1080p.
- **f16.** Enable `"shader-f16"` where available for interval math and payload packing; big bandwidth win on the merge pass.
- **Subgroups.** `"subgroups"` (shipping in Chrome) accelerates the compaction scans and can do subgroup-level pre-reduction before atomics in the split-scatter — worth it once correct.
- **Three.js integration.** Drive the passes with raw `device.createComputePipeline` + your own frame graph rather than TSL nodes for the core (TSL is fine for the final composite node). Share the depth/normal targets via `renderer.getContext()`-level access or render your own thin G-buffer with `THREE.RenderTarget` MRT; WebGPURenderer MRT works as of recent releases.

---

## 7. Parameter starting points

| Knob | Start | Notes |
|---|---|---|
| Levels | 5 | covers 0.25 m → ~256 m with ×4 interval growth |
| Spacing0 | 0.25 m | 2× your 0.125 m voxel base |
| Dirs0 / rays emitted | 8 stored / 64 traced (jittered) | single-frame mode: trace 256 |
| Interval0 length | 0.5 m | ≈ 2× spacing0 |
| Hashmap capacity | 1 M slots | telemetry, grow ×2 on overflow flag |
| Accumulation α | 0.1 | 0.3 while probe age < 8 frames |
| Probe eviction age | 60 frames | compaction every 16 frames |

## 8. Validation & debugging checklist

1. **Unit-test the hashmap** in isolation (insert/find/collision storm) with a compute test harness before wiring anything.
2. **Visualize probes** as instanced spheres colored by level — confirm anchoring hugs visible surfaces and higher levels are coarser.
3. **Single-level sanity**: disable merging, render cascade-0 intervals only → should look like short-range AO-ish bounce.
4. **Furnace test**: uniform white emissive sky, white albedo 1.0 → converged irradiance must be flat 1.0; any level imbalance shows as banding at interval boundaries (classic RC bug: interval overlap/gap — check `t` boundaries are exact, no epsilon gaps).
5. **Interval boundary rings** in the final image → your merge is interpolating pre-merge data or intervals gap; re-check top-down ordering and the bilinear fix.
6. **Light leaks** → anchor offset too small, or trilinear pulling probes through walls: add the DDGI-style plane-distance weight.
7. **Fireflies impossible** in principle (no stochastic estimator at the pixel), so any sparkle = atomics race or fixed-point overflow.
8. Compare against a compute path-tracer reference of the same scene (even 1 spp accumulated) — SRC should match large-scale energy closely and soften only fine angular detail near contact.

## 9. Known hard parts (plan time for these)

- **Scatter contention** on high-level probes (thousands of rays hitting one atomic texel). Subgroup pre-reduction or the gather restructure fixes it; expect this to be your first perf cliff.
- **Sparse merge robustness**: missing-neighbor renormalization must not bias energy. Test in geometry-dense scenes (Sponza curtains — your old friend).
- **Disocclusion**: freshly visible surfaces have brand-new probes with 1-frame data. Mitigate with the fast-α warmup and by seeding new probes from their parent level's merged result **[inferred technique, works well in DDGI-family systems]**.
- **Mobile**: Adreno/Mali storage-buffer bandwidth will hurt; halve levels/dirs and lean on temporal accumulation harder.

## 10. References

- Freeman R., Sannikov A. *Split Radiance Cascades*, arXiv:2607.20384, 2026 — primary source; reconcile every **[inferred]** in this doc against it.
- Sannikov A. *Radiance Cascades: A Novel Approach to Calculating Global Illumination*, 2023 — github.com/Raikiri/RadianceCascadesPaper (core theory, penumbra condition, merge math).
- Freeman R., Sannikov A., Margel A. *Holographic Radiance Cascades for 2D GI*, arXiv:2505.02041, 2025.
- Osborne C., Sannikov A. *Radiance Cascades for non-LTE radiative transfer*, arXiv:2408.14425 / RASTI 2024 — cleanest formal writeup of cascade construction.
- radiance-cascades.com — community implementations and demos.
- Jarzynski M., Olano M. *Hash Functions for GPU Rendering*, JCGT 2020 — the hash family for §4.1.
- Majercik et al., *Dynamic Diffuse Global Illumination (DDGI)*, JCGT 2019 — leak-suppression weights reused in §Final gather.
