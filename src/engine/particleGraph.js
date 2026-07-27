import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshSurfaceSampler } from "three/addons/math/MeshSurfaceSampler.js";
import {
  Fn,
  PI2,
  clamp,
  cross,
  float,
  hash,
  instancedArray,
  mix,
  mx_fractal_noise_float,
  mx_noise_float,
  mx_noise_vec3,
  mx_worley_noise_float,
  normalize,
  smoothstep,
  time,
  uniform,
  vec3,
} from "three/tsl";
import { resolveAssetUrl } from "./assetResolver.js";
import { loadTextureAsset } from "./textureAsset.js";
import { sampleSurfacePoints, sampleVolumePoints } from "./meshSampling.js";

/**
 * Node-based GPU particle system: a graph of small logic nodes (emitters,
 * particle attributes, math, noise fields, forces) compiled to TSL and
 * evaluated in three contexts:
 *
 *   spawn  — init pass + respawn branch (per-respawn randomness available)
 *   update — per-frame compute pass (storage-buffer element access)
 *   render — sprite material (per-instance attribute access)
 *
 * The same wire can feed any context; attribute nodes (age, position, …)
 * resolve to whatever that context provides. Each System node anchors one
 * independent emitter branch: its inputs are the six evaluation roots, and
 * its upstream nodes are traced in isolation from any other System node in
 * the same graph. A graph may contain several System nodes — that's how one
 * particle component runs multiple emitters (e.g. flame + embers) at once.
 */

const MESH_SAMPLE_COUNT = 2048;

// ---------------------------------------------------------------------------
// Node registry (metadata drives both the editor UI and the compiler)
// ---------------------------------------------------------------------------

const num = (key, label, def, extra = {}) => ({ key, label, type: "number", default: def, ...extra });
const v3 = (key, label, def) => ({ key, label, type: "vec3", default: def });
const col = (key, label, def) => ({ key, label, type: "color", default: def });

// Port helpers. The `type` drives the editor's socket colours and its
// connection validation (src/editor/nodegraph/socketTypes.js); the compiler
// ignores it, and TSL broadcasting means float/vec3 mixes stay legal.
const port = (key, label, type = "any") => ({ key, label, type });
const pv3 = (key, label) => port(key, label, "vec3");
const pf = (key, label) => port(key, label, "float");
const pcol = (key, label) => port(key, label, "color");

/** Emitters all expose the same two typed outputs. */
const EMIT_OUT = (dirLabel = "dir") => [pv3("pos", "pos"), pv3("dir", dirLabel)];

