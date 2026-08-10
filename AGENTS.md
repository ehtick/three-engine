# Engine development invariants

## WebGPU GI binding budget

- Every GI compute shader must stay within WebGPU's portable limit of **8 storage buffers per shader stage** (`maxStorageBuffersPerShaderStage = 8`).
- Do not fix binding validation errors by requesting a device limit of 16. The engine must continue to run on adapters that expose only the portable default.
- Count bindings on the fully composed TSL graph, not per helper function. A deferred pass that invokes one helper for each of three cascades can bind each cascade's buffers independently; three buffers per cascade therefore becomes nine and fails pipeline creation.
- Prefer packing related data into an existing storage buffer, reusing an already-bound buffer/bit field, or moving read-only sampled data into textures. The probe and light data are intentionally packed for this reason.
- After any GI buffer or TSL sampling change, run the runtime WebGPU smoke test. A Vite build does not create GPU pipelines and cannot detect binding-limit failures:

  1. Start Vite locally.
  2. Run `node scripts/run-gpu-page.mjs http://127.0.0.1:<port>/scripts/gi-gpu-smoke.html 70000`.
  3. Require `GI-SMOKE PASS` and no WebGPU validation errors.

The recurring failure signature is:

```text
The number of storage buffers (9) in the Compute stage exceeds the maximum per-stage limit (8).
```

Treat this as a graph binding-budget regression, not as a reason to raise device limits.

## Test index

Not exhaustive yet — `package.json`'s `scripts` is the full list. Entries land here
as they are added, newest first.

| Script | What it gates |
|---|---|
| `npm run test:gi-src-surface` | SRC static surface attribution (`srcSurface.js`): a traced hit reads its own mesh's albedo, the stamp is deterministic across dispatches, the NEE emitter flag round-trips, a recolour costs no re-voxelize. Real occupancy field + real rays; race-sensitive, run 2-3×. |
| `npm run test:gi-src-shade` | SRC hit shading (`srcShade.js`) against `srcRef.js`'s `makeHitShader`. |
| `npm run test:gi-src-ref` | The SRC CPU mirror — no GPU, ~9s, the reference every SRC gate is diffed against. |
