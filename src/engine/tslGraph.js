import { vmState } from "./vmState.js";
import * as THREE from "three/webgpu";
import * as TSL from "three/tsl";
import { loadTextureAsset } from "./textureAsset.js";

/**
 * TSL-first shader graph. Every node maps ~1:1 to a `three/tsl` export; the
 * Output node exposes one input port per material `*Node` slot. The registry
 * drives the compiler, the editor UI, and the JS code generator.
 *
 * Graph JSON (persisted in .mat `shaderGraph`):
 *   { nodes: [{id, type, props, position}], edges: [{source, sourceHandle, target, targetHandle}] }
 *
 * compileShaderGraph(graph, {taps}) →
 *   { mutations: { <materialProp>: tslNode }, uniforms: { "<nodeId>.<key>": uniformNode }, taps: { <nodeId>: tslNode } }
 *
 * Unwired inputs with an editable default become `uniform()` nodes registered
 * in `uniforms`, so the editor can live-patch values without recompiling.
 */

const textureCache = vmState("tslGraphTextures", () => new Map()); // path -> Promise<THREE.Texture>
const textureKey = (path) => String(path ?? "").replaceAll("\\", "/");

function loadTexture(path) {
  const key = textureKey(path);
  let cached = textureCache.get(key);
  if (!cached) {
    cached = loadTextureAsset(path, { colorSpace: THREE.SRGBColorSpace });
    textureCache.set(key, cached);
    // A rejected load must be retryable after the asset is repaired or its
    // compression setting changes. Pending loads are bounded by
    // textureAsset's Basis timeout.
    cached.catch(() => {
      if (textureCache.get(key) === cached) textureCache.delete(key);
    });
  }
  return cached;
}

/** Drops cached shader textures so material refreshes cannot reuse a stale or
 * previously stalled Promise. With no path, clears every graph texture. */
export function invalidateShaderTextureCache(path = null) {
  if (path == null) textureCache.clear();
  else textureCache.delete(textureKey(path));
}

/** Input port spec. `def` null = wire-only; number/hex/array = inline-editable
 *  default (compiled to a uniform when unwired); `src` = fallback TSL builtin
 *  (e.g. "uv", "time") used when unwired and no value set. */
const i = (key, type, def = null, src = null, extra = null) => ({ key, type, default: def, src, ...extra });

/** Input sockets exposed by the Material Output node — Blender-style. Three
 *  pins, mirroring Blender's `Material Output`:
 *
 *   - `surface` (type `surface`) — fed by a shader node (Principled BSDF,
 *     Emission, …). Those nodes don't compile to a single TSL value; they
 *     return a *surface bundle* `{ __surface: { <materialSlot>: tslNode } }`
 *     that the compiler unpacks into the material's `*Node` slots. This is
 *     why the per-channel pins (Color, Roughness, Metalness, …) live on the
 *     BSDF node now, not on the Output — exactly like Blender.
 *   - `volume` (type `volume`) — the Volume pin: a node wired into it is a
 *     `Fn({positionRay}) -> vec4` suitable for `VolumeNodeMaterial.scatteringNode`.
 *     The material-asset layer instantiates a `VolumeNodeMaterial` (volume
 *     wired) or a `MeshPhysicalNodeMaterial` (surface only) accordingly.
 *   - `displacement` (type `vec3`) — offsets/replaces vertex position via
 *     `positionNode`.
 *
 *  `slot` is the single material property a socket maps to, or `null` for
 *  `surface` (which expands to many slots via the bundle).
 */
export const OUTPUT_SLOTS = [
  { key: "surface", slot: null, type: "surface" },
  { key: "volume", slot: null, type: "volume" },
  { key: "displacement", slot: "positionNode", type: "vec3" },
];

/** Every material `*Node` a compiled graph can populate — the union of all
 *  surface-bundle slots plus volume/displacement. Callers reset these to null
 *  before applying a fresh compile so a stale slot never leaks across edits. */
export const MATERIAL_NODE_SLOTS = [
  "colorNode", "roughnessNode", "metalnessNode", "emissiveNode", "opacityNode",
  "iorNode", "specularIntensityNode", "specularColorNode", "anisotropyNode",
  "sheenNode", "sheenRoughnessNode", "clearcoatNode", "clearcoatRoughnessNode",
  "transmissionNode", "thicknessNode", "normalNode", "aoNode", "positionNode",
];

/** Build a surface bundle from a shader node's resolved inputs. `def.surfaceSlots`
 *  maps input keys → material `*Node` names; only non-null inputs are emitted
 *  (so wire-only channels like clearcoat/transmission stay unset unless the
 *  user wires them — three's `useClearcoat`/`useTransmission`/… getters turn
 *  the expensive lighting path ON the instant their node is non-null, even at
 *  0, so leaving them null is what keeps a plain material cheap). `def.emitterBase`
 *  forces a black, rough, non-metal base (Emission). `def.emissive` combines a
 *  color × strength input pair into `emissiveNode`. */
function buildSurface(def, ins) {
  const m = {};
  if (def.emitterBase) {
    m.colorNode = TSL.vec3(0);
    m.roughnessNode = TSL.float(1);
    m.metalnessNode = TSL.float(0);
  }
  for (const [inKey, slot] of Object.entries(def.surfaceSlots ?? {})) {
    if (ins[inKey] != null) m[slot] = ins[inKey];
  }
  if (def.emissive) {
    const c = ins[def.emissive.color];
    const s = ins[def.emissive.strength];
    if (c != null) m.emissiveNode = s != null ? TSL.mul(c, s) : c;
  }
  return { __surface: m };
}

const VOLUME_STEPS_DEFAULT = 32;

/** The current raymarch sample position in the mesh's local box space, shared
 *  so that nodes wired into a volume (Noise, math on Position, …) vary THROUGH
 *  the volume rather than across its surface. `volumeBundle` assigns it every
 *  march step (inside the lighting model's Loop, before density/emission are
 *  read); `Position (Local)` / `Position (World)` resolve to it when compiling
 *  a volume graph. Module-level + assigned-in-loop mirrors how three's own
 *  VolumetricLightingModel drives `scatteringDensity`. */
const volumeRayLocal = TSL.property("vec3");

/** World-space form of the current volume sample (local ray pos → world). */
const volumeRayWorld = () => TSL.modelWorldMatrix.mul(TSL.vec4(volumeRayLocal, 1)).xyz;

