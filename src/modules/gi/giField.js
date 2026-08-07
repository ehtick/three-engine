// THE GI FIELD (formerly sdfScene.js — renamed 2026-08-02 when the mesh-SDF
// bake pipeline was deleted): the global scene field, composited on the GPU
// from the occupancy pyramid's distance oracle + the slot registry's
// analytic shapes and per-slot albedo/emissive (slotRegistry.js). Moving a mesh
// updates its slot uniforms and re-runs one compute pass (~1-2ms for the
// whole grid); the cascade transport on top is unchanged.
//
// Cell payload (same contract the cascades already consume):
//   stagingBuffer  — rgb residual emissive, w occupancy (composite output)
//   baseBuffer     — temporally blended copy (bounce feedback ingests staging)
//   radianceBuffer — live traced field (base + per-frame direct + bounce)
//   surfaceBuffer  — rgb albedo, w reliability (1 where occupied)
//   normalBuffer   — SDF-gradient normal of the nearest mesh
//   distanceTexture — Storage3DTexture rgba8: r = distance / capWorld,
//                     gba = normal·0.5+0.5; written by the composite pass,
//                     sampled with HARDWARE TRILINEAR by the traces.
import * as THREE from "three/webgpu";
import { Break, Discard, Fn, If, Loop, atomicLoad, cameraPosition, float, floor, instanceIndex, instancedArray, ivec3, mix, mod, positionWorld, select, smoothstep, step, texture3D, textureStore, uint, uniform, vec3, vec4 } from "three/tsl";
import { sharedFn } from "./giFn.js";
import { createInstanceGrid, loopCandidates } from "./instanceGrid.js";
import { createSparseField } from "./sparseField.js";
import { createTrilinearRadianceSampler } from "./voxelizeOnce.js";
import { emitterSlotFactor, emitterSurfaceT } from "./giLight.js";
import { RayHitMode } from "./rayHit/RayHitConfig.js";
import { MAX_MACRO_STEPS } from "./rayHit/RayHitPacking.js";


// The mesh-SDF baker (a dedicated worker running bakeCore) lived here until
// 2026-08-02. SDF-free mode shipped, measured better on the real scene (see
// GlobalIlluminationComponent killSdf notes), and the bake pipeline was
// deleted: bakeCore.js, bakeWorker.js, the Library/gi-sdf cache and the
// runtime-bake path are gone. The occupancy pyramid is the only geometry
// medium.
const SDF_CAP = 16;

/**
 * @param {{min: THREE.Vector3, max: THREE.Vector3}} bounds world AABB
 * @param {{x,y,z}} res global grid cells per axis
 * @param {import("./slotRegistry.js").SlotRegistry} atlas
 */
