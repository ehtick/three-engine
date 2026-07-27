// Sub-LSB dithering on the final output transform.
//
// THE PROBLEM IT FIXES. GI produces large, smooth, low-contrast gradients —
// a wall falling off from a lamp, a big soft shadow, a grazing-angle surface.
// The canvas is 8 bits per channel, so a gradient that spans (say) 18 levels
// across 130 pixels gets written as EIGHTEEN FLAT PLATEAUS about 6px wide with
// a hard one-level step between each. Measured on the user's scene, exactly
// that: `123 123 … 137 137 137 137 137 136 136 136 136 136 135 …`. The eye is
// far more sensitive to that edge than to the 1/255 step itself (Mach banding),
// so it reads as concentric contour rings — worst where the gradient is
// flattest, i.e. big soft shadows and steep/grazing angles, which is precisely
// when the user sees them.
//
// It is NOT a GI bug: the computed gradient is smooth and correct, the
// QUANTIZATION is what bands. Probe density, the cascade blend and the shadow
// trace were each measured and ruled out (swapping the probe interpolation for
// a C1 Hermite blend moved the metric by 0.02/255 — nothing).
//
// THE FIX. Add a triangular-PDF noise of ±1 LSB immediately before the write,
// in DISPLAY space (after tone mapping and the color-space transform — the
// step being broken up is a display-space step). Pixels that would all snap to
// 137 instead land on 136/137 in a fine stipple whose local average is the true
// value, so the plateau edges dissolve into a smooth ramp. This is the standard
// fix; three does it for WebGL via `material.dithering`, but the node/WebGPU
// path has no dither of any kind, so the engine has to add its own.
//
// Triangular PDF (two independent uniforms, minus one) rather than a single
// uniform: it decorrelates the error from the signal, which is what removes the
// residual pattern instead of just softening it.
import { Fn, float, fract, sin, vec2, vec3, vec4 } from "three/tsl";
import { screenCoordinate } from "three/tsl";

/** One LSB of an 8-bit channel. */
const LSB = 1 / 255;

const hash = (p, seed) =>
  fract(sin(p.dot(vec2(seed.x, seed.y))).mul(seed.z));

/**
 * Wraps `renderer._nodes.getOutputNode` so every output-transform quad three
 * builds (one per render target, cached by `_quadCache`) ends with a dither.
 *
 * Hooking HERE rather than in a material is deliberate: `_renderOutput` is the
 * single full-screen pass that applies tone mapping + color space on the way to
 * the canvas, so one wrap covers every material, the editor viewport and any
 * post-processing output alike, and costs one hash per output pixel.
 *
 * Idempotent — safe to call again after a renderer rebuild.
 */
export function installOutputDither(renderer) {
  const nodes = renderer?._nodes;
  if (!nodes || nodes.__giOutputDither) return false;
  const original = nodes.getOutputNode.bind(nodes);
  nodes.getOutputNode = (outputTarget) => {
    const base = original(outputTarget);
    return Fn(() => {
      const color = vec4(base).toVar();
      const p = vec2(screenCoordinate.x, screenCoordinate.y);
      // Two decorrelated uniforms → triangular PDF in [-1, 1] LSB.
      const n1 = hash(p, vec3(12.9898, 78.233, 43758.5453));
      const n2 = hash(p, vec3(39.3468, 11.1352, 24634.6345));
      const d = float(n1).add(n2).sub(1).mul(LSB);
      return vec4(vec3(color.rgb).add(d), color.a);
    })();
  };
  nodes.__giOutputDither = true;
  return true;
}
