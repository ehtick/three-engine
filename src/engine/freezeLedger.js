/**
 * THE FREEZE LEDGER — every main-thread block, with an owner.
 *
 * ⭐ WHY THIS EXISTS (docs/ZERO_FREEZE_PLAN.md §3 R5). Until this file, the
 * editor recorded nothing about its own freezes. Every one the user reported
 * — a 10-120 s boot, a 10 s click, a param change that hangs — was
 * reconstructed days later from console archaeology, and several of those
 * reconstructions were wrong (see the ledgers: "the reflect HOLD held a trace
 * that never ran", "the lit marker lied by 22 s"). A freeze the instrument
 * cannot name is a freeze nobody can fix, and a mean cannot see one:
 * `profile.cpuFrame` reports a healthy 14 ms for a drag with a 300 ms hitch
 * every second.
 *
 * WHAT IT IS. A `PerformanceObserver('longtask')` — the browser's own report
 * of "the main thread was blocked for N ms" — joined to a ring of ACTIVITY
 * SPANS the engine records as it works. The observer fires after the task, so
 * attribution is an overlap query against spans that are already closed:
 * nothing needs to guess, and nothing on the hot path allocates.
 *
 * SELF TIME, NOT TOTAL. Spans nest (`gi:rebuild` contains `gi:staticBvh`
 * contains `gpu:shaderModule`), so a naive overlap sum reports 300 % of the
 * task. Each span subtracts its direct children's total from its own, exactly
 * as a sampling profiler's self time works, and attribution reads `selfMs`.
 * A block therefore reads as ONE name plus the frames above it, which is what
 * "who froze the editor" means.
 *
 * COST WHEN NOTHING IS FREEZING. `begin`/`end` are two `performance.now()`
 * calls and a push/pop on a preallocated stack; a span shorter than
 * `MIN_SPAN_MS` is dropped without touching the ring. There is no allocation
 * per span and no string work until a report is read. The observer itself is
 * a browser-side thing that only calls back when the thread actually blocked.
 *
 * ⚠ THE ONE FAILURE MODE, same as StatsSystem's phase marks: an UNMARKED
 * block does not read as zero, it reads as `(unattributed)`. That is
 * deliberate — an honest hole beats a wrong name — but it means adding a
 * heavy new stage without a mark makes the ledger quietly less useful. Mark
 * the stage in the same commit that adds it.
 */

/** Spans shorter than this never reach the ring: a freeze is not built of them. */
import { WgslRegistry } from "./wgslStable.js";

const MIN_SPAN_MS = 0.4;

/** Ring capacity. ~4 s of a busy boot at 500 spans/s. */
const SPAN_RING = 4096;

/** Long tasks kept for `profile.freezes`, newest last. */
/** How many individual node-build causes to keep for per-block attribution. */
const BUILD_CAUSE_RING = 2000;
const TASK_RING = 200;

/** A task at or over this is worth a console line. */
const LOG_MS = 150;

/** At most this many console lines per window, so a bad boot stays readable. */
const LOG_BUDGET = 12;
const LOG_WINDOW_MS = 10_000;
/** How far back a synchronous pipeline creation can still be blamed for a
 * spanless block: an 80 s kernel compile parks the GPU process for 80 s. */
const STALL_LOOKBACK_MS = 90_000;
const SYNC_COMPILE_RING = 64;

const now = () => performance.now();

class FreezeLedger {
  constructor() {
    /**
     * Master switch. On for the editor, tests and harnesses; the player turns
     * it off before building its engine unless `?freezeLedger=1` (see
     * player/main.js). Read at renderer init: when off, the per-call device
     * and render wrappers are not installed at all, so flipping it on later
     * gets spans and long tasks but not the GPU-call rows.
     */
    this.enabled = true;
    /** Console lines for blocks over LOG_MS. */
    this.logging = true;

    // Span ring, struct-of-arrays so a span costs no object.
    this._names = new Array(SPAN_RING).fill(null);
    this._starts = new Float64Array(SPAN_RING);
    this._ends = new Float64Array(SPAN_RING);
    this._selves = new Float64Array(SPAN_RING);
    this._head = 0;
    this._filled = 0;

    // Open-span stack. `_stackChild[i]` accumulates the TOTAL ms of spans
    // closed inside frame i, which is what makes `selfMs` exclusive.
    this._stackName = [];
    this._stackStart = [];
    this._stackChild = [];

    /** Long tasks, each already attributed. */
    this.tasks = [];
    /** Totals since boot, so a session has a headline without a capture. */
    this.totals = { tasks: 0, ms: 0, worstMs: 0, over100: 0, over500: 0 };

    // Sync GPU-object creation counted per task window. These are the calls
    // that block without appearing in any JS profile (the driver parses WGSL
    // on the calling thread), so they are counted as well as spanned.
    this.gpu = { renderPipelines: 0, computePipelines: 0, shaderModules: 0, ms: 0, bytes: 0, writeBytes: 0, writes: 0, largestWrite: 0 };
    /**
     * What the GPU process may be busy with, kept ACROSS task windows: the
     * synchronous pipeline creations of the last `STALL_LOOKBACK_MS` and the
     * asynchronous ones still in flight. A block with no engine span and no
     * GPU call in it is the page's main thread waiting for the GPU process
     * (its command thread executes a sync `createRenderPipeline` in order, so
     * every later command — including the flow-control ack the renderer is
     * blocked on — queues behind the compile). Without this the 21.5 s block
     * of 2026-09-09 read `(unattributed) 21528` and nothing else.
     */
    this.syncCompileLog = [];
    this.asyncInFlight = new Map();
    /** Shader-module text registry (raw/canonical hashes); set by the GPU ledger. */
    this.wgsl = null;

    this._logCount = 0;
    this._logWindow = 0;
    this._observer = null;
    /** Boot timeline; see `bootStage`. */
    this.boot = { stages: [], t0: now(), openName: null, openAt: 0 };
  }

  // ---------------------------------------------------------------- spans

  /**
   * Open an activity span. Returns a token to pass to `end`; a falsy token
   * means the ledger was off and `end` is a no-op, so call sites never branch.
   *
   *     const t = freeze.begin("gi:staticBvh");
   *     try { ...  } finally { freeze.end(t); }
   */
  begin(name) {
    if (!this.enabled) return 0;
    const depth = this._stackName.length;
    this._stackName.push(name);
    this._stackStart.push(now());
    this._stackChild.push(0);
    // Token encodes the depth so a mismatched end cannot corrupt the stack.
    return depth + 1;
  }

