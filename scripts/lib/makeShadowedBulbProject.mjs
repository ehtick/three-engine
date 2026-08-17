// THE SHADOWED-BULB RIG — Phase E's new gate (plan Part 1 E4), and the rig
// E0 runs to decide whether emitter delivery is severed.
//
// ══ WHY THIS RIG AND NOT ANOTHER EMISSIVE ROOM ═════════════════════════════
//
// Every emissive rig this module already owns (the storm, the NEE parity room,
// the emitter-scale ledger) shares one property that hides the bug under
// investigation: THE LAMPS ARE IN FRAME. A lamp's own pixels are emissive
// geometry rendered by the raster path — they are bright whether or not GI
// delivers a single photon — so a centre-crop luminance statistic passes with
// the entire transport severed. That is exactly how R5-zeroing-over-dead-
// delivery shipped: all 95 emitters had their field emission deleted on the
// promise the tree would deliver, and nothing in the suite could tell.
//
// So here the bulb is HIDDEN FROM THE CAMERA BY A SHADE and the statistic is
// read off a NEUTRAL WALL PATCH it lights. Every lit pixel in the crop is
// delivered light. Emitter off = black. There is no path by which this rig
// reports success without the emitter actually reaching the wall.
//
// ══ THE GEOMETRY, AND WHY EACH NUMBER ══════════════════════════════════════
//
//        camera (0, 1.5, +2.0)  ──►  looking at the back wall
//                    │
//              shade │  z = -2.35, 0.5 x 0.5 m opaque card
//               bulb ○  z = -2.50, r = 0.05 m, authored strength >= 1000
//        back wall ██████  z = -3.00
//
// · r = 0.05 m and strength >= 1000 is the user's exact case ("1000 emission
//   strength mesh does not cast any light on surrounding meshes at all"), and
//   it is also the case the reach/cutoff suspects in E2 would break: an
//   emitter whose range is derived from its GEOMETRIC radius is capped at a
//   few centimetres here regardless of its power.
// · The bulb sits 0.5 m from the wall, so the pool is small and bright rather
//   than a wash — a wash is what an ambient/boot-ambient leak looks like, and
//   the two must not be confusable.
// · The shade is 0.5 m across at 4.35 m from the camera (half-angle 0.057 rad)
//   and the wall is at 5.0 m, so the shade hides a 0.29 m-radius disc of wall.
//   The bulb's pool is far wider than that, so the measured ring is bright:
//   at the shadowed disc's edge the inverse-square falloff has only reached
//   0.25/(0.25+0.29²) = 75% of the peak.
// · NO SUN AND NO ENVIRONMENT. The bulb is the only light in the room, which
//   is what "in full shadow" means for a rig — anything the wall shows came
//   from the bulb or from a bug.
//
// `emitStrength: 0` builds the OFF arm as a real project rather than as a
// runtime toggle, because every runtime path for darkening an emitter
// (`visible = false`, a slot radius) is itself part of what is under test.
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

// `strength`, NOT `emissionStrength` — tslGraph's emission node names its float
// input `strength`, and the wrong key silently falls back to 1 (the storm rig's
// own comment records losing a whole run to it).
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
const id = () => `bulb${(n++).toString().padStart(3, "0")}`;
const mesh = (name, geometry, material, position, scale, extra = {}) => ({
  id: id(), name, position, rotation: [0, 0, 0], scale,
  viewOnly: false, enabledInEditor: true, enabledInGame: true,
  components: [{
    type: "mesh",
    props: {
      enabled: true, geometry, geometryAsset: "", material,
      material2: "", material3: "", material4: "", material5: "", material6: "", material7: "", material8: "",
      castShadow: false, receiveShadow: true,
      ...extra,
    },
  }],
  children: [],
});

/** The measured pose. Exported so the harness cannot drift from the rig. */
export const BULB_POSE = { position: [0, 1.5, 2.0], target: [0, 1.5, -3.0] };

/**
 * Where the bulb sits and how big it is — exported for the same reason: E2's
 * stage walk needs to ask "is THIS emitter in THIS pixel's cut list", and a
 * harness that hard-codes a second copy of the position answers about a
 * different point in space.
 */
export const BULB = { position: [0, 1.5, -2.5], radius: 0.05, wallZ: -3.0 };