/** Volume nodes compile to a `__volume` bundle consumed by the material-asset
 *  layer, which drives a `THREE.VolumeNodeMaterial` + its built-in
 *  `VolumetricLightingModel`. That model raymarches the bounds, iterates every
 *  scene light (with shadow maps → light shafts), applies Beer's-law
 *  transmittance, and — given `material.depthNode` (a scene depth prepass) —
 *  clips scattering behind opaque geometry for correct depth occlusion.
 *
 *  The model hands the callbacks a *world-space* sample `positionRay`, so we
 *  transform back into the mesh's local unit box for the density field and mask
 *  everything outside `[-0.5, 0.5]³` to 0 — that's what keeps the effect bounded
 *  to the box instead of filling all of world space.
 *
 *   - `scattering(worldPos) -> vec3`  density × albedo tint (modulates the light
 *     the model accumulates at this sample; also drives the transmittance).
 *   - `emissive(worldPos)  -> vec3`   self-emitted light (fire/blackbody), added
 *     independently of scene lights, or `null`.
 *   - `steps`                          raymarch step count for this material. */
function volumeBundle({ density, albedo, emission, steps }) {
  const local = (worldPos) => TSL.modelWorldMatrixInverse.mul(TSL.vec4(worldPos, 1)).xyz;
  // 1 inside the unit box, 0 outside (per-axis half-extent test, multiplied).
  const boxMask = (l) => {
    const a = l.abs();
    return TSL.step(a.x, 0.5).mul(TSL.step(a.y, 0.5)).mul(TSL.step(a.z, 0.5));
  };
  return {
    __volume: {
      steps: Math.max(1, Math.round(steps ?? VOLUME_STEPS_DEFAULT)),
      scattering: (worldPos) => {
        // Publish this sample so wired Position/Noise nodes evaluate here. The
        // model calls us inside its march Loop, so the assign is emitted in
        // order, before the density expression below reads it.
        const l = local(worldPos);
        volumeRayLocal.assign(l);
        const d = density(l).mul(boxMask(l));
        return albedo ? albedo.mul(d) : d;
      },
      emissive: emission
        ? (worldPos) => {
            const l = local(worldPos);
            volumeRayLocal.assign(l);
            return emission.mul(density(l)).mul(boxMask(l));
          }
        : null,
    },
  };
}

/** A soft 0..1 cloud field in the mesh's local box, so a plain volume reads as
 *  fuzzy rather than a solid cube. `positionLocal` is local ([-0.5,0.5]). */
function cloudDensity(positionLocal) {
  return TSL.mx_fractal_noise_float(positionLocal.mul(3), 3, 2, 0.5).mul(0.5).add(0.5);
}

// --- Registry builder helpers -------------------------------------------
const src = (label, fn, out = "any") => ({ label, cat: "attribute", fn, inputs: [], out });
const fn1 = (label, fn, cat = "math", t = "any") => ({ label, cat, fn, inputs: [i("x", t)], out: t });
const fn2 = (label, fn, a = 0, b = 0, cat = "math") => ({ label, cat, fn, inputs: [i("a", "any", a), i("b", "any", b)], out: "any" });