  /** Close the span opened by `token`, and every span left open inside it. */
  end(token) {
    if (!token || !this.enabled) return;
    const depth = token - 1;
    // An early return or a throw between begin and end leaves inner spans
    // open. Closing them here (rather than asserting) keeps the ledger honest
    // through exactly the code paths that fail.
    while (this._stackName.length > depth) this.#pop();
  }

  #pop() {
    const t = now();
    const name = this._stackName.pop();
    const start = this._stackStart.pop();
    const childMs = this._stackChild.pop();
    const total = t - start;
    const parent = this._stackChild.length - 1;
    if (parent >= 0) this._stackChild[parent] += total;
    if (total < MIN_SPAN_MS) return;
    const i = this._head;
    this._names[i] = name;
    this._starts[i] = start;
    this._ends[i] = t;
    this._selves[i] = Math.max(0, total - childMs);
    this._head = (i + 1) % SPAN_RING;
    if (this._filled < SPAN_RING) this._filled++;
  }

  /** `begin`/`end` around a synchronous call, with the return value passed through. */
  run(name, fn) {
    const t = this.begin(name);
    try {
      return fn();
    } finally {
      this.end(t);
    }
  }

  /** Same, for an awaited call. Only the synchronous head is attributed. */
  async runAsync(name, fn) {
    const t = this.begin(name);
    try {
      return await fn();
    } finally {
      this.end(t);
    }
  }

  /**
   * Record a span that already happened (a measurement taken elsewhere).
   * Used for work timed by another instrument — the compile wave's per-object
   * timings, a worker round trip — so one report covers both.
   */
  note(name, startMs, endMs = now()) {
    if (!this.enabled || endMs - startMs < MIN_SPAN_MS) return;
    const i = this._head;
    this._names[i] = name;
    this._starts[i] = startMs;
    this._ends[i] = endMs;
    this._selves[i] = endMs - startMs;
    this._head = (i + 1) % SPAN_RING;
    if (this._filled < SPAN_RING) this._filled++;
  }

  // ------------------------------------------------------------ attribution

  /**
   * Owners of the window [from, to), by self time, largest first.
   * `(unattributed)` is the remainder — real time in code nothing marks.
   */
  attribute(from, to, limit = 4) {
    const byName = new Map();
    let attributed = 0;
    for (let k = 0; k < this._filled; k++) {
      const i = (this._head - 1 - k + SPAN_RING * 2) % SPAN_RING;
      const end = this._ends[i];
      if (end < from) {
        // The ring is chronological going backwards; once a span ends before
        // the window there is nothing older that can overlap it.
        break;
      }
      const start = this._starts[i];
      if (start >= to) continue;
      // Self time is not a span on the timeline (children were subtracted), so
      // scale it by the fraction of the span that lies inside the window.
      const total = end - start;
      const inside = Math.min(end, to) - Math.max(start, from);
      if (inside <= 0 || total <= 0) continue;
      const ms = this._selves[i] * (inside / total);
      if (ms < 0.05) continue;
      byName.set(this._names[i], (byName.get(this._names[i]) ?? 0) + ms);
      attributed += ms;
    }
    const owners = [...byName.entries()]
      .map(([name, ms]) => ({ name, ms: +ms.toFixed(1) }))
      .sort((a, b) => b.ms - a.ms)
      .slice(0, limit);
    const rest = to - from - attributed;
    if (rest > 1 && rest > (to - from) * 0.15) {
      owners.push({ name: "(unattributed)", ms: +rest.toFixed(1) });
      owners.sort((a, b) => b.ms - a.ms);
    }
    return owners;
  }

  /**
   * Record one node-graph build's cause at the time it happened, so a BLOCK
   * can name the reason it froze rather than leaving the reader to correlate
   * it against session-wide totals.
   *
   * The distinction matters because the two readings disagree: session totals
   * on the user's Pool scene put `material key: side` on top, but that is 40
   * builds spread over the whole boot, while ONE 724 ms block is what the
   * user actually feels. Without this, "the biggest cause" and "the cause of
   * the freeze" are silently assumed to be the same thing.
   */
  noteBuildCause(at, cause, ms) {
    const ring = (this.buildCauseLog ??= []);
    ring.push({ at, cause, ms });
    if (ring.length > BUILD_CAUSE_RING) ring.splice(0, ring.length - BUILD_CAUSE_RING);
  }

  /** The build causes that fired inside one window, largest first. */
  #causesWithin(from, to) {
    const ring = this.buildCauseLog;
    if (!ring?.length) return null;
    const byCause = new Map();
    for (const entry of ring) {
      if (entry.at < from || entry.at > to) continue;
      const row = byCause.get(entry.cause) ?? { name: entry.cause, count: 0, ms: 0 };
      row.count++;
      row.ms += entry.ms;
      byCause.set(entry.cause, row);
    }
    if (!byCause.size) return null;
    return [...byCause.values()]
      .map((row) => ({ ...row, ms: +row.ms.toFixed(0) }))
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 4);
  }

  /** Called by the observer for one long task. */
  recordTask(start, duration) {
    const owners = this.attribute(start, start + duration);
    const causes = this.#causesWithin(start, start + duration);
    // `writeBytes` rides along only when it is large: a `queue.writeBuffer`
    // that blocked for 178 ms (2026-09-09) is either a real copy of that many
    // bytes or the wire's back-pressure, and the byte count is what tells them
    // apart.
    // ⚠⚠ THESE COUNTERS ARE NOT "INSIDE THIS TASK" — THEY ARE "SINCE THE LAST
    // LONG TASK", because that is the only moment anything resets them (a
    // PerformanceObserver only reports tasks over the 50 ms threshold, so
    // there is no hook at the start of an ordinary one). Read against a block
    // they look like the block's own work, and they are not: on 2026-09-12 a
    // 60 ms `editor:zoomProbe` block reported "484 MB written in 123 097
    // write(s)", which reads as a catastrophic per-frame upload and is in fact
    // SEVEN SECONDS of ordinary 60 fps rendering — ~293 writes and ~1.15 MB a
    // frame, which is unremarkable. An hour went into chasing that before the
    // reset was checked.
    //
    // `windowMs` is therefore mandatory alongside them: divide by it before
    // believing any of it. The pipeline/module counts have the same caveat,
    // but they are far smaller numbers and a compile anywhere in the window is
    // still the thing that made the GPU process busy, which is what they are
    // read for.
    const windowMs = +(start + duration - (this._gpuSince ?? this.boot.t0)).toFixed(0);
    const gpu = this.gpu.renderPipelines || this.gpu.computePipelines || this.gpu.shaderModules
      || this.gpu.writeBytes >= 1 << 20
      ? { ...this.gpu, windowMs }
      : null;
    this.gpu = { renderPipelines: 0, computePipelines: 0, shaderModules: 0, ms: 0, bytes: 0, writeBytes: 0, writes: 0, largestWrite: 0 };
    this._gpuSince = start + duration;
    const task = {
      at: +start.toFixed(0),
      ms: +duration.toFixed(0),
      sinceBootMs: +(start - this.boot.t0).toFixed(0),
      owners,
      // Why the material graphs inside THIS block were rebuilt. Absent when
      // the block contained no node build at all.
      causes,
      gpu,
    };
    // A block that nothing marked: name what the GPU process was doing, so
    // the reader can tell "a missing span" from "waiting on the driver".
    const unattributed = owners.find((o) => o.name === "(unattributed)")?.ms ?? 0;
    if (unattributed >= duration * 0.5 && unattributed >= 50) {
      const load = this.gpuLoadAt(start);
      if (load) task.gpuLoad = load;
    }
    this.tasks.push(task);
    if (this.tasks.length > TASK_RING) this.tasks.splice(0, this.tasks.length - TASK_RING);
    this.totals.tasks++;
    this.totals.ms += duration;
    if (duration > this.totals.worstMs) this.totals.worstMs = duration;
    if (duration >= 100) this.totals.over100++;
    if (duration >= 500) this.totals.over500++;
    if (this.logging && duration >= LOG_MS) this.#log(task);
    return task;
  }

  #log(task) {
    const t = now();
    if (t - this._logWindow > LOG_WINDOW_MS) { this._logWindow = t; this._logCount = 0; }
    this._logCount++;
    if (this._logCount === LOG_BUDGET + 1) {
      console.warn(`[freeze] …more blocks this window; read profile.freezes for the rest`);
      return;
    }
    if (this._logCount > LOG_BUDGET) return;
    const who = task.owners.map((o) => `${o.name} ${o.ms}`).join(", ") || "unattributed";
    const gpu = task.gpu
      ? ` [sync gpu: ${task.gpu.renderPipelines}r/${task.gpu.computePipelines}c/${task.gpu.shaderModules}m` +
        `${task.gpu.bytes ? `, ${(task.gpu.bytes / 1024).toFixed(0)}kB WGSL` : ""}` +
        // "over the last Ns", never "in this block" — see `recordTask`.
        `${task.gpu.writeBytes >= 1 << 20 ? `, ${(task.gpu.writeBytes / 1048576).toFixed(1)}MB written in ${task.gpu.writes} write(s) over the last ${(task.gpu.windowMs / 1000).toFixed(1)}s, largest ${(task.gpu.largestWrite / 1048576).toFixed(1)}MB` : ""}]`
      : "";
    const why = task.causes?.length
      ? ` [rebuilt: ${task.causes.map((c) => `${c.name} x${c.count}`).join(", ")}]`
      : "";
    const load = task.gpuLoad
      ? ` [GPU process busy? ${task.gpuLoad.syncRecent.count} sync pipeline(s) / ${task.gpuLoad.syncRecent.kB}kB WGSL in the last ${task.gpuLoad.syncRecent.windowS}s`
        + `${task.gpuLoad.syncRecent.names.length ? `: ${task.gpuLoad.syncRecent.names.join(", ")}` : ""}`
        + `${task.gpuLoad.asyncInFlight.count ? `; ${task.gpuLoad.asyncInFlight.count} async / ${task.gpuLoad.asyncInFlight.kB}kB still compiling` : ""}]`
      : "";
    console.warn(`[freeze] ${task.ms} ms — ${who}${gpu}${why}${load}`);
  }

  /** A synchronous pipeline creation, remembered past its own task window. */
  noteSyncCompile(at, kind, name, bytes) {
    const log = this.syncCompileLog;
    log.push({ at, kind, name, bytes });
    if (log.length > SYNC_COMPILE_RING) log.splice(0, log.length - SYNC_COMPILE_RING);
  }

  /**
   * What the GPU process had been handed before `at`: the sync pipelines of
   * the look-back window (by name, so the module that owns them is the
   * answer) and the async ones still in flight (they compile on the driver's
   * worker threads, but a saturated pool is still a busy GPU process).
   */
  gpuLoadAt(at) {
    const from = at - STALL_LOOKBACK_MS;
    const recent = this.syncCompileLog.filter((c) => c.at >= from && c.at <= at);
    let asyncCount = 0;
    let asyncBytes = 0;
    for (const entry of this.asyncInFlight.values()) {
      if (entry.at <= at) { asyncCount++; asyncBytes += entry.bytes; }
    }
    if (!recent.length && !asyncCount) return null;
    const byName = new Map();
    for (const c of recent) {
      const key = c.name || c.kind;
      byName.set(key, (byName.get(key) ?? 0) + 1);
    }
    const names = [...byName.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([name, count]) => (count > 1 ? `${name} x${count}` : name));
    const windowS = recent.length ? Math.max(1, Math.round((at - recent[0].at) / 1000)) : 0;
    return {
      syncRecent: {
        count: recent.length,
        kB: +(recent.reduce((sum, c) => sum + (c.bytes || 0), 0) / 1024).toFixed(0),
        windowS,
        names,
      },
      asyncInFlight: { count: asyncCount, kB: +(asyncBytes / 1024).toFixed(0) },
    };
  }

  /** The report `profile.freezes` returns. */
  read({ limit = 20, sinceMs = 0 } = {}) {
    const from = this.boot.t0 + sinceMs;
    const tasks = this.tasks.filter((t) => t.at >= from);
    const byOwner = new Map();
    for (const task of tasks) {
      for (const owner of task.owners) {
        const row = byOwner.get(owner.name) ?? { name: owner.name, ms: 0, blocks: 0 };
        row.ms += owner.ms;
        row.blocks++;
        byOwner.set(owner.name, row);
      }
    }
    return {
      observing: !!this._observer,
      totals: {
        ...this.totals,
        ms: +this.totals.ms.toFixed(0),
        worstMs: +this.totals.worstMs.toFixed(0),
      },
      worst: tasks.slice().sort((a, b) => b.ms - a.ms).slice(0, limit),
      recent: tasks.slice(-limit),
      byOwner: [...byOwner.values()]
        .map((r) => ({ ...r, ms: +r.ms.toFixed(0) }))
        .sort((a, b) => b.ms - a.ms)
        .slice(0, limit),
      // Every TSL node-graph build this session. This is three's
      // `nodeBuilder.build()` — the graph walk and WGSL codegen — and it runs
      // SYNCHRONOUSLY inside whatever frame first needs the program.
      nodeBuilds: [...(this.nodeBuilds?.values() ?? [])]
        .map((r) => ({ ...r, ms: +r.ms.toFixed(0), worstMs: +r.worstMs.toFixed(0), meanMs: +(r.ms / r.count).toFixed(1) }))
        .sort((a, b) => b.ms - a.ms)
        .slice(0, limit),
      // WHY those builds happened. `first compile` is the unavoidable one —
      // every material is built once. Anything else is a scene-wide input to
      // three's dynamic cache key MOVING, which invalidates every material at
      // once: `fog` is `scene.fogNode` (the water medium), `lights` is the
      // light set changing, `context` is a new render target or pass.
      nodeBuildCauses: [...(this.nodeBuildCauses?.values() ?? [])]
        .map((r) => ({
          name: r.name,
          count: r.count,
          ms: +r.ms.toFixed(0),
          // The names, not just how many: a cause is only actionable once you
          // know WHICH material is paying it. `side` on a glass material is a
          // look decision the author can make; `side` on a name they do not
          // recognise is a bug hunt.
          materials: [...r.materials].slice(0, 6).join(", ") + (r.materials.size > 6 ? `, +${r.materials.size - 6}` : ""),
        }))
        .sort((a, b) => b.ms - a.ms)
        .slice(0, limit),
      // Which pipelines were built SYNCHRONOUSLY this session, by name. A
      // count says a frame blocked; this says which module to fix.
      syncPipelines: [...(this.syncPipelines?.values() ?? [])]
        .map((r) => ({ ...r, ms: +r.ms.toFixed(1) }))
        .sort((a, b) => b.ms - a.ms)
        .slice(0, limit),
      // The spanless blocks, split by whether the GPU process had been handed
      // a synchronous compile shortly before. `waitingOnGpuMs` is the part of
      // `(unattributed)` this session that has a named driver-side cause; the
      // remainder is a missing span or the browser's own work.
      stalls: (() => {
        let waiting = 0;
        let waitingBlocks = 0;
        let unmarked = 0;
        for (const task of tasks) {
          const un = task.owners.find((o) => o.name === "(unattributed)")?.ms ?? 0;
          if (!un) continue;
          if (task.gpuLoad?.syncRecent?.count) { waiting += un; waitingBlocks++; } else unmarked += un;
        }
        return { waitingOnGpuMs: +waiting.toFixed(0), waitingBlocks, unmarkedMs: +unmarked.toFixed(0) };
      })(),
      // Whether the browser's compiled-shader disk cache can serve this boot's
      // shader text next time. See wgslStable.js.
      wgsl: this.wgsl ? this.wgsl.summary() : null,
    };
  }

  /**
   * Empty the ledger so the next read measures ONE action.
   *
   * ⚠ The counters go too. They did not at first, and that is a trap with the
   * shape this project keeps meeting: a before/after A/B would have cleared the
   * blocks, left `nodeBuilds` and `syncPipelines` carrying the whole session,
   * and read the "after" arm as no better — with the numbers looking perfectly
   * plausible. Everything a report shows is cleared together or none of it is.
   */
  clear() {
    this.tasks.length = 0;
    this.totals = { tasks: 0, ms: 0, worstMs: 0, over100: 0, over500: 0 };
    this.nodeBuilds?.clear();
    this.nodeBuildCauses?.clear();
    this.buildCauseLog = [];
    this.syncPipelines?.clear();
    this.gpu = { renderPipelines: 0, computePipelines: 0, shaderModules: 0, ms: 0, bytes: 0, writeBytes: 0, writes: 0, largestWrite: 0 };
    // The compile history goes too, for the same reason: a cleared ledger
    // must not blame the next block on a compile from before the A/B began.
    this.syncCompileLog.length = 0;
  }

  // ------------------------------------------------------------- boot table

  /**
   * Close the open boot stage and open `name`. `null` closes without opening.
   * The boot is the one timeline where a stage's WALL time (not its self time)
   * is the number that matters, because stages overlap with GPU work on
   * purpose — so this is a separate, tiny record rather than a span.
   */
  bootStage(name, detail = null) {
    const t = now();
    if (this.boot.openName) {
      const stage = { name: this.boot.openName, ms: +(t - this.boot.openAt).toFixed(0), at: +(this.boot.openAt - this.boot.t0).toFixed(0) };
      if (this.boot.openDetail) stage.detail = this.boot.openDetail;
      this.boot.stages.push(stage);
    }
    this.boot.openName = name;
    this.boot.openAt = t;
    this.boot.openDetail = detail;
  }

  /** A stage that measured itself elsewhere (GI's own logs, an awaited load). */
  bootMark(name, ms, detail = null) {
    const stage = { name, ms: +ms.toFixed(0), at: +(now() - this.boot.t0 - ms).toFixed(0) };
    if (detail) stage.detail = detail;
    this.boot.stages.push(stage);
  }

  readBoot() {
    const stages = this.boot.stages.slice();
    if (this.boot.openName) {
      stages.push({ name: this.boot.openName, ms: +(now() - this.boot.openAt).toFixed(0), at: +(this.boot.openAt - this.boot.t0).toFixed(0), open: true });
    }
    return {
      sinceLoadMs: +(now() - this.boot.t0).toFixed(0),
      stages,
      blocked: {
        tasks: this.totals.tasks,
        ms: +this.totals.ms.toFixed(0),
        worstMs: +this.totals.worstMs.toFixed(0),
      },
    };
  }

  /** One printable table, logged at "Editor ready" and at first light. */
  logBoot(label) {
    const boot = this.readBoot();
    const rows = boot.stages
      .filter((s) => s.ms >= 5)
      .map((s) => `    ${String(s.ms).padStart(6)} ms  ${s.name}${s.detail ? `  (${s.detail})` : ""}`)
      .join("\n");
    console.log(
      `[boot] ${label} at ${boot.sinceLoadMs} ms — main thread blocked ${boot.blocked.ms} ms ` +
      `in ${boot.blocked.tasks} long task(s), worst ${boot.blocked.worstMs} ms\n${rows}`,
    );
  }
}

