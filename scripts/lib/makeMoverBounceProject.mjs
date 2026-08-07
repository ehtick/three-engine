// Frozen MOVER-BOUNCE rig for scripts/run-gi-mover-bounce.mjs.
//
// The claim under test (user, 2026-08-07): "indirect light from dynamic meshes
// still comes from voxels, resulting in bad indirect lighting."
//
// The suspected mechanism is narrower than that and has a yes/no answer: a mesh
// adopted into the exact-dynamic set LEAVES the voxel field entirely — its
// occupancy slot is parked and its atlas slot cleared (GISystem #tryAdoptDynamic)
// — while the cascade rays that now hit its exact triangles still resolve their
// radiance by sampling the VOXEL radiance buffer at the hit point
// (giField.js createSceneTrace → createTrilinearRadianceSampler). If that is
// what happens, an adopted mover contributes NO colour of its own; whatever the
// receiver picks up is the surrounding room bleeding through.
//
// This rig isolates exactly that. One white floor, one coloured box, one sun.
// The measurement is a COLOUR RATIO on the floor beside the box, never a
// brightness: the two representations shadow differently (exact triangles vs a
// conservative voxel shell) and AO/contact darkening differs with them, but
// white light attenuates r, g and b together, so hue is invariant to every one
// of those confounds. What hue is NOT invariant to is the box's own bounce,
// which is the only red source in the scene.
//
//   redExcess = 2r / (g + b)      1.0 = neutral, >1 = the box's colour arrived
//
// Paired arms: the SAME geometry is measured with a WHITE box and with a RED
// box under each representation. The white arm is the per-representation
// neutral reference, so `redExcess(red) / redExcess(white)` cancels any residual
// hue the rig itself carries (floor material, sun colour, tone curve) and leaves
// the mover's colour transfer alone.
//
// GI intensity is boosted well above 1 on purpose. Direct sunlight on a white
// floor is the dominant term and it is white; scaling only the INDIRECT
// contribution (which is what the component's `intensity` does) lifts the red
// bounce out of the 8-bit noise floor without touching the direct term or the
// transport being measured.
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
      // `strength`, NOT `emissionStrength` — the Emission node's float input
      // is named `strength` (tslGraph NODE_TYPES.emission); the wrong key
      // silently falls back to 1 and the EMISSIVE arm runs eight times dimmer
      // than the rig claims.
      { id: "em", type: "emission", props: { color, strength }, position: { x: 228, y: 176 } },
      { id: "output", type: "output", props: {}, position: { x: 560, y: 150 } },
    ],
    edges: [{ id: "e1", source: "em", sourceHandle: "out", target: "output", targetHandle: "surface" }],
  },
  pipeline: null,
});

let n = 0;
const id = () => `mover${(n++).toString().padStart(3, "0")}`;
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

export const MOVER_RIG = {
  // Box: 1m cube resting on the floor. Big enough to voxelize into several
  // 0.15m cells (so the voxel arm is not itself a resolution artifact) and
  // small enough that its bounce falls off inside the sampled span.
  boxSize: 1,
  boxY: 0.5,
  floorSize: 12,
  floorAlbedo: "#e8e8e8",
  // Sun from +x and above: the box's +x face is fully lit and its shadow falls
  // toward -x, so every sample on the +x side is directly lit AND sees the lit
  // face. Measuring on the lit side (rather than in the shadow) is deliberate —
  // in the shadow the only faces the receiver can see are the box's UNLIT ones,
  // which is a measurement of nothing.
  // TRAVEL direction of the sunlight, world space (from the sun toward the
  // scene). A directional light in this engine aims down its ENTITY'S -Z
  // forward — LightComponent parents a target at local (0,0,-1) — so position
  // does not aim it and the shadow-camera recentring overwrites that position
  // every frame anyway. The first version of this rig set a position and got a
  // scene lit edge-on along -Z: black floor, and a "measurement" of nothing.
  sunDir: [-5, -5, -3],
  sunIntensity: 3,
  // Floor sample distances from the box CENTRE along +x, z = 0. The box's +x
  // face is at x = 0.5, so 0.75 is one quarter-metre out. The last two are the
  // far-field reference: the bounce must be gone there in every arm, which is
  // what proves the metric reads zero when there is nothing to read.
  // Dense through the near field: a single hot sample is an artifact, a broad
  // peak is light. The first run could not tell those apart at 1.1m, which is
  // exactly where the box's screen silhouette ends.
  samples: [0.75, 0.9, 1.0, 1.1, 1.2, 1.35, 1.5, 1.65, 1.85, 2.0, 2.5, 3.2, 4.5],
};

/**
 * Euler XYZ (radians, three's default order) whose -Z forward is `dir`.
 *
 * three composes 'XYZ' as R = RX·RY·RZ, whose third column is
 * (sin y, -sin x·cos y, cos x·cos y), so forward = -Z is
 * (-sin y, sin x·cos y, -cos x·cos y). Roll (z) is free; 0.
 */
export function eulerForForward(dir) {
  const n = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  const [fx, fy, fz] = [dir[0] / n, dir[1] / n, dir[2] / n];
  const y = Math.asin(Math.max(-1, Math.min(1, -fx)));   // cos y ≥ 0 branch
  const cosY = Math.cos(y);
  // Degenerate only when the direction is exactly ±x, which no rig here uses.
  const x = Math.abs(cosY) < 1e-6 ? 0 : Math.atan2(fy / cosY, -fz / cosY);
  return [x, y, 0];
}