export const NODE_TYPES = {
  // --- values (uniform-backed; old graph type names kept for back-compat) ---
  float: {
    label: "Float", cat: "value", params: [{ key: "value", type: "number", default: 1 }], out: "float",
    build: ({ props, uni, id }) => uni(`${id}.value`, TSL.uniform(props.value ?? 1)),
    gen: ({ props, use }) => `${use("uniform")}(${num(props.value ?? 1)})`,
  },
  color: {
    label: "Color", cat: "value", params: [{ key: "value", type: "color", default: "#ffffff" }], out: "color",
    build: ({ props, uni, id }) => uni(`${id}.value`, TSL.uniform(new THREE.Color(props.value ?? "#ffffff"))),
    gen: ({ props, use }) => `${use("uniform")}(${use("color", true)}('${props.value ?? "#ffffff"}'))`,
  },

  // --- attributes / coordinates ---
  uv: src("UV", "uv", "vec2"),
  vertexColor: src("Vertex Color", "vertexColor", "color"),
  positionLocal: src("Position (Local)", "positionLocal", "vec3"),
  positionWorld: src("Position (World)", "positionWorld", "vec3"),
  positionView: src("Position (View)", "positionView", "vec3"),
  viewDirection: src("View Direction", "positionViewDirection", "vec3"),
  normalLocal: src("Normal (Local)", "normalLocal", "vec3"),
  normalView: src("Normal (View)", "normalView", "vec3"),
  normalWorld: src("Normal (World)", "normalWorld", "vec3"),
  tangentWorld: src("Tangent (World)", "tangentWorld", "vec3"),
  bitangentWorld: src("Bitangent (World)", "bitangentWorld", "vec3"),
  cameraPosition: src("Camera Position", "cameraPosition", "vec3"),
  screenUV: src("Screen UV", "screenUV", "vec2"),
  viewportUV: src("Viewport UV", "viewportUV", "vec2"),
  matcapUV: src("Matcap UV", "matcapUV", "vec2"),
  frontFacing: src("Front Facing", "frontFacing", "float"),
  // Per-instance ID on an InstancedMesh (0..count-1) — NodeMaterial applies
  // the per-instance matrix to positionLocal automatically, so this is the
  // hook for per-instance *variation* (color, scale offsets, …) via e.g.
  // hash(instanceIndex). There's no native "instance count" TSL builtin
  // (it isn't a GPU attribute); drive that from a Float/Uniform node instead.
  instanceIndex: src("Instance Index", "instanceIndex", "float"),

  // --- time / oscillators ---
  time: { ...src("Time", "time", "float"), cat: "osc" },
  deltaTime: { ...src("Delta Time", "deltaTime", "float"), cat: "osc" },
  oscSine: { label: "Osc Sine", cat: "osc", fn: "oscSine", inputs: [i("t", "float", null, "time")], out: "float" },
  oscSquare: { label: "Osc Square", cat: "osc", fn: "oscSquare", inputs: [i("t", "float", null, "time")], out: "float" },
  oscTriangle: { label: "Osc Triangle", cat: "osc", fn: "oscTriangle", inputs: [i("t", "float", null, "time")], out: "float" },
  oscSawtooth: { label: "Osc Sawtooth", cat: "osc", fn: "oscSawtooth", inputs: [i("t", "float", null, "time")], out: "float" },

  // --- math: one input ---
  abs: fn1("Abs", "abs"), floor: fn1("Floor", "floor"), ceil: fn1("Ceil", "ceil"),
  round: fn1("Round", "round"), trunc: fn1("Trunc", "trunc"), fract: fn1("Fract", "fract"),
  sign: fn1("Sign", "sign"), sqrt: fn1("Sqrt", "sqrt"), inverseSqrt: fn1("Inverse Sqrt", "inverseSqrt"),
  cbrt: fn1("Cbrt", "cbrt"), exp: fn1("Exp", "exp"), exp2: fn1("Exp2", "exp2"),
  log: fn1("Log", "log"), log2: fn1("Log2", "log2"),
  sin: fn1("Sin", "sin"), cos: fn1("Cos", "cos"), tan: fn1("Tan", "tan"),
  asin: fn1("Asin", "asin"), acos: fn1("Acos", "acos"), atan: fn1("Atan", "atan"),
  degrees: fn1("Degrees", "degrees"), radians: fn1("Radians", "radians"),
  oneMinus: fn1("One Minus", "oneMinus"), negate: fn1("Negate", "negate"),
  reciprocal: fn1("Reciprocal", "reciprocal"), saturate: fn1("Saturate", "saturate"),
  pow2: fn1("Power 2", "pow2"), pow3: fn1("Power 3", "pow3"), pow4: fn1("Power 4", "pow4"),

  // --- math: multi input (old type names add/subtract/… kept) ---
  add: fn2("Add", "add"), subtract: fn2("Subtract", "sub"), multiply: fn2("Multiply", "mul", 1, 1),
  divide: fn2("Divide", "div", 1, 1), mod: fn2("Mod", "mod", 0, 1), pow: fn2("Power", "pow", 0, 2),
  min: fn2("Min", "min"), max: fn2("Max", "max"),
  atan2: { label: "Atan2", cat: "math", fn: "atan", inputs: [i("y", "float", 0), i("x", "float", 1)], out: "float" },
  lerp: { label: "Mix", cat: "math", fn: "mix", inputs: [i("a", "any"), i("b", "any"), i("t", "float", 0.5)], out: "any" },
  clamp: { label: "Clamp", cat: "math", fn: "clamp", inputs: [i("x", "any"), i("min", "float", 0), i("max", "float", 1)], out: "any" },
  step: { label: "Step", cat: "math", fn: "step", inputs: [i("edge", "float", 0.5), i("x", "any")], out: "any" },
  smoothstep: { label: "Smoothstep", cat: "math", fn: "smoothstep", inputs: [i("low", "float", 0), i("high", "float", 1), i("x", "any")], out: "any" },
  remap: { label: "Remap", cat: "math", fn: "remap", inputs: [i("x", "any"), i("inLow", "float", 0), i("inHigh", "float", 1), i("outLow", "float", 0), i("outHigh", "float", 1)], out: "any" },
  remapClamp: { label: "Remap (Clamp)", cat: "math", fn: "remapClamp", inputs: [i("x", "any"), i("inLow", "float", 0), i("inHigh", "float", 1), i("outLow", "float", 0), i("outHigh", "float", 1)], out: "any" },
  greaterThan: fn2("Greater Than", "greaterThan"), lessThan: fn2("Less Than", "lessThan"),
  select: { label: "Select", cat: "math", fn: "select", inputs: [i("cond", "any"), i("a", "any", 1), i("b", "any", 0)], out: "any" },

  // --- vector ---
  vec2: { label: "Vec2", cat: "vector", fn: "vec2", inputs: [i("x", "float", 0), i("y", "float", 0)], out: "vec2" },
  vec3: { label: "Vec3", cat: "vector", fn: "vec3", inputs: [i("x", "float", 0), i("y", "float", 0), i("z", "float", 0)], out: "vec3" },
  vec4: { label: "Vec4", cat: "vector", fn: "vec4", inputs: [i("x", "float", 0), i("y", "float", 0), i("z", "float", 0), i("w", "float", 1)], out: "vec4" },
  split: {
    label: "Split", cat: "vector", inputs: [i("v", "any")], outputs: ["x", "y", "z", "w"], out: "float",
    build: ({ ins, out }) => (ins.v ? ins.v[out] : null),
    gen: ({ args, out }) => `${args.v}.${out}`,
  },
  dot: fn2("Dot", "dot", null, null, "vector"),
  cross: fn2("Cross", "cross", null, null, "vector"),
  distance: fn2("Distance", "distance", null, null, "vector"),
  normalize: fn1("Normalize", "normalize", "vector", "vec3"),
  length: fn1("Length", "length", "vector"),
  reflect: { label: "Reflect", cat: "vector", fn: "reflect", inputs: [i("I", "vec3"), i("N", "vec3", null, "normalView")], out: "vec3" },
  refract: { label: "Refract", cat: "vector", fn: "refract", inputs: [i("I", "vec3"), i("N", "vec3", null, "normalView"), i("eta", "float", 0.66)], out: "vec3" },
  rotate: { label: "Rotate", cat: "vector", fn: "rotate", inputs: [i("v", "any"), i("angle", "float", 0)], out: "any" },
  rotateUV: { label: "Rotate UV", cat: "vector", fn: "rotateUV", inputs: [i("uv", "vec2", null, "uv"), i("angle", "float", 0), i("center", "vec2", [0.5, 0.5])], out: "vec2" },
  spherizeUV: { label: "Spherize UV", cat: "vector", fn: "spherizeUV", inputs: [i("uv", "vec2", null, "uv"), i("strength", "float", 1), i("center", "vec2", [0.5, 0.5])], out: "vec2" },

  // --- noise ---
  noise: { label: "Noise", cat: "noise", fn: "mx_noise_float", inputs: [i("pos", "any", null, "uv")], out: "float" },
  noiseVec3: { label: "Noise Vec3", cat: "noise", fn: "mx_noise_vec3", inputs: [i("pos", "any", null, "uv")], out: "vec3" },
  fractalNoise: { label: "Fractal Noise", cat: "noise", fn: "mx_fractal_noise_float", inputs: [i("pos", "any", null, "uv"), i("octaves", "float", 3), i("lacunarity", "float", 2), i("diminish", "float", 0.5)], out: "float" },
  fractalNoiseVec3: { label: "Fractal Noise Vec3", cat: "noise", fn: "mx_fractal_noise_vec3", inputs: [i("pos", "any", null, "uv"), i("octaves", "float", 3), i("lacunarity", "float", 2), i("diminish", "float", 0.5)], out: "vec3" },
  worley: { label: "Worley Noise", cat: "noise", fn: "mx_worley_noise_float", inputs: [i("pos", "any", null, "uv"), i("jitter", "float", 1)], out: "float" },
  worleyVec3: { label: "Worley Noise Vec3", cat: "noise", fn: "mx_worley_noise_vec3", inputs: [i("pos", "any", null, "uv"), i("jitter", "float", 1)], out: "vec3" },
  cellNoise: { label: "Cell Noise", cat: "noise", fn: "mx_cell_noise_float", inputs: [i("pos", "any", null, "uv")], out: "float" },
  triNoise3D: { label: "Tri Noise 3D", cat: "noise", fn: "triNoise3D", inputs: [i("pos", "vec3", null, "positionLocal"), i("speed", "float", 0.2), i("time", "float", null, "time")], out: "float" },
  hash: { label: "Hash", cat: "noise", fn: "hash", inputs: [i("seed", "float", 0)], out: "float" },
  rand: { label: "Random", cat: "noise", fn: "rand", inputs: [i("uv", "vec2", null, "uv")], out: "float" },

  // --- texture ---
  texture: {
    label: "Texture", cat: "texture", params: [{ key: "path", type: "asset" }],
    inputs: [i("uv", "vec2", null, "uv")], outputs: ["out", "r", "g", "b", "a"], out: "color",
    build: ({ ins, out, textures, id }) => {
      const tex = textures.get(id);
      if (!tex) return null;
      const t = TSL.texture(tex, ins.uv ?? undefined);
      return out === "out" ? t : t[out];
    },
    gen: ({ args, out, props, use, name }) =>
      `${use("texture")}(/* load "${props.path ?? ""}" */ ${name}_map${args.uv ? `, ${args.uv}` : ""})${out !== "out" ? `.${out}` : ""}`,
  },
  checker: { label: "Checker", cat: "texture", fn: "checker", inputs: [i("uv", "vec2", null, "uv")], out: "float" },
  normalMap: { label: "Normal Map", cat: "texture", fn: "normalMap", inputs: [i("color", "color"), i("scale", "float", 1)], out: "vec3" },

  // --- color ---
  hue: { label: "Hue", cat: "color", fn: "hue", inputs: [i("color", "color"), i("adjust", "float", 0)], out: "color" },
  saturation: { label: "Saturation", cat: "color", fn: "saturation", inputs: [i("color", "color"), i("amount", "float", 1)], out: "color" },
  vibrance: { label: "Vibrance", cat: "color", fn: "vibrance", inputs: [i("color", "color"), i("amount", "float", 1)], out: "color" },
  luminance: fn1("Luminance", "luminance", "color", "color"),
  grayscale: fn1("Grayscale", "grayscale", "color", "color"),
  posterize: { label: "Posterize", cat: "color", fn: "posterize", inputs: [i("color", "color"), i("steps", "float", 4)], out: "color" },
  blendOverlay: fn2("Blend Overlay", "blendOverlay", null, null, "color"),
  blendScreen: fn2("Blend Screen", "blendScreen", null, null, "color"),
  blendDodge: fn2("Blend Dodge", "blendDodge", null, null, "color"),
  blendBurn: fn2("Blend Burn", "blendBurn", null, null, "color"),
  hsvToRgb: fn1("HSV to RGB", "mx_hsvtorgb", "color", "color"),
  rgbToHsv: fn1("RGB to HSV", "mx_rgbtohsv", "color", "color"),

  // --- utility ---
  fresnel: {
    label: "Fresnel", cat: "utility", inputs: [i("power", "float", 3)], out: "float",
    build: ({ ins }) => TSL.pow(TSL.oneMinus(TSL.saturate(TSL.dot(TSL.normalView, TSL.positionViewDirection))), ins.power),
    gen: ({ args, use }) =>
      `${use("pow")}(${use("oneMinus")}(${use("saturate")}(${use("dot")}(${use("normalView", true)}, ${use("positionViewDirection", true)}))), ${args.power})`,
  },
  parabola: { label: "Parabola", cat: "utility", fn: "parabola", inputs: [i("x", "float"), i("k", "float", 1)], out: "float" },
  gain: { label: "Gain", cat: "utility", fn: "gain", inputs: [i("x", "float"), i("k", "float", 1)], out: "float" },
  pcurve: { label: "P-Curve", cat: "utility", fn: "pcurve", inputs: [i("x", "float"), i("a", "float", 0.5), i("b", "float", 0.5)], out: "float" },

  // --- advanced ---
  // Escape hatch: write a raw TSL JS expression using up to 4 wired inputs
  // (a/b/c/d) plus any `three/tsl` export in scope (mix, sin, uv, time, …).
  customFn: {
    label: "Custom Fn", cat: "advanced",
    inputs: [i("a", "any"), i("b", "any"), i("c", "any"), i("d", "any")],
    params: [{ key: "code", type: "code", default: "a" }],
    out: "any",
    build: ({ ins, props }) => runCustomCode(props.code, ins),
    gen: ({ args, props, use }) => {
      // Best-effort: pull any three/tsl export the snippet references into
      // the generated file's import list (may over/under-match; the user
      // owns cleanup of generated code).
      for (const word of (props.code ?? "").match(/[A-Za-z_$][\w$]*/g) ?? []) {
        if (!["a", "b", "c", "d"].includes(word) && typeof TSL[word] !== "undefined") use(word);
      }
      return `(() => { const a = ${args.a}, b = ${args.b}, c = ${args.c}, d = ${args.d}; return (${props.code || "null"}); })()`;
    },
  },

  // --- volume ---
  // Volume nodes wire into Material Output's Volume socket, compiling to
  // `scatteringNode` + `scatteringEmissiveNode` callbacks for
  // `VolumeNodeMaterial`. The material's built-in `VolumetricLightingModel`
  // marches the bounds, iterates every scene light (including shadow maps), and
  // composites the result with proper transmittance. `MeshComponent` snaps the
  // geometry to `BoxGeometry(1,1,1)` for correct march bounds.
  volumeScatter: {
    label: "Volume Scatter",
    cat: "volume",
    inputs: [
      i("color", "color", "#ffffff"),
      i("density", "float", 1),
      i("anisotropy", "float", 0),
    ],
    params: [{ key: "steps", type: "number", default: 32, min: 1, step: 1 }],
    out: "volume",
    build: ({ ins, props }) => {
      const colorNode = ins.color ?? TSL.uniform(new THREE.Color("#ffffff"));
      const densityNode = ins.density ?? TSL.float(1);
      return volumeBundle({
        density: (p) => densityNode.mul(cloudDensity(p)),
        albedo: colorNode,
        emission: null,
        steps: props.steps,
      });
    },
  },
  volumeAbsorption: {
    label: "Volume Absorption",
    cat: "volume",
    inputs: [
      i("color", "color", "#000000"),
      i("density", "float", 1),
    ],
    params: [{ key: "steps", type: "number", default: 32, min: 1, step: 1 }],
    out: "volume",
    build: ({ ins, props }) => {
      const densityNode = ins.density ?? TSL.float(1);
      return volumeBundle({
        density: (p) => densityNode.mul(cloudDensity(p)),
        albedo: null,
        emission: null,
        steps: props.steps,
      });
    },
  },
  principledVolume: {
    label: "Principled Volume",
    cat: "volume",
    inputs: [
      i("color", "color", "#ffffff"),
      i("colorAttribute", "any"),
      i("density", "float", 1),
      i("anisotropy", "float", 0),
      i("emissionColor", "color", "#000000"),
      i("emissionStrength", "float", 0),
      i("blackbodyIntensity", "float", 0),
      i("blackbodyTint", "color", "#ffffff"),
      i("temperature", "any"),
    ],
    params: [{ key: "steps", type: "number", default: 48, min: 1, step: 1 }],
    out: "volume",
    build: ({ ins, props }) => {
      const scatterColor = ins.color ?? TSL.uniform(new THREE.Color("#ffffff"));
      const colorAttr = ins.colorAttribute;
      const densityNode = ins.density ?? TSL.float(1);
      const emissionC = ins.emissionColor ?? TSL.uniform(new THREE.Color("#000000"));
      const emissionS = ins.emissionStrength ?? TSL.float(0);
      const bbIntensity = ins.blackbodyIntensity ?? TSL.float(0);
      const bbTint = ins.blackbodyTint ?? TSL.uniform(new THREE.Color("#ffffff"));
      const emit = emissionC.mul(emissionS).add(bbTint.mul(bbIntensity));

      return volumeBundle({
        density: (p) => densityNode.mul(colorAttr ? TSL.float(colorAttr) : cloudDensity(p)),
        albedo: scatterColor,
        emission: emit,
        steps: props.steps,
      });
    },
  },

  // --- shaders (surface) ---
  // Blender-style: these are the nodes you wire into Material Output's
  // `Surface` socket. They carry the per-channel inputs (Color, Roughness, …)
  // and compile to a surface bundle (see `buildSurface`). The "cheap" channels
  // have inline-editable defaults; the expensive ones (normal, anisotropy,
  // clearcoat*, sheen*, transmission, thickness) are wire-only so they don't
  // switch on their lighting path unless the user explicitly connects them.
  principledBsdf: {
    label: "Principled BSDF",
    cat: "shader",
    out: "surface",
    inputs: [
      i("color", "color", "#ffffff"),
      i("roughness", "float", 0.5),
      i("metalness", "float", 0),
      i("ior", "float", 1.5),
      i("specularIntensity", "float", 0.5),
      i("specularColor", "color", "#ffffff"),
      i("emissive", "color", "#000000"),
      i("emissiveStrength", "float", 1),
      i("opacity", "float", 1),
      i("ao", "float", 1),
      i("normal", "vec3"),
      i("anisotropy", "float"),
      i("clearcoat", "float"),
      i("clearcoatRoughness", "float"),
      i("sheen", "color"),
      i("sheenRoughness", "float"),
      i("transmission", "float"),
      i("thickness", "float"),
    ],
    surfaceSlots: {
      color: "colorNode", roughness: "roughnessNode", metalness: "metalnessNode",
      ior: "iorNode", specularIntensity: "specularIntensityNode", specularColor: "specularColorNode",
      opacity: "opacityNode", ao: "aoNode", normal: "normalNode", anisotropy: "anisotropyNode",
      clearcoat: "clearcoatNode", clearcoatRoughness: "clearcoatRoughnessNode",
      sheen: "sheenNode", sheenRoughness: "sheenRoughnessNode",
      transmission: "transmissionNode", thickness: "thicknessNode",
    },
    emissive: { color: "emissive", strength: "emissiveStrength" },
    build: ({ def, ins }) => buildSurface(def, ins),
  },
  emission: {
    label: "Emission",
    cat: "shader",
    out: "surface",
    inputs: [
      i("color", "color", "#ffffff"),
      i("strength", "float", 1),
    ],
    emitterBase: true,
    emissive: { color: "color", strength: "strength" },
    build: ({ def, ins }) => buildSurface(def, ins),
  },

  // --- output ---
  output: {
    label: "Material Output", cat: "output",
    inputs: OUTPUT_SLOTS.map((s) => i(s.key, s.type)),
    outputs: [],
  },
};