export const P_NODE_TYPES = {
  // --- Emitters: where particles are born. Outputs: pos + dir. -------------
  emitPoint: {
    label: "Point",
    category: "emitter",
    inputs: [],
    outputs: EMIT_OUT(),
    params: [v3("offset", "Offset", [0, 0, 0])],
  },
  emitSphere: {
    label: "Sphere",
    category: "emitter",
    inputs: [],
    outputs: EMIT_OUT(),
    params: [num("radius", "Radius", 0.5, { min: 0, step: 0.05 }), { key: "shell", label: "Shell only", type: "boolean", default: false }],
  },
  emitBox: {
    label: "Box",
    category: "emitter",
    inputs: [],
    outputs: EMIT_OUT(),
    params: [v3("size", "Size", [1, 1, 1])],
  },
  emitCone: {
    label: "Cone",
    category: "emitter",
    inputs: [],
    outputs: EMIT_OUT(),
    params: [num("radius", "Radius", 0.25, { min: 0, step: 0.05 }), num("angle", "Angle °", 25, { min: 0, max: 89 })],
  },
  emitCircle: {
    label: "Ring",
    category: "emitter",
    inputs: [],
    outputs: EMIT_OUT(),
    params: [num("radius", "Radius", 1, { min: 0, step: 0.05 })],
  },
  emitMesh: {
    label: "Mesh Surface",
    category: "emitter",
    inputs: [],
    outputs: EMIT_OUT("normal"),
    params: [
      { key: "path", label: "Model", type: "asset", exts: ["glb"], default: "" },
      num("scale", "Scale", 1, { min: 0.01, step: 0.1 }),
    ],
  },
  emitSelf: {
    label: "This Mesh",
    category: "emitter",
    inputs: [],
    outputs: EMIT_OUT("normal"),
    params: [
      { key: "mode", label: "Mode", type: "select", options: ["surface", "volume"], default: "surface" },
      num("scale", "Scale", 1, { min: 0.01, step: 0.1 }),
    ],
  },

  // --- Particle attributes (context-dependent reads) -----------------------
  pAge: { label: "Age", category: "attribute", inputs: [], outputs: [pf("out", "s")], params: [] },
  pLife: { label: "Life 0–1", category: "attribute", inputs: [], outputs: [pf("out", "t")], params: [] },
  pPosition: { label: "Position", category: "attribute", inputs: [], outputs: [pv3("out", "xyz")], params: [] },
  pVelocity: { label: "Velocity", category: "attribute", inputs: [], outputs: [pv3("out", "xyz")], params: [] },
  pRandom: {
    label: "Random",
    category: "attribute",
    inputs: [],
    outputs: [pf("out", "f")],
    params: [num("seed", "Seed", 1), num("min", "Min", 0), num("max", "Max", 1)],
  },
  simTime: { label: "Time", category: "attribute", inputs: [], outputs: [pf("out", "s")], params: [] },

  // --- Values ---------------------------------------------------------------
  float: { label: "Float", category: "value", inputs: [], outputs: [pf("out", "f")], params: [num("value", "Value", 1)] },
  vec3: { label: "Vec3", category: "value", inputs: [], outputs: [pv3("out", "xyz")], params: [v3("value", "Value", [0, 1, 0])] },
  color: { label: "Color", category: "value", inputs: [], outputs: [pcol("out", "rgb")], params: [col("value", "Color", "#ffffff")] },
  gradient: {
    label: "Gradient",
    category: "value",
    inputs: [pf("t", "t (life)")],
    outputs: [pcol("out", "rgb")],
    params: [col("from", "From", "#ffd27f"), col("to", "To", "#ff3300")],
  },
  blackbody: {
    label: "Blackbody",
    category: "value",
    // Fire-spectrum ramp: t (heat, 0..1) → dark → ember red → orange →
    // yellow → white-hot. Reads more like flame than a two-colour gradient.
    inputs: [pf("t", "t (heat)")],
    outputs: [pcol("out", "rgb")],
    params: [num("intensity", "Intensity", 1, { min: 0, step: 0.1 })],
  },

  // --- Math -------------------------------------------------------------------
  add: { label: "Add", category: "math", inputs: [port("a", "a"), port("b", "b")], outputs: [port("out", "=")], params: [] },
  multiply: { label: "Multiply", category: "math", inputs: [port("a", "a"), port("b", "b")], outputs: [port("out", "=")], params: [] },
  mix: {
    label: "Mix",
    category: "math",
    inputs: [port("a", "a"), port("b", "b"), pf("t", "t")],
    outputs: [port("out", "=")],
    params: [],
  },
  remap: {
    label: "Remap",
    category: "math",
    inputs: [port("v", "v")],
    outputs: [port("out", "=")],
    params: [num("inMin", "In min", 0), num("inMax", "In max", 1), num("outMin", "Out min", 0), num("outMax", "Out max", 1)],
  },
  sine: {
    label: "Sine",
    category: "math",
    inputs: [pf("t", "t")],
    outputs: [pf("out", "=")],
    params: [num("frequency", "Frequency", 1), num("amplitude", "Amplitude", 1), num("phase", "Phase", 0)],
  },
  normalizeV: { label: "Normalize", category: "math", inputs: [pv3("v", "v")], outputs: [pv3("out", "n̂")], params: [] },
  lengthV: { label: "Length", category: "math", inputs: [pv3("v", "v")], outputs: [pf("out", "f")], params: [] },
  combine: {
    label: "Combine XYZ",
    category: "math",
    inputs: [pf("x", "x"), pf("y", "y"), pf("z", "z")],
    outputs: [pv3("out", "xyz")],
    params: [],
  },
  split: {
    label: "Split XYZ",
    category: "math",
    inputs: [pv3("v", "v")],
    outputs: [pf("x", "x"), pf("y", "y"), pf("z", "z")],
    params: [],
  },

  // --- Noise fields (input p defaults to particle position) -------------------
  noise: {
    label: "Noise",
    category: "noise",
    inputs: [pv3("p", "p")],
    outputs: [pf("out", "f")],
    params: [num("frequency", "Frequency", 1), num("speed", "Scroll", 0.3), num("amplitude", "Amplitude", 1)],
  },
  noiseField: {
    label: "Noise Field",
    category: "noise",
    inputs: [pv3("p", "p")],
    outputs: [pv3("out", "xyz")],
    params: [num("frequency", "Frequency", 1), num("speed", "Scroll", 0.3), num("amplitude", "Amplitude", 1)],
  },
  curl: {
    label: "Curl Noise",
    category: "noise",
    inputs: [pv3("p", "p")],
    outputs: [pv3("out", "xyz")],
    params: [num("frequency", "Frequency", 0.6), num("speed", "Scroll", 0.25), num("amplitude", "Amplitude", 1)],
  },
  worley: {
    label: "Worley",
    category: "noise",
    inputs: [pv3("p", "p")],
    outputs: [pf("out", "f")],
    params: [num("frequency", "Frequency", 1), num("speed", "Scroll", 0.2), num("amplitude", "Amplitude", 1)],
  },
  fractal: {
    label: "Fractal Noise",
    category: "noise",
    inputs: [pv3("p", "p")],
    outputs: [pf("out", "f")],
    params: [num("frequency", "Frequency", 1), num("octaves", "Octaves", 3, { min: 1, max: 6, step: 1 }), num("speed", "Scroll", 0.2), num("amplitude", "Amplitude", 1)],
  },

  // --- Forces: vec3 accelerations wired (usually via Add) into System.force ---
  gravity: { label: "Gravity", category: "force", inputs: [], outputs: [pv3("out", "F")], params: [v3("vector", "m/s²", [0, -9.8, 0])] },
  drag: { label: "Drag", category: "force", inputs: [], outputs: [pv3("out", "F")], params: [num("amount", "Amount", 1, { min: 0 })] },
  turbulence: {
    label: "Turbulence",
    category: "force",
    inputs: [],
    outputs: [pv3("out", "F")],
    params: [num("frequency", "Frequency", 0.6), num("strength", "Strength", 2), num("speed", "Scroll", 0.3)],
  },
  vortex: {
    label: "Vortex",
    category: "force",
    inputs: [],
    outputs: [pv3("out", "F")],
    params: [v3("center", "Center", [0, 0, 0]), v3("axis", "Axis", [0, 1, 0]), num("strength", "Swirl", 5), num("pull", "Pull in", 0.5)],
  },
  attract: {
    label: "Attractor",
    category: "force",
    inputs: [],
    outputs: [pv3("out", "F")],
    params: [v3("point", "Point", [0, 2, 0]), num("strength", "Strength", 5), num("falloff", "Falloff", 1, { min: 0 })],
  },
  buoyancy: {
    label: "Buoyancy",
    category: "force",
    inputs: [],
    outputs: [pv3("out", "F")],
    params: [num("strength", "Heat", 3), num("flicker", "Flicker", 0.5)],
  },
  wind: {
    label: "Wind",
    category: "force",
    inputs: [],
    outputs: [pv3("out", "F")],
    params: [v3("direction", "Direction", [1, 0, 0]), num("strength", "Strength", 1), num("gustiness", "Gustiness", 0.5), num("gustFrequency", "Gust freq", 0.5)],
  },

  // --- System: the anchor. Inputs are the six evaluation roots. ---------------
  system: {
    label: "Particle System",
    category: "system",
    inputs: [
      pv3("position", "spawn position"),
      pv3("velocity", "spawn velocity"),
      pv3("force", "force"),
      pf("size", "size"),
      pcol("color", "color"),
      pf("opacity", "opacity"),
    ],
    outputs: [],
    params: [
      num("capacity", "Capacity", 2000, { min: 1, max: 100000, step: 100 }),
      num("lifetime", "Lifetime s", 2, { min: 0.05, step: 0.1 }),
      num("lifetimeJitter", "Life jitter", 0.3, { min: 0, max: 1, step: 0.05 }),
      num("sizeJitter", "Size jitter", 0.3, { min: 0, max: 1, step: 0.05 }),
      { key: "additive", label: "Additive", type: "boolean", default: true },
      { key: "texture", label: "Sprite", type: "asset", exts: ["png", "jpg", "jpeg", "webp"], default: "" },
      { key: "floor", label: "Floor", type: "select", options: ["none", "bounce", "kill"], default: "none" },
      num("floorY", "Floor Y", 0, { step: 0.1 }),
      num("bounce", "Bounce", 0.4, { min: 0, max: 1, step: 0.05 }),

      // --- Rendering: custom geometry, lighting, shadows -------------------
      { key: "geometryType", label: "Geometry", type: "select", options: ["quad", "plane", "box", "sphere", "cylinder", "cone", "torus"], default: "quad" },
      { key: "geometry", label: "Custom Geo", type: "asset", exts: ["glb"], default: "" },
      { key: "faceVelocity", label: "Face Velocity", type: "boolean", default: false },
      { key: "lit", label: "Lit", type: "boolean", default: false },
      { key: "castShadow", label: "Cast Shadow", type: "boolean", default: false },
      { key: "receiveShadow", label: "Receive Shadow", type: "boolean", default: false },

      // --- Collision ---------------------------------------------------------
      { key: "sceneCollision", label: "Scene Collision", type: "boolean", default: false },
      num("collisionBounce", "Coll. Bounce", 0.3, { min: 0, max: 1, step: 0.05 }),
      num("collisionFriction", "Coll. Friction", 0.1, { min: 0, max: 1, step: 0.05 }),
      { key: "selfCollision", label: "Self Collision", type: "boolean", default: false },
      num("collisionRadius", "Coll. Radius", 0.1, { min: 0.001, step: 0.01 }),
      num("collisionElasticity", "Coll. Elasticity", 0.5, { min: 0, max: 1, step: 0.05 }),

      // --- GI integration ---------------------------------------------------
      // Promotes the particle cloud to a DYNAMIC GI emitter: the same GPU
      // cluster readback that drives the point lights below is published to the
      // GI module's per-frame emitter slots instead. That makes the particles
      // real light sources in the radiance field — they bounce colour onto
      // nearby surfaces, cast the GI emissive shadow, and show up in mirrors —
      // rather than faking it with a PointLight that GI only sees second-hand.
      // No-op when the GI module isn't installed.
      { key: "giEmission", label: "GI Emission", type: "boolean", default: false },
      num("giEmissionStrength", "GI Emission Power", 1, { min: 0, step: 0.1 }),

      // --- Lighting integration: particles drive real point lights ---------
      num("lightCount", "Lights", 0, { min: 0, max: 8, step: 1 }),
      num("lightIntensity", "Light Power", 5, { min: 0, step: 0.5 }),
      num("lightDistance", "Light Range", 6, { min: 0, step: 0.5 }),
    ],
  },
};

