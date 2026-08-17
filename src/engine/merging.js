// @ts-check
import * as THREE from "three/webgpu";
import { OCCLUDER_LAYER } from "./editorLayers.js";
import { buildUberMaterial, slotSignature, uberIncompatibility } from "./uberMaterial.js";
import { textureLoadsInFlight } from "./textureAsset.js";

/**
 * Automatic static MERGING — the case instancing cannot reach.
 *
 * `batching.js` collapses meshes that repeat: same geometry, same material, many
 * transforms, one `InstancedMesh`. That is the right answer for a scene built by
 * dropping one crate a thousand times, and it is worth exactly nothing on an
 * imported environment, where every mesh is unique. Sponza is the canonical
 * shape of the problem: 26 meshes, 26 geometries, 26 materials, no repetition at
 * all, and 26 draw calls in every pass that touches it — main colour, depth
 * prepass, shadow map — for 78 of a 90-call frame.
 *
 * Those 26 materials are not 26 different SHADERS, though. They are one shader
 * with 26 rows of data: `applyStockPbr` already expresses each as plain colour /
 * roughness / metalness / map / normalMap, so what separates two draws is which
 * texture is bound. So this concatenates their geometry into one buffer, tags
 * every vertex with which row it came from, and draws the lot with the single
 * table-driven material `uberMaterial.js` builds.
 *
 * Merging is not free and this file is mostly about what it refuses to do.
 *
 * ## Frustum culling
 *
 * A merged proxy is culled as one object, so merging can trade draw calls for
 * triangles. On the scene this was built for it costs nothing: each Sponza mesh
 * is one MATERIAL's worth of surface scattered across the whole atrium, so its
 * bounding sphere already covers the model and no camera has ever culled one.
 * Where that is not true — props spread over a landscape — merging them into one
 * blob would submit the whole landscape every frame. `MAX_MERGE_RADIUS_RATIO`
 * is the guard: a group whose merged bound is much larger than its members'
 * typical bound is refusing a real cull, and is left alone.
 *
 * ## Motion
 *
 * Merging BAKES world transforms into the vertex buffer, so a member that moves
 * would drag its geometry behind it. Instancing can afford movers (rewrite one
 * matrix); merging cannot (rewrite the mesh). Rather than ask the author to
 * label things static, this watches: a member whose world matrix changes is
 * marked unstable, permanently for the session, and the group rebuilds without
 * it. A crate that gets shoved once is never merged again.
 *
 * ## What sees what
 *
 * Members are hidden with `mesh.visible = false` and left in the scene graph —
 * the same protocol `batching.js` uses, and for its reasons: three's Raycaster
 * tests `layers` and never `visible`, so editor picking, bounds and the
 * selection outline keep resolving to the real per-entity meshes, while the
 * proxy opts out of raycasting so a click never lands on it. The renderer skips
 * an invisible object during scene projection, so a hidden member costs nothing
 * in any pass — including the occluder pass, which renders by layer.
 *
 * ⚠ THE ONE THING THAT DOES CHANGE: the GI module builds its albedo atlas by
 * reading `material.map` on the CPU (`bvh/bvhScene.js buildAlbedoAtlas`). An
 * uber material has no `.map` — its colour lives in a texture array the CPU side
 * cannot index — so a merged surface contributes its group's AVERAGE tint to
 * GI's BVH reflection albedo instead of its own texture. Direct lighting, shadows
 * and the voxel field are unaffected. That is why this system is OFF by default:
 * `settings.performance.staticMerging`.
 */

/** Fewer members than this and the bookkeeping outweighs the saved draws. */
const MIN_GROUP_SIZE = 3;

/**
 * A group is abandoned when merging it would inflate the culling bound by more
 * than this factor over the members' own mean radius. 6x lets a building's
 * worth of surfaces merge (their bounds already overlap) and stops a group of
 * scattered props from becoming one scene-sized object.
 */
const MAX_MERGE_RADIUS_RATIO = 6;

/**
 * The coarsest a locality cell may be, as a fraction of the SCENE's diagonal.
 *
 * ## Why a scene-relative floor exists at all
 *
 * `MAX_MERGE_RADIUS_RATIO` sizes a cell from the MEMBERS' own mean radius, and
 * on a room-sized scene that is the whole answer. On an imported city it is a
 * trap that scales the wrong way: a group of café chairs has a mean radius of
 * ~0.4 m, so its cell comes out at ~2 m, and forty chairs scattered down a
 * 115 m street land in forty different cells — every one of them below
 * `MIN_GROUP_SIZE`, so NONE of them merge.
 *
 * Measured on Bistro (2026-08-17), that is exactly what happened: the main pass
 * drew one material **31 times** and another 29 times with same-material
 * merging fully enabled and eligible, because the split had already diced those
 * meshes into singletons before the merge was ever attempted. The rule was
 * refusing to merge small objects at ANY distance, which is precisely backwards
 * — small scattered props are the cheapest thing to merge and the most numerous.
 *
 * ## Why this is still safe for culling
 *
 * The thing culling actually cares about is the proxy's bound relative to the
 * SCENE, not relative to its members: a 19 m blob on a 115 m street is an
 * ordinary spatial chunk, and dicing the scene into ~6 cells per axis is what a
 * chunked renderer would do anyway. Tying cell size to object size instead means
 * a scene of small objects can never be chunked at all.
 *
 * So the cell is `max(member-relative, scene-relative)` — room-sized scenes keep
 * the old behaviour exactly (their scene diagonal is small, so the floor never
 * binds), and a city gets chunks instead of singletons.
 */
const MAX_LOCALITY_CELLS_PER_AXIS = 6;

/**
 * Ceiling on the triangles ONE merged proxy may carry.
 *
 * ## Merging trades draw calls for GRANULARITY, and downstream systems buy that
 *
 * A proxy is one object to everything after merging: one frustum cull, one entry
 * in GI's reflection BVH, one occupancy slot, one surface-record owner. Those
 * systems are budgeted PER OBJECT, so a proxy that swallows a whole city block
 * does not just cost more — it can exceed a per-object limit and get dropped
 * entirely, which is worse than not merging at all.
 *
 * Measured on Bistro (2026-08-17), immediately after the scene-relative locality
 * floor let groups grow properly:
 *
 * ```
 * [gi] bvh: skipping "Merged(4)" (166676 tris > 150000 bvh cap)
 * [gi] surface records: 2036452/2097152 claimed, triangles 4241682/2097152,
 *      300306 dense cells exceed the per-cell exact-triangle limit
 * ```
 *
 * The triangle pool went from comfortably inside its budget to **2× over**, and
 * the count of cells falling back to coarse voxel-box hits went **24 701 →
 * 300 306**. On screen that is the user's report: *"when I start moving the
 * camera, there are black patches in some area, that starts filling with light,
 * or turning black again"* — surfaces whose exact triangles no longer fit lose
 * their records, and which ones lose them changes as the GI detail box follows
 * the camera.
 *
 * So the budget is set BELOW `MAX_TRIS_PER_BVH_MESH` (150 000 in
 * `gi/bvh/bvhScene.js`) with headroom, because a proxy that trips that cap is
 * silently excluded from exact reflections and traced shadows. A group over
 * budget is CHUNKED, not refused: the draw-call saving is kept, the granularity
 * is kept, and nothing downstream gets an object it cannot represent.
 *
 * ⚠ This is a coupling to another module's constant and it should stay
 * conservative. Raising it without checking what GI does with a proxy that size
 * reintroduces exactly the artifact above, which reads as a GI bug and not as a
 * merging one.
 */
const MAX_MERGED_TRIANGLES = 120_000;

/** Triangles a member contributes to a merged proxy. */
function memberTriangles(member) {
  const geometry = member.mesh.geometry;
  const count = geometry.index ? geometry.index.count : (geometry.attributes.position?.count ?? 0);
  return count / 3;
}

/**
 * Chunks a spatially-local group so no proxy exceeds `MAX_MERGED_TRIANGLES`.
 *
 * Runs AFTER `#splitByLocality`, so the members handed here are already near
 * each other and a greedy sequential pack keeps each chunk local — there is no
 * need (and no benefit) to re-cluster spatially.
 *
 * A single member larger than the budget is passed through as its own chunk
 * rather than refused: it was one draw call before merging and it stays one,
 * which is the correct no-op.
 */
