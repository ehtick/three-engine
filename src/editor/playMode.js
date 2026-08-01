import { ensureEngine } from "./engineInstance.js";
import { commandBus } from "./commands/CommandBus.js";
import { useSceneStore } from "./store/sceneStore.js";
import { useSelectionStore } from "./store/selectionStore.js";
import { usePlayStore } from "./store/playStore.js";

let snapshot = null;
let transition = null;

export async function play() {
  if (transition) return transition;
  transition = doPlay();
  try {
    return await transition;
  } finally {
    transition = null;
  }
}

async function doPlay() {
  const engine = await ensureEngine();
  const { serializeScene } = await import("../engine/index.js");
  const { currentScenePath } = await import("./sceneIO.js");
  if (engine.playing) return;
  snapshot = serializeScene(engine);
  // Tell the scene manager which scene the game is starting in, so a script
  // can ask (and so `loadScene` of the *same* scene still counts as a reload).
  engine.scenes.reset({ path: currentScenePath() ?? null, name: engine.sceneName });
  engine.setPlaying(true);
  usePlayStore.setState({ playing: true, paused: false });
}

export async function stop() {
  if (transition) return transition;
  transition = doStop();
  try {
    return await transition;
  } finally {
    transition = null;
  }
}

async function doStop() {
  const engine = await ensureEngine();
  const { reconcileScene } = await import("../engine/index.js");
  const { currentScenePath } = await import("./sceneIO.js");
  if (!engine.playing) return;
  engine.setPlaying(false);
  // Cancel any in-flight load and drop the game's scene bookkeeping BEFORE
  // restoring — a level the game loaded must not still look "loaded" once the
  // editor's own scene is back, and a load still resolving would otherwise
  // instantiate into the restored scene a moment later.
  engine.scenes.reset({ path: currentScenePath() ?? null, name: engine.sceneName });
  if (snapshot) {
    // Restores the snapshot ONTO the live scene rather than clearing and
    // rebuilding it. A full rebuild re-attaches every component, and the GI
    // component's re-attach alone froze the main thread for ~2s on a real
    // project. See serialize.js `reconcileScene`.
    await reconcileScene(engine, snapshot);
    snapshot = null;
  }
  commandBus.clearHistory();
  useSelectionStore.getState().clear();
  useSceneStore.getState().refresh();
  usePlayStore.setState({ playing: false, paused: false });
}

/**
 * Freezes game time without leaving Play. The scene stays exactly as the game
 * left it — entities, physics bodies, script state — and the viewport keeps
 * rendering, so a paused frame can be inspected and even edited.
 */
export async function setPaused(paused) {
  const engine = await ensureEngine();
  if (!engine.playing) return;
  engine.setPaused(paused);
  usePlayStore.setState({ paused: engine.paused });
}

export async function togglePaused() {
  const engine = await ensureEngine();
  await setPaused(!engine.paused);
}

/** Advances one frame of game time while paused — the debugger's step button. */
export async function stepFrame() {
  const engine = await ensureEngine();
  if (!engine.playing) return;
  if (!engine.paused) await setPaused(true);
  engine.step(1);
}

export async function toggle() {
  // Ignore repeated toolbar/shortcut input while the snapshot is being
  // restored. Starting Play midway through that transaction can select a
  // camera or start scripts from a half-populated scene.
  if (transition) return transition;
  const engine = await ensureEngine();
  if (engine.playing) await stop();
  else await play();
}