export function createGiField(bounds, res, atlas, options = {}) {
  const cellCount = res.x * res.y * res.z;
  const size = new THREE.Vector3().subVectors(bounds.max, bounds.min);
  const cell = new THREE.Vector3(size.x / res.x, size.y / res.y, size.z / res.z);
  const minCell = Math.min(cell.x, cell.y, cell.z);
  // Global field reach — everything beyond reads "far". The atlas expands
  // slot AABBs by this so AABB-rejected cells are legitimately far.
  const capWorld = SDF_CAP * minCell;
  atlas.aabbExpand = capWorld;

  // TOP-LEVEL traversal structure. Attached to the atlas so its TSL helpers
  // (`refineDetail`) can reach it, and consulted by every pass that used to
  // sweep the whole slot list. `__giNoInstanceGrid` restores the flat scans
  // for A/B — the two paths must produce the SAME field, so any difference
  // between them is a bug in here, not a quality setting.
  const grid = globalThis.__giNoInstanceGrid ? null : createInstanceGrid(atlas);
  atlas.grid = grid;

  // WORLD PARAMETERIZATION AS UNIFORMS. Every world-space constant the GI
  // shaders need (volume origin/size, cell size, distance cap) lives in
  // this bundle instead of being baked into WGSL — so an auto-fit REFIT is
  // a uniform update plus one recomposite, with ZERO shader recompiles.
  // Before this, any bounds change forced a full rebuild whose material
  // compile wave froze the viewport for 10-20s — and since scenes commonly
  // live under the GI component's entity, MOVING ANY OBJECT beyond the
  // refit tolerance triggered that wave a few seconds after the drag (the
  // "10s freeze after I release" report). Grid RESOLUTION stays a build
  // constant (dispatch sizes, buffer lengths); a refit keeps the cell
  // COUNT and rescales the cells' world size.
  const world = {
    min: uniform(bounds.min.clone()),
    size: uniform(size.clone()),
    cell: uniform(cell.clone()),
    minCell: uniform(minCell),
    cellMax: uniform(Math.max(cell.x, cell.y, cell.z)),
    capWorld: uniform(capWorld),
    // Composite dirty-brick bounds — permissive defaults mean any composite
    // that doesn't set them recomputes everything (always correct, never
    // stale).
    dirtyMin: uniform(new THREE.Vector3(-1e9, -1e9, -1e9)),
    dirtyMax: uniform(new THREE.Vector3(1e9, 1e9, 1e9)),
  };
  // Occupancy: cell centers within ~half a cell diagonal of a surface. Too
  // tight → thin slabs get single-sided shells (their one cell carries the
  // WRONG side's lighting for half the viewers) and diagonal walls get
  // DDA-tunnelable holes; too fat → shells self-shadow. 0.87 ≈ half the
  // cell diagonal keeps a shell layer on BOTH sides of thin geometry for
  // nearly all slab placements (the direction-aware DDA handles the rest).
  const occThreshold = world.minCell.mul(0.87);

  const stagingBuffer = instancedArray(new Float32Array(cellCount * 4), "vec4");
  const radianceBuffer = instancedArray(new Float32Array(cellCount * 4), "vec4");
  const baseBuffer = instancedArray(new Float32Array(cellCount * 4), "vec4");
  const surfaceBuffer = instancedArray(new Float32Array(cellCount * 4), "vec4");
  const normalBuffer = instancedArray(new Float32Array(cellCount * 4), "vec4");
  // Indirect-only field (emissive + bounce, NO analytic/emitter direct):
  // reflection hits re-evaluate direct light PER PIXEL at the exact hit
  // point (crisp), then add this for the diffuse remainder — sampling the
  // full radiance field there instead would double-count the direct term.
  const indirectBuffer = instancedArray(new Float32Array(cellCount * 4), "vec4");

  const distanceTexture = new THREE.Storage3DTexture(res.x, res.y, res.z);
  distanceTexture.format = THREE.RGBAFormat;
  // HALF FLOAT, not u8: the shadow trace turns distance error into penumbra
  // error amplified by k/t, so 8-bit distance (capWorld/255 ≈ millimetres)
  // painted visible marble/terrace bands into every soft shadow ("dirty
  // shadows"). fp16 is densest near zero — exactly where the shadow math
  // lives — and rgba16float is base-WebGPU storage-capable AND filterable.
  // ~2× texture memory (a few MB) for quantization-free traces.
  distanceTexture.type = THREE.HalfFloatType;
  distanceTexture.minFilter = THREE.LinearFilter;
  distanceTexture.magFilter = THREE.LinearFilter;

  // ------------------------------------------------ FINE level (sparse bricks)
  // The coarse field above is ~0.33m on a real scene, which is wider than the
  // columns and walls it is supposed to occlude — measured, see sparseField.js.
  // The sparse level puts a fp16 brick in every coarse cell a surface passes
  // through, so a transport ray pays ONE extra texture fetch (not a per-slot
  // loop) to get sub-decimetre occlusion. Off by default until it is proven on
  // the user's own scene: `__giSparseField = true`, or the component prop.
  const sparse = options.sparseField
    ? createSparseField(
        { res, world, cell, distanceTexture },
        atlas,
        { brickAxis: options.brickAxis, maxBricks: options.maxBricks },
      )
    : null;
  // Registered so slot edits invalidate the page table through the same path
  // that invalidates the grid — the atlas is the only thing that knows when a
  // slot moved, and it must not have to know what a brick is.
  atlas.sparse = sparse;

  // Conservative triangle occupancy, supplied by GISystem at build time (it
  // owns the mesh list). Null until then, and null forever when disabled.
  let occupancy = options.occupancy ?? null;

  // ─────────────────────────────────────── OCCUPANCY BACKEND (spec phases 1+4)
  // The conservative triangle-occupancy pyramid (occupancyField.js). When
  // present it becomes the HIT TEST for diffuse transport and the hard block
  // for shadow rays; the composited SDF above stays as the RADIANCE/albedo
  // carrier and as the distance source for the tuned soft-shadow penumbra
  // estimator, which needs a continuous distance that a bitset cannot provide.
  //
  // See createSceneTrace's note for exactly which rays moved and which did not.
  const occField = options.occupancyField ?? null;
  const rayHitMode = options.rayHitConfig?.activeMode ?? RayHitMode.OccupancyLegacy;
  // The composite's cell grid is chosen HERE, not by the pyramid (whose level-0
  // resolution is picked for tracing and is deliberately finer). Telling the
  // field about it before any graph is built is what lets the voxelizer write
  // surface attribution straight into cells this pass indexes by
  // `instanceIndex` — no resampling, no second coordinate system.
  occField?.setCoarseRes(res);
  // Pyramid level whose voxel is at least one coarse cell across. The composite
  // uses it to force `occupied` where triangles pass, so sub-cell geometry gets
  // a radiance/albedo shell instead of vanishing. CONSERVATIVE on purpose (a
  // level finer than the coarse cell would test only the cell's middle and miss
  // exactly the thin features this exists for) — and it is a genuine build
  // constant, because a refit rescales both grids from the same bounds and
  // leaves their RATIO untouched.
  const coarseLevel = occField
    ? Math.max(0, Math.min(
        occField.levels.length - 1,
        Math.ceil(Math.log2(Math.max(1, occField.res.x / res.x))),
      ))
    : 0;
  // ───────────────────────────────────────────────── SDF-FREE DISTANCE SOURCE
  // With this on, NOTHING in the lighting path reads a baked mesh SDF: the
  // composited distance comes from the occupancy pyramid's distance oracle
  // (`freeRadiusAtWorld`) instead of min-ing the per-mesh atlas slots, and the
  // shadow/mirror traces sharpen against the same oracle instead of
  // `atlas.refineDetail`. That retires the 40 MB atlas, the bake worker and the
  // `.sdf` cache — the download-size and hosted-build blockers — in one switch.
  //
  // Requires an occupancy field by construction: without one there is no other
  // distance source at all, so this silently stays off.
  // SDF-free is no longer a mode — the bake pipeline is deleted. The only
  // reason this flag survives is the (never-observed) device without an
  // occupancy field, which degrades to the legacy branches with an empty
  // atlas rather than crashing.
  const killSdf = !!occField;

  // ------------------------------------------------------------- composite
  // One thread per global cell: min all slot SDFs → distance + nearest-slot
  // surface. Runs only when atlas.revision changed (move/edit/SDF arrival).
  const compositeCompute = Fn(() => {
    const idx = instanceIndex.toFloat();
    const ix = mod(idx, res.x);
    const iy = mod(floor(idx.div(res.x)), res.y);
    const iz = floor(idx.div(res.x * res.y));
    const p = vec3(
      ix.add(0.5).mul(world.cell.x).add(world.min.x),
      iy.add(0.5).mul(world.cell.y).add(world.min.y),
      iz.add(0.5).mul(world.cell.z).add(world.min.z),
    ).toVar();

    const inDirty = p.x.greaterThanEqual(world.dirtyMin.x)
      .and(p.y.greaterThanEqual(world.dirtyMin.y))
      .and(p.z.greaterThanEqual(world.dirtyMin.z))
      .and(p.x.lessThanEqual(world.dirtyMax.x))
      .and(p.y.lessThanEqual(world.dirtyMax.y))
      .and(p.z.lessThanEqual(world.dirtyMax.z));

    If(inDirty, () => {
      const minD = float(world.capWorld).toVar();
      const best = float(-1).toVar();
      if (killSdf) {
        // THE PYRAMID IS THE DISTANCE (see `killSdf`). Every level, because
        // this is the only distance source in the build — the bound saturates
        // at `2^(levels-1) · voxel`, which the cap clamps anyway, and the
        // composite runs on change rather than per ray so it can afford them.
        // `capWorld` saturation: consumers test `d < 0.85·capWorld` to mean
        // "not open space", so the oracle has to top out where they expect.
        // See freeRadiusAtWorld's saturation note.
        minD.assign(occField.freeRadiusAtWorld(p, undefined, true, world.capWorld).min(minD));
        // ...BUT `best` STILL HAS TO BE FOUND, and it does not need an SDF.
        //
        // `best` names the slot whose mean albedo/emissive this cell carries,
        // and INDIRECT LIGHT IS ALBEDO — a cell with no albedo reflects
        // nothing, so leaving `best` at -1 here (on the theory that `cellAttr`
        // would answer it instead) produced a scene with direct light and no
        // bounce at all. `cellAttr` is a good answer when it has one, but it is
        // one unverified mechanism and this is the whole indirect term; it must
        // not be the only source.
        //
        // ATTRIBUTION IS BY NEAREST SLOT, exactly as on the SDF path — and it
        // needs no baked grid here, because in this mode EVERY slot is analytic
        // (`#buildEntries` gives any mesh without a fitted primitive a bounding
        // box), so `sampleSlot` is closed form.
        //
        // A "smallest containing AABB" heuristic was tried instead and was
        // badly wrong: `atlas.aabbExpand = capWorld` inflates every slot box by
        // ~5.6 m, so a cell in the middle of a room is inside DOZENS of them
        // and the smallest is just whichever small prop happens to be nearby.
        // On Sponza that meant the curtains and banners won almost everywhere
        // and the entire indirect term took their colour — the "all indirect
        // looks very red" report. Containment says which boxes are in range;
        // only a DISTANCE says which surface a cell belongs to.
        const bestD = float(1e30).toVar();
        loopCandidates(grid, atlas.capacity, p, (slot) => {
          const bmin = atlas.aabbMin.element(slot).toVar();
          If(bmin.w.greaterThan(0.5), () => {
            const bmax = atlas.aabbMax.element(slot);
            const inside = p.x.greaterThan(bmin.x)
              .and(p.y.greaterThan(bmin.y))
              .and(p.z.greaterThan(bmin.z))
              .and(p.x.lessThan(bmax.x))
              .and(p.y.lessThan(bmax.y))
              .and(p.z.lessThan(bmax.z));
            If(inside, () => {
              const d = atlas.sampleSlot(slot, p).toVar();
              If(d.lessThan(bestD), () => {
                bestD.assign(d);
                best.assign(slot.toFloat());
              });
            });
          });
        });

        // (Exact cellAttr attribution overrides this scan's answer below,
        // after the oracle-gradient normal is known — the shell-inheritance
        // step needs that normal.)
      } else {
        // Only the slots the grid lists for this cell — the AABB test below
        // still runs, so a conservative list costs nothing but time.
        loopCandidates(grid, atlas.capacity, p, (slot) => {
          const bmin = atlas.aabbMin.element(slot).toVar();
          If(bmin.w.greaterThan(0.5), () => {
            const bmax = atlas.aabbMax.element(slot);
            const inside = p.x.greaterThan(bmin.x)
              .and(p.y.greaterThan(bmin.y))
              .and(p.z.greaterThan(bmin.z))
              .and(p.x.lessThan(bmax.x))
              .and(p.y.lessThan(bmax.y))
              .and(p.z.lessThan(bmax.z));
            If(inside, () => {
              const d = atlas.sampleSlot(slot, p).toVar();
              If(d.lessThan(minD), () => {
                minD.assign(d);
                best.assign(slot.toFloat());
              });
            });
          });
        });
      }

      // CONSERVATIVE TRIANGLE OCCUPANCY (occupancyGrid.js). The slot SDFs
      // above are per-mesh grids whose cells are 0.4–0.6m on a real building,
      // so anything smaller than that — a column, a curtain, a moulding — is
      // already gone from `minD` before this line. The occupancy bitset is
      // rasterized straight from triangles, so it still has them.
      //
      // Where it says "solid", the distance is FORCED to zero. That cannot
      // make the field leak more (zero is the smallest a distance can be, so
      // every sphere-traced step gets shorter, never longer) and it puts back
      // exactly the geometry the resampling chain dropped.
      if (occupancy) {
        const occ = texture3D(
          occupancy.texture,
          vec3(ix.add(0.5).div(res.x), iy.add(0.5).div(res.y), iz.add(0.5).div(res.z)),
        ).level(0).r;
        minD.assign(select(occ.greaterThan(0.5), float(0), minD));
      }
      // Same clamp, from the SAT-conservative pyramid rather than the CPU
      // prototype's point-sampled grid. This is what gives a sub-cell column a
      // radiance/albedo shell in the coarse field: without it the column would
      // BLOCK light (the DDA sees it) while emitting nothing and reading black.
      if (occField) {
        minD.assign(select(occField.occupiedAtWorld(p, coarseLevel).greaterThan(0.5), float(0), minD));
      }
      const occupied = step(minD, occThreshold).toVar();
      const albedo = vec3(0).toVar();
      const emissive = vec3(0).toVar();
      const normal = vec3(0, 1, 0).toVar();
      // SDF-FREE: no slot field to take a gradient of, so use the DISTANCE
      // ORACLE's gradient instead. It is a real continuous distance now (see
      // freeRadiusAtWorld's near field), so its gradient points AWAY from the
      // surface exactly like the SDF's did — deterministic, and two-sided by
      // construction rather than a coin flip between a slab's two faces.
      // Runs BEFORE the attribution override below, which walks one cell
      // along −normal to find the surface a SHELL cell belongs to.
      //
      // STEP SIZE IS A FULL COARSE CELL, not half. Sampling a binary occupancy
      // indicator at ±½ cell put both taps inside the same voxel wherever the
      // occupancy voxel was coarser than that (0.25 m at the low tier against a
      // 0.175 m half-cell), so the gradient read ZERO, every cell fell back to
      // the (0,1,0) default, and the one-sided bounce gather lit almost nothing
      // — a scene with direct light and no indirect at all.
      if (killSdf && occField) {
        If(occupied.greaterThan(0.5), () => {
          const h = world.minCell;
          // maxLevel 2 so the oracle can report up to ~4 voxels: at maxLevel 1
          // it tops out around 0.25 m, and BOTH taps of a ±0.35 m stencil
          // saturate there, which is a zero gradient for a perfectly ordinary
          // cell.
          const at = (o) => occField.freeRadiusAtWorld(p.add(o), 2);
          const g = vec3(
            at(vec3(h, 0, 0)).sub(at(vec3(h.negate(), 0, 0))),
            at(vec3(0, h, 0)).sub(at(vec3(0, h.negate(), 0))),
            at(vec3(0, 0, h)).sub(at(vec3(0, 0, h.negate()))),
          ).toVar();
          // AMBIGUOUS ⇒ NO DIRECT LIGHT, rather than a guessed normal.
          //
          // A zero gradient means the cell is deep enough inside geometry that
          // both taps read the same — a slab INTERIOR cell. There is no right
          // normal for it, and every wrong answer is a light source: the
          // voxelizer's own face normal (the obvious fallback) races between a
          // slab's two faces, so a floor's interior cells take -Y half the time
          // and the floor lights up from a sun BELOW it. A constant up-vector
          // is the same bug pointing the other way.
          //
          // A zero normal makes `dot(dir, normal).max(0)` zero in the bounce
          // gather, so the cell takes no direct light at all while still
          // carrying its albedo for bounce. That is the honest answer for a
          // point inside a wall.
          If(g.length().greaterThan(1e-5), () => {
            normal.assign(g.normalize());
          }).Else(() => {
            normal.assign(vec3(0));
          });
        });
      }
      // EXACT ATTRIBUTION OVERRIDE — COLOURS ONLY, killSdf mode. The nearest-
      // slot scan above ties at 0 for every slot whose analytic box CONTAINS
      // the cell (box distance is clamped to 0 inside, see #sampleSlotBody),
      // and a building-scale mesh's box contains nearly every cell — so
      // `best` degenerated to candidate order, the whole field took one
      // mesh's mean albedo, and colour bleed died (the post-occupancy "no
      // colour bleed" report). `cellAttr.x` is an ATLAS slot + 1 — the
      // voxelizer applies the occupancy→atlas numbering bridge (slotAtlas,
      // GISystem-maintained) at WRITE time, because binding the remap array
      // here was one uniform buffer past this kernel's 12-per-stage device
      // limit and dropped the whole compute batch.
      //
      // SHELL CELLS INHERIT THE SURFACE THEY SHELL. A cell with no triangle
      // (attr 0) can still be occupied: anything within occThreshold of a
      // surface is a per-side SHELL layer, and the shells are what actually
      // BOUNCE — a sheet's own cells read a zero oracle gradient, take no
      // direct light, and re-emit nothing (by design, see the normal note
      // above). Left to the scan, a shell took the nearest analytic BOX's
      // mean albedo — so the sunlit shell of a red curtain bounced BEIGE,
      // which is why fixing in-cell attribution alone doubled measured
      // chroma yet left the curtain→floor pools missing. The surface a shell
      // belongs to sits one cell along −normal (the oracle gradient points
      // away from geometry); inherit that cell's attribution.
      // The NORMAL never comes from cellAttr (last-write-wins race — see the
      // block comment below).
      // Build-time hatch: __giNoAttrColors (evaluateOnNewDocument / HATCH=
      // only — a console set after load does nothing, Round 11 rule).
      if (killSdf && occField && !globalThis.__giNoAttrColors) {
        // `cellAttr` is an ATOMIC u32 buffer (deterministic atomicMax winner
        // — see occupancyField); an atomic binding read without atomicLoad is
        // a WGSL type error that silently drops the whole compute batch.
        const attr = atomicLoad(occField.cellAttr.element(instanceIndex)).toVar();
        If(attr.greaterThan(uint(0)), () => {
          best.assign(attr.toFloat().sub(1));
        }).ElseIf(occupied.greaterThan(0.5).and(normal.length().greaterThan(1e-5)), () => {
          const q = p.sub(normal.mul(vec3(world.cell.x, world.cell.y, world.cell.z)));
          const qx = q.x.sub(world.min.x).div(world.cell.x).floor().clamp(0, res.x - 1);
          const qy = q.y.sub(world.min.y).div(world.cell.y).floor().clamp(0, res.y - 1);
          const qz = q.z.sub(world.min.z).div(world.cell.z).floor().clamp(0, res.z - 1);
          const attrNear = atomicLoad(
            occField.cellAttr.element(qz.mul(res.y).add(qy).mul(res.x).add(qx).toInt()),
          ).toVar();
          If(attrNear.greaterThan(uint(0)), () => {
            best.assign(attrNear.toFloat().sub(1));
          });
        });
      }
      // SURFACE ATTRIBUTION FROM OCCUPANCY, when the field can supply it.
      //
      // This is the step that lets the mesh-SDF atlas be deleted. The atlas was
      // never consulted here for its DISTANCE — `best` is just "which slot is
      // nearest", used to look up that slot's MEAN albedo/emissive, and the six
      // extra taps below are a gradient normal. The occupancy voxelizer already
      // knows both exactly (it visits every triangle/voxel pair and has the
      // face normal), so it writes them per coarse cell and this reads them.
      //
      // It also answers a question the SDF answered badly: a slot whose blurred
      // field happens to be nearest is not necessarily the surface IN the cell,
      // whereas an attributed cell was written by a triangle that provably
      // overlaps it.
      //
      // `attr.x` is slot + 1, so 0 means "no triangle touched this cell" and
      // the SDF path below still supplies the colours.
      //
      // COLOURS ONLY — NOT THE NORMAL, and this is the important part.
      // `cellAttr` is written by the voxelizer as LAST WRITE WINS with no
      // atomics, which is harmless for a per-slot MEAN colour (any triangle in
      // the cell gives the same answer) and actively wrong for a face normal.
      // A floor slab's top face (+Y) and bottom face (−Y) land in the SAME
      // coarse cell, so the stored normal is whichever triangle won a race —
      // and the bounce gather is deliberately ONE-SIDED (`dot(dir, normal)`
      // clamped at 0, see cascadeGather's note) precisely so a wall's outside
      // shell cannot be lit from inside the room. A cell that raced to −Y takes
      // light from a sun BELOW the floor: the floor glows from underneath, and
      // it flips whenever the voxelizer redispatches and re-runs the race.
      // Coarser cells hold both faces more often, which is why it worsens at
      // the lower quality tiers.
      // `cellAttr` colours are back in use ABOVE via the slotAtlas remap
      // (killSdf mode only); the normal is still never read from it. Both were
      // bugs, and both are worth naming so this is never re-wired:
      //   · COLOURS crossed two slot numberings. `cellAttr.x` is
      //     `occupancySlot + 1`, an index into the OCCUPANCY field's
      //     `placements` (numbered over the mesh walk), while `atlas.albedo` is
      //     indexed by ATLAS slot, which `#syncSlots` assigns independently by
      //     capacity and priority. It read a different mesh's colour, or an
      //     inactive slot's black. Colours come from `best` — atlas space,
      //     correct by construction.
      //   · THE NORMAL was written last-write-wins with no atomics, so a floor
      //     slab's cell holds whichever of its +Y top face and -Y bottom face
      //     won a race, and a cell that raced to -Y takes light from a sun
      //     BELOW the floor. Both modes take the normal from a GRADIENT instead
      //     (the SDF slot field, or the occupancy distance oracle).
      If(best.greaterThanEqual(0), () => {
        const s = best.toInt();
        albedo.assign(atlas.albedo.element(s).xyz);
        emissive.assign(atlas.emissive.element(s).xyz);
        // SDF-gradient normal of the winning slot (6 taps) — only where the
        // cell is occupied; empty cells never feed the bounce gather. Runs
        // whether or not occupancy attributed the colours: a gradient is a
        // property of the FIELD around the cell, so a thin slab gets an
        // outward-facing shell on each side instead of one coin-flip normal.
        if (!killSdf) {
          If(occupied.greaterThan(0.5), () => {
            const h = world.minCell.mul(0.5);
            const gx = atlas.sampleSlot(s, p.add(vec3(h, 0, 0))).sub(atlas.sampleSlot(s, p.sub(vec3(h, 0, 0))));
            const gy = atlas.sampleSlot(s, p.add(vec3(0, h, 0))).sub(atlas.sampleSlot(s, p.sub(vec3(0, h, 0))));
            const gz = atlas.sampleSlot(s, p.add(vec3(0, 0, h))).sub(atlas.sampleSlot(s, p.sub(vec3(0, 0, h))));
            const g = vec3(gx, gy, gz).toVar();
            If(g.length().greaterThan(1e-5), () => {
              normal.assign(g.normalize());
            });
          });
        }
      });
      stagingBuffer.element(instanceIndex).assign(vec4(emissive.mul(occupied), occupied));
      surfaceBuffer.element(instanceIndex).assign(vec4(albedo, occupied));
      normalBuffer.element(instanceIndex).assign(vec4(normal, 0));
      textureStore(
        distanceTexture,
        ivec3(ix.toInt(), iy.toInt(), iz.toInt()),
        vec4(minD.div(world.capWorld).clamp(0, 1), normal.mul(0.5).add(0.5)),
      );
    });
  })().compute(cellCount);

  return {
    res,
    bounds,
    cell,
    minCell,
    capWorld,
    world,
    atlas,
    grid,
    sparse,
    occupancy,
    occupancyField: occField,
    coarseLevel,

    /**
     * Re-pages the fine level if any slot moved. Returns true when the page
     * table changed, which is the caller's signal that `sparse.fillCompute`
     * has to run before anything traces.
     */
    updateSparse() {
      return sparse ? sparse.allocate() : false;
    },

    /**
     * Refreshes the top-level candidate lists if any slot moved. MUST run
     * before the composite dispatch — the composite reads the lists to decide
     * what it is allowed to skip, so a stale list is a stale field.
     * Returns true when the lists actually changed.
     */
    updateGrid() {
      return grid ? grid.update(bounds) : false;
    },

    /**
     * In-place volume refit: rescales the SAME cell grid to new world
     * bounds via the uniform bundle — no shader touches, no recompiles.
     * The caller must force a recomposite afterwards (atlas.refreshAllSlots
     * — slot AABBs embed the old aabbExpand and unmoved meshes would
     * otherwise keep it).
     */
    setBounds(next) {
      bounds.min.copy(next.min);
      bounds.max.copy(next.max);
      size.subVectors(bounds.max, bounds.min);
      cell.set(size.x / res.x, size.y / res.y, size.z / res.z);
      this.minCell = Math.min(cell.x, cell.y, cell.z);
      this.capWorld = SDF_CAP * this.minCell;
      atlas.aabbExpand = this.capWorld;
      world.min.value.copy(bounds.min);
      world.size.value.copy(size);
      world.cell.value.copy(cell);
      world.minCell.value = this.minCell;
      world.cellMax.value = Math.max(cell.x, cell.y, cell.z);
      world.capWorld.value = this.capWorld;
      // Every cell of the top-level grid just changed world size, and the
      // slot AABBs are about to be re-expanded by the new cap.
      grid?.invalidate();
      // Same for the fine level: its bricks are indexed BY COARSE CELL, and
      // every coarse cell just moved and resized.
      sparse?.invalidate();
      if (sparse) sparse.params.band.value = this.minCell * 1.5;
      // The occupancy pyramid shares `world.min`/`world.size`, so its shaders
      // need no touching — but its voxel SIZE is derived, not uniform-shared,
      // and every bit in it was rasterized against the old bounds.
      occField?.refit();
    },
    stats: { occupiedCells: -1, emissiveCells: -1, cellCount },
    stagingBuffer,
    baseBuffer,
    radianceBuffer,
    surfaceBuffer,
    normalBuffer,
    rayHitMode,
    indirectBuffer,
    distanceTexture,
    compositeCompute,

    /** GPU→CPU occupancy count (diagnostics/harness only — one readback). */
    async readbackStats(renderer) {
      // A buffer that no dispatched compute has touched yet has NO GPU-side
      // allocation, and three's getArrayBufferAsync throws "reading 'size'"
      // on it (uncaught, it spams every tick). The spawn-blink guard made
      // that state ordinary: bail ticks defer the composite chain while its
      // fresh pipelines compile, so a diagnostics readback can outrun the
      // first real dispatch. Diagnostics must never throw into the frame
      // loop — report "not ready" instead.
      let raw;
      try {
        raw = await renderer.getArrayBufferAsync(stagingBuffer.value);
      } catch {
        return this.stats;
      }
      const data = new Float32Array(raw);
      let occupiedCells = 0;
      let emissiveCells = 0;
      for (let i = 0; i < cellCount; i++) {
        if (data[i * 4 + 3] > 0.5) {
          occupiedCells++;
          if (data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2] > 1e-4) emissiveCells++;
        }
      }
      Object.assign(this.stats, { occupiedCells, emissiveCells });
      return this.stats;
    },

    dispose() {
      distanceTexture.dispose();
      atlas.texture.dispose();
      sparse?.dispose();
      occupancy?.dispose();
    },

    // TRANSPORT RAYS — the ones the leak lives on.
    //
    // With the occupancy backend these are a HIERARCHICAL DDA over conservative
    // triangle occupancy: hits come from a level-0 bit and nothing else, so a
    // 0.5m column in a 0.33m field is present instead of melted, and the
    // 0.125m voxel resolves the two faces of a 0.2m wall. This is the path that
    // deliberately did NO detail refinement (6 extra SDF fetches per step
    // quadrupled the frame, 8.3 → 33ms), which is precisely why diffuse GI saw
    // only the coarse blobs while shadows and mirrors saw sub-cell geometry.
    //
    // Without it, the legacy sphere trace of the composited SDF (+ sparse
    // bricks) — unchanged.
    // `dynamicShade` ({ lightSlots, ambient }) is uniforms only — no storage
    // binding, so the composed cascade kernels stay under the portable 8.
    createSceneTrace: (dynamicShade = null) => {
      const sampler = createTrilinearRadianceSampler(
        radianceBuffer, { min: world.min }, res, world.cell, normalBuffer,
      );
      return occField
        ? createOccupancySceneTrace(occField, world, sampler, 64, rayHitMode, dynamicShade)
        : createGiFieldTrace(distanceTexture, world, res, atlas, sampler, sparse);
    },
    createRadianceSampler: () => createTrilinearRadianceSampler(radianceBuffer, { min: world.min }, res, world.cell),
    createIndirectSampler: () => createTrilinearRadianceSampler(indirectBuffer, { min: world.min }, res, world.cell),
    // `name` only labels the emitted WGSL function (readability in dumps) —
    // every instance gets a layout now, per shader (giFn.js).
    // SHADOW RAYS keep the distance-based penumbra estimator — min(k·d/t) with
    // closest-approach interpolation needs a CONTINUOUS distance, and a bitset
    // has none. What the occupancy field replaces here is only the HARD BLOCK:
    // the safety net for walls thinner than a coarse cell, which used to test
    // the coarse `stagingBuffer` occupancy (same 0.33m cells that lost the wall
    // in the first place) and now tests a 0.125m conservative voxel.
    // RECORD-AWARE SHADOW DISTANCE (Phase 5) is decided here, once, and folded
    // into the trace's WGSL. `hasSurfaceRecords` is the correct signal rather
    // than `rayHitMode`: records exist only under a plane-family mode anyway,
    // and this is the property the oracle actually needs — whether there is
    // anything in the `bits` tail to read.
    // Both halves of the kill switch: `enableShadowRecords` carries the
    // component prop (and the global, which resolveRayHitConfig already folds
    // in), and the raw global is read again so a harness that flips it AFTER
    // the config was resolved still takes effect. Default ON either way.
    createSoftShadowTrace: (lift, steps, name = undefined, stable = false) => {
      const recordAware = occField?.hasSurfaceRecords === true && killSdf &&
        globalThis.__giRayHitShadowRecords !== false &&
        options.rayHitConfig?.enableShadowRecords !== false;
      return createShadowTrace(distanceTexture, world, res, lift, atlas, steps, stagingBuffer, name, sparse, occField, killSdf, stable, recordAware);
    },
    // The analytic mid-field width term (docs/GI_SHADOWS_PLAN.md §5, behind
    // `__giShadowAnalyticWidth`) — see createWidthProbeFn. Each caller gets
    // its own instance; sharedFn keeps it one WGSL function per shader.
    createWidthProbe: (name = undefined) => createWidthProbeFn(distanceTexture, world, occField, name),
    // MIRROR RAYS stay on the sphere trace deliberately. They were a voxel DDA
    // once and moved OFF it because binary cells give stair-stepped hit
    // silhouettes where continuous distance gives smooth ones — and the spec's
    // own non-goals exclude sharp reflections through the voxel field.
    createMirrorTrace: (steps) => createMirrorTrace(distanceTexture, world, res, atlas, steps, sparse, killSdf ? occField : null),
    createHitSurfaceFn: () => createHitSurfaceFn(atlas, world.minCell),
  };
}