export const CATEGORY_LABELS = {
  value: "Values", attribute: "Attributes", osc: "Time & Oscillators", math: "Math",
  vector: "Vector", noise: "Noise", texture: "Texture", color: "Color", utility: "Utility",
  shader: "Shaders", volume: "Volume", advanced: "Advanced", output: "Output",
};

export function nodeDefaults(type) {
  const def = NODE_TYPES[type];
  const props = {};
  for (const p of def?.params ?? []) props[p.key] = Array.isArray(p.default) ? [...p.default] : p.default;
  return props;
}

function num(v) {
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e5) / 1e5);
}

/** Builtin TSL source by export name — callable exports are invoked, node
 *  objects (time, positionWorld, …) returned as-is. In a volume graph the
 *  position sources resolve to the raymarch sample (see `volumeRayLocal`) so
 *  Position-driven nodes (Noise, …) vary through the volume, not its surface. */
function builtin(name, volumeMode = false) {
  if (volumeMode) {
    if (name === "positionLocal") return volumeRayLocal;
    if (name === "positionWorld") return volumeRayWorld();
  }
  const v = TSL[name];
  return typeof v === "function" ? v() : v;
}

/** Uniform node for an unwired-but-valued input. Arrays → Vector2/3/4,
 *  hex strings → Color, numbers → float. */
