import * as THREE from "three/webgpu";
import { resolveAssetUrl, loadAssetMeta } from "./assetResolver.js";
import { applyTextureMeta } from "./textureMeta.js";

const imageLoader = new THREE.TextureLoader();
let textureRenderer = null;
let basisLoader = null;
let basisLoaderPromise = null;
let basisCompressionEnabled = false;

// A broken/unsupported worker or GPU transcode can leave KTX2Loader's promise
// pending forever without rejecting (three's WorkerPool never listens for the
// worker's `error` event, so a worker that dies at startup simply never
// replies). Shader-graph compilation waits for every referenced texture, so one
// such task leaves the material permanently white. The editable source image is
// always retained specifically as a safe fallback; do not wait forever.
//
// The timeout only guards a genuine HANG. It is deliberately not tight: a real
// transcode of a large (2K–4K) texture on a cold worker can take a second or
// two, and it only ever runs while this task actually holds a worker (see the
// concurrency gate below), so a busy queue never eats into the budget.
const BASIS_LOAD_TIMEOUT_MS = 12000;

// KTX2Loader transcodes on a small worker pool. Firing dozens of loads at once
// (a multi-material GLB import does exactly this) means most sit queued behind
// the few in flight — and because each load's timeout starts when it is
// REQUESTED, the queued ones blow the deadline before a worker ever reaches
// them, misreporting a healthy transcoder as broken. Gate submissions to the
// pool size so every started transcode is measured, not its wait in line.
const BASIS_MAX_CONCURRENT = 4;

// Distinguish a transient overload (some timeouts, but the transcoder works)
// from a genuinely dead transcoder. A single timeout falls back for that one
// texture only; the whole session is disabled only after this many consecutive
// timeouts with zero successes between them, or immediately on a worker error.
const BASIS_TIMEOUT_GIVEUP = 4;

// Latched off for the rest of the session once the transcoder is proven broken
// (worker error, or repeated hangs). Source images load in ~400ms as fallback.
let basisDisabledForSession = false;
let basisConsecutiveTimeouts = 0;

// Simple counting semaphore bounding concurrent transcodes to the pool size.
let basisInFlight = 0;
const basisWaiters = [];
function acquireBasisSlot() {
  if (basisInFlight < BASIS_MAX_CONCURRENT) {
    basisInFlight++;
    return Promise.resolve();
  }
  return new Promise((resolve) => basisWaiters.push(resolve));
}
function releaseBasisSlot() {
  const next = basisWaiters.shift();
  if (next) next(); // hand the slot straight to the next waiter
  else basisInFlight--;
}

async function loadBasisWithTimeout(loader, url) {
  let timer = null;
  let timedOut = false;
  const pending = loader.loadAsync(url);
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(`Basis transcode timed out after ${BASIS_LOAD_TIMEOUT_MS}ms`));
    }, BASIS_LOAD_TIMEOUT_MS);
  });

  try {
    return await Promise.race([pending, timeout]);
  } finally {
    clearTimeout(timer);
    // Promise.race cannot cancel KTX2Loader. If its worker eventually returns
    // after the timeout, dispose that unused GPU texture instead of leaking it.
    if (timedOut) pending.then((texture) => texture?.dispose?.()).catch(() => {});
  }
}

/** Controlled by the optional Basis engine module. */
export function setBasisCompressionEnabled(enabled) {
  basisCompressionEnabled = enabled === true;
}

/** Must be called after renderer.init(); selects the best GPU target format. */
export function configureTextureAssetLoader(nextRenderer) {
  if (!nextRenderer) return;
  // Keep Basis code and WASM off the startup path until a compressed asset is
  // actually requested. Re-detect after renderer rebuilds.
  textureRenderer = nextRenderer;
  basisLoader?.detectSupport(nextRenderer);
}

