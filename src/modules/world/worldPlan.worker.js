import { normalizeWorldDocument } from '../../engine/world/worldDocument.js';
import { worldPlanDataSteps } from './worldPlanData.js';

/**
 * A module Worker running the pure-CPU half of a World plan (see
 * `worldPlanData.js`'s own header) so it finishes in its own CPU time
 * regardless of how long a boot/edit frame is. `worldPlan.js`'s
 * `prepareWorldPlanAsync` posts one `{type:'run', id, input, detailMaps,
 * reuse}` per generation; this drives `worldPlanDataSteps` to completion and
 * posts back `{type:'done', id, result}` with every typed array transferred,
 * or `{type:'error', id, message}`. A generation abandoned mid-flight (a
 * newer one started, or `WorldComponent` cancelled) is never replied to —
 * `prepareWorldPlanAsync` just stops listening for that `id` and terminates
 * this worker outright if it needs the thread back before this one finishes;
 * see the "terminate and respawn" note on `runWorldPlanDataInWorker`.
 *
 * `input`/`reuse`/`detailMaps` are the exact structured-cloneable subset
 * `prepareWorldPlanAsync` already needs to build regardless (this file never
 * touches `document`/`window`; nothing it imports does either — see
 * `worldPlanData.js`'s header for why that module was split out from
 * `worldPlan.js` in the first place).
 *
 * Runs flat-out (no per-frame slicing — there is no frame here to protect),
 * but still yields to the event loop every ~24 ms so a `cancel` message for
 * an abandoned job can actually be read before this one finishes; posts one
 * `{type:'progress', id, stage}` per stage change so the main thread can keep
 * reporting per-stage wall time to the freeze ledger exactly as it does for
 * the inline sliced path.
 */

let cancelledId = -1;

function makeClock(periodMs = 24) {
  let deadline = performance.now() + periodMs;
  return { due() { return performance.now() >= deadline; }, reset() { deadline = performance.now() + periodMs; } };
}

async function run(id, input, detailMaps, reuse) {
  const document = normalizeWorldDocument(input);
  const clock = makeClock();
  const steps = worldPlanDataSteps(document, { detailMaps, reuse, clock });
  let stageName = null;
  for (;;) {
    if (cancelledId === id) return; // a newer request superseded this one
    const step = steps.next();
    if (step.done) {
      const result = step.value;
      const transfer = [result.fieldCache.buffer, result.packed.buffer, result.shoreCache.buffer, result.waterHeights.buffer];
      if (result.grassField) {
        transfer.push(result.grassField.data.buffer);
        if (result.grassField.ground) transfer.push(result.grassField.ground.buffer);
      }
      postMessage({ type: 'done', id, result }, transfer);
      return;
    }
    if (step.value !== stageName) { stageName = step.value; postMessage({ type: 'progress', id, stage: stageName }); }
    if (clock.due()) { await Promise.resolve(); clock.reset(); }
  }
}

self.onmessage = event => {
  const message = event.data;
  if (message?.type === 'run') {
    run(message.id, message.input, message.detailMaps, message.reuse).catch(error => {
      if (cancelledId === message.id) return;
      postMessage({ type: 'error', id: message.id, message: error?.message ?? String(error) });
    });
  } else if (message?.type === 'cancel') {
    cancelledId = message.id;
  }
};