export function nodeDefaults(type) {
  const meta = P_NODE_TYPES[type];
  return Object.fromEntries(
    (meta?.params ?? []).map((p) => [p.key, Array.isArray(p.default) ? [...p.default] : p.default]),
  );
}

// ---------------------------------------------------------------------------
// TSL helpers
// ---------------------------------------------------------------------------

const unitSphere = (r1, r2) => {
  const z = r1.mul(2).sub(1);
  const phi = r2.mul(PI2);
  const xy = z.mul(z).oneMinus().max(0).sqrt();
  return vec3(phi.cos().mul(xy), z, phi.sin().mul(xy));
};

/** Divergence-free curl of a vec3 noise field (finite differences). */
const curlNoise = /*@__PURE__*/ Fn(([p]) => {
  const e = float(0.1);
  const dx = vec3(e, 0, 0);
  const dy = vec3(0, e, 0);
  const dz = vec3(0, 0, e);

  const x0 = mx_noise_vec3(p.sub(dx)).toVar();
  const x1 = mx_noise_vec3(p.add(dx)).toVar();
  const y0 = mx_noise_vec3(p.sub(dy)).toVar();
  const y1 = mx_noise_vec3(p.add(dy)).toVar();
  const z0 = mx_noise_vec3(p.sub(dz)).toVar();
  const z1 = mx_noise_vec3(p.add(dz)).toVar();

  const divisor = e.mul(2);
  return vec3(
    y1.z.sub(y0.z).sub(z1.y.sub(z0.y)),
    z1.x.sub(z0.x).sub(x1.z.sub(x0.z)),
    x1.y.sub(x0.y).sub(y1.x.sub(y0.x)),
  ).div(divisor);
});