function makeUniform(value) {
  if (typeof value === "number") return TSL.uniform(value);
  if (typeof value === "string") return TSL.uniform(new THREE.Color(value));
  if (Array.isArray(value)) {
    const V = [null, null, THREE.Vector2, THREE.Vector3, THREE.Vector4][value.length];
    if (V) return TSL.uniform(new V(...value));
  }
  return null;
}

/** Evaluates a Custom Fn node's code string with `a/b/c/d` bound to its wired
 *  inputs and every `three/tsl` export available by bare name (`with(TSL)`).
 *  `new Function` bodies run as non-strict sloppy-mode code even from an ES
 *  module, so `with` is legal here. Same trust model as ScriptComponent's
 *  dynamic script loading — this is local editor/game code, not untrusted
 *  network input. */
function runCustomCode(code, ins) {
  if (!code) return null;
  const { a = null, b = null, c = null, d = null } = ins;
  const fn = new Function("TSL", "a", "b", "c", "d", `with (TSL) { return (${code}); }`);
  return fn(TSL, a, b, c, d);
}

export function setUniformValue(uniformNode, value) {
  const cur = uniformNode.value;
  if (typeof cur === "number") uniformNode.value = value;
  else if (cur?.isColor) cur.set(value);
  else if (cur?.set && Array.isArray(value)) cur.set(...value);
}

/** Shared graph-texture loader, exported so the stock-PBR path in
 *  materialAsset loads the SAME cached instance (same SRGB default, same .meta
 *  override, same Basis handling) a graph compile would — pixel parity between
 *  the two paths is what makes the stock expression an invisible swap. */
