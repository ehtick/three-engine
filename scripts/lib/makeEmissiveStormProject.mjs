// Frozen EMISSIVE-STORM rig for scripts/run-gi-emissive-cost.mjs.
//
// The claim under test (user, 2026-08-07): "each emissive object is still
// -15-20 fps, which is horrible" and "try to spawn 4 emissive objects in a
// scene and move them, you will see heavy performance drop".
//
// MAX_EMITTERS is 4, so four emissive meshes is the FULL analytic budget —
// exactly the configuration the user names, and the worst case the current
// design can be asked for. The rig is built so the per-emitter marginal cost
// can be isolated without ever rebuilding a shader:
//
//   · All four emissive spheres exist from the first bake, so the resolve and
//     the emitter shadow pass compile their four unrolled slots ONCE.
//   · An emitter is made live or dark by toggling `mesh.visible`, which
//     `#refreshEmitterSlots` turns into `slot.radius = 0` — the same per-slot
//     runtime gate a real scene hits. Zero recompiles between arms, so an
//     0-live vs 4-live delta is pure shader cost, not pipeline churn.
//
// OCCLUDERS ARE THE POINT. A shadow trace only costs what it marches, and a
// scene with nothing to hit measures the early-out, not the shadow. Eight
// crates sit between the lamps and the floor so every emitter shadow ray has
// real work, and so "dynamic objects cast no emissive shadow" is VISIBLE here
// rather than only assertable.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const bsdf = (color, roughness = 1) => ({
  color: "#ffffff", roughness, metalness: 0, map: "",
  shaderGraph: {
    nodes: [
      { id: "bsdf", type: "principledBsdf", props: { color, metalness: 0, roughness, ior: 1 }, position: { x: 200, y: 120 } },
      { id: "output", type: "output", props: {}, position: { x: 560, y: 150 } },
    ],
    edges: [{ id: "e1", source: "bsdf", sourceHandle: "out", target: "output", targetHandle: "surface" }],
  },
  pipeline: null,
});

const emissive = (color, strength) => ({
  color: "#ffffff", roughness: 0.7, metalness: 0, map: "",
  shaderGraph: {
    nodes: [
      // `strength`, NOT `emissionStrength`: the Emission node's float input is
      // named `strength` (tslGraph NODE_TYPES.emission). The wrong key is not
      // an error — it falls back to the default 1, and the rig then measures
      // lamps eight times dimmer than it claims, two of which never clear the
      // promotion gate. Cost the first run of this harness exactly that.
      { id: "em", type: "emission", props: { color, strength }, position: { x: 228, y: 176 } },
      { id: "output", type: "output", props: {}, position: { x: 560, y: 150 } },
    ],
    edges: [{ id: "e1", source: "em", sourceHandle: "out", target: "output", targetHandle: "surface" }],
  },
  pipeline: null,
});

let n = 0;
const id = () => `storm${(n++).toString().padStart(3, "0")}`;
const mesh = (name, geometry, material, position, scale, extra = {}) => ({
  id: id(), name, position, rotation: [0, 0, 0], scale,
  viewOnly: false, enabledInEditor: true, enabledInGame: true,
  components: [{
    type: "mesh",
    props: {
      enabled: true, geometry, geometryAsset: "", material,
      material2: "", material3: "", material4: "", material5: "", material6: "", material7: "", material8: "",
      castShadow: true, receiveShadow: true,
      ...extra,
    },
  }],
  children: [],
});

/** Lamp home positions (the harness orbits them around these). */
export const LAMP_HOMES = [
  [-3.2, 1.6, -3.2],
  [3.2, 1.6, -3.2],
  [3.2, 1.6, 3.2],
  [-3.2, 1.6, 3.2],
];
export const LAMP_COLORS = ["#ff3010", "#20ff40", "#3050ff", "#ffd020"];

/**
 * N lamps on a ring, well separated, each with its own patch of floor.
 *
 * MAX_EMITTERS is 4, so asking for more than four is the only way to see what
 * a scene with "A LOT of" emissive objects actually gets: the brightest four
 * take the analytic slots, and the question this arrangement exists to answer
 * is whether lamps five and up still light anything at all. Separation is the
 * whole point — overlapping pools cannot be attributed to a lamp.
 */
