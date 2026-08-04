/**
 * Undo history for the texture editor.
 *
 * Local to the panel, like the node graphs' and the Timeline's — a brush
 * stroke is not a scene mutation and has no business on the global command
 * bus, where it would sit between two entity moves and make Ctrl+Z mean
 * different things depending on where the pointer was.
 *
 * Entries carry their own `undo`/`redo` closures and a **byte cost**. The cost
 * is not bookkeeping for its own sake: a pixel-level undo entry holds a copy
 * of the region it changed, so a session of full-canvas filters on a 2K
 * document can hold hundreds of megabytes of history without any single step
 * looking expensive. The stack is trimmed by total bytes as well as by depth,
 * oldest first.
 */

const DEFAULT_LIMIT = 80;
const DEFAULT_BYTE_LIMIT = 512 * 1024 * 1024;

/** Successive edits sharing a key inside this window collapse into one entry —
 *  dragging an opacity slider is one undo step, not forty. */
const COALESCE_MS = 600;

export function createHistory({ limit = DEFAULT_LIMIT, byteLimit = DEFAULT_BYTE_LIMIT } = {}) {
  /** @type {Array<{label: string, undo: () => void, redo: () => void, bytes: number, key: string|null, time: number}>} */
  const entries = [];
  let index = -1; // index of the entry that Ctrl+Z would undo
  let bytes = 0;

  function trim() {
    while (entries.length > limit || (bytes > byteLimit && entries.length > 1)) {
      const dropped = entries.shift();
      bytes -= dropped.bytes;
      index--;
    }
    if (index < -1) index = -1;
  }

  return {
    get length() {
      return entries.length;
    },
    get bytes() {
      return bytes;
    },
    canUndo: () => index >= 0,
    canRedo: () => index < entries.length - 1,
    /** Label of the step Ctrl+Z would take, for the menu item. */
    undoLabel: () => (index >= 0 ? entries[index].label : null),
    redoLabel: () => (index < entries.length - 1 ? entries[index + 1].label : null),

    push({ label = "Edit", undo, redo, bytes: cost = 0, coalesceKey = null, now = Date.now() }) {
      // Anything redoable ahead of the cursor is unreachable once a new edit
      // lands — drop it and reclaim its bytes.
      while (entries.length > index + 1) bytes -= entries.pop().bytes;

      const top = entries[index];
      if (coalesceKey && top && top.key === coalesceKey && now - top.time <= COALESCE_MS) {
        // Keep the ORIGINAL undo (the state before the gesture started) and
        // take the newest redo. Keeping the newest undo instead would rewind
        // one slider tick per Ctrl+Z while claiming to be a single step.
        top.redo = redo;
        top.time = now;
        bytes += cost - top.bytes;
        top.bytes = cost;
        trim();
        return;
      }

      entries.push({ label, undo, redo, bytes: cost, key: coalesceKey, time: now });
      bytes += cost;
      index = entries.length - 1;
      trim();
    },

    undo() {
      if (index < 0) return null;
      const entry = entries[index];
      entry.undo();
      index--;
      return entry.label;
    },

    redo() {
      if (index >= entries.length - 1) return null;
      const entry = entries[index + 1];
      entry.redo();
      index++;
      return entry.label;
    },

    clear() {
      entries.length = 0;
      index = -1;
      bytes = 0;
    },
  };
}

/**
 * The common entry: one layer's pixels changed inside a known rectangle.
 *
 * Only the changed rectangle is copied, in both directions. A brush dab on a
 * 2048² document would otherwise cost 16MB of history for the fifty pixels it
 * touched, and the stack would be trimmed away after a handful of strokes —
 * turning "undo" into "undo, sometimes, recently".
 *
 * @param {import("./pixels.js").PixelBuffer} buffer the live layer buffer
 * @param {{x0:number,y0:number,x1:number,y1:number}} rect region that changed
 * @param {Uint8ClampedArray} before the same region's pixels before the edit,
 *   as produced by `captureRegion` prior to the operation
 */
export function regionEntry(buffer, rect, before, label = "Edit", coalesceKey = null) {
  const after = captureRegion(buffer, rect);
  return {
    label,
    coalesceKey,
    bytes: before.length + after.length,
    undo: () => restoreRegion(buffer, rect, before),
    redo: () => restoreRegion(buffer, rect, after),
  };
}

export function captureRegion(buffer, { x0, y0, x1, y1 }) {
  const w = Math.max(0, x1 - x0);
  const h = Math.max(0, y1 - y0);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const src = ((y0 + y) * buffer.width + x0) * 4;
    out.set(buffer.data.subarray(src, src + w * 4), y * w * 4);
  }
  return out;
}

export function restoreRegion(buffer, { x0, y0, x1, y1 }, pixels) {
  const w = Math.max(0, x1 - x0);
  const h = Math.max(0, y1 - y0);
  for (let y = 0; y < h; y++) {
    const dst = ((y0 + y) * buffer.width + x0) * 4;
    buffer.data.set(pixels.subarray(y * w * 4, (y + 1) * w * 4), dst);
  }
  return buffer;
}

/**
 * Structural change (layer added, reordered, merged, document resized): the
 * whole document is snapshotted, because there is no small rectangle to
 * describe it. These are rare compared to strokes, which is what makes the
 * cost acceptable — and why strokes must never take this path.
 */
export function documentEntry(getDocument, setDocument, before, label = "Edit") {
  const after = getDocument();
  const cost = (doc) => doc.layers.reduce((sum, l) => sum + l.buffer.data.length, 0);
  return {
    label,
    bytes: cost(before) + cost(after),
    undo: () => setDocument(before),
    redo: () => setDocument(after),
  };
}