export const loadShaderTexture = loadTexture;

/**
 * Recognizes the canonical imported-PBR graph — the shape every GLB import
 * produces — and returns its stock-material expression, or null.
 *
 * WHY (§13.15): compileShaderGraph mints fresh uniform/texture nodes per
 * material, and three r185 keys programs on node IDENTITY
 * (`Node.customCacheKey() → this.id`), so 26 structurally identical imported
 * materials compile 26 programs: the whole material wave is N× main-thread
 * codegen for ONE program's worth of structure (WGSL proven identical modulo
 * node-id naming and emission order). Materials expressed through PLAIN
 * properties instead share three's stock program cache key (type + property
 * walk — no node ids), so every material this matcher accepts costs zero
 * extra codegens after the first of its feature set.
 *
 * Deliberately conservative: exactly one Principled BSDF into Output.surface,
 * textures only as `texture.out → color` and `texture.out → normalMap → normal`
 * with default UVs, everything else constant. Any other wire, swizzle, prop on
 * a wire-only channel, non-opaque opacity, constant AO ≠ 1, or non-black
 * emissive keeps the graph on the compile path unchanged. (Texture-fed
 * emissive must NEVER be stock-expressed: GI's resolveMaterialSurface guards
 * area-light wash via `emissiveNode`'s texture, and `material.emissiveMap`
 * would bypass that guard.)
 */
export function matchStockPbr(graph) {
  // A/B hatch (R12): boot with __noStockPbr = true to force every graph onto
  // the compile path — one flag isolates this optimization in any comparison.
  if (globalThis.__noStockPbr) return null;
  const nodes = graph?.nodes ?? [];
  const edges = graph?.edges ?? [];
  if (!nodes.length) return null;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const counts = { texture: 0, normalMap: 0, principledBsdf: 0, output: 0 };
  for (const n of nodes) {
    if (!(n.type in counts)) return null;
    counts[n.type]++;
  }
  if (counts.principledBsdf !== 1 || counts.output !== 1 || counts.normalMap > 1) return null;
  const bsdf = nodes.find((n) => n.type === "principledBsdf");
  const output = nodes.find((n) => n.type === "output");
  const nm = nodes.find((n) => n.type === "normalMap") ?? null;

  // Classify every edge; anything unrecognized disqualifies the graph.
  let surfaceWired = false;
  let colorTex = null;
  let normalFeed = null; // texture node feeding the normalMap node
  let normalWired = false;
  let roughnessTex = null; // texture node whose .g feeds roughness
  let metalnessTex = null; // texture node whose .b feeds metalness
  let alphaTex = null; // texture node whose .a feeds opacity
  const texUses = new Map(); // texture node -> use count
  for (const e of edges) {
    const src = byId.get(e.source);
    const dst = byId.get(e.target);
    if (!src || !dst) return null;
    if (src === bsdf && dst === output && e.targetHandle === "surface") {
      if (surfaceWired) return null;
      surfaceWired = true;
      continue;
    }
    // The canonical glTF ORM/ARM packing — one texture whose green channel is
    // roughness and whose blue channel is metalness. This is not an
    // approximation of the graph, it is the SAME arithmetic: three composes
    // `roughness * roughnessMap.g` and `metalness * metalnessMap.b`
    // (three.webgpu.js:17362,17371), which is exactly what `.g → roughness`
    // and `.b → metalness` emit here, with the factors pinned to 1 below.
    //
    // ⚠ ONLY these two channel pairings. `.r → roughness` would be a different
    // texel and there is no stock property that samples it, so anything else
    // must keep falling through to the compile path. Occlusion is deliberately
    // absent too: three's `aoMap` reads a different UV set, so expressing a
    // wired `ao` through it would move the lookup, not just re-spell it.
    if (
      src.type === "texture" &&
      dst === bsdf &&
      ((e.sourceHandle === "g" && e.targetHandle === "roughness") ||
        (e.sourceHandle === "b" && e.targetHandle === "metalness"))
    ) {
      if (e.targetHandle === "roughness") {
        if (roughnessTex) return null;
        roughnessTex = src;
      } else {
        if (metalnessTex) return null;
        metalnessTex = src;
      }
      texUses.set(src, (texUses.get(src) ?? 0) + 1);
      continue;
    }
    // Alpha-masked foliage: the colour texture's OWN alpha into opacity. three
    // composes `materialColor` as `color * texture(map)` — a vec4 — and assigns
    // it straight to `diffuseColor`, so `map.a` is already the opacity on the
    // stock path. This wire is spelling out what stock does for free.
    //
    // ⚠ ONLY from the colour texture (checked after the loop). Another
    // texture's alpha has no stock slot — three's `alphaMap` reads `.g`, not
    // `.a` — so routing one through `map` would sample a different channel of
    // a different image.
    if (src.type === "texture" && e.sourceHandle === "a" && dst === bsdf && e.targetHandle === "opacity") {
      if (alphaTex) return null;
      alphaTex = src;
      texUses.set(src, (texUses.get(src) ?? 0) + 1);
      continue;
    }
    if (src.type === "texture" && e.sourceHandle === "out" && dst === bsdf && e.targetHandle === "color") {
      if (colorTex) return null;
      colorTex = src;
      texUses.set(src, (texUses.get(src) ?? 0) + 1);
      continue;
    }
    if (src.type === "texture" && e.sourceHandle === "out" && dst === nm && e.targetHandle === "color") {
      if (normalFeed) return null;
      normalFeed = src;
      texUses.set(src, (texUses.get(src) ?? 0) + 1);
      continue;
    }
    if (src === nm && dst === bsdf && e.targetHandle === "normal") {
      if (normalWired) return null;
      normalWired = true;
      continue;
    }
    return null;
  }
  if (!surfaceWired) return null;
  // A normalMap node must be a complete texture → normal chain, every texture
  // must be consumed by at least one recognized role, and none may have a
  // wired UV (an edge INTO a texture was already rejected above — every
  // allowed edge targets bsdf, nm, or output).
  //
  // "At least one" rather than "exactly one": an ORM map legitimately feeds
  // both roughness and metalness, and every edge reaching this point has
  // already been classified, so a second use can only be a second role.
  if (nm && (!normalFeed || !normalWired)) return null;
  // See the opacity branch: only the COLOUR texture's alpha is expressible,
  // because the stock path gets it through `map` and nothing else.
  if (alphaTex && alphaTex !== colorTex) return null;
  for (const n of nodes) {
    if (n.type !== "texture") continue;
    if ((texUses.get(n) ?? 0) < 1) return null;
    if (!n.props?.path) return null;
  }

  // Constants: props ?? registry default, straight from the same specs the
  // compiler reads, so the two paths can never drift on a default.
  const specs = NODE_TYPES.principledBsdf.inputs;
  const valueOf = (key) => {
    const spec = specs.find((s) => s.key === key);
    return bsdf.props?.[key] ?? spec?.default ?? null;
  };
  // Wire-only channels (default null): a stored prop value would compile to a
  // live uniform on the graph path, which stock props cannot express.
  for (const spec of specs) {
    if (spec.default !== null) continue;
    if (spec.key === "normal") continue; // handled structurally above
    if (bsdf.props?.[spec.key] != null) return null;
  }
  const opacity = valueOf("opacity");
  const ao = valueOf("ao");
  if (opacity !== 1 || ao !== 1) return null;
  const emissive = new THREE.Color(valueOf("emissive") ?? "#000000");
  const emissiveStrength = valueOf("emissiveStrength") ?? 1;
  if ((emissive.r > 0 || emissive.g > 0 || emissive.b > 0) && emissiveStrength !== 0) return null;

  return {
    // A wired color input is the texture ALONE on the graph path (no factor
    // multiply), so the stock expression must pin the factor to white.
    color: colorTex ? "#ffffff" : valueOf("color"),
    // Same rule as colour, for the same reason: a wired channel REPLACES the
    // scalar on the graph path, while three MULTIPLIES the map by it. Pinning
    // to 1 is what makes the two paths the same number rather than nearly.
    roughness: roughnessTex ? 1 : valueOf("roughness"),
    metalness: metalnessTex ? 1 : valueOf("metalness"),
    ior: valueOf("ior"),
    specularIntensity: valueOf("specularIntensity"),
    specularColor: valueOf("specularColor"),
    map: colorTex?.props?.path ?? null,
    normalMap: normalFeed?.props?.path ?? null,
    roughnessMap: roughnessTex?.props?.path ?? null,
    metalnessMap: metalnessTex?.props?.path ?? null,
    normalScale: nm ? (nm.props?.scale ?? 1) : 1,
  };
}