export function lampRing(count, radius = 4.4, y = 1.4) {
  return Array.from({ length: count }, (_, i) => {
    const a = (i / count) * Math.PI * 2 + Math.PI / count;
    return [Math.cos(a) * radius, y, Math.sin(a) * radius];
  });
}

/** Crate positions — occluders BETWEEN every lamp and the floor centre. */
const CRATES = [
  [-1.6, 0.5, -1.6], [1.6, 0.5, -1.6], [1.6, 0.5, 1.6], [-1.6, 0.5, 1.6],
  [0, 0.5, -3.0], [0, 0.5, 3.0], [-3.0, 0.5, 0], [3.0, 0.5, 0],
];

export const STORM_RIG = { floorSize: 14, lampRadius: 0.4, crateSize: 1 };

/**
 * Extra STATIC clutter on a ring, and extra DYNAMIC movers.
 *
 * The user's real editor measured `emitterShadowPass` at 10.53ms for 3
 * emitters over 158k shadow pixels; this rig measured 0.23ms for 4 emitters
 * over 158k pixels. Same pass, same pixel budget, 60x apart — so the cost is
 * not per-pixel, it is per-RAY-TRAVERSAL, and the two things their scene has
 * that this one did not are a deep static BVH8 and a full set of 16 adopted
 * movers (every emitter shadow ray tests the static BVH *and* every mover).
 * These knobs let the rig grow both until it reproduces, which is the only
 * way to A/B which traversal owns the time.
 */
const ring = (count, radius, y, jitter) =>
  Array.from({ length: count }, (_, i) => {
    const a = (i / count) * Math.PI * 2;
    const r = radius + ((i * 37) % 11) * jitter;
    return [Math.cos(a) * r, y, Math.sin(a) * r];
  });