/**
 * The one ledger. A module singleton rather than an engine field because the
 * things that freeze the editor are not all inside the engine — the scene
 * parse, the React mirror and the command bus are editor-side, and a boot
 * table that could not see them would describe half a boot.
 */
export const freeze = new FreezeLedger();

/**
 * Start observing. Idempotent, safe in any host (a missing PerformanceObserver
 * or an unsupported `longtask` type leaves the spans working and the tasks
 * empty, which still powers the boot table).
 */
export function installFreezeObserver() {
  if (freeze._observer || typeof PerformanceObserver === "undefined") return false;
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) freeze.recordTask(entry.startTime, entry.duration);
    });
    observer.observe({ entryTypes: ["longtask"] });
    freeze._observer = observer;
    return true;
  } catch {
    return false;
  }
}

/**
 * Span three's per-material NODE GRAPH BUILD — the other half of "a material
 * compiles for an enormous time", and the half no existing instrument sees.
 *
 * `Nodes.getForRender(renderObject)` misses its cache the first time a program
 * is needed and runs `nodeBuilder.build()`: the TSL graph walk and the WGSL
 * codegen, measured at ~80-110 ms per GI-injected lit variant. It runs
 * SYNCHRONOUSLY inside `renderer.render`, so it lands in the freeze ledger as
 * `frame:renderEncode` with no further detail — indistinguishable from the
 * driver compile that follows it, which has a completely different fix. This
 * splits them.
 *
 * The span carries the material's name, so the answer to "which material
 * froze the editor" is a name in the console line.
 */