// ---------------------------------------------------------------------------
// Async asset preparation (mesh samples, sprite texture)
// ---------------------------------------------------------------------------

const gltfLoader = new GLTFLoader();
const meshSampleCache = new Map(); // path -> Promise<{positions: Float32Array, normals: Float32Array}>

function sampleMeshSurface(path) {
  let cached = meshSampleCache.get(path);
  if (!cached) {
    cached = (async () => {
      const url = await resolveAssetUrl(path);
      const gltf = await gltfLoader.loadAsync(url);
      let mesh = null;
      gltf.scene.traverse((o) => {
        if (!mesh && o.isMesh) mesh = o;
      });
      if (!mesh) throw new Error(`No mesh found in "${path}"`);
      mesh.updateWorldMatrix(true, false);
      const sampler = new MeshSurfaceSampler(mesh).build();
      const positions = new Float32Array(MESH_SAMPLE_COUNT * 3);
      const normals = new Float32Array(MESH_SAMPLE_COUNT * 3);
      const p = new THREE.Vector3();
      const n = new THREE.Vector3();
      for (let i = 0; i < MESH_SAMPLE_COUNT; i++) {
        sampler.sample(p, n);
        p.applyMatrix4(mesh.matrixWorld);
        positions.set([p.x, p.y, p.z], i * 3);
        normals.set([n.x, n.y, n.z], i * 3);
      }
      return { positions, normals };
    })();
    meshSampleCache.set(path, cached);
  }
  return cached;
}

const spriteTextureCache = new Map(); // path -> Promise<THREE.Texture>

function loadSpriteTexture(path) {
  let cached = spriteTextureCache.get(path);
  if (!cached) {
    cached = loadTextureAsset(path, { colorSpace: THREE.SRGBColorSpace });
    spriteTextureCache.set(path, cached);
  }
  return cached;
}

const particleGeometryCache = new Map(); // path -> Promise<THREE.BufferGeometry>

/** Loads the first mesh's geometry out of a .glb for use as custom particle geometry. */
function loadParticleGeometry(path) {
  let cached = particleGeometryCache.get(path);
  if (!cached) {
    cached = resolveAssetUrl(path)
      .then((url) => gltfLoader.loadAsync(url))
      .then((gltf) => {
        let mesh = null;
        gltf.scene.traverse((o) => {
          if (!mesh && o.isMesh) mesh = o;
        });
        if (!mesh) throw new Error(`No mesh found in "${path}"`);
        return mesh.geometry;
      });
    particleGeometryCache.set(path, cached);
  }
  return cached;
}

// ---------------------------------------------------------------------------
// Compiler
// ---------------------------------------------------------------------------

/**
 * Compiles a particle graph. Async part (mesh sampling, textures) happens
 * here; the returned builders are synchronous and safe inside Fn() bodies.
 *
 * A graph may contain several System nodes — each becomes one independent
 * entry in the returned `systems` array, its upstream nodes traced in
 * isolation from any other System node's inputs.
 *
 * Returns { systems: [{
 *   id: system node id,
 *   system: merged System-node params,
 *   spriteTexture: THREE.Texture | null,
 *   customGeometry: THREE.BufferGeometry | null,
 *   spawnPosition(ctx), spawnVelocity(ctx), force(ctx) | null,
 *   size(ctx), color(ctx), opacity(ctx) | null,
 * }] }
 * where ctx = { key, cache: Map, index, position, velocity, age, life01, rand(k) }.
 *
 * `opts.entity`, when given, lets `emitSelf` nodes sample the entity's own
 * MeshComponent geometry.
 */
