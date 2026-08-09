// GI volume debug views — the two camera-facing volume boxes the component's
// `debugProbes` modes render from the inside.
//
// Moved off `giField.js` when the dense transport was deleted (plan §5). Both
// take the `createSrcVolume` bundle (`{ occupancyField, world, rayHitMode,
// distance }`), so neither can outlive its field or drift onto a second world
// parameterization.
//
// THE STANDING RULE FOR BOTH, inherited verbatim: a debug view that renders a
// different field than the traces do lies about the thing it exists to show.
// That is why the distance view below marches the volume's own `distance`
// closure — literally the function the shadow arms march — rather than
// re-deriving an oracle with its own `maxLevel`/`recordAware` settings.
// `three/webgpu`, not `three` — the node materials only exist on the WebGPU
// entry point, and `new THREE.MeshBasicNodeMaterial()` off the base build throws
// "is not a constructor" at RENDER time, not at import.
import * as THREE from "three/webgpu";
import { Break, Discard, Fn, If, Loop, cameraPosition, float, mix, mod, positionWorld, vec3, vec4 } from "three/tsl";
import { RayHitMode } from "./rayHit/RayHitConfig.js";
import { MAX_MACRO_STEPS } from "./rayHit/RayHitPacking.js";

/**
 * Camera ray → volume slab entry/exit, shared by both views. An outside camera
 * must start marching AT the volume, not at its own eye.
 */
function slabRange(dir, world) {
  const minV = vec3(world.min).toVar();
  const sizeV = vec3(world.size).toVar();
  const invEps = (component) => component.sign().mul(component.abs().max(1e-6));
  const bmax = minV.add(sizeV).toVar();
  const t1x = minV.x.sub(cameraPosition.x).div(invEps(dir.x));
  const t2x = bmax.x.sub(cameraPosition.x).div(invEps(dir.x));
  const t1y = minV.y.sub(cameraPosition.y).div(invEps(dir.y));
  const t2y = bmax.y.sub(cameraPosition.y).div(invEps(dir.y));
  const t1z = minV.z.sub(cameraPosition.z).div(invEps(dir.z));
  const t2z = bmax.z.sub(cameraPosition.z).div(invEps(dir.z));
  return {
    minV,
    sizeV,
    tEnter: t1x.min(t2x).max(t1y.min(t2y)).max(t1z.min(t2z)),
    tExit: t1x.max(t2x).min(t1y.max(t2y)).min(t1z.max(t2z)),
  };
}

/** The shared overlay material shell: backfaces, no depth interaction. */
function overlayMaterial() {
  const material = new THREE.MeshBasicNodeMaterial();
  material.side = THREE.BackSide;
  // The raymarch replaces the scene view entirely — scene depth would otherwise
  // occlude the box's backfaces and hide the debug.
  material.depthTest = false;
  material.depthWrite = false;
  return material;
}

/**
 * Debug "Occupancy" view: hierarchical-DDA of the occupancy pyramid, shaded by
 * the hit's own normal. The instrument for "is the geometry the GI sees the
 * geometry I placed" — missing, misplaced and one-voxel-thin pieces are all
 * immediately readable.
 */
export function createSrcOccupancyView(volume) {
  const occField = volume.occupancyField;
  const { world } = volume;
  const hybrid = volume.rayHitMode === RayHitMode.HybridBrickBox && occField.traceHybridBrick;
  // Plane modes shade by the DECODED record normal — the doc's required
  // "plane-normal visualization". Flat surfaces render flat colour instead of
  // the voxel-face quantization, which is exactly the Phase-2 acceptance look
  // (and in exact-complex mode, curved silhouettes come from real triangles).
  const plane = volume.rayHitMode >= RayHitMode.HybridPlane &&
    volume.rayHitMode <= RayHitMode.HybridExactComplex && occField.traceHybridPlane;

  const material = overlayMaterial();
  material.fragmentNode = Fn(() => {
    const dir = positionWorld.sub(cameraPosition).normalize().toVar();
    const { tEnter, tExit } = slabRange(dir, world);

    // A generous budget: this view exists to show what IS there, so it must not
    // report a hole the transport rays would not see just because it ran out of
    // iterations (the failure that made the sparse field look broken when the
    // MARCHER was starved).
    // `dynamics: "obb"` — this is a FRAGMENT shader, and the exact-dynamic
    // BVH4 traversal is compute-only by policy (its raw-WGSL storage pointer
    // is annotated for the compute kernels' binding mode). Analytic OBB
    // movers still show up in the debug view — which is the instrument for
    // "is the exact box actually where the mesh is".
    const r = plane
      ? occField.traceHybridPlane(
          cameraPosition,
          dir,
          tEnter.max(0),
          tExit.max(0),
          {
            macroSteps: MAX_MACRO_STEPS,
            coverage: volume.rayHitMode >= RayHitMode.HybridPlaneCoverage,
            exact: volume.rayHitMode === RayHitMode.HybridExactComplex,
            dynamics: "obb",
          },
        )
      : hybrid
        ? occField.traceHybridBrick(
            cameraPosition,
            dir,
            tEnter.max(0),
            tExit.max(0),
            { macroSteps: MAX_MACRO_STEPS, dynamics: "obb" },
          )
        : occField.traceOccupancy(
            cameraPosition, dir, tEnter.max(0), tExit.max(0), { steps: 256, dynamics: "obb" },
          );
    If(r.hit.lessThan(0.5), () => {
      Discard();
    });
    // Normal-coloured with a headlight lambert — a missing, misplaced or
    // one-voxel-thin piece of geometry is immediately readable.
    const lambert = r.normal.dot(dir.negate()).abs().mul(0.6).add(0.4);
    if (hybrid) {
      // Alternating macrocell tint + local 4^3 coordinates makes both levels
      // of the Phase-1 hierarchy visible. Red rises with coarse traversal
      // work, so bounded-step hot spots are apparent without GPU readback.
      const macro = r.voxel.div(4).floor().toVar();
      const parity = mod(macro.x.add(macro.y).add(macro.z), 2).toVar();
      const local = vec3(
        mod(r.voxel.x, 4), mod(r.voxel.y, 4), mod(r.voxel.z, 4),
      ).div(3).toVar();
      const base = mix(vec3(0.12, 0.32, 0.85), vec3(0.12, 0.75, 0.42), parity);
      const heat = r.macroSteps.div(MAX_MACRO_STEPS).clamp(0, 1);
      const color = mix(base, local, 0.35).add(vec3(heat.mul(0.7), 0, 0));
      return vec4(color.mul(lambert), 1);
    }
    return vec4(r.normal.mul(0.5).add(0.5).mul(lambert), 1);
  })();
  return material;
}

