// @ts-check
import { DepthStencilFormat, DepthTexture, FloatType, OperatorNode, WebGLCoordinateSystem } from "three/webgpu";
import { float } from "three/tsl";

/**
 * Reversed depth buffer support (`settings.renderer.reversedDepth`, opt-in).
 *
 * three r185 does most of it: clear value, every material depth func, reversed
 * projection matrices on every camera it renders, shadow compare + bias sign,
 * canvas/PassNode float depth. What it does NOT cover is collected here:
 *
 *   - NDC near/far for code that unprojects or clips by hand (`ndcDepthRange`).
 *   - `polygonOffset` is passed to the pipeline unsigned
 *     (WebGPUPipelineUtils.js:241-242), so under the GreaterEqual compare a
 *     "pull toward the camera" bias pushes the surface BACK.
 *   - three's addons (GTAO/SSR/SSGI/Denoise) test the sky as
 *     `depthSample >= 1.0`; a reversed buffer clears to 0.
 *   - The renderer's own framebuffer target (tone mapping / MSAA path) gets an
 *     auto depth texture of UnsignedIntType = depth24plus (Textures.js:94),
 *     which throws away most of the far-range precision the option is for and
 *     no longer matches the depth32float canvas.
 */

/**
 * NDC z of the near and far planes for `camera`'s projection.
 * WebGL: near -1, far 1. WebGPU: near 0, far 1. Reversed (either): near 1, far 0.
 * @param {any} camera
 */
export function ndcDepthRange(camera) {
  if (camera?.reversedDepth === true) return { near: 1, far: 0 };
  const webgl = (camera?.coordinateSystem ?? WebGLCoordinateSystem) === WebGLCoordinateSystem;
  return { near: webgl ? -1 : 0, far: 1 };
}

/**
 * True when a projected point's NDC z lies between the near and far planes —
 * i.e. in front of the camera and inside the depth range. A point behind a
 * perspective camera projects OUTSIDE this interval in every convention.
 * @param {number} z
 * @param {any} camera
 */
export function isNdcDepthInside(z, camera) {
  const { near, far } = ndcDepthRange(camera);
  return z >= Math.min(near, far) && z <= Math.max(near, far);
}

/**
 * The depth bias the pipeline should get for `material`. Under a reversed
 * buffer "closer" is LARGER depth, so the WebGL-convention sign flips.
 * @param {{polygonOffsetFactor?: number, polygonOffsetUnits?: number}} material
 * @param {boolean} reversed
 */
export function pipelinePolygonOffset(material, reversed) {
  const factor = material.polygonOffsetFactor ?? 0;
  const units = material.polygonOffsetUnits ?? 0;
  return reversed ? { factor: -factor, units: -units } : { factor, units };
}

/**
 * Per-renderer guards. Safe to call on any renderer (no-ops when it is not
 * reversed); idempotent.
 * @param {any} renderer
 */
export function installReversedDepthGuards(renderer) {
  installPolygonOffsetGuard(renderer?.backend?.pipelineUtils);
  installFrameBufferFloatDepth(renderer);
}

/**
 * Negates polygon offset while three builds a render pipeline for a reversed
 * backend. Patched on the WebGPUPipelineUtils PROTOTYPE (not exported by three,
 * so reached through an instance). `createRenderPipeline` reads the material's
 * offset synchronously while building the descriptor, before any await, so a
 * swap restored in `finally` is invisible to everything else.
 * @param {any} pipelineUtils
 */
export function installPolygonOffsetGuard(pipelineUtils) {
  const proto = pipelineUtils ? Object.getPrototypeOf(pipelineUtils) : null;
  if (!proto || proto.__engineReversedPolygonOffset) return false;
  const original = proto.createRenderPipeline;
  if (typeof original !== "function") return false;
  proto.createRenderPipeline = function createRenderPipeline(renderObject, promises) {
    const material = renderObject?.material;
    // Same flag three's own depth-func remap reads (WebGPUPipelineUtils.js:892).
    const reversed = this.backend?.parameters?.reversedDepthBuffer === true;
    if (!reversed || material?.polygonOffset !== true || globalThis.__engineReversedPolygonOffset === false) {
      return original.call(this, renderObject, promises);
    }
    const { polygonOffsetFactor, polygonOffsetUnits } = material;
    const flipped = pipelinePolygonOffset(material, true);
    material.polygonOffsetFactor = flipped.factor;
    material.polygonOffsetUnits = flipped.units;
    try {
      return original.call(this, renderObject, promises);
    } finally {
      material.polygonOffsetFactor = polygonOffsetFactor;
      material.polygonOffsetUnits = polygonOffsetUnits;
    }
  };
  proto.__engineReversedPolygonOffset = true;
  return true;
}

