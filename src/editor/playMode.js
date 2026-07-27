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
  if (engine.playing) return;
  snapshot = serializeScene(engine);
  engine.setPlaying(true);
  usePlayStore.setState({ playing: true });
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
  if (!engine.playing) return;
  engine.setPlaying(false);
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
  usePlayStore.setState({ playing: false });
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