async function getBasisLoader() {
  if (!textureRenderer) return null;
  if (!basisLoaderPromise) {
    basisLoaderPromise = import("three/addons/loaders/KTX2Loader.js").then(async ({ KTX2Loader }) => {
      // The transcoder binaries live in `public/basis/` (copied from three's
      // libs), exactly like the Draco decoder — and the path is RELATIVE for
      // the same reason: it resolves against the document URL, so an exported
      // game served from a subpath still finds them.
      //
      // Setting this explicitly is NOT optional. Left empty, KTX2Loader
      // resolves the transcoder via `new URL('../libs/basis/...',
      // import.meta.url)`. Vite pre-bundles KTX2Loader into
      // `/node_modules/.vite/deps/`, so that relative URL points at a path that
      // does not exist — and the dev server's SPA fallback answers it with
      // `index.html` and a 200. FileLoader sees success, the worker gets built
      // with HTML as its source, dies on `<!doctype html>`, and (because
      // WorkerPool ignores worker errors) never replies at all. Every texture
      // then hangs until the timeout below. See git history for the 20s
      // white-geometry startup this caused.
      const loader = new KTX2Loader()
        .setTranscoderPath("basis/")
        .setWorkerLimit(BASIS_MAX_CONCURRENT) // keep the pool and our gate in lock-step
        .detectSupport(textureRenderer);
      await loader.init();

      // WorkerPool has no 'error' handling, so without this a broken worker is
      // completely silent. A worker error means the transcoder itself is dead
      // (bad build/path) — every transcode will hang — so latch Basis off for
      // the session immediately instead of waiting out timeouts one by one.
      const createWorker = loader.workerPool.workerCreator;
      loader.workerPool.setWorkerCreator(() => {
        const worker = createWorker();
        worker.addEventListener("error", (e) => {
          basisDisabledForSession = true;
          console.error(
            `Basis transcode worker failed (${e.message} @ ${e.filename}:${e.lineno}); ` +
              `using source images for the rest of this session.`,
          );
        });
        return worker;
      });

      basisLoader = loader;
      return loader;
    });
  }
  return basisLoaderPromise;
}

/**
 * Loads an image asset, preferring its generated `<path>.basis` KTX2 when the
 * per-asset toggle is enabled. A missing/stale derivative safely falls back to
 * the source image, which keeps projects portable and source assets editable.
 */
export async function loadTextureAsset(path, { colorSpace = null } = {}) {
  const meta = await loadAssetMeta(`${path}.meta`);
  let texture = null;

  if (basisCompressionEnabled && meta?.basis?.enabled && !basisDisabledForSession) {
    await acquireBasisSlot();
    try {
      // A peer that failed while we waited in the queue may have latched Basis
      // off — don't start a transcode we already know will be wasted.
      if (!basisDisabledForSession) {
        const loader = await getBasisLoader();
        if (loader) {
          texture = await loadBasisWithTimeout(loader, await resolveAssetUrl(`${path}.basis`));
          basisConsecutiveTimeouts = 0; // a success clears the strike count
        }
      }
    } catch (err) {
      // The source image is always retained, so this is recoverable. A lone
      // timeout (a big texture, a momentarily overloaded pool) falls back for
      // this texture only; the session is disabled only once hangs pile up with
      // no success between them, i.e. the transcoder is genuinely stuck.
      const isTimeout = /timed out/.test(err.message ?? "");
      if (isTimeout && ++basisConsecutiveTimeouts < BASIS_TIMEOUT_GIVEUP) {
        console.warn(`Basis transcode fell back to source for "${path}" — ${err.message ?? err}`);
      } else {
        basisDisabledForSession = true;
        console.warn(
          `Basis transcoding failed; using source images for the rest of this session. ` +
            `Last failure: "${path}" — ${err.message ?? err}`,
        );
      }
    } finally {
      releaseBasisSlot();
    }
  }

  if (!texture) texture = await imageLoader.loadAsync(await resolveAssetUrl(path));
  if (colorSpace) texture.colorSpace = colorSpace;
  applyTextureMeta(texture, meta);
  return texture;
}
