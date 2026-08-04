// Frozen emissive-Cornell repro project for scripts/run-gi-emissive.mjs.
//
// WHY a generated project instead of the user's own: their scenes/Main.scene
// IS this Cornell box, but they are actively tuning it (autosave every 10s
// rewrote backend/ao/quality/probeSpacing THREE times mid-measurement) — a
// harness that reads it measures a different scene every run. This one is
// deterministic, has NO directional light and ambient 0, so the emissive cube
// is the ONLY light and any pixel that is lit was lit by the GI emitter path.
//
// Faithful to their geometry: 5m room, 0.1m-thick box walls (NOT planes — that
// thinness is part of the scene under test), a rotated tall block, and an
// emissive CUBE (their "Light" is a uniform-scaled box, not a flat panel).
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

const emissive = (strength) => ({
  color: "#ffffff", roughness: 0.7, metalness: 0, map: "",
  shaderGraph: {
    nodes: [
      { id: "em", type: "emission", props: { color: "#ffffff", emissionStrength: strength }, position: { x: 228, y: 176 } },
      { id: "output", type: "output", props: {}, position: { x: 560, y: 150 } },
    ],
    edges: [{ id: "e1", source: "em", sourceHandle: "out", target: "output", targetHandle: "surface" }],
  },
  pipeline: null,
});

let n = 0;
const id = () => `cor${(n++).toString().padStart(3, "0")}`;
const mesh = (name, geometry, material, position, rotation, scale) => ({
  id: id(), name, position, rotation, scale,
  viewOnly: false, enabledInEditor: true, enabledInGame: true,
  components: [{
    type: "mesh",
    props: {
      enabled: true, geometry, geometryAsset: "", material,
      material2: "", material3: "", material4: "", material5: "", material6: "", material7: "", material8: "",
      castShadow: true, receiveShadow: true,
    },
  }],
  children: [],
});

export async function makeCornellProject(root, opts = {}) {
  const {
    wallThickness = 0.1,
    emitStrength = 1,
    gi = {},
  } = opts;
  await mkdir(path.join(root, "scenes"), { recursive: true });
  await mkdir(path.join(root, "materials"), { recursive: true });

  const mats = {
    Red: bsdf("#ff0000"), Green: bsdf("#00ff00"), White: bsdf("#e6e6e6"),
    Emit: emissive(emitStrength),
  };
  for (const [name, data] of Object.entries(mats)) {
    await writeFile(path.join(root, "materials", `${name}.mat`), JSON.stringify(data, null, 2));
  }
  const M = (name) => `${root.replaceAll("\\", "/")}/materials/${name}.mat`;
  const t = wallThickness;
  const HALF = Math.PI / 2;

  const room = [
    // 5x5 room, floor at y=0, open toward +z. Walls are BOXES (their scene's
    // are too) so the field has two faces to keep apart.
    mesh("Floor", "box", M("White"), [0, -t / 2, 0], [0, 0, 0], [5, t, 5]),
    mesh("Ceiling", "box", M("White"), [0, 5 + t / 2, 0], [0, 0, 0], [5, t, 5]),
    mesh("Back", "box", M("White"), [0, 2.5, -2.5 - t / 2], [0, 0, 0], [5, 5, t]),
    mesh("Red", "box", M("Red"), [-2.5 - t / 2, 2.5, 0], [0, 0, 0], [t, 5, 5]),
    mesh("Green", "box", M("Green"), [2.5 + t / 2, 2.5, 0], [0, 0, 0], [t, 5, 5]),
    // The occluder the emitter must cast a shadow from.
    mesh("Block", "box", M("White"), [0.95, 1.5, -0.8], [0, 0.6, 0], [1.2, 3, 1.2]),
    // The emitter: a CUBE, like their "Light" (uniform scale 1.225).
    mesh("Emitter", "box", M("Emit"), [-0.75, 2.6, 0.7], [0, 0, 0], [1.2, 1.2, 1.2]),
  ];

  const scene = {
    version: 1,
    name: "Main",
    settings: {
      background: "#000000",
      ambientColor: "#ffffff",
      // ZERO ambient and NO environment lighting: the emissive cube must be the
      // only light in the room, or the arms measure ambient instead of GI.
      ambientIntensity: 0,
      environment: { cubemap: "", background: false, lighting: false, intensity: 0, rotation: 0, blur: 0 },
      fog: { type: "none", color: "#f2f2f2", near: 10, far: 40, density: 0.02 },
      toneMapping: "aces",
      exposure: 1,
      shadows: true,
      renderer: { antialias: true, samples: 4, transparent: false },
      shadow: { type: "PCFSoftShadowMap", autoUpdate: true, needsUpdate: false },
      performance: {
        maxDevicePixelRatio: 2, renderScale: 1, dynamicResolution: false,
        targetFps: 120, volumeStepScale: 1, autoBatching: true, occlusionCulling: true,
      },
    },
    entities: [
      {
        id: "cornellRoot", name: "Cornell",
        position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
        viewOnly: false, enabledInEditor: true, enabledInGame: true,
        components: [{
          type: "global-illumination",
          props: {
            enabled: true, autoFit: true, quality: "high",
            sizeX: 10, sizeY: 10, sizeZ: 10,
            voxelSize: 0.15, probeSpacing: 0.35, cascadeCount: 5, c0DirRes: 4,
            intensity: 1, skyColor: "#ffffff", skyIntensity: 0,
            bounce: 1, temporalBlend: 0.25, probeSmoothing: 0.35,
            reflections: true, exactReflections: false,
            backend: "occupancy", sparseField: false,
            emissiveShadows: true,
            ao: true, aoStrength: 0.6, aoRadius: 0.6,
            resolveScale: 1, autoRebake: true, debugProbes: "off", hitLighting: false,
            ...gi,
          },
        }],
        children: room,
      },
      {
        id: "cornellCam", name: "Camera",
        // Their own saved camera pose — straight down -z through the opening.
        position: [0.3, 2.9, 7.3], rotation: [0, 0, 0], scale: [1, 1, 1],
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
    name: "GI-Cornell", version: 1,
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
      rendering: { pixelRatioCap: 2 },
      build: { startScene: "", scenes: ["scenes/Main.scene"], target: "web", quality: "high" },
    },
  }, null, 2));
  return root;
}