function splitByTriangleBudget(members) {
  let total = 0;
  for (const member of members) total += memberTriangles(member);
  if (total <= MAX_MERGED_TRIANGLES) return [members];

  const chunks = [];
  let current = [];
  let running = 0;
  for (const member of members) {
    const tris = memberTriangles(member);
    if (current.length && running + tris > MAX_MERGED_TRIANGLES) {
      chunks.push(current);
      current = [];
      running = 0;
    }
    current.push(member);
    running += tris;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

/**
 * How many times `#splitByLocality` may subdivide a group.
 *
 * Each level re-measures the bucket it was handed, so a scene with wildly
 * mixed object sizes converges in a few levels. The cap is a termination
 * guarantee, not a tuning knob: without it a pathological set (identical
 * centres, differing radii) could recurse until the stack gave out.
 */
const MAX_SPLIT_DEPTH = 6;

/**
 * How many frames one full pass of the per-frame watchers is spread over.
 *
 * See the amortisation note in `sync()`. Four is chosen so a material edit
 * lands within ~66 ms at 60 fps — below the threshold where an author would
 * read it as "the viewport did not update" — while cutting the steady-state
 * sweep to a quarter.
 */
const WATCH_WINDOW_FRAMES = 4;

/** How often `#report` may print the rebuild-rate warning. */
const REBUILD_REPORT_INTERVAL_MS = 10_000;

/**
 * Ceiling on the texture memory ONE group's arrays may allocate, in bytes.
 *
 * A merged group copies every source texture into an array, so the arrays are
 * pure addition — the originals stay resident for the hidden members' materials
 * and for anything else in the project that shares them. That bill is easy to
 * underestimate and expensive to get wrong: on the scene this was developed
 * against, merging added ~290 MB of texture memory and the D3D12 device was
 * subsequently lost with DXGI_ERROR_DEVICE_HUNG while allocating a buffer.
 *
 * The ratio is what makes a budget the right shape rather than a flat cap. A
 * group of three 2048² materials costs ~90 MB to save two draw calls; a group of
 * twenty 1024² ones costs ~110 MB to save nineteen. Same order of memory, an
 * order of magnitude apart in value — so the test below is per-draw-saved, and
 * this is the ceiling on the whole group as a backstop.
 */
const MAX_GROUP_TEXTURE_BYTES = 192 * 1024 * 1024;

/** Refuse a group that spends more than this much texture memory per draw call saved. */
const MAX_BYTES_PER_DRAW_SAVED = 24 * 1024 * 1024;

/**
 * Ceiling on the texture memory ALL merged groups may add, scene-wide.
 *
 * The two budgets above are PER GROUP, and on a room-sized scene that is the
 * same thing — a handful of groups, so bounding each bounds the total. An
 * imported city is not that scene. Bistro formed **112 groups**, every one of
 * them individually affordable (the largest cost ~1.5 MB per draw saved against
 * a 24 MB allowance), and summed to **630 MB of pure addition** — on top of the
 * originals, which stay resident for the hidden members. Texture memory was
 * measured climbing past 700 MB with a JS heap of several GB behind it, on a
 * machine whose D3D12 device has already been lost once to exactly this
 * (see MAX_GROUP_TEXTURE_BYTES).
 *
 * A per-item budget with no aggregate is not a budget; it is a rate limit. This
 * is the aggregate. Groups are taken in the order `#rebuild` forms them and the
 * first one that would cross the line stops merging for that pass — the scene
 * keeps the draw-call savings it has already paid for, and the remainder simply
 * draw normally, which is what they did before merging existed.
 *
 * The DEFAULT only; the live ceiling is `merging.textureBudgetBytes`, so a
 * project on a 24 GB card can raise it and a test can lower it far enough to
 * exercise the path without allocating half a gigabyte of pixels to do so.
 *
 * 768 MB, not the 256 MB it shipped at. The first number was chosen while
 * merging was rebuilding in a loop and memory was the emergency; with the loop
 * fixed and the uber cache actually hitting, the tradeoff inverted on the
 * measured scene: at 256 MB Bistro merged 51 of 112 groups, the frame stayed
 * DRAW-BOUND (renderEncode 23.5 ms of a 45.4 ms CPU frame), and
 * `profile.textures` put the renderer's ENTIRE texture residency at 287 MB —
 * the estimate this budget gates on prices a fully-compressed scene's arrays
 * at block-copy cost, so the historic DEVICE_HUNG number (290 MB of RGBA8
 * arrays, and on the iGPU era at that) is not the regime a Basis-compressed
 * project is in. A scene that still overruns 768 MB is spending texture memory
 * faster than it saves draws and should be looked at, not accommodated.
 */
const DEFAULT_TOTAL_TEXTURE_BYTES = 768 * 1024 * 1024;

/**
 * Floor on the gap between rebuilds, in milliseconds.
 *
 * ⚠ THIS IS NOT A MICRO-OPTIMISATION, IT IS A CRASH FIX. Merging subscribes to
 * `hierarchy-changed`, and in PLAY MODE that fires constantly — a script
 * spawning a projectile, a pool recycling one. `batching.js` shares the
 * subscription and can afford it, because its rebuild is scene-graph
 * bookkeeping. This system's rebuild rasterises every source texture into a new
 * array, so an unthrottled invalidation storm allocates the group's entire
 * texture footprint per frame: measured at 351 ms CPU frames, a 6 GB JS heap and
 * 3 fps on the scene this was developed against, from ~160 MB of arrays being
 * rebuilt about forty times.
 *
 * The throttle is the backstop. The real fix is `_uberCache` below, which makes
 * a rebuild that changed no materials cost nothing — a spawned cannonball has no
 * bearing on Sponza's twenty stone materials, and it should not cost a single
 * texture decode to prove it.
 */
const MIN_REBUILD_INTERVAL_MS = 250;

/**
 * How long the scene must stay QUIET before a rebuild runs.
 *
 * The throttle above bounds how OFTEN merging rebuilds; this bounds how EAGER
 * it is, and loading needs the second. An imported scene announces every mesh
 * as its geometry resolves, so a rate limit alone re-merges the whole world
 * every quarter second for the entire load — and a merge is not cheap once it
 * works: it copies every merged vertex into new typed arrays and stacks every
 * texture array again. Waiting for quiet turns a load into one merge.
 */
const SETTLE_MS = 400;

/**
 * Ceiling on how long settling may defer a rebuild.
 *
 * Without it, a scene that changes continuously — an animated transform in the
 * editor, a watcher rewriting assets — would never go quiet and would never
 * merge at all. This makes the worst case "merges every two seconds" instead
 * of "silently stops merging", which is the failure a settle-timer invites.
 */
const MAX_DEFER_MS = 2000;

/**
 * Hard ceiling on how long a GROWING scene may push the deferral clock forward.
 *
 * `MAX_DEFER_MS` above is the ceiling for a scene that keeps changing at a
 * stable size; this is the separate, much larger one for a scene that is still
 * streaming meshes in, where every early merge is guaranteed to be redone. A
 * large model import runs tens of seconds, so this is generous on purpose — the
 * failure it guards against (never merging at all) needs a bound, but merging
 * ONE second sooner during a load has no value and costs a full re-rasterisation
 * of every texture array built so far.
 */
const MAX_LOAD_DEFER_MS = 60_000;

/**
 * Ceiling on the texture memory held by CACHED-but-unused uber materials.
 *
 * Budgeted in bytes rather than entries, because entries are not the unit that
 * hurts. An eight-entry cache sounds small and is 1.3 GB when each entry owns
 * 160 MB of texture arrays: play-mode texture memory was measured climbing
 * 613 → 741 → 869 MB in twenty seconds, one cache miss at a time, on the way to
 * a second device loss.
 *
 * ⚠ IT MUST EXCEED `textureBudgetBytes`, OR THE CACHE CANNOT DO ITS JOB. Only
 * IDLE entries are counted here — a group currently drawing is never evicted —
 * so this bounds what survives BETWEEN rebuilds. Set below the scene ceiling it
 * guarantees that a rebuild evicts arrays the very next rebuild asks for again,
 * which is the miss the cache exists to prevent: at 128 MB against a 256 MB
 * scene, Bistro could retain at most half its own arrays and re-rasterised the
 * rest every pass. That failure was shipped once already, as two constants that
 * drifted apart — so the live ceiling is now DERIVED from the budget
 * (`#cacheCeilingBytes`: 25% above `textureBudgetBytes`, floored here) and the
 * invariant cannot silently break again.
 */
const MIN_CACHED_TEXTURE_BYTES = 320 * 1024 * 1024;

/** Components that own their entity's mesh in ways a baked vertex buffer cannot represent. */
const EXCLUSIVE_COMPONENTS = [
  "skinnedmesh",
  "terrain",
  "geometryModifiers",
  "rigidbody",
  "lodgroup",
  "impostor",
  "splinemesh",
  "instancer",
];

/** Attributes carried through a merge. Anything else on a source geometry is dropped. */
const MERGED_ATTRIBUTES = ["position", "normal", "uv", "uv1"];

/**
 * WHY a mesh cannot join a SAME-MATERIAL merge, or `null` when it can.
 *
 * ## This is the cheap merge, and it should have been the FIRST one
 *
 * The uber path above answers "how do I draw N meshes with N DIFFERENT materials
 * in one call", and its answer — copy every source texture into an array and
 * shade from a table — is expensive and lossy: it costs texture memory that is
 * pure ADDITION (the originals stay resident for the hidden members), it mints a
 * new `Uber(n)` material that GI must compile a fresh shader variant for, and it
 * can only express the four `UBER_SLOTS`, so `uberIncompatibility` turns away
 * every material with a custom node, an emissive map or an AO map.
 *
 * None of that applies when the members already share ONE material instance.
 * There is no table to build, no texture to copy, and no new material to
 * compile — the proxy is handed `members[0].material`, the identical object the
 * members were drawing with. The merge is then pure geometry concatenation:
 * bytes of texture memory ZERO, new shader variants ZERO, and the material's own
 * complexity completely irrelevant, because it is never inspected.
 *
 * Measured on Bistro (2026-08-17), this is not a marginal case. The main pass
 * submitted **484 draws over 161 distinct materials** — one material drawn 40
 * times, the next 27, then 21, 19, 17, 16 — every one of them a group the uber
 * path had refused (custom nodes) or run out of texture budget for, and every
 * one of them mergeable here for free.
 *
 * So the gate is narrow on purpose. Only two things can actually go wrong:
 *
 * - **Emissive surfaces.** GI promotes an emissive mesh to a light emitter keyed
 *   on the mesh, so merging two of them into one proxy MOVES the light to the
 *   combined centroid. Same reasoning as `uberIncompatibility`'s, and the same
 *   refusal — this one is about where light comes from, not about shading.
 * - **A material that reads a per-mesh attribute the merge may drop.** Handled
 *   by keying the group on its ATTRIBUTE SET rather than refused here, so a mesh
 *   with no `uv` merges with other uv-less meshes instead of silently stripping
 *   the channel off the ones that have it (`mergeGeometries` keeps an attribute
 *   only when EVERY member has it — that is where "Vertex attribute uv not
 *   found" comes from).
 *
 * Everything else the uber path refuses is fine here, and that is the point.
 */
function sameMaterialRefusal(material) {
  if (!material || Array.isArray(material)) return "no single material";
  // Not the uber material's own table shader: it reads `materialIndex`, which a
  // same-material merge deliberately does not write. Reusing one verbatim would
  // shade every vertex from row 0.
  if (material.userData?.uberMaterial) return "uber table material";
  if (emissiveRefusal(material)) return "emissive surface";
  return null;
}

/**
 * Does this material emit light, as GI understands the question?
 *
 * ⚠ `material.emissive` ALONE IS THE WRONG QUESTION, AND ASKING IT COST THE
 * WHOLE EMITTER PATH (2026-08-17). Engine material assets carry emission in
 * `emissiveNode`, and GI's own resolver says so in as many words:
 *
 *   "Not `material.emissive` — engine material assets carry the real value in
 *    `emissiveNode` and the top-level field sits at stale black."
 *   — lightTree.js, `describeEmitter`
 *
 * So the refusal above was interrogating the one field documented as stale
 * black. Every authored emissive mesh in the user's Bistro read
 * "not emissive" to merging, got welded into a proxy, and GI then fitted ONE
 * emitter to the combined bounds. The live ledger is unambiguous — every top
 * emitter in the scene is a merge:
 *
 *   "Merged(10)" P=8.6 area=2.7e-1m² fill=0.001 | "Merged(3)" fill=0.001 | …
 *
 * `fill` is triangle area over the fitted shape's cross-section, so welding
 * ten 2 cm bulbs spread over 8 m into one proxy collapses it to 0.001 and
 * §13.7g's sparse correction then dims their radiance 1000x — correctly, for
 * the shape it was handed. Merging was MANUFACTURING the sparse emitters that
 * correction exists to tame, which is why turning emissive strength up to 1000
 * still lit nothing.
 *
 * Kept deliberately broad: `emissiveNode` present at all is enough, because a
 * node this resolver cannot fold to a constant is exactly the case we must not
 * silently merge. A false refusal costs one draw call; a false accept moves a
 * light and dims it by three orders of magnitude.
 */
function emissiveRefusal(material) {
  if (!material) return false;
  if (material.emissiveNode) return true;
  const e = material.emissive;
  return !!e && typeof e.getHex === "function" && e.getHex() !== 0x000000;
}

/**
 * The attribute channels a geometry actually carries, as a group-key fragment.
 *
 * `mergeGeometries` keeps an attribute only if EVERY member has it, so a group
 * mixing uv-ful and uv-less meshes silently strips uv from the whole merge and
 * the material samples a channel that is no longer there. Splitting on the set
 * up front makes that unrepresentable rather than merely unlikely.
 */
/**
 * Where a member actually SITS in the world, as one shared definition.
 *
 * ⚠ NOT `setFromMatrixPosition(mesh.matrixWorld)`, and the difference is not
 * academic. A GLB exporter routinely bakes the node transform into the VERTEX
 * DATA and leaves every mesh's matrix at identity — Bistro is exactly that
 * shape. Read the matrix translation on such a scene and all 1500 meshes report
 * the origin: the scene measures **0 m across**, any scene-relative rule
 * silently evaluates to zero, and the failure is invisible because a zero floor
 * is indistinguishable from "the floor did not bind".
 *
 * That is not a hypothetical — it shipped for one boot and the merge report's
 * "Scene diagonal 0m" is what caught it, on a scene whose content is 109 × 115 m.
 * The geometry's bounding-sphere centre carries the baked offset, so transforming
 * THAT is the only reading that works for both conventions.
 */
function memberWorldCenter(member, target) {
  const geometry = member.mesh.geometry;
  if (!geometry.boundingSphere) geometry.computeBoundingSphere();
  const sphere = geometry.boundingSphere;
  return sphere
    ? target.copy(sphere.center).applyMatrix4(member.mesh.matrixWorld)
    : target.setFromMatrixPosition(member.mesh.matrixWorld);
}

function attributeSignature(geometry) {
  let signature = "";
  for (const name of MERGED_ATTRIBUTES) {
    if (geometry.attributes[name]) signature += name[0] + (geometry.attributes[name].itemSize | 0);
  }
  return signature;
}

/**
 * Everything about a material that the bake copied rather than referenced.
 * Two materials with the same signature produce a byte-identical merge, so a
 * change to any of it is a rebuild.
 */
const SIGNATURE_FIELDS = [
  "map.uuid", "map.version",
  "normalMap.uuid", "normalMap.version",
  "roughnessMap.uuid", "roughnessMap.version",
  "metalnessMap.uuid", "metalnessMap.version",
  "color", "roughness", "metalness", "normalScale",
];

function materialSignature(material) {
  return [
    material.map?.uuid ?? "-",
    material.map?.version ?? -1,
    material.normalMap?.uuid ?? "-",
    material.normalMap?.version ?? -1,
    material.roughnessMap?.uuid ?? "-",
    material.roughnessMap?.version ?? -1,
    material.metalnessMap?.uuid ?? "-",
    material.metalnessMap?.version ?? -1,
    material.color?.getHex() ?? -1,
    material.roughness,
    material.metalness,
    material.normalScale?.x ?? 1,
  ].join("|");
}

/**
 * GPU bytes the arrays for `materials` would allocate — the price of merging
 * them, payable before a single one is built.
 *
 * `4/3` is the mip chain: a full pyramid adds a third again over the base level.
 * Layers are counted per DISTINCT texture plus one neutral fill, matching what
 * `buildLayeredTexture` actually stacks.
 */
function arrayTextureBytes(materials) {
  let total = 0;
  // Grouped by ARRAY, not by slot: roughness and metalness share one array
  // (see `buildUberMaterial`), and in a glTF import they are the same ORM
  // texture, so counting them separately would price this at double what it
  // allocates and refuse groups that are affordable.
  for (const slots of [["map"], ["normalMap"], ["roughnessMap", "metalnessMap"]]) {
    const distinct = new Set();
    for (const material of materials) {
      for (const slot of slots) if (material[slot]) distinct.add(material[slot]);
    }
    if (!distinct.size) continue;
    // ⚠ PRICED PER TEXTURE, not from the first one. Sampling `[...distinct][0]`
    // and applying its branch to the whole slot meant a single uncompressed
    // straggler charged every layer at RGBA8 rates: on a fully Basis-compressed
    // project that read as ~330 MB of arrays against 39.6 MB of texture memory
    // actually resident, a 6-8x over-charge. It is a BUDGET, so over-charging
    // is not conservative — it silently refuses groups that are affordable.
    let compressed = 0;
    let plainLayers = 0;
    let width = 0;
    let height = 0;
    for (const texture of distinct) {
      const t = /** @type {any} */ (texture);
      if (t.isCompressedTexture || t.isCompressedArrayTexture) {
        // Copied block-for-block, mip chain included in these byte lengths.
        for (const mip of t.mipmaps ?? []) compressed += mip.data?.byteLength ?? 0;
      } else {
        plainLayers++;
        width = Math.max(width, t.image?.width ?? 0);
        height = Math.max(height, t.image?.height ?? 0);
      }
    }
    total += compressed;
    // `+1` is the synthesised neutral layer, `4/3` the mip pyramid — both of
    // which only the uncompressed path allocates.
    if (plainLayers) total += width * height * 4 * (plainLayers + 1) * (4 / 3);
  }
  return total;
}

/** True when `entity` and every ancestor are enabled for the current mode. */
function entityVisible(entity, modeFlag) {
  for (let node = entity; node; node = node.parent) {
    if (node[modeFlag] === false) return false;
    if (node.object3D.visible === false) return false;
  }
  return true;
}

export class MergeSystem {
  constructor(engine) {
    this.engine = engine;
    this.enabled = false;
    /** @type {any[]} */
    this.groups = [];
    this._dirty = true;
    this._unsubscribe = [];
    /** Entities observed to move. Never merged again this session. */
    this._unstable = new Set();
    this._building = false;
    /** Built uber materials by material-set key — see MIN_REBUILD_INTERVAL_MS. */
    this._uberCache = new Map();
    this._lastRebuildAt = -Infinity;
    this._rebuildCount = 0;
    /** When the last invalidation landed, and when this dirty spell began. */
    this._dirtiedAt = -Infinity;
    this._dirtySince = 0;
    /**
     * When the CURRENT load-deferral hold began — the fixed origin that
     * MAX_LOAD_DEFER_MS is measured from. Cleared only when the scene reports
     * nothing pending, so the bound cannot be re-armed by the very signal it
     * bounds (which is how the previous version made it dead code).
     */
    this._deferHoldStart = 0;
    this._deferExhaustedWarned = false;
    this._lastPendingCount = 0;
    /**
     * Ready-mesh count at the last deferral check — the "is the scene still
     * streaming in" signal. -1 so the first check always registers a change
     * without treating an empty scene as growth.
     */
    this._lastPopulation = -1;
    /** Round-robin cursor for the amortised per-frame watchers (see `sync`). */
    this._watchCursor = 0;
    /** Why the pending rebuild was asked for, and a lifetime tally by reason. */
    this._invalidateReason = "initial";
    this._invalidateTally = {};
    /**
     * Scene-wide ceiling on ADDED texture-array memory, and the current pass's
     * spend against it. See DEFAULT_TOTAL_TEXTURE_BYTES.
     */
    this.textureBudgetBytes = DEFAULT_TOTAL_TEXTURE_BYTES;
    this._textureBudgetSpent = 0;
    this._textureBudgetStoppedAt = 0;
    /** Set when the CURRENT frame is already wrong — bypasses the throttle. */
    this._urgent = true;
  }

  setEnabled(enabled) {
    const next = !!enabled;
    if (next === this.enabled) return;
    this.enabled = next;
    if (next) {
      this._dirty = true;
      // Turning the system on must take effect now, not at the next tick the
      // throttle happens to allow.
      this._urgent = true;
      // ⚠ WHILE PLAYING, THE MERGE IS FROZEN. Entering play rebuilds once; after
      // that, `hierarchy-changed` and `component-changed` are ignored until play
      // ends. This is not a workaround, it is what "static merging" means — every
      // engine bakes it at load and leaves it alone. Reacting to a running game's
      // scene graph is both wrong (a spawned projectile has no bearing on which
      // walls share a material) and ruinous: each rebuild that misses the cache
      // allocates the group's whole texture footprint again, which is how a
      // cannonball script turned into 351 ms frames and a 6 GB heap.
      const invalidate = (reason) => {
        if (this.engine.playing) return;
        this.invalidate(reason);
      };
      this._unsubscribe = [
        this.engine.on("hierarchy-changed", () => invalidate("hierarchy-changed")),
        this.engine.on("component-changed", (event) => {
          if (event?.componentType !== "mesh" && event?.componentType !== "model") return;
          // ── A MEMBER WE ALREADY HOLD IS NOT NEWS ─────────────────────────
          //
          // `MeshComponent#announceSwap` fires on every material-asset
          // notification, and a GI scene generates those continuously: GI's
          // compile wave re-resolves materials, each resolve announces, and
          // this handler turned every one into a rebuild. Measured on Bistro
          // AFTER the resurrect fix: `component-changed:mesh` **x4911 and
          // still climbing**, driving 2-3 rebuilds every 10 s forever, and each
          // rebuild changed the mesh set GI collects (1532 → 1473 → 1328 →
          // 1112) which forced another GI rebuild. The loop survived losing its
          // other half.
          //
          // For a mesh this system already merged, the announcement carries no
          // information it does not already have a PRECISE detector for:
          // `#watchForMaterialEdits` compares the real signature of every
          // merged material and fires within WATCH_WINDOW_FRAMES. So a genuine
          // edit is still caught, one frame group later, and the ~99% of
          // announcements that change nothing cost nothing.
          //
          // A mesh we do NOT hold is different — a material swap may have just
          // made it mergeable — so those still invalidate immediately.
          const mesh = this.engine.entities.get(event.entityId)?.components.get("mesh")?.mesh;
          if (mesh?.userData.mergedInto) return;
          invalidate(`component-changed:${event.componentType}`);
        }),
        // NOT filtered: entering and leaving play is exactly when the merge set
        // legitimately changes (per-mode enable flags), and it happens twice.
        this.engine.on("play-changed", () => this.invalidate("play-changed")),
      ];
    } else {
      for (const off of this._unsubscribe) off();
      this._unsubscribe = [];
      this.#teardown();
      this.#clearCache();
    }
  }

  /** Releases every cached uber material and the texture arrays it owns. */
  /** Idle-entry ceiling, derived so it always clears the scene budget. */
  #cacheCeilingBytes() {
    return Math.max(MIN_CACHED_TEXTURE_BYTES, Math.round(this.textureBudgetBytes * 1.25));
  }

  #clearCache() {
    for (const entry of this._uberCache.values()) entry.dispose();
    this._uberCache.clear();
  }

  /**
   * `reason` is diagnostic only, and it exists because this system's failure
   * mode is a REBUILD LOOP whose cost lands somewhere else entirely: every
   * regrouping mints fresh uber materials, and on a GI scene each new material
   * is a shader variant that costs a full compile wave (measured at 68866 ms
   * and 77381 ms on Bistro). When that happens the console shows GI compiling
   * for a minute and says nothing about who asked for it. `#report` prints this
   * alongside the group counts so the trigger is named at the scene of the
   * crime rather than inferred.
   */
  invalidate(reason = "unknown") {
    this._dirty = true;
    this._invalidateReason = reason;
    this._invalidateTally[reason] = (this._invalidateTally[reason] ?? 0) + 1;
    this._dirtiedAt = performance.now();
    if (this._dirtySince === 0) this._dirtySince = this._dirtiedAt;
  }

  /**
   * Per-frame entry point, called from the same place `batching.sync()` is so
   * both agree with the scene graph before any pass reads it.
   */
  sync() {
    if (!this.enabled || this._building) return;
    if (!this._dirty && this.groups.length === 0) return;
    if (this._dirty) {
      // Stay dirty and come back: an invalidation storm must cost one rebuild
      // per interval, not one per frame. See MIN_REBUILD_INTERVAL_MS. The first
      // build is never delayed — the scene would draw unmerged until the
      // timer elapsed, which is a visible pop for no benefit.
      const now = performance.now();
      // ── WAIT FOR THE SCENE TO STOP CHANGING ──────────────────────────────
      //
      // A rate limit is the wrong shape for LOADING. Every one of 1532 meshes
      // announces itself as its `.geom` resolves, and a fixed interval turns
      // that into one full re-merge every 250 ms for the whole load — each of
      // which copies every merged vertex in the scene into fresh typed arrays
      // and rebuilds every texture array. Measured after the spatial split
      // made merging actually produce groups: the JS heap went from ~700 MB to
      // 3.3 GB, and the GC bill showed up as frame time nothing was
      // attributing.
      //
      // Settling instead collapses the entire load into ONE merge at the end.
      // MAX_DEFER keeps that bounded: a scene that never stops changing (an
      // animated transform in the editor) still merges, just no more often
      // than that, rather than starving forever waiting for quiet.
      const settling = now - (this._dirtiedAt ?? 0) < SETTLE_MS;
      // ── STARVATION ≠ STILL LOADING ───────────────────────────────────────
      //
      // MAX_DEFER exists for a scene that never goes quiet at a STABLE size —
      // an animated transform in the editor, a watcher rewriting assets. A
      // scene that is still STREAMING IN is the opposite case: waiting is
      // exactly right, because every mesh that has not arrived yet will force
      // the whole merge to be redone.
      //
      // The two were indistinguishable, so a long load hit the 2 s cap over and
      // over. Measured on the Bistro scene, one load: six rebuilds at :07, :13,
      // :14, :18, :24, :31, whose texture arrays grew 8 → 217 → 514 → 581 →
      // 629 MB. Every one of those re-rasterised every array built so far, for
      // ~2 GB of allocation churn that the JS heap then had to collect — and
      // five of the six results were thrown away seconds later anyway.
      //
      // The discriminator is how much of the scene has MATERIALISED, which is
      // not the same as how many entities exist: a `.scene` file restores every
      // entity at once and then streams geometry in behind them, so entity
      // count is flat for the whole load while the mergeable population climbs
      // from nothing. `#scenePopulation` counts what `#collectGroups` would
      // accept past its "mesh not built yet"/"assets still loading" gates,
      // PLUS how many meshes are still streaming their assets. While either
      // says the load is unfinished the deferral clock is pushed forward,
      // bounded by MAX_LOAD_DEFER_MS so a scene that never settles still
      // merges.
      const { ready, pending } = this.#scenePopulation();
      // `pending > 0` is a HARD hold, and it has to be a return: transcode
      // waves pause for seconds without being done, and in those gaps the
      // SETTLE_MS release below fired — one Bistro load committed incremental
      // generations at 887 then 952 meshes, each staging fresh texture arrays
      // and handing GI a different mesh set to rebuild against. Merely pushing
      // the starvation clock gates the wrong path; while anything is pending,
      // nothing merges. Bounded by MAX_LOAD_DEFER_MS from a FIXED origin,
      // cleared only when pending hits zero — the previous bound re-armed the
      // clock it was bounding and was dead code.
      //
      // A moving READY count stays a soft push (not a return): geometry
      // materialising raises no pending flag, but it does invalidate as it
      // lands, so the settle timer covers it — and a hard return here would
      // break the "first sync after setEnabled merges immediately" contract,
      // since the first look at any scene registers as a population change.
      if (pending > 0) {
        if (!this._deferHoldStart) this._deferHoldStart = now;
        // Progress re-arms the bound: it measures a STALLED load, not a long
        // one — Bistro's transcode tail runs 2+ minutes and releasing mid-tail
        // is the dribble this hold exists to stop. A broken asset leaves the
        // count frozen and the bound does its job.
        if (pending !== this._lastPendingCount) {
          this._lastPendingCount = pending;
          this._deferHoldStart = now;
        }
        if (now - this._deferHoldStart < MAX_LOAD_DEFER_MS) {
          this._lastPopulation = ready;
          if (this._dirtySince > 0) this._dirtySince = now;
          return;
        }
        if (!this._deferExhaustedWarned) {
          this._deferExhaustedWarned = true;
          console.warn(
            `[merging] load deferral exhausted after ${(MAX_LOAD_DEFER_MS / 1000).toFixed(0)}s without ` +
              `progress (${pending} asset load(s) still pending) — merging what has arrived; ` +
              `the rest stay unmerged until they land.`,
          );
        }
      } else {
        this._deferHoldStart = 0;
        this._deferExhaustedWarned = false;
        this._lastPendingCount = 0;
      }
      if (ready !== this._lastPopulation) {
        this._lastPopulation = ready;
        if (this._dirtySince > 0) this._dirtySince = now;
      }
      const starved = this._dirtySince > 0 && now - this._dirtySince >= MAX_DEFER_MS;
      if (settling && !starved && !this._urgent) return;
      const throttled =
        this._rebuildCount > 0 && now - this._lastRebuildAt < MIN_REBUILD_INTERVAL_MS;
      // URGENT REBUILDS ARE NEVER THROTTLED, and the distinction is the whole
      // reason for the flag. The throttle exists for `hierarchy-changed`, whose
      // storms are unbounded and whose contents (a spawned projectile) have
      // nothing to do with what is merged. A member that MOVED, or a material
      // that was EDITED, is different in kind: the proxy on screen is already
      // showing the wrong thing, and holding that for a quarter second to save
      // a rebuild the cache has made cheap would trade a real artifact for
      // nothing. Both are self-limiting anyway — a mover is marked unstable and
      // never merged again, an edit lands once.
      if (throttled && !this._urgent) return;
      this._urgent = false;
      this._lastRebuildAt = now;
      this._rebuildCount++;
      this._dirty = false;
      this._dirtySince = 0;
      this.engine.scene.updateMatrixWorld();
      this.#rebuild();
      return;
    }
    if (!this.groups.length) return;
    this.engine.scene.updateMatrixWorld();
    // ── AMORTISED OVER WATCH_WINDOW_FRAMES ───────────────────────────────────
    //
    // Both watchers used to sweep EVERY group EVERY frame, on a scene that by
    // construction is not changing — merging only keeps a group while it stays
    // static. Measured on Bistro at world scale: 1.9 ms per frame, 6% of a
    // CPU-bound tick, for 1023 member matrices compared element-by-element plus
    // a `materialSignature()` per merged material. That signature is a joined
    // STRING, so the sweep also allocated ~200 short-lived strings per frame —
    // garbage on the hot path of a scene already fighting its heap.
    //
    // A round-robin slice keeps the same guarantees a few frames later, and
    // neither watcher is latency-critical: a moved member is already drawing in
    // the wrong place by the time it is noticed (the rebuild it triggers costs
    // far more than WATCH_WINDOW_FRAMES), and a .mat edit resolving in ~4
    // frames is imperceptible. Nothing can be MISSED — the cursor visits every
    // group in order, and both checks compare against cached state that does not
    // expire.
    const total = this.groups.length;
    const window = Math.max(1, Math.ceil(total / WATCH_WINDOW_FRAMES));
    const start = this._watchCursor % total;
    const end = Math.min(total, start + window);
    this.#watchForMotion(start, end);
    // Materials are authored, not simulated: nothing edits a .mat mid-game.
    if (!this.engine.playing) this.#watchForMaterialEdits(start, end);
    this._watchCursor = end >= total ? 0 : end;
  }

  /**
   * Rebuilds when a source material's appearance changed underneath the bake.
   *
   * There is no event for this. `materialAsset.js` notifies subscribers only
   * when a material's IDENTITY or renderability changes, on the stated grounds
   * that "in-place edits mutate the shared instance and need no notification" —
   * true for everyone who reads the live material each frame, and false for this
   * system, which copied its pixels and scalars into an array texture and a
   * uniform buffer. Without this, editing a .mat leaves the viewport showing the
   * old one until something unrelated invalidates the group, and the async
   * texture load that lands one frame after a merge never appears at all.
   *
   * A signature compare over the merged materials is a few dozen property reads
   * per frame — cheaper than the plumbing an event would need, and it cannot
   * miss a mutation nobody thought to announce.
   */
  #watchForMaterialEdits(start = 0, end = this.groups.length) {
    for (let g = start; g < end; g++) {
      const group = this.groups[g];
      // ⚠ BOUNDED BY `signatures`, NOT BY `materials`. A same-material group
      // carries its one material (GI and the reports read it) but an EMPTY
      // signature list, because it copied nothing and has nothing to go stale.
      // Walking `materials` instead would compare a live signature against
      // `undefined` on every sweep, differ every time, and invalidate the scene
      // four frames a second forever — a rebuild loop with no edit behind it.
      for (let i = 0; i < group.signatures.length; i++) {
        const signature = materialSignature(group.materials[i]);
        if (signature === group.signatures[i]) continue;
        // NAME THE FIELD. "a material changed" is not actionable when the
        // rebuild it triggers costs a GI compile wave — and the usual culprit
        // is a texture `version` bump (three increments it on every
        // `needsUpdate`), which is a very different problem from an author
        // editing a colour. Only the first differing field is reported; that is
        // enough to tell those two apart.
        const before = String(group.signatures[i]).split("|");
        const after = signature.split("|");
        let field = "?";
        for (let f = 0; f < SIGNATURE_FIELDS.length; f++) {
          if (before[f] !== after[f]) {
            field = `${SIGNATURE_FIELDS[f]} ${before[f]}->${after[f]}`;
            break;
          }
        }
        this._invalidateReason = `material-edit:${field}`;
        this._invalidateTally[`material-edit:${SIGNATURE_FIELDS.find((_, f) => before[f] !== after[f]) ?? "?"}`] =
          (this._invalidateTally[`material-edit:${SIGNATURE_FIELDS.find((_, f) => before[f] !== after[f]) ?? "?"}`] ?? 0) + 1;
        // ⚠ DIRTY BUT NOT URGENT, and the distinction is a startup cost.
        // "An edit lands once" is true when a human edits a .mat and false
        // during LOADING, where every texture that resolves moves a signature:
        // an imported city walked this hundreds of times, and each urgent
        // rebuild bypassed the throttle to re-scan every entity in the scene.
        // Staying merely dirty caps that at one rebuild per
        // MIN_REBUILD_INTERVAL_MS, so the worst case is a quarter second of a
        // stale proxy instead of a visible minute of rebuilding.
        this._dirty = true;
        return;
      }
    }
  }

  /**
   * A merged member that moved invalidates its whole group — the movement is
   * already baked out of the vertex buffer, so the frame it is noticed the
   * proxy is showing that member in its old place. Marking it unstable and
   * rebuilding restores it as an ordinary mesh and never merges it again.
   */
  #watchForMotion(start = 0, end = this.groups.length) {
    let moved = false;
    for (let g = start; g < end; g++) {
      const group = this.groups[g];
      for (let i = 0; i < group.members.length; i++) {
        const elements = group.members[i].mesh.matrixWorld.elements;
        const cached = group.matrices[i];
        for (let e = 0; e < 16; e++) {
          if (cached[e] === elements[e]) continue;
          this._unstable.add(group.members[i].entityId);
          moved = true;
          break;
        }
      }
    }
    if (moved) {
      this._dirty = true;
      this._urgent = true;
      this._invalidateReason = "member-moved";
      this._invalidateTally["member-moved"] = (this._invalidateTally["member-moved"] ?? 0) + 1;
    }
  }

  /* ---------------------------------------------------------------------- */

  /**
   * How many mesh components have actually materialised — the cheap prefix of
   * `#collectGroups`' candidate walk, stopping at the gates that a still-loading
   * scene fails ("mesh not built yet", "material not renderable yet").
   *
   * Used only as a CHANGE signal for the load deferral in `sync()`, so it does
   * not have to agree with the final candidate count — it has to move while the
   * scene is streaming in and hold still once it has arrived, which these few
   * boolean reads per entity do. Deliberately not the full walk: the expensive part of a
   * rebuild is rasterising texture arrays, and paying a signature comparison per
   * material per frame to decide whether to defer would cost more than it saves.
   */
  #scenePopulation() {
    let ready = 0;
    let pending = 0;
    for (const entity of this.engine.entities.values()) {
      const component = entity.components.get("mesh");
      if (!component?.mesh) continue;
      // A placeholder-material mesh is renderable long before its real material
      // and textures arrive, so `ready` alone "settled" while materials were
      // still streaming. But a MOVING count is not enough either: transcodes
      // land in WAVES with multi-second gaps, and a count that merely has to
      // hold still for MAX_DEFER_MS released in every gap — one Bistro load
      // committed incremental generations at 887 then 952 meshes, each one
      // staging fresh texture arrays and handing GI a different mesh set to
      // rebuild against. `pending` is the positive signal the deferral actually
      // needs: while it is nonzero the load is not done, full stop.
      if (component.assetLoadsPending) { pending++; continue; }
      if (component.materialRenderable === false) continue;
      ready++;
    }
    // `assetLoadsPending` alone is NOT enough: `loadMaterialAsset` resolves the
    // material immediately and its textures land in detached `.then()`s, so
    // every mesh reads "arrived" for the whole transcode tail. On that blind
    // window one Bistro boot read pending=0, released the hold, and 1173 of
    // the uber builds refused ("uber material could not be built") because
    // their KTX2 sources had no mip data yet — dribbling 12- and 21-mesh
    // generations while GI storm-rebuilt behind each one. The loader's
    // in-flight count sees exactly that window.
    return { ready, pending: pending + textureLoadsInFlight() };
  }

  /**
   * Everything eligible, keyed by what has to agree for one draw to stand in
   * for all of them.
   *
   * The key deliberately EXCLUDES `OCCLUDER_LAYER`. That bit is written by the
   * occlusion system from a bounding-sphere test, so folding it into the key
   * would split a group by a property that is not about how the group draws —
   * the same trap `batching.js` documents. The proxy is tagged instead, exactly
   * as batch proxies are.
   */
  #collectGroups() {
    const groups = new Map();
    const modeFlag = this.engine.playing ? "enabledInGame" : "enabledInEditor";
    // Why candidates were turned away, tallied for `#report`. A system that can
    // legitimately produce zero groups needs to say WHICH gate did it: this
    // returned nothing on a 384-mesh scene twice — once because every material
    // carried a `roughnessNode`, once because every texture was Basis-
    // compressed — and in both cases the only symptom was silence.
    const rejects = (this._rejects = {});
    const reject = (reason, n = 1) => (rejects[reason] = (rejects[reason] ?? 0) + n);
    // Shared with `#buildGroup`, which refuses AFTER grouping and used to do so
    // without a word.
    this._reject = reject;
    // ── TWO PASSES, BECAUSE THE CHEAP MERGE IS A PROPERTY OF THE SCENE ──────
    //
    // Whether a mesh should take the free same-material path depends on how
    // many OTHER meshes share its material instance, which is not knowable
    // until the whole candidate walk has run. So pass 1 applies the structural
    // gates and tallies per material; pass 2 assigns each survivor to a group.
    //
    // The tally is keyed on the material OBJECT, not on a signature: sharing an
    // instance is exactly the condition that makes the merge free, and two
    // byte-identical-but-separate materials still need the uber table (or a
    // second draw) because the proxy can only be handed one of them.
    const eligible = [];
    const perMaterial = new Map();
    for (const entity of this.engine.entities.values()) {
      if (this._unstable.has(entity.id)) continue;
      const component = entity.components.get("mesh");
      if (!component) continue; // not a mesh entity at all — not a candidate
      const mesh = component.mesh;
      // ⚠ SEPARATE FROM "not a mesh entity", and the distinction is why this
      // system looked hopeless on an imported city. A mesh COMPONENT whose
      // `.mesh` has not materialised yet is a candidate that arrived too early,
      // not a non-candidate — and on Bistro it was 1400 of 1532 meshes, so
      // merging was judged on 8% of the scene while the console said nothing.
      // If this number stays high after loading settles, the invalidation that
      // should re-run this once the geometry lands is missing.
      if (!mesh) { reject("mesh not built yet"); continue; }
      if (!component.enabled) { reject("component disabled"); continue; }
      if (mesh.userData.noBatch || mesh.userData.noMerge) { reject("opted out"); continue; }
      if (component.materialRenderable === false) { reject("material not renderable yet"); continue; }
      // A mesh whose material or textures are still streaming is renderable —
      // it draws its PLACEHOLDER. Grouping on that placeholder is how one load
      // produced a 4-group generation of 1426 meshes that the real materials
      // dissolved three seconds later: a full staging pass and a GI compile
      // wave for uber materials that never survived to be seen.
      if (component.assetLoadsPending) { reject("assets still loading"); continue; }
      if (!entityVisible(entity, modeFlag)) { reject("hidden"); continue; }
      if (Array.isArray(mesh.material)) { reject("multi-material"); continue; }
      if (mesh.userData.batchedInto) { reject("already instanced"); continue; }
      const { geometry, material } = mesh;
      if (!geometry || !material) { reject("no geometry or material"); continue; }
      if (geometry.morphAttributes && Object.keys(geometry.morphAttributes).length) { reject("morph targets"); continue; }
      if (!geometry.attributes?.position) { reject("no position attribute"); continue; }
      if (EXCLUSIVE_COMPONENTS.some((type) => entity.components.has(type))) { reject("exclusive component"); continue; }

      eligible.push({ entity, mesh, geometry, material });
      if (!sameMaterialRefusal(material)) {
        perMaterial.set(material, (perMaterial.get(material) ?? 0) + 1);
      }
    }

    const push = (key, record) => {
      const list = groups.get(key);
      if (list) list.push(record);
      else groups.set(key, [record]);
    };

    for (const { entity, mesh, geometry, material } of eligible) {
      // ── THE FREE PATH, TAKEN FIRST WHENEVER IT APPLIES ───────────────────
      //
      // Deliberately ahead of the uber path even for a material the uber path
      // could handle, because the trade is not close. Ten meshes of material A
      // and ten of material B, all four texture slots matching: uber merges the
      // lot into ONE draw and pays ~100 MB of copied texture array plus a fresh
      // shader variant for GI to compile; same-material merging produces TWO
      // draws and pays nothing at all. One extra draw call against a hundred
      // megabytes and a compile wave is not a trade worth making — and on an
      // imported scene the same-material groups are the big ones anyway.
      //
      // The uber path keeps everything below `MIN_GROUP_SIZE` copies of one
      // material, which is the case it was actually designed for: many DISTINCT
      // materials on a room-sized scene.
      if ((perMaterial.get(material) ?? 0) >= MIN_GROUP_SIZE) {
        push(
          [
            "sm",
            material.uuid,
            // A merge drops any channel a member lacks — split rather than strip.
            attributeSignature(geometry),
            // Per-MESH state the proxy carries as one value for the whole group.
            // Every material-level scalar matches by construction here (it is
            // literally the same object), so this is the entire remainder.
            mesh.castShadow ? 1 : 0,
            mesh.receiveShadow ? 1 : 0,
            (mesh.layers.mask >>> 0) & ~(1 << OCCLUDER_LAYER),
            mesh.renderOrder,
          ].join("|"),
          { entityId: entity.id, mesh, material, sameMaterial: true },
        );
        continue;
      }

      const incompatible = uberIncompatibility(material);
      if (incompatible) { reject(incompatible); continue; }

      const colorSignature = slotSignature(material.map);
      const normalSignature = slotSignature(material.normalMap);
      const roughnessSignature = slotSignature(material.roughnessMap);
      const metalnessSignature = slotSignature(material.metalnessMap);
      if (colorSignature === "unreadable" || normalSignature === "unreadable" ||
          roughnessSignature === "unreadable" || metalnessSignature === "unreadable") {
        reject("texture cannot be arrayed");
        continue;
      }

      // Scalars that the uber material does NOT carry per row: a difference
      // here would change the look, so it splits the group instead.
      const key = [
        material.type,
        material.transparent ? 1 : 0,
        material.side,
        material.alphaTest,
        material.blending,
        material.depthTest ? 1 : 0,
        material.depthWrite ? 1 : 0,
        material.toneMapped ? 1 : 0,
        material.fog ? 1 : 0,
        material.wireframe ? 1 : 0,
        material.ior,
        material.specularIntensity,
        material.specularColor?.getHex() ?? -1,
        mesh.castShadow ? 1 : 0,
        mesh.receiveShadow ? 1 : 0,
        (mesh.layers.mask >>> 0) & ~(1 << OCCLUDER_LAYER),
        mesh.renderOrder,
        // An empty slot (null signature) is compatible with any size, so it is
        // not part of the key — `#splitBySlotSize` resolves those afterwards.
        colorSignature ?? "*",
        normalSignature ?? "*",
        // The ORM slots are NOT wildcard-folded, for the reason the normal slot
        // is not (see `#foldWildcards`): folding a material with no ORM map
        // into a group that has them buys one draw call and makes that
        // material pay a texture fetch per fragment forever.
        roughnessSignature ?? "*",
        metalnessSignature ?? "*",
      ].join("|");
      push(key, {
        entityId: entity.id,
        mesh,
        material,
        colorSignature,
        normalSignature,
        roughnessSignature,
        metalnessSignature,
      });
    }
    return [...groups.values()];
  }

  /**
   * Folds a group with no COLOUR map into one that has colour maps of a single
   * size: an untextured material samples the neutral white layer and shades
   * identically, so keeping it in its own draw buys nothing.
   *
   * ⚠ THE NORMAL SLOT IS DELIBERATELY NOT FOLDED, and the reason is a measured
   * regression rather than caution. A material with no normal map compiles a
   * shader with no normal mapping in it; fold it into a normal-mapped group and
   * it starts paying for a texture fetch AND — because merged geometry carries
   * no tangents — three's derivative-based tangent frame, per fragment, forever.
   * On Sponza that folds fourteen untextured-normal materials into the expensive
   * shader to save ONE draw call, and this scene's frame is fragment-bound, not
   * draw-bound. Merging must not make the shader more expensive than the
   * materials it replaced.
   *
   * Wildcards fold into the LARGEST eligible group so the fewest draws survive.
   */
  #foldWildcards(groups) {
    const hosts = groups.filter((g) => !g[0].sameMaterial && g[0].colorSignature)
      .sort((a, b) => b.length - a.length);
    const rest = [];
    for (const group of groups) {
      if (!group[0].sameMaterial && group[0].colorSignature) continue;
      // ⚠ A SAME-MATERIAL GROUP IS NOT A WILDCARD, it just never computed a
      // colour signature — there is no texture array for it to be a layer of.
      // Without this it reads as "no colour map" and gets folded into an uber
      // host, which throws away the entire point of the free path (and would
      // shade it from row 0 of a table it never wrote indices for).
      if (group[0].sameMaterial) { rest.push(group); continue; }
      const host = hosts.find(
        (candidate) =>
          candidate[0].normalSignature === group[0].normalSignature &&
          // ⚠ THE ORM SIGNATURES MUST MATCH TOO. `buildLayeredTexture` sizes an
          // array from its FIRST present source and rescales the rest into it,
          // so the only thing standing between a merge and silently resampling
          // the user's roughness map is this predicate — folding on the colour
          // slot alone would fold across ORM sizes that never agreed.
          candidate[0].roughnessSignature === group[0].roughnessSignature &&
          candidate[0].metalnessSignature === group[0].metalnessSignature &&
          // Only the colour signature may differ; everything else in the key
          // already matched or these would not both be here.
          candidate[0].mesh.material.side === group[0].mesh.material.side,
      );
      if (host) host.push(...group);
      else rest.push(group);
    }
    return [...hosts, ...rest].filter((g) => g.length);
  }

  #rebuild() {
    this.#teardown();
    this._building = true;
    // Reset per pass: #teardown has just disposed the previous pass's arrays,
    // so the aggregate below prices THIS scene's merge, not the session's.
    this._textureBudgetSpent = 0;
    this._textureBudgetStoppedAt = 0;
    let candidates = 0;
    let undersized = 0;
    try {
      const groups = this.#foldWildcards(this.#collectGroups());
      // ── THE SCENE'S OWN SCALE, measured once per rebuild ─────────────────
      // Both the locality split and `#buildGroup`'s backstop need it, and they
      // MUST read the same number or the split produces cells the backstop then
      // refuses (which is how 866 meshes were once rejected as "merged bound
      // would refuse a real cull" AFTER being diced to satisfy exactly that
      // test). Derived from the candidates rather than the whole scene graph so
      // a distant skybox or a stray helper cannot inflate it.
      const sceneBounds = new THREE.Box3();
      const scratchCenter = new THREE.Vector3();
      for (const group of groups) {
        for (const member of group) {
          sceneBounds.expandByPoint(memberWorldCenter(member, scratchCenter));
        }
      }
      this._sceneDiagonal = sceneBounds.isEmpty()
        ? 0
        : sceneBounds.getSize(new THREE.Vector3()).length();
      for (const group of groups) {
        for (const local of this.#splitByLocality(group)) {
          // Locality first, then the triangle budget: the budget chunks a group
          // that is ALREADY local, so a greedy sequential pack stays local. The
          // other order would pack by triangle count across the whole world and
          // then need re-splitting spatially anyway.
          for (const members of splitByTriangleBudget(local)) {
            candidates += members.length;
            if (members.length < MIN_GROUP_SIZE) {
              undersized += members.length;
              continue;
            }
            const built = this.#buildGroup(members);
            if (built) this.groups.push(built);
          }
        }
      }
    } finally {
      this._building = false;
    }
    this.#report(candidates, undersized);
  }

  /**
   * Dices a group that is spread over the world into spatially local cells.
   *
   * A material's meshes are grouped by how they DRAW, which says nothing about
   * where they are. On an imported city that is catastrophic in both
   * directions: one material can carry ninety-seven meshes scattered over the
   * whole block, so merging them produces a city-sized proxy that no camera can
   * ever cull — and `MAX_MERGE_RADIUS_RATIO` therefore refused the group
   * outright, which is how a 1532-mesh scene merged NOTHING while every
   * material in it was shared dozens of ways.
   *
   * Refusing is the wrong horn of that dilemma when the frame is CPU-bound on
   * submission and the GPU is idle. Splitting takes neither: each cell merges
   * into a proxy whose bound is comparable to its members', so the draw calls
   * collapse AND the result still culls. Ninety-seven city-wide meshes become a
   * handful of per-block proxies instead of one blob or ninety-seven draws.
   *
   * The cell is sized so a full cell still satisfies the backstop in
   * `#buildGroup`: a merged sphere spans about half the cell's diagonal plus a
   * member radius, so cell * sqrt(3)/2 + r <= r * RATIO. The 0.8 factor leaves
   * headroom for members straddling a boundary.
   */
  #splitByLocality(members, depth = 0) {
    // ⚠ RECURSIVE, and it has to be. One pass sizes its cell from the WHOLE
    // group's mean radius, but `#buildGroup` re-derives the mean from the
    // BUCKET it is handed — and a bucket of small props has a smaller mean
    // than the group it came from, so it fails the very test the split was
    // supposed to satisfy. Measured: 866 meshes still rejected as "merged
    // bound would refuse a real cull" after a single-pass split. Each level
    // re-measures the members it actually has, so a cell keeps subdividing
    // until it is genuinely local by its own standard.
    if (members.length < MIN_GROUP_SIZE || depth >= MAX_SPLIT_DEPTH) return [members];

    const centers = [];
    const bounds = new THREE.Box3();
    let meanRadius = 0;
    for (const member of members) {
      const geometry = member.mesh.geometry;
      if (!geometry.boundingSphere) geometry.computeBoundingSphere();
      const scale = member.mesh.matrixWorld.getMaxScaleOnAxis();
      meanRadius += (geometry.boundingSphere?.radius ?? 0) * scale;
      // Same definition the scene bounds use — see `memberWorldCenter`.
      const center = memberWorldCenter(member, new THREE.Vector3());
      centers.push(center);
      bounds.expandByPoint(center);
    }
    meanRadius /= members.length;
    if (!(meanRadius > 0)) return [members];

    // Already local enough to merge whole — the common case for a room-sized
    // scene, and it must stay a single group so nothing regresses there.
    const extent = bounds.getSize(new THREE.Vector3()).length();
    const allowance = this.#mergeRadiusAllowance(meanRadius);
    if (extent <= allowance) return [members];

    // See MAX_LOCALITY_CELLS_PER_AXIS: the member-relative cell alone cannot
    // chunk a city made of small props, because it shrinks with the props.
    const cell = allowance * 0.8;
    const buckets = new Map();
    for (let i = 0; i < members.length; i++) {
      const c = centers[i];
      const key = `${Math.floor(c.x / cell)}|${Math.floor(c.y / cell)}|${Math.floor(c.z / cell)}`;
      const list = buckets.get(key);
      if (list) list.push(members[i]);
      else buckets.set(key, [members[i]]);
    }
    // No progress — every member landed in one cell despite the extent test, so
    // recursing would loop forever on the same set. Hand it back and let the
    // backstop in `#buildGroup` decide.
    if (buckets.size <= 1) return [members];

    const out = [];
    for (const bucket of buckets.values()) out.push(...this.#splitByLocality(bucket, depth + 1));
    return out;
  }

  /**
   * One line saying what this rebuild actually did, and — when it did nothing —
   * why. Logged only when the outcome CHANGES, so a scene that rebuilds on
   * every `hierarchy-changed` does not fill the console.
   */
  #report(candidates, undersized) {
    const merged = this.groups.reduce((n, g) => n + g.members.length, 0);
    const summary = `${this.groups.length}|${merged}|${candidates}`;
    // ── A SILENT REBUILD LOOP IS THE EXPENSIVE ONE ───────────────────────────
    //
    // Reporting only on CHANGE was chosen so a `hierarchy-changed` storm does
    // not fill the console, and it hid the worst case completely: a rebuild
    // that produces the same grouping every time logs nothing at all, while
    // still tearing down and re-minting uber materials — which on a GI scene is
    // a shader variant and a compile wave apiece. On Bistro the observable
    // symptom was GI compiling for 68-77 s with no line saying merging had just
    // rebuilt for the fifth time.
    //
    // So: the outcome line stays change-gated, and a separate throttled line
    // reports the REBUILD RATE and what asked for it. Both are cheap; neither
    // can be starved by the other.
    const now = performance.now();
    if (now - (this._lastRateReportAt ?? 0) > REBUILD_REPORT_INTERVAL_MS) {
      const since = this._rebuildCount - (this._lastReportedRebuildCount ?? 0);
      if (since > 1) {
        const reasons = Object.entries(this._invalidateTally)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 4)
          .map(([reason, n]) => `${reason} x${n}`)
          .join(", ");
        console.warn(
          `[merging] ${since} rebuilds in the last ${(REBUILD_REPORT_INTERVAL_MS / 1000).toFixed(0)}s ` +
            `— each one re-mints uber materials, and on a GI scene each new material costs a compile wave. ` +
            `Triggers so far: ${reasons || "none recorded"}.`,
        );
      }
      this._lastRateReportAt = now;
      this._lastReportedRebuildCount = this._rebuildCount;
    }
    if (summary === this._lastReport) return;
    this._lastReport = summary;
    if (this.groups.length) {
      const bytes = this.groups.reduce((n, g) => n + (g.textureBytes ?? 0), 0);
      // The free/uber split is the number that matters now: a same-material
      // group costs one vertex copy, an uber group costs a texture array and a
      // GI shader variant. Reporting only the total hides which kind of merging
      // a scene is actually getting.
      const free = this.groups.filter((g) => g.sameMaterial).length;
      const freeSaved = this.groups.reduce(
        (n, g) => n + (g.sameMaterial ? g.members.length - 1 : 0), 0);
      // ⚠ THE REJECTS BELONG ON THE SUCCESS LINE TOO, and it took a wasted
      // reload to learn it. This used to print the reject tally ONLY when zero
      // groups formed — so a scene that merged 634 of 1500 meshes reported a
      // cheerful success and said nothing about the 866 it turned away. The
      // interesting number on an imported scene is never the groups that formed;
      // it is which gate ate the rest, and `undersized` (the locality split
      // dicing a group below MIN_GROUP_SIZE) is invisible without it.
      const rejects = Object.entries(this._rejects ?? {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([reason, n]) => `${n} ${reason}`)
        .join(", ");
      console.info(
        `[merging] ${this.groups.length} group(s): ${merged} meshes → ${this.groups.length} draws ` +
          `(${this.savedDrawCalls} saved, ${(bytes / 1048576).toFixed(0)} MB of texture arrays) ` +
          `— ${free} same-material (${freeSaved} draws saved for 0 MB and no new shader), ` +
          `${this.groups.length - free} uber. ` +
          `Scene diagonal ${(this._sceneDiagonal ?? 0).toFixed(0)}m ⇒ locality cell ` +
          `${((this._sceneDiagonal ?? 0) / MAX_LOCALITY_CELLS_PER_AXIS).toFixed(0)}m floor. ` +
          `Not merged: ${undersized} below the ${MIN_GROUP_SIZE}-mesh threshold after splitting` +
          (rejects ? `, ${rejects}` : "") +
          ` [rebuild #${this._rebuildCount}, asked for by ${this._invalidateReason}].`,
      );
      return;
    }
    const reasons = Object.entries(this._rejects ?? {}).sort((a, b) => b[1] - a[1]);
    const why = reasons.length
      ? reasons.slice(0, 5).map(([reason, n]) => `${n} ${reason}`).join(", ")
      : "nothing eligible in this scene";
    const seen = Object.values(this._rejects ?? {}).reduce((n, v) => n + v, 0) + candidates;
    console.info(
      `[merging] no groups formed — ${seen} mesh entities considered: ${why}` +
        (undersized ? `, ${undersized} in groups below the ${MIN_GROUP_SIZE}-mesh threshold` : "") +
        ".",
    );
  }

  /**
   * The uber material for `materials`, built once and kept.
   *
   * Keyed on the material set AND each material's appearance signature, so the
   * cache can only ever hand back something pixel-identical to what a fresh
   * build would produce — edit a .mat and the signature moves, missing the
   * cache and rebuilding. What it removes is the case that actually happens
   * every frame in play mode: a rebuild triggered by something that has nothing
   * to do with these materials, which used to re-decode every texture.
   *
   * @returns {any | null}
   */
  #uberFor(materials) {
    const key = materials.map((m) => `${m.uuid}@${materialSignature(m)}`).join("|");
    const cached = this._uberCache.get(key);
    if (cached) {
      // Re-insert so the eviction below is least-recently-USED, not
      // least-recently-built: the groups a scene rebuilds are the ones it keeps.
      this._uberCache.delete(key);
      this._uberCache.set(key, cached);
      return cached;
    }
    const built = buildUberMaterial(materials, materials[0]);
    if (!built) return null;
    built.bytes = arrayTextureBytes(materials);
    this._uberCache.set(key, built);
    // Never evict something a group is drawing with. A rebuild tears down and
    // repopulates `groups` one at a time, so mid-rebuild this set is the groups
    // already rebuilt — exactly the ones that must survive.
    const live = new Set(this.groups.map((group) => group.built));
    let idle = 0;
    for (const entry of this._uberCache.values()) {
      if (entry !== built && !live.has(entry)) idle += entry.bytes ?? 0;
    }
    const ceiling = this.#cacheCeilingBytes();
    for (const [oldest, entry] of this._uberCache) {
      if (idle <= ceiling) break;
      if (entry === built || live.has(entry)) continue;
      this._uberCache.delete(oldest);
      idle -= entry.bytes ?? 0;
      entry.dispose();
    }
    return built;
  }

  /**
   * Would the merged bound refuse a cull the members are currently getting?
   *
   * Shared by both build paths so they cannot drift: the free path merges the
   * groups an imported scene is mostly made of, and it must obey the same
   * culling contract the uber path does.
   *
   * @returns {boolean} true when the merged bound is acceptable
   */
  #boundIsAcceptable(members, geometry) {
    let meanRadius = 0;
    for (const member of members) {
      if (!member.mesh.geometry.boundingSphere) member.mesh.geometry.computeBoundingSphere();
      const scale = member.mesh.matrixWorld.getMaxScaleOnAxis();
      meanRadius += (member.mesh.geometry.boundingSphere?.radius ?? 0) * scale;
    }
    meanRadius /= members.length;
    const mergedRadius = geometry.boundingSphere?.radius ?? 0;
    return !(meanRadius > 0 && mergedRadius > this.#mergeRadiusAllowance(meanRadius));
  }

  /**
   * The largest bound a merged proxy of members this size may have.
   *
   * ⚠ ONE FUNCTION, TWO CALLERS, ON PURPOSE. `#splitByLocality` sizes its cells
   * from this and `#boundIsAcceptable` refuses on it; if the two ever disagree,
   * the split dices a group precisely so the backstop will reject it — which is
   * the shape of a bug this file has already had once (866 meshes rejected as
   * "merged bound would refuse a real cull" after being split to satisfy that
   * very test).
   */
  #mergeRadiusAllowance(meanRadius) {
    return Math.max(
      meanRadius * MAX_MERGE_RADIUS_RATIO,
      (this._sceneDiagonal ?? 0) / MAX_LOCALITY_CELLS_PER_AXIS,
    );
  }

  /**
   * Concatenate members that already share ONE material into a single draw.
   *
   * The whole method is the uber path with every expensive step deleted, and
   * what is left is the honest cost of a static merge: one vertex-buffer copy.
   * No texture is read, no array is stacked, no budget is consulted (there is
   * nothing to charge), no material is created — so GI sees a proxy wearing a
   * material it has ALREADY compiled a shader variant for, and the compile wave
   * that used to follow every rebuild does not happen.
   *
   * @returns {any | null}
   */
  #buildSameMaterialGroup(members, material) {
    // `null` rowOf ⇒ no `materialIndex` attribute. The material shades from its
    // own uniforms and never reads a row, so writing one would be 4 bytes per
    // vertex of buffer that nothing samples.
    const geometry = mergeGeometries(members, null);
    if (!geometry) {
      this._reject?.("geometry could not be merged", members.length);
      return null;
    }
    geometry.computeBoundingSphere();
    if (!this.#boundIsAcceptable(members, geometry)) {
      geometry.dispose();
      this._reject?.("merged bound would refuse a real cull", members.length);
      return null;
    }

    const template = members[0].mesh;
    const proxy = new THREE.Mesh(geometry, material);
    proxy.name = `Merged(${members.length})`;
    proxy.castShadow = template.castShadow;
    proxy.receiveShadow = template.receiveShadow;
    proxy.renderOrder = template.renderOrder;
    proxy.layers.mask = (template.layers.mask >>> 0) & ~(1 << OCCLUDER_LAYER);
    proxy.matrixAutoUpdate = false;
    proxy.raycast = () => {};
    proxy.userData.batchProxy = true;
    proxy.userData.mergeProxy = true;
    proxy.userData.engineOwned = true;
    this.engine.scene.add(proxy);

    const matrices = [];
    for (const member of members) {
      matrices.push(Float64Array.from(member.mesh.matrixWorld.elements));
      member.mesh.userData.mergedInto = proxy;
      member.mesh.visible = false;
    }
    return {
      members,
      matrices,
      materials: [material],
      // ⚠ NOT WATCHED, and the empty array is what says so (see
      // `#watchForMaterialEdits`). The proxy holds the author's material
      // INSTANCE, so an edit to it is already on screen the frame it is made —
      // there is nothing copied for a signature to go stale against. The uber
      // path needs that watcher precisely because it copied pixels; this one
      // would rebuild the scene to reproduce a change it already has.
      signatures: [],
      sameMaterial: true,
      mesh: proxy,
      textureBytes: 0,
      built: null,
    };
  }

  /** @returns {any | null} */
  #buildGroup(members) {
    // One row per DISTINCT material: two meshes sharing a material share a row.
    //
    // ⚠ ROW ORDER IS CANONICAL (sorted by uuid), NOT MEMBER-ENCOUNTER ORDER.
    //
    // `#uberFor` keys its cache on this list, so encounter order made the key a
    // function of which members happened to come first — and merging re-derives
    // its member lists on every rebuild, so the SAME material set produced a
    // different key each time. Every rebuild therefore missed the cache and
    // re-rasterised texture arrays that were already resident, which is the
    // whole cost the cache exists to remove (Bistro: hundreds of MB per pass,
    // and a fresh `Uber(n)` material that GI then had to compile a shader
    // variant for).
    //
    // Sorting must happen HERE and not inside `#uberFor`, because `rowOf` is
    // what `mergeGeometries` stamps into each vertex's `materialIndex` and the
    // uber material builds its layers in this array's order. The two are the
    // same numbering by construction — canonicalise one without the other and a
    // cache hit shades every vertex from the wrong row.
    const distinct = [];
    for (const member of members) if (!distinct.includes(member.material)) distinct.push(member.material);
    const materials = distinct.sort((a, b) => (a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0));
    const rowOf = new Map();
    for (let row = 0; row < materials.length; row++) rowOf.set(materials[row], row);

    // ── THE FREE PATH ────────────────────────────────────────────────────────
    //
    // Exactly one distinct material means there is no shading table to build,
    // so every cost below this branch — the texture-array pricing, the scene
    // budget, `#uberFor`, the `materialIndex` attribute and the new-material
    // shader variant GI would have to compile — is spent to reproduce a
    // material that already exists. Hand the proxy that material instead.
    //
    // ⚠ Reached by `sameMaterial` groups AND by a one-material uber group,
    // which used to build a ONE-LAYER array texture: a full copy of every
    // source map to express a table with a single row in it.
    if (materials.length === 1) {
      return this.#buildSameMaterialGroup(members, materials[0]);
    }

    // Priced BEFORE anything is allocated. See MAX_GROUP_TEXTURE_BYTES: the
    // arrays are additional memory, not a replacement, and a group can cost
    // hundreds of megabytes to save two draw calls.
    const bytes = arrayTextureBytes(materials);
    const saved = members.length - 1;
    // The scene-wide ceiling, checked before the per-group ones because a group
    // that is affordable on its own can still be the one that puts the scene
    // over. Counted once per refusal so the report can say how much was left on
    // the table rather than going silent after the first skip.
    if (this._textureBudgetSpent + bytes > this.textureBudgetBytes) {
      if (!this._textureBudgetStoppedAt) {
        this._textureBudgetStoppedAt = this._textureBudgetSpent;
        console.warn(
          `[merging] texture budget reached: ${(this._textureBudgetSpent / 1048576).toFixed(0)} MB of ` +
            `${(this.textureBudgetBytes / 1048576).toFixed(0)} MB spent — remaining groups draw unmerged. ` +
            `Merged texture arrays are ADDED to the originals, not a replacement.`,
        );
      }
      this._reject?.("scene texture budget exhausted", members.length);
      return null;
    }
    if (bytes > MAX_GROUP_TEXTURE_BYTES || bytes > saved * MAX_BYTES_PER_DRAW_SAVED) {
      console.warn(
        `[merging] skipped a group of ${members.length} meshes: its texture arrays would cost ` +
          `${(bytes / 1048576).toFixed(0)} MB to save ${saved} draw call${saved === 1 ? "" : "s"}.`,
      );
      return null;
    }

    const geometry = mergeGeometries(members, rowOf);
    if (!geometry) {
      this._reject?.("geometry could not be merged", members.length);
      return null;
    }
    geometry.computeBoundingSphere();

    // Would merging refuse a cull the scene is currently getting? Compare the
    // merged bound against the members' own — see MAX_MERGE_RADIUS_RATIO.
    //
    // Reaching here with an oversized bound is now a BUG rather than a normal
    // outcome: `#splitByLocality` has already diced the group into cells that
    // satisfy this. The check stays as a backstop, but it reports instead of
    // returning null in silence — that silence is what made an imported city
    // look like "merging does not apply here" when in fact 1407 of 1532 meshes
    // were passing every gate and being dropped on this line.
    if (!this.#boundIsAcceptable(members, geometry)) {
      geometry.dispose();
      this._reject?.("merged bound would refuse a real cull", members.length);
      return null;
    }

    const built = this.#uberFor(materials);
    if (!built) {
      geometry.dispose();
      this._reject?.("uber material could not be built", members.length);
      return null;
    }

    const template = members[0].mesh;
    const proxy = new THREE.Mesh(geometry, built.material);
    proxy.name = `Merged(${members.length})`;
    proxy.castShadow = template.castShadow;
    proxy.receiveShadow = template.receiveShadow;
    proxy.renderOrder = template.renderOrder;
    proxy.layers.mask = (template.layers.mask >>> 0) & ~(1 << OCCLUDER_LAYER);
    // Vertices are already in world space, so the proxy must add no transform.
    proxy.matrixAutoUpdate = false;
    proxy.raycast = () => {};
    proxy.userData.batchProxy = true;
    proxy.userData.mergeProxy = true;
    proxy.userData.engineOwned = true;
    this.engine.scene.add(proxy);

    const matrices = [];
    for (const member of members) {
      matrices.push(Float64Array.from(member.mesh.matrixWorld.elements));
      member.mesh.userData.mergedInto = proxy;
      member.mesh.visible = false;
    }
    // Charged only once the group is actually committed — every `return null`
    // above is a group that allocated nothing, and charging on entry would let
    // refused groups exhaust the scene budget for the ones that follow.
    this._textureBudgetSpent += bytes;
    return {
      members,
      matrices,
      materials,
      signatures: materials.map(materialSignature),
      mesh: proxy,
      // Reported by `profile.drawCalls`. A merged group's whole case is a
      // ratio — draws removed against megabytes spent — and neither number is
      // visible from outside without carrying it here.
      textureBytes: bytes,
      // The CACHE owns the uber material and its texture arrays, not the group
      // — that is the whole point of `#uberFor`. Held here only so eviction can
      // tell a live entry from a stale one.
      built,
    };
  }

  #teardown() {
    for (const group of this.groups) {
      for (const member of group.members) {
        const mesh = member.mesh;
        if (!mesh.userData.mergedInto) continue;
        mesh.userData.mergedInto = null;
        // NOT a blanket `true`: a member whose component was disabled (or whose
        // material stopped being renderable) while it was merged must stay
        // hidden — and that is exactly the change that triggered this rebuild.
        const component = this.engine.entities.get(mesh.userData.entityId)?.components.get("mesh");
        mesh.visible = component
          ? component.enabled && component.materialRenderable !== false
          : true;
      }
      this.engine.scene.remove(group.mesh);
      // The merged geometry IS this group's own — dispose it. The material is
      // the cache's, and disposing it here is what made every rebuild re-decode
      // every texture; see MIN_REBUILD_INTERVAL_MS.
      group.mesh.geometry.dispose();
    }
    this.groups.length = 0;
  }

  /**
   * True while an invalidation is waiting for its rebuild — the signal GI's
   * build gate holds on, so its first build sees the MERGED scene. Without it
   * GI's 250 ms asset-stable window always beat this system's 400 ms settle,
   * and every boot paid one full build + compile wave against the unmerged
   * mesh set (1532 placements into 768 slots) that the merge commit then
   * invalidated seconds later.
   */
  get settling() {
    return this.enabled && this._dirty === true;
  }

  /** Draw calls this grouping removed, for the stats overlay. */
  get savedDrawCalls() {
    let saved = 0;
    for (const group of this.groups) saved += group.members.length - 1;
    return saved;
  }

  dispose() {
    this.setEnabled(false);
  }
}

