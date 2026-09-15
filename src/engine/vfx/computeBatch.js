/**
 * ⭐⭐⭐ ONE GPU SUBMIT FOR EVERY CLOTH IN THE SCENE, NOT ONE EACH.
 *
 * `renderer.compute(kernels)` is not a cheap call. In three's WebGPU backend it
 * is a whole submission: `beginCompute` creates a command encoder AND a compute
 * pass, every kernel is encoded into it, and `finishCompute` ends the pass and
 * calls `device.queue.submit()`. Ten cloths each calling it from their own tick
 * therefore cost ten encoders, ten passes and TEN SUBMITS every frame — and in
 * Chromium a submit is a hop to the GPU process, so its cost lands nowhere any
 * clock inside the page can see it.
 *
 * That is exactly the shape the user measured with `profile.frameCensus` on
 * 2026-09-09: cloth priced at **22.92 ms of a 31.25 ms frame** while its main
 * thread read 1.3 ms and its timestamped GPU passes read ~3 ms. The frame was
 * waiting on submissions, and the profiler called the wait idle.
 *
 * Cloths are independent, so the ORDER of one cloth's kernels relative to
 * another's does not matter — only the order WITHIN a cloth, which
 * concatenation preserves exactly. WebGPU orders dispatches inside a pass and
 * makes each one's writes visible to the next, which is the same guarantee the
 * solver's ping-pong already relies on.
 *
 * ⚠ WATER IS NOT BATCHED. Its queue is interleaved with a nested
 * `renderer.render` for caustics and with `spectrum.afterCompute`, and the
 * ordering of those against the compute encoder is load-bearing — issuing the
 * caustic draw inside the compute encoding poisoned the object bind group and
 * failed every water pipeline (2026-09-05). Cloth has no such coupling.
 */

/**
 * The scene's shared cloth submission. Kernels pushed during the frame's
 * updates are submitted once, from `onPreRender`, before anything draws.
 */
export function clothComputeBatch(engine) {
  if (!engine) return null;
  let batch = engine.__clothComputeBatch;
  if (batch) return batch;
  batch = engine.__clothComputeBatch = {
    kernels: [],
    // ⚠ THE FLOCK'S SOLVER RUNS BEFORE ITS MEMBERS' SURFACE KERNELS. Members
    // push during the frame's updates and the flock is ticked from preRender,
    // which is later — so the solver goes in a HEAD list that is flushed first,
    // or every member would draw last frame's particles.
    head: [],
    /** Run just before the submission — where the flock ticks, so its solver
     *  is queued no matter which preRender listener registered first. */
    beforeFlush: new Set(),
    /** Kernels in the last submission, and how many submissions it replaced. */
    lastKernels: 0,
    lastSources: 0,
    sources: 0,
    // Scratch output reused every frame — `head` must precede `kernels`, and
    // `kernels.unshift(...head)` both spread-allocated and shifted every
    // existing element down per frame. Built fresh each flush, capacity kept.
    order: [],
    push(kernels) {
      for (const kernel of kernels) this.kernels.push(kernel);
      this.sources++;
    },
    pushFirst(kernels) {
      for (const kernel of kernels) this.head.push(kernel);
    },
  };
  engine.onPreRender?.(() => {
    for (const before of batch.beforeFlush) {
      try { before(); } catch (error) { console.error("[cloth] flock tick failed", error); }
    }
    const { kernels, head, order } = batch;
    order.length = 0;
    if (head.length) { for (const kernel of head) order.push(kernel); head.length = 0; }
    for (const kernel of kernels) order.push(kernel);
    kernels.length = 0;
    batch.lastKernels = order.length;
    batch.lastSources = batch.sources;
    batch.sources = 0;
    if (!order.length) return;
    // A tick that ran without a render (a suspended viewport) must not let its
    // kernels pile up into the next frame's submission.
    engine.renderer?.compute(order);
  });
  return batch;
}
