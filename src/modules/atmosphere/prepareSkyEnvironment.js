import { EnvironmentNode } from 'three/webgpu';

// Three stores the authoritative version on its private PMREM render target,
// while node._pmrem is the output texture and can retain pmremVersion === 0.
// Keep our own receipt only after the native synchronous update returns.
const prepared = new WeakMap();

/** Refresh an existing native sky PMREM before the main render opens its
 * async/build-budget scope. A skipped one-shot PMREM draw otherwise leaves
 * black IBL cached as complete. First creation remains owned by Three.
 * Returns whether the existing node was updated; native errors propagate.
 */
export function prepareSkyEnvironment(engine, skyTexture) {
  const renderer = engine?.renderer, scene = engine?.scene;
  if (!renderer || !skyTexture || !scene || scene.environment !== skyTexture || scene.environmentNode ||
      engine.simulationSuspended === true || engine.rendererReady === false ||
      renderer._pipelines?.__asyncRenderPipelines?.active === true) return false;

  // Use Three's actual per-renderer EnvironmentNode cache. Do not construct a
  // PMREMNode or generator here, or warm any unrelated material/texture.
  const node = EnvironmentNode.prototype._getPMREMNodeCache(renderer).get(skyTexture);
  if (!node?._pmrem || !node._generator || node.value !== skyTexture) return false;
  const version = skyTexture.pmremVersion, receipt = prepared.get(node);
  if (receipt?.texture === skyTexture && receipt.version === version) return false;
  if (!receipt && node._pmrem.pmremVersion === version) return false;

  node.updateBefore({ renderer });
  prepared.set(node, { texture: skyTexture, version });
  return true;
}