/**
 * Concatenates every member's geometry into one buffer, in world space, with a
 * `materialIndex` attribute naming the row each vertex shades with.
 *
 * Positions and normals are transformed here rather than left local because the
 * proxy carries no transform: a merged group has as many source transforms as it
 * has members and one object to hang them on.
 *
 * `rowOf` is `null` for a SAME-MATERIAL merge, which writes no `materialIndex`
 * at all — the proxy's material shades from its own uniforms and never samples a
 * row, so the attribute would be four bytes per vertex that nothing reads.
 */
function mergeGeometries(members, rowOf) {
  let vertexCount = 0;
  let indexCount = 0;
  for (const member of members) {
    const geometry = member.mesh.geometry;
    const position = geometry.attributes.position;
    vertexCount += position.count;
    indexCount += geometry.index ? geometry.index.count : position.count;
  }
  if (!vertexCount || vertexCount > 0x7fffffff) return null;

  const present = new Set(MERGED_ATTRIBUTES);
  for (const name of MERGED_ATTRIBUTES) {
    // An attribute only survives if EVERY member has it — a half-filled uv
    // channel shades half the merge with garbage.
    for (const member of members) {
      if (!member.mesh.geometry.attributes[name]) {
        present.delete(name);
        break;
      }
    }
  }
  if (!present.has("position")) return null;

  const merged = new THREE.BufferGeometry();
  const buffers = {};
  for (const name of present) {
    const itemSize = members[0].mesh.geometry.attributes[name].itemSize;
    buffers[name] = { array: new Float32Array(vertexCount * itemSize), itemSize };
  }
  const rows = rowOf ? new Float32Array(vertexCount) : null;
  const indices = vertexCount > 65535 ? new Uint32Array(indexCount) : new Uint16Array(indexCount);

  const vector = new THREE.Vector3();
  const normalMatrix = new THREE.Matrix3();
  let vertexAt = 0;
  let indexAt = 0;
  for (const member of members) {
    const geometry = member.mesh.geometry;
    const matrix = member.mesh.matrixWorld;
    normalMatrix.getNormalMatrix(matrix);
    const position = geometry.attributes.position;
    const row = rowOf ? (rowOf.get(member.material) ?? 0) : 0;

    for (const name of present) {
      const source = geometry.attributes[name];
      const target = buffers[name];
      if (name === "position") {
        for (let i = 0; i < source.count; i++) {
          vector.fromBufferAttribute(source, i).applyMatrix4(matrix);
          target.array[(vertexAt + i) * 3] = vector.x;
          target.array[(vertexAt + i) * 3 + 1] = vector.y;
          target.array[(vertexAt + i) * 3 + 2] = vector.z;
        }
      } else if (name === "normal") {
        for (let i = 0; i < source.count; i++) {
          vector.fromBufferAttribute(source, i).applyMatrix3(normalMatrix).normalize();
          target.array[(vertexAt + i) * 3] = vector.x;
          target.array[(vertexAt + i) * 3 + 1] = vector.y;
          target.array[(vertexAt + i) * 3 + 2] = vector.z;
        }
      } else {
        const size = target.itemSize;
        for (let i = 0; i < source.count; i++) {
          for (let c = 0; c < size; c++) {
            target.array[(vertexAt + i) * size + c] = source.getComponent(i, c);
          }
        }
      }
    }
    if (rows) rows.fill(row, vertexAt, vertexAt + position.count);

    if (geometry.index) {
      const source = geometry.index;
      for (let i = 0; i < source.count; i++) indices[indexAt + i] = source.getX(i) + vertexAt;
      indexAt += source.count;
    } else {
      for (let i = 0; i < position.count; i++) indices[indexAt + i] = vertexAt + i;
      indexAt += position.count;
    }
    vertexAt += position.count;
  }

  for (const name of present) {
    merged.setAttribute(name, new THREE.BufferAttribute(buffers[name].array, buffers[name].itemSize));
  }
  if (rows) merged.setAttribute("materialIndex", new THREE.BufferAttribute(rows, 1));
  merged.setIndex(new THREE.BufferAttribute(indices, 1));
  return merged;
}