/**
 * Resolves the mesh surface under a reflection-ray HIT point: nearest slot
 * by SDF (world-AABB pre-reject), its constant albedo, and a crisp normal
 * from the slot SDF's gradient. `valid` = 0 when no slot covers the point
 * (SDF still baking) — callers fall back to the field sample. Runs per
 * MIRROR PIXEL only, after the trace — not per step.
 */
function createHitSurfaceFn(atlas, minCellNode) {
  return (p) => {
    const bestD = float(1e5).toVar();
    const best = float(-1).toVar();
    loopCandidates(atlas.grid, atlas.capacity, p, (hitSlot) => {
      const bmin = atlas.aabbMin.element(hitSlot).toVar();
      If(bmin.w.greaterThan(0.5), () => {
        const bmax = atlas.aabbMax.element(hitSlot);
        const inside = p.x.greaterThan(bmin.x)
          .and(p.y.greaterThan(bmin.y))
          .and(p.z.greaterThan(bmin.z))
          .and(p.x.lessThan(bmax.x))
          .and(p.y.lessThan(bmax.y))
          .and(p.z.lessThan(bmax.z));
        If(inside, () => {
          const d = atlas.sampleSlot(hitSlot, p).toVar();
          If(d.lessThan(bestD), () => {
            bestD.assign(d);
            best.assign(hitSlot.toFloat());
          });
        });
      });
    });
    const albedo = vec3(0.5).toVar();
    const normal = vec3(0, 1, 0).toVar();
    const valid = float(0).toVar();
    If(best.greaterThanEqual(0), () => {
      const s = best.toInt();
      albedo.assign(atlas.albedo.element(s).xyz);
      const h = float(minCellNode).mul(0.5);
      const gx = atlas.sampleSlot(s, p.add(vec3(h, 0, 0))).sub(atlas.sampleSlot(s, p.sub(vec3(h, 0, 0))));
      const gy = atlas.sampleSlot(s, p.add(vec3(0, h, 0))).sub(atlas.sampleSlot(s, p.sub(vec3(0, h, 0))));
      const gz = atlas.sampleSlot(s, p.add(vec3(0, 0, h))).sub(atlas.sampleSlot(s, p.sub(vec3(0, 0, h))));
      const g = vec3(gx, gy, gz).toVar();
      If(g.length().greaterThan(1e-5), () => {
        normal.assign(g.normalize());
        valid.assign(1);
      });
    });
    return { albedo, normal, valid };
  };
}

