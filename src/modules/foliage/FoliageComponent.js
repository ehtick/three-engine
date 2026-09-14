import * as THREE from "three/webgpu";
import { Component } from "../../engine/components/Component.js";
import { chooseImpostorTile, createImpostorBakeJob, debugSaveAtlas } from "../../engine/lod/impostorBake.js";
import { createImpostorGeometry, createImpostorMaterial } from "../../engine/lod/impostorMaterial.js";
import { createFoliagePrototype } from "./foliageGeometry.js";
import { collectSurfaceTriangles, reseatFoliageInstances, scatterFoliage } from "./foliageScatter.js";
import { acquireFoliageEntry, acquireFoliageSurfaceMaterial, foliageEntryMaterial, foliageMaterialKey, installFoliagePassHooks, releaseFoliageEntry, releaseFoliageSurfaceMaterial, setupFoliageImpostorMaterial, updateFoliageUniforms } from "./foliageMaterial.js";
import { foliageCellSize, foliageChunkTierMask, foliageLodLevel, foliageLodThresholds, foliageShadowFar, partitionFoliage, foliageShadowCasterRanges } from "./foliageLod.js";
import { stableInstanceCapacity } from "../../engine/instanceCapacity.js";
import { updateFoliageInteractions } from "./foliageInteraction.js";
import { deferFoliageDisposal, updateFoliageWarmup } from "./foliageWarmup.js";
import { sceneWind } from "../../engine/vfx/clothWind.js";
import { GrassRenderer } from "./grassRenderer.js";
import { freeze } from "../../engine/freezeLedger.js";

/** Props that only reconfigure the drawn sward. */
const GRASS_KEYS = new Set(["drawnGrass", "blades", "grassDensity", "bladeWidth", "grassLean", "lodNear",
  "maxDistance", "groundBlend", "dryColor", "height", "leafColor", "barkColor", "castShadow", "receiveShadow",
  "grassBrightness", "grassOcclusion", "grassVariation", "grassSpecular", "grassRoughness", "grassSky"]);
import { resolveFoliagePlacements } from "./foliagePlacements.js";
import {
  appendChunkToJob, appendChunkToTier, commitBatchChunksFull, createBatchOrderJob, finalizeCommittedMesh,
  foliageCanOrderMaterial, foliageCommitBudget, foliageOrderDirection, FOLIAGE_ORDER_SPREAD_CHUNKS,
  orderFoliageChunks, stepBatchOrderJob,
} from "./foliageBatchOrder.js";

const atlasCaches = new WeakMap();
const bakeQueues = new WeakMap();
const shapeKeys = new Set(["species", "seed", "height", "width", "leafColor", "barkColor", "flowerColor", "leafDensity", "leafSize", "branchDensity", "crownBase", "crownSpread"]);
const placementKeys = new Set(["distribution", "placements", "surface", "density", "maxInstances", "minSpacing", "seed", "minSlope", "maxSlope", "minAltitude", "maxAltitude", "alignToNormal", "minScale", "maxScale", "chunkSize"]);
const geometrySourceKeys = new Set(["geometry", "geometryAsset", "heights", "size", "resolution", "path", "enabled"]);
const matrix = new THREE.Matrix4(), position = new THREE.Vector3(), quaternion = new THREE.Quaternion(), scale = new THREE.Vector3();
const cameraPosition = new THREE.Vector3(), axisX = new THREE.Vector3(), axisY = new THREE.Vector3();
/** Metres each chunk's tier mask is widened by on both edges; the chunk walk
 * reruns once the viewer has moved half of it (`_tierMasksCurrent`).
 * `__foliageTierSlack = 0` restores the per-frame walk. */
export const FOLIAGE_TIER_SLACK = 4;
const NO_CHUNKS = [];
const foliageTierSlack = () => Math.max(0, Number(globalThis.__foliageTierSlack ?? FOLIAGE_TIER_SLACK) || 0);
const viewportSize = new THREE.Vector2(), prototypeSize = new THREE.Vector3();
const viewDirection = new THREE.Vector3();
const levelNames = ["nearChunks", "midChunks", "impostorChunks", "culledChunks"];

/** The farthest point of an axis-aligned box from `point` is the corner
 * picked independently per axis (whichever side of the box is farther along
 * that axis) — correct because squared distance separates into independent
 * per-axis terms. `chunk.detailBounds.distanceToPoint` already gives the
 * NEAREST distance; this is its missing twin, turning a chunk's box into the
 * `[min, max]` distance RANGE `foliageChunkTierMask` wants instead of just
 * its nearest corner. */