export function installNodeBuildLedger(renderer) {
  const nodes = renderer?._nodes;
  if (!nodes || typeof nodes.getForRender !== "function" || nodes.__freezeLedgerInstalled) return false;
  nodes.__freezeLedgerInstalled = true;
  // Per-material totals, so a report can say "31 builds of MeshPhysicalNodeMaterial,
  // 14 ms each" rather than "438 ms somewhere in three". The COUNT is the part
  // that decides which fix applies: many cheap builds is a variant-count
  // problem, few expensive ones is a graph-size problem, and they have nothing
  // in common.
  const builds = (freeze.nodeBuilds ??= new Map());
  const causes = (freeze.nodeBuildCauses ??= new Map());
  const original = nodes.getForRender.bind(nodes);

  /**
   * WHY a build happened, which the count alone cannot say.
   *
   * three keys its node-builder cache on `RenderObject.getCacheKey()`, and half
   * of that is `getDynamicCacheKey()` — a key recomputed EVERY DRAW out of
   * scene-wide state: the lights node, the environment node, `scene.fogNode`,
   * the shadow-map mode, the renderer's context node. Every material in the
   * scene shares those inputs, so one of them changing does not invalidate one
   * program — it invalidates ALL of them, and the editor spends half a second
   * rebuilding graphs for objects nobody touched.
   *
   * That is the difference between "59 builds" and a fix. Sampling the same
   * inputs three does and reporting which one MOVED turns a wave into a name:
   * `fog` is the water medium arming its underwater term, `lights` is a light
   * being added or toggled, `context` is a new render target or pass.
   */
  const sampleKeyInputs = (renderObject) => {
    const scene = renderObject?.scene;
    const read = (fn) => { try { return fn(); } catch { return "?"; } };
    return {
      lights: read(() => renderObject?.lightsNode?.getCacheKey?.(true) ?? "-"),
      fog: read(() => nodes.getFogNode?.(scene)?.getCacheKey?.() ?? "-"),
      environment: read(() => nodes.getEnvironmentNode?.(scene)?.getCacheKey?.() ?? "-"),
      shadowMap: read(() => `${renderer.shadowMap?.enabled}/${renderer.shadowMap?.type}`),
      lighting: read(() => String(renderer.lighting?.enabled)),
      context: read(() => `${renderer.contextNode?.id}/${renderer.contextNode?.version}`),
      // `scene.backgroundNode` is the sky; its cache key is what three's
      // `Background.update` diffs to decide whether to re-mint `Background
      // .material`. Sampled because a day/night sky is the one node in the
      // scene most likely to re-key per frame. (`getCacheKey()`, no force:
      // the same call three makes.)
      background: read(() => scene?.backgroundNode?.getCacheKey?.() ?? "-"),
      // ⭐ THE TWO HALVES three ACTUALLY keys the render object on, whole.
      // Every named input above is a GUESS at what might move; these are the
      // ground truth. When nothing named moved but `dynHalf` did, the cause is
      // a dynamic input this list does not sample yet (a fog node, the output
      // target's multiview flag, a clipping context) — and the report says
      // `dynHalf` instead of `?`, which is the difference between "I cannot
      // say" and "look in getDynamicCacheKey". `matHalf` likewise localises an
      // unnamed material-property fork. This is what turns the Foliage scene's
      // 10 000 `material key: ?` rows into a named driver.
      dynHalf: read(() => String(renderObject?.getDynamicCacheKey?.() ?? "-")),
      matHalf: read(() => String(renderObject?.getMaterialCacheKey?.() ?? "-")),
    };
  };
  // The key inputs as they stood the last time THIS MATERIAL INSTANCE was
  // built, keyed on `material.id` — three's per-instance counter.
  //
  // ⚠ NOT THE LABEL, and the first cut of this got it wrong in a way that
  // read plausibly: a label is `material.name || material.type`, so all 28
  // unnamed MeshPhysicalNodeMaterials in a scene share one. Keyed that way,
  // 27 perfectly ordinary FIRST builds of 27 different materials reported as
  // re-mints of one, and the section's largest row — the one a reader would
  // go fix — was pure measurement error. A cause table that cannot tell "this
  // material had never been built" from "this material was invalidated" is
  // worse than no cause table, because it looks like an answer.
  const lastInputsById = new Map();

  /**
   * The material's OWN key, field by field, the way three folds it.
   *
   * `RenderObject.getMaterialCacheKey()` walks every enumerable property of
   * the material and hashes it, so a rebuild with no scene-wide input moving
   * means one of those properties changed. A hash cannot say which; this can,
   * and the answer is the difference between "materials rebuild, that is how
   * it is" and a named thing to stop doing — a texture landing after the
   * material was already drawn, a node slot wired a frame late, a flag toggled
   * per frame. The filter and the number/texture formatting mirror three's
   * exactly (r185 RenderObject.js), or the diff reports fields three ignores.
   */
  const SKIP_PROPERTY = /^(is[A-Z]|_)|^(visible|version|uuid|name|opacity|userData)$/;
  /**
   * A render context, named rather than numbered.
   *
   * `material key: renderContext` was the second-largest cause on the user's
   * Sponza — EVERY scene-wide change (a light toggle, sky lighting) produced a
   * `lights`/`environment` wave and then a near-identical second wave over the
   * same 6-8 materials, ~100-220 ms, because each of them has one built graph
   * PER CONTEXT and a scene-wide input invalidates all of them. Both builds
   * are legitimate given two contexts; the question is what the second context
   * IS, and a bare `context.id` cannot say. An hour went into guessing it from
   * the outside (the postprocess MRT — ruled out by disabling it and watching
   * the doubling survive; `allowOverride` — ruled out, nothing in this repo
   * sets it). The instrument should have answered it, so now it does.
   */
  const renderContextLabel = (context) => {
    if (!context) return "none";
    const size = context.width && context.height ? `${context.width}x${context.height}` : "?";
    const samples = context.sampleCount > 1 ? `msaa${context.sampleCount}` : "";
    // `textures[0].name` is what the draw-call audit labels a target by; fall
    // back to whether this context has a render target at all (the canvas
    // context has none), so the two are always distinguishable by eye.
    const name = context.textures?.[0]?.name || context.renderTarget?.texture?.name
      || (context.renderTarget ? "rt" : "canvas");
    return `${name}:${size}${samples}#${context.id ?? "?"}`;
  };
  const materialFields = (material, renderObject) => {
    const fields = new Map();
    if (!material) return fields;
    const read = (key, fn) => { try { fields.set(key, String(fn())); } catch { fields.set(key, "?"); } };
    // ⚠ THE REST OF three's KEY, not just the material's plain properties.
    // `getMaterialCacheKey` also folds in the clipping context, the geometry
    // key, skeleton size, instancing, the RENDER CONTEXT id and
    // `receiveShadow` — and `customProgramCacheKey()`'s RETURN VALUE, which is
    // where node identity and GI's roughness bucket enter.
    //
    // Without these the diff reported `material key: ?` — "something forked and
    // I cannot say what" — which is the least useful answer an attribution can
    // give. It came up on the exact case being chased (a mesh vanishing on
    // select), so it is closed here rather than worked around.
    read("customProgramCacheKey", () => material.customProgramCacheKey?.() ?? "");
    if (renderObject) {
      read("renderContext", () => renderContextLabel(renderObject.context));
      read("clippingContext", () => renderObject.clippingContextCacheKey);
      read("geometry", () => renderObject.getGeometryCacheKey?.());
      read("receiveShadow", () => renderObject.object?.receiveShadow);
      read("bones", () => renderObject.object?.skeleton?.bones?.length ?? 0);
      read("instanced", () => (renderObject.object?.isInstancedMesh ? renderObject.object.uuid : 0));
    }
    try {
      for (const property in material) {
        if (SKIP_PROPERTY.test(property)) continue;
        const value = material[property];
        // Read explicitly above by CALLING it; stringifying the function shows
        // only the wrapper's source, which never changes even when GI's bucket
        // flips the value it returns.
        if (typeof value === "function") continue;
        let valueKey;
        if (value === null || value === undefined) valueKey = String(value);
        else if (typeof value === "number") valueKey = property === "side" ? String(value) : (value !== 0 ? "1" : "0");
        else if (typeof value === "object") valueKey = value.isTexture ? `tex:${value.mapping},${value.magFilter},${value.minFilter},${value.wrapS},${value.wrapT}` : "{}";
        else valueKey = String(value);
        fields.set(property, valueKey);
      }
    } catch { /* a getter that throws mid-rebuild is not worth losing the row over */ }
    return fields;
  };
  const lastFieldsById = new Map();

  // `nodeBuilderCache` is three's own map; a hit means no build happened, and
  // spanning a hit would bury the misses under thousands of 0 ms rows.
  nodes.getForRender = function (renderObject) {
    if (!freeze.enabled) return original(renderObject);
    const cache = this.nodeBuilderCache;
    const hit = cache ? cache.has(renderObject.initialCacheKey) : false;
    if (hit) return original(renderObject);
    const material = renderObject?.material;
    const label = material?.name || material?.type || "?";
    const token = freeze.begin(`material:nodeBuild ${label}`);
    const t0 = now();
    try {
      return original(renderObject);
    } finally {
      freeze.end(token);
      const ms = now() - t0;
      const row = builds.get(label) ?? { name: label, count: 0, ms: 0, worstMs: 0 };
      row.count++;
      row.ms += ms;
      if (ms > row.worstMs) row.worstMs = ms;
      builds.set(label, row);

      const inputs = sampleKeyInputs(renderObject);
      const id = material?.id ?? material?.uuid ?? label;
      const before = lastInputsById.get(id);
      lastInputsById.set(id, inputs);
      const fields = materialFields(material, renderObject);
      const beforeFields = lastFieldsById.get(id);
      lastFieldsById.set(id, fields);
      const changedFields = beforeFields
        ? [...fields.keys()].filter((key) => fields.get(key) !== beforeFields.get(key))
          .concat([...beforeFields.keys()].filter((key) => !fields.has(key)))
          .sort()
        : [];
      // Every material must be built ONCE, and no amount of work removes that.
      // A build of a material that was never built is `first compile`; a
      // SECOND build of the same material is a re-mint, and the cause is
      // whichever shared input moved since its last one. `material variant` is
      // the honest answer when nothing shared moved — the material's own key
      // forked (a node slot, a define, a new instance), which is legitimate
      // and is nobody's bug.
      let cause;
      if (!before) {
        cause = "first compile";
      } else {
        const moved = Object.keys(inputs).filter((field) => inputs[field] !== before[field]);
        // This exact material was built before and no shared input moved, so
        // its OWN key forked. Name the fields that moved: a material whose
        // `map` went null → texture was DRAWN BEFORE IT WAS READY, and that
        // first build was pure waste.
        cause = moved.length ? moved.join("+") : `material key: ${changedFields.slice(0, 4).join(",") || "?"}`;
        // NAME THE TWO CONTEXTS. Without this the row reads
        // `material key: renderContext` — true, and useless: it says a
        // material is drawn through more than one context without saying
        // which, and the fix (stop drawing it through the second one, or make
        // the second one share a key) needs exactly that. Contexts are pooled
        // by (scene, camera, target), so the set is small and this cannot
        // explode the cause table.
        if (!moved.length && changedFields.includes("renderContext")) {
          cause += ` (${beforeFields.get("renderContext")} → ${fields.get("renderContext")})`;
        }
      }
      freeze.noteBuildCause(t0, cause, ms);
      const causeRow = causes.get(cause) ?? { name: cause, count: 0, ms: 0, materials: new Set() };
      causeRow.count++;
      causeRow.ms += ms;
      causeRow.materials.add(label);
      causes.set(cause, causeRow);
    }
  };
  return true;
}

