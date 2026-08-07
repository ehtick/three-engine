// Frozen BLOCK-SIZE rig for scripts/run-gi-block-size.mjs.
//
// THE QUESTION: the user's indirect light is "blocky and flickery" — coloured
// bleed from a box and light from emissive meshes, both in the same way. Two
// lattices could be imprinting themselves on it: the VOXEL/field cell and the
// PROBE grid. Which one is it? The answer is a LENGTH, so the rig has to make
// both lengths independently settable and the length itself measurable.
//
// WHY THIS IS NOT `makeBleedProject` WITH A DIFFERENT CAMERA — the trap this
// rig exists to avoid:
//
//   **`autoFit: true` MAKES `voxelSize` AND `probeSpacing` INERT.** GISystem
//   #rebuild, autoFit branch: "voxel/probe density is fully derived from the
//   fitted volume (the manual size/voxel/probe fields are ignored)". The props
//   are overwritten from QUALITY_BUDGETS before anything reads them. Every
//   other GI rig in scripts/lib ships autoFit ON, so a sweep of either prop on
//   any of them measures four identical builds.
//
//   Worse, the Inspector marks both props `flipsToCustom: "quality"`, and
//   qualityTierOf maps "custom" → "high". So editing voxelSize in a scene
//   saved at "ultra" does change the picture — by dropping the whole preset a
//   tier. That is the one way a user CAN see voxelSize "work" under autoFit,
//   and it moves the probe grid at the same time, which makes it useless as a
//   discriminator between the two.
//
// So: autoFit OFF, explicit bounds, and the harness reads the BUILT res/c0Grid
// back off the live system every arm and refuses to report an arm whose dial
// did not move the build.
//
// TWO SOURCE MODES, because the user reports the artifact from both ends:
//   · "emissive" — the panel emits, nothing else lights the scene. 100% of the
//     floor's brightness is GI transport, so the artifact is at full contrast
//     and the metric is plain luminance.
//   · "albedo"   — a sun lights a GREEN diffuse panel; the floor is measured by
//     its GREEN EXCESS 2g/(r+b), which the white direct term cannot fake.
//   In both, the panel can be pinned `giMobility: "dynamic"` (MOVER=1) to ask
//   the same question of an exact mover that owns no voxels at all — and SPIN
//   then yaws it between frames. The panel is authored STILL either way: SPIN
//   drives the rotation LIVE through `entity.setTransform`, so a spinning run
//   and a still run load exactly the same scene file. The harness owns the one
//   geometric constraint that creates — the panel is `panelW` (2m) wide and
//   centred at x = -panelT/2, so yaw swings its footprint towards the measured
//   patch at x0 = 0.6 and arrives near 38 deg; widening the panel or moving
//   `patch.x0` inwards tightens that budget, and run-gi-block-size.mjs recomputes
//   it from these constants before every spinning run.
//
// The floor is deliberately EMPTY and OPEN — no ceiling, no side walls. A flat
// floor cannot see itself, so what lands on it is single-bounce transport from
// the panel and nothing else. Any structure in it came from the machinery.
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

// `strength`, NOT `emissionStrength` — the Emission node's float input is named
// `strength` (tslGraph NODE_TYPES.emission) and the wrong key silently falls
// back to 1. makeBleedProject.mjs still carries that typo; every EMISSIVE
// magnitude it ever reported was strength 1.
const emissive = (color, strength) => ({
  color: "#ffffff", roughness: 0.7, metalness: 0, map: "",
  shaderGraph: {
    nodes: [
      { id: "em", type: "emission", props: { color, strength }, position: { x: 228, y: 176 } },
      { id: "output", type: "output", props: {}, position: { x: 560, y: 150 } },
    ],
    edges: [{ id: "e1", source: "em", sourceHandle: "out", target: "output", targetHandle: "surface" }],
  },
  pipeline: null,
});

let n = 0;
const id = () => `blk${(n++).toString().padStart(3, "0")}`;
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