/**
 * `uvNode` replaces the graph's default `uv()` source wherever a node falls
 * back to it (texture nodes, most notably). Terrain needs this: it blends
 * several layer .mats into one material and each layer samples at its own
 * tiling, which is impossible if every graph hard-codes the mesh's raw UV.
 */
export async function compileShaderGraph(graph, { taps, uvNode = null } = {}) {
  if (!graph?.nodes?.length) return null;
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const edges = graph.edges ?? [];

  // Async prep: load all referenced textures before the (sync) build pass.
  const textures = new Map();
  await Promise.all(
    graph.nodes
      .filter((n) => n.type === "texture" && n.props?.path)
      .map((n) =>
        loadTexture(n.props.path)
          .then((tex) => textures.set(n.id, tex))
          .catch((err) => console.error(`Shader texture "${n.props.path}": ${err.message}`)),
      ),
  );

  const uniforms = {};
  const uni = (key, node) => ((uniforms[key] = node), node);
  const cache = new Map();

  // Known up-front so position sources can resolve to the raymarch sample while
  // building the volume subtree (see `builtin`).
  const outputId = graph.nodes.find((n) => n.type === "output")?.id;
  const isVolume = outputId != null && edges.some((e) => e.target === outputId && e.targetHandle === "volume");

  const source = (name) => (name === "uv" && uvNode ? uvNode : builtin(name, isVolume));

  function inputNode(node, spec) {
    const edge = edges.find((e) => e.target === node.id && e.targetHandle === spec.key);
    if (edge) return build(edge.source, edge.sourceHandle);
    const value = node.props?.[spec.key] ?? spec.default;
    if (value != null) {
      const u = makeUniform(value);
      if (u) return uni(`${node.id}.${spec.key}`, u);
    }
    return spec.src ? source(spec.src) : null;
  }

  function build(id, outKey) {
    const node = nodeById.get(id);
    const def = node && NODE_TYPES[node.type];
    if (!def) return null;
    const out = def.outputs?.length ? (def.outputs.includes(outKey) ? outKey : def.outputs[0]) : "out";
    const memoKey = `${id}|${out}`;
    if (cache.has(memoKey)) return cache.get(memoKey);
    let result = null;
    try {
      const ins = {};
      for (const spec of def.inputs ?? []) ins[spec.key] = inputNode(node, spec);
      if (def.build) {
        result = def.build({ def, ins, out, props: node.props ?? {}, id, uni, textures });
      } else if (def.fn && !def.inputs?.length) {
        // Attribute-source node (uv, time, positionWorld, …) — may be a
        // callable TSL builder or a plain pre-built Node object.
        result = source(def.fn);
      } else if (def.fn) {
        const args = def.inputs.map((s) => ins[s.key]);
        while (args.length && args[args.length - 1] == null) args.pop();
        if (!args.includes(null)) result = TSL[def.fn](...args);
      }
    } catch (err) {
      console.error(`Shader node ${node.type} (${id}): ${err.message}`);
    }
    cache.set(memoKey, result);
    return result;
  }

  const mutations = {};
  const outputNode = graph.nodes.find((n) => n.type === "output");
  if (outputNode) {
    for (const slot of OUTPUT_SLOTS) {
      const edge = edges.find((e) => e.target === outputNode.id && e.targetHandle === slot.key);
      if (!edge) continue;
      const node = build(edge.source, edge.sourceHandle);
      if (node == null) continue;
      if (slot.key === "surface") {
        if (node.__surface) Object.assign(mutations, node.__surface);
        else mutations.colorNode = node;
      } else if (slot.key === "volume") {
        // Volume bundle → consumed by the material-asset layer to drive a
        // VolumeNodeMaterial (scatteringNode / scatteringEmissiveNode / steps).
        if (node.__volume) mutations.__volume = node.__volume;
      } else {
        mutations[slot.slot] = node;
      }
    }
  }

  const tapNodes = {};
  if (taps) for (const id of taps) tapNodes[id] = build(id, null);

  // `isVolume` (computed up-front) — the Output's Volume socket being wired
  // selects the volume material class.
  return { mutations, uniforms, taps: tapNodes, isVolume };
}