/**
 * Count and span the synchronous GPU-object creation a JS profile cannot see.
 *
 * ⭐ THE CLASS THIS EXISTS FOR: `createShaderModule` parses and validates a
 * material's 180-250 kB of WGSL ON THE CALLING THREAD. It lands in the
 * profiler as "(program)" with no stack, so three sessions of this project
 * attributed those blocks to whatever JS happened to be on the stack. Here
 * they are their own spans, and their count rides every long task's report.
 */
export function installGpuCallLedger(device) {
  if (!device || device.__freezeLedgerInstalled) return false;
  device.__freezeLedgerInstalled = true;

  // module → WGSL length, so a pipeline can report the size of the shader it
  // is compiling. The descriptor carries a GPUShaderModule, not the source.
  const moduleBytes = new WeakMap();

  /**
   * Who compiled synchronously, and how big it was. A count alone says "41
   * compute pipelines blocked a frame" and leaves you guessing which module
   * owns them; this names them, which is the difference between a finding and
   * a lead.
   */
  const offenders = new Map();
  freeze.syncPipelines = offenders;

  const describe = (descriptor, stage) => {
    const label = descriptor?.label;
    if (label) return String(label).slice(0, 80);
    const entry = stage?.entryPoint;
    const mod = stage?.module;
    const bytes = mod ? moduleBytes.get(mod) : 0;
    return `${entry ?? "?"}${bytes ? ` (${(bytes / 1024).toFixed(0)}kB)` : ""}`;
  };

  const wrap = (method, name, counter, meta) => {
    const original = device[method];
    if (typeof original !== "function") return;
    device[method] = function (descriptor, ...rest) {
      if (!freeze.enabled) return original.call(this, descriptor, ...rest);
      const t0 = now();
      const token = freeze.begin(name);
      try {
        return original.call(this, descriptor, ...rest);
      } finally {
        freeze.end(token);
        const ms = now() - t0;
        freeze.gpu[counter]++;
        freeze.gpu.ms += ms;
        const info = meta?.(descriptor);
        if (info) {
          freeze.gpu.bytes += info.bytes ?? 0;
          const key = `${counter}:${info.name}`;
          const row = offenders.get(key) ?? { kind: counter, name: info.name, count: 0, ms: 0, bytes: info.bytes ?? 0 };
          row.count++;
          row.ms += ms;
          offenders.set(key, row);
          // A synchronous PIPELINE parks the GPU process's command thread for
          // its whole driver compile — long after this call returned. Keep it,
          // sized by its shader text, so a later spanless block can be read.
          if (counter !== "shaderModules") freeze.noteSyncCompile(t0, counter, info.name, info.bytes ?? 0);
        }
      }
    };
  };

  /** The WGSL bytes a pipeline descriptor compiles (both stages, or the one). */
  const pipelineBytes = (d) => {
    let bytes = 0;
    for (const stage of [d?.vertex, d?.fragment, d?.compute]) {
      const mod = stage?.module;
      if (mod) bytes += moduleBytes.get(mod) ?? 0;
    }
    return bytes;
  };

  wrap("createShaderModule", "gpu:shaderModule", "shaderModules", (d) => {
    const bytes = d?.code?.length ?? 0;
    return { name: null, bytes };
  });
  wrap("createRenderPipeline", "gpu:renderPipeline(sync)", "renderPipelines", (d) => ({
    name: describe(d, d?.fragment ?? d?.vertex),
    bytes: pipelineBytes(d),
  }));
  wrap("createComputePipeline", "gpu:computePipeline(sync)", "computePipelines", (d) => ({
    name: describe(d, d?.compute),
    bytes: pipelineBytes(d),
  }));

  // ⭐ THE **ASYNC** PIPELINE CALLS BLOCK TOO, AND THEY WERE NOT MEASURED.
  //
  // `createRenderPipelineAsync` returns a promise, which reads as "this does
  // not block" — and that reading is why `(unattributed)` stayed the largest
  // owner of every boot measured on 2026-09-07 (~1.1 s across ~11 blocks).
  // The promise only covers the DRIVER's compile. Everything before it — WGSL
  // parsing, reflection, layout validation — runs synchronously on the calling
  // thread inside the call, and the blocks in question were creating pipelines
  // over 380-980 kB of WGSL while the wrapped SYNC calls in them accounted for
  // 1.5 ms.
  //
  // Only the call itself is spanned, never the promise: charging a block for
  // the driver's own threads would be the opposite error, and this project has
  // made it before (a boot probe that timestamped console lines at receipt
  // time turned a 7 s boot into a reported 21.7 s).
  // In flight until the driver settles the promise — the count a spanless
  // block reads to say whether the GPU process was saturated. NOT only
  // instrumentation: asyncRenderPipelines' busy gate and the viewport read
  // `asyncInFlight`, so it is kept with the ledger off too.
  const trackInFlight = (result, ticket) => {
    if (!result || typeof result.then !== "function") return;
    freeze.asyncInFlight.set(ticket, ticket);
    const done = () => { freeze.asyncInFlight.delete(ticket); };
    try { result.then(done, done); } catch { freeze.asyncInFlight.delete(ticket); }
  };
  const wrapAsync = (method, name, counter, meta) => {
    const original = device[method];
    if (typeof original !== "function") return;
    device[method] = function (descriptor, ...rest) {
      if (!freeze.enabled) {
        const result = original.call(this, descriptor, ...rest);
        trackInFlight(result, { at: now(), bytes: 0, name });
        return result;
      }
      const t0 = now();
      const token = freeze.begin(name);
      let result;
      try {
        result = original.call(this, descriptor, ...rest);
        return result;
      } finally {
        freeze.end(token);
        const ms = now() - t0;
        freeze.gpu[counter]++;
        freeze.gpu.ms += ms;
        const info = meta?.(descriptor);
        if (info) {
          const key = `${counter}:${info.name}`;
          const row = offenders.get(key) ?? { kind: counter, name: info.name, count: 0, ms: 0, bytes: 0 };
          row.count++;
          row.ms += ms;
          offenders.set(key, row);
        }
        trackInFlight(result, { at: t0, bytes: pipelineBytes(descriptor), name: info?.name ?? name });
      }
    };
  };
  wrapAsync("createRenderPipelineAsync", "gpu:renderPipeline(async call)", "renderPipelines", (d) => ({
    name: `${describe(d, d?.fragment ?? d?.vertex)} [async]`,
  }));
  wrapAsync("createComputePipelineAsync", "gpu:computePipeline(async call)", "computePipelines", (d) => ({
    name: `${describe(d, d?.compute)} [async]`,
  }));

  // Record every module's source length as it is created, so the pipeline
  // wrappers above can size what they are compiling — and hand the driver
  // BYTE-STABLE text (wgslStable.js), so the browser's compiled-shader disk
  // cache can serve the same graph on the next boot. `__wgslCanonical = false`
  // sends three's text through unchanged (the A/B arm).
  let storage = null;
  try { storage = typeof localStorage !== "undefined" ? localStorage : null; } catch { storage = null; }
  const registry = freeze.wgsl ?? (freeze.wgsl = new WgslRegistry(storage));
  const wrappedShaderModule = device.createShaderModule;
  device.createShaderModule = function (descriptor, ...rest) {
    let desc = descriptor;
    let canonical = null;
    // Not gated on `freeze.enabled`: canonical text + interning are a compile
    // win (browser shader cache hits, deduped modules), not instrumentation,
    // and a player with the ledger off must keep them.
    if (descriptor && typeof descriptor.code === "string") {
      const entry = registry.record(descriptor.label, descriptor.code, {
        canonical: globalThis.__wgslCanonical !== false,
      });
      if (entry.renamed && entry.code !== descriptor.code) desc = { ...descriptor, code: entry.code };
      canonical = desc.code;
    }
    // INTERN BY TEXT. three interns its programs on the source IT generated,
    // before `canonicalizeWgsl` runs here, so two graphs differing only in
    // `NodeBuffer_<id>` naming reach the driver as two modules with identical
    // bytes — 129 of 336 modules and 1 148 kB on the user's Complex scene.
    // See `WgslRegistry.intern`; `__wgslInternModules = false` reverts.
    const create = () => {
      const made = wrappedShaderModule.call(this, desc, ...rest);
      if (made && desc?.code) moduleBytes.set(made, desc.code.length);
      return made;
    };
    return canonical === null ? create() : registry.intern(canonical, create);
  };

  // ── the other doors a GPU-process stall can come through ──────────────────
  //
  // Chromium's WebGPU client serialises every call into a shared ring the GPU
  // process consumes; when the ring is full the CALLING thread waits for the
  // GPU process to catch up. Which call blocks is therefore luck — a
  // `writeBuffer` of uniforms, a `createBindGroup`, the `submit` — so each is
  // its own span (no counters: these run hundreds of times a frame and a span
  // under the ring floor costs two `performance.now()`s).
  //
  // These are the ledger's real per-frame cost, so with the ledger off at
  // install (a shipped player) they are not wrapped at all, rather than
  // wrapped and bypassed on every call.
  if (!freeze.enabled) return true;
  const countWrite = (n) => {
    freeze.gpu.writeBytes += n;
    freeze.gpu.writes++;
    if (n > freeze.gpu.largestWrite) freeze.gpu.largestWrite = n;
  };
  const span = (target, method, name, bytesOf = null) => {
    const original = target?.[method];
    if (typeof original !== "function") return;
    target[method] = function (...args) {
      if (!freeze.enabled) return original.apply(this, args);
      if (bytesOf) countWrite(bytesOf(args) || 0);
      const token = freeze.begin(name);
      try {
        return original.apply(this, args);
      } finally {
        freeze.end(token);
      }
    };
  };
  span(device, "createBindGroup", "gpu:createBindGroup");
  span(device, "createBuffer", "gpu:createBuffer");
  span(device, "createTexture", "gpu:createTexture");
  // The two hottest calls get fixed-arity wrappers: no rest array and no
  // `apply` per call. An `undefined` optional tail is WebIDL's "not passed".
  const queue = device.queue;
  const submit = queue?.submit;
  if (typeof submit === "function") {
    queue.submit = function (commandBuffers) {
      if (!freeze.enabled) return submit.call(this, commandBuffers);
      const token = freeze.begin("gpu:submit");
      try {
        return submit.call(this, commandBuffers);
      } finally {
        freeze.end(token);
      }
    };
  }
  // writeBuffer(buffer, offset, data, dataOffset?, size?) — three hands the
  // WHOLE attribute array as `data` and bounds the write with `dataOffset` /
  // `size` (in elements for a typed view), so the view's byteLength would
  // over-count a partial upload by the size of the array: the first version
  // read 10 GB written in one 60 ms task.
  const writeBuffer = queue?.writeBuffer;
  if (typeof writeBuffer === "function") {
    queue.writeBuffer = function (buffer, offset, data, dataOffset, size) {
      if (!freeze.enabled) return writeBuffer.call(this, buffer, offset, data, dataOffset, size);
      if (data) {
        const unit = data.BYTES_PER_ELEMENT ?? 1;
        countWrite(size != null && Number.isFinite(size)
          ? Math.max(0, size * unit)
          : Math.max(0, (data.byteLength ?? 0) - (dataOffset ?? 0) * unit));
      }
      const token = freeze.begin("gpu:writeBuffer");
      try {
        return writeBuffer.call(this, buffer, offset, data, dataOffset, size);
      } finally {
        freeze.end(token);
      }
    };
  }
  span(device.queue, "writeTexture", "gpu:writeTexture", (args) => args[1]?.byteLength ?? 0);
  span(device.queue, "copyExternalImageToTexture", "gpu:copyExternalImageToTexture");
  return true;
}

