// Frozen COLOUR-BLEED FALLOFF rig for scripts/run-gi-bleed.mjs.
//
// The user's report is about Sponza: "our colour bleed is too strong and
// reaches too far; in Blender it fades out quickly, and the overall white
// indirect is stronger". Sponza cannot answer that — it is an enclosure with
// hundreds of surfaces, so there is no ground truth to compare a measurement
// against, only another renderer's screenshot.
//
// This rig has a CLOSED-FORM answer. One Lambertian emitting rectangle facing
// down an otherwise empty floor:
//
//     E(d) = L · ∫∫ (d·y) / (d² + y² + z²)²  dz dy      (panel at x=0,
//            y ∈ [0, PANEL_H], z ∈ [-PANEL_W/2, PANEL_W/2], receiver at
//            (d, 0, 0) with normal +y)
//
// so the irradiance profile along the floor is exactly integrable and the only
// question is whether ours has the same SHAPE. An open rig (no ceiling, no side
// walls) is deliberate: a flat floor cannot see itself, so multi-bounce is
// negligible and the measured profile is the single-bounce transport alone.
//
// The panel is EMISSIVE rather than a sunlit diffuse surface because that
// removes the sun, its shadows and its own falloff from the measurement while
// exercising the SAME transport: with `emissiveShadows` off an emissive mesh
// stays a field emissive source (cell radiance → cascade traces → probes →
// resolve), which is the identical path a sunlit curtain's bounce takes.
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
      { id: "em", type: "emission", props: { color, emissionStrength: strength }, position: { x: 228, y: 176 } },
      { id: "output", type: "output", props: {}, position: { x: 560, y: 150 } },
    ],
    edges: [{ id: "e1", source: "em", sourceHandle: "out", target: "output", targetHandle: "surface" }],
  },
  pipeline: null,
});

let n = 0;
const id = () => `bleed${(n++).toString().padStart(3, "0")}`;
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

export const BLEED_RIG = {
  // Panel: a PLANE (not a box) so the analytic model has exactly one emitting
  // face and no top/side faces leaking extra energy into the integral.
  panelW: 2,
  panelH: 2,
  panelT: 0.2,
  floorLength: 16,
  floorWidth: 6,
  floorAlbedo: "#cccccc",
};