/**
 * ANALYTIC MID-FIELD PENUMBRA WIDTH (docs/GI_SHADOWS_PLAN.md §5 — the
 * deterministic soft-shadow arm, behind `__giShadowAnalyticWidth`).
 *
 * The record march's own cone term (`pen`) only sees geometry within ~1–2
 * occupancy voxels of the ray — planes are tested in cells the ray ENTERS
 * and the near-field oracle reaches ~1.5 voxels — so penumbras wider than a
 * couple of voxels are unrepresentable and the stochastic sun-disc jitter
 * existed solely to fill that mid-range hole. This term IS that missing
 * mid-range oracle: min over ~12 log-spaced ray points of k·D(p)/t, where D
 * is the composited `distanceTexture` (trilinear, fp16, reach capWorld ≈
 * 16 field cells ≈ metres) — the same estimator family as Unreal's
 * distance-field shadows, and the reason those are famously stable under a
 * dragged sun: every term is deterministic, so each frame is already the
 * converged answer and there is no convergence process to disturb.
 *
 * WIDTH ONLY, NEVER ADMISSION — the invariant that evades both recorded
 * analytic-arm failures (the density cone's density≠opacity leaks/blacks
 * and the session-24 sphere arm's lattice-phase speckle, GISystem.js
 * ~1902-2034): the factor multiplies the record march's verdict and lives
 * in [0,1], so a melty or coarse D can only soften a penumbra — it can
 * never open the umbra (admission stays with the records) and it saturates
 * lit wherever D reads far (the `capCut` gate below, same 0.85·capWorld
 * saturation test createShadowTrace uses — without it every sample beyond
 * t ≈ k·capWorld would "occlude" and carve a hard light sphere).
 *
 * The receiver's own surface is excluded the way createShadowTrace does it:
 * a sample only counts when D reads decisively closer than the sample's
 * height above the receiver plane (`lift + t·cos`), with the tolerance
 * sized off the OCCUPANCY voxel (the medium that quantizes D near
 * surfaces) — the hugging-ray case a plain distance test gets wrong.
 *
 * `__giShadowWidthTaps` overrides the tap count (build-time, default 12).
 */
function createWidthProbeFn(distanceTexture, world, occField, name = "giShadowWidthProbe") {
  const TAPS = Math.max(4, Math.min(24, Number(globalThis.__giShadowWidthTaps) || 12));
  return sharedFn({
    name,
    type: "float",
    inputs: [
      { name: "origin", type: "vec3" },
      { name: "dir", type: "vec3" },
      { name: "tStart", type: "float" },
      { name: "maxT", type: "float" },
      { name: "k", type: "float" },
      { name: "cosRayNormal", type: "float" },
      { name: "lift", type: "float" },
    ],
    body: (origin, dir, tStart, maxT, k, cosRayNormal, lift) => {
      const minV = vec3(world.min).toVar();
      const sizeInvV = vec3(1).div(world.size).toVar();
      const capWorldV = float(world.capWorld).toVar();
      const capCut = capWorldV.mul(0.85).toVar();
      const minCellV = float(world.minCell).toVar();
      // Same own-plane tolerance createShadowTrace derived for the hugging-
      // ray case: up to a voxel of SAT bulge + ~half a coarse cell of
      // trilinear undershoot on the receiver's floor.
      const occVox = occField?.voxel
        ? vec3(occField.voxel).x.max(vec3(occField.voxel).y).max(vec3(occField.voxel).z).toVar()
        : null;
      // 3.5 voxels, deliberately WIDER than createShadowTrace's 2.5: the
      // probe rig's blocky residual showed the composited D undershoots a
      // big flat receiver by up to ~3 voxels (SAT bulge + trilinear over
      // coarse cells + fp16), and a hugging ray lives at that margin for
      // its whole length. Contact-scale width below ~4 voxels is the
      // MARCH's near-field pen term's job anyway — the probe is strictly
      // the mid-field.
      const planeCut = (occVox ? minCellV.mul(1.0).max(occVox.mul(3.5)) : minCellV.mul(0.75)).toVar();
      const width = float(1).toVar();
      // DEBUG (`__giWidthProbeDebugTap`, build-time): paint the ARGMIN tap
      // index instead of the width — dark = the darkening happened at an
      // early tap (receiver-proximal), light grey = late (lamp-proximal),
      // white = the probe left the ray alone. The instrument that locates
      // WHERE along rays a false darkening lives.
      const dbgTap = globalThis.__giWidthProbeDebugTap === true;
      const bestIdx = dbgTap ? float(1).toVar() : null;
      // Log-spaced t_i in [tStart, maxT]: constant ratio per tap, so near
      // taps resolve contact-scale width and far taps cover metres. The
      // spacing is FIXED (no jitter of any kind) — determinism is the point.
      const t0 = tStart.max(minCellV.mul(0.5)).toVar();
      const ratio = maxT.div(t0).max(1.0001).pow(1 / (TAPS - 1)).toVar();
      const t = t0.toVar();
      for (let i = 0; i < TAPS; i++) {
        const p = origin.add(dir.mul(t)).toVar();
        const uvw = p.sub(minV).mul(sizeInvV).toVar();
        // Outside the volume D is undefined — saturate lit; the record
        // march (which owns admission) already clamps to the volume slab.
        const inBounds = uvw.x.greaterThanEqual(0).and(uvw.y.greaterThanEqual(0)).and(uvw.z.greaterThanEqual(0))
          .and(uvw.x.lessThanEqual(1)).and(uvw.y.lessThanEqual(1)).and(uvw.z.lessThanEqual(1));
        // Hardware trilinear; explicit level — implicit-derivative sampling
        // inside unrolled bodies is illegal WGSL in compute.
        const d = texture3D(distanceTexture, uvw).level(0).r.mul(capWorldV).toVar();
        // Own-plane exclusion needs BOTH an absolute and a PROPORTIONAL
        // margin. On a grazing ray hugging its receiver (the common case
        // for a low panel emitter lighting a floor), D ≈ planeHeight for
        // the ENTIRE ray — the absolute cut alone leaves the threshold
        // inside D's quantization noise band (SAT bulge + trilinear
        // undershoot ≈ 0.2m) forever, so admission flipped with lattice
        // phase and, at emitter k as low as 1.2, each admitted sample read
        // k·d/t ≈ 0: the whole floor went near-black in a waffle-grid
        // pattern (the emissive probe's PNG; probe-off A/B was clean).
        // Requiring d < 0.6·planeHeight gives headroom that GROWS with
        // hugging height, so the far field is unconditionally clean, while
        // real occluders — laterally close to the ray but well under its
        // receiver-plane height — still register. 0.6, not 0.75: the probe
        // rig measured D's relative undershoot over a hugging ray at
        // 25-30% (far-floor grey landed at exactly k·0.75h/t), so the
        // factor must sit below ~0.7 to clear the noise band; what it
        // costs is probe WIDTH from occluders within 40% of the ray's
        // receiver-plane height — admission of those stays with the march.
        const planeHeight = lift.add(t.mul(cosRayNormal));
        const counts = inBounds
          .and(d.lessThan(capCut))
          .and(d.lessThan(planeHeight.sub(planeCut)))
          .and(d.lessThan(planeHeight.mul(0.6)))
          .and(t.lessThan(maxT));
        const cand = k.mul(d).div(t.max(1e-4)).clamp(0, 1);
        const candEff = select(counts, cand, float(1)).toVar();
        if (dbgTap) bestIdx.assign(select(candEff.lessThan(width), float(i / (TAPS - 1)), bestIdx));
        width.assign(width.min(candEff));
        if (i < TAPS - 1) t.mulAssign(ratio);
      }
      if (dbgTap) return select(width.lessThan(0.95), bestIdx.mul(0.7).add(0.15), float(1));
      return width;
    },
  });
}

/**
 * SDF sphere-traced soft shadow over the COMPOSITED global field +
 * per-step DETAIL-slot refinement: (origin, dir, maxT, k, cosRayNormal) →
 * penumbra in [0, 1] via min(k·d/t). Same estimator battle-tested on the
 * CPU-baked field (plane-aware self-exclusion, small contact cut, stepping
 * safety factor) — only the field source changed.
 */