/**
 * Gives the renderer's framebuffer target a FloatType depth texture when the
 * buffer is reversed, the way PassNode already does. Assigned before three's
 * `Textures.updateRenderTarget` would mint its UnsignedIntType default; three
 * resizes a supplied depth texture with the target (Textures.js:110-120).
 * `__engineReversedFrameBufferFloatDepth = false` restores three's default.
 * @param {any} renderer
 */
export function installFrameBufferFloatDepth(renderer) {
  if (!renderer || renderer.__engineFrameBufferFloatDepth) return false;
  const original = renderer._getFrameBufferTarget;
  if (typeof original !== "function") return false;
  renderer._getFrameBufferTarget = function getFrameBufferTarget() {
    const target = original.call(this);
    if (target && this.reversedDepthBuffer === true && target.depthBuffer === true
      && !target.depthTexture && globalThis.__engineReversedFrameBufferFloatDepth !== false) {
      target.depthTexture = frameBufferDepthTexture(target);
    }
    return target;
  };
  renderer.__engineFrameBufferFloatDepth = true;
  return true;
}

/** @param {any} target */
export function frameBufferDepthTexture(target) {
  const depth = new DepthTexture(target.width, target.height);
  depth.type = FloatType;
  if (target.stencilBuffer) depth.format = DepthStencilFormat;
  return depth;
}

/**
 * Walks through the wrappers a TSL depth read passes on its way to a compare
 * (`.sample(uv).r.toVar()`) and returns true when it bottoms out at a texture
 * whose value is a DepthTexture.
 * @param {any} node
 */
export function isRawDepthSample(node) {
  for (let i = 0; node && i < 8; i++) {
    if (node.isTextureNode === true) return node.value?.isDepthTexture === true;
    if (node.isVarNode === true || node.isContextNode === true || node.isConvertNode === true) {
      node = node.node;
    } else if (node.isSplitNode === true) {
      // Only a single depth channel; `.rg` of a depth texture is not a depth.
      if (node.components !== "r" && node.components !== "x") return false;
      node = node.node;
    } else {
      return false;
    }
  }
  return false;
}

/**
 * Rewrites unported sky tests in three's screen-space addons.
 *
 * GTAONode.js:346, SSRNode.js:897 and SSGINode.js:568 discard on
 * `depth.greaterThanEqual( 1.0 )`; DenoiseNode.js:192 passes the texel through
 * on the same test. Under a reversed buffer the sky clears to 0, so none of them
 * ever skip it. The comparison lives inside `setup()`-local closures with no
 * patch point, and vendoring would pull in five more addon files. So the node
 * that performs it is rewritten instead, at build time:
 *
 *   rawDepthTextureSample >= 1.0   →   rawDepthTextureSample <= 0.0
 *
 * only when `builder.renderer.reversedDepthBuffer` is true. It is safe as a
 * global rule because a reversed-aware site never emits that shape under a
 * reversed buffer (it would compare against 0 itself), and ">= the far-plane
 * clear value" has no other meaning for a raw depth sample. UV bound tests
 * (`uv.x >= 1`) are not depth samples and are untouched. Idempotent,
 * prototype-level. `__engineReversedSkyDepthTest = false` disables it.
 */
export function installReversedSkyDepthTest() {
  const proto = /** @type {any} */ (OperatorNode?.prototype);
  if (!proto || proto.__engineReversedSkyDepthTest) return false;
  const setup = proto.setup;
  const generate = proto.generate;
  /** @this {any} */
  proto.setup = function (builder) {
    if (this.op === ">=" && builder?.renderer?.reversedDepthBuffer === true
      && globalThis.__engineReversedSkyDepthTest !== false
      && this.bNode?.isConstNode === true && this.bNode.value === 1
      && isRawDepthSample(this.aNode)) {
      // Returned from setup = stored as this node's `outputNode`, which three
      // builds through the setup/analyze stages with the other properties.
      const replacement = /** @type {any} */ (new OperatorNode("<=", this.aNode, float(0)));
      replacement.__engineReversedSkyDepthTest = true;
      return replacement;
    }
    return setup.call(this, builder);
  };
  // OperatorNode overrides `generate`, so unlike the base Node it never emits
  // its `outputNode` — redirect only for the replacement made above.
  /** @this {any} */
  proto.generate = function (builder, output) {
    const replacement = builder.getNodeProperties(this).outputNode;
    if (replacement?.__engineReversedSkyDepthTest === true) return replacement.build(builder, output);
    return generate.call(this, builder, output);
  };
  proto.__engineReversedSkyDepthTest = true;
  return true;
}