export async function makeBleedProject(root, opts = {}) {
  const { emitStrength = 5, gi = {}, panelColor = "#ff0000" } = opts;
  await mkdir(path.join(root, "scenes"), { recursive: true });
  await mkdir(path.join(root, "materials"), { recursive: true });

  const mats = {
    Floor: bsdf(BLEED_RIG.floorAlbedo),
    EmitRed: emissive(panelColor, emitStrength),
    EmitWhite: emissive("#ffffff", emitStrength),
  };
  for (const [name, data] of Object.entries(mats)) {
    await writeFile(path.join(root, "materials", `${name}.mat`), JSON.stringify(data, null, 2));
  }
  const M = (name) => `${root.replaceAll("\\", "/")}/materials/${name}.mat`;
  const { panelW, panelH, panelT, floorLength, floorWidth } = BLEED_RIG;

  const rig = [
    // Floor: x ∈ [-1, floorLength-1], centred on z = 0, top face at y = 0.
    mesh("Floor", "box", M("Floor"), [floorLength / 2 - 1, -0.05, 0], [0, 0, 0], [floorLength, 0.1, floorWidth]),
    // Panel: a BOX 0.2m thick whose +x face sits exactly at x = 0, not a
    // zero-thickness plane. The plane version produced a floor that was BLACK
    // for the first 0.8m and then spiked 10x at 2m — a thin single-layer
    // emitter voxelizes to one cell whose shell lands on one side only, so the
    // near floor saw an unlit occluder instead of a source. That is a real
    // engine behaviour worth its own investigation, but here it is a confound:
    // this rig exists to measure FALLOFF, so the source must be unambiguous.
    // Only the +x face matters to the samples — the top faces +y (no
    // contribution to a floor below it), the sides face ±z (cosθ ≈ 0 on the
    // z = 0 sample line), and -x faces away — so the analytic model still holds.
    mesh("Panel", "box", M("EmitRed"), [-panelT / 2, panelH / 2, 0], [0, 0, 0], [panelT, panelH, panelW]),
  ];

  const scene = {
    version: 1,
    name: "Main",
    settings: {
      background: "#000000",
      ambientColor: "#ffffff",
      // NOTHING but the panel may light this scene, or the falloff being
      // measured is ambient's (which is flat) rather than the transport's.
      ambientIntensity: 0,
      environment: { cubemap: "", background: false, lighting: false, intensity: 0, rotation: 0, blur: 0 },
      fog: { type: "none", color: "#f2f2f2", near: 10, far: 40, density: 0.02 },
      // Screenshots bypass tone mapping anyway (the op renders to a target, and
      // three only applies the output transform on the final pass), so this is
      // recorded for the viewport's benefit only — every number this rig
      // produces is raw radiance, which is what a transport test wants.
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
        id: "bleedRoot", name: "Bleed",
        position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
        viewOnly: false, enabledInEditor: true, enabledInGame: true,
        components: [{
          type: "global-illumination",
          props: {
            enabled: true, autoFit: true, quality: "high",
            sizeX: 20, sizeY: 8, sizeZ: 10,
            voxelSize: 0.15, probeSpacing: 0.35, cascadeCount: 5, c0DirRes: 4,
            intensity: 1, skyColor: "#ffffff", skyIntensity: 0,
            bounce: 1, temporalBlend: 1, probeSmoothing: 0.35,
            reflections: true, exactReflections: false,
            backend: "occupancy", sparseField: false,
            // FIELD emissive path, not the analytic area-light path — see the
            // header. Flipping this on would measure a different mechanism.
            emissiveShadows: false,
            // AO darkens the floor near the panel's base, which is exactly
            // where the profile is steepest — it would read as a falloff.
            ao: false, aoStrength: 0.6, aoRadius: 0.6,
            // Full-resolution resolve: the half-res path fringes at silhouettes
            // and this measurement samples a strip a few pixels wide.
            resolveScale: 1, autoRebake: true, debugProbes: "off", hitLighting: false,
            ...gi,
          },
        }],
        children: rig,
      },
      {
        id: "bleedCam", name: "Camera",
        position: [7, 13, 0.5], rotation: [0, 0, 0], scale: [1, 1, 1],
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
    name: "GI-Bleed", version: 1,
    lastScene: "scenes/Main.scene", mainScene: "scenes/Main.scene",
    modules: ["gi"],
    settings: {
      editor: {
        // Autosave OFF: session 20 lost two runs to autosave rewriting the GI
        // props mid-measurement.
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

/**
 * Exact irradiance at floor point (d, 0, 0) from the emitting rectangle, up to
 * the constant radiance L. Double Gauss-free midpoint quadrature — the
 * integrand is smooth and bounded for d > 0, and 400x400 samples converge to
 * more digits than the measurement can resolve.
 */
export function analyticIrradiance(d, { panelW = BLEED_RIG.panelW, panelH = BLEED_RIG.panelH, steps = 400 } = {}) {
  const dy = panelH / steps;
  const dz = panelW / steps;
  let sum = 0;
  for (let i = 0; i < steps; i++) {
    const y = (i + 0.5) * dy;
    for (let j = 0; j < steps; j++) {
      const z = -panelW / 2 + (j + 0.5) * dz;
      const r2 = d * d + y * y + z * z;
      // cosθ_source = d/√r2 (panel normal +x), cosθ_receiver = y/√r2 (floor
      // normal +y); the two cosines over r² give (d·y)/r⁴.
      sum += (d * y) / (r2 * r2);
    }
  }
  return (sum * dy * dz) / Math.PI;
}
