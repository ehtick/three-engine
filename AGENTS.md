# Engine development invariants

## Response style

Respond short: main thesis first, 2-3 sentences with the key information. Detail belongs in plan docs and memory, not in chat replies.

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
| `npm run test:confirm` | The destructive-confirmation dialog (`components/ConfirmDialog.jsx`), which replaced the OS message box after that box was seen dismissing itself. Gates the two rules that make a delete prompt safe: it cannot be dismissed by the interaction that opened it (backdrop closes on **`click`, never `pointerdown`**, plus a one-frame arming guard — a `pointerdown` backdrop eats the pointerup of the menu item that opened it, which looks exactly like "the popup vanished"), and a stray Enter cannot delete (focus lands on **Cancel**; Enter only fires when the destructive button really has focus). Also that every failure mode answers *false*, and that `assetOps.js` no longer imports the Tauri dialog or `window.confirm`. No browser, instant. |
| `npm run test:time` | `engine.time` (`src/engine/time.js`) — clocks + scheduler. Gates the specific failure each structure avoids: a stale handle must not cancel the timer that inherited its slot (handles are `gen·2²⁰+slot+1` — the **`+1` matters**, without it the first timer ever created gets handle `0` and can never be cancelled); a repeater must not drift *and* must not fire 10,000 times catching up after a stall; game timers freeze under pause while real ones don't; a frame wait must survive the 256-bucket wheel wrapping; a cancelled `await` must RESOLVE `false`, not hang or reject; a callback may schedule/cancel from inside itself. Plus a measured claim: an idle frame with 20k pending timers costs the same as with none. No browser, ~1s. |
| `npm run test:library` | The six asset browsers (Poly Haven, ambientCG, Sketchfab, Poly Pizza, itch.io, Audio Library) as source contracts, plus the MCP asset flow. **Registration**: each panel wired into all five points (lazy import + component map + **dock entry** in `EditorShell.jsx`, `MenuBar.jsx`, `QuickSearch.jsx` — miss the dock entry and the tab opens EMPTY with no error), each module registered and categorised `Assets`. **Agent flow**: every browser reachable through an op family; `library.import` returns an actionable `primary` + `next` per asset kind, with the prefab FOUND by listing (a name collision suffixes the FOLDER while the prefab keeps the original stem, so string-building it misses); `audio.library.import`/`font.import` name their follow-up too. **Poly Pizza**: `x-auth-token` (Bearer 401s identically to no key), host allowlist, PascalCase response fields, the two ids (`PublicID` vs `ResourceID`), and — the big one — **all three filters are NUMERIC**: `Category` 0-11 in their array order, `License` 0=CC-BY/1=CC0 ("any" = omit), `Animated` 1/0. A string value is NaN and 400s; a lowercase param name is silently IGNORED and returns a full unfiltered page that looks like it worked. Plus the interactive `ModelPreview` (throttled, disposes its GLB, clip switching without re-downloading). No network, instant. |
| `npm run test:stats` | `engine.stats` (`src/engine/StatsSystem.js`): FPS is a COUNT of presented frames over a one-second window, not an EMA of `1000 / dt` (which overstated a hitching second by ~2×) and not a count of engine ticks (a `renderSuspended` wave used to report the full refresh rate for a frozen canvas). Also that the window ends at READ time, so a stopped loop decays to 0 instead of holding its last number, and the `PerfReadout` drift guard against `script-types/engine.d.ts`. No browser, instant. |
| `npm run test:math` | `engine.math` (`src/engine/math/`): the specific wrongness each function avoids — smoothing that is frame-rate independent, angle blends that take the short way, a seeded stream that replays, sphere sampling that is uniform, a ray from inside a volume reporting its exit, a ballistic solve that lands when you integrate it. Plus the **drift guard**: every member of the runtime `math` namespace must be declared in `script-types/engine.d.ts`, and `math` must reach all three of `import { math } from "engine"`, `engine.math` and `this.math`. No browser, ~1s. |
| `npm run smoke:script-rename` | A script file and its default-exported class keep the same name from either end (`scriptClassSync.js`): renaming the asset rewrites the class, renaming the class renames the file, other classes in the file are untouched, and open tabs + entity script slots follow. Needs a **fresh** `npx vite --port 5217`. |
| `npm run smoke:keyscope` | Keyboard ownership (`keyScope.js`): one context owns each key, the code editor keeps Ctrl+S/Ctrl+F/Delete, the app keeps Ctrl+P/Ctrl+B from inside it, and maximize is a double-click gesture that Escape does not undo. Needs a **fresh** `npx vite --port 5217`. |
| `npm run test:gi-src-surface` | SRC static surface attribution (`srcSurface.js`): a traced hit reads its own mesh's albedo, the stamp is deterministic across dispatches, the NEE emitter flag round-trips, a recolour costs no re-voxelize. Real occupancy field + real rays; race-sensitive, run 2-3×. |
| `npm run test:gi-src-shade` | SRC hit shading (`srcShade.js`) against `srcRef.js`'s `makeHitShader`. |
| `npm run test:gi-src-ref` | The SRC CPU mirror — no GPU, ~9s, the reference every SRC gate is diffed against. |