export const BLOCK_RIG = {
  // Panel: a 0.2m-thick BOX whose +x face sits exactly at x = 0. A
  // zero-thickness plane voxelizes to a single shell layer that lands on one
  // side only, which makes the near floor read an unlit occluder (see
  // makeBleedProject's note — same failure, same fix).
  panelW: 2,      // z extent
  panelH: 2,      // y extent
  panelT: 0.2,    // x extent
  floorX0: -2, floorX1: 10,
  floorZ: 8,
  floorAlbedo: "#e8e8e8",
  // MANUAL volume, centred on the GI entity. THE GI ENTITY STAYS AT THE ORIGIN:
  // the rig meshes are its CHILDREN, so any offset here moves the whole scene
  // with it (the first run put the floor at y = 1.45 and framed the panel's top
  // face instead of the floor). x ∈ [-6, 6], y ∈ [-3, 3], z ∈ [-4, 4]. Both
  // dials are live inside it, with these hard floors:
  //   voxelSize ≥ sizeX/MAX_AXIS_RES = 12/128 = 0.094  (res clamps above that)
  //   probeSpacing ≥ sizeX/MAX_PROBE_AXIS = 12/48 = 0.25 (c0Grid clamps below)
  // A sweep that crosses either clamp measures the clamp, not the dial.
  giCenter: [0, 0, 0],
  sizeX: 12, sizeY: 6, sizeZ: 8,
  minVoxel: 12 / 128,
  minProbe: 12 / 48,
  // The measured floor patch, world space, y = 0.
  //   · starts at 0.4m — the panel's own screen silhouette (top edge at y = 2,
  //     seen from y = 12) leans back to a ground-equivalent x of −0.58, so 0.4
  //     clears it with margin (measured: the silhouette ends at x ≈ 0.02);
  //   · ends at 2.8m — past that a strength-4 panel puts the floor into the
  //     8-bit noise floor, and a residual measured there is quantisation. The
  //     first run of this rig sampled 0.8–5.0m and read RMS 39 (i.e. the
  //     residual was 39× the level) for exactly that reason.
  // A patch this size resolves blocks up to ~1/3 of its span; bigger structure
  // is absorbed by the per-line detrend.
  patch: { x0: 0.6, x1: 2.8, z0: -1.8, z1: 1.8 },
  // Near-overhead and NARROW (fov 20): a steep view keeps the floor's world
  // axes aligned with the image axes so an x-lag and a z-lag mean what they
  // say, and the narrow fov buys ~190 px/m without lowering the camera into
  // the panel's parallax.
  eye: [2.9, 12, 0.6],
  target: [2.9, 0, 0],
  fov: 20,
  sunDir: [-5, -5, -1.5],
  sunIntensity: 3,
};

/**
 * WHAT "NO TEMPORAL BLUR" ACTUALLY TAKES — the globals the component props
 * cannot reach. Injected before any module runs (run-gi-block-size.mjs's
 * `evaluateOnNewDocument` GLOBALS path) when `QUIET_EMA=1`.
 *
 * OPT-IN, NOT THE DEFAULT. The rig's default arm keeps today's behaviour byte
 * for byte — see the long note on `temporalBlend`/`probeSmoothing` in the scene
 * above for why the props there do not do what they claimed. A sweep run with
 * QUIET_EMA is NOT comparable with one run without it; say which you used.
 *
 * There are THREE temporal integrators in the chain, not two:
 *
 *   __giFieldSmoothing = 0   the per-cell FIELD RADIANCE EMA retain weight
 *                            (default 0.95, ~20-frame constant, NO component
 *                            prop — `temporalBlend` is a different uniform).
 *                            0 = "this frame's value outright", which the
 *                            module's own comment calls the pre-Phase-1
 *                            behaviour byte-for-byte.
 *
 *   __giProbeNoise     = 0   the PROBE EMA's noise-band alpha ceiling. This is
 *                            the one that makes `probeSmoothing: 1` a real
 *                            passthrough: with it at 0 the `select` in
 *                            createProbeIrradiance takes `base`, so
 *                            noiseFloor = base = 1 and
 *                            adaptive = mix(1, max(snap,1), boost) ≡ 1 for
 *                            EVERY probe at every `boost`. No lag, and — just
 *                            as important for a lattice measurement — no
 *                            per-probe 15% threshold deciding which probes lag.
 *                            (REQUIRES the hatch added to cascadeGather.js on
 *                            2026-08-07; before that the global was named in
 *                            two comments and read nowhere.)
 *
 *   __giDepthAlpha     = 1   the VISIBILITY integrators — the probe depth
 *                            moments AND the openness EMA. Both are documented
 *                            as deliberately INDEPENDENT of probeSmoothing, so
 *                            they keep integrating however the props are set;
 *                            1 = this frame only. Included because a rig whose
 *                            stated goal is "a settled measurement must not
 *                            depend on how long it settled" cannot leave a
 *                            third EMA running and call itself quiet.
 *
 * NOT the other flattening arm. If what you want is "remove the per-probe
 * threshold but KEEP the lag" (to separate the two), that is
 * `probeSmoothing: 0.25` + `__giProbeSnap = 0.25` on the component instead:
 * noiseFloor = min(0.25, 0.25) and max(0.25, 0.25) both collapse to 0.25, so
 * `adaptive` is a constant 0.25 regardless of `boost`.
 */