export async function makeShadowedBulbProject(root, opts = {}) {
  const {
    quality = "high",
    emitStrength = 2000,
    bulbRadius = BULB.radius,
    // Extra bulbs, to put the rig past MAX_EMITTERS. With `bulbCount: 1` the
    // single bulb WINS a seat, so the default rig measures the seated path and
    // proves the instrument; past 4 the tail bulbs are un-seated and only the
    // tree/tile-cut path can deliver them. Both are wanted, and mixing them in
    // one arm would make a partial delivery look like a dim one.
    bulbCount = 1,
    // ── DECOYS: HOW THE MEASURED BULB IS MADE UN-SEATED ─────────────────────
    //
    // Four lamps that outrank the measured bulb for all MAX_EMITTERS analytic
    // seats, so bulb 0 is delivered by the tree/tile-cut path ALONE. They sit
    // in the FRONT corners — behind the camera at the measured pose, on the
    // far side of the room from the wall patch — and they are IDENTICAL IN
    // BOTH ARMS. That is what makes the statistic clean: `emitStrength` darkens
    // only bulb 0, so the lit-minus-dark delta is exactly one un-seated
    // emitter's delivery, measured against a room that is otherwise lit the
    // same way in both arms (a realistic noise floor, not a black one).
    //
    // Seat ranking is `luminance x radius² / (1 + d²_camera)`. The decoys win
    // on both terms — 3x the radius (9x the area) and a third of the camera
    // distance squared — for roughly 20x the score, comfortably past the 1.5x
    // sticky-seat hysteresis in both directions.
    decoyCount = 0,
    decoyStrength = 2000,
    decoyRadius = 0.15,
    // ── FILLERS: EMITTER COUNT AS A DIAL ────────────────────────────────────
    //
    // Dim bulbs scattered through the room whose only job is to make the light
    // tree BIG. The user's scene has 95 emitters and this rig had 5, and that
    // is the one structural difference that could break delivery while leaving
    // a small rig healthy: the per-tile cut keeps FOUR emitters, ranked by
    // importance at the tile centre, so an emitter's screen-direct term
    // survives only if it out-ranks every other emitter competing for that
    // tile. Five emitters cannot test that; ninety-five can.
    //
    // Strength 5 clears the 0.5 peak promotion gate by 10x while contributing
    // almost nothing to the crop, and they are IDENTICAL IN BOTH ARMS.
    fillerCount = 0,
    fillerStrength = 5,
    // Gap between the bulb and the wall it lights. The falloff sweep's dial: the
    // default 0.5 m is deliberately CLOSE (a bright, unambiguous pool), which is
    // exactly why the first version of this rig could not tell "delivers" from
    // "delivers only very close" — a reach cutoff derived from the emitter's
    // geometric radius would cap a 5 cm bulb at a few centimetres and still pass
    // a 0.5 m measurement.
    bulbWallGap = 0.5,
    // "none" makes the canvas linear before sRGB, so luminance RATIOS mean
    // something. AgX at a 0.65 mean is deep into its shoulder and would compress
    // an inverse-square falloff into something much flatter — a tone curve
    // masquerading as a reach cutoff.
    toneMapping = "agx",
    // Merge the bulbs into a proxy's material group (E3/E6). Off by default.
    mergeable = false,
  } = opts;
  await mkdir(path.join(root, "scenes"), { recursive: true });
  await mkdir(path.join(root, "materials"), { recursive: true });

  const mats = { Wall: bsdf("#c8c8c8"), Shade: bsdf("#101010") };
  for (let i = 0; i < bulbCount; i++) mats[`Bulb${i}`] = emissive("#ffffff", emitStrength);
  if (decoyCount) mats.Decoy = emissive("#ffffff", decoyStrength);
  if (fillerCount) mats.Filler = emissive("#ffffff", fillerStrength);
  for (const [name, data] of Object.entries(mats)) {
    await writeFile(path.join(root, "materials", `${name}.mat`), JSON.stringify(data, null, 2));
  }
  const M = (name) => `${root.replaceAll("\\", "/")}/materials/${name}.mat`;

  // The room. 6 x 3 x 6, walls 0.1 thick, all one neutral material so the
  // patch statistic is not confounded by albedo.
  const room = [
    mesh("Floor", "box", M("Wall"), [0, -0.05, 0], [6, 0.1, 6]),
    mesh("Ceiling", "box", M("Wall"), [0, 3.05, 0], [6, 0.1, 6]),
    mesh("WallBack", "box", M("Wall"), [0, 1.5, -3.05], [6, 3, 0.1]),
    mesh("WallFront", "box", M("Wall"), [0, 1.5, 3.05], [6, 3, 0.1]),
    mesh("WallLeft", "box", M("Wall"), [-3.05, 1.5, 0], [0.1, 3, 6]),
    mesh("WallRight", "box", M("Wall"), [3.05, 1.5, 0], [0.1, 3, 6]),
  ];

  // Bulbs, spread along x so extra ones do not overlap the measured pool. Bulb
  // 0 is always the one at the measured pose.
  const bulbs = [];
  for (let i = 0; i < bulbCount; i++) {
    const x = i === 0 ? 0 : (i % 2 === 1 ? 1 : -1) * (0.8 + Math.floor((i - 1) / 2) * 0.7);
    bulbs.push(mesh(`Bulb${i}`, "sphere", M(`Bulb${i}`), [x, BULB.position[1], BULB.wallZ + bulbWallGap],
      [bulbRadius * 2, bulbRadius * 2, bulbRadius * 2], {
        giMobility: "static", giTrace: "auto", giDynamic: "auto",
        // Same material for every bulb when the merge arm is on, so the
        // same-material path has a group to weld. Distinct otherwise.
        material: mergeable ? M("Bulb0") : M(`Bulb${i}`),
      }));
  }

  // Decoy homes: the two front corners, high and low, all behind the camera at
  // the measured pose so none of them is ever in the crop.
  const DECOY_HOMES = [
    [-2.4, 2.5, 2.4], [2.4, 2.5, 2.4], [-2.4, 0.6, 2.4], [2.4, 0.6, 2.4],
  ];
  const decoys = DECOY_HOMES.slice(0, decoyCount).map((p, i) =>
    mesh(`Decoy${i}`, "sphere", M("Decoy"), p, [decoyRadius * 2, decoyRadius * 2, decoyRadius * 2], {
      giMobility: "static", giTrace: "auto", giDynamic: "auto",
    }));

  // Fillers on a deterministic lattice through the room's volume, skipping the
  // half-metre around the measured bulb so they never join its own pool.
  const fillers = [];
  for (let i = 0; fillers.length < fillerCount && i < fillerCount * 4; i++) {
    const gx = i % 5, gy = Math.floor(i / 5) % 4, gz = Math.floor(i / 20) % 5;
    const p = [-2.2 + gx * 1.1, 0.5 + gy * 0.7, -2.0 + gz * 1.0 + (i >= 100 ? 0.12 : 0)];
    const d = Math.hypot(p[0] - 0, p[1] - BULB.position[1], p[2] - (BULB.wallZ + bulbWallGap));
    if (d < 0.6) continue;
    fillers.push(mesh(`Filler${fillers.length}`, "sphere", M("Filler"), p, [0.08, 0.08, 0.08], {
      giMobility: "static", giTrace: "auto", giDynamic: "auto",
    }));
  }

  const rig = [
    ...room,
    ...decoys,
    ...fillers,
    // THE SHADE. Opaque, black, and only in front of bulb 0 — the extra bulbs
    // are off-axis and hidden by the same card in screen space at this pose
    // only if it is wide enough, so it is sized to the measured bulb and the
    // extras are placed inside its silhouette's reach.
    mesh("Shade", "box", M("Shade"), [0, 1.5, BULB.wallZ + bulbWallGap + 0.15], [0.5, 0.5, 0.04], {
      giMobility: "static", giTrace: "auto", giDynamic: "auto",
    }),
    ...bulbs,
  ];

  const scene = {
    version: 1,
    name: "Main",
    settings: {
      background: "#000000",
      ambientColor: "#ffffff",
      // ZERO. Ambient is the one term that would light the wall with the bulb
      // dead, and this rig's whole claim is that a lit wall means delivery.
      ambientIntensity: 0,
      environment: { cubemap: "", background: false, lighting: false, intensity: 0, rotation: 0, blur: 0 },
      fog: { type: "none", color: "#f2f2f2", near: 10, far: 40, density: 0.02 },
      toneMapping,
      exposure: 1,
      shadows: true,
      renderer: { antialias: true, samples: 4, transparent: false },
      shadow: { type: "PCFSoftShadowMap", autoUpdate: true, needsUpdate: false },
      performance: {
        maxDevicePixelRatio: 1, renderScale: 1, dynamicResolution: false,
        targetFps: 120, volumeStepScale: 1,
        // AUTO-BATCHING OFF unless the merge arm asks for it: a proxy that
        // welds the bulbs is E3/E6's subject, not a background variable.
        autoBatching: !!mergeable, occlusionCulling: false,
      },
    },
    entities: [
      {
        id: "bulbRoot", name: "ShadowedBulb",
        position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
        viewOnly: false, enabledInEditor: true, enabledInGame: true,
        components: [{ type: "global-illumination", props: { enabled: true, quality } }],
        children: rig,
      },
      // NO SUN ENTITY AT ALL. An intensity-0 light would still build a shadow
      // map and take the sun path through the resolve; absent is the arm this
      // rig means.
    ],
  };

  await writeFile(path.join(root, "scenes", "Main.scene"), JSON.stringify(scene, null, 1));
  await writeFile(path.join(root, "project.json"), JSON.stringify({
    name: "GI-ShadowedBulb", version: 1,
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