function farthestDistanceToPoint(box, point) {
  const dx = Math.max(point.x - box.min.x, box.max.x - point.x);
  const dy = Math.max(point.y - box.min.y, box.max.y - point.y);
  const dz = Math.max(point.z - box.min.z, box.max.z - point.z);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function visibleEntity(entity, playing) {
  for (let node = entity; node; node = node.parent) {
    if (node.enabled === false || node[playing ? "enabledInGame" : "enabledInEditor"] === false || node.object3D?.visible === false || node._lodHidden === true) return false;
  }
  return true;
}

function instanceMatrix(instance) {
  position.fromArray(instance.position);
  quaternion.fromArray(instance.quaternion ?? [0, 0, 0, 1]);
  const s = Number(instance.scale) || 1;
  scale.setScalar(s);
  return matrix.compose(position, quaternion, scale);
}

function tagMesh(mesh, entityId) {
  Object.assign(mesh.userData, { entityId, foliageOwned: true, noBatch: true, noMerge: true, vfxSimulation: "foliage" });
  installFoliagePassHooks(mesh);
  return mesh;
}

function atlasKey(props) {
  return [...shapeKeys].map(key => `${key}:${props[key]}`).join("|");
}

/** Hands the frame back between bake steps — the same fallback chain
 *  `WorldComponent.js`'s own `frame()` helper uses, so a bake yields a real
 *  animation frame in a browser and an immediate macrotask under Node/tests. */
function nextFrame() {
  return new Promise(resolve => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}

/** Walks up to the owning World, if any — the same pattern `WorldSection.jsx`
 *  uses to find which World entity contains a clicked feature. `null` for a
 *  standalone foliage component (nothing under a World), which bakes
 *  immediately — see `_requestAtlas`'s ordering gate. */
function owningWorld(entity) {
  for (let node = entity; node; node = node.parent) {
    const world = node.getComponent?.("world");
    if (world) return world;
  }
  return null;
}

/** Reuse the engine's normal/albedo octahedral atlas, serialized per renderer.
 * Drives `createImpostorBakeJob` directly (rather than the `bakeImpostorAtlas`
 * convenience wrapper) so the bake's own frame count can be reported below —
 * `impostorBake.js`'s job never blocks the main thread for more than
 * `MAX_VIEWS_PER_STEP` views at a time and never reads a pixel back to the
 * CPU, so "serialized" here means queued behind any earlier species' bake,
 * not synchronous with it. */
function acquireAtlas(renderer, key, geometry, props, label) {
  let cache = atlasCaches.get(renderer);
  if (!cache) atlasCaches.set(renderer, cache = new Map());
  let entry = cache.get(key);
  if (entry) { entry.refs++; entry.idleAt = 0; return entry; }
  entry = { refs: 1, atlas: null, material: null, error: null, cache, key, settled: false, idleAt: 0 };
  cache.set(key, entry);
  // §impostor-tile-choice (P1-B, 09-13): a fixed 64 px tile made a thin
  // species' smallest leaf card cover under a texel — after the alpha test it
  // rasterized as a coin flip, so birch baked as a bare pole while oak's
  // wider cards survived. `chooseImpostorTile` picks the smallest tile (from
  // 64/128/256) whose texel still resolves that species' worst-case card at
  // `MIN_CARD_TEXELS`, from the SAME bounding box `impostorBake`'s own
  // `boundsOf` will independently recompute on this geometry (identity
  // transform, no parent — the two are guaranteed to agree).
  const bounds = geometry.boundingBox;
  const radius = bounds ? bounds.getSize(new THREE.Vector3()).length() * 0.5 : 0;
  const cardWidth = geometry.userData?.foliage?.tree?.leafCardMinWidthMeters ?? 0;
  // ⭐ 09-14: never below 128 px. The card-resolution rule alone gave a 12 m
  // oak a 64 px tile (~20 cm texels) that is MAGNIFIED ~2× on screen at the
  // lodFar handoff — the blurry, crumbly far canopy. 4×4 × 128 px is 2 MB.
  const tile = chooseImpostorTile({ cardWidth, radius, minTile: 128 });
  const sourceGeometry = geometry.clone();
  // Shared per SPECIES — the bake material reads no other prop, and a fresh one
  // per atlas entry also defeated `impostorBake`'s per-source memo for the
  // normal pass. See `acquireFoliageSurfaceMaterial`.
  const sourceEntry = acquireFoliageSurfaceMaterial(props);
  const source = new THREE.Mesh(sourceGeometry, sourceEntry.material);
  renderer.__foliageAtlasPending = (renderer.__foliageAtlasPending ?? 0) + 1;
  const before = bakeQueues.get(renderer) ?? Promise.resolve();
  entry.promise = before.catch(() => {}).then(async () => {
    // Timed from HERE, not from when this species joined the queue: species
    // stay serialized (one bake in flight at a time, on purpose — the
    // renderer state a bake step borrows is not safe to share concurrently),
    // but the wait for an earlier species' turn is queueing, not this bake's
    // own cost.
    const bakeStart = performance.now();
    // A looser bake-time alpha test (vs. the live surface material's own 0.5 —
    // `foliageMaterial.js`) plus `impostorBake`'s supersample-and-box-filter
    // pass turns a thin card's partial, sub-texel coverage into a fractional
    // alpha instead of discarding it outright. The runtime impostor material's
    // own `alphaTest: .35` below thresholds that smoothed coverage again.
    const job = createImpostorBakeJob(renderer, source, { frames: 4, tile, hemisphere: true, alphaTest: .25 });
    // Drive the job ourselves (rather than the `bakeImpostorAtlas` wrapper) so
    // `frames` below counts exactly how many real animation frames THIS
    // species' bake spanned — `MAX_VIEWS_PER_STEP` views (and, at the end, the
    // GPU downsample/dilate pair) per frame, never more, and never a pixel
    // readback in between.
    let result = { done: false }, frameCount = 0;
    while (!result.done) {
      result = await job.step();
      frameCount++;
      if (!result.done) await nextFrame();
    }
    const atlas = result.atlas;
    entry.atlas = atlas;
    // 09-14: .5, not .35 — the .25 bake plus bilinear coverage at .35 grew the
    // far crown to 1.3-1.4× the tree it replaces (a fat, blobby cloud).
    entry.material = createImpostorMaterial(atlas, { alphaTest: .5, lit: true });
    entry.material.name = "Foliage · octahedral impostor";
    freeze.bootMark(`foliage: impostor bake ${label ?? props.species}`, performance.now() - bakeStart, `tile=${tile}, ${frameCount} frame(s)`);
    // DEBUG ONLY: set `globalThis.__impostorDumpDir` (an absolute folder path)
    // before a bake to save that atlas's albedo/normal as PNG + raw dumps
    // there — see `impostorBake.js#debugSaveAtlas`. Never armed in a shipped
    // build; a failed dump must not fail the bake itself.
    if (globalThis.__impostorDumpDir) {
      debugSaveAtlas(renderer, atlas, globalThis.__impostorDumpDir)
        .catch(error => console.warn(`impostor atlas dump failed (${label ?? props.species}): ${error?.message ?? error}`));
    }
    return entry;
  }).catch(error => { entry.error = error?.message ?? String(error); return entry; }).finally(() => {
    // The geometry was cloned for this bake; the MATERIAL is shared — release,
    // never dispose, or the next species-mate's bake loses its shader.
    sourceGeometry.dispose(); releaseFoliageSurfaceMaterial(sourceEntry);
    renderer.__foliageAtlasPending = Math.max(0, (renderer.__foliageAtlasPending ?? 1) - 1);
    // Every holder let go while it baked: the result parks like any release.
    entry.settled = true;
    if (!entry.refs) trimIdleAtlases(cache);
  });
  bakeQueues.set(renderer, entry.promise);
  return entry;
}

/** Unreferenced baked atlases kept for a later holder of the same key. */
export const ATLAS_IDLE_KEEP = 12;
let atlasIdleClock = 0;

/**
 * ⭐ PARK, DON'T DISPOSE (09-14, the Complex scene's post-open stall).
 *
 * The last release used to dispose the atlas on the spot. A shape rebuild
 * (`_rebuildShape`) releases its atlas and asks again only once the owning
 * World is Ready, so a World regeneration dropped every species' atlas and
 * re-baked the identical picture moments later — each bake a GPU job plus new
 * pipelines, behind 10-25 s GPU-process stalls. A released entry now stays in
 * the cache; the next acquire of its key revives it for free, and only a
 * failed bake or the oldest beyond `ATLAS_IDLE_KEEP` is really disposed.
 */
export function releaseAtlas(entry) {
  if (!entry || entry.refs <= 0) return;
  if (--entry.refs > 0) return;
  entry.idleAt = ++atlasIdleClock;
  trimIdleAtlases(entry.cache);
}

/** Dispose failed bakes and all but the newest `keep` settled, unheld atlases. */
export function trimIdleAtlases(cache, keep = ATLAS_IDLE_KEEP) {
  const idle = [];
  for (const entry of [...cache.values()]) {
    if (entry.refs > 0 || !entry.settled) continue;
    if (entry.error || !entry.atlas) disposeAtlasEntry(entry);
    else idle.push(entry);
  }
  idle.sort((a, b) => b.idleAt - a.idleAt);
  for (const entry of idle.slice(keep)) disposeAtlasEntry(entry);
}

function disposeAtlasEntry(entry) {
  if (entry.cache.get(entry.key) === entry) entry.cache.delete(entry.key);
  entry.material?.dispose();
  entry.atlas?.dispose();
  entry.material = null;
  entry.atlas = null;
}

export class FoliageComponent extends Component {
  static type = "foliage";
  static label = "Foliage";
  static tags = ["world", "trees", "grass", "flowers", "terrain", "3d"];
  static defaults = {
    species: "oak", distribution: "single", surface: "", density: .15, maxInstances: 10000,
    placements: [],
    seed: 1, height: 6, width: 4, leafColor: "#427a32", barkColor: "#654733", flowerColor: "#eed078",
    leafDensity: 1, leafSize: 1, branchDensity: 1, crownBase: 0, crownSpread: 1,
    minSpacing: 0, minSlope: 0, maxSlope: 55, minAltitude: -10000, maxAltitude: 10000,
    alignToNormal: false, minScale: .8, maxScale: 1.2,
    wind: true, windStrength: .2, windSpeed: 1, windDirection: 35,
    windGustStrength: .6, windScale: 12, windTurbulence: .25,
    interaction: false, interactionStrength: .5, interactionRadius: 1,
    lodNear: 45, lodFar: 130, maxDistance: 320, chunkSize: 24,
    // 0 = shadows hand mid-tier geometry to the impostor tier at `lodFar`
    // exactly as the colour pass does. A positive value hands off earlier:
    // a tree's shadow past ~100 m is a blob, so the shadow maps stop carrying
    // its real geometry there long before the picture does. Clamped by
    // `foliageLod.js#foliageShadowFar`; see it for the two guarantees.
    shadowFar: 0,
    castShadow: true, receiveShadow: true,
    // Grass only. A sward is drawn, not scattered: see `grassRenderer.js`.
    // A dense short sward, not sparse ribbons: 480k blades, ~2.2cm wide.
    drawnGrass: true, blades: 480000, bladeWidth: .022, grassLean: .38,
    groundBlend: .6, dryColor: "#b9ab63", grassDensity: 1,
    grassBrightness: .65, grassOcclusion: .65, grassVariation: .2, grassSpecular: 0,
    grassRoughness: 1, grassSky: 1,
  };
  static structuralProps = [...shapeKeys, ...placementKeys, "castShadow", "receiveShadow"];
  static schema = [
    { key: "species", label: "Species", type: "select", options: ["oak", "pine", "birch", "black-tupelo", "weeping-willow", "spruce", "maple", "poplar", "shrub", "hawthorn", "grass", "wildflowers"] },
    { key: "distribution", label: "Distribution", type: "select", options: ["single", "scatter", "placements"] },
    { key: "surface", label: "Surface", type: "entity" },
    { key: "leafDensity", label: "Leaf density", type: "number", min: .5, max: 1.6, step: .05 },
    { key: "leafSize", label: "Leaf size", type: "number", min: .6, max: 1.5, step: .05 },
    { key: "branchDensity", label: "Branch density", type: "number", min: .6, max: 1.4, step: .05 },
    { key: "crownBase", label: "Crown base offset", type: "number", min: -.15, max: .2, step: .01 },
    { key: "crownSpread", label: "Crown spread", type: "number", min: .7, max: 1.3, step: .05 },
    ...["density", "maxInstances", "seed", "height", "width", "minSpacing", "minSlope", "maxSlope", "minAltitude", "maxAltitude", "minScale", "maxScale", "windStrength", "windSpeed", "windDirection", "windGustStrength", "windScale", "windTurbulence", "interactionStrength", "interactionRadius", "lodNear", "lodFar", "maxDistance", "chunkSize", "shadowFar"].map(key => ({ key, label: key === "shadowFar" ? "Shadow handoff" : key.replace(/([A-Z])/g, " $1"), type: "number", step: ["seed", "maxInstances"].includes(key) ? 1 : .1 })),
    ...["leafColor", "barkColor", "flowerColor"].map(key => ({ key, label: key.replace("Color", " Color"), type: "color" })),
    // Grass is drawn rather than scattered, so it has its own handful of
    // controls. They do nothing for a tree, and the inspector hides them.
    ...[
      { key: "drawnGrass", label: "Drawn grass", type: "boolean",
        hint: "Draw a continuous sward in the shader instead of scattering clumps. Off falls back to the old scattered prototypes." },
      { key: "blades", label: "Blade budget", type: "number", min: 0, max: 2400000, step: 10000,
        hint: "Blades drawn across the whole field. Cost is linear in this and in nothing else." },
      { key: "grassDensity", label: "Coverage", type: "number", min: 0, max: 1, step: .02,
        hint: "Share of the budget that survives. Thins the sward without changing what it costs to consider." },
      { key: "bladeWidth", label: "Blade width (m)", type: "number", min: .002, max: .3, step: .002 },
      { key: "grassLean", label: "Blade lean", type: "number", min: 0, max: 1.2, step: .05 },
      { key: "groundBlend", label: "Blend with ground", type: "number", min: 0, max: 1, step: .05,
        hint: "How much of the terrain's own colour the base of a blade takes." },
      { key: "dryColor", label: "Dry Color", type: "color" },
    ].map(field => ({ ...field, showIf: props => props.species === "grass" })),
    ...["alignToNormal", "wind", "interaction", "castShadow", "receiveShadow"].map(key => ({ key, label: key.replace(/([A-Z])/g, " $1"), type: "boolean" })),
    { key: "runInEditor", label: "Run In Editor", type: "boolean" },
  ];

  constructor(props) {
    // Component spreads defaults shallowly. A script may append authored
    // placements, so the empty default must belong to this instance alone.
    // Explicit lists (including invalid null) retain the ordinary prop contract.
    super({ placements: [], ...props });
    this.root = null;
    this.chunks = [];
    this.renderMeshes = [];
    this.instances = [];
    // Runtime-only streamed plants (World chunk streaming): groupKey ->
    // { placements, instances, chunks, maxScale }. Never serialized; see
    // `setStreamedPlacements`. `_ownInstances` is the props-derived half of
    // `this.instances`, which is always own + every streamed group.
    this._streamed = new Map();
    this._ownInstances = [];
    this._streamedMaxScale = 0;
    // The shared shader bucket for these props (uniforms now, material lazily
    // in `_rebuildShape` exactly as before) — see `acquireFoliageEntry`.
    // Eleven foliage components used to mean eleven copies of one shader.
    this._materialEntry = acquireFoliageEntry(this.props);
    this.uniforms = this._materialEntry.uniforms;
    this._time = 0;
    this._generation = 0;
    this._lodProps = {};
    this._batchOrderMask = 0;
    // ⭐ P1-B commit-generation bookkeeping (`foliageBatchOrder.js`): bumped
    // whenever a chunk's tier membership actually changes, so `_commitBatches`
    // knows when its per-tier resumable jobs must restart against a FRESH,
    // consistent snapshot (`chunk.commitMask`) instead of independently
    // rebuilding whenever a completed tier's slot merely happens to be null.
    this._batchVersion = 0;
    this._batchCommitVersion = -1;
    // Per-TIER, not per-component: the impostor mesh is born long after the
    // near/mid tiers already have their first commit behind them (it waits
    // on the atlas bake), so a single component-wide "first commit" flag
    // exempted the tree/grass tiers from spreading but left the impostor
    // tier's OWN debut commit to spread like any other — see
    // `_commitBatches`'s `spreadForLod`.
    this._tierEverCommitted = [false, false, false];
    // The impostor bake's arrival ramp (0..1 over .8 s once the bake resolves;
    // `foliageApplyImpostorRamp`'s live twin) and the atlas identity it tracks
    // to know when a NEW bake (not just the same one) has arrived.
    this._impostorRamp = 0;
    this._impostorRampStart = null;
    this._impostorAtlasSeen = null;
    // ⭐⭐ THE VIEWER'S WORLD POSITION, OWNED BY THIS COMPONENT (09-13, LOD
    // shadow fix). Read in `update()` from `engine.camera` — never from TSL's
    // builtin `cameraPosition`, which is the CURRENT RENDER PASS's camera and
    // is the light's shadow-map camera during a shadow pass — and written onto
    // every one of this component's own render meshes' `userData` so the
    // shared tree/grass and impostor materials' per-instance LOD crossfade
    // (`foliageMaterial.js`, `impostorMaterial.js`) fades by distance from the
    // real viewer in EVERY pass, shadow included. One Vector3, mutated in
    // place every frame, shared by reference across this component's meshes.
    this._viewerPosition = new THREE.Vector3();
    this._stats = { instances: 0, chunks: 0, drawCalls: 0, triangles: 0, nearChunks: 0, midChunks: 0, impostorChunks: 0, culledChunks: 0, impostorReady: false, status: "Detached", colliders: 0 };
  }

  get stats() { return { ...this._stats }; }

  onAttach() {
    if (this.entity.engine._foliageModuleEnabled === false) return;
    if (this.root) this.onDetach();
    this._alive = true;
    this.root = new THREE.Group();
    this.root.name = "Foliage";
    // Keep ownership in the entity subtree for picking/framing while the
    // instance data and billboard shader remain explicitly in world space.
    this.root.matrixAutoUpdate = false;
    this.root.matrixWorldAutoUpdate = false;
    Object.assign(this.root.userData, { foliageOwned: true, entityId: this.entity.id });
    this.entity.object3D.add(this.root);
    const engine = this.entity.engine;
    this._unsub = [
      engine.onPreRender?.(() => this.update()),
      engine.on?.("component-changed", event => {
        if (!event || event.componentType === "foliage" || !geometrySourceKeys.has(event.key)) return;
        if (this._sourceIds?.has(event.entityId)) this._layoutDirty = true;
      }),
      engine.on?.("model-loaded", () => { this._checkSurface = true; }),
      engine.on?.("hierarchy-changed", () => { this._checkSurface = true; }),
      engine.on?.("component-added", () => { this._checkSurface = true; }),
      engine.on?.("component-removed", () => { this._checkSurface = true; }),
    ];
    this._shapeDirty = true;
    this._layoutDirty = true;
    this._resample = true;
    this._checkSurface = true;
    if (this._syncGrass() && this._packedField) this._grass.setField(this._packedField);
    this.update(true);
  }

  /** Grass is drawn, not scattered; every other species keeps the prototype
   * pipeline. This is the one switch that decides which one runs. */
  get drawsGrass() { return this.props.species === "grass" && this.props.drawnGrass !== false; }

  _syncGrass() {
    if (!this.drawsGrass) {
      this._grass?.dispose(); this._grass = null;
      return false;
    }
    this._grass ??= new GrassRenderer(this.root, this.uniforms);
    this._grass.configure({
      // A drawn sward has no impostors and no cells, but "detail distance" and
      // "draw distance" mean exactly what they say — so they are those controls
      // rather than a second pair the author has to find.
      blades: this.props.blades, near: Math.min(this.props.lodNear, this.props.maxDistance * .8),
      far: this.props.maxDistance,
      density: this.props.grassDensity, height: this.props.height, width: this.props.bladeWidth,
      heightVariation: .45, lean: this.props.grassLean, groundBlend: this.props.groundBlend,
      style: "natural", color: this.props.barkColor, tipColor: this.props.leafColor,
      dryColor: this.props.dryColor, castShadow: this.props.castShadow, receiveShadow: this.props.receiveShadow,
      brightness: this.props.grassBrightness, occlusion: this.props.grassOcclusion,
      variation: this.props.grassVariation, specular: this.props.grassSpecular,
      roughness: this.props.grassRoughness, sky: this.props.grassSky,
    });
    return true;
  }

  /**
   * The ground this grass grows on, from a generator that already has it.
   * Without one the renderer derives a field from the placements instead, so a
   * hand-scattered patch still draws.
   */
  setPackedField(packed) {
    this._packedField = packed ?? null;
    if (this._grass) this._grass.setField(this._packedField);
    return this._packedField;
  }

  /**
   * World chunk streaming feed (09-14): replace one streaming group's plants
   * without rebuilding the population. `placements` are in this entity's LOCAL
   * frame, shaped like `props.placements` (`id` optional — one is derived from
   * the group key); `null`/`[]` removes the group.
   *
   * Only that group's foliage chunks are created or disposed: prototypes,
   * material, impostor atlas and every other chunk (authored or another group)
   * are untouched. The three shared render meshes are replaced only when the
   * population outgrows their capacity (then with 25 % headroom). Batch commits
   * restart against a fresh snapshot, so a spread commit settles within
   * `FOLIAGE_ORDER_SETTLE_FRAMES`; the live draw keeps its previous picture
   * meanwhile. Streamed plants are runtime state: never in `props.placements`,
   * never serialized, and re-created after any layout or shape rebuild.
   */
  setStreamedPlacements(groupKey, placements) {
    if (typeof groupKey !== "string" || !groupKey) throw new TypeError("A streamed foliage group needs a nonempty string key");
    if (placements != null && !Array.isArray(placements)) throw new TypeError("Streamed placements must be an array or null");
    const list = placements?.length ? placements : null;
    const had = this._streamed.has(groupKey);
    if (!list && !had) return;
    // Built = chunks exist for the current prototypes and layout; otherwise the
    // pending `_rebuildLayout` picks the group up from `_streamed`.
    const built = !!(this._alive && this.root && this.geometries && !this._shapeDirty && !this._layoutDirty && !this.drawsGrass);
    if (had) {
      if (built) this._retireStreamedChunks(groupKey);
      this._streamed.delete(groupKey);
    }
    if (list) {
      const normalized = list.map((plant, index) => plant?.id ? plant : { ...plant, id: `${groupKey}#${index}` });
      this._streamed.set(groupKey, { placements: normalized, instances: [], chunks: [], maxScale: 1 });
      if (built) this._appendStreamedGroup(groupKey, foliageCellSize(this.props));
      else if (this.entity?.object3D) this._resolveStreamedGroup(this._streamed.get(groupKey));
    }
    this._composeInstances();
    if (built) {
      this._ensureBatchCapacity();
      if (this._atlasEntry?.atlas) this._buildImpostors(); else this._buildRenderBatches();
      this._orderSpread = null;
      this._orderDirty = true;
      this._batchDirty = true;
      this._batchVersion++;
      this._stats.chunks = this.chunks.length;
      if (this.instances.length) this._stats.status = "Ready";
    }
  }

  _resolveStreamedGroup(group) {
    this.entity.object3D.updateWorldMatrix(true, false);
    group.instances = resolveFoliagePlacements(group.placements, this.entity.object3D.matrixWorld);
    group.maxScale = group.instances.reduce((largest, plant) => Math.max(largest, plant.scale), 1);
  }

  /** Resolve one stored group against the entity's CURRENT transform and
   * append its chunks. Callers own batch/impostor bookkeeping afterwards. */
  _appendStreamedGroup(groupKey, cellSize) {
    const group = this._streamed.get(groupKey);
    this._resolveStreamedGroup(group);
    group.chunks = partitionFoliage(group.instances, cellSize)
      .map(item => this._createChunk({ key: `${groupKey}|${item.key}`, instances: item.instances }, groupKey));
    for (const chunk of group.chunks) this.chunks.push(chunk);
  }

  /** Detach and release the chunks of one group (or every group). `this.chunks`
   * gets a NEW array, so any in-flight batch-order job restarts. */
  _retireStreamedChunks(groupKey = null) {
    const retired = [];
    for (const [key, group] of this._streamed) {
      if (groupKey != null && key !== groupKey) continue;
      retired.push(...group.chunks);
      group.chunks = [];
    }
    if (!retired.length) return;
    const gone = new Set(retired);
    this.chunks = this.chunks.filter(chunk => !gone.has(chunk));
    this._orderedChunks = null;
    for (const chunk of retired) for (const mesh of chunk.meshes) mesh?.removeFromParent();
    deferFoliageDisposal(this, () => {
      for (const chunk of retired) for (let lod = 0; lod < chunk.meshes.length; lod++) {
        const mesh = chunk.meshes[lod];
        if (!mesh) continue;
        if (lod === 2) mesh.geometry.dispose();
        mesh.dispose?.();
      }
    });
  }

  /** `this.instances` = props-derived plants followed by every streamed group. */
  _composeInstances() {
    const own = this._ownInstances ?? [];
    let streamed = 0, maxScale = 0;
    for (const group of this._streamed.values()) { streamed += group.instances.length; maxScale = Math.max(maxScale, group.maxScale); }
    this.instances = streamed ? own.concat(...[...this._streamed.values()].map(group => group.instances)) : own;
    this._streamedMaxScale = maxScale;
    Object.assign(this._stats, { instances: this.instances.length, streamedGroups: this._streamed.size, streamedInstances: streamed });
  }

  /** A shared render mesh is sized for the population it was built for; a
   * streamed feed can outgrow it, or unload most of it. Retire any that are
   * too small, or more than 4x too large past 1024 plants (so unloading really
   * releases the bytes, with hysteresis against thrash); the next
   * `_buildRenderBatches` recreates them with headroom. */
  _ensureBatchCapacity() {
    const needed = this.instances.length;
    for (let lod = 0; lod < 3; lod++) {
      const mesh = this.renderMeshes[lod];
      if (!mesh) continue;
      const capacity = lod < 2 ? Math.floor(mesh.instanceMatrix.array.length / 16) : mesh.geometry.attributes.aCenter.count;
      if (capacity >= needed && !(capacity > 1024 && capacity > needed * 4)) continue;
      mesh.removeFromParent();
      this.renderMeshes[lod] = null;
      this._tierEverCommitted[lod] = false;
      if (this._orderSpread) this._orderSpread[lod] = null;
      deferFoliageDisposal(this, () => { if (lod === 2) mesh.geometry.dispose(); mesh.dispose?.(); });
    }
  }

  /**
   * Bytes this population holds for its plants (09-14, streaming residency):
   * `instances` = every instanceMatrix array (per-chunk + shared batches),
   * `impostors` = every impostor geometry attribute array, `records` = the
   * per-plant JS transform records (an estimate: 16 matrix doubles + position,
   * quaternion and normal arrays), `prototypes` = the shared prototype
   * geometry (reported, not in `total`).
   */
  memoryBytes() {
    const geometryBytes = geometry => {
      if (!geometry) return 0;
      let bytes = geometry.index?.array.byteLength ?? 0;
      for (const attribute of Object.values(geometry.attributes)) bytes += attribute.array?.byteLength ?? 0;
      return bytes;
    };
    let instances = 0, impostors = 0;
    for (const chunk of this.chunks) {
      instances += chunk.meshes[0]?.instanceMatrix.array.byteLength ?? 0;
      if (chunk.meshes[1] && chunk.meshes[1].instanceMatrix !== chunk.meshes[0]?.instanceMatrix) instances += chunk.meshes[1].instanceMatrix.array.byteLength;
      impostors += geometryBytes(chunk.meshes[2]?.geometry);
    }
    for (let lod = 0; lod < 3; lod++) {
      const mesh = this.renderMeshes[lod];
      if (!mesh) continue;
      if (lod < 2) instances += mesh.instanceMatrix.array.byteLength;
      else impostors += geometryBytes(mesh.geometry);
    }
    const records = this.instances.length * (16 + 3 + 4 + 3) * 8;
    const prototypes = (this.geometries ?? []).reduce((sum, geometry) => sum + geometryBytes(geometry), 0);
    return { instances, impostors, records, prototypes, total: instances + impostors + records };
  }

  onDetach() {
    this._alive = false;
    this._generation++;
    this._grass?.dispose(); this._grass = null;
    for (const unsub of this._unsub ?? []) unsub?.();
    this._unsub = [];
    this._disposeChunks();
    const oldGeometries = this.geometries;
    deferFoliageDisposal(this, () => { for (const geometry of oldGeometries ?? []) geometry.dispose(); });
    this.geometries = null;
    // The material is SHARED with every other component in this bucket — drop a
    // reference, never dispose. The last holder out disposes it.
    const oldEntry = this._materialEntry; this._materialEntry = null; this.material = null;
    deferFoliageDisposal(this, () => releaseFoliageEntry(oldEntry));
    const oldImpostorMaterial = this._impostorMaterial; this._impostorMaterial = null;
    deferFoliageDisposal(this, () => oldImpostorMaterial?.dispose());
    const oldAtlas = this._atlasEntry; this._atlasEntry = null;
    deferFoliageDisposal(this, () => releaseAtlas(oldAtlas));
    this.root?.removeFromParent(); this.root = null;
    this.instances = [];
    this._surfaceStamp = null;
    this._scatterResult = null;
    Object.assign(this._stats, { instances: 0, chunks: 0, drawCalls: 0, triangles: 0, impostorReady: false });
    this._stats.status = "Detached";
  }

  onDisable() { if (this.root) this.root.visible = false; }
  onEnable() { if (this.root) this.root.visible = true; }
  /** Where a hand-scattered patch of grass is, so a field can be derived. */
  _grassBounds() {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const instance of this.instances) {
      const [x, , z] = instance.position;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
    if (!Number.isFinite(minX)) return { extent: 64, resolution: 128, origin: [0, 0] };
    const margin = Math.max(2, this.props.width);
    const extent = Math.max(8, Math.max(maxX - minX, maxZ - minZ) + margin * 2);
    return { extent, resolution: Math.min(256, Math.max(32, Math.round(extent / .5))),
      origin: [(minX + maxX) / 2, (minZ + maxZ) / 2] };
  }

  onPropChanged(key) {
    if (!this._alive) return;
    if (GRASS_KEYS.has(key)) this._grassDirty = true;
    if (key === "species") { this._grassDirty = true; this._syncGrass(); }
    if (shapeKeys.has(key)) this._shapeDirty = true;
    if (placementKeys.has(key)) {
      this._layoutDirty = true;
      if (key !== "chunkSize") this._resample = true;
    }
    if (key === "surface" || key === "distribution") this._checkSurface = true;
    if (key === "castShadow" || key === "receiveShadow") {
      for (const mesh of this.renderMeshes) if (mesh) mesh[key] = !!this.props[key];
    }
    updateFoliageUniforms(this.uniforms, this.props, this._windTime ?? this._time, sceneWind(this.entity.engine));
    this._expandMotionBounds();
  }

  _expandMotionBounds() {
    const margin = this._motionMargin();
    if (margin <= (this._motionEnvelope ?? 0)) return;
    this._motionEnvelope = margin;
    for (const chunk of this.chunks) {
      const extra = Math.max(0, margin - chunk.motionMargin);
      if (!extra) continue;
      chunk.motionMargin = margin;
      chunk.bounds.expandByScalar(extra); chunk.sphere.radius += extra;
      for (const mesh of chunk.meshes.slice(0, 2)) {
        mesh.boundingBox.expandByScalar(extra); mesh.boundingSphere.radius += extra;
      }
      if (chunk.meshes[2]) {
        chunk.meshes[2].geometry.boundingSphere.copy(chunk.sphere);
        chunk.meshes[2].geometry.boundingBox.copy(chunk.bounds);
      }
    }
    this._batchDirty = true;
  }

  _resolveSurface() {
    if (this.props.distribution !== "scatter") return null;
    const engine = this.entity.engine;
    if (this.props.surface) return engine.getEntity?.(this.props.surface)?.object3D ?? null;
    if (this.entity.getComponent?.("terrain") || this.entity.getComponent?.("mesh") || this.entity.getComponent?.("model")) return this.entity.object3D;
    return this.entity.parent?.object3D ?? null;
  }

  _inspectSurface(source) {
    const stamps = [];
    this._sourceIds = new Set();
    const visit = object => {
      if (object.userData?.foliageOwned || object.userData?.batchProxy || object.userData?.mergeProxy || object.userData?.impostorQuad) return;
      const visible = object.visible !== false || !!object.userData?.batchedInto || !!object.userData?.mergedInto;
      stamps.push(`${object.uuid}:${visible}`);
      if (object.userData?.entityId) this._sourceIds.add(object.userData.entityId);
      if (object.isMesh && object.geometry?.attributes?.position) {
        object.updateWorldMatrix(true, false);
        const geometry = object.geometry;
        stamps.push(`${object.uuid}:${geometry.uuid}:${geometry.attributes.position.version}:${geometry.index?.version ?? 0}:${object.instanceMatrix?.version ?? 0}:${object.matrixWorld.elements.join(",")}`);
      }
      for (const child of object.children ?? []) visit(child);
    };
    if (source) visit(source);
    if (this.props.distribution === "single" || this.props.distribution === "placements") {
      this.entity.object3D.updateWorldMatrix(true, false);
      stamps.push(this.entity.object3D.matrixWorld.elements.join(","));
    }
    return stamps.join("|");
  }

  _rebuildShape() {
    this._shapeDirty = false;
    this._generation++;
    this._disposeChunks();
    const oldGeometries = this.geometries;
    deferFoliageDisposal(this, () => { for (const geometry of oldGeometries ?? []) geometry.dispose(); });
    const buildStart = performance.now();
    this.geometries = [createFoliagePrototype(this.props, 0), createFoliagePrototype(this.props, 1)];
    // One population's CPU prototype build, unsliced (a single tree/shrub is
    // low single-digit ms — see `treeGrowth.js`'s `growTreeSkeletonSteps`);
    // "population" is the entity's own name, which `WorldComponent._commit`
    // sets from the ecology group id (`oak-wide`, `pine-tall`, ...), so this
    // reads as which stand is expensive rather than only "species: oak" x11.
    freeze.bootMark(`foliage: prototypes ${this.entity?.name ?? this.props.species}`,
      performance.now() - buildStart, `species=${this.props.species}, 1 slice(s)`);
    // The bucket covers species (the only prop that shapes the graph) AND every
    // prop written into the shared uniforms, so a key change is exactly the old
    // `_materialSpecies` check plus the cases that would have made two holders
    // fight over one uniform. ⚠ ACQUIRE BEFORE RELEASING: a rebuild that lands
    // on the same key must not drop the refcount to zero in between and dispose
    // the material it is about to reuse. The material is SHARED — never dispose
    // it here; `releaseFoliageEntry` owns that.
    const key = foliageMaterialKey(this.props);
    // `onDetach` drops the reference, so a re-attached component arrives here
    // holding nothing.
    if (!this._materialEntry) {
      this._materialEntry = acquireFoliageEntry(this.props);
      this.uniforms = this._materialEntry.uniforms;
      this.material = null;
    } else if (this._materialEntry.key !== key) {
      const previous = this._materialEntry;
      this._materialEntry = acquireFoliageEntry(this.props);
      this.uniforms = this._materialEntry.uniforms;
      this.material = null;
      deferFoliageDisposal(this, () => releaseFoliageEntry(previous));
    }
    this.material = foliageEntryMaterial(this._materialEntry, this.props);
    this.geometries[0].boundingBox.getSize(prototypeSize);
    this._prototypeSize = Math.max(prototypeSize.x, prototypeSize.y, prototypeSize.z);
    const oldImpostorMaterial = this._impostorMaterial; this._impostorMaterial = null;
    deferFoliageDisposal(this, () => oldImpostorMaterial?.dispose());
    const oldAtlas = this._atlasEntry; this._atlasEntry = null;
    deferFoliageDisposal(this, () => releaseAtlas(oldAtlas));
    this._layoutDirty = true;
  }

  _motionMargin() {
    let maxScale = Math.max(1, Number(this.props.minScale) || 1, Number(this.props.maxScale) || 1);
    if (this.props.distribution === "placements") maxScale = Math.max(maxScale, this._placementMaxScale ?? 1);
    if (this._streamedMaxScale) maxScale = Math.max(maxScale, this._streamedMaxScale);
    if (this.props.distribution === "single") {
      this.entity.object3D.getWorldScale(scale);
      maxScale = Math.max(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z));
    }
    // The shader clamps blade curvature and tree joint angles, so this envelope
    // remains valid even when Scene wind changes sharply. Tree displacement
    // grows with limb length and world scale, not the old translation strength.
    const meadow = this.props.species === "grass" || this.props.species === "wildflowers";
    return 1 + (meadow ? 1.1 : .35) * (this._prototypeSize || Number(this.props.height) || 1) * maxScale;
  }

  _disposeChunks() {
    const renderMeshes = this.renderMeshes, chunks = this.chunks;
    this.renderMeshes = []; this.chunks = [];
    // Streamed groups keep their placements; their chunks go with the rest and
    // are re-created by the next `_rebuildLayout`.
    for (const group of this._streamed?.values() ?? []) group.chunks = [];
    this._orderedChunks = null;
    this._orderDirty = true;
    for (const mesh of renderMeshes) mesh?.removeFromParent();
    for (const chunk of chunks) for (const mesh of chunk.meshes) mesh?.removeFromParent();
    // A compiler may still hold an old render object after its async node build.
    // Withdraw it immediately, then release its captured resources when it exits.
    deferFoliageDisposal(this, () => {
      for (let lod = 0; lod < renderMeshes.length; lod++) {
        const mesh = renderMeshes[lod];
        if (!mesh) continue;
        if (lod === 2) mesh.geometry.dispose();
        mesh.dispose?.();
      }
      for (const chunk of chunks) for (let lod = 0; lod < chunk.meshes.length; lod++) {
        const mesh = chunk.meshes[lod];
        if (!mesh) continue;
        if (lod === 2) mesh.geometry.dispose();
        mesh.dispose?.();
      }
    });
    this._batchDirty = true;
    this._batchVersion++;
    this._orderSpread = null;
    // Brand-new mesh objects with nothing committed yet — their first commit
    // must be synchronous again, exactly like the component's very first one.
    this._tierEverCommitted = [false, false, false];
  }

  /** Where every plant sits, independent of whether it is ever turned into
   * prototype meshes. A drawn sward still needs this: `setFieldFromPlacements`
   * derives its field from `this.instances`, and an architecture footprint has
   * to exclude the grass under it exactly as it does for scattered clumps —
   * see the split from `_rebuildLayout` below. */
  _computeInstances(source) {
    if (this.props.distribution === "single") {
      this.entity.object3D.updateWorldMatrix(true, false);
      this.entity.object3D.matrixWorld.decompose(position, quaternion, scale);
      this.instances = [{ position: position.toArray(), quaternion: quaternion.toArray(), normal: [0, 1, 0], scale: 1, matrix: this.entity.object3D.matrixWorld.clone() }];
    } else if (this.props.distribution === "placements") {
      this.entity.object3D.updateWorldMatrix(true, false);
      this.instances = resolveFoliagePlacements(this.props.placements, this.entity.object3D.matrixWorld);
      this._placementMaxScale = this.instances.reduce((largest, plant) => Math.max(largest, plant.scale), 1);
      this._scatterResult = null;
    } else {
      const surface = source ? collectSurfaceTriangles(source, this.props) : null;
      let result = null;
      if (surface && !this._resample && this._scatterResult?.surface.topologyKey === surface.topologyKey) {
        const candidates = this._scatterResult.instances;
        const reseated = reseatFoliageInstances(surface, candidates);
        if (!reseated.invalid) result = { ...this._scatterResult, surface, instances: candidates };
      }
      if (!result && surface) result = scatterFoliage(surface, this.props);
      const exclusions = this.entity.engine.architecture?.snapshot();
      this.instances = exclusions ? (result?.instances ?? []).filter(instance => !exclusions.excludes(instance.position)) : result?.instances ?? [];
      this._scatterResult = result;
    }
    this._resample = false;
    this._ownInstances = this.instances;
    this._composeInstances();
  }

  /** One foliage chunk (two instanced LOD meshes, bounds, plant measures) for a
   * partition item. `streamGroup` marks a chunk owned by a streamed group. */
  _createChunk(item, streamGroup = null) {
    const chunk = { ...item, streamGroup, meshes: [], level: -1, sphere: new THREE.Sphere(), bounds: new THREE.Box3(), detailBounds: new THREE.Box3(), motionMargin: this._motionMargin() };
    for (let lod = 0; lod < 2; lod++) {
      const mesh = tagMesh(new THREE.InstancedMesh(this.geometries[lod], this.material, item.instances.length), this.entity.id);
      mesh.name = `Foliage ${this.props.species} · LOD${lod} · ${item.key}`;
      mesh.castShadow = !!this.props.castShadow;
      mesh.receiveShadow = !!this.props.receiveShadow;
      if (lod === 0) {
        for (let i = 0; i < item.instances.length; i++) mesh.setMatrixAt(i, item.instances[i].matrix ?? instanceMatrix(item.instances[i]));
        mesh.instanceMatrix.needsUpdate = true;
      } else mesh.instanceMatrix = chunk.meshes[0].instanceMatrix;
      mesh.computeBoundingBox();
      mesh.computeBoundingSphere();
      chunk.detailBounds.union(mesh.boundingBox);
      // Vertex motion must stay inside frustum/shadow culling bounds.
      const margin = this._motionMargin();
      mesh.boundingSphere.radius += margin;
      mesh.boundingBox.expandByScalar(margin);
      chunk.bounds.union(mesh.boundingBox);
      mesh.visible = lod === 0;
      chunk.meshes.push(mesh);
    }
    chunk.bounds.getBoundingSphere(chunk.sphere);
    this._measureChunkPlants(chunk);
    return chunk;
  }

  _rebuildLayout(source) {
    this._layoutDirty = false;
    // Attributed per population (freeze ledger; see the freeze `foliage:*`
    // marks docs/WORLD_PRODUCTION_PLAN.md §7.6 asked for) so a World commit's
    // block names WHICH population's scatter/partition it spent time in,
    // rather than reading as one opaque `(unattributed)` span.
    const label = this.entity?.name ?? this.props.species;
    freeze.run(`foliage:layout ${label}`, () => this._computeInstances(source));
    const cellSize = foliageCellSize(this.props);
    // Streamed groups are partitioned separately (their chunk keys carry the
    // group key) and re-created below against the entity's current transform.
    const partition = freeze.run(`foliage:chunks ${label}`, () => partitionFoliage(this._ownInstances, cellSize));
    const ownChunks = this.chunks.filter(chunk => chunk.streamGroup == null);
    const reuse = partition.length === ownChunks.length && partition.every((item, index) => item.key === ownChunks[index].key && item.instances.length === ownChunks[index].instances.length);
    if (reuse) {
      this._retireStreamedChunks();
      this.chunks = ownChunks;
      for (let index = 0; index < partition.length; index++) {
        const chunk = this.chunks[index];
        chunk.instances = partition[index].instances;
        chunk.bounds.makeEmpty();
        chunk.detailBounds.makeEmpty();
        for (let i = 0; i < chunk.instances.length; i++) chunk.meshes[0].setMatrixAt(i, chunk.instances[i].matrix ?? instanceMatrix(chunk.instances[i]));
        chunk.meshes[0].instanceMatrix.needsUpdate = true;
        for (const mesh of chunk.meshes.slice(0, 2)) {
          mesh.computeBoundingBox(); mesh.computeBoundingSphere();
          chunk.detailBounds.union(mesh.boundingBox);
          const margin = this._motionMargin();
          mesh.boundingSphere.radius += margin; mesh.boundingBox.expandByScalar(margin);
          chunk.bounds.union(mesh.boundingBox);
        }
        chunk.bounds.getBoundingSphere(chunk.sphere);
        this._measureChunkPlants(chunk);
        chunk.motionMargin = this._motionMargin();
        if (chunk.meshes[2]) this._writeImpostor(chunk, chunk.meshes[2].geometry);
      }
    } else this._disposeChunks();
    for (const item of reuse ? [] : partition) this.chunks.push(this._createChunk(item));
    if (this._streamed.size) {
      freeze.run(`foliage:streamed ${label}`, () => { for (const key of this._streamed.keys()) this._appendStreamedGroup(key, cellSize); });
      this._composeInstances();
      this._ensureBatchCapacity();
    }
    if (this._atlasEntry?.atlas) freeze.run(`foliage:impostors ${label}`, () => this._buildImpostors());
    freeze.run(`foliage:batches ${label}`, () => this._buildRenderBatches());
    this._batchDirty = true;
    this._orderDirty = true;
    // The "reuse" branch above mutates existing chunk objects' `instances`/
    // instance matrices IN PLACE without changing `this.chunks`'s own array
    // identity, so a resumable job's `job.chunks !== chunks` check alone
    // would not notice the swap. Force a fresh commit-mask snapshot either way.
    this._batchVersion++;
    this._stats.instances = this.instances.length;
    this._stats.chunks = this.chunks.length;
    this._stats.effectiveCellSize = cellSize;
    this._motionEnvelope = this._motionMargin();
    this._stats.status = this.instances.length ? "Ready" : "Choose a mesh or Terrain surface";
    this.entity.engine.emit?.("hierarchy-changed");
  }

  _measureChunkPlants(chunk) {
    let maxScale = 0, minScale = Infinity;
    for (const instance of chunk.instances) {
      let scaleValue;
      if (instance.matrix) {
        instance.matrix.decompose(position, quaternion, scale);
        scaleValue = Math.max(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z));
      } else scaleValue = instance.scale || 1;
      maxScale = Math.max(maxScale, scaleValue);
      minScale = Math.min(minScale, scaleValue);
    }
    chunk.plantSize = this._prototypeSize * maxScale;
    // The per-instance shader (and `foliageTierWeights`) divides distance by
    // THIS instance's own world scale before comparing it to a threshold —
    // the chunk's box distance never does. A chunk's [nearest, farthest] box
    // range only bounds every instance's RAW distance; converting it to a
    // range that bounds every instance's SCALE-NORMALIZED distance needs the
    // chunk's own scale extremes: dividing the near edge by the largest scale
    // (which shrinks a big plant's normalized distance the most) and the far
    // edge by the smallest scale (which grows a small plant's the most) is
    // what keeps `foliageChunkTierMask`'s superset actually a superset.
    chunk.maxInstanceScale = maxScale || 1;
    chunk.minInstanceScale = Number.isFinite(minScale) ? Math.max(minScale, 1e-4) : 1;
  }

  /** [smallest, largest] instance scale over every chunk (authored + streamed),
   *  cached until the chunk set changes. */
  _instanceScaleBounds() {
    const chunks = this.chunks ?? [];
    if (this._scaleBoundsChunks === chunks && this._scaleBoundsCount === chunks.length && this._scaleBoundsStreamed === this._streamedMaxScale) return this._scaleBounds;
    let min = Infinity, max = 0;
    for (const chunk of chunks) {
      min = Math.min(min, chunk.minInstanceScale ?? 1);
      max = Math.max(max, chunk.maxInstanceScale ?? 1);
    }
    this._scaleBounds = [Number.isFinite(min) ? min : 1, max || 1];
    this._scaleBoundsChunks = chunks; this._scaleBoundsCount = chunks.length; this._scaleBoundsStreamed = this._streamedMaxScale;
    return this._scaleBounds;
  }

  _requestAtlas() {
    const engine = this.entity.engine;
    if (this._atlasEntry || !this.geometries || !this.chunks.length || !engine.renderer || engine.rendererReady === false || engine.impostors?.baking) return;
    // §impostor-ordering (09-13): a bake is a several-second job spread across
    // many real frames (`acquireAtlas`) — starting one while the owning World
    // is still laying out its OTHER features fights that generation for the
    // exact frame slices `WorldComponent._generate` budgets itself to
    // (`frameSliceBudget`), which is exactly what starved a boot's `world:
    // commit` behind bakes that had no business running yet. Gate only a
    // FRESH request: an entity outside a World (no owner found) bakes
    // immediately, exactly as before, and an already-baked/in-flight entry
    // (`this._atlasEntry`, checked above) is never re-gated once it exists.
    const world = owningWorld(this.entity.parent);
    if (world && world.status !== "Ready") return;
    const generation = this._generation;
    const entry = this._atlasEntry = acquireAtlas(engine.renderer, atlasKey(this.props), this.geometries[0], this.props, this.entity?.name);
    entry.promise.then(() => {
      if (!this._alive || this._generation !== generation || this._atlasEntry !== entry) return;
      if (entry.error) { this._stats.status = `Impostor unavailable: ${entry.error}`; return; }
      this._buildImpostors();
      this.entity.engine.emit?.("hierarchy-changed");
    });
  }

  _buildImpostors() {
    const entry = this._atlasEntry;
    if (!entry?.atlas || !this.root) return;
    if (!this._impostorMaterial) {
      this._impostorMaterial = entry.material.clone();
      // Three r185 NodeMaterial.copy misses Material's inherited alphaTest
      // accessor. Without this, a wind-enabled clone draws the empty atlas
      // background as an opaque black rectangle.
      this._impostorMaterial.alphaTest = entry.material.alphaTest;
      this._impostorMaterial.castShadowPositionNode = entry.material.castShadowPositionNode;
      setupFoliageImpostorMaterial(this._impostorMaterial, this.uniforms, this.props);
    }
    for (const chunk of this.chunks) {
      if (chunk.meshes[2]) continue;
      const geometry = createImpostorGeometry(chunk.instances.length);
      this._writeImpostor(chunk, geometry);
      const mesh = tagMesh(new THREE.Mesh(geometry, this._impostorMaterial), this.entity.id);
      mesh.userData.impostorQuad = true;
      mesh.raycast = (raycaster, intersections) => chunk.meshes[0].raycast(raycaster, intersections);
      mesh.name = `Foliage ${this.props.species} · Impostor · ${chunk.key}`;
      mesh.castShadow = !!this.props.castShadow;
      mesh.receiveShadow = !!this.props.receiveShadow;
      mesh.visible = false;
      chunk.meshes.push(mesh);
    }
    this._buildRenderBatches();
    this._batchDirty = true;
  }

  /** Spatial chunks choose detail, while only three shared meshes submit it.
   * Separate draw objects per tiny grass cell cost more CPU than their blades
   * cost GPU time, and each InstancedMesh also creates a shader variant. */
  _buildRenderBatches() {
    if (!this.root || !this.instances.length) return;
    // A streamed population grows and shrinks; headroom keeps a load from
    // replacing the shared meshes every time (`_ensureBatchCapacity`).
    // Stable sizes (`instanceCapacity.js`): three writes a ≤1024-matrix capacity
    // into the vertex WGSL, so an exact size compiled a new program per size and
    // missed the shader cache on every boot.
    const capacity = stableInstanceCapacity(this._streamed.size ? Math.ceil(this.instances.length * 1.25) : this.instances.length);
    for (let lod = 0; lod < 3; lod++) {
      if (this.renderMeshes[lod] || (lod === 2 && !this._impostorMaterial)) continue;
      const mesh = lod === 2
        ? new THREE.Mesh(createImpostorGeometry(capacity), this._impostorMaterial)
        : new THREE.InstancedMesh(this.geometries[lod], this.material, capacity);
      tagMesh(mesh, this.entity.id);
      mesh.name = `Foliage ${this.props.species} · batch LOD${lod}`;
      mesh.castShadow = !!this.props.castShadow; mesh.receiveShadow = !!this.props.receiveShadow;
      mesh.visible = false;
      // A per-mesh CONSTANT: the near mesh is always tier 0, the mid mesh
      // always tier 1, read back by the shared tree/grass material's
      // `.onObjectUpdate` (`foliageMaterial.js`) to pick which of its two
      // crossfade weights this draw wants — see the LOD block in `update()`
      // for the near/far/end/ramp fields written there every frame.
      if (lod < 2) mesh.userData.foliageLodTier = lod;
      // GI policy (2026-09-13, docs/FOLIAGE.md): at most ONE seated proxy per
      // population, and grass/wildflowers (ground-cover meadow species — no
      // trunk/canopy worth a GI proxy at any distance) get none at all. The
      // near tier (lod 0) never seats or bakes — it is the tier a viewer is
      // standing right next to, replaced every few frames as chunks stream,
      // and its instance count is the largest of the three. For a tree/shrub
      // population the mid tier (lod 1) is the one GI presence kept: capped
      // to MAX_FOLIAGE_INSTANCES_PER_MESH (GISystem.js) via `giInstanceCap`
      // — the biggest/closest instances win the seats (InstancedMesh order is
      // whatever `_rebuildLayout`/repacking wrote, not distance-sorted, so
      // this is a budget cap, not a "closest 48" guarantee). The impostor
      // tier (lod 2) is billboards with no volume worth occluding with.
      const meadowSpecies = this.props.species === "grass" || this.props.species === "wildflowers";
      if (lod === 0 || meadowSpecies) { mesh.userData.giTrace = "none"; mesh.userData.giMobility = "static"; }
      else if (lod === 1) mesh.userData.giInstanceCap = 48;
      // Three uploads DynamicDrawUsage on every render pass, even when its
      // version has not changed. Placements change only on an explicit repack;
      // both Three's Instance node and our wind reader mirror that version.
      if (lod < 2) { mesh.count = 0; mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage); }
      else {
        mesh.userData.impostorQuad = true;
        mesh.userData.giTrace = "none";
        mesh.userData.giMobility = "static";
        mesh.geometry.instanceCount = 0;
        for (const key of ["aCenter", "aSize", "aAxisX", "aAxisY"]) mesh.geometry.attributes[key].setUsage(THREE.StaticDrawUsage);
        mesh.raycast = (raycaster, intersections) => {
          for (const chunk of this.chunks) if (chunk.level === 2) chunk.meshes[0].raycast(raycaster, intersections);
        };
      }
      this.renderMeshes[lod] = mesh; this.root.add(mesh);
    }
  }

  /**
   * ⚡ TIER MASKS WITH SLACK (09-14, Complex scene at 37 fps). Every frame
   * re-classified every chunk against the exact tier bands, so a walking camera
   * flipped some chunk's mask almost every frame — 1.8 `_batchVersion` bumps a
   * frame at 0.1 m/frame over 2 457 chunks, 10 at 0.5 m/frame — which kept a
   * resumable commit pass and an instance-buffer upload running every frame:
   * ~1.4 ms per population, ~7.5 ms across the scene
   * (`scripts/bench-foliage-walk.mjs`). Masks are widened by `slack` metres on
   * both edges, so they stay a superset of what the shader's per-instance
   * weights need for any viewer within half the slack of where they were
   * computed (an extra tier holding a zero-weight instance dithers away — see
   * `_commitBatches`). The walk reruns once the viewer has moved that far, or
   * when anything else the masks read changes: the LOD thresholds, impostor
   * readiness or ramp, or a structural rebuild (every one bumps
   * `_batchVersion`; this walk's own bumps are recorded as `_tierVersion`).
   */
  _tierMasksCurrent(position, impostorReady, extendMidToImpostor, slack, force = false, midFromViewer = false) {
    const { near, far, end } = foliageLodThresholds(this.props);
    const key = `${impostorReady}|${extendMidToImpostor}|${midFromViewer}|${near}|${far}|${end}|${slack}|${this.chunks.length}`;
    const viewer = this._tierViewer ??= new THREE.Vector3();
    const current = !force && slack > 0 && this._tierKey === key && this._tierChunks === this.chunks
      && this._tierVersion === this._batchVersion
      && viewer.distanceToSquared(position) <= (slack / 2) ** 2;
    if (!current) { this._tierKey = key; this._tierChunks = this.chunks; viewer.copy(position); }
    return current;
  }

  _updateBatchOrder(camera, animating) {
    let mask = 0;
    if (globalThis.__foliageFrontToBack !== false) {
      for (let lod = 0; lod < this.renderMeshes.length; lod++) {
        if (foliageCanOrderMaterial(this.renderMeshes[lod]?.material)) mask |= 1 << lod;
      }
    }
    if (mask !== this._batchOrderMask) { this._batchOrderMask = mask; this._batchDirty = true; }
    if (!mask || this.chunks.length < 2 || !camera) return;
    // Paused casters retain their last packing: changing buffer versions on
    // camera yaw would invalidate otherwise unchanged native shadow caches.
    const casts = this.renderMeshes.some(mesh => mesh?.castShadow);
    const moving = animating && (this.uniforms.strength.value > 0 || this.uniforms.interaction.value > 0);
    if (casts && !moving) return;
    camera.getWorldDirection(viewDirection);
    const direction = foliageOrderDirection(viewDirection, this._orderDirection);
    if (direction !== this._orderDirection) {
      this._orderDirection = direction;
      this._orderDirty = this._batchDirty = true;
    }
  }

  /** ⭐ §patch-capacity-guard (09-13): `§mid-pass-accretion` below appends a
   * chunk straight onto a `.done` tier's live mesh the instant it needs a bit
   * that job no longer has a cursor left to pick up on its own — a tail grow,
   * never a remove, of a buffer sized for `this.instances.length`, the true
   * ceiling on any tier's membership. `appendChunkToTier` would throw
   * (`TypedArray.set` out of bounds) rather than silently corrupt neighbouring
   * instances if that ceiling were ever reached, so this checks capacity
   * FIRST: normally it appends exactly as before; on the rare occasion
   * appending would overflow, it instead does a full, correct rebuild from
   * the live `commitMask` right here (`commitBatchChunksFull`, the same
   * routine an ordinary non-spread commit already uses), which is exactly
   * the "current true membership" the buffer has room for. */
  _patchTierAppend(lod, chunk) {
    const mesh = this.renderMeshes[lod];
    if (!mesh) return;
    const capacity = lod < 2 ? Math.floor(mesh.instanceMatrix.array.length / 16) : mesh.geometry.attributes.aCenter.count;
    const current = lod < 2 ? mesh.count : mesh.geometry.instanceCount;
    if (current + chunk.instances.length > capacity) {
      const chunks = this._batchOrderMask & (1 << lod) ? this._orderedChunks ?? this.chunks : this.chunks;
      const bounds = lod === 2 ? (mesh.geometry.boundingBox ??= new THREE.Box3()) : (mesh.boundingBox ??= new THREE.Box3());
      bounds.makeEmpty();
      const count = commitBatchChunksFull(mesh, chunks, lod, bounds);
      finalizeCommittedMesh(mesh, lod, count, bounds);
    } else {
      appendChunkToTier(mesh, chunk, lod);
    }
  }

  /** Upload on changed LOD membership or a coarse opaque depth-order bin.
   * Whole typed-array ranges copy without touching individual plants.
   * Offscreen selected chunks stay present so their shadows remain correct.
   *
   * §batch-order-spread: below `FOLIAGE_ORDER_SPREAD_CHUNKS` this rewrites
   * every LOD mesh's buffer in one pass, exactly as it always has. Past it, a
   * per-LOD job (`this._orderSpread`) stages the same rewrite
   * `FOLIAGE_ORDER_CHUNKS_PER_FRAME` chunks at a time across successive
   * `update()`s — see `foliageBatchOrder.js` for why a bucket crossing must
   * not rewrite every chunk in one frame on a world-scale scatter. A LOD tier
   * finishes and swaps into the live mesh independently of the others; while
   * any tier still has work left, `_batchDirty` stays true so `update()`
   * calls this again next frame.
   *
   * ⭐ §batch-order-generation (P1-B, 09-13): a resumable job must not read
   * `chunk.tierMask` LIVE — `update()` mutates it every frame, so two jobs at
   * different cursor speeds could see the SAME chunk under two DIFFERENT
   * masks (one from before a reassignment, one from after) and both include
   * it: a real, persistent double-count, not just a stale-for-a-few-frames
   * picture. Every chunk's `commitMask` is instead FROZEN, once, whenever
   * `_batchVersion` (bumped only on an actual membership change — see
   * `update()`'s LOD block) moves past `_batchCommitVersion`; every lod's job
   * reads that frozen snapshot for its whole resumable run, and `_orderSpread`
   * is dropped entirely so all three restart together against it. A job that
   * has already finished for the CURRENT snapshot is marked `.done` and left
   * alone — it used to be nulled back out and unconditionally rebuilt from
   * scratch on the very next call merely because a SIBLING tier's job was
   * still spread across frames, which both wasted the work and reopened the
   * live-mutation race this snapshot exists to close. */
  _commitBatches() {
    if (this._orderDirty) {
      this._orderedChunks = this._orderDirection ? orderFoliageChunks(this.chunks, this._orderDirection) : null;
      this._orderDirty = false;
    }
    // ⭐ §tier-debut (P1-B follow-up): a render mesh's very FIRST commit ever
    // has no earlier picture to fall back on while it spreads — every chunk
    // would sit invisible in that tier for however long a full pass takes.
    // This is PER TIER, not per component: the impostor mesh is built long
    // after the near/mid tiers already have a settled commit behind them (it
    // waits on the atlas bake to resolve, `_requestAtlas`/`_buildImpostors`),
    // so a single component-wide flag exempted the tree/grass tiers' debut
    // but left the impostor tier's OWN debut to spread like any other commit
    // — measured as a real gap: a component whose bake had JUST resolved
    // showed correct near/mid coverage but the newborn impostor mesh sat at
    // `instanceCount === 0` for its first several frames regardless.
    // `_tierEverCommitted[lod]` (reset to all-false in the constructor and by
    // `_disposeChunks`) tracks this per render mesh; `spreadForLod` is what
    // every use of "spread" below checks instead of a single shared flag.
    const spreadCapable = this.chunks.length > FOLIAGE_ORDER_SPREAD_CHUNKS;
    const spreadForLod = lod => spreadCapable && this._tierEverCommitted[lod];
    // ⛔⚡ §starvation-guard (P1-B follow-up, "the disappearing logs" receipt):
    // refreezing `commitMask` from LIVE `tierMask` the INSTANT `_batchVersion`
    // moves is correct in isolation — it is what stops two jobs from ever
    // seeing one chunk under two different masks (`§batch-order-generation`
    // above) — but it starves the whole mechanism once the camera moves
    // CONTINUOUSLY and there are enough chunks to need the spread path at
    // all: with a few hundred chunks, some chunk's `tierMask` changes on
    // nearly every 0.5 m step, so `_batchVersion` was bumping, and this
    // block refreezing+nulling `_orderSpread`, before `stepBatchOrderJob`'s
    // `FOLIAGE_ORDER_CHUNKS_PER_FRAME`-per-tier-per-frame budget ever
    // finished a SINGLE pass. Measured on a 400-plant/275-chunk walk: 466
    // refreezes over 500 steps, and all three render meshes stayed at
    // `count === 0` — their very first, still-incomplete commit — for the
    // ENTIRE walk. That is not a pop or a flicker, it is the whole layer
    // never drawing anything.
    //
    // A resumable pass must instead be allowed to run to completion against
    // the snapshot it started with; only once EVERY tier's job for the
    // CURRENT snapshot has finished (or none has started yet) does the next
    // call adopt whatever `tierMask` has become by then. This bounds the
    // staleness a moving camera can see to "one pass's worth of frames"
    // instead of "forever", and a stationary or slow camera — where a pass
    // finishes before the next relevant change — sees no change at all.
    const midSpread = this._orderSpread?.some((job, lod) => spreadForLod(lod) && job && !job.done);
    // ⭐ §mid-pass-accretion: even with the settle-frames budget above, a
    // camera that keeps moving through the whole pass can still ask a chunk
    // for a NEW bit before that tier's cursor has reached it. Waiting for the
    // full settle point (below) to notice would leave the render mesh a
    // whole pass behind for that one bit — so while a pass is running,
    // `commitMask` is allowed to GROW (never shrink) every frame from the
    // live `tierMask`: a chunk whose job hasn't visited it yet this pass
    // picks up the freshest need the moment it does. Bits are never DROPPED
    // here — only the settle branch below does that — so this can only make
    // a chunk MORE included than strictly necessary for a few frames, never
    // less: an extra tier briefly drawing a near-zero-weight instance dithers
    // away silently (item 2d's "brighter dither", not a gap), while a
    // missing tier is the instance vanishing outright.
    if (midSpread) {
      // A bit that newly appears for a chunk this pass's job has ALREADY
      // PASSED — whether the job is fully `.done`, or just far enough along
      // that its cursor moved past this specific chunk (`chunk._visitedMask`,
      // set by `stepBatchOrderJob`) — has no cursor left to pick it up on its
      // own. A `.done` job's swap-in already happened, so the patch has to
      // land directly on the live mesh (`_patchTierAppend`, a capacity-safe
      // `appendChunkToTier`); a job still running would otherwise overwrite
      // that same patch the moment it finishes and swaps its OWN scratch in,
      // so the patch instead lands on the JOB'S scratch (`appendChunkToJob`),
      // which the eventual swap-in then carries through intact. A tier whose
      // cursor has NOT yet reached this chunk is left alone: it will see the
      // bit live (via `commitMask` above) once it gets there, so patching
      // here too would double-commit (this chunk would land once from the
      // job's own normal scan AND once from an eager patch, with nothing
      // ever retiring the extra copy until the next full rebuild).
      for (const chunk of this.chunks) {
        const before = chunk.commitMask, after = before | chunk.tierMask;
        if (after === before) continue;
        chunk.commitMask = after;
        const added = after & ~before;
        for (let lod = 0; lod < 3; lod++) {
          const bit = 1 << lod;
          if (!(added & bit) || !spreadForLod(lod)) continue;
          const job = this._orderSpread[lod];
          if (!job) continue;
          if (job.done) this._patchTierAppend(lod, chunk);
          else if (chunk._visitedMask & bit) appendChunkToJob(job, chunk, lod);
        }
      }
    } else if (this._batchCommitVersion !== this._batchVersion) {
      for (const chunk of this.chunks) chunk.commitMask = chunk.tierMask;
      this._batchCommitVersion = this._batchVersion;
      this._orderSpread = null;
    }
    let pending = false;
    for (let lod = 0; lod < this.renderMeshes.length; lod++) {
      const mesh = this.renderMeshes[lod];
      if (!mesh) continue;
      const spread = spreadForLod(lod);
      const chunks = this._batchOrderMask & (1 << lod) ? this._orderedChunks ?? this.chunks : this.chunks;
      const bounds = lod === 2 ? (mesh.geometry.boundingBox ??= new THREE.Box3()) : (mesh.boundingBox ??= new THREE.Box3());
      let count;
      if (spread) {
        this._orderSpread ??= [null, null, null];
        let job = this._orderSpread[lod];
        // A different `chunks` identity (a fresh sort, or a fresh chunk list
        // from a structural rebuild) invalidates whatever was in flight —
        // restart clean rather than finish a job built from stale input.
        if (!job || job.chunks !== chunks) { job = createBatchOrderJob(mesh, lod, chunks); job.chunks = chunks; this._orderSpread[lod] = job; }
        // Already fully committed for the current snapshot — a sibling tier
        // still catching up must not force this one to redo settled work
        // (any bit that arrived since is `appendChunkToTier`'s job, above).
        if (job.done) continue;
        if (!stepBatchOrderJob(job, chunks, lod, foliageCommitBudget(chunks.length))) { pending = true; continue; }
        bounds.copy(job.bounds);
        if (lod < 2) mesh.instanceMatrix.array.set(job.matrix);
        else for (const key of ["aCenter", "aSize", "aAxisX", "aAxisY"]) mesh.geometry.attributes[key].array.set(job.attrs[key]);
        count = job.count;
        job.done = true;
      } else {
        bounds.makeEmpty();
        count = commitBatchChunksFull(mesh, chunks, lod, bounds);
        // This lod took the fast path instead of a resumable job this call —
        // drop any stale job sitting in its slot so a LATER switch into
        // spreading (`_tierEverCommitted[lod]` flips true right below) starts
        // clean rather than resuming a job built for a different pass.
        if (this._orderSpread) this._orderSpread[lod] = null;
      }
      finalizeCommittedMesh(mesh, lod, count, bounds);
      this._tierEverCommitted[lod] = true;
    }
    this._batchDirty = pending;
  }

  _writeImpostor(chunk, geometry) {
      const entry = this._atlasEntry;
      const attrs = geometry.attributes;
      for (let i = 0; i < chunk.instances.length; i++) {
        const instance = chunk.instances[i];
        const transform = instance.matrix ?? instanceMatrix(instance);
        transform.decompose(position, quaternion, scale);
        position.copy(entry.atlas.center).applyMatrix4(transform);
        axisX.set(1, 0, 0).applyQuaternion(quaternion);
        axisY.set(0, 1, 0).applyQuaternion(quaternion);
        attrs.aCenter.setXYZ(i, position.x, position.y, position.z);
        attrs.aSize.setX(i, entry.atlas.radius * 2 * Math.max(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z)));
        attrs.aAxisX.setXYZ(i, axisX.x, axisX.y, axisX.z);
        attrs.aAxisY.setXYZ(i, axisY.x, axisY.y, axisY.z);
      }
      geometry.instanceCount = chunk.instances.length;
      for (const attribute of Object.values(attrs)) attribute.needsUpdate = true;
      geometry.boundingSphere.copy(chunk.sphere);
      geometry.boundingBox = chunk.bounds.clone();
  }

  /** Public for diagnostic fixtures; normally driven by Engine.onPreRender. */
  update(force = false) {
    if (!this._alive || !this.root) return;
    const engine = this.entity.engine;
    this.reconcileEnabled();
    this.root.visible = this.enabled && visibleEntity(this.entity, engine.playing);
    if (!this.root.visible || engine.simulationSuspended === true) return;
    // `_time` is the component's general timer (surface-check cadence,
    // interactions) — it always advances. The WIND clock is `_windTime` below,
    // and THAT is what "Run In Editor" freezes.
    this._time += Math.min(.1, Math.max(0, Number(engine.deltaTime) || 0));
    const source = this._resolveSurface();
    const architecture = engine.architecture?.snapshot();
    const architectureStamp = architecture?.revision ?? -1;
    if (this._architectureStamp !== architectureStamp) {
      this._architectureStamp = architectureStamp;
      if (this.props.distribution === "scatter") this._layoutDirty = true;
    }
    if (force || this._checkSurface || this._time - (this._lastSurfaceCheck ?? -Infinity) > .15) {
      this._checkSurface = false;
      this._lastSurfaceCheck = this._time;
      const stamp = this._inspectSurface(source);
      if (stamp !== this._surfaceStamp || source !== this._surfaceRoot) this._layoutDirty = true;
      this._surfaceStamp = stamp;
      this._surfaceRoot = source;
    }
    // A newly painted layer joins the same moving gust field as older layers.
    // Engine elapsed time is already pause/time-scale aware and hitch clamped.
    // "Run In Editor" freezes the WIND by holding this clock: the sway is
    // f(windTime, …), so a held windTime is a static snapshot. Advance it only
    // when animating; seed it once if never set so the shader never sees NaN.
    const foliageAnimating = this.shouldAnimate;
    if (foliageAnimating || this._windTime == null) {
      this._windTime = Number.isFinite(engine.elapsedTime) ? engine.elapsedTime : this._time;
    }
    // Tell shadowFreeze the foliage is a STATIC caster while its wind clock is
    // held: the vertex shader displaces off a frozen time, so the shadow is
    // constant and the map can freeze at rest. `vfxSimulation` stays set (GI
    // keeps foliage out of the static BVH, physics skips it); only this extra
    // hint changes. Set every frame so LOD chunks streamed in later inherit it.
    for (const mesh of this.renderMeshes) { if (mesh?.userData) mesh.userData.vfxStatic = !foliageAnimating; }
    updateFoliageUniforms(this.uniforms, this.props, this._windTime, sceneWind(engine));
    // A drawn sward has no prototypes, chunks, impostors or instance buffers.
    // It is three instanced rings following the camera, so the mesh-building
    // half of the scatter pipeline is skipped rather than run and discarded.
    // The PLACEMENT half still runs (`_computeInstances`, not `_rebuildLayout`):
    // `setFieldFromPlacements` derives its field from `this.instances`, and an
    // architecture footprint excludes grass exactly as it excludes scattered
    // clumps — both need that filtered instance list kept current.
    if (this._grassDirty) { this._grassDirty = false; this._syncGrass(); }
    if (this.drawsGrass) {
      if (this._layoutDirty) {
        try { this._computeInstances(source); } catch (error) {
          this._stats.status = `Foliage: ${error?.message ?? String(error)}`;
        }
        this._layoutDirty = false;
      }
      if (this._grass && !this._grass.field && !this._packedField && this.instances.length) {
        this._grass.setFieldFromPlacements(this.instances, this._grassBounds());
      }
      this._grass?.update(this.entity.object3D, engine.camera, engine.sunDirection ?? null);
      const stats = this._grass?.stats;
      Object.assign(this._stats, { instances: stats?.blades ?? 0, chunks: this._grass?.rings.length ?? 0,
        drawCalls: stats?.draws ?? 0, triangles: stats?.triangles ?? 0, impostorReady: true, status: "Drawn" });
      return;
    }
    try {
      if (this._shapeDirty) this._rebuildShape();
      if (this._layoutDirty) this._rebuildLayout(source);
    } catch (error) {
      this._shapeDirty = this._layoutDirty = false;
      this._stats.status = `Foliage: ${error?.message ?? String(error)}`;
      return;
    }
    this._expandMotionBounds();
    const camera = engine.camera;
    if (camera) camera.getWorldPosition(cameraPosition); else cameraPosition.set(0, 0, 0);
    // The VIEWER's world position, this component's own copy — never TSL's
    // builtin `cameraPosition` (see the long comment on `foliageFadeNode` in
    // `foliageMaterial.js`), and never the module-level `cameraPosition`
    // scratch vector above directly: that one is a shared mutable scratch
    // reused by every foliage component's CPU-side LOD math this same frame,
    // while `mesh.userData.foliageViewerPosition` below is read back by the
    // GPU uniform possibly on a LATER frame than it was written (the node
    // system re-reads it lazily, per draw) — a shared scratch could then hand
    // the shader some OTHER component's most recent write instead of this
    // one's.
    this._viewerPosition.copy(cameraPosition);
    this._stats.colliders = updateFoliageInteractions(engine, this.uniforms, cameraPosition, this._time, this.props.interaction);
    this._requestAtlas();
    const atlas = this._atlasEntry?.atlas ?? null;
    // A NEW atlas (bake just resolved, or a rebuild started a fresh one)
    // starts the ramp's clock; releasing the atlas (rebuild in flight) resets
    // it so the NEXT bake's arrival gets its own fresh 0.8 s fade-in too.
    if (atlas !== this._impostorAtlasSeen) {
      this._impostorAtlasSeen = atlas;
      this._impostorRampStart = atlas ? this._time : null;
    }
    const impostorReady = !!atlas;
    // 0 while the bake is pending, ramping to 1 over 0.8 s once it resolves
    // (`foliageApplyImpostorRamp`'s live twin). While below 1, a chunk that
    // would otherwise classify purely to the impostor tier still needs the
    // mid mesh to hold its data too (`extendMidToImpostor` below) so the
    // shader's `1 - impostorWeight * ramp` mid leftover has something to draw.
    const impostorRamp = impostorReady ? Math.min(1, Math.max(0, (this._time - this._impostorRampStart) / .8)) : 0;
    this._impostorRamp = impostorRamp;
    const extendMidToImpostor = impostorRamp < 1;
    // A clipmap sun's mid-LOD shadow level needs mid geometry from the viewer on.
    const midFromViewer = (this.entity.engine?.clipmapShadowNodes?.size ?? 0) > 0;
    const slack = foliageTierSlack();
    const evaluateTiers = !this._tierMasksCurrent(cameraPosition, impostorReady, extendMidToImpostor, slack, force, midFromViewer);
    if (evaluateTiers) Object.assign(this._stats, { drawCalls: 0, triangles: 0, vertices: 0, nearChunks: 0, midChunks: 0, impostorChunks: 0, culledChunks: 0, impostorReady });
    for (const chunk of evaluateTiers ? this.chunks : NO_CHUNKS) {
      // Species-level thresholds only, times whatever the chunk's own detail
      // box already reports — no chunk-relative pixel rescale (deleted with
      // `foliageDetailDistances`) and no hysteresis: the shader's per-instance
      // crossfade (`foliageMaterial.js`, `impostorMaterial.js`) is what keeps
      // this from popping, not a sticky boundary. `chunk.level` stays the
      // single "best" tier for bookkeeping (stats, per-chunk template
      // visibility, impostor raycast dispatch) — `chunk.tierMask` is the
      // SUPERSET a straddling chunk actually needs: every tier whose band
      // overlaps the chunk's own distance RANGE, not just its nearest point
      // (`foliageChunkTierMask`), so the commit path (`foliageBatchOrder.js`)
      // can copy its instance data into both render meshes during a crossfade.
      const nearest = chunk.detailBounds.distanceToPoint(cameraPosition);
      const farthest = farthestDistanceToPoint(chunk.detailBounds, cameraPosition);
      let level = foliageLodLevel(nearest, this.props);
      if (level === 2 && !impostorReady) level = 1;
      // The mask has to bound every instance's own SCALE-NORMALIZED distance
      // (what the shader and `foliageTierWeights` actually compare to a
      // threshold), not the chunk box's raw one — a bigger-than-1 plant's
      // normalized distance shrinks below its raw distance, so the near edge
      // divides by the chunk's LARGEST instance scale (the most it could
      // shrink by); a smaller-than-1 plant's grows, so the far edge divides
      // by the SMALLEST (see `_measureChunkPlants`).
      const maskNear = Math.max(0, nearest - slack) / (chunk.maxInstanceScale || 1);
      const maskFar = (farthest + slack) / (chunk.minInstanceScale || 1);
      const mask = foliageChunkTierMask(maskNear, maskFar, this.props, extendMidToImpostor, midFromViewer);
      // A real membership change (not just this frame's camera jitter) is the
      // ONLY thing allowed to invalidate an already-committed resumable job —
      // see `_commitBatches`'s file-level comment for why that has to be a
      // frozen, versioned snapshot rather than a live per-frame read.
      // `chunk.level` is bookkeeping (stats, raycast dispatch) that no commit
      // reads; only a tier MEMBERSHIP change invalidates committed batches.
      if (chunk.tierMask !== mask) { this._batchDirty = true; this._batchVersion++; }
      chunk.level = level;
      chunk.tierMask = mask;
      this._stats[levelNames[chunk.level]]++;
      for (let i = 0; i < chunk.meshes.length; i++) chunk.meshes[i].visible = i === chunk.level;
      if (chunk.level < 3) {
        const geometry = chunk.meshes[chunk.level]?.geometry;
        this._stats.triangles += ((geometry?.index?.count ?? geometry?.attributes.position.count ?? 0) / 3) * chunk.instances.length;
        this._stats.vertices += (geometry?.attributes.position.count ?? 0) * chunk.instances.length;
      }
    }
    if (evaluateTiers) this._tierVersion = this._batchVersion;
    // Per-object state the shared tree/grass and impostor shaders read back
    // with `.onObjectUpdate` (never a material uniform — this material can be
    // shared by other components with different authored distances; see the
    // long comment in `foliageMaterial.js`). Cheap plain-object writes, no
    // GPU upload of their own. `foliageLodThresholds` — not a bare `+1` floor
    // — is what the chunk-mask math above already resolves props through, and
    // it additionally widens `lodFar`/`maxDistance` (`enforceLodGap`) so the
    // near/far and far/end crossfade bands never touch: the shader's
    // complementary discard rule (`foliageDitherThreshold`/`foliageDitherSurvivesFromThreshold`) is only exact when
    // one boundary's fade is saturated to exactly 0 or 1 while the other is
    // live, so the values fed to the shader must be the SAME enforced ones
    // `foliageChunkTierMask`/`foliageTierKeeps` already use, not a raw prop.
    const { near: lodNear, far: lodFar, end: lodEnd } = foliageLodThresholds(this.props);
    // The shadow pass's mid→impostor handoff (`props.shadowFar`, clamped by
    // `foliageShadowFar` to the span the impostor mesh can actually cover).
    // Always written — with the prop unset it equals `lodFar`, which makes the
    // shadow dither replay the colour dither exactly.
    // Until the impostor has fully arrived there is no tier to hand the shadow
    // to: an early handoff would fade the mid mesh's shadow out over nothing.
    const shadowLodFar = extendMidToImpostor ? lodFar : foliageShadowFar(this.props);
    // Clipmap shadows pick the LOD per LEVEL (`clipmapShadowCache.js`,
    // `foliageShadowTierRule`): near geometry in the finest level, mid in the
    // next, impostors in the outermost; the clipmap's own level blend is the
    // smooth transition between them. Each render mesh publishes its tier.
    for (let lod = 0; lod < this.renderMeshes.length; lod++) {
      const mesh = this.renderMeshes[lod];
      if (mesh) mesh.userData.foliageShadowTier = lod;
    }
    // Per-cascade shadow caster culling (`csmShadowNode.js`): where each tier's
    // shadow can be live in world metres, and the tallest caster it holds.
    const scaleBounds = this._instanceScaleBounds();
    const casterRanges = foliageShadowCasterRanges({ near: lodNear, far: lodFar, end: lodEnd, shadowFar: shadowLodFar },
      scaleBounds[0], scaleBounds[1], impostorRamp);
    const casterHeight = (this._prototypeSize || Number(this.props.height) || 1) * scaleBounds[1] + this._motionMargin();
    for (let lod = 0; lod < this.renderMeshes.length; lod++) {
      const mesh = this.renderMeshes[lod];
      if (!mesh?.userData) continue;
      mesh.userData.shadowCasterRange = casterRanges[Math.min(lod, 2)];
      mesh.userData.shadowCasterHeight = casterHeight;
    }
    for (const mesh of this.renderMeshes) {
      if (!mesh?.userData) continue;
      mesh.userData.foliageLodNear = lodNear;
      mesh.userData.foliageLodFar = lodFar;
      mesh.userData.foliageLodEnd = lodEnd;
      mesh.userData.foliageShadowLodFar = shadowLodFar;
      mesh.userData.foliageImpostorRamp = impostorRamp;
      // Shared by reference, not copied: every render mesh (near, mid AND the
      // impostor) reads this same Vector3, which `this._viewerPosition.copy(…)`
      // above mutates in place once a frame. See the LOD-shadow-fix comment
      // there for why this must be the viewer, never the pass camera.
      mesh.userData.foliageViewerPosition = this._viewerPosition;
    }
    this._updateBatchOrder(camera, foliageAnimating);
    if (this._batchDirty) this._commitBatches();
    this._stats.drawCalls = this.renderMeshes.reduce((sum, mesh) => sum + (mesh?.visible ? 1 : 0), 0);
    updateFoliageWarmup(this);
  }
}
