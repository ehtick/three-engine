import * as THREE from 'three/webgpu';
import { worldStreamPalette, effectiveSwardSettings } from './worldPlanData.js';
import { Component } from '../../engine/components/Component.js';
import { normalizeWorldDocument, createWorldDocument, captureWorldTerrainEdits, clampWorldDocument } from '../../engine/world/worldDocument.js';
import { heightEditsToTerrainEdits, terrainEditsToHeightEdits } from '../../engine/world/featureEdits.js';
import { createShapeOverlay } from '../../engine/world/landscapeFields.js';
import { PROCEDURAL_TERRAIN_PARAMS } from '../../engine/terrain/proceduralTerrain.js';
import { prepareWorldPlanAsync } from './worldPlan.js';
import { loadWorldSurfaceMaps } from './worldSurfaceMaps.js';
import { loadMaterialAsset, getMaterialInstance, subscribeMaterial } from '../../engine/materialAsset.js';
import { installWorldDepthPrepass } from './worldDepthPrepass.js';
import { freeze } from '../../engine/freezeLedger.js';
import { frameSliceBudget } from '../../engine/frameSlice.js';
import { alignedChunkSize } from '../../engine/world/chunkGrid.js';
import { WorldStreamer } from './worldStreaming.js';
import { WorldStreamPhysics } from './worldStreamPhysics.js';
import { createLandscapeEcology } from '../../engine/world/landscapeEcology.js';
import { GrassWindow } from './worldGrassWindow.js';
import { createLandscapeSettlements, composeLandscape } from '../../engine/world/landscapeSettlements.js';
import { StreamBuildings, buildingVariant } from './worldStreamBuildings.js';
import { describeCottageStudy } from './worldCottage.js';

const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
/** The terrain feature's shape/grid keys are provider-owned (P1-T): they must
 *  always come from the plan, never survive as a captured "authored override"
 *  — see `_resolveTerrainProviderProps`, the fix for a scene saved before
 *  P1-T keeping its old baked `heights` / implicit `procedural:false` forever. */
const TERRAIN_PROVIDER_KEYS = Object.freeze(['procedural', 'proceduralSeed', 'proceduralExtent', 'proceduralOrigin', 'proceduralReserve', 'stoneLayer', 'size', 'resolution',
  ...PROCEDURAL_TERRAIN_PARAMS.map(param => param.key)]);
/** 09-14: a World's Terrain wears the World's Ground swatches; its colour props
 *  map onto them (`customColors` is always on under a World). */
const TERRAIN_COLOR_SWATCHES = Object.freeze({ customColors: null, grassColor: 'meadow', soilColor: 'soil', rockColor: 'rock' });
/** Chunk-safe base64 -> Float32Array, matching TerrainComponent's own
 *  `heights`/`heightEdits` encoding. Only needed here to read a LEGACY baked
 *  `heights` override during migration; nothing else in this file touches a
 *  terrain's raw height buffer. */
function decodeHeightGrid(text, length) {
  if (!text) return null;
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const values = new Float32Array(bytes.buffer);
  return values.length === length ? values : null;
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
/** Hand the frame back to the renderer between slices of generation work. */
const frame = () => new Promise(resolve => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
  else setTimeout(resolve, 0);
});
const providerType = kind => ({ terrain:'terrain', foliage:'foliage', atmosphere:'atmosphere' })[kind] ?? 'world-feature';
const titles = { terrain: 'Terrain', water: 'River and lakes', rocks: 'Cliffs and rocks', cottage: 'Cottage', atmosphere: 'Atmosphere' };
const nativeKeys = ['terrain','foliage','atmosphere','architecture'];