export async function compileParticleGraph(graph, opts = {}) {
  const nodes = graph?.nodes ?? [];
  const sysNodes = nodes.filter((n) => n.type === "system");
  if (!sysNodes.length) throw new Error("Particle graph needs at least one Particle System node");

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const edges = graph.edges ?? [];

  // Async prep: mesh surface samples become storage buffers, shared by id
  // across however many System branches reference them.
  const meshBuffers = new Map(); // nodeId -> {pos, nrm}
  for (const n of nodes) {
    if (n.type === "emitMesh" && n.props?.path) {
      const { positions, normals } = await sampleMeshSurface(n.props.path);
      meshBuffers.set(n.id, {
        pos: instancedArray(positions, "vec3"),
        nrm: instancedArray(normals, "vec3"),
      });
    } else if (n.type === "emitSelf") {
      const geometry = opts.entity?.getComponent?.("mesh")?.mesh?.geometry;
      if (geometry) {
        const mode = n.props?.mode ?? "surface";
        const { positions, normals } =
          mode === "volume"
            ? sampleVolumePoints(geometry, MESH_SAMPLE_COUNT)
            : sampleSurfacePoints(geometry, MESH_SAMPLE_COUNT);
        meshBuffers.set(n.id, {
          pos: instancedArray(positions, "vec3"),
          nrm: instancedArray(normals, "vec3"),
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Hot-tunable params compile to uniform() nodes instead of inlined
  // constants. `updateParams(newGraph)` then refreshes their values without
  // recompiling TSL or rebuilding GPU pipelines — that's what makes slider
  // drags in the node editor cheap. Structural params (booleans, selects,
  // assets, capacity, octaves) still require a rebuild; see
  // `particleGraphSignature`.
  // -------------------------------------------------------------------------
  const uniformCache = new Map(); // `${nodeId}|${slot}` -> uniform node
  const paramAppliers = new Map(); // nodeId -> [(mergedProps) => void]

  function regUniform(nodeId, slot, P, kind, calc) {
    const id = `${nodeId}|${slot}`;
    let u = uniformCache.get(id);
    if (u) return u;
    const v = calc(P);
    u =
      kind === "vec3"
        ? uniform(new THREE.Vector3(v?.[0] ?? 0, v?.[1] ?? 0, v?.[2] ?? 0))
        : kind === "color"
          ? uniform(new THREE.Color(v ?? "#ffffff"))
          : uniform(v ?? 0);
    uniformCache.set(id, u);
    let appliers = paramAppliers.get(nodeId);
    if (!appliers) paramAppliers.set(nodeId, (appliers = []));
    appliers.push((newP) => {
      const nv = calc(newP);
      if (kind === "vec3") u.value.set(nv?.[0] ?? 0, nv?.[1] ?? 0, nv?.[2] ?? 0);
      else if (kind === "color") u.value.set(nv ?? "#ffffff");
      else u.value = nv ?? 0;
    });
    return u;
  }

  const inputEdge = (nodeId, key) =>
    edges.find((e) => e.target === nodeId && e.targetHandle === key);

  function input(nodeId, key, ctx, fallback) {
    const edge = inputEdge(nodeId, key);
    return edge ? build(edge.source, edge.sourceHandle ?? "out", ctx) : fallback;
  }

  function build(id, out, ctx) {
    const cacheKey = `${id}|${out}`;
    if (ctx.cache.has(cacheKey)) return ctx.cache.get(cacheKey);
    const node = nodeById.get(id);
    if (!node) return float(0);
    const P = { ...nodeDefaults(node.type), ...node.props };
    const value = buildNode(node, P, out, ctx);
    ctx.cache.set(cacheKey, value);
    return value;
  }

  function buildNode(node, P, out, ctx) {
    // Hot params → shared uniforms (cached per nodeId|slot across contexts).
    // `calc` derives the uniform's value from the node's merged props, so
    // derived quantities (tan of an angle, normalized axes) stay hot too.
    const fu = (slot, calc = (p) => p[slot] ?? 0) => regUniform(node.id, slot, P, "float", calc);
    const vu = (slot, calc = (p) => p[slot]) => regUniform(node.id, slot, P, "vec3", calc);
    const cu = (slot, calc = (p) => p[slot]) => regUniform(node.id, slot, P, "color", calc);
    const scroll = (speedKey) => time.mul(fu(speedKey));
    const noiseAt = (key, freqKey = "frequency", speedKey = "speed") =>
      input(node.id, key, ctx, ctx.position).mul(fu(freqKey)).add(scroll(speedKey));

    switch (node.type) {
      // Emitters -----------------------------------------------------------
      case "emitPoint": {
        if (out === "dir") return unitSphere(ctx.rand(1), ctx.rand(2));
        return vu("offset");
      }
      case "emitSphere": {
        const dir = unitSphere(ctx.rand(1), ctx.rand(2));
        if (out === "dir") return dir;
        const r = P.shell ? float(1) : ctx.rand(3).pow(1 / 3);
        return dir.mul(r).mul(fu("radius"));
      }
      case "emitBox": {
        if (out === "dir") return vec3(0, 1, 0);
        return vec3(ctx.rand(1), ctx.rand(2), ctx.rand(3)).sub(0.5).mul(vu("size"));
      }
      case "emitCone": {
        const phi = ctx.rand(1).mul(PI2);
        const rr = ctx.rand(2).sqrt();
        if (out === "dir") {
          const tanA = fu("tanAngle", (p) => Math.tan((Math.max(0.01, p.angle ?? 25) * Math.PI) / 180));
          return normalize(vec3(phi.cos().mul(rr).mul(tanA), 1, phi.sin().mul(rr).mul(tanA)));
        }
        return vec3(phi.cos().mul(rr), 0, phi.sin().mul(rr)).mul(fu("radius"));
      }
      case "emitCircle": {
        const phi = ctx.rand(1).mul(PI2);
        const radial = vec3(phi.cos(), 0, phi.sin());
        if (out === "dir") return radial;
        return radial.mul(fu("radius"));
      }
      case "emitMesh":
      case "emitSelf": {
        const buffers = meshBuffers.get(node.id);
        if (!buffers) return out === "dir" ? vec3(0, 1, 0) : vec3(0);
        const idx = ctx.rand(4).mul(MESH_SAMPLE_COUNT - 1).floor().toUint();
        if (out === "dir") return buffers.nrm.element(idx);
        return buffers.pos.element(idx).mul(fu("scale", (p) => p.scale ?? 1));
      }

      // Attributes -----------------------------------------------------------
      case "pAge":
        return ctx.age;
      case "pLife":
        return ctx.life01;
      case "pPosition":
        return ctx.position;
      case "pVelocity":
        return ctx.velocity;
      case "pRandom":
        return hash(ctx.index.add(fu("seedK", (p) => (p.seed ?? 1) * 127.1)))
          .mul(fu("span", (p) => (p.max ?? 1) - (p.min ?? 0)))
          .add(fu("min"));
      case "simTime":
        return time;

      // Values ----------------------------------------------------------------
      case "float":
        return fu("value");
      case "vec3":
        return vu("value");
      case "color":
        return cu("value");
      case "gradient": {
        const t = input(node.id, "t", ctx, ctx.life01);
        return mix(cu("from"), cu("to"), clamp(t, 0, 1));
      }
      case "blackbody": {
        const t = clamp(input(node.id, "t", ctx, ctx.life01), 0, 1);
        let c = mix(vec3(0), vec3(0.85, 0.13, 0.02), smoothstep(0.0, 0.28, t));
        c = mix(c, vec3(1.0, 0.45, 0.05), smoothstep(0.28, 0.55, t));
        c = mix(c, vec3(1.0, 0.85, 0.35), smoothstep(0.55, 0.8, t));
        c = mix(c, vec3(1.0, 0.98, 0.85), smoothstep(0.8, 1.0, t));
        return c.mul(fu("intensity"));
      }

      // Math --------------------------------------------------------------------
      case "add":
        return input(node.id, "a", ctx, float(0)).add(input(node.id, "b", ctx, float(0)));
      case "multiply":
        return input(node.id, "a", ctx, float(1)).mul(input(node.id, "b", ctx, float(1)));
      case "mix":
        return mix(
          input(node.id, "a", ctx, float(0)),
          input(node.id, "b", ctx, float(1)),
          clamp(input(node.id, "t", ctx, ctx.life01), 0, 1),
        );
      case "remap": {
        const v = input(node.id, "v", ctx, ctx.life01);
        return clamp(v.sub(fu("inMin")).div(fu("inSpan", (p) => (p.inMax ?? 1) - (p.inMin ?? 0) || 1)), 0, 1)
          .mul(fu("outSpan", (p) => (p.outMax ?? 1) - (p.outMin ?? 0)))
          .add(fu("outMin"));
      }
      case "sine": {
        const t = input(node.id, "t", ctx, time);
        return t.mul(fu("omega", (p) => (p.frequency ?? 1) * Math.PI * 2)).add(fu("phase")).sin().mul(fu("amplitude"));
      }
      case "normalizeV":
        return input(node.id, "v", ctx, vec3(0, 1, 0)).add(vec3(1e-6)).normalize();
      case "lengthV":
        return input(node.id, "v", ctx, vec3(0)).length();
      case "combine":
        return vec3(
          input(node.id, "x", ctx, float(0)),
          input(node.id, "y", ctx, float(0)),
          input(node.id, "z", ctx, float(0)),
        );
      case "split": {
        const v = input(node.id, "v", ctx, ctx.position);
        return out === "x" ? v.x : out === "y" ? v.y : v.z;
      }

      // Noise -----------------------------------------------------------------
      case "noise":
        return mx_noise_float(noiseAt("p")).mul(fu("amplitude"));
      case "noiseField":
        return mx_noise_vec3(noiseAt("p")).mul(fu("amplitude"));
      case "curl":
        return curlNoise(noiseAt("p")).mul(fu("amplitude"));
      case "worley":
        return mx_worley_noise_float(noiseAt("p")).mul(fu("amplitude"));
      case "fractal":
        // Fractal noise is linear in its amplitude argument, so scaling the
        // result by a uniform is equivalent to baking amplitude in — but hot.
        return mx_fractal_noise_float(noiseAt("p"), Math.round(P.octaves), 2, 0.5, 1).mul(fu("amplitude"));

      // Forces -----------------------------------------------------------------
      case "gravity":
        return vu("vector");
      case "drag":
        return ctx.velocity.mul(fu("negAmount", (p) => -(p.amount ?? 1)));
      case "turbulence":
        return curlNoise(ctx.position.mul(fu("frequency")).add(scroll("speed"))).mul(fu("strength"));
      case "vortex": {
        const axisN = vu("axisN", (p) => new THREE.Vector3(...(p.axis ?? [0, 1, 0])).normalize().toArray());
        const rel = ctx.position.sub(vu("center"));
        const radial = rel.sub(axisN.mul(rel.dot(axisN)));
        const tangent = cross(axisN, radial.add(vec3(1e-5))).normalize();
        return tangent.mul(fu("strength")).sub(radial.mul(fu("pull")));
      }
      case "attract": {
        const d = vu("point").sub(ctx.position);
        const dist = d.length().add(0.01);
        return d.div(dist).mul(fu("strength")).div(dist.mul(fu("falloff")).add(1));
      }
      case "buoyancy": {
        const flicker = mx_noise_float(ctx.position.mul(2).add(time.mul(2)))
          .mul(fu("flicker"))
          .add(1);
        return vec3(0, 1, 0).mul(fu("strength")).mul(ctx.life01.oneMinus()).mul(flicker);
      }
      case "wind": {
        const dirN = vu("dirN", (p) => new THREE.Vector3(...(p.direction ?? [1, 0, 0])).normalize().toArray());
        const gust = mx_noise_float(vec3(scroll("gustFrequency"), 0, 0).add(ctx.position.mul(0.1)))
          .mul(fu("gustiness"))
          .add(1);
        return dirN.mul(fu("strength")).mul(gust);
      }

      default:
        console.warn(`Unknown particle node type "${node.type}"`);
        return float(0);
    }
  }

  const systems = [];
  for (const sysNode of sysNodes) {
    const system = { ...nodeDefaults("system"), ...sysNode.props };
    const spriteTexture = system.texture
      ? await loadSpriteTexture(system.texture).catch((err) => {
          console.warn(`Particle sprite texture failed (${system.texture}): ${err.message ?? err}`);
          return null;
        })
      : null;
    const customGeometry = system.geometry
      ? await loadParticleGeometry(system.geometry).catch((err) => {
          console.warn(`Particle geometry failed (${system.geometry}): ${err.message ?? err}`);
          return null;
        })
      : null;

    const root = (key, fallback) => (ctx) => input(sysNode.id, key, ctx, fallback?.(ctx));
    const wired = (key) => !!inputEdge(sysNode.id, key);

    // System-node hot params, shared with the component's compute/render TSL.
    const su = (slot, calc) => regUniform(sysNode.id, slot, system, "float", calc);
    const u = {
      lifetime: su("lifetime", (p) => Math.max(0.05, p.lifetime ?? 2)),
      lifetimeJitter: su("lifetimeJitter", (p) => Math.min(1, Math.max(0, p.lifetimeJitter ?? 0))),
      sizeJitter: su("sizeJitter", (p) => p.sizeJitter ?? 0),
      floorY: su("floorY", (p) => p.floorY ?? 0),
      bounce: su("bounce", (p) => p.bounce ?? 0.4),
      bounceFactor: su("bounceFactor", (p) => 1 + (p.collisionBounce ?? 0.3)),
      frictionFactor: su("frictionFactor", (p) => 1 - (p.collisionFriction ?? 0.1)),
      collisionRadius: su("collisionRadius", (p) => Math.max(0.001, p.collisionRadius ?? 0.1)),
      collisionElasticity: su("collisionElasticity", (p) => p.collisionElasticity ?? 0.5),
      invCellSize: su("invCellSize", (p) => 1 / Math.max(1e-4, (p.collisionRadius ?? 0.1) * 2)),
    };

    systems.push({
      id: sysNode.id,
      system,
      u,
      spriteTexture,
      customGeometry,
      spawnPosition: root("position", () => vec3(0)),
      spawnVelocity: root("velocity", (ctx) => unitSphere(ctx.rand(1), ctx.rand(2)).mul(1.5)),
      force: wired("force") ? root("force") : null,
      size: root("size", () => float(0.1)),
      color: root("color", () => vec3(1, 0.8, 0.4)),
      opacity: wired("opacity") ? root("opacity") : null,
      // Soft-circle fade fallback is applied by the component when opacity is unwired.
    });
  }

  /**
   * Applies a value-only graph edit in place: refreshes every registered
   * param uniform plus each system's merged-props object (for values the
   * component reads CPU-side each tick). Only valid when the new graph has
   * the same structural signature as the compiled one.
   */
  const updateParams = (newGraph) => {
    for (const n of newGraph?.nodes ?? []) {
      const P = { ...nodeDefaults(n.type), ...n.props };
      const appliers = paramAppliers.get(n.id);
      if (appliers) for (const apply of appliers) apply(P);
      if (n.type === "system") {
        const sys = systems.find((s) => s.id === n.id);
        if (sys) Object.assign(sys.system, P);
      }
    }
  };

  return { systems, updateParams };
}

// Numeric params that still force a rebuild (buffer sizes, loop counts).
const STRUCTURAL_NUMERIC = { system: new Set(["capacity", "lightCount"]), fractal: new Set(["octaves"]) };
const HOT_PARAM_TYPES = new Set(["number", "vec3", "color"]);

/**
 * Structure-only fingerprint of a particle graph. Two graphs with equal
 * signatures compile to identical TSL/pipelines and differ only in uniform
 * values — so an edit that preserves the signature can be applied live via
 * `compiled.updateParams(graph)` instead of a full rebuild.
 */
export function particleGraphSignature(graph) {
  const nodes = (graph?.nodes ?? [])
    .map((n) => {
      const meta = P_NODE_TYPES[n.type];
      const P = { ...nodeDefaults(n.type), ...n.props };
      const structural = {};
      for (const p of meta?.params ?? []) {
        const hot = HOT_PARAM_TYPES.has(p.type) && !STRUCTURAL_NUMERIC[n.type]?.has(p.key);
        if (!hot) structural[p.key] = P[p.key];
      }
      return `${n.id}:${n.type}:${JSON.stringify(structural)}`;
    })
    .sort();
  const edges = (graph?.edges ?? [])
    .map((e) => `${e.source}.${e.sourceHandle ?? "out"}>${e.target}.${e.targetHandle}`)
    .sort();
  return JSON.stringify([nodes, edges]);
}

/** Approximates a legacy (pre-graph) particle component as a graph. */
export function legacyPropsToGraph(props) {
  const shape = props.shape === "sphere" ? "emitSphere" : props.shape === "box" ? "emitBox" : "emitPoint";
  const emitProps =
    shape === "emitSphere"
      ? { radius: props.emitterSize ?? 0.5 }
      : shape === "emitBox"
        ? { size: [props.emitterSize * 2 || 1, props.emitterSize * 2 || 1, props.emitterSize * 2 || 1] }
        : {};
  return {
    nodes: [
      { id: "emit", type: shape, props: emitProps, position: { x: 0, y: 0 } },
      { id: "speed", type: "float", props: { value: props.speed ?? 2 }, position: { x: 0, y: 160 } },
      { id: "vel", type: "multiply", props: {}, position: { x: 200, y: 90 } },
      { id: "grav", type: "gravity", props: { vector: [0, props.gravity ?? 0, 0] }, position: { x: 200, y: 240 } },
      { id: "ramp", type: "gradient", props: { from: props.startColor ?? "#ffcc66", to: props.endColor ?? "#ff3300" }, position: { x: 200, y: 380 } },
      { id: "size", type: "float", props: { value: props.size ?? 0.1 }, position: { x: 200, y: 520 } },
      { id: "sys", type: "system", props: {
        capacity: props.count ?? 500,
        lifetime: props.lifetime ?? 2,
        additive: props.additive ?? true,
      }, position: { x: 460, y: 120 } },
    ],
    edges: [
      { source: "emit", sourceHandle: "pos", target: "sys", targetHandle: "position" },
      { source: "emit", sourceHandle: "dir", target: "vel", targetHandle: "a" },
      { source: "speed", sourceHandle: "out", target: "vel", targetHandle: "b" },
      { source: "vel", sourceHandle: "out", target: "sys", targetHandle: "velocity" },
      { source: "grav", sourceHandle: "out", target: "sys", targetHandle: "force" },
      { source: "ramp", sourceHandle: "out", target: "sys", targetHandle: "color" },
      { source: "size", sourceHandle: "out", target: "sys", targetHandle: "size" },
    ],
  };
}

/** Starter graph for a fresh Particles component. */
export const DEFAULT_PARTICLE_GRAPH = {
  nodes: [
    { id: "emit", type: "emitSphere", props: { radius: 0.25 }, position: { x: -40, y: 40 } },
    { id: "speed", type: "float", props: { value: 2 }, position: { x: -40, y: 240 } },
    { id: "vel", type: "multiply", props: {}, position: { x: 200, y: 140 } },
    { id: "grav", type: "gravity", props: { vector: [0, -3, 0] }, position: { x: 200, y: 300 } },
    { id: "ramp", type: "gradient", props: { from: "#ffd27f", to: "#ff3300" }, position: { x: 200, y: 460 } },
    { id: "sys", type: "system", props: { capacity: 2000, lifetime: 2 }, position: { x: 500, y: 120 } },
  ],
  edges: [
    { source: "emit", sourceHandle: "pos", target: "sys", targetHandle: "position" },
    { source: "emit", sourceHandle: "dir", target: "vel", targetHandle: "a" },
    { source: "speed", sourceHandle: "out", target: "vel", targetHandle: "b" },
    { source: "vel", sourceHandle: "out", target: "sys", targetHandle: "velocity" },
    { source: "grav", sourceHandle: "out", target: "sys", targetHandle: "force" },
    { source: "ramp", sourceHandle: "out", target: "sys", targetHandle: "color" },
  ],
};