/**
 * Spans INSIDE three's render, so a `frame:renderEncode` block can say which
 * half of the render it was.
 *
 * 2026-09-09, after a light's castShadow flip: `[freeze] 475 ms —
 * frame:renderEncode 433.5, gpu:writeBuffer 36.7` with no node build in it.
 * The render is one span from the outside, and inside it are at least five
 * different owners with five different fixes: the shadow-map pass (a nested
 * `_renderScene` into the shadow target), bind-group creation for re-created
 * render objects, texture uploads, geometry uploads, and the per-object
 * `updateBefore` hooks (skinning, instancing, and the shadow node's own
 * render). Each is a few calls per object per frame, so a span costs two
 * `performance.now()`s and nothing reaches the ring below the 0.4 ms floor.
 */
export function installRenderSpans(renderer) {
  if (!renderer || renderer.__freezeRenderSpans) return false;
  renderer.__freezeRenderSpans = true;
  const wrapMethod = (target, method, label) => {
    const original = target?.[method];
    if (typeof original !== "function") return;
    target[method] = function (...args) {
      if (!freeze.enabled) return original.apply(this, args);
      const token = freeze.begin(typeof label === "function" ? label(this, args) : label);
      try {
        return original.apply(this, args);
      } finally {
        freeze.end(token);
      }
    };
  };
  // The scene render, labelled by its target: the main one presents to the
  // canvas; a shadow map, a reflection, a bake each name their own.
  wrapMethod(renderer, "_renderScene", (self) => {
    let target = null;
    try { target = self.getRenderTarget?.(); } catch { target = null; }
    if (!target) return "render:scene→canvas";
    const name = target.texture?.name || target.depthTexture?.name || "rt";
    return `render:scene→${name}:${target.width}x${target.height}`;
  });
  // Per object: `onBeforeRender` callbacks, the render-object lookup, the
  // per-object update chain. A 261 ms `render:scene→canvas` SELF time with
  // no build in it (2026-09-10, after a terrain heights undo) is exactly the
  // kind of thing that lives in an object's `onBeforeRender`.
  wrapMethod(renderer, "renderObject", "render:object");
  wrapMethod(renderer._bindings, "_createBindings", "render:createBindings");
  wrapMethod(renderer._textures, "updateTexture", "render:updateTexture");
  wrapMethod(renderer._geometries, "updateForRender", "render:geometry");
  wrapMethod(renderer._nodes, "updateBefore", "render:updateBefore");
  return true;
}