export async function makeEmissiveStormProject(root, opts = {}) {
  const {
    gi = {},
    emitStrength = 12,
    // Movers default to the EXACT path — the whole point of the exercise is
    // that dynamic lighting is supposed to be exact-silhouette, so the rig
    // must not quietly measure the voxel fallback instead.
    lampMobility = "dynamic",
    crateMobility = "static",
    lampGeometry = "sphere",
    // Scene weight — see the `ring` note above.
    clutterCount = 0,
    clutterSegments = 24,
    moverCount = 0,
    // > 4 puts lamps past MAX_EMITTERS on purpose — see lampRing.
    lampCount = 4,
    // Per-index strength ramp. Promotion RANKS by emitted power, so a ramp
    // decides WHICH lamps win slots without moving any of them — the control
    // that separates "promotion changed the light" from "position did".
    // > 0 favours high indices, < 0 favours low ones.
    strengthRamp = 0,
    // Lamp size. The transport path samples an emitter with the cascade's
    // finite angular resolution, so a SMALL emitter can be under-sampled in a
    // way a large one is not — the difference between "apply a calibration
    // factor" and "the cheap path cannot represent small emitters at all".
    lampRadius = STORM_RIG.lampRadius,
    // Mirror floor (2026-08-13): roughness 0.3 puts the floor in bucket 0
    // (GI_MIRROR_ROUGHNESS_MAX 0.45) — the scene gains a reflection CONSUMER,
    // which at ultra turns on the exact-reflection prepass + the resolve's
    // hit-shading. That is the arm that prices the emitters × reflections
    // interaction (each hit pixel runs emitterSlotShadow inline per slot);
    // without it the resolve never compiles the bvhShade branch and the
    // emitter sweep measures only the dedicated shadow pass.
    mirrorFloor = false,
    // Walls + ceiling. An OPEN rig cannot price hit shading at all: the
    // mirror floor reflects the sky, every reflection ray MISSES (t = -1),
    // and the resolve's bvhShade branch — the thing the mirror arm exists to
    // measure — is skipped on ~every pixel. Enclosed, a floor pixel's
    // reflected ray hits the ceiling and pays the full hit-shade (gather +
    // per-slot emitter march), which is the Sponza shape.
    enclosed = false,
  } = opts;
  await mkdir(path.join(root, "scenes"), { recursive: true });
  await mkdir(path.join(root, "materials"), { recursive: true });

  const mats = { Floor: bsdf("#d8d8d8", mirrorFloor ? 0.3 : 1), Crate: bsdf("#b0b4bc") };
  // All lamps share ONE colour when there are more than four: the measurement
  // compares lamp-to-lamp delivery, and per-lamp hue would confound it with
  // the promotion gate's own colour sensitivity.
  const homes = lampCount === 4 ? LAMP_HOMES : lampRing(lampCount);
  const colorOf = (i) => (lampCount === 4 ? LAMP_COLORS[i] : "#ffffff");
  const strengthOf = (i) => emitStrength * (1 + strengthRamp * (strengthRamp > 0 ? i : homes.length - 1 - i));
  homes.forEach((_, i) => { mats[`Lamp${i}`] = emissive(colorOf(i), strengthOf(i)); });
  for (const [name, data] of Object.entries(mats)) {
    await writeFile(path.join(root, "materials", `${name}.mat`), JSON.stringify(data, null, 2));
  }
  const M = (name) => `${root.replaceAll("\\", "/")}/materials/${name}.mat`;
  const { floorSize, crateSize } = STORM_RIG;

  // Enclosure walls sit just inside the GI volume (sizeX/Z 16 spans ±8, the
  // 14m floor leaves a margin); height 3.6 keeps the ceiling inside sizeY 8's
  // upper half. Crate material — diffuse, so the enclosure adds hit targets
  // without adding more reflection consumers.
  const wallH = 3.6;
  const half = floorSize / 2;
  const enclosure = enclosed
    ? [
        mesh("Ceiling", "box", M("Crate"), [0, wallH, 0], [floorSize, 0.1, floorSize]),
        mesh("WallN", "box", M("Crate"), [0, wallH / 2, -half], [floorSize, wallH, 0.1]),
        mesh("WallS", "box", M("Crate"), [0, wallH / 2, half], [floorSize, wallH, 0.1]),
        mesh("WallW", "box", M("Crate"), [-half, wallH / 2, 0], [0.1, wallH, floorSize]),
        mesh("WallE", "box", M("Crate"), [half, wallH / 2, 0], [0.1, wallH, floorSize]),
      ]
    : [];
  const rig = [
    ...enclosure,
    mesh("Floor", "box", M("Floor"), [0, -0.05, 0], [floorSize, 0.1, floorSize]),
    ...CRATES.map((p, i) =>
      mesh(`Crate${i}`, "box", M("Crate"), p, [crateSize, crateSize, crateSize], {
        giMobility: crateMobility, giTrace: "auto", giDynamic: "auto",
      }),
    ),
    // STATIC clutter: spheres, because segment count is a direct triangle dial
    // and triangle count is what makes a static BVH8 traversal expensive.
    ...ring(clutterCount, 5.6, 0.6, 0.12).map((p, i) =>
      mesh(`Clutter${i}`, "sphere", M("Crate"), p, [0.7, 0.7, 0.7], {
        giMobility: "static", giTrace: "auto", giDynamic: "auto",
        segments: clutterSegments,
      }),
    ),
    // EXTRA MOVERS: pinned dynamic so they are adopted into the exact set and
    // therefore tested by every shadow ray, exactly like the user's crates.
    ...ring(moverCount, 2.6, 1.1, 0.08).map((p, i) =>
      mesh(`Mover${i}`, "box", M("Crate"), p, [0.5, 0.5, 0.5], {
        giMobility: "dynamic", giTrace: "auto", giDynamic: "auto",
      }),
    ),
    ...homes.map((p, i) =>
      mesh(`Lamp${i}`, lampGeometry, M(`Lamp${i}`), p, [lampRadius * 2, lampRadius * 2, lampRadius * 2], {
        giMobility: lampMobility, giTrace: "auto", giDynamic: "auto",
        // A lamp casting a shadow-MAP shadow of itself over its own pool is
        // noise in a measurement about GI emitter shadows.
        castShadow: false,
      }),
    ),
  ];

  const scene = {
    version: 1,
    name: "Main",
    settings: {
      background: "#05070a",
      ambientColor: "#ffffff",
      ambientIntensity: 0,
      environment: { cubemap: "", background: false, lighting: false, intensity: 0, rotation: 0, blur: 0 },
      fog: { type: "none", color: "#f2f2f2", near: 10, far: 40, density: 0.02 },
      toneMapping: "agx",
      exposure: 1,
      shadows: true,
      renderer: { antialias: true, samples: 4, transparent: false },
      shadow: { type: "PCFSoftShadowMap", autoUpdate: true, needsUpdate: false },
      performance: {
        maxDevicePixelRatio: 1, renderScale: 1, dynamicResolution: false,
        targetFps: 120, volumeStepScale: 1, autoBatching: true, occlusionCulling: false,
      },
    },
    entities: [
      {
        id: "stormRoot", name: "EmissiveStorm",
        position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
        viewOnly: false, enabledInEditor: true, enabledInGame: true,
        components: [{
          type: "global-illumination",
          props: {
            // autoFit OFF and the volume PINNED. With auto-fit on, orbiting
            // lamps stretch the volume ("auto-fit: refit in place — 17.1x5.4
            // x16.2m" mid-arm) and the cell count changes underneath the
            // measurement, so a per-emitter delta picks up a per-cell delta
            // too. The box below contains the floor, the crates and every
            // point on every lamp's orbit.
            // (The volume centres on the GI entity at the origin, so sizeY 8
            // spans -4..4 — the lower half is empty and constant, which is
            // all a per-emitter delta needs.)
            enabled: true, autoFit: false, quality: "high",
            sizeX: 16, sizeY: 8, sizeZ: 16,
            voxelSize: 0.15, probeSpacing: 0.35, cascadeCount: 5, c0DirRes: 4,
            intensity: 1.5, skyColor: "#ffffff", skyIntensity: 0,
            bounce: 1, temporalBlend: 1, probeSmoothing: 0.35,
            reflections: false, exactReflections: false,
            backend: "occupancy", sparseField: false,
            // THE SUBJECT. Emitter promotion is gated on this.
            emissiveShadows: true,
            ao: false, aoStrength: 0.6, aoRadius: 0.6,
            resolveScale: 1, autoRebake: true, debugProbes: "off", hitLighting: false,
            ...gi,
          },
        }],
        children: rig,
      },
      {
        id: "stormSun", name: "Sun",
        position: [6, 8, 6], rotation: [-0.9, 0.6, 0], scale: [1, 1, 1],
        viewOnly: false, enabledInEditor: true, enabledInGame: true,
        components: [{
          type: "light",
          props: {
            enabled: true, kind: "directional", color: "#ffffff",
            // Dim on purpose: the lamps must be the dominant light or the
            // measurement is about the sun.
            intensity: 0.35,
            castShadow: true, shadowMode: "map", sourceAngle: 0.53,
            shadowMapType: "PCFSoftShadowMap", shadowMapWidth: 2048, shadowMapHeight: 2048,
            shadowBias: -0.0005, shadowNormalBias: 0.02, shadowRadius: 1,
            shadowCamNear: 0.1, shadowCamFar: 100, shadowCamSize: 14, shadowCamFov: 90,
            csm: false, csmCascades: 4, csmMaxFar: 1000, csmMode: "practical",
            csmSplitLambda: 0.9, csmLightMargin: 200, csmFade: true,
          },
        }],
        children: [],
      },
      {
        id: "stormCam", name: "Camera",
        position: [0, 7, 9], rotation: [0, 0, 0], scale: [1, 1, 1],
        viewOnly: false, enabledInEditor: true, enabledInGame: true,
        components: [{
          type: "camera",
          props: {
            enabled: true, fov: 60, near: 0.1, far: 1000, blendTime: 0.6,
            blendStyle: "easeInOut", shake: 1, previewRigInEditor: false,
            showPreview: true, followTarget: null, followInViewport: false, followInGame: false,
          },
        }],
        children: [],
      },
    ],
  };

  await writeFile(path.join(root, "scenes", "Main.scene"), JSON.stringify(scene, null, 1));
  await writeFile(path.join(root, "project.json"), JSON.stringify({
    name: "GI-EmissiveStorm", version: 1,
    lastScene: "scenes/Main.scene", mainScene: "scenes/Main.scene",
    modules: ["gi"],
    settings: {
      editor: {
        autosaveSeconds: 0,
        snapTranslate: 0.5, snapRotateDeg: 15, snapScale: 0.1,
        gridSize: 40, gridDivisions: 40, showGrid: false,
        layers: { gizmos: false, cursor3D: false, colliders: false, grid: false, stats: false, debugDraw: false, uiOverlay: false, virtualGeometry: false },
        keybindings: {},
      },
      scripts: { hotReload: false, reloadIntervalMs: 750 },
      rendering: { pixelRatioCap: 1 },
      build: { startScene: "", scenes: ["scenes/Main.scene"], target: "web", quality: "high" },
    },
  }, null, 2));
  return root;
}