export class WorldComponent extends Component {
  static type = 'world';
  static label = 'World';
  static tags = ['world','terrain','foliage','architecture','water','atmosphere','3d'];
  static defaults = { document: null };
  /** Owns streamed-chunk colliders directly — PhysicsSystem adopts it as a rig (see worldStreamPhysics.js). */
  static physicsRig = true;
  static schema = [{ key:'document', label:'World document', type:'object' }];
  constructor(props = {}) {
    super({ ...props, document: normalizeWorldDocument(clampWorldDocument(props.document ?? createWorldDocument())) });
    this.status = 'Queued'; this.error = null; this.stats = {}; this.features = [];
    // Milliseconds of generation per frame — the FLOOR a fast, interactive
    // frame gets. `_generate` actually drives `prepareWorldPlanAsync` with
    // `frameSliceBudget(engine)`, which widens this while boot frames are
    // long because the GPU is compiling shaders (see `engine/frameSlice.js`);
    // this field stays as the documented minimum and a diagnostic default.
    this.sliceBudget = 6; this._stage = ''; this._timeline = [];
    // Wait for the control to settle before starting. Dragging a slider bumps
    // the revision on every tick; without this each tick would start, and then
    // abandon, a full generation.
    this.settleDelay = 90;
    this.ready = Promise.resolve(this); this._revision = 0; this._alive = false; this._applying = false;
    this._featureEntities = new Map(); this._unsubs = []; this._materialUnsubs = [];
  }
  onAttach() {
    if (this._alive) return;
    this._alive = true;
    const engine = this.entity.engine;
    this._unsubs = [engine.on('component-changed', event => this._captureProvider(event)),
      engine.on('authoring-committed', () => this.commitAuthoredChanges()),
      engine.onPreRender(() => { if (this._alive && this.enabled) { this.captureAuthoredChanges(); this._plan?.update(engine.elapsedTime ?? 0); this._streamer?.tick(engine.elapsedTime ?? 0); this._updateStreaming(); } })];
    engine.physics?.registerRig?.(this);
    this.regenerate();
  }
  /** What streaming has actually built right now (MCP `world.streamingStatus`). */
  streamingStatus() {
    const streaming = this._plan?.document?.settings?.streaming ?? this.props.document?.settings?.streaming ?? null;
    if (!this._streamer) return { enabled: !!streaming?.enabled, active: false, settings: streaming };
    return {
      enabled: true, active: true, settings: streaming,
      chunkSize: this._streamer.size, radius: this._streamer.radius, physicsRadius: this._streamer.physicsRadius,
      ...this._streamer.stats(),
      libraryReady: !!this._streamer.library,
      colliders: this._streamPhysics?.colliderCount ?? 0,
      colliderTiles: this._streamPhysics?.tiles.size ?? 0,
      physicsLive: !!this._streamPhysics?.physics?.world,
    };
  }
  /* ---- physics rig contract (streamed-chunk colliders) ---- */
  buildRig(physics) { this._streamPhysics?.build(physics); }
  clearRig() { this._streamPhysics?.clear(); }
  onDetach() {
    this.entity?.engine?.physics?.unregisterRig?.(this);
    this._alive = false; this._revision++;
    this._unsubs.forEach(off => off?.()); this._unsubs = [];
    this._materialUnsubs.forEach(off => off()); this._materialUnsubs = [];
    this._setGeneratedEnabled(false); this._releasePlan();
    this._announce('Inactive');
  }
  onDisable() { this._revision++; this._setGeneratedEnabled(false); this._announce('Inactive'); }
  onEnable() { if (this._alive) { this._setGeneratedEnabled(true); this.regenerate(); } }
  onPropChanged(key) { if (key === 'document' && !this._capturing && this.enabled) this.regenerate(); }
  setProp(key, value) { return super.setProp(key, key === 'document' ? normalizeWorldDocument(clampWorldDocument(value)) : value); }
  setBaseProp(key, value) { return super.setBaseProp(key, key === 'document' ? normalizeWorldDocument(clampWorldDocument(value)) : value); }
  get terrainEntity() { return this.getFeatureEntity('terrain'); }
  getFeatureEntity(key) { return this.entity?.children.find(child => child.getComponent('world-feature')?.props.key === key) ?? null; }
  getFeature(key) { return this.features.find(feature => feature.id === key) ?? null; }
  whenReady() { return this.ready; }
  _announce(status, error = null) {
    this.status = status; this.error = error;
    this.entity?.engine.emit('world-changed', { entityId: this.entity.id, status, error, stats: this.stats, stage: this._stage });
  }
  _setGeneratedEnabled(enabled) {
    if (this._streamer) this._streamer.group.visible = enabled;
    for (const child of this.entity?.children ?? []) if (child.getComponent('world-feature')) {
      for (const type of nativeKeys) child.getComponent(type)?.setEnabledOverride(enabled ? null : false);
      if (child._worldProduct) child._worldProduct.visible = enabled;
    }
  }
  /**
   * Chunk streaming (09-14): the World governs a `WorldStreamer` that draws the
   * landscape around its authored region. Created or replaced after a commit
   * whenever the landscape or the streaming settings change; kept otherwise, so
   * a look edit does not throw away every loaded chunk.
   */
  _syncStreaming() {
    const plan = this._plan, settings = plan?.document?.settings, streaming = settings?.streaming;
    const landscape = plan?.fields?.shape?.landscape;
    if (!streaming?.enabled || !landscape || !this.entity?.object3D) {
      this._streamer?.dispose(); this._streamer = null; this._streamerKey = null;
      return;
    }
    const size = alignedChunkSize(settings.extent, streaming.chunkSize);
    const ecologyOptions = { seed: settings.seed, forestDensity: settings.forestDensity, groundDensity: settings.groundDensity,
      vegetation: settings.vegetation, drawnGrass: settings.grass.enabled };
    const villages = streaming.villages ?? .5;
    // 09-14: streamed ground, its rocks and the grass window paint from the World's
    // Ground swatches and the sward's drawn colours — the same ones the region uses.
    const meadow = plan.document?.providerOverrides?.['foliage/meadow']?.props ?? null;
    const palette = worldStreamPalette(landscape.palette, settings);
    const key = JSON.stringify([landscape.options, size, streaming.radius, settings.extent, streaming.extent, ecologyOptions, settings.style, villages, settings.settlement]);
    const memoryBudget = (streaming.memory ?? 512) * 2 ** 20;
    if (this._streamer && this._streamerKey === key) {
      this._streamer.memoryBudget = memoryBudget;
      // A colour edit recolours what is loaded; it never rebuilds the streamer.
      if (this._streamer.setPalette(palette)) this._grassWindow?.setGround(palette.grass);
      // A commit can replace a population's Foliage component (a species
      // change): hand every loaded chunk's plants to the new one.
      this._refeedStreamedPlants();
      // The commit handed the meadow the region-only field; re-pack the window.
      this._grassWindow?.setRegion(plan.grassField, settings.extent / 2);
      return;
    }
    this._streamer?.dispose();
    this._streamedFeeds = new Map();
    this._streamPhysics ??= new WorldStreamPhysics({ entity: this.entity });
    this._streamPhysics.offset = this.entity.object3D.getWorldPosition(new THREE.Vector3()).toArray();
    const physics = this.entity.engine?.physics;
    if (physics?.world && !this._streamPhysics.physics) this._streamPhysics.build(physics);
    // Hamlets and villages in the streamed land: the valley's own planner on the
    // landscape, folded into the ground every streamed layer samples.
    const settlements = villages > 0 ? createLandscapeSettlements(landscape, { seed: settings.seed, density: villages, reserve: settings.extent,
      settlement: { roadWidth: settings.settlement.roadWidth, maxGrade: settings.settlement.maxGrade, buildingScale: settings.settlement.buildingScale,
        setback: settings.settlement.setback, plotFrontage: settings.settlement.plotFrontage, outbuildings: settings.settlement.outbuildings },
      footprint: variation => describeCottageStudy({ seed: buildingVariant(variation), style: settings.style }).footprint }) : null;
    const ground = composeLandscape(Object.freeze({ ...landscape, palette }), settlements);
    const ecology = createLandscapeEcology(ground, ecologyOptions);
    this._streamEcology = ecology;
    this._streamer = new WorldStreamer({ parent: this.entity.object3D, landscape: ground, chunkSize: size, radius: streaming.radius,
      settlements, buildings: settlements ? new StreamBuildings({ style: settings.style }) : null,
      exclude: settings.extent / 2, bounds: streaming.extent / 2, physics: this._streamPhysics, style: settings.style, memoryBudget,
      plants: { placeSteps: ecology.placeSteps, feed: (chunk, groups) => this._feedStreamedPlants(chunk, groups) } });
    this._streamer.group.visible = this.enabled;
    this._streamerKey = key;
    // The drawn sward follows the camera out of the region (one window field).
    const grass = settings.grass;
    this._grassWindow = grass.enabled && plan.grassField ? new GrassWindow({ fieldAt: ecology.fieldAt, region: plan.grassField, regionHalf: settings.extent / 2,
      span: Math.max(128, 2 ** Math.ceil(Math.log2((grass.distance ?? 60) * 2 + 48))), size: 257, grass: effectiveSwardSettings(grass, meadow), palette }) : null;
    this._grassClock ??= { deadline: 0, due() { return performance.now() >= this.deadline; } };
  }
  /** Re-centre the drawn sward's window field on the camera, a couple of ms a frame. */
  _updateGrassWindow(x, z) {
    const window = this._grassWindow;
    if (!window) return;
    this._grassClock.deadline = performance.now() + 2;
    const field = window.update(x, z, this._grassClock);
    if (field) this.getFeatureEntity('foliage/meadow')?.getComponent('foliage')?.setPackedField(field);
  }
  /** One streamed chunk's plants into the World's own foliage populations (local frame = World frame). */
  _feedStreamedPlants(chunk, groups) {
    const fed = this._streamedFeeds ??= new Map();
    const previous = fed.get(chunk)?.ids ?? new Set();
    const ids = new Set(groups ? groups.keys() : []);
    for (const id of new Set([...previous, ...ids])) {
      const foliage = this.getFeatureEntity(`foliage/${id}`)?.getComponent('foliage');
      foliage?.setStreamedPlacements?.(chunk, groups?.get(id) ?? null);
    }
    if (groups) fed.set(chunk, { ids, groups, components: this._populationComponents(ids) });
    else fed.delete(chunk);
  }
  _populationComponents(ids) {
    return new Map([...ids].map(id => [id, this.getFeatureEntity(`foliage/${id}`)?.getComponent('foliage') ?? null]));
  }
  _refeedStreamedPlants() {
    for (const [chunk, entry] of this._streamedFeeds ?? []) {
      for (const id of entry.ids) {
        const foliage = this.getFeatureEntity(`foliage/${id}`)?.getComponent('foliage') ?? null;
        if (foliage === entry.components.get(id)) continue;
        foliage?.setStreamedPlacements?.(chunk, entry.groups.get(id));
        entry.components.set(id, foliage);
      }
    }
  }
  /** Feed the streamer the camera, in the World's own frame, each frame. */
  _updateStreaming() {
    const streamer = this._streamer, camera = this.entity?.engine?.camera;
    if (!streamer || !camera?.getWorldPosition) return;
    // ⛔ 09-14 owner: "the whole world was building and streaming was building
    // all at once" — Play froze. Streaming builds only while the World is Ready:
    // a regeneration (and its commit, foliage bakes, shader wave) never shares a
    // frame with the chunk wave. Loaded chunks stay on screen meanwhile.
    if (this.status !== 'Ready') return;
    const point = this._streamPoint ??= new THREE.Vector3(), inverse = this._streamInverse ??= new THREE.Matrix4();
    const look = this._streamLook ??= new THREE.Vector3();
    camera.updateWorldMatrix?.(true, false);
    camera.getWorldPosition(point);
    this.entity.object3D.updateWorldMatrix(true, false);
    inverse.copy(this.entity.object3D.matrixWorld).invert();
    point.applyMatrix4(inverse);
    // "Load what we see": the view direction, in the World's frame, orders loading.
    let forward = null;
    if (camera.getWorldDirection) {
      camera.getWorldDirection(look).transformDirection(inverse);
      forward = [look.x, look.z];
    }
    streamer.update(point.x, point.z, { budgetMs: frameSliceBudget(this.entity.engine), forward });
    this._updateGrassWindow(point.x, point.z);
  }
  _releasePlan() {
    this._streamer?.dispose(); this._streamer = null; this._streamerKey = null; this._streamedFeeds = null; this._grassWindow = null;
    this._depthPrepass?.dispose(); this._depthPrepass = null;
    const terrain = this.terrainEntity?.getComponent('terrain');
    terrain?.clearProceduralMaterial(this);
    terrain?.clearShapeOverlay(this);
    for (const child of this.entity?.children ?? []) if (child._worldProduct) { child._worldProduct.removeFromParent(); delete child._worldProduct; }
    this._plan?.dispose(); this._plan = null;
    this._maps?.dispose(); this._maps = null;
    this._committedGrassField = null;
  }
  _writeCaptured(document) {
    if (same(document, this.props.document)) return;
    this._capturing = true;
    try { super.setProp('document', normalizeWorldDocument(document)); }
    finally { this._capturing = false; }
  }
  _captureProvider(event) {
    if (!this._alive || this._applying || this._capturing || !this._plan || !event) return;
    const child = this.entity.engine.getEntity(event.entityId), marker = child?.getComponent('world-feature');
    if (child?.parent !== this.entity || !marker || event.componentType === 'world-feature') return;
    const key = marker.props.key, component = child.getComponent(event.componentType);
    if (!component || !['terrain','foliage','atmosphere','architecture','mesh'].includes(event.componentType) || event.architectureGenerated) return;
    const document = structuredClone(this.props.document);
    if (key === 'terrain' && event.componentType === 'terrain' && ['size','resolution'].includes(event.key)) {
      // This first recipe owns a fixed metre grid. Independent Terrain keeps
      // its full grid controls; a World grid must also fit its ecology/water.
      this._applying = true;
      try { component.setBaseProp(event.key, this._plan.generated.find(feature => feature.id === key).props[event.key]); }
      finally { this._applying = false; }
      this.regenerate(); return;
    }
    if (key === 'terrain' && event.componentType === 'terrain' && event.key === 'heightEdits') {
      // The terrain is procedural now (P1-T): a sculpt stroke lands in its own
      // `heightEdits`, already a delta against its generated base — which,
      // via the shape overlay below, IS this plan's `baseHeights`. So this is
      // a pure reformat (dense base64 <-> World's sparse document record),
      // never a re-derivation against a base array.
      document.terrainEdits = heightEditsToTerrainEdits(component.props.heightEdits, this._plan.grid.resolution);
      this._writeCaptured(document);
      // A committed stroke invalidates seating and water depth once; live
      // dabs still follow Terrain's own immediate geometry path.
      this.regenerate(); return;
    }
    if (key === 'terrain' && event.componentType === 'terrain' && Object.prototype.hasOwnProperty.call(TERRAIN_COLOR_SWATCHES, event.key)) {
      // An edit on the Terrain inspector IS an edit of the World's swatch, so the
      // region, the streamed tiles and the grass window all repaint from it.
      const swatch = TERRAIN_COLOR_SWATCHES[event.key], value = component.getBaseProp(event.key);
      if (swatch && typeof value === 'string' && document.settings?.ground?.[swatch] !== value) {
        document.settings.ground = { ...document.settings.ground, [swatch]: value };
        this._writeCaptured(document);
        this.regenerate();
      }
      return;
    }
    if (key === 'terrain' && event.componentType === 'terrain' && (event.key === 'heights' || TERRAIN_PROVIDER_KEYS.includes(event.key))) {
      // Provider-owned (P1-T) — `procedural`/`proceduralSeed`/every Procedural
      // param always come from the plan, never an authored override (see
      // `_resolveTerrainProviderProps`); `heights` is meaningless on a
      // procedural terrain and, unlike every other key here, capturing it
      // would hard-fail `normalizeWorldDocument`'s own "use terrainEdits"
      // guard rather than just silently misbehave. Drop the write rather
      // than let either resurrect this bug for a different key.
      return;
    }
    const generated = this._plan.generated.find(feature => feature.id === key);
    const override = document.providerOverrides[key] ??= { type: marker.props.provider, props: {} };
    const destination = event.componentType === 'mesh' ? (override.mesh ??= {}) : (override.props ??= {});
    // ⛔ 09-14: a key the generator never supplied inherits the component's own
    // default. Comparing against `undefined` captured every default-valued write
    // as an authored override (7 populations' shadowFar:0), which then outranked
    // the ecology table once it began supplying the key.
    const supplied = generated && Object.prototype.hasOwnProperty.call(generated.props, event.key);
    const value = component.getBaseProp(event.key), inherited = event.componentType === 'mesh' ? undefined
      : supplied ? generated.props[event.key] : component.constructor.defaults?.[event.key];
    if (same(value, inherited)) delete destination[event.key]; else if (value !== undefined) destination[event.key] = structuredClone(value);
    this._writeCaptured(document);
    // The sward's colours also paint the ground under it (and past its draw
    // distance), so they repaint the World rather than wait for the next edit.
    const swardColour = key === 'foliage/meadow' && (event.key === 'leafColor' || event.key === 'dryColor');
    if (swardColour || this._committedRevision !== this._revision) this.regenerate();
  }
  captureAuthoredChanges() {
    if (!this._alive || this._applying || !this._plan || !this.enabled) return;
    let document;
    for (const [key] of this._featureEntities) {
      // Deleted generated features remain suppressed on regeneration. Restore
      // through native Undo keeps the feature key and clears this tombstone.
      const live = this.getFeatureEntity(key), editId = `deleted:${key}`;
      // While new settings load, the old picture is still visible. Only a
      // change from that picture is a new manual edit, never the old pose
      // itself (otherwise Undo of a World edit would immediately undo itself).
      if (this._committedRevision !== this._revision && same(live?.getTransform() ?? null, this._generationTransforms?.get(key) ?? null)) continue;
      const deleted = !live, had = this.props.document.edits.some(edit => edit.id === editId);
      if (deleted !== had) {
        if (key === 'cottage' || key.startsWith('house/')) this._layoutEditPending = true;
        document ??= structuredClone(this.props.document);
        document.edits = document.edits.filter(edit => edit.id !== editId);
        if (deleted) document.edits.push({ id: editId, kind:'suppress', target:key });
      }
      if (!live) continue;
      const current = live.getTransform(), generated = live.getComponent('world-feature').props.generatedTransform;
      const saved = (document ?? this.props.document).providerOverrides[key]?.transform;
      const wanted = same(current, generated) ? undefined : current;
      if (!same(saved, wanted)) {
        if (key === 'cottage' || key.startsWith('house/')) this._layoutEditPending = true;
        document ??= structuredClone(this.props.document);
        const override = document.providerOverrides[key] ??= { type: live.getComponent('world-feature').props.provider, props:{} };
        if (wanted) override.transform = wanted; else delete override.transform;
      }
    }
    if (document) this._writeCaptured(document);
  }
  commitAuthoredChanges() {
    if (!this._alive || this._applying || !this.enabled) return;
    this.captureAuthoredChanges();
    if (this._layoutEditPending) {
      this._layoutEditPending = false;
      if (this.props.document.settings.layout.mode === 'procedural') this.regenerate();
    }
  }
  toJSON() { this.captureAuthoredChanges(); return super.toJSON(); }
  regenerate() {
    const revision = ++this._revision;
    this._generationTransforms = new Map([...this._featureEntities.keys()].map(key => [key, this.getFeatureEntity(key)?.getTransform() ?? null]));
    this._announce('Queued');
    this.ready = this._generate(revision).catch(error => {
      if (this._alive && revision === this._revision) this._announce('Error', error.message ?? String(error));
      return this;
    });
    return this.ready;
  }
  async _generate(revision) {
    const engine = this.entity.engine;
    const generateStart = performance.now();
    this._timeline = [];
    await tick();
    const current = () => this._alive && this.enabled && revision === this._revision && this.entity.engine.getEntity(this.entity.id) === this.entity;
    if (!current()) return this;
    if (this.settleDelay > 0) {
      await new Promise(resolve => setTimeout(resolve, this.settleDelay));
      if (!current()) return this;
    }
    let document = normalizeWorldDocument(this.props.document);
    this._announce('Generating');
    let maps = null, plan = null;
    try {
      if (document.settings.surfaceMode === 'materials') maps = await loadWorldSurfaceMaps(document.resources.surfaceMaps);
      const roleMaterials = {};
      await Promise.all(Object.entries(document.resources.materials).map(async ([role,path]) => {
        if (!path) return;
        await loadMaterialAsset(path, { strict: true }); roleMaterials[role] = getMaterialInstance(path);
        if (!roleMaterials[role]) throw new Error(`World material ${role} could not be loaded: ${path}`);
      }));
      if (!current()) { maps?.dispose(); return this; }
      await tick();
      if (!current()) { maps?.dispose(); return this; }
      this.captureAuthoredChanges();
      document = normalizeWorldDocument(this.props.document);
      // Generation runs in short slices and is abandoned the moment a newer
      // revision arrives, so a live parameter edit never blocks a frame and
      // never publishes a world the author has already moved past.
      // The slice widens on a slow (GPU-compiling) frame and stays at the 6 ms
      // floor once frames are fast — see `frameSliceBudget`. A function, not a
      // number, because it must be re-read before every slice this call takes.
      plan = await prepareWorldPlanAsync(document, { detailMaps: maps, roleMaterials, reuse: this._plan },
        { budget: () => frameSliceBudget(engine), defer: frame, shouldCancel: () => !current(),
          onProgress: stage => { this._stage = stage; },
          onStage: entry => { this._timeline.push(entry); } });
      if (!plan) { maps?.dispose(); return this; }
      if (!current()) { plan.dispose(); maps?.dispose(); return this; }
      const commitStart = performance.now();
      this._commit(plan, maps);
      this._syncStreaming();
      const commitMs = performance.now() - commitStart;
      freeze.bootMark('world: commit', commitMs, `${this.stats.features ?? 0} feature(s)`);
      this._timeline.push({ stage: 'commit', ms: +commitMs.toFixed(1), slices: 1 });
      plan = null; maps = null;
      this._depthPrepass?.dispose();
      this._depthPrepass = installWorldDepthPrepass(this.entity.engine,
        [...this._featureEntities.values()].map(child => child?.getComponent('foliage')).filter(Boolean));
      this._materialUnsubs.forEach(off => off());
      this._materialUnsubs = Object.values(document.resources.materials).filter(Boolean).map(path => subscribeMaterial(path, () => this.regenerate()));
      await Promise.all([...this._featureEntities.values()].map(child => child?.getComponent('foliage')?._atlasEntry?.promise));
      // Foliage prototype/impostor marks land on the freeze ledger's boot
      // timeline asynchronously (the atlas bake resolves after `_commit`
      // returns), so they are only all present once the wait above settles —
      // gather them into `stats.timeline` here rather than inside `_commit`.
      this.stats.timeline = [...this._timeline, ...this._collectFreezeTimeline(generateStart)];
      if (current()) this._announce('Ready');
      return this;
    } catch (error) { plan?.dispose(); maps?.dispose(); throw error; }
  }
  /**
   * The foliage/terrain marks a native provider component logged to the boot
   * ledger while THIS generation's commit and atlas wait were running — the
   * prototype build and impostor bake are the component's own instrumentation
   * (`FoliageComponent#_rebuildShape`, `acquireAtlas`), not something
   * `WorldComponent` measures itself, so they are read back rather than
   * re-timed. Bounded to `[generateStart, now]` so a concurrent, unrelated
   * Terrain/Foliage elsewhere in the scene cannot bleed into this report.
   */
  _collectFreezeTimeline(generateStart) {
    const startRel = generateStart - freeze.boot.t0, endRel = performance.now() - freeze.boot.t0;
    return freeze.boot.stages
      .filter(stage => stage.at >= startRel - 1 && stage.at <= endRel + 1 &&
        (stage.name.startsWith('foliage:') || stage.name.startsWith('terrain:')))
      .map(stage => ({ stage: stage.name, ms: stage.ms, slices: 1, detail: stage.detail ?? null }));
  }
  _commit(plan, maps) {
    const engine = this.entity.engine;
    const previous = this._plan, previousMaps = this._maps;
    const previousChildren = [...this.entity.children], previousObjects = [...this.entity.object3D.children];
    const previousProducts = previousChildren.filter(child => child._worldProduct)
      .map(child => ({ product: child._worldProduct, parent: child.object3D }));
    const wanted = new Set(), nextEntities = new Map(), rollback = [], parked = [];
    const revision = this._revision;
    // Removed native entities remain intact until publication. Their exact
    // objects/resources are the rollback snapshot, including authored extras.
    const retireParked = report => {
      for (const child of parked) {
        for (const type of [...child.components.keys()]) {
          try { child.removeComponent(type); } catch (error) { report(error); }
        }
        delete child._worldProduct;
      }
    };
    this._applying = true;
    try {
      try {
      engine.batchHierarchy(() => {
        for (const feature of plan.features) {
          if (feature.kind === 'atmosphere' && plan.document.settings.sky === 'auto') {
            const own = this.getFeatureEntity('atmosphere');
            const other = [...engine.entities.values()].some(entity => entity !== own && entity.getComponent('atmosphere')?.enabled && entity._componentsActive !== false);
            if (other) continue;
          }
          wanted.add(feature.id);
          let child = this.getFeatureEntity(feature.id);
          if (!child) {
            const id = `${this.entity.id}/world/${feature.id}`;
            if (engine.getEntity(id)) throw new Error(`World feature identity already exists: ${id}`);
            child = engine.createEntity({ id, name: titles[feature.id] ?? feature.props.label ?? feature.id.replace('foliage/',''), parent:this.entity });
            const created = child; rollback.push(() => engine.destroyEntity(created));
            child.addComponent('world-feature', { key:feature.id, provider:feature.provider ?? providerType(feature.kind) });
          } else {
            const saved = { transform: child.getTransform(), marker: structuredClone(child.getComponent('world-feature').props),
              components: ['mesh', ...nativeKeys].map(type => child.getComponent(type)?.toJSON()).filter(Boolean), product: child._worldProduct };
            rollback.push(() => {
              for (const type of [...nativeKeys, 'mesh']) if (child.getComponent(type)) child.removeComponent(type);
              child.setTransform(saved.transform);
              Object.assign(child.getComponent('world-feature').props, saved.marker);
              for (const data of saved.components) child.addComponent(data.type, data.props);
              child._worldProduct = saved.product;
              if (feature.id === 'terrain' && previous) this._installTerrainSurface(child, previous);
            });
          }
          const inherited = plan.generated.find(item => item.id === feature.id) ?? feature;
          const generatedTransform = { position: inherited.position ?? [0,0,0], rotation: inherited.rotation ?? [0,0,0], scale: inherited.scale ?? [1,1,1] };
          const marker = child.getComponent('world-feature');
          marker.props.generatedTransform = structuredClone(generatedTransform);
          child.setTransform({ position:feature.position ?? [0,0,0], rotation:feature.rotation ?? [0,0,0], scale:feature.scale ?? [1,1,1] });
          const type = feature.provider ?? providerType(feature.kind);
          if (type !== 'world-feature') {
            // An editable building is an Architecture model plus a plain mesh to
            // adopt; the house metadata stays on the feature, off the component.
            if (type === 'architecture' && !child.getComponent('mesh')) child.addComponent('mesh', { collision:'none', castShadow:true, receiveShadow:true });
            const providerProps = type === 'architecture' ? { model:feature.props.model, collision:'concave' }
              : feature.id === 'terrain' ? this._resolveTerrainProviderProps(feature, plan)
              : feature.props;
            // Attributed per feature so the freeze ledger can name which
            // population/provider a live edit's block actually spent time in
            // — see docs/WORLD_PRODUCTION_PLAN.md §7.6, "THE FREEZE WAS
            // `_commit`, NOT THE PLAN". `type` (foliage/terrain/architecture/…)
            // plus `feature.id` (the population/feature key) is the same
            // vocabulary the plan's own `world: plan <stage>` marks use.
            const commitToken = freeze.begin(`world:commit/${type}${type === 'foliage' ? ` ${feature.id}` : ''}`);
            try {
            let component = child.getComponent(type);
            if (!component || component.missingType) { if (component) child.removeComponent(type); component = child.addComponent(type, providerProps); }
            else {
              const desired = { ...component.constructor.defaults, ...providerProps };
              const changes = Object.entries(desired).filter(([key,value]) => !same(component.getBaseProp(key), value));
              // ⛔ THIS USED TO REPLACE THE WHOLE FOLIAGE COMPONENT ON ANY CHANGE.
              // A native component already coalesces its dirty flags into one
              // rebuild per frame, so setting the changed props is strictly
              // cheaper — while remove/add discards the prototypes, the LOD
              // meshes and the baked impostor atlas and builds them again. With
              // eleven populations that was the freeze on every edit, and a leaf
              // colour was enough to trigger it. Only a species change actually
              // needs a new component, because it is a different prototype.
              if (type === 'foliage' && changes.some(([key]) => key === 'species')) {
                const props = { ...component.toJSON().props, ...desired };
                child.removeComponent(type); component = child.addComponent(type, props);
              } else for (const [key,value] of changes) component.setBaseProp(key, structuredClone(value));
            }
            // A drawn sward's ground is bulk data, not a prop: it is handed
            // over directly rather than serialized into the document.
            // ⛔ Only when the field actually changed — `plan.grassField` is a
            // freshly allocated object (a Worker transfer, or a fresh pack)
            // every single generation even when the ground is byte-identical,
            // and `GrassRenderer.setField` dirty-checks by REFERENCE
            // (`grassRenderer.js`'s `setField`), so calling this unconditionally
            // rebuilt all 3 ring materials (`material:nodeBuild Grass field ·
            // natural`) on every regenerate — including every settle-debounced
            // tick of a slider drag that never touched the ground at all. Gate
            // on the data stage's own reuse key so a look-only edit (a leaf
            // colour, a house move) never touches the grass field.
            if (type === 'foliage' && feature.id === 'foliage/meadow' && plan.grassField !== this._committedGrassField) {
              component.setPackedField(plan.grassField);
              this._committedGrassField = plan.grassField;
            }
            component.setEnabledOverride(null);
            } finally { freeze.end(commitToken); }
          }
          const mesh = child.getComponent('mesh'), meshProps = plan.document.providerOverrides[feature.id]?.mesh ?? {};
          if (mesh) {
            for (const [key,value] of Object.entries({ ...mesh.constructor.defaults, ...(type === 'architecture' ? { collision:'none' } : {}), ...meshProps })) {
              if (value !== undefined && !same(mesh.getBaseProp(key),value)) mesh.setBaseProp(key,structuredClone(value));
            }
          }
          if (feature.id === 'terrain') {
            freeze.run('terrain:apply', () => this._installTerrainSurface(child, plan));
          }
          const product = plan.products.get(feature.id);
          if (product) {
            freeze.run(`world:assemble ${feature.id}`, () => product.traverse(object => {
              object.userData.entityId = child.id; object.userData.noMerge = true; object.userData.noBatch = true;
              // A baked product (rocks, cottages) owns its geometry outright, so
              // this is the last chance to guarantee it can actually be culled
              // rather than trusting whatever the generator happened to leave
              // set. A merged draw with no bound is invisible only sometimes —
              // exactly a "flickers, then vanishes as the camera moves" report.
              if (object.isMesh && object.geometry) {
                if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
                if (!object.geometry.boundingSphere) object.geometry.computeBoundingSphere();
                object.frustumCulled = true;
              }
            }));
            child.object3D.add(product); child._worldProduct = product;
          } else if (child._worldProduct) {
            // A provider switch (baked cottage -> editable architecture) retires
            // the old product; previousProducts above already parked its removal.
            child._worldProduct.removeFromParent(); delete child._worldProduct;
          }
          nextEntities.set(feature.id, child);
        }
        // Withdraw generator-owned outputs only. Authored descendants survive
        // even when a recipe omits their old provider feature.
        for (const child of [...this.entity.children]) {
          const marker = child.getComponent('world-feature');
          if (!marker || wanted.has(marker.props.key)) continue;
          const authoredChildren = child.children.map(entity => ({ entity, transform: entity.getTransform() }));
          rollback.push(() => {
            engine.entities.set(child.id, child);
            child.setParent(this.entity);
            for (const { entity: authored, transform } of authoredChildren) {
              authored.setParent(child); authored.setTransform(transform);
            }
          });
          for (const { entity: authored } of authoredChildren) {
            authored.object3D.updateWorldMatrix(true, false);
            const pose = authored.object3D.matrixWorld.clone();
            this.entity.object3D.updateWorldMatrix(true, false);
            pose.premultiply(this.entity.object3D.matrixWorld.clone().invert());
            authored.setParent(this.entity);
            pose.decompose(authored.object3D.position, authored.object3D.quaternion, authored.object3D.scale);
          }
          // Only unlink during the fallible transaction. Native teardown is
          // retirement, after the new hierarchy has been accepted. Calling
          // destroyEntity here made a late listener failure irreversible.
          const childIndex = this.entity.children.indexOf(child);
          if (childIndex !== -1) this.entity.children.splice(childIndex, 1);
          child.object3D.removeFromParent(); child.parent = null;
          engine.entities.delete(child.id); parked.push(child);
        }
        // Track only actual outputs and deliberate deletion tombstones.
        // Turning buildings/sky off must not create a permanent user deletion.
        for (const edit of plan.document.edits) if (edit.id === `deleted:${edit.target}` && edit.kind === 'suppress' && !nextEntities.has(edit.target)) {
          nextEntities.set(edit.target, this._featureEntities.get(edit.target) ?? null);
        }
        for (const { product } of previousProducts) product.removeFromParent();
        this.entity.object3D.updateWorldMatrix(true,true);
        engine.emit('hierarchy-changed');
      });
      if (!this._alive || !this.enabled || engine.getEntity(this.entity.id) !== this.entity) {
        throw new Error('World became inactive during commit');
      }
      } catch (error) {
        const restoreErrors = [], attempt = fn => { try { fn(); } catch (failure) { restoreErrors.push(failure); } };
        for (const product of plan.products.values()) attempt(() => product.removeFromParent());
        if (this._alive && engine.getEntity(this.entity.id) === this.entity) {
          attempt(() => engine.batchHierarchy(() => {
            for (const undo of rollback.reverse()) attempt(undo);
            for (const { product, parent } of previousProducts) attempt(() => parent.add(product));
            // Reparenting appends children. Restore original scene and native
            // submission order while preserving independent observer additions.
            for (const [current, original] of [[this.entity.children, previousChildren], [this.entity.object3D.children, previousObjects]]) {
              const restored = original.filter(child => current.includes(child));
              current.splice(0, current.length, ...restored, ...current.filter(child => !restored.includes(child)));
            }
            if (!this.enabled) attempt(() => this._setGeneratedEnabled(false));
            this.entity.object3D.updateWorldMatrix(true, true);
            engine.emit('hierarchy-changed');
          }));
        } else {
          // A hierarchy observer may delete the World itself. Its normal
          // teardown handled live descendants; parked natives need release too.
          retireParked(failure => restoreErrors.push(failure));
        }
        const failure = error instanceof Error ? error : new Error(String(error));
        if (restoreErrors.length) failure.cause ??= new AggregateError(restoreErrors, 'World rollback failed');
        throw failure;
      }
      // batchHierarchy flushes observers when it returns. Publish only after
      // that fallible boundary so _generate may safely dispose a rejected plan.
      this._featureEntities = nextEntities; this._committedRevision = revision;
      this._plan = plan; this._maps = maps; this.features = plan.features;
      // Scrub any stale terrain override this commit found (see
      // _resolveTerrainProviderProps) now that its migrated values have
      // actually published, so the NEXT regeneration starts clean instead of
      // re-decoding the same legacy grid every time.
      this._migrateLegacyTerrainOverride();
      this.stats = { ...plan.ecology.counts, houses:plan.features.filter(feature => feature.kind === 'building').length,
        lakes:plan.fields.recipe.lakes.length, rivers:plan.fields.recipe.rivers.length,
        settlements:plan.layout?.settlements?.length ?? 0, lanes:plan.layout?.lanes.length ?? 1,
        extent:plan.grid.extent, resolution:plan.grid.resolution,
        places:(plan.layout?.settlements ?? []).map(place => ({ id:place.id, kind:place.kind, buildings:place.buildings.length })),
        siting:plan.layout?.siting ?? null, unconnectedHouses:plan.layout?.unconnected ?? [],
        features:wanted.size, generationMs:plan.generationMs, revision, orphanEdits:plan.orphanEdits.length };

      // Retirement cannot reject a published plan: _generate would otherwise
      // dispose resources that the live providers already borrow. Continue
      // releasing other owners and retain diagnostics for a failing disposer.
      const retirementErrors = [];
      retireParked(error => retirementErrors.push(error));
      for (const owner of [previous, previousMaps]) {
        try { owner?.dispose(); } catch (error) { retirementErrors.push(error); }
      }
      if (retirementErrors.length) {
        this.stats.retirementErrors = retirementErrors.map(error => error?.message ?? String(error));
        try { console.warn('World committed; previous resources failed to retire', new AggregateError(retirementErrors)); } catch {}
      }
    } finally { this._applying = false; }
  }
  /**
   * The terrain feature's props as `_commit` should actually apply them.
   * `procedural`/`proceduralSeed`/the 12 Procedural params/`size`/`resolution`
   * are provider-owned now (P1-T) — a scene saved before that change has no
   * `procedural` prop at all, so its terrain child loads with the CURRENT
   * default (`procedural:false`) plus its old baked `heights`. If that ever
   * also reads back as a captured `providerOverrides.terrain` override (an
   * old resave, or any other route into the document), the generic override
   * merge in `worldPlanSteps` would keep handing it straight back on every
   * regeneration — exactly the bug this closes. So these keys always come
   * from `plan.generated`'s terrain feature, never an override, full stop.
   *
   * A legacy baked `heights` override is not simply discarded: its
   * difference from THIS generation's own bare `plan.baseHeights` (the same
   * comparison `captureWorldTerrainEdits` already makes for a live sculpt) is
   * folded into `heightEdits`, so a real old sculpt survives the migration
   * instead of vanishing. Records the outcome in `_terrainOverrideMigration`
   * for `_migrateLegacyTerrainOverride` to scrub out of the document once
   * this commit actually publishes.
   */
  _resolveTerrainProviderProps(feature, plan) {
    const override = plan.document.providerOverrides.terrain?.props;
    const stale = !!override && (TERRAIN_PROVIDER_KEYS.some(key => key in override) || 'heights' in override);
    if (!stale) return feature.props;
    const generated = plan.generated.find(item => item.id === 'terrain').props;
    const forced = { ...feature.props };
    for (const key of TERRAIN_PROVIDER_KEYS) forced[key] = generated[key];
    let terrainEdits = null;
    if (typeof override.heights === 'string' && override.heights) {
      const resolution = plan.grid.resolution;
      const authored = decodeHeightGrid(override.heights, (resolution + 1) ** 2);
      terrainEdits = authored && captureWorldTerrainEdits(plan.baseHeights, authored, resolution);
      forced.heightEdits = terrainEdits ? terrainEditsToHeightEdits(terrainEdits, resolution) : generated.heightEdits;
    } else {
      forced.heightEdits = generated.heightEdits;
    }
    delete forced.heights;
    this._terrainOverrideMigration = { hadHeights: 'heights' in override, terrainEdits };
    return forced;
  }
  /** Runs once, right after a commit that resolved a stale terrain override
   *  (see `_resolveTerrainProviderProps`) actually publishes: scrubs the
   *  provider-owned keys and `heights` out of the document so the next
   *  regeneration starts clean, and promotes a migrated sculpt into the
   *  document's own `terrainEdits` so it is recorded exactly once, not
   *  re-derived from a 550 KB grid on every future commit. */
  _migrateLegacyTerrainOverride() {
    const migration = this._terrainOverrideMigration;
    this._terrainOverrideMigration = null;
    if (!migration) return;
    const document = structuredClone(this.props.document);
    const override = document.providerOverrides.terrain;
    if (override) {
      for (const key of TERRAIN_PROVIDER_KEYS) delete override.props[key];
      delete override.props.heights;
      if (!Object.keys(override.props).length && !override.mesh && !override.transform) delete document.providerOverrides.terrain;
    }
    if (migration.hadHeights) document.terrainEdits = migration.terrainEdits;
    this._writeCaptured(document);
  }
  _installTerrainSurface(child, plan) {
    const terrain = child.getComponent('terrain');
    terrain.geometry.setAttribute('color', new THREE.BufferAttribute(plan.colors,3));
    terrain.geometry.setAttribute('worldSurface', new THREE.BufferAttribute(plan.surface,4));
    terrain.setProceduralMaterial(this, plan.groundMaterial);
    // Lends the terrain component World's own banks/road corridors/building
    // pads/ridges/escarpments on top of whatever bare landform it grows from
    // its own Procedural props (P1-T). `plan.baseHeights` is this exact grid,
    // already sampled once for World's colour/ecology/grass pass, so the
    // component's own fill just copies it rather than walking a second time;
    // `plan.fieldKey` is the same invalidation signal every other stage-keyed
    // reuse in this file already keys on, so a look/scatter-only regeneration
    // (whose fields are numerically identical) does not repeat that copy.
    terrain.setShapeOverlay(this, createShapeOverlay(plan.fields, { key: plan.fieldKey, samples: plan.baseHeights }));
  }
}