// `stable = true` — THE MOVING-LIGHT FLICKER FIX (2026-08-02), used by the
// FEEDBACK trace only. The field injection re-evaluates this trace for every
// occupied cell every frame with a smoothly rotating sun, and the standard
// estimator is DISCONTINUOUS in the ray direction in three places: the binary
// contact break (`penumbra = 0` the moment a sample dips under contactCut), the
// binary occupancy hard block, and the oracle refinement — whose far-field
// ladder is quantized to `2^L·voxel` values and whose on/off gate is a hard
// threshold. Groups of cells whose rays graze the same occluder edge (the
// skylight rim, an arch) cross those thresholds together as the sun turns, so
// whole regions of indirect light stepped bright↔dark over a few frames —
// user-confirmed as THE flicker (forcing shadows fully open stopped it dead).
// Stable mode replaces every one of those verdicts with a continuous ramp:
//   · refinement = smooth blend toward the oracle's NEAR FIELD ONLY, which is
//     genuinely continuous (distance to voxel AABBs — see freeRadiusAtWorld);
//     the quantized far ladder is never consulted;
//   · occlusion = min over samples of k·d/t weighted by smooth own-plane and
//     cap-saturation ramps — the same exclusions isRealOccluder encodes, made
//     continuous — reaching an exact 0 where geometry truly is.
// Receiver-side traces (emitter shadows, mirror hits) keep the sharp estimator:
// they are visually direct and their inputs don't sweep every frame.
// `recordAware = true` — RECORD-AWARE SHADOW DISTANCE (2026-08-04). The oracle's
// near field measures distance to occupied VOXEL AABBs, so its isosurface is a
// staircase of boxes and the penumbra it feeds steps in voxel-sized blocks along
// a shadow edge ("squarish light changes"). Where the occupied neighbour carries
// a fitted SIMPLE plane record, the oracle reports the plane distance instead —
// same bits buffer, no new binding, still conservative (see freeRadiusAtWorld).
// Only the SHADOW oracle takes it: the composite, the AO taps and the mirror
// trace keep the byte-identical pre-Phase-5 function.
function createShadowTrace(distanceTexture, world, res, lift, atlas, steps = 56, occupancy = null, name = "giShadowTrace", sparse = null, occField = null, killSdf = false, stable = false, recordAware = false) {
  const minCell = world.minCell;
  const capWorld = world.capWorld;
  // `lift` may be a plain number or a TSL node (GISystem passes uniform-
  // derived nodes so a refit rescales the lift with the cells).
  const liftWorld = lift == null ? minCell.mul(2) : float(lift);

  // ONE WGSL function per trace config PER SHADER (sharedFn — see giFn.js).
  // Materials call this up to 8 times (4 emitter slots + 4 mirror-hit slots);
  // inlining the ~56-step loop body — each with its own inlined detail-slot
  // refinement — at every call site made every material's shader enormous,
  // the dominant cost of the seconds-long compile waves on init/rebuild.
  // excludeRadius < 0 disables the light-source self-exclusion (the length
  // test is then trivially true).
  // excludeHalf.x >= 0 switches the exclusion region from the sphere to an
  // ORIENTED BOX (the lamp's OBB dilated by excludeRadius). A big panel
  // lamp's bounding SPHERE swallowed every wall within ~1.5× its radius —
  // those walls stopped occluding, pouring a circular spot of light through
  // ceilings into the room above, and the sphere's boundary painted a
  // visible ring into the lamp's own pool ("dirty shadows").
  const traceFn = sharedFn({
    name,
    type: "float",
    inputs: [
      { name: "origin", type: "vec3" },
      { name: "dir", type: "vec3" },
      { name: "maxT", type: "float" },
      { name: "k", type: "float" },
      { name: "cosRayNormal", type: "float" },
      { name: "excludeCenter", type: "vec3" },
      { name: "excludeRadius", type: "float" },
      { name: "excludeHalf", type: "vec3" },
      { name: "excludeBx", type: "vec3" },
      { name: "excludeBy", type: "vec3" },
      { name: "excludeBz", type: "vec3" },
    ],
    body: (origin, dir, maxT, k, cosRayNormal, excludeCenter, excludeRadius, excludeHalf, excludeBx, excludeBy, excludeBz) => {
      // HOIST all uniform-derived scalars into locals BEFORE the loop. The
      // D3D shader compiler is drastically slower optimizing a long sphere-
      // trace loop whose operands are uniform-buffer loads than one reading
      // function-local values (measured: 3 pipelines 6.5s+2.2s+1.8s vs ~1s
      // total with baked constants) — a `var` copy up front restores nearly
      // all of it while keeping the values refit-live.
      const minCellV = float(minCell).toVar();
      const capWorldV = float(capWorld).toVar();
      const minV = vec3(world.min).toVar();
      const sizeInvV = vec3(1).div(world.size).toVar();
      const cellV = vec3(world.cell).toVar();
      // ── SELF-EXCLUSION MUST TRACK THE MEDIUM THAT TRACES THE RAY ────────────
      // Round 6's rule, applied to the one trace that never got it: "a
      // visibility proxy's tolerance must track the QUANTIZATION OF WHATEVER
      // ACTUALLY TRACED THE RAY." Under the occupancy backend `dRaw` comes from
      // the oracle (`freeRadiusAtWorld` below), which measures distance to
      // occupied VOXEL AABBs and therefore reads exactly 0 anywhere inside an
      // occupied voxel — and conservative voxelization marks every voxel a
      // triangle touches, so a receiver standing ON a surface is INSIDE one.
      // These cuts were still sized off the composited FIELD cell (0.05m on the
      // Cornell repro) while the oracle quantizes at the OCCUPANCY VOXEL
      // (0.122m) — 2.4x coarser. The own-plane test then read the receiver's
      // own floor as an occluder wherever the shaded point fell in the voxel
      // lattice, zeroing the emitter's direct light in GRID-ALIGNED BLOTCHES:
      // measured 54-73% darker and 7-12x blotchier the moment `emissiveShadows`
      // promoted an emissive mesh onto this trace (scripts/run-gi-emissive.mjs).
      // Same failure family as session 19's AO trap, which needed 2 voxels of
      // self-surface allowance for exactly this reason.
      // `__giNoOccSelfCut` restores the old sizing (BUILD-TIME — set it via
      // evaluateOnNewDocument before load, per the hatch rule).
      const occVox = occField && killSdf && occField.voxel && !globalThis.__giNoOccSelfCut
        ? vec3(occField.voxel).x.max(vec3(occField.voxel).y).max(vec3(occField.voxel).z).toVar()
        : null;
      // `liftV` stays the TRUE ray-origin lift and must not be inflated with
      // it: `planeHeight = liftV + t·cos` is the height being tested, so
      // raising it LOWERS the bar for calling a sample an occluder — the exact
      // opposite of the intent. The tolerance is the only term that moves.
      const liftV = float(liftWorld).toVar();
      const contactCut = minCellV.mul(0.25).toVar();
      // occVox·2.5 / minCell·1.0 (was 1.5 / 0.75): sized for the HUGGING-RAY
      // case, not just the departure. A near-horizontal emitter ray skims a
      // constant ~lift above its receiver's floor for tens of meters, so the
      // own-plane test's margin is (planeCut − floorNoise) for the WHOLE
      // march — and the floor's apparent distance carries up to one voxel of
      // SAT bulge plus ~half a coarse cell of trilinear undershoot, ≈ 2.1
      // voxels combined. The old 1.5-voxel cut sat inside that noise band, so
      // admission flipped with lattice phase and painted concentric moiré
      // rings of escaped emitter light across every floor (user screenshot,
      // 2026-08-04). Real occluders lose only the sub-0.35m contact band,
      // which soft emitter cones cannot resolve anyway.
      const planeCut = (occVox ? minCellV.mul(1.0).max(occVox.mul(2.5)) : minCellV.mul(0.75)).toVar();
      const capCut = capWorldV.mul(0.85).toVar();
      const occCut = minCellV.mul(0.3).toVar();
      const stepMin = minCellV.mul(0.35).toVar();
      const stepMax = minCellV.mul(8).toVar();
      const penumbra = float(1).toVar();
      // Volume slab entry/exit: a receiver OUTSIDE the fitted volume (auto-fit
      // keeps the volume tight around the scene) must march INTO the field,
      // not give up — the old first-sample out-of-bounds Break() left every
      // outside receiver with penumbra 1, i.e. full UNSHADOWED analytic light
      // past a hard line at the volume face (the "light cutoff" report: lit
      // sharp-edged pools on otherwise dark floors). Entry math mirrors the
      // debug-view raymarcher.
      const invEps = (component) => component.sign().mul(component.abs().max(1e-6));
      const bmax = minV.add(vec3(world.size)).toVar();
      const t1x = minV.x.sub(origin.x).div(invEps(dir.x));
      const t2x = bmax.x.sub(origin.x).div(invEps(dir.x));
      const t1y = minV.y.sub(origin.y).div(invEps(dir.y));
      const t2y = bmax.y.sub(origin.y).div(invEps(dir.y));
      const t1z = minV.z.sub(origin.z).div(invEps(dir.z));
      const t2z = bmax.z.sub(origin.z).div(invEps(dir.z));
      const tEnter = t1x.min(t2x).max(t1y.min(t2y)).max(t1z.min(t2z)).toVar();
      const tExit = t1x.max(t2x).min(t1y.max(t2y)).min(t1z.max(t2z)).toVar();
      const t = minCellV.mul(2).max(tEnter.add(minCellV.mul(0.5))).toVar();
      const tEnd = tExit.sub(contactCut).toVar();
      // Previous-sample distance for the IMPROVED penumbra estimator (iq):
      // two consecutive sphere-trace samples bound a closest-approach point
      // BETWEEN them — estimating the occluder distance there instead of at
      // the samples removes the banding/raggedness the plain min(k·d/t)
      // estimator paints when step size ≈ feature size (the "rough shadows"
      // report; the u8-quantized field makes plain-estimator bands worse).
      const prevD = float(1e10).toVar();
      // Stable mode: the previous sample's OCCLUDER WEIGHT (see the stable
      // estimator below) — 0 disables the closest-approach pairing smoothly,
      // replacing the binary prevD reset.
      const prevW = float(0).toVar();
      // DID THE MARCH REACH A VERDICT? Set only where we KNOW why the loop
      // stopped: the ray reached its end, left the volume, or hit something.
      // Running out of iterations is none of those — see the fail-closed
      // clamp after the loop.
      const resolved = float(0).toVar();
      // Last sampled field distance — the "was I still near a surface when the
      // budget ran out?" discriminator for the fail-closed clamp below. Starts
      // large so a ray that never sampled anything reads as open space.
      const lastD = float(1e10).toVar();

      Loop({ start: 0, end: steps, name: "sdfShadow" }, () => {
        If(t.greaterThanEqual(maxT).or(t.greaterThan(tEnd)), () => {
          resolved.assign(1);
          Break();
        });
        const p = origin.add(dir.mul(t)).toVar();
        const uvw = p.sub(minV).mul(sizeInvV).toVar();
        If(
          uvw.x.lessThan(0)
            .or(uvw.y.lessThan(0))
            .or(uvw.z.lessThan(0))
            .or(uvw.x.greaterThan(1))
            .or(uvw.y.greaterThan(1))
            .or(uvw.z.greaterThan(1)),
          () => {
            resolved.assign(1);
            Break();
          },
        );
        // Hardware trilinear over the composited field; explicit level —
        // implicit-derivative sampling inside loops is illegal WGSL.
        const dRaw = texture3D(distanceTexture, uvw).level(0).r.mul(capWorldV).toVar();
        // Fine level first (one fetch, whole-scene coverage), then the detail
        // slots on top. They are not redundant: the bricks resample the same
        // per-mesh SDFs onto a fixed lattice, so they carry every mesh but at
        // brick resolution, while refineDetail reads a handful of per-mesh
        // SDFs at their own NATIVE resolution (0.02–0.15m — finer than any
        // brick). Sparse fixes coverage; detail slots keep the sharpest edges.
        if (sparse) {
          const fine = sparse.sample(p);
          dRaw.assign(select(fine.valid.and(dRaw.lessThan(sparse.params.band)), fine.d, dRaw));
        }
        if (killSdf) {
          // THE OCCUPANCY ORACLE REPLACES `refineDetail`, doing the same job
          // from data that needs no bake: sharpen the coarse composited
          // distance where sub-cell geometry lives. Three levels, so the bound
          // reaches ~4 voxels (≈0.5 m at the high tier) — enough to bracket a
          // coarse cell, which is exactly where the trilinear far-field
          // distance takes over and paying for more levels buys nothing.
          //
          // GATED, and this is a pure optimisation rather than a behaviour
          // change: the oracle can only LOWER `dRaw`, and it cannot return
          // more than ~4 voxels, so where the coarse distance is already
          // larger than that the call could not have changed anything. Worth
          // gating because the near field is 27 buffer reads and most steps of
          // most rays are in open space.
          // (A stable-mode near-field-only variant of this refine was tried and
          // REVERTED: its ~1-voxel reach is half of maxLevel 2's, and the
          // under-floor leak reopened at the low preset. The far ladder's
          // quantization jitter is absorbed by the field EMA instead — see
          // createBounceFeedback's radiance blend.)
          If(dRaw.lessThan(minCellV.mul(2)), () => {
            // Saturating at `capWorld` matters here too: without it a sample
            // whose neighbourhood is simply empty reports the oracle's own
            // ~4-voxel ceiling, which would pull `dRaw` DOWN and make open
            // space read as an occluder to `isRealOccluder`'s cap test.
            dRaw.assign(dRaw.min(occField.freeRadiusAtWorld(p, 2, true, capWorldV, recordAware)));
          });
        } else {
          // Detail slots: crisp local fields min()ed in near dense/important
          // meshes — sub-scene-cell silhouettes (thin wings, fine props).
          dRaw.assign(atlas.refineDetail(dRaw, p));
        }
        // LIGHT-SOURCE SELF-EXCLUSION: a ray aimed AT the light must not be
        // occluded by the light's own body/field shell. Without this, rays
        // skimming the emitter's SDF near arrival painted its bounding-box
        // shadow onto every receiver ("+"-shaped dark bands under disc
        // lamps).
        // SPHERE lamps: legacy region test — samples within excludeRadius
        // (1.5R + margin) never occlude; the 0.5R shell left outside keeps
        // min(k·d/t) ≥ ~1 for the lamp's own field, so it can't self-shadow.
        // (excludeRadius < 0 → always true: no exclusion.)
        // BOX lamps (excludeHalf.x ≥ 0): COMPARATIVE test — the sample may
        // occlude only when the field reads DECISIVELY closer than the
        // lamp's own analytic SDF explains. A region the size of a big
        // panel's bounding sphere swallowed nearby ceilings (light poured
        // through into the room above as a circle) and its boundary ringed
        // the pool with dirt; a small fixed region instead lets the lamp's
        // own shell darken its light (min(k·d/t) with d capped at the
        // dilation ≈ heavy false self-shadow on any large lamp). Comparing
        // against the exact lamp SDF excludes exactly the lamp, at any
        // size — a wall two cells from the face still seals.
        const relEx = p.sub(excludeCenter).toVar();
        const localEx = vec3(relEx.dot(excludeBx), relEx.dot(excludeBy), relEx.dot(excludeBz));
        const lampDist = localEx.abs().sub(excludeHalf).max(vec3(0)).length().toVar();
        const slack = minCellV.mul(1.5).max(lampDist.mul(0.25));
        const outsideLight = select(
          excludeHalf.x.greaterThanEqual(0),
          dRaw.lessThan(lampDist.sub(slack)),
          relEx.length().greaterThan(excludeRadius),
        );
        const planeHeight = liftV.add(t.mul(cosRayNormal));
        // A sample only counts as an occluder if it is BOTH under the
        // receiver-plane exclusion threshold AND not SATURATED at the field
        // cap. dRaw clamps at capWorld while `lift + t·cos` grows unbounded —
        // without the cap check, every open-space sample beyond
        // t ≈ k·capWorld "occludes", carving a hard light sphere of radius
        // k·capWorld around every lamp (the user's cutoff disc; the radius
        // SHRANK at higher quality because finer cells mean smaller capWorld).
        const isRealOccluder = dRaw
          .lessThan(planeHeight.sub(planeCut))
          .and(dRaw.lessThan(capCut))
          .and(outsideLight)
          .toVar();
        If(isRealOccluder.and(dRaw.lessThan(contactCut)), () => {
          penumbra.assign(0);
          resolved.assign(1);
          Break();
        });
        // OCCUPANCY HARD BLOCK: a wall thinner than a field cell keeps its
        // trilinear distance above the contact cut (the surface sits between
        // cell centers), so a distance-only march can step across it — light
        // through walls. Marching THROUGH an occupied cell is unambiguous
        // occlusion regardless of what the interpolated distance claims. The
        // plane-exclusion gate keeps the receiver's own shell from
        // self-shadowing.
        // Gated on the refined distance ALSO being VERY small: the old
        // 0.6·cell gate zeroed every near-silhouette ray, bottom-clipping the
        // penumbra ramp — large emitters cast HARD-edged shadows ("no soft
        // shadows from the emissive"). Thin walls are now detail-refined to
        // EXACT distances (analytic + baked local SDFs), so rays truly
        // crossing them converge under the contact cut on their own; this
        // block is only the safety net for thin walls beyond the detail
        // budget, and 0.3·cell catches those while leaving the soft band
        // (est ≥ 0.3·cell) untouched.
        //
        // The occupancy FIELD supersedes the coarse cell test when present:
        // same net, at 0.125m conservative voxels instead of the 0.33m cells
        // that lost the wall to begin with. Its gate is the CONTACT cut rather
        // than `occCut`, because a level-0 bit is unambiguous — the reason the
        // old gate had to be conservative (0.3·cell) was that a coarse
        // "occupied" cell could be half empty space, and zeroing on it
        // bottom-clipped the penumbra ramp into hard-edged shadows.
        // NOT IN SDF-FREE MODE — the oracle already subsumes it, and keeping it
        // costs the shadow edges.
        //
        // This block zeroes the penumbra OUTRIGHT the moment a level-0 bit is
        // set, which is a binary decision at voxel resolution: shadow
        // boundaries come out stair-stepped in voxel-sized blocks, and as the
        // light moves each voxel flips at a different moment, so the steps
        // crawl. That is the "squarish light changes / jumpy light spots"
        // report, and it is the same hard-edged-shadow failure this file's own
        // comment records from the previous 0.6·cell version.
        //
        // It exists because a BLURRED distance loses sub-cell geometry. In
        // SDF-free mode the distance is the occupancy oracle — derived from the
        // very same bits, with a real continuous near field — so a thin wall
        // already produces a small `dRaw` and the estimator ramps down to it
        // smoothly. There is nothing left for a hard override to catch.
        if (occField && !killSdf && !stable) {
          // UNGATED (2026-08-02). This used to only consult occupancy where
          // `dRaw < contactCut*2` — i.e. where the SDF ALREADY thought a
          // surface was near. That voids the safety net for exactly the
          // geometry it exists to catch: a floor or wall thinner than a coarse
          // cell keeps its trilinear distance ABOVE the cut (the surface sits
          // between cell centres), so the check never ran and the ray walked
          // straight through. The user's report is the visible form of it —
          // a sun below the floor lighting the room through it, worst at
          // grazing angles where the ray spends the longest inside the slab.
          //
          // A level-0 bit is unambiguous, so `isRealOccluder` (own-plane,
          // cap-saturation and lamp-body exclusion) is the only gate it needs.
          // Cost is one pyramid fetch per shadow step.
          If(isRealOccluder, () => {
            If(occField.occupiedAtWorld(p, 0).greaterThan(0.5), () => {
              penumbra.assign(0);
              resolved.assign(1);
              Break();
            });
          });
        } else if (occupancy && !stable) {
          If(isRealOccluder.and(dRaw.lessThan(occCut)), () => {
            const cx = p.x.sub(minV.x).div(cellV.x).floor().clamp(0, res.x - 1);
            const cy = p.y.sub(minV.y).div(cellV.y).floor().clamp(0, res.y - 1);
            const cz = p.z.sub(minV.z).div(cellV.z).floor().clamp(0, res.z - 1);
            const cellIdx = cz.mul(res.y).add(cy).mul(res.x).add(cx);
            If(occupancy.element(cellIdx.toInt()).w.greaterThan(0.5), () => {
              penumbra.assign(0);
              Break();
            });
          });
        }
        if (stable) {
          // THE SAME closest-approach estimator, admitted CONTINUOUSLY.
          //
          // (v1 of stable mode replaced the estimator outright with plain
          // min(k·d/t) under smooth weights and was REVERTED the same day:
          // shadows went visibly loose and the under-floor leak reopened. The
          // estimator's SHAPE was never the problem — its ADMISSION was: a
          // sample is either in the min or absent, decided by the boolean
          // isRealOccluder, and near opening rims — where the sun streams in
          // and half the samples hover at the own-plane/cap thresholds — that
          // membership churns as the light turns. If the churning sample would
          // have been the minimum, the whole penumbra jumps. That is the
          // "flickers like hell when the light comes in", on every preset.)
          //
          // `w` is isRealOccluder's three tests as ramps; a sample's candidate
          // fades toward 1 (a no-op in the min) as it approaches exclusion
          // instead of vanishing. `prevW` weights the pairing the same way —
          // the old binary prevD reset switched a sample between the paired
          // and unpaired estimates in one frame; scaling `y` by the previous
          // sample's weight makes that handoff a fade too (prevW → 0 gives
          // y → 0, which IS the unpaired estimator). `prox` folds in the
          // contact-proximity ramp so a ray reaches the hard Break above
          // already ~0 — the Break stays, it is the leak seal.
          const planeW = smoothstep(planeHeight.sub(planeCut.mul(1.25)), planeHeight.sub(planeCut.mul(0.75)), dRaw)
            .oneMinus()
            .toVar();
          const capW = smoothstep(capCut.mul(0.9), capCut, dRaw).oneMinus();
          const w = planeW.mul(capW).mul(select(outsideLight, float(1), float(0))).toVar();
          const y = dRaw.mul(dRaw).div(prevD.mul(2)).min(dRaw).mul(prevW).toVar();
          const est = dRaw.mul(dRaw).sub(y.mul(y)).max(0).sqrt();
          // (A `prox` proximity ramp was min'd in here for one build and
          // REVERTED: it dragged EVERY ray passing within a cell of geometry
          // toward dark regardless of what k·d/t said — visibly over-dark
          // shadows, and its slope steepens as cells shrink, so it JITTERED
          // hardest at ultra. The temporal edge it existed to cushion is the
          // probe EMA's job — see probeSmoothing.)
          const cand = est.mul(k).div(t.sub(y).max(1e-4)).clamp(0, 1);
          penumbra.assign(penumbra.min(mix(float(1), cand, w)));
          prevD.assign(dRaw);
          prevW.assign(w);
        } else {
          If(isRealOccluder, () => {
            // Closest-approach interpolation: y = where between the previous
            // and current sample the ray passed nearest the occluder, est = the
            // interpolated distance there. Exact for a straight silhouette,
            // and MUCH smoother than min(k·d/t) at coarse step counts.
            const y = dRaw.mul(dRaw).div(prevD.mul(2)).min(dRaw).toVar();
            const est = dRaw.mul(dRaw).sub(y.mul(y)).max(0).sqrt();
            penumbra.assign(penumbra.min(est.mul(k).div(t.sub(y).max(1e-4))));
            prevD.assign(dRaw);
          }).Else(() => {
            // Non-occluder samples (own plane, cap-saturated, lamp body) must
            // not feed the interpolation — their distances describe excluded
            // geometry, and pairing them with a real sample fabricates a
            // closest approach that never existed.
            prevD.assign(1e10);
          });
        }
        lastD.assign(dRaw);
        t.addAssign(dRaw.mul(0.85).clamp(stepMin, stepMax));
      });

      // FAIL CLOSED ON STEP EXHAUSTION — BUT ONLY WHERE THE RAY WAS HUGGING
      // GEOMETRY WHEN IT RAN OUT.
      //
      // Why fail closed at all: falling out of the loop with no verdict leaves
      // `penumbra` at its running minimum — in practice 1, i.e. FULLY LIT. That
      // is a light leak, and a direction-dependent one, because whether a ray
      // runs out depends on how many SMALL steps it took and steps are small
      // exactly where the ray hugs a surface. A sun at a grazing or below-floor
      // angle sends rays skimming along a slab for their whole length, so they
      // exhaust and report "nothing blocked me" and the floor lights up; as the
      // light moves, each ray crosses the budget boundary at a different
      // moment, which is the flicker on top of the glow.
      //
      // WHY IT CANNOT BE UNCONDITIONAL, learned the expensive way: a ray can
      // also run out simply because the volume is bigger than
      // `budget × maxStep`. A directional light makes every ray cross the whole
      // scene, and those rays exhaust in OPEN SPACE, where "occluded" is
      // exactly wrong. Failing them closed put the scene in shadow with only
      // the cells near the roof openings — whose rays exit the volume in a few
      // steps — still lit. That is a black room with a lit ceiling, and it is
      // what the last build did.
      //
      // The discriminator is the last sample's distance: still close to a
      // surface ⇒ the ray was threading geometry and probably blocked; out in
      // the open ⇒ the budget was just too short for the distance, and the
      // honest answer is the unshadowed one.
      // `__giShadowFailOpen` disables the clamp entirely (A/B arm).
      // CONTINUOUS, not a hard zero. `select(..., penumbra, 0)` is a binary
      // flip on a per-ray condition, and a per-ray binary flip under a moving
      // light is a flickering pixel. Scaling by how deep in geometry the march
      // was when it ran out keeps the leak closed while varying smoothly with
      // both the ray and the light.
      // (A stable-mode "progress-smooth" variant — trusting a ray by how far
      // its march got instead of the binary `resolved` — was tried and
      // REVERTED: a ray can be 90% of the way through and still be about to
      // hit the floor slab, and trusting it reopened the under-floor leak at
      // the low preset, whose 18-step budget exhausts rays constantly. The
      // binary clamp SEALS; its temporal flip is damped by the probe EMA
      // (probeSmoothing), which is the layer that owns temporal smoothness.)
      if (!globalThis.__giShadowFailOpen && !globalThis.__giNoFailClosed) {
        const exhausted = resolved.oneMinus();
        const inGeometry = smoothstep(planeCut.mul(4), planeCut, lastD);
        penumbra.mulAssign(exhausted.mul(inGeometry).oneMinus());
      }

      return penumbra.clamp(0, 1);
    },
  });

  return (origin, dir, maxT, k, cosRayNormal, excludeCenter = null, excludeRadius = null, excludeBox = null) =>
    traceFn(
      vec3(origin),
      vec3(dir),
      float(maxT),
      float(k),
      float(cosRayNormal),
      excludeCenter ? vec3(excludeCenter) : vec3(0, 0, 0),
      excludeRadius ? float(excludeRadius) : float(-1),
      // excludeBox = { half, bx, by, bz } node bundle; x < 0 → sphere mode.
      excludeBox ? vec3(excludeBox.half) : vec3(-1, -1, -1),
      excludeBox ? vec3(excludeBox.bx) : vec3(1, 0, 0),
      excludeBox ? vec3(excludeBox.by) : vec3(0, 1, 0),
      excludeBox ? vec3(excludeBox.bz) : vec3(0, 0, 1),
    );
}