export const QUIET_EMA_GLOBALS = Object.freeze({
  __giFieldSmoothing: 0,
  __giProbeNoise: 0,
  __giDepthAlpha: 1,
});

/**
 * Euler XYZ (radians) whose -Z forward is `dir` — a directional light aims down
 * its ENTITY'S forward (LightComponent parents a target at local (0,0,-1)), so
 * position does not aim it. Same derivation as makeMoverBounceProject's.
 */
export function eulerForForward(dir) {
  const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  const [fx, fy, fz] = [dir[0] / len, dir[1] / len, dir[2] / len];
  const y = Math.asin(Math.max(-1, Math.min(1, -fx)));
  const cosY = Math.cos(y);
  const x = Math.abs(cosY) < 1e-6 ? 0 : Math.atan2(fy / cosY, -fz / cosY);
  return [x, y, 0];
}

export async function makeBlockRigProject(root, opts = {}) {
  const {
    gi = {},
    panelColor = "#12d012",
    emitStrength = 4,
    voxelSize = 0.15,
    probeSpacing = 0.375,
    mover = false,
  } = opts;
  await mkdir(path.join(root, "scenes"), { recursive: true });
  await mkdir(path.join(root, "materials"), { recursive: true });

  const mats = {
    Floor: bsdf(BLOCK_RIG.floorAlbedo),
    PanelWhite: bsdf("#e8e8e8"),
    PanelGreen: bsdf(panelColor),
    EmitWhite: emissive("#ffffff", emitStrength),
    EmitGreen: emissive(panelColor, emitStrength),
  };
  for (const [name, data] of Object.entries(mats)) {
    await writeFile(path.join(root, "materials", `${name}.mat`), JSON.stringify(data, null, 2));
  }
  const M = (name) => `${root.replaceAll("\\", "/")}/materials/${name}.mat`;
  const { panelW, panelH, panelT, floorX0, floorX1, floorZ } = BLOCK_RIG;

  const rig = [
    mesh("Floor", "box", M("Floor"),
      [(floorX0 + floorX1) / 2, -0.05, 0], [floorX1 - floorX0, 0.1, floorZ],
      { giMobility: "static", giTrace: "auto" }),
    // The arms swap this mesh's material and mobility; it starts on the STATIC
    // voxel path so "auto" cannot adopt it behind the measurement's back.
    // WHITE, not the green one: the metric in emissive mode is luminance, and a
    // saturated green panel puts all of it in one 8-bit channel, so the near
    // half of the patch clipped at GI intensity 3. White spreads the same
    // luminance over three channels and clips ~1.4x later. (MODE=albedo swaps
    // in PanelGreen, where the hue ratio is the point.)
    mesh("Panel", "box", M("EmitWhite"),
      [-panelT / 2, panelH / 2, 0], [panelT, panelH, panelW],
      { giMobility: mover ? "dynamic" : "static", giTrace: "auto", giDynamic: "auto" }),
  ];

  const scene = {
    version: 1,
    name: "Main",
    settings: {
      background: "#000000",
      ambientColor: "#ffffff",
      // NOTHING but the panel (and, in albedo mode, the sun) lights this rig.
      // Ambient is a flat term that would dilute the modulation being measured.
      ambientIntensity: 0,
      environment: { cubemap: "", background: false, lighting: false, intensity: 0, rotation: 0, blur: 0 },
      fog: { type: "none", color: "#f2f2f2", near: 10, far: 40, density: 0.02 },
      // Screenshots bypass tone mapping (the op renders to its own target), so
      // this is the viewport's business only — the numbers are raw radiance.
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
        id: "blockRoot", name: "BlockRig",
        position: BLOCK_RIG.giCenter, rotation: [0, 0, 0], scale: [1, 1, 1],
        viewOnly: false, enabledInEditor: true, enabledInGame: true,
        components: [{
          type: "global-illumination",
          props: {
            enabled: true,
            // THE WHOLE POINT — see the header. autoFit ON silently ignores
            // both dials this rig exists to sweep.
            autoFit: false,
            quality: "high",
            sizeX: BLOCK_RIG.sizeX, sizeY: BLOCK_RIG.sizeY, sizeZ: BLOCK_RIG.sizeZ,
            voxelSize, probeSpacing,
            cascadeCount: 5, c0DirRes: 4,
            // The INDIRECT term only. Lifted well above 1 so the far end of
            // the patch clears the 8-bit floor — the modulation being measured
            // is a few percent of the level, and at intensity 1 that is one
            // quantisation step.
            intensity: 3, skyColor: "#ffffff", skyIntensity: 0,
            bounce: 1, bleedSaturation: 1,
            // ── THESE TWO DO NOT DISABLE THE EMAs. THEY NEVER DID. ───────────
            //
            // This pair shipped with the comment "temporalBlend 1 = no field
            // EMA, probeSmoothing 1 = no probe EMA", and BOTH halves are false.
            // Every measurement this rig has ever produced was taken with two
            // temporal integrators running, so read its history accordingly.
            //
            //  · `temporalBlend` is NOT the field EMA. It is the staging→base
            //    INGEST lerp (cascadeGather.js, the `blendUniform` at the top of
            //    the feedback Fn: `alpha = blendUniform` when occupancy did not
            //    flip, `base = mix(prev, staging, alpha)`). At 1 the CPU bake
            //    lands outright — correct, and worth keeping — but that is the
            //    bake-swap ramp, not the radiance history.
            //    The FIELD EMA is a different uniform entirely:
            //    `state.fieldSmoothing`, the per-cell radiance RETAIN weight,
            //    fed from `globalThis.__giFieldSmoothing ?? 0.95` (GISystem
            //    #applyLiveProps and the build). **It has no component prop at
            //    all**, so no value of any authored field can reach it, and it
            //    defaults to 0.95 — a ~20-frame time constant sitting under
            //    every "settled" number this rig reports.
            //
            //  · `probeSmoothing: 1` does NOT make the probe EMA a passthrough.
            //    The adaptive-hysteresis mix in createProbeIrradiance is
            //      base      = clamp(probeSmoothing, 0.02, 1)          = 1
            //      noiseFloor= min(base, probeNoiseAlpha)              = 0.25
            //      adaptive  = mix(noiseFloor, max(probeSnapAlpha, base), boost)
            //      boost     = smoothstep(0.15, 0.60, relative frame delta)
            //    so any probe whose frame-to-frame irradiance moves less than
            //    15% is pinned at alpha ≤ 0.25 — a ~4-frame ramp — REGARDLESS of
            //    this prop. Sub-threshold probes lag; above-threshold probes do
            //    not; which side a probe is on is itself part of the picture.
            //    (And `__giProbeSnap` cannot undo it: `max(probeSnapAlpha, base)`
            //    ignores the snap value whenever probeSmoothing ≥ it, which at 1
            //    is always.)
            //
            // KEPT AS THE DEFAULT ANYWAY, deliberately: changing them would
            // change what every previous run of this rig measured, and the
            // point of a frozen rig is that its arms stay comparable. The
            // genuinely-quiet configuration is QUIET_EMA_GLOBALS below, opt-in
            // via `QUIET_EMA=1` on scripts/run-gi-block-size.mjs.
            temporalBlend: 1, probeSmoothing: 1,
            peakSplit: false,
            // Reflections add a second screen term with its own reconstruction
            // to the floor's pixels; this rig measures the diffuse gather.
            reflections: false, exactReflections: false,
            backend: "occupancy", sparseField: false,
            // FIELD emissive path, not the analytic emitter path. The user's
            // Cornell scene has emissiveShadows off too, and the analytic path
            // would bypass the field entirely — which is the thing under test.
            emissiveShadows: false,
            // AO is a second occupancy-lattice term painted onto the same
            // pixels. It would be measured AS the artifact.
            ao: false, aoStrength: 0.6, aoRadius: 0.6,
            resolveScale: 1, autoRebake: true, debugProbes: "off", hitLighting: false,
            ...gi,
          },
        }],
        children: rig,
      },
      {
        id: "blockSun", name: "Sun",
        position: [8, 6, 2], rotation: eulerForForward(BLOCK_RIG.sunDir), scale: [1, 1, 1],
        viewOnly: false, enabledInEditor: true, enabledInGame: true,
        components: [{
          type: "light",
          props: {
            enabled: true, kind: "directional", color: "#ffffff",
            // OFF at load: the emissive mode is the default arm and a sun would
            // swamp it. The albedo arm turns it up through component.setProp.
            intensity: 0,
            // Shadow MAPS, per the user's 2026-08-07 pivot — a GI-traced sun
            // would put the voxel lattice on the DIRECT term too, and then a
            // block on the floor could not be attributed to the indirect path.
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
        id: "blockCam", name: "Camera",
        position: [6, 4, 6], rotation: [0, 0, 0], scale: [1, 1, 1],
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
    name: "GI-BlockSize", version: 1,
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
