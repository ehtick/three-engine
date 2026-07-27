/**
 * Ready-made particle graphs. Each is a plain graph (same shape the compiler
 * takes) demonstrating how the small nodes compose into a class of effect.
 * Loading a preset replaces the current graph in the editor (until Apply,
 * nothing touches the component).
 */

export const PARTICLE_PRESETS = {
  // Two independent emitter branches sharing one component: a wide flame
  // body (rise-then-fade opacity and a fat-near-base/thin-near-tip size
  // curve, the same layered-forces technique Smoke uses) plus a second,
  // faster-rising ember layer — the flagship demo of multi-emitter graphs.
  Fire: {
    nodes: [
      // --- Flame body -------------------------------------------------------
      { id: "emit", type: "emitCone", props: { radius: 0.28, angle: 22 }, position: { x: -60, y: 40 } },
      { id: "speed", type: "float", props: { value: 1.8 }, position: { x: -60, y: 230 } },
      { id: "vel", type: "multiply", props: {}, position: { x: 170, y: 120 } },
      { id: "heat", type: "buoyancy", props: { strength: 4.2, flicker: 1 }, position: { x: -60, y: 360 } },
      { id: "turb", type: "turbulence", props: { frequency: 1.4, strength: 1.9, speed: 0.7 }, position: { x: -60, y: 520 } },
      { id: "windN", type: "wind", props: { direction: [1, 0, 0.15], strength: 0.25, gustiness: 0.6, gustFrequency: 0.6 }, position: { x: -60, y: 690 } },
      { id: "drag", type: "drag", props: { amount: 0.6 }, position: { x: -60, y: 860 } },
      { id: "f1", type: "add", props: {}, position: { x: 170, y: 430 } },
      { id: "f2", type: "add", props: {}, position: { x: 170, y: 590 } },
      { id: "f3", type: "add", props: {}, position: { x: 170, y: 750 } },
      { id: "ramp", type: "gradient", props: { from: "#ffe08a", to: "#ff2200" }, position: { x: 170, y: 260 } },
      { id: "sizeRise", type: "remap", props: { inMin: 0, inMax: 0.2, outMin: 0.05, outMax: 0.42 }, position: { x: 450, y: 620 } },
      { id: "sizeFall", type: "remap", props: { inMin: 0, inMax: 1, outMin: 1, outMax: 0.15 }, position: { x: 450, y: 780 } },
      { id: "sizeMul", type: "multiply", props: {}, position: { x: 700, y: 700 } },
      { id: "opRise", type: "remap", props: { inMin: 0, inMax: 0.15, outMin: 0, outMax: 1 }, position: { x: 450, y: 940 } },
      { id: "opFall", type: "remap", props: { inMin: 0, inMax: 1, outMin: 1, outMax: 0 }, position: { x: 450, y: 1080 } },
      { id: "opMul", type: "multiply", props: {}, position: { x: 700, y: 1010 } },
      { id: "sys", type: "system", props: { capacity: 3000, lifetime: 1.3, lifetimeJitter: 0.4, additive: true, lightCount: 2, lightIntensity: 5, lightDistance: 6 }, position: { x: 950, y: 180 } },

      // --- Embers (second, independent emitter branch) ----------------------
      { id: "e_emit", type: "emitCone", props: { radius: 0.14, angle: 10 }, position: { x: -60, y: 1300 } },
      { id: "e_speed", type: "float", props: { value: 3.5 }, position: { x: -60, y: 1480 } },
      { id: "e_vel", type: "multiply", props: {}, position: { x: 170, y: 1360 } },
      { id: "e_heat", type: "buoyancy", props: { strength: 5, flicker: 1.2 }, position: { x: -60, y: 1640 } },
      { id: "e_turb", type: "turbulence", props: { frequency: 1.8, strength: 1.2, speed: 0.9 }, position: { x: -60, y: 1800 } },
      { id: "e_f1", type: "add", props: {}, position: { x: 170, y: 1720 } },
      { id: "e_ramp", type: "gradient", props: { from: "#fff6d0", to: "#ff8a1e" }, position: { x: 170, y: 1500 } },
      { id: "e_size", type: "remap", props: { inMin: 0, inMax: 1, outMin: 0.035, outMax: 0.01 }, position: { x: 450, y: 1860 } },
      { id: "e_opRise", type: "remap", props: { inMin: 0, inMax: 0.1, outMin: 0, outMax: 1 }, position: { x: 450, y: 2000 } },
      { id: "e_opFall", type: "remap", props: { inMin: 0, inMax: 1, outMin: 1, outMax: 0 }, position: { x: 450, y: 2140 } },
      { id: "e_opMul", type: "multiply", props: {}, position: { x: 700, y: 2070 } },
      { id: "e_sys", type: "system", props: { capacity: 500, lifetime: 0.7, lifetimeJitter: 0.5, sizeJitter: 0.4, additive: true }, position: { x: 950, y: 1500 } },
    ],
    edges: [
      // Flame body
      { source: "emit", sourceHandle: "pos", target: "sys", targetHandle: "position" },
      { source: "emit", sourceHandle: "dir", target: "vel", targetHandle: "a" },
      { source: "speed", sourceHandle: "out", target: "vel", targetHandle: "b" },
      { source: "vel", sourceHandle: "out", target: "sys", targetHandle: "velocity" },
      { source: "heat", sourceHandle: "out", target: "f1", targetHandle: "a" },
      { source: "turb", sourceHandle: "out", target: "f1", targetHandle: "b" },
      { source: "f1", sourceHandle: "out", target: "f2", targetHandle: "a" },
      { source: "windN", sourceHandle: "out", target: "f2", targetHandle: "b" },
      { source: "f2", sourceHandle: "out", target: "f3", targetHandle: "a" },
      { source: "drag", sourceHandle: "out", target: "f3", targetHandle: "b" },
      { source: "f3", sourceHandle: "out", target: "sys", targetHandle: "force" },
      { source: "ramp", sourceHandle: "out", target: "sys", targetHandle: "color" },
      { source: "sizeRise", sourceHandle: "out", target: "sizeMul", targetHandle: "a" },
      { source: "sizeFall", sourceHandle: "out", target: "sizeMul", targetHandle: "b" },
      { source: "sizeMul", sourceHandle: "out", target: "sys", targetHandle: "size" },
      { source: "opRise", sourceHandle: "out", target: "opMul", targetHandle: "a" },
      { source: "opFall", sourceHandle: "out", target: "opMul", targetHandle: "b" },
      { source: "opMul", sourceHandle: "out", target: "sys", targetHandle: "opacity" },

      // Embers
      { source: "e_emit", sourceHandle: "pos", target: "e_sys", targetHandle: "position" },
      { source: "e_emit", sourceHandle: "dir", target: "e_vel", targetHandle: "a" },
      { source: "e_speed", sourceHandle: "out", target: "e_vel", targetHandle: "b" },
      { source: "e_vel", sourceHandle: "out", target: "e_sys", targetHandle: "velocity" },
      { source: "e_heat", sourceHandle: "out", target: "e_f1", targetHandle: "a" },
      { source: "e_turb", sourceHandle: "out", target: "e_f1", targetHandle: "b" },
      { source: "e_f1", sourceHandle: "out", target: "e_sys", targetHandle: "force" },
      { source: "e_ramp", sourceHandle: "out", target: "e_sys", targetHandle: "color" },
      { source: "e_size", sourceHandle: "out", target: "e_sys", targetHandle: "size" },
      { source: "e_opRise", sourceHandle: "out", target: "e_opMul", targetHandle: "a" },
      { source: "e_opFall", sourceHandle: "out", target: "e_opMul", targetHandle: "b" },
      { source: "e_opMul", sourceHandle: "out", target: "e_sys", targetHandle: "opacity" },
    ],
  },

  Smoke: {
    nodes: [
      { id: "emit", type: "emitSphere", props: { radius: 0.2 }, position: { x: -60, y: 40 } },
      { id: "speed", type: "float", props: { value: 0.5 }, position: { x: -60, y: 230 } },
      { id: "vel", type: "multiply", props: {}, position: { x: 170, y: 120 } },
      { id: "rise", type: "buoyancy", props: { strength: 1.2, flicker: 0.3 }, position: { x: -60, y: 360 } },
      { id: "turb", type: "turbulence", props: { frequency: 0.5, strength: 0.8, speed: 0.25 }, position: { x: -60, y: 520 } },
      { id: "windN", type: "wind", props: { direction: [1, 0, 0.2], strength: 0.35, gustiness: 0.8, gustFrequency: 0.4 }, position: { x: -60, y: 690 } },
      { id: "drag", type: "drag", props: { amount: 0.8 }, position: { x: -60, y: 860 } },
      { id: "f1", type: "add", props: {}, position: { x: 170, y: 430 } },
      { id: "f2", type: "add", props: {}, position: { x: 170, y: 590 } },
      { id: "f3", type: "add", props: {}, position: { x: 170, y: 750 } },
      { id: "ramp", type: "gradient", props: { from: "#7a7a80", to: "#26262e" }, position: { x: 170, y: 260 } },
      { id: "grow", type: "remap", props: { inMin: 0, inMax: 1, outMin: 0.15, outMax: 1.2 }, position: { x: 450, y: 620 } },
      { id: "fade", type: "remap", props: { inMin: 0, inMax: 1, outMin: 0.35, outMax: 0 }, position: { x: 450, y: 780 } },
      { id: "sys", type: "system", props: { capacity: 1200, lifetime: 4, lifetimeJitter: 0.4, additive: false }, position: { x: 720, y: 180 } },
    ],
    edges: [
      { source: "emit", sourceHandle: "pos", target: "sys", targetHandle: "position" },
      { source: "emit", sourceHandle: "dir", target: "vel", targetHandle: "a" },
      { source: "speed", sourceHandle: "out", target: "vel", targetHandle: "b" },
      { source: "vel", sourceHandle: "out", target: "sys", targetHandle: "velocity" },
      { source: "rise", sourceHandle: "out", target: "f1", targetHandle: "a" },
      { source: "turb", sourceHandle: "out", target: "f1", targetHandle: "b" },
      { source: "f1", sourceHandle: "out", target: "f2", targetHandle: "a" },
      { source: "windN", sourceHandle: "out", target: "f2", targetHandle: "b" },
      { source: "f2", sourceHandle: "out", target: "f3", targetHandle: "a" },
      { source: "drag", sourceHandle: "out", target: "f3", targetHandle: "b" },
      { source: "f3", sourceHandle: "out", target: "sys", targetHandle: "force" },
      { source: "ramp", sourceHandle: "out", target: "sys", targetHandle: "color" },
      { source: "grow", sourceHandle: "out", target: "sys", targetHandle: "size" },
      { source: "fade", sourceHandle: "out", target: "sys", targetHandle: "opacity" },
    ],
  },

  Fountain: {
    nodes: [
      { id: "emit", type: "emitCone", props: { radius: 0.06, angle: 9 }, position: { x: -60, y: 40 } },
      { id: "speed", type: "float", props: { value: 6.5 }, position: { x: -60, y: 230 } },
      { id: "vel", type: "multiply", props: {}, position: { x: 170, y: 120 } },
      { id: "grav", type: "gravity", props: { vector: [0, -9.8, 0] }, position: { x: 170, y: 300 } },
      { id: "ramp", type: "gradient", props: { from: "#bfe3ff", to: "#2a6cff" }, position: { x: 170, y: 460 } },
      { id: "size", type: "float", props: { value: 0.06 }, position: { x: 170, y: 620 } },
      { id: "sys", type: "system", props: { capacity: 6000, lifetime: 3, lifetimeJitter: 0.25, additive: true, floor: "bounce", floorY: 0, bounce: 0.45 }, position: { x: 470, y: 160 } },
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
  },

  Snow: {
    nodes: [
      { id: "emit", type: "emitBox", props: { size: [10, 0.2, 10] }, position: { x: -60, y: 40 } },
      { id: "split", type: "split", props: {}, position: { x: -60, y: 200 } },
      { id: "height", type: "float", props: { value: 8 }, position: { x: -60, y: 360 } },
      { id: "spawn", type: "combine", props: {}, position: { x: 110, y: 220 } },
      { id: "fall", type: "vec3", props: { value: [0, -0.9, 0] }, position: { x: -60, y: 530 } },
      { id: "windN", type: "wind", props: { direction: [1, 0, 0.3], strength: 0.4, gustiness: 1, gustFrequency: 0.3 }, position: { x: -60, y: 700 } },
      { id: "sway", type: "turbulence", props: { frequency: 0.35, strength: 0.4, speed: 0.3 }, position: { x: -60, y: 870 } },
      { id: "drag", type: "drag", props: { amount: 0.4 }, position: { x: -60, y: 1040 } },
      { id: "f1", type: "add", props: {}, position: { x: 170, y: 770 } },
      { id: "f2", type: "add", props: {}, position: { x: 170, y: 940 } },
      { id: "white", type: "color", props: { value: "#ffffff" }, position: { x: 170, y: 160 } },
      { id: "size", type: "float", props: { value: 0.045 }, position: { x: 170, y: 300 } },
      { id: "sys", type: "system", props: { capacity: 4000, lifetime: 9, lifetimeJitter: 0.35, additive: false, floor: "kill", floorY: 0 }, position: { x: 470, y: 140 } },
    ],
    edges: [
      { source: "emit", sourceHandle: "pos", target: "split", targetHandle: "v" },
      { source: "split", sourceHandle: "x", target: "spawn", targetHandle: "x" },
      { source: "height", sourceHandle: "out", target: "spawn", targetHandle: "y" },
      { source: "split", sourceHandle: "z", target: "spawn", targetHandle: "z" },
      { source: "spawn", sourceHandle: "out", target: "sys", targetHandle: "position" },
      { source: "fall", sourceHandle: "out", target: "sys", targetHandle: "velocity" },
      { source: "windN", sourceHandle: "out", target: "f1", targetHandle: "a" },
      { source: "sway", sourceHandle: "out", target: "f1", targetHandle: "b" },
      { source: "f1", sourceHandle: "out", target: "f2", targetHandle: "a" },
      { source: "drag", sourceHandle: "out", target: "f2", targetHandle: "b" },
      { source: "f2", sourceHandle: "out", target: "sys", targetHandle: "force" },
      { source: "white", sourceHandle: "out", target: "sys", targetHandle: "color" },
      { source: "size", sourceHandle: "out", target: "sys", targetHandle: "size" },
    ],
  },

  "Magic Vortex": {
    nodes: [
      { id: "emit", type: "emitCircle", props: { radius: 1.3 }, position: { x: -60, y: 40 } },
      { id: "inward", type: "float", props: { value: -0.25 }, position: { x: -60, y: 230 } },
      { id: "vel", type: "multiply", props: {}, position: { x: 170, y: 120 } },
      { id: "swirl", type: "vortex", props: { center: [0, 0, 0], axis: [0, 1, 0], strength: 6, pull: 0.9 }, position: { x: -60, y: 380 } },
      { id: "lift", type: "attract", props: { point: [0, 1.8, 0], strength: 2.5, falloff: 0.8 }, position: { x: -60, y: 560 } },
      { id: "wisp", type: "turbulence", props: { frequency: 1.1, strength: 1, speed: 0.5 }, position: { x: -60, y: 730 } },
      { id: "f1", type: "add", props: {}, position: { x: 170, y: 460 } },
      { id: "f2", type: "add", props: {}, position: { x: 170, y: 630 } },
      { id: "ramp", type: "gradient", props: { from: "#7fe3ff", to: "#c26bff" }, position: { x: 170, y: 260 } },
      { id: "shrink", type: "remap", props: { inMin: 0, inMax: 1, outMin: 0.12, outMax: 0.02 }, position: { x: 450, y: 560 } },
      { id: "sys", type: "system", props: { capacity: 8000, lifetime: 3, lifetimeJitter: 0.3, additive: true, lightCount: 2, lightIntensity: 4, lightDistance: 6 }, position: { x: 470, y: 160 } },
    ],
    edges: [
      { source: "emit", sourceHandle: "pos", target: "sys", targetHandle: "position" },
      { source: "emit", sourceHandle: "dir", target: "vel", targetHandle: "a" },
      { source: "inward", sourceHandle: "out", target: "vel", targetHandle: "b" },
      { source: "vel", sourceHandle: "out", target: "sys", targetHandle: "velocity" },
      { source: "swirl", sourceHandle: "out", target: "f1", targetHandle: "a" },
      { source: "lift", sourceHandle: "out", target: "f1", targetHandle: "b" },
      { source: "f1", sourceHandle: "out", target: "f2", targetHandle: "a" },
      { source: "wisp", sourceHandle: "out", target: "f2", targetHandle: "b" },
      { source: "f2", sourceHandle: "out", target: "sys", targetHandle: "force" },
      { source: "ramp", sourceHandle: "out", target: "sys", targetHandle: "color" },
      { source: "shrink", sourceHandle: "out", target: "sys", targetHandle: "size" },
    ],
  },

  // -------------------------------------------------------------------------
  // Scene-integrated presets.
  //
  // Everything above predates the lighting work and leaves `lit`, `castShadow`
  // and `lightCount` at their defaults (false/false/0), so those effects are
  // unlit additive sprites: they cannot be shadowed, cannot receive light, and
  // are invisible to GI. That is why particles looked disconnected from the
  // scene. The presets below deliberately switch the integration on:
  //
  //   lit + receiveShadow  → the particles are shaded by scene lights AND by
  //                          the GI module when it is installed (a lit particle
  //                          uses MeshStandardNodeMaterial, which is exactly
  //                          what GICascadeLight plugs into).
  //   castShadow           → the particles darken geometry below them.
  //                          Measured at Δ75/255 on a white floor — the same as
  //                          a solid mesh (scripts/run-particle-lighting.mjs).
  //   lightCount           → the ONLY way particles push light back INTO the
  //                          scene and into GI: a few real PointLights follow
  //                          clusters of live particles, and GI consumes scene
  //                          lights. Keep the count low; each one is a real
  //                          light with real cost.
  // -------------------------------------------------------------------------

  // Sparks that actually light what they bounce off. Stretched along velocity,
  // so they read as streaks rather than dots.
  Sparks: {
    nodes: [
      { id: "emit", type: "emitSphere", props: { radius: 0.08 }, position: { x: -60, y: 40 } },
      { id: "speed", type: "float", props: { value: 6 }, position: { x: -60, y: 210 } },
      { id: "vel", type: "multiply", props: {}, position: { x: 180, y: 110 } },
      { id: "grav", type: "gravity", props: { vector: [0, -14, 0] }, position: { x: -60, y: 360 } },
      { id: "drag", type: "drag", props: { amount: 1.2 }, position: { x: -60, y: 500 } },
      { id: "f1", type: "add", props: {}, position: { x: 180, y: 420 } },
      { id: "heat", type: "remap", props: { inMin: 0, inMax: 1, outMin: 1, outMax: 0 }, position: { x: 180, y: 620 } },
      { id: "glow", type: "blackbody", props: { intensity: 2.2 }, position: { x: 430, y: 620 } },
      { id: "shrink", type: "remap", props: { inMin: 0, inMax: 1, outMin: 0.05, outMax: 0.01 }, position: { x: 430, y: 780 } },
      {
        id: "sys",
        type: "system",
        props: {
          capacity: 1200, lifetime: 1.4, lifetimeJitter: 0.5, additive: true,
          floor: "bounce", floorY: 0, bounce: 0.35,
          geometryType: "cylinder", faceVelocity: true,
          lightCount: 2, lightIntensity: 6, lightDistance: 5,
        },
        position: { x: 720, y: 200 },
      },
    ],
    edges: [
      { source: "emit", sourceHandle: "pos", target: "sys", targetHandle: "position" },
      { source: "emit", sourceHandle: "dir", target: "vel", targetHandle: "a" },
      { source: "speed", sourceHandle: "out", target: "vel", targetHandle: "b" },
      { source: "vel", sourceHandle: "out", target: "sys", targetHandle: "velocity" },
      { source: "grav", sourceHandle: "out", target: "f1", targetHandle: "a" },
      { source: "drag", sourceHandle: "out", target: "f1", targetHandle: "b" },
      { source: "f1", sourceHandle: "out", target: "sys", targetHandle: "force" },
      { source: "heat", sourceHandle: "out", target: "glow", targetHandle: "t" },
      { source: "glow", sourceHandle: "out", target: "sys", targetHandle: "color" },
      { source: "shrink", sourceHandle: "out", target: "sys", targetHandle: "size" },
    ],
  },

  // The clearest demonstration that particles are part of the lit scene: slow
  // opaque motes, shaded by scene lights and GI, casting real shadows.
  "Dust Motes": {
    nodes: [
      { id: "emit", type: "emitBox", props: { size: [6, 4, 6] }, position: { x: -60, y: 40 } },
      { id: "drift", type: "curl", props: { frequency: 0.35, speed: 0.08, amplitude: 0.35 }, position: { x: -60, y: 240 } },
      { id: "rise", type: "vec3", props: { value: [0, 0.06, 0] }, position: { x: -60, y: 420 } },
      { id: "f1", type: "add", props: {}, position: { x: 200, y: 320 } },
      { id: "still", type: "vec3", props: { value: [0, 0, 0] }, position: { x: -60, y: 580 } },
      { id: "col", type: "color", props: { value: "#fff2d8" }, position: { x: 200, y: 560 } },
      { id: "size", type: "float", props: { value: 0.035 }, position: { x: 200, y: 690 } },
      {
        id: "sys",
        type: "system",
        props: {
          capacity: 4000, lifetime: 14, lifetimeJitter: 0.6, sizeJitter: 0.7,
          additive: false, geometryType: "sphere",
          lit: true, castShadow: true, receiveShadow: true,
        },
        position: { x: 470, y: 220 },
      },
    ],
    edges: [
      { source: "emit", sourceHandle: "pos", target: "sys", targetHandle: "position" },
      { source: "still", sourceHandle: "out", target: "sys", targetHandle: "velocity" },
      { source: "drift", sourceHandle: "out", target: "f1", targetHandle: "a" },
      { source: "rise", sourceHandle: "out", target: "f1", targetHandle: "b" },
      { source: "f1", sourceHandle: "out", target: "sys", targetHandle: "force" },
      { source: "col", sourceHandle: "out", target: "sys", targetHandle: "color" },
      { source: "size", sourceHandle: "out", target: "sys", targetHandle: "size" },
    ],
  },

  // Drifting glow points that each carry a real light — the cheapest way to see
  // particles pushing light into GI.
  Fireflies: {
    nodes: [
      { id: "emit", type: "emitBox", props: { size: [7, 2.5, 7] }, position: { x: -60, y: 40 } },
      { id: "wander", type: "curl", props: { frequency: 0.5, speed: 0.35, amplitude: 1.4 }, position: { x: -60, y: 240 } },
      { id: "still", type: "vec3", props: { value: [0, 0, 0] }, position: { x: -60, y: 430 } },
      { id: "col", type: "color", props: { value: "#c8ff6a" }, position: { x: 200, y: 300 } },
      { id: "size", type: "float", props: { value: 0.06 }, position: { x: 200, y: 430 } },
      // Per-particle phase so they don't all pulse together.
      { id: "phase", type: "pRandom", props: { seed: 7, min: 0, max: 6.28 }, position: { x: -60, y: 600 } },
      { id: "t", type: "simTime", props: {}, position: { x: -60, y: 730 } },
      { id: "beat", type: "add", props: {}, position: { x: 200, y: 660 } },
      { id: "pulse", type: "sine", props: { frequency: 0.5, amplitude: 0.5, phase: 0 }, position: { x: 430, y: 660 } },
      { id: "lift", type: "remap", props: { inMin: -0.5, inMax: 0.5, outMin: 0.05, outMax: 1 }, position: { x: 660, y: 660 } },
      {
        id: "sys",
        type: "system",
        props: {
          capacity: 200, lifetime: 9, lifetimeJitter: 0.5, additive: true,
          lightCount: 4, lightIntensity: 3, lightDistance: 4,
        },
        position: { x: 900, y: 260 },
      },
    ],
    edges: [
      { source: "emit", sourceHandle: "pos", target: "sys", targetHandle: "position" },
      { source: "still", sourceHandle: "out", target: "sys", targetHandle: "velocity" },
      { source: "wander", sourceHandle: "out", target: "sys", targetHandle: "force" },
      { source: "col", sourceHandle: "out", target: "sys", targetHandle: "color" },
      { source: "size", sourceHandle: "out", target: "sys", targetHandle: "size" },
      { source: "t", sourceHandle: "out", target: "beat", targetHandle: "a" },
      { source: "phase", sourceHandle: "out", target: "beat", targetHandle: "b" },
      { source: "beat", sourceHandle: "out", target: "pulse", targetHandle: "t" },
      { source: "pulse", sourceHandle: "out", target: "lift", targetHandle: "v" },
      { source: "lift", sourceHandle: "out", target: "sys", targetHandle: "opacity" },
    ],
  },

  // Falling streaks that stop at the floor. Also the simplest preset to point at
  // when explaining `floor: "kill"` and velocity-aligned geometry.
  Rain: {
    nodes: [
      { id: "emit", type: "emitBox", props: { size: [10, 0.2, 10] }, position: { x: -60, y: 40 } },
      { id: "fall", type: "vec3", props: { value: [0, -9, 0] }, position: { x: -60, y: 230 } },
      { id: "grav", type: "gravity", props: { vector: [0, -6, 0] }, position: { x: -60, y: 380 } },
      { id: "col", type: "color", props: { value: "#9fc7ff" }, position: { x: 200, y: 300 } },
      { id: "size", type: "float", props: { value: 0.035 }, position: { x: 200, y: 430 } },
      {
        id: "sys",
        type: "system",
        props: {
          capacity: 6000, lifetime: 2.2, lifetimeJitter: 0.2, sizeJitter: 0.2,
          additive: false, geometryType: "cylinder", faceVelocity: true,
          floor: "kill", floorY: 0, lit: true,
        },
        position: { x: 470, y: 200 },
      },
    ],
    edges: [
      { source: "emit", sourceHandle: "pos", target: "sys", targetHandle: "position" },
      { source: "fall", sourceHandle: "out", target: "sys", targetHandle: "velocity" },
      { source: "grav", sourceHandle: "out", target: "sys", targetHandle: "force" },
      { source: "col", sourceHandle: "out", target: "sys", targetHandle: "color" },
      { source: "size", sourceHandle: "out", target: "sys", targetHandle: "size" },
    ],
  },

  // Wind-driven snow that collides with the actual scene colliders instead of a
  // flat floor plane — the showcase for `sceneCollision`.
  Blizzard: {
    nodes: [
      { id: "emit", type: "emitBox", props: { size: [14, 0.5, 14] }, position: { x: -60, y: 40 } },
      { id: "drop", type: "vec3", props: { value: [0, -1.2, 0] }, position: { x: -60, y: 230 } },
      { id: "gust", type: "wind", props: { direction: [1, 0, 0.35], strength: 3.5, gustiness: 1.2, gustFrequency: 0.35 }, position: { x: -60, y: 380 } },
      { id: "tumble", type: "turbulence", props: { frequency: 0.8, strength: 1.4, speed: 0.5 }, position: { x: -60, y: 570 } },
      { id: "f1", type: "add", props: {}, position: { x: 220, y: 460 } },
      { id: "col", type: "color", props: { value: "#ffffff" }, position: { x: 220, y: 300 } },
      { id: "size", type: "float", props: { value: 0.05 }, position: { x: 220, y: 690 } },
      {
        id: "sys",
        type: "system",
        props: {
          capacity: 9000, lifetime: 7, lifetimeJitter: 0.4, sizeJitter: 0.6,
          additive: false, lit: true, receiveShadow: true,
          sceneCollision: true, collisionBounce: 0.05, collisionFriction: 0.6, collisionRadius: 0.05,
        },
        position: { x: 500, y: 220 },
      },
    ],
    edges: [
      { source: "emit", sourceHandle: "pos", target: "sys", targetHandle: "position" },
      { source: "drop", sourceHandle: "out", target: "sys", targetHandle: "velocity" },
      { source: "gust", sourceHandle: "out", target: "f1", targetHandle: "a" },
      { source: "tumble", sourceHandle: "out", target: "f1", targetHandle: "b" },
      { source: "f1", sourceHandle: "out", target: "sys", targetHandle: "force" },
      { source: "col", sourceHandle: "out", target: "sys", targetHandle: "color" },
      { source: "size", sourceHandle: "out", target: "sys", targetHandle: "size" },
    ],
  },

  // A bright short-lived flash that genuinely lights its surroundings.
  Explosion: {
    nodes: [
      { id: "emit", type: "emitSphere", props: { radius: 0.35, shell: true }, position: { x: -60, y: 40 } },
      { id: "burst", type: "float", props: { value: 9 }, position: { x: -60, y: 230 } },
      { id: "vel", type: "multiply", props: {}, position: { x: 190, y: 110 } },
      { id: "drag", type: "drag", props: { amount: 2.6 }, position: { x: -60, y: 380 } },
      { id: "up", type: "buoyancy", props: { strength: 2.2, flicker: 0.8 }, position: { x: -60, y: 530 } },
      { id: "f1", type: "add", props: {}, position: { x: 190, y: 450 } },
      { id: "cool", type: "remap", props: { inMin: 0, inMax: 0.8, outMin: 1, outMax: 0 }, position: { x: 190, y: 640 } },
      { id: "glow", type: "blackbody", props: { intensity: 3 }, position: { x: 440, y: 640 } },
      { id: "grow", type: "remap", props: { inMin: 0, inMax: 1, outMin: 0.18, outMax: 0.5 }, position: { x: 440, y: 800 } },
      { id: "fade", type: "remap", props: { inMin: 0.45, inMax: 1, outMin: 1, outMax: 0 }, position: { x: 440, y: 940 } },
      {
        id: "sys",
        type: "system",
        props: {
          capacity: 3000, lifetime: 1.1, lifetimeJitter: 0.45, sizeJitter: 0.5, additive: true,
          lightCount: 3, lightIntensity: 14, lightDistance: 9,
        },
        position: { x: 720, y: 220 },
      },
    ],
    edges: [
      { source: "emit", sourceHandle: "pos", target: "sys", targetHandle: "position" },
      { source: "emit", sourceHandle: "dir", target: "vel", targetHandle: "a" },
      { source: "burst", sourceHandle: "out", target: "vel", targetHandle: "b" },
      { source: "vel", sourceHandle: "out", target: "sys", targetHandle: "velocity" },
      { source: "drag", sourceHandle: "out", target: "f1", targetHandle: "a" },
      { source: "up", sourceHandle: "out", target: "f1", targetHandle: "b" },
      { source: "f1", sourceHandle: "out", target: "sys", targetHandle: "force" },
      { source: "cool", sourceHandle: "out", target: "glow", targetHandle: "t" },
      { source: "glow", sourceHandle: "out", target: "sys", targetHandle: "color" },
      { source: "grow", sourceHandle: "out", target: "sys", targetHandle: "size" },
      { source: "fade", sourceHandle: "out", target: "sys", targetHandle: "opacity" },
    ],
  },

  // Two emitters in one graph: a bright core ring plus a slower outer haze —
  // the multi-System-node feature, with the ring lighting the scene.
  "Portal Ring": {
    nodes: [
      { id: "emit", type: "emitCircle", props: { radius: 1.15 }, position: { x: -60, y: 40 } },
      { id: "out", type: "float", props: { value: 0.15 }, position: { x: -60, y: 220 } },
      { id: "vel", type: "multiply", props: {}, position: { x: 190, y: 110 } },
      { id: "swirl", type: "vortex", props: { center: [0, 0, 0], axis: [0, 0, 1], strength: 5, pull: 1.4 }, position: { x: -60, y: 370 } },
      { id: "ramp", type: "gradient", props: { from: "#8be9ff", to: "#5a2bff" }, position: { x: 190, y: 300 } },
      { id: "sz", type: "remap", props: { inMin: 0, inMax: 1, outMin: 0.12, outMax: 0.01 }, position: { x: 190, y: 470 } },
      {
        id: "sys",
        type: "system",
        props: {
          capacity: 6000, lifetime: 2.4, lifetimeJitter: 0.35, additive: true,
          lightCount: 2, lightIntensity: 5, lightDistance: 7,
        },
        position: { x: 470, y: 160 },
      },

      // --- outer haze (second independent branch) ---------------------------
      { id: "h_emit", type: "emitCircle", props: { radius: 1.45 }, position: { x: -60, y: 760 } },
      { id: "h_out", type: "float", props: { value: 0.4 }, position: { x: -60, y: 940 } },
      { id: "h_vel", type: "multiply", props: {}, position: { x: 190, y: 830 } },
      { id: "h_swirl", type: "vortex", props: { center: [0, 0, 0], axis: [0, 0, 1], strength: 1.6, pull: -0.5 }, position: { x: -60, y: 1090 } },
      { id: "h_col", type: "color", props: { value: "#2b1a5c" }, position: { x: 190, y: 1010 } },
      { id: "h_sz", type: "remap", props: { inMin: 0, inMax: 1, outMin: 0.25, outMax: 0.6 }, position: { x: 190, y: 1160 } },
      { id: "h_fade", type: "remap", props: { inMin: 0, inMax: 1, outMin: 0.35, outMax: 0 }, position: { x: 190, y: 1300 } },
      {
        id: "h_sys",
        type: "system",
        props: { capacity: 1500, lifetime: 3.5, lifetimeJitter: 0.5, sizeJitter: 0.5, additive: true },
        position: { x: 470, y: 900 },
      },
    ],
    edges: [
      { source: "emit", sourceHandle: "pos", target: "sys", targetHandle: "position" },
      { source: "emit", sourceHandle: "dir", target: "vel", targetHandle: "a" },
      { source: "out", sourceHandle: "out", target: "vel", targetHandle: "b" },
      { source: "vel", sourceHandle: "out", target: "sys", targetHandle: "velocity" },
      { source: "swirl", sourceHandle: "out", target: "sys", targetHandle: "force" },
      { source: "ramp", sourceHandle: "out", target: "sys", targetHandle: "color" },
      { source: "sz", sourceHandle: "out", target: "sys", targetHandle: "size" },

      { source: "h_emit", sourceHandle: "pos", target: "h_sys", targetHandle: "position" },
      { source: "h_emit", sourceHandle: "dir", target: "h_vel", targetHandle: "a" },
      { source: "h_out", sourceHandle: "out", target: "h_vel", targetHandle: "b" },
      { source: "h_vel", sourceHandle: "out", target: "h_sys", targetHandle: "velocity" },
      { source: "h_swirl", sourceHandle: "out", target: "h_sys", targetHandle: "force" },
      { source: "h_col", sourceHandle: "out", target: "h_sys", targetHandle: "color" },
      { source: "h_sz", sourceHandle: "out", target: "h_sys", targetHandle: "size" },
      { source: "h_fade", sourceHandle: "out", target: "h_sys", targetHandle: "opacity" },
    ],
  },
};