// --- Migration ------------------------------------------------------------
// The Output is Blender-style (Surface / Volume / Displacement) with first-class
// shader nodes (Principled BSDF, Emission) feeding Surface, so modern graphs
// compile directly with no rewrite.
//
// The one thing that does need rewriting: a Texture wired STRAIGHT into a
// `normal` input. A normal map stores a tangent-space vector packed into 0..1
// texels — feeding those raw RGB values in as a normal vector produces normals
// that all point roughly +Z-ish in the wrong space, so lighting collapses and
// the surface goes dark. It has to pass through a Normal Map node, which
// unpacks (texel·2−1) and applies the TBN transform.
//
// Older importers emitted the direct wire; the generator now inserts the node
// itself (see pbrMaterialGraph.js), but .mat files already on disk still carry
// the broken edge and would never be regenerated. Repair them on load.
export function migrateGraph(graph) {
  if (!graph?.nodes?.length) return graph;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const edges = graph.edges ?? [];
  const direct = edges.filter(
    (e) => e.targetHandle === "normal" && byId.get(e.source)?.type === "texture",
  );
  if (!direct.length) return graph;

  const nodes = [...graph.nodes];
  const next = edges.filter((e) => !direct.includes(e));
  for (const edge of direct) {
    const tex = byId.get(edge.source);
    let id = `normalMap_${edge.source}`;
    while (byId.has(id)) id = `${id}_`;
    nodes.push({
      id,
      type: "normalMap",
      props: { scale: 1 },
      position: { x: (tex.position?.x ?? 0) + 260, y: tex.position?.y ?? 0 },
    });
    // Always take the texture's full color, never a single channel — a normal
    // map needs all three components.
    next.push({ source: edge.source, sourceHandle: "out", target: id, targetHandle: "color" });
    next.push({ source: id, sourceHandle: "out", target: edge.target, targetHandle: "normal" });
  }
  return { ...graph, nodes, edges: next };
}

// --- Code generation --------------------------------------------------------

/** Emits readable three/tsl JavaScript for the graph. */
export function generateTslCode(graph) {
  if (!graph?.nodes?.length) return "// empty graph";
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const edges = graph.edges ?? [];
  const imports = new Set();
  const lines = [];
  const names = new Map(); // `${id}|${out}` -> var name
  const counts = {};

  const use = (name, threeImport = false) => {
    imports.add(threeImport && name === "color" ? "color" : name);
    return name;
  };

  function emit(id, outKey) {
    const node = nodeById.get(id);
    const def = node && NODE_TYPES[node.type];
    if (!def) return "null";
    const out = def.outputs?.length ? (def.outputs.includes(outKey) ? outKey : def.outputs[0]) : "out";
    const memoKey = `${id}|${out}`;
    if (names.has(memoKey)) return names.get(memoKey);

    const args = {};
    for (const spec of def.inputs ?? []) {
      const edge = edges.find((e) => e.target === id && e.targetHandle === spec.key);
      if (edge) args[spec.key] = emit(edge.source, edge.sourceHandle);
      else {
        const value = node.props?.[spec.key] ?? spec.default;
        if (value != null) {
          args[spec.key] =
            typeof value === "string"
              ? `${use("color")}('${value}')`
              : Array.isArray(value)
                ? `${use(`vec${value.length}`)}(${value.map(num).join(", ")})`
                : num(value);
        } else if (spec.src) {
          const v = TSL[spec.src];
          args[spec.key] = typeof v === "function" ? `${use(spec.src)}()` : use(spec.src);
        } else args[spec.key] = null;
      }
    }

    const name = `${node.type}${(counts[node.type] = (counts[node.type] ?? 0) + 1)}`;
    let expr;
    if (def.gen) {
      expr = def.gen({ args, out, props: node.props ?? {}, use, name });
      if (node.type === "texture") lines.push(`const ${name}_map = new THREE.Texture(); // TODO load "${node.props?.path ?? ""}"`);
    } else if (def.fn && !def.inputs?.length) {
      // Attribute-source node — only append call parens if it's actually callable.
      expr = typeof TSL[def.fn] === "function" ? `${use(def.fn)}()` : use(def.fn);
    } else if (def.fn) {
      const list = def.inputs.map((s) => args[s.key]);
      while (list.length && list[list.length - 1] == null) list.pop();
      expr = `${use(def.fn)}(${list.join(", ")})`;
    } else expr = "null";
    lines.push(`const ${name} = ${expr};`);
    names.set(memoKey, name);
    return name;
  }

  // Expression for one input of `node` — a wired upstream, else its inline
  // value, else null (wire-only input left unconnected).
  const inputExpr = (node, key) => {
    const def = NODE_TYPES[node.type];
    const spec = def.inputs?.find((s) => s.key === key);
    if (!spec) return null;
    const edge = edges.find((e) => e.target === node.id && e.targetHandle === key);
    if (edge) return emit(edge.source, edge.sourceHandle);
    const value = node.props?.[key] ?? spec.default;
    if (value == null) return null;
    return typeof value === "string"
      ? `${use("color")}('${value}')`
      : Array.isArray(value)
        ? `${use(`vec${value.length}`)}(${value.map(num).join(", ")})`
        : num(value);
  };

  // Emit `material.<slot> = <expr>;` for every channel a Surface shader node
  // drives (mirrors `buildSurface`).
  const emitSurface = (src) => {
    const sdef = NODE_TYPES[src.type];
    if (sdef.emitterBase) {
      assignments.push(`material.colorNode = ${use("vec3")}(0);`);
      assignments.push(`material.roughnessNode = ${use("float")}(1);`);
      assignments.push(`material.metalnessNode = ${use("float")}(0);`);
    }
    for (const [inKey, matSlot] of Object.entries(sdef.surfaceSlots ?? {})) {
      const expr = inputExpr(src, inKey);
      if (expr != null) assignments.push(`material.${matSlot} = ${expr};`);
    }
    if (sdef.emissive) {
      const c = inputExpr(src, sdef.emissive.color);
      const s = inputExpr(src, sdef.emissive.strength);
      if (c != null) assignments.push(`material.emissiveNode = ${s != null ? `${use("mul")}(${c}, ${s})` : c};`);
    }
  };

  const assignments = [];
  const output = graph.nodes.find((n) => n.type === "output");
  if (output) {
    for (const slot of OUTPUT_SLOTS) {
      const edge = edges.find((e) => e.target === output.id && e.targetHandle === slot.key);
      if (!edge) continue;
      const src = nodeById.get(edge.source);
      const sdef = src && NODE_TYPES[src.type];
      if (slot.key === "surface" && (sdef?.surfaceSlots || sdef?.emitterBase || sdef?.emissive)) {
        emitSurface(src);
      } else {
        const matSlot = slot.key === "surface" ? "colorNode" : slot.slot;
        assignments.push(`material.${matSlot} = ${emit(edge.source, edge.sourceHandle)};`);
      }
    }
  }
  if (!assignments.length) return "// nothing wired to the Material Output";

  return [
    `import { ${[...imports].sort().join(", ")} } from 'three/tsl';`,
    "",
    "// const material = new THREE.MeshPhysicalNodeMaterial();",
    ...lines,
    "",
    ...assignments,
  ].join("\n");
}
