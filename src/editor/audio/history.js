/**
 * Undo/redo for audio documents.
 *
 * Snapshot-based, not inverse-operation-based. An inverse per edit is smaller
 * in memory and is where subtle irreversibility bugs live: "undo delete" has to
 * restore both the samples *and* the exact selection, and any effect with
 * randomness in it (dither, a noise generator, a randomised variation) has no
 * inverse at all. Keeping the old buffer always works.
 *
 * The cost is memory, so the stack is bounded by **bytes, not entries**. A
 * fixed depth of 50 is meaningless here: fifty edits to a UI blip is a few
 * megabytes, fifty edits to a ten-minute ambience is several gigabytes and the
 * tab dies. Entries are evicted oldest-first until the budget is met, and the
 * most recent entry is never evicted — an undo stack that can't undo the thing
 * that just happened would be worse than none.
 *
 * Snapshots share unchanged buffers. Only the tracks an edit actually touched
 * get copied, so editing one track of a six-track document costs one track.
 */
import { frameCount } from "./pcm.js";

const DEFAULT_BUDGET = 512 * 1024 * 1024; // bytes of sample data across the stack

const pcmBytes = (pcm) => frameCount(pcm) * pcm.channels.length * 4;

/** Mix state + PCM references. Buffers are shared, never copied. */
function snapshot(doc) {
  return {
    sampleRate: doc.sampleRate,
    channels: doc.channels,
    tracks: doc.tracks.map((t) => ({ ...t })),
  };
}

export function createHistory({ budgetBytes = DEFAULT_BUDGET } = {}) {
  return { past: [], future: [], budgetBytes };
}

/**
 * Records the document's current state under `label`, then the caller mutates.
 * Called *before* the edit, which is what makes the label describe what's about
 * to happen and the snapshot describe what to go back to.
 */
export function pushHistory(history, doc, label) {
  history.past.push({ label, state: snapshot(doc) });
  // A new edit invalidates the redo branch. Dropping it here rather than on
  // undo is what makes "undo, undo, edit" behave the way people expect.
  history.future.length = 0;
  evict(history);
  return history;
}

/**
 * Evicts oldest-first until the stack fits its byte budget.
 *
 * Buffers shared between snapshots are counted once — otherwise a six-track
 * document would appear to cost six times what it does after every edit and the
 * stack would evict almost immediately.
 */
function evict(history) {
  while (history.past.length > 1 && stackBytes(history) > history.budgetBytes) {
    history.past.shift();
  }
}

export function stackBytes(history) {
  const seen = new Set();
  let total = 0;
  for (const entry of [...history.past, ...history.future]) {
    for (const track of entry.state.tracks) {
      if (seen.has(track.pcm)) continue;
      seen.add(track.pcm);
      total += pcmBytes(track.pcm);
    }
  }
  return total;
}

export const canUndo = (history) => history.past.length > 0;
export const canRedo = (history) => history.future.length > 0;

export const undoLabel = (history) => history.past.at(-1)?.label ?? null;
export const redoLabel = (history) => history.future.at(-1)?.label ?? null;

/**
 * Steps back one edit, writing the previous state into `doc` **in place**.
 *
 * In place, because the panel holds the document in a ref and every open view
 * of it — waveform lanes, the track heads, the playback engine — points at that
 * one object. Returning a new document would leave all of them addressing the
 * pre-undo state, which is the audio equivalent of the texture editor's
 * "canvas keeps showing what was just rewound" bug.
 */
export function undo(history, doc) {
  const entry = history.past.pop();
  if (!entry) return null;
  history.future.push({ label: entry.label, state: snapshot(doc) });
  applySnapshot(doc, entry.state);
  return entry.label;
}

export function redo(history, doc) {
  const entry = history.future.pop();
  if (!entry) return null;
  history.past.push({ label: entry.label, state: snapshot(doc) });
  applySnapshot(doc, entry.state);
  return entry.label;
}

function applySnapshot(doc, state) {
  doc.sampleRate = state.sampleRate;
  doc.channels = state.channels;
  doc.tracks.length = 0;
  for (const track of state.tracks) doc.tracks.push({ ...track });
}