/**
 * Debug material for the "SDF" view: raymarches the composited distance
 * field (+ detail slots — the ACTUAL per-mesh SDFs) from the camera and
 * shades hits with the field's own gradient normals plus distance-band
 * rings, so a broken/missing/misplaced mesh SDF is immediately visible.
 * Applied to a camera-facing volume box rendered from the inside.
 */
export function createSdfDebugMaterial(volume) {
  const { world, distanceTexture, atlas, sparse } = volume;
  const minCell = world.minCell;
  const capWorld = world.capWorld;

  const material = new THREE.MeshBasicNodeMaterial();
  material.side = THREE.BackSide;
  // Overlay: the raymarch replaces the scene view entirely — scene depth
  // would otherwise occlude the box's backfaces and hide the debug.
  material.depthTest = false;
  material.depthWrite = false;
  material.fragmentNode = Fn(() => {
    // Uniform-derived values hoisted before the loop (driver compile cost).
    const minCellV = float(minCell).toVar();
    const capWorldV = float(capWorld).toVar();
    const minV = vec3(world.min).toVar();
    const sizeV = vec3(world.size).toVar();
    const dir = positionWorld.sub(cameraPosition).normalize().toVar();
    // Slab entry so an outside camera starts marching AT the volume.
    const invEps = (component) => component.sign().mul(component.abs().max(1e-6));
    const bmax = minV.add(sizeV).toVar();
    const t1x = minV.x.sub(cameraPosition.x).div(invEps(dir.x));
    const t2x = bmax.x.sub(cameraPosition.x).div(invEps(dir.x));
    const t1y = minV.y.sub(cameraPosition.y).div(invEps(dir.y));
    const t2y = bmax.y.sub(cameraPosition.y).div(invEps(dir.y));
    const t1z = minV.z.sub(cameraPosition.z).div(invEps(dir.z));
    const t2z = bmax.z.sub(cameraPosition.z).div(invEps(dir.z));
    const tEnter = t1x.min(t2x).max(t1y.min(t2y)).max(t1z.min(t2z));
    const tExit = t1x.max(t2x).min(t1y.max(t2y)).min(t1z.max(t2z));

    const t = tEnter.max(0).add(minCellV.mul(0.25)).toVar();
    const out = vec4(0, 0, 0, 0).toVar();
    Loop({ start: 0, end: 128, name: "sdfDebug" }, () => {
      If(t.greaterThan(tExit), () => {
        Break();
      });
      const p = cameraPosition.add(dir.mul(t)).toVar();
      const uvw = p.sub(minV).div(sizeV).clamp(0, 1).toVar();
      const sample = texture3D(distanceTexture, uvw).level(0).toVar();
      const d = sample.r.mul(capWorldV).toVar();
      // The debug view must march the SAME field the traces do, fine level
      // included — otherwise it keeps showing the coarse blobs while the GI
      // has stopped using them, and the one instrument for "is my SDF any
      // good" lies about the thing it exists to show.
      if (sparse) {
        const fine = sparse.sample(p);
        d.assign(select(fine.valid.and(d.lessThan(sparse.params.band)), fine.d, d));
      }
      d.assign(atlas.refineDetail(d, p));
      // HIT CUT AND STEP FLOOR AND ITERATION BUDGET ARE A TRIPLE, not a pair.
      // Scaling the cut down to the fine cell (÷ brickAxis-1) and the floor
      // with it left the 128-step budget untouched, so every grazing ray ran
      // out of iterations before reaching its surface: the colonnade rendered
      // as vertical shreds with the floor intact, which reads as "the sparse
      // field is broken" when the field was fine and the MARCHER was starved.
      // Held identical to the coarse path on purpose — then any difference in
      // this view is the field's accuracy, which is the thing being judged.
      // Sharpening the contact is a separate change with its own budget.
      const hitCut = minCellV.mul(0.4);
      If(d.lessThan(hitCut), () => {
        const n = sample.gba.mul(2).sub(1).toVar();
        // Normal-colored surface with a headlight lambert — a missing,
        // misplaced, or garbage mesh SDF is immediately visible.
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

/**
 * SDF sphere-traced CASCADE ray: (origin, dir, tMaxWorld) → { rad, t },
 * t < 0 = miss. Replaces the voxel DDA the transport used to march —
 * steps scale with distance-to-geometry (fast in open space), silhouettes
 * are continuous, and the hit shades from the trilinear radiance field.
 * Back-side hits block but emit nothing (the composite's per-side gradient
 * normal decides), matching the DDA's convention.
 */
function createGiFieldTrace(distanceTexture, world, res, atlas, radianceSampler, sparse) {
  const minCell = world.minCell;
  const capWorld = world.capWorld;

  return (origin, dir, tMaxWorld) => {
    // Uniform-derived values hoisted to locals before the loop — see the
    // shadow trace's note (driver pipeline-compile cost).
    const minCellV = float(minCell).toVar();
    const capWorldV = float(capWorld).toVar();
    const minV = vec3(world.min).toVar();
    const sizeInvV = vec3(1).div(world.size).toVar();
    const hitCut = minCellV.mul(0.45).toVar();
    const stepMin = minCellV.mul(0.5).toVar();
    const rad = vec3(0).toVar();
    const hitT = float(-1).toVar();
    const t = float(0).toVar();
    Loop({ start: 0, end: 48, name: "sdfRay" }, () => {
      If(t.greaterThan(tMaxWorld), () => {
        Break();
      });
      const p = origin.add(dir.mul(t)).toVar();
      const uvw = p.sub(minV).mul(sizeInvV).toVar();
      If(
        uvw.x.lessThan(0)
          .or(uvw.y.lessThan(0))
          .or(uvw.z.lessThan(0))
          .or(uvw.x.greaterThan(1))
          .or(uvw.y.greaterThan(1))
          .or(uvw.z.greaterThan(1)),
        () => {
          Break();
        },
      );
      const sample = texture3D(distanceTexture, uvw).level(0).toVar();
      const d = sample.r.mul(capWorldV).toVar();
      // NO detail-slot refinement here on purpose: transport rays number in
      // the hundreds of thousands per frame — 6 extra SDF fetches per step
      // quadrupled the whole frame (harness-measured 8.3 → 33ms). Shadows
      // and mirrors keep sub-cell detail; diffuse transport doesn't need it.
      //
      // THE SPARSE LEVEL IS WHAT LETS THAT CHANGE. It costs ONE page fetch
      // plus one brick fetch — a constant, not a loop over slots — so the
      // rays that decide GI occlusion finally see sub-cell geometry. This is
      // the path the leak lives on: at 0.33m cells a 0.5m column is one and a
      // half cells wide and transport walks straight through it.
      //
      // Consumed as PURE DATAFLOW (nested select, no If gate around the
      // fetch). An `If()` around a `.toVar()`ed texture read is the idiom
      // that rendered the BVH mirror pass black — see giLight's note.
      if (sparse) {
        const fine = sparse.sample(p);
        d.assign(select(fine.valid.and(d.lessThan(sparse.params.band)), fine.d, d));
      }
      If(d.lessThan(hitCut), () => {
        const n = sample.gba.mul(2).sub(1).toVar();
        // Side-aware sample: only cells facing the hit side contribute.
        const shaded = radianceSampler(p, n);
        // Front-side hits carry the field radiance; back sides only block.
        rad.assign(vec3(shaded.rad).mul(step(dir.dot(n), 0)));
        hitT.assign(t.max(1e-4));
        Break();
      });
      t.addAssign(d.mul(0.9).clamp(stepMin, capWorldV));
    });
    return { rad, t: hitT };
  };
}

/**
 * OCCUPANCY transport ray: (origin, dir, tMaxWorld) → { rad, t }, t < 0 = miss.
 * The spec's `traceInterval`, phase 4 — hierarchical DDA over the conservative
 * occupancy pyramid, with the hit shaded from the existing coarse radiance
 * field.
 *
 * WHY THE RADIANCE STAYS COARSE (spec phase 3 is not this change). The leak is
 * an OCCLUSION failure, not a radiance one: a 0.5m column melted out of a 0.33m
 * distance field lets light through, and no amount of radiance resolution fixes
 * that. Occlusion is now 0.125m and conservative; radiance is still probe-scale,
 * which is where diffuse GI wants it anyway. Per-voxel radiance is the separate,
 * later upgrade.
 *
 * TWO DETAILS THAT ARE NOT ARBITRARY:
 *  · The hit is pushed OUT along the voxel face normal by half a coarse cell
 *    before sampling radiance. The DDA stops exactly ON the surface, which in
 *    coarse-cell terms is inside the wall; the shell cell carrying that face's
 *    lighting is half a cell outside it.
 *  · No `step(dot(dir, n), 0)` front-face gate, unlike the SDF trace. That gate
 *    existed because an SDF-gradient normal is the SURFACE's outward normal, so
 *    a back-side hit had to be detected and silenced. A DDA face normal always
 *    points back along the ray, i.e. at the side the ray can actually see, and
 *    feeding it to the SIDE-AWARE sampler already selects that side's shell —
 *    a wall's dark face returns dark because its cells are dark, not because a
 *    gate zeroed it.
 */
function createOccupancySceneTrace(
  occField,
  world,
  radianceSampler,
  steps = 64,
  rayHitMode = RayHitMode.OccupancyLegacy,
  dynamicShade = null,
) {
  // The one place the ray-hit mode swaps implementations. Interval semantics,
  // radiance lookup and the {rad, t} contract are identical across modes.
  const planeMode = rayHitMode >= RayHitMode.HybridPlane &&
    rayHitMode <= RayHitMode.HybridExactComplex && occField.traceHybridPlane;
  const trace = planeMode
    ? (o, d, t0, t1, opts) => occField.traceHybridPlane(o, d, t0, t1, {
        ...opts,
        coverage: rayHitMode >= RayHitMode.HybridPlaneCoverage,
        exact: rayHitMode === RayHitMode.HybridExactComplex,
      })
    : rayHitMode === RayHitMode.HybridBrickBox && occField.traceHybridBrick
      ? occField.traceHybridBrick
      : occField.traceOccupancy;
  // EXACT-DYNAMIC HITS SHADE THEMSELVES (2026-08-07). Adoption parks a mover's
  // occupancy slot and clears its atlas slot, so the voxel radiance buffer has
  // nothing where the mover is — and a ray that hits its exact triangles used
  // to come back with the SURROUNDING room's colour. Measured on the
  // mover-bounce rig: a voxel-path red box put 16.1% red excess on the floor
  // beside it, the same box adopted put 0.0% (its red and white frames were
  // pixel-identical). So when the hit is a mover, shade it from its own header
  // surface instead of sampling a field it left.
  const dyn = occField.dynamicObjects;
  const lightSlots = dynamicShade?.lightSlots ?? null;
  const emitterSlots = dynamicShade?.emitterSlots ?? null;
  const shadeDynamic = !!(dyn?.enabled && dyn.surfaceAt && (lightSlots?.length || emitterSlots?.length));
  // Sun/point visibility for the mover's own direct term, through the SAME
  // marcher the primary ray used (no extra WGSL, no new bindings) with
  // dynamics excluded — so a mover cannot shadow itself and the ray costs one
  // traversal per active light per mover hit. `__giDynShadeShadow = false`
  // drops it: unshadowed movers bounce sun colour everywhere, which is the
  // A/B that says whether the ray is worth its cost.
  const shadeShadow = shadeDynamic && globalThis.__giDynShadeShadow !== false;
  const farT = Math.hypot(world.size?.x ?? 0, world.size?.y ?? 0, world.size?.z ?? 0) || 1e3;
  return (origin, dir, tMaxWorld) => {
    const o = vec3(origin).toVar();
    const d = vec3(dir).toVar();
    // Self-bias (spec §5.3): start a quarter of a coarse cell out so a probe
    // sitting on a surface does not instantly hit the voxel it lives in.
    const tMin = float(world.minCell).mul(0.25).toVar();
    const r = trace(o, d, tMin, float(tMaxWorld), {
      steps,
      macroSteps: MAX_MACRO_STEPS,
      profile: true,
      dynObj: shadeDynamic,
    });
    const p = o.add(d.mul(r.t)).add(r.normal.mul(float(world.minCell).mul(0.5))).toVar();
    const shaded = radianceSampler(p, r.normal);
    const rad = vec3(shaded.rad).mul(r.hit).toVar();
    if (shadeDynamic && r.dynObj != null) {
      If(r.dynObj.greaterThanEqual(0), () => {
        const surf = dyn.surfaceAt(r.dynObj);
        // The EXACT hit point, not the half-cell-lifted one: that lift exists
        // to move a voxel-face hit out to the shell cell carrying its
        // lighting, and an exact triangle needs no such correction.
        const hp = o.add(d.mul(r.t)).toVar();
        const n = vec3(r.normal).toVar();
        // AMBIENT PROXY, DEFAULT OFF (2026-08-07). This was the neighbourhood
        // voxel radiance, kept at weight 1 so the change could only ADD the
        // direct term. Two measurements retired it: in the controlled rig it
        // contributes ~nothing (an adopted mover's cells are EMPTY, so there
        // is no neighbourhood radiance to read), and it was the ONLY
        // voxel-quantized term left in an otherwise exact path — which is
        // precisely the user's "large square patches of colour bleed that
        // appear and disappear fast" as a mover rotates through the lattice.
        // The uniform survives for the A/B; the emitter term below is what
        // now covers "lit by something other than an analytic light".
        const irr = vec3(shaded.rad).mul(float(dynamicShade.ambient ?? 0)).toVar();
        const lift = float(world.minCell).mul(0.75).toVar();
        /** Binary visibility toward a source, through the primary ray's own marcher. */
        const visibility = (L, maxT) => {
          const v = float(1).toVar();
          if (shadeShadow) {
            const sh = trace(hp.add(n.mul(lift)), L, lift, maxT, {
              steps,
              macroSteps: MAX_MACRO_STEPS,
              dynamics: false,
            });
            v.assign(select(float(sh.hit).greaterThan(0.5), float(0), float(1)));
          }
          return v;
        };
        for (const slot of lightSlots) {
          If(float(slot.active).greaterThan(0.5), () => {
            // Same convention as the field gather's analytic direct block:
            // `vector` is a world position for a point light and the
            // normalized direction TOWARD a directional one.
            const isDir = float(slot.kind).toVar();
            const rel = vec3(slot.vector).sub(hp).toVar();
            const pointDist = rel.length().max(1e-4).toVar();
            const L = mix(rel.div(pointDist), vec3(slot.vector), isDir).toVar();
            let atten = mix(float(1).div(pointDist.mul(pointDist).max(1)), float(1), isDir);
            if (slot.range) {
              // three's PointLight `distance` cutoff, mirrored so GI dies
              // where the renderer's own direct light does.
              const range = float(slot.range);
              const ratio = pointDist.div(range.max(1e-4)).clamp(0, 1);
              const r2 = ratio.mul(ratio);
              const win = r2.mul(r2).oneMinus().clamp(0, 1);
              atten = atten.mul(mix(float(1), win.mul(win), step(1e-3, range).mul(isDir.oneMinus())));
            }
            const ndotl = L.dot(n).max(0).toVar();
            If(ndotl.greaterThan(1e-4), () => {
              const vis = visibility(L, mix(pointDist.sub(lift).max(0), float(farT), isDir).toVar());
              // Lambert /π, matching cascadeGather's `direct` term exactly —
              // a different normalisation here would make movers read
              // brighter or darker than the static geometry beside them.
              irr.addAssign(vec3(slot.color).mul(atten.mul(ndotl).mul(vis).mul(1 / Math.PI)));
            });
          });
        }
        // PROMOTED EMISSIVE MESHES. Without this a mover lit only by a lamp
        // bounces nothing — and "dynamic objects and emissive light" is the
        // case the user actually cares about. Same `emitterSlotFactor` the
        // field gather and the receiver material use, so a mover and the floor
        // beside it agree about how bright the lamp is.
        for (const slot of emitterSlots ?? []) {
          If(float(slot.radius).greaterThan(0.001), () => {
            const rel = vec3(slot.center).sub(hp).toVar();
            const dist = rel.length().max(1e-4).toVar();
            const L = rel.div(dist).toVar();
            const cosTheta = L.dot(n).toVar();
            const sinR = float(slot.radius).div(dist).clamp(0, 1).toVar();
            const factor = emitterSlotFactor(slot, hp, n, cosTheta, sinR).toVar();
            If(factor.greaterThan(1e-6), () => {
              // Stop at the lamp's surface, not its centre, or every ray ends
              // inside the lamp body and reports itself occluded.
              const maxT = emitterSurfaceT(slot, hp, L, dist).sub(lift).max(0).toVar();
              const vis = visibility(L, maxT);
              irr.addAssign(vec3(slot.color).mul(factor).mul(vis).mul(1 / Math.PI));
            });
          });
        }
        rad.assign(surf.emissive.add(surf.albedo.mul(irr)));
      });
    }
    const hitT = select(r.hit.greaterThan(0.5), r.t.max(1e-4), float(-1)).toVar();
    return { rad, t: hitT };
  };
}

/**
 * Debug material for the "Occupancy" view: hierarchical-DDA the pyramid from
 * the camera and shade hits by voxel face normal, tinted by which pyramid level
 * the ray was on when it descended. This is the instrument for "is a column
 * actually in the field" — the one question every leak in this module has come
 * down to — and it marches EXACTLY what the transport rays march, because a
 * debug view that renders a different field than the traces lies about the
 * thing it exists to show.
 */
export function createOccupancyDebugMaterial(volume) {
  const occField = volume.occupancyField;
  const { world } = volume;
  const hybrid = volume.rayHitMode === RayHitMode.HybridBrickBox && occField.traceHybridBrick;
  // Plane modes shade by the DECODED record normal — the doc's required
  // "plane-normal visualization". Flat surfaces render flat colour instead of
  // the voxel-face quantization, which is exactly the Phase-2 acceptance look
  // (and in exact-complex mode, curved silhouettes come from real triangles).
  const plane = volume.rayHitMode >= RayHitMode.HybridPlane &&
    volume.rayHitMode <= RayHitMode.HybridExactComplex && occField.traceHybridPlane;

  const material = new THREE.MeshBasicNodeMaterial();
  material.side = THREE.BackSide;
  material.depthTest = false;
  material.depthWrite = false;
  material.fragmentNode = Fn(() => {
    const minV = vec3(world.min).toVar();
    const sizeV = vec3(world.size).toVar();
    const dir = positionWorld.sub(cameraPosition).normalize().toVar();
    // Slab entry so an outside camera starts marching AT the volume.
    const invEps = (component) => component.sign().mul(component.abs().max(1e-6));
    const bmax = minV.add(sizeV).toVar();
    const t1x = minV.x.sub(cameraPosition.x).div(invEps(dir.x));
    const t2x = bmax.x.sub(cameraPosition.x).div(invEps(dir.x));
    const t1y = minV.y.sub(cameraPosition.y).div(invEps(dir.y));
    const t2y = bmax.y.sub(cameraPosition.y).div(invEps(dir.y));
    const t1z = minV.z.sub(cameraPosition.z).div(invEps(dir.z));
    const t2z = bmax.z.sub(cameraPosition.z).div(invEps(dir.z));
    const tEnter = t1x.min(t2x).max(t1y.min(t2y)).max(t1z.min(t2z));
    const tExit = t1x.max(t2x).min(t1y.max(t2y)).min(t1z.max(t2z));

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
 * Mirror ray: sphere trace of the composited field (+ detail slots) —
 * (origin, dir, maxTWorld) → { t } with t < 0 = miss. Much smoother hit
 * silhouettes than the old occupancy DDA (continuous distances vs binary
 * cells), and cheaper in open space (steps grow with distance from
 * geometry). The caller shades the hit via the trilinear radiance sampler.
 */
function createMirrorTrace(distanceTexture, world, res, atlas, steps = 64, sparse = null, occField = null) {
  const minCell = world.minCell;
  const capWorld = world.capWorld;

  // One WGSL function per shader (see createShadowTrace's note on compile
  // cost, and giFn.js on why the instance must be per-builder).
  const traceFn = sharedFn({
    name: "giMirrorTrace",
    type: "float",
    inputs: [
      { name: "origin", type: "vec3" },
      { name: "dir", type: "vec3" },
      { name: "maxTWorld", type: "float" },
    ],
    body: (origin, dir, maxTWorld) => {
      // Uniform-derived values hoisted to locals before the loop — see the
      // shadow trace's note (driver pipeline-compile cost).
      const minCellV = float(minCell).toVar();
      const capWorldV = float(capWorld).toVar();
      const minV = vec3(world.min).toVar();
      const sizeInvV = vec3(1).div(world.size).toVar();
      const hitCut = minCellV.mul(0.45).toVar();
      const stepMin = minCellV.mul(0.4).toVar();
      const hitT = float(-1).toVar();
      // Skip the receiver's own surface: start past the origin cell.
      const t = float(minCellV.mul(1.5)).toVar();
      Loop({ start: 0, end: steps, name: "mirror" }, () => {
        If(t.greaterThanEqual(maxTWorld), () => {
          Break();
        });
        const p = origin.add(dir.mul(t)).toVar();
        const uvw = p.sub(minV).mul(sizeInvV).toVar();
        If(
          uvw.x.lessThan(0)
            .or(uvw.y.lessThan(0))
            .or(uvw.z.lessThan(0))
            .or(uvw.x.greaterThan(1))
            .or(uvw.y.greaterThan(1))
            .or(uvw.z.greaterThan(1)),
          () => {
            Break();
          },
        );
        const d = texture3D(distanceTexture, uvw).level(0).r.mul(capWorldV).toVar();
        if (sparse) {
          const fine = sparse.sample(p);
          d.assign(select(fine.valid.and(d.lessThan(sparse.params.band)), fine.d, d));
        }
        // Same substitution as the shadow trace, and gated for the same reason.
        if (occField) {
          If(d.lessThan(minCellV.mul(2)), () => {
            d.assign(d.min(occField.freeRadiusAtWorld(p, 2, true, capWorldV)));
          });
        } else {
          d.assign(atlas.refineDetail(d, p));
        }
        If(d.lessThan(hitCut), () => {
          hitT.assign(t);
          Break();
        });
        t.addAssign(d.mul(0.9).clamp(stepMin, capWorldV));
      });
      return hitT;
    },
  });

  return (origin, dir, maxTWorld) => ({ t: traceFn(vec3(origin), vec3(dir), float(maxTWorld)) });
}