export async function makeMoverBounceProject(root, opts = {}) {
  const { gi = {}, redColor = "#e01010", emitStrength = 8 } = opts;
  await mkdir(path.join(root, "scenes"), { recursive: true });
  await mkdir(path.join(root, "materials"), { recursive: true });

  const mats = {
    Floor: bsdf(MOVER_RIG.floorAlbedo),
    // The two mover materials the arms swap between. Same roughness, same
    // metalness, same graph shape — only the albedo differs, so nothing but
    // colour changes between the paired arms.
    MoverRed: bsdf(redColor),
    MoverWhite: bsdf("#e8e8e8"),
    // EMISSIVE=1 arm: the same question asked of the emission path rather than
    // the albedo path. An adopted mover that has left the field cannot inject
    // emission either, and emission has no direct-light term to dilute it.
    EmitRed: emissive(redColor, emitStrength),
    EmitWhite: emissive("#ffffff", emitStrength),
  };
  for (const [name, data] of Object.entries(mats)) {
    await writeFile(path.join(root, "materials", `${name}.mat`), JSON.stringify(data, null, 2));
  }
  const M = (name) => `${root.replaceAll("\\", "/")}/materials/${name}.mat`;
  const { boxSize, boxY, floorSize } = MOVER_RIG;

  const rig = [
    mesh("Floor", "box", M("Floor"), [0, -0.05, 0], [floorSize, 0.1, floorSize]),
    // The mover starts on the STATIC path ("auto" would also adopt it the
    // moment anything nudged it, and the arms must control that themselves).
    mesh("Mover", "box", M("MoverRed"), [0, boxY, 0], [boxSize, boxSize, boxSize], {
      giMobility: "static", giTrace: "auto", giDynamic: "auto",
    }),
  ];

  const scene = {
    version: 1,
    name: "Main",
    settings: {
      background: "#000000",
      ambientColor: "#ffffff",
      // The sun and the box are the ONLY light sources. Ambient would add a
      // white term to every sample and flatten the ratio being measured.
      ambientIntensity: 0,
      environment: { cubemap: "", background: false, lighting: false, intensity: 0, rotation: 0, blur: 0 },
      fog: { type: "none", color: "#f2f2f2", near: 10, far: 40, density: 0.02 },
      toneMapping: "agx",
      exposure: 1,
      shadows: true,
      renderer: { antialias: true, samples: 4, transparent: false },
      shadow: { type: "PCFSoftShadowMap", autoUpdate: true, needsUpdate: false },
      performance: {
        maxDevicePixelRatio: 2, renderScale: 1, dynamicResolution: false,
        targetFps: 120, volumeStepScale: 1, autoBatching: true, occlusionCulling: false,
      },
    },
    entities: [
      {
        id: "moverRoot", name: "MoverBounce",
        position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
        viewOnly: false, enabledInEditor: true, enabledInGame: true,
        components: [{
          type: "global-illumination",
          props: {
            enabled: true, autoFit: true, quality: "high",
            sizeX: 16, sizeY: 8, sizeZ: 16,
            voxelSize: 0.15, probeSpacing: 0.35, cascadeCount: 5, c0DirRes: 4,
            // See the header: this scales the INDIRECT term only.
            intensity: 4, skyColor: "#ffffff", skyIntensity: 0,
            bounce: 1, temporalBlend: 1, probeSmoothing: 0.35,
            reflections: false, exactReflections: false,
            backend: "occupancy", sparseField: false,
            emissiveShadows: false,
            // AO darkens the contact region, which is where the bounce is
            // strongest. Hue-neutral, but it costs signal for nothing.
            ao: false, aoStrength: 0.6, aoRadius: 0.6,
            resolveScale: 1, autoRebake: true, debugProbes: "off", hitLighting: false,
            ...gi,
          },
        }],
        children: rig,
      },
      {
        id: "moverSun", name: "Sun",
        // Position is cosmetic (see MOVER_RIG.sunDir); rotation is the aim.
        position: [6, 5, 3.6], rotation: eulerForForward(MOVER_RIG.sunDir), scale: [1, 1, 1],
        viewOnly: false, enabledInEditor: true, enabledInGame: true,
        components: [{
          type: "light",
          props: {
            enabled: true, kind: "directional", color: "#ffffff",
            intensity: MOVER_RIG.sunIntensity,
            // Shadow MAPS, not GI-traced shadows: the user's 2026-08-07 pivot
            // put directional lights on the map path, and a GI-traced sun
            // would put the representation swap on BOTH sides of the
            // measurement (shadow shape and bounce) instead of one.
            castShadow: true, shadowMode: "map", sourceAngle: 0.53,
            shadowMapType: "PCFSoftShadowMap", shadowMapWidth: 2048, shadowMapHeight: 2048,
            shadowBias: -0.0005, shadowNormalBias: 0.02, shadowRadius: 1,
            shadowCamNear: 0.1, shadowCamFar: 100, shadowCamSize: 12, shadowCamFov: 90,
            csm: false, csmCascades: 4, csmMaxFar: 1000, csmMode: "practical",
            csmSplitLambda: 0.9, csmLightMargin: 200, csmFade: true,
          },
        }],
        children: [],
      },
      {
        id: "moverCam", name: "Camera",
        position: [4.5, 3.6, 4.5], rotation: [0, 0, 0], scale: [1, 1, 1],
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
    name: "GI-MoverBounce", version: 1,
    lastScene: "scenes/Main.scene", mainScene: "scenes/Main.scene",
    modules: ["gi"],
    settings: {
      editor: {
        // Autosave rewrites component props mid-measurement (session 20).
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