/**
 * Debug "Distance" view: sphere-traces the volume's distance oracle and shades
 * hits by that oracle's own gradient.
 *
 * This was the "SDF" view and it marched the composited `distanceTexture`,
 * shading from the normal the composite mirrored into `.gba`. Both are gone with
 * the transport — and §12.6 measured the texture as nothing but a low-pass of
 * this same oracle, so pointing the view at `volume.distance` shows strictly MORE
 * than it used to: no lattice resample, no fp16 step, and the sub-voxel plane
 * fits the records carry (which the composite averaged away before the shadow
 * path could see them). It is now the direct instrument for the distance the
 * soft shadows actually consume, including the deferred `capWorld` and 3×3×3
 * ladder retunes (§12.6.5).
 *
 * THE NORMAL COSTS SIX TAPS and is only taken at the hit, never per step — the
 * oracle is ~59 buffer fetches, so a per-step gradient would be ~350 fetches per
 * step and this is an overlay that replaces the frame anyway.
 */
export function createSrcDistanceView(volume) {
  const { world, distance } = volume;
  const minCell = world.minCell;
  const capWorld = world.capWorld;

  const material = overlayMaterial();
  material.fragmentNode = Fn(() => {
    // Uniform-derived values hoisted before the loop (driver compile cost).
    const minCellV = float(minCell).toVar();
    const capWorldV = float(capWorld).toVar();
    const dir = positionWorld.sub(cameraPosition).normalize().toVar();
    const { tEnter, tExit } = slabRange(dir, world);

    const t = tEnter.max(0).add(minCellV.mul(0.25)).toVar();
    const out = vec4(0, 0, 0, 0).toVar();
    Loop({ start: 0, end: 128, name: "srcDistanceDebug" }, () => {
      If(t.greaterThan(tExit), () => {
        Break();
      });
      const p = cameraPosition.add(dir.mul(t)).toVar();
      const d = distance(p, capWorldV).toVar();
      // HIT CUT AND STEP FLOOR AND ITERATION BUDGET ARE A TRIPLE, not a pair.
      // The 128-step budget is what starved this view once before: scaling the
      // cut down without raising the budget made every grazing ray run out of
      // iterations before reaching its surface, so a colonnade rendered as
      // vertical shreds with the floor intact — which reads as "the field is
      // broken" when the field was fine and the MARCHER was starved. Held at
      // the coarse path's numbers on purpose: then any difference in this view
      // is the field's accuracy, which is the thing being judged.
      const hitCut = minCellV.mul(0.4);
      If(d.lessThan(hitCut), () => {
        // Central differences on the oracle itself — half a cell each way, the
        // same h the composite's gradient used.
        const h = minCellV.mul(0.5).toVar();
        const gx = distance(p.add(vec3(h, 0, 0)), capWorldV).sub(distance(p.sub(vec3(h, 0, 0)), capWorldV));
        const gy = distance(p.add(vec3(0, h, 0)), capWorldV).sub(distance(p.sub(vec3(0, h, 0)), capWorldV));
        const gz = distance(p.add(vec3(0, 0, h)), capWorldV).sub(distance(p.sub(vec3(0, 0, h)), capWorldV));
        const g = vec3(gx, gy, gz).toVar();
        // A gradient of zero means every tap read the same value — inside a
        // solid, or a flat spot of the ladder. Fall back to the view direction
        // so the surface still reads as a surface instead of as black.
        const n = vec3(dir.negate()).toVar();
        If(g.length().greaterThan(1e-5), () => {
          n.assign(g.normalize());
        });
        // Normal-coloured surface with a headlight lambert — a missing,
        // misplaced or garbage piece of the field is immediately visible.
        const lambert = n.dot(dir.negate()).abs().mul(0.6).add(0.4);
        out.assign(vec4(n.mul(0.5).add(0.5).mul(lambert), 1));
        Break();
      });
      // Floor stays paired with the cut above (a ray whose distance lands
      // between them steps clean over the hit band and punches a hole).
      t.addAssign(d.mul(0.9).clamp(minCellV.mul(0.3), capWorldV));
    });
    If(out.w.lessThan(0.5), () => {
      Discard();
    });
    return out;
  })();
  return material;
}
