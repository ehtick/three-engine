import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { EventEmitter } from '../src/engine/EventEmitter.js';
import { Engine } from '../src/engine/Engine.js';
import { registerComponent } from '../src/engine/components/registry.js';
import { MeshComponent } from '../src/engine/components/MeshComponent.js';
import { registerModuleDefinition, enableEngineModule, disposeEngineModules } from '../src/engine/modules.js';
import { normalizeArchitectureModel } from '../src/modules/architecture/formModel.js';
import { buildArchitectureFormGeometry } from '../src/modules/architecture/formGeometry.js';
import { STYLE_IDS } from '../src/modules/architecture/styles/catalog.js';
import { cottageArchitectureModel } from '../src/modules/world/cottageArchitecture.js';
import { describeCottageStudy } from '../src/modules/world/worldCottage.js';
import { prepareWorldPlan } from '../src/modules/world/worldPlan.js';
import { createWorldDocument } from '../src/engine/world/worldDocument.js';
import { terrainModule } from '../src/modules/terrain/index.js';
import { foliageModule } from '../src/modules/foliage/index.js';
import { atmosphereModule } from '../src/modules/atmosphere/index.js';
import { architectureModule } from '../src/modules/architecture/index.js';
import { waterModule } from '../src/modules/water/index.js';
import { worldModule } from '../src/modules/world/index.js';
import { vmSingleton } from '../src/editor/singleton.js';
import { commandBus } from '../src/editor/commands/CommandBus.js';

const studySettings = { layout: { mode: 'study' }, sky: 'off', forestDensity: 0, groundDensity: 0, grass: { enabled: false }, surfaceMode: 'procedural' };
const mainVolume = model => model.forms.find(form => form.id === 'main');

test('the adapter is deterministic and every family passes normalization unchanged', () => {
  for (let seed = 0; seed < 16; seed++) for (const style of ['natural', 'stylized']) {
    const model = cottageArchitectureModel({ style, seed });
    assert.equal(JSON.stringify(model), JSON.stringify(cottageArchitectureModel({ style, seed })), `seed ${seed} ${style} is byte-identical`);
    assert.deepEqual(normalizeArchitectureModel(structuredClone(model)), model, `seed ${seed} ${style} is already normalized`);
    const built = buildArchitectureFormGeometry(model);
    assert.ok(built.stats.triangles > 30, `seed ${seed} builds actual geometry`);
    built.geometry.dispose();
  }
  assert.notEqual(JSON.stringify(cottageArchitectureModel({ seed: 1 })), JSON.stringify(cottageArchitectureModel({ seed: 2 })), 'seeds change the document');
  const scaled = cottageArchitectureModel({ seed: 4, buildingScale: 1.5 }), plain = cottageArchitectureModel({ seed: 4 });
  for (let i = 0; i < plain.forms.length; i++) for (let axis = 0; axis < 3; axis++) {
    assert.ok(Math.abs(scaled.forms[i].size[axis] - plain.forms[i].size[axis] * 1.5) < 2e-3, 'buildingScale multiplies the model, not the entity');
    assert.ok(Math.abs(scaled.forms[i].position[axis] - plain.forms[i].position[axis] * 1.5) < 2e-3);
  }
  assert.deepEqual(normalizeArchitectureModel(structuredClone(scaled)), scaled);
});

test('every generated cottage carries a valid, deterministic style id (P1-H)', () => {
  for (let seed = 0; seed < 16; seed++) {
    const natural = cottageArchitectureModel({ style: 'natural', seed });
    const stylized = cottageArchitectureModel({ style: 'stylized', seed });
    assert.ok(STYLE_IDS.includes(natural.style.id), `seed ${seed} natural id ${natural.style.id} is a known style`);
    assert.equal(stylized.style.id, 'tiny-glade', `seed ${seed} stylized always reads as tiny-glade`);
    assert.equal(natural.style.seed, (Number(seed) >>> 0) || 1);
    // Same seed/style always picks the same id and seed…
    assert.deepEqual(cottageArchitectureModel({ style: 'natural', seed }).style, natural.style, `seed ${seed} style is deterministic`);
  }
  // …and every emitted style survives normalization byte-identical (already
  // checked in bulk above, but pinned narrowly here against the style field).
  const model = cottageArchitectureModel({ style: 'natural', seed: 3 });
  assert.deepEqual(normalizeArchitectureModel(structuredClone(model)).style, model.style);
});

test('the door sits on the entry face and reaches the walkable base', () => {
  for (let seed = 0; seed < 16; seed++) {
    const model = cottageArchitectureModel({ seed }), spec = describeCottageStudy({ seed });
    const door = model.openings.find(opening => opening.kind === 'door');
    assert.ok(door, `seed ${seed} has a door`);
    assert.equal(door.formId, 'main'); assert.deepEqual(door.normal, [0, 0, 1]);
    assert.equal(door.position[0], Math.round(spec.entry.x * 1e4) / 1e4);
    assert.ok(Math.abs(door.position[2] - (mainVolume(model).position[2] + mainVolume(model).size[2] / 2)) < 1e-3, 'on the +Z facade');
    assert.ok(Math.abs(door.position[1] - door.height / 2) < 1e-3, `seed ${seed} door threshold touches the ground`);
    assert.ok(door.width >= 1 && door.width <= 1.3 && door.height >= 2.05 && door.height <= 2.4);
  }
});

test('seeded windows stay inside their wall and keep clear of the door', () => {
  for (let seed = 0; seed < 16; seed++) {
    const model = cottageArchitectureModel({ seed }), door = model.openings.find(opening => opening.kind === 'door');
    const windows = model.openings.filter(opening => opening.kind === 'window');
    assert.ok(windows.length >= 2, `seed ${seed} has windows`);
    for (const opening of windows) {
      const form = model.forms.find(entry => entry.id === opening.formId), [nx, , nz] = opening.normal;
      // On the wall plane, inside the facade with wall left around the frame.
      const across = nz ? Math.abs(opening.position[0] - form.position[0]) : Math.abs(opening.position[2] - form.position[2]);
      const length = nz ? form.size[0] : form.size[2];
      assert.ok(across + opening.width / 2 <= length / 2 - .3 + 1e-4, `seed ${seed} window framed by wall`);
      const onPlane = Math.abs(nx * (opening.position[0] - form.position[0]) + nz * (opening.position[2] - form.position[2]));
      assert.ok(Math.abs(onPlane - (nx ? form.size[0] : form.size[2]) / 2) < 1e-4, `seed ${seed} window on the facade`);
      assert.ok(opening.position[1] - opening.height / 2 >= .85, `seed ${seed} window has a sill`);
      assert.ok(opening.position[1] + opening.height / 2 <= form.size[1] - .25, `seed ${seed} window below the eave`);
      if (opening.formId === 'main' && nz === 1 && opening.position[1] < 2.4) {
        assert.ok(Math.abs(opening.position[0] - door.position[0]) >= (opening.width + door.width) / 2 + .3 - 1e-4, `seed ${seed} window clear of the door`);
      }
    }
    const twoStorey = describeCottageStudy({ seed }).volumes.some(volume => volume.storeys >= 2);
    if (twoStorey) assert.ok(windows.some(opening => opening.position[1] > 3.5), `seed ${seed} lights the upper floor`);
  }
});

test('roofColor and gable ends reach the built materials and the roof closes', () => {
  const model = cottageArchitectureModel({ seed: 0, roofColor: '#7a2f2a' });
  const built = buildArchitectureFormGeometry(model);
  // Every cottage now carries a style (P1-H): the box's own roof faces are
  // styled too (a procedural tile/slate/... texture tinted by the override,
  // rather than the style's own palette pick — `colorFor` keeps an authored
  // `roofColor` as the tint), and the decorators add their own separate
  // roof-role detail (ridge cap, tile courses) tinted from the style's
  // palette instead. Identify "every roof face" by the actual massing
  // surfaces (formId set) rather than the `styled` flag, which both share.
  // P1-H4: every styled "roof" face now shares ONE material (keyed on role
  // only, World production plan §3), so the override no longer shows up as
  // a distinct `descriptor.color` — it rides the per-vertex `styleTint`
  // attribute instead, which is what this now reads.
  const styleTint = built.geometry.attributes.styleTint, builtIndex = built.geometry.index;
  const massingRoofTints = new Set();
  for (const surface of built.surfaces) {
    if (surface.kind !== 'roof' || surface.formId == null) continue;
    for (let i = surface.start; i < surface.start + surface.count; i++) {
      const vertex = builtIndex.getX(i);
      massingRoofTints.add(`${styleTint.getX(vertex).toFixed(4)},${styleTint.getY(vertex).toFixed(4)},${styleTint.getZ(vertex).toFixed(4)}`);
    }
  }
  // The kit-built roof slab is the pickable roof now; its vertices carry the override times a
  // per-piece shade, so every roof tint must be the override's colour at some brightness.
  const expected = new THREE.Color('#7a2f2a');
  assert.ok(massingRoofTints.size > 0, 'the styled roof is pickable as the form roof');
  for (const tint of massingRoofTints) {
    const [r, g, b] = tint.split(',').map(Number), k = r / expected.r;
    assert.ok(k > .3 && k < 1.3 && Math.abs(g - expected.g * k) < 2e-3 && Math.abs(b - expected.b * k) < 2e-3, `the override repaints every roof face (${tint})`);
  }
  built.geometry.dispose();

  // The base-massing structural invariants below (gable-end colour, a closed
  // roof, the exact ridge apex height) are style-independent, but the
  // style's own ridge cap sits physically proud of the bare ridge and every
  // catalogue style used here enables one — build without style to check
  // the underlying massing on its own.
  const bare = buildArchitectureFormGeometry({ ...model, style: undefined });
  const wallSurfaces = bare.surfaces.filter(surface => surface.kind === 'wall' && !surface.interior && Math.abs(surface.normal[1]) < 1e-6);
  const spec = describeCottageStudy({ seed: 0 }), main = mainVolume(model), eave = main.size[1];
  const gableEnds = wallSurfaces.filter(surface => {
    const index = bare.geometry.index, position = bare.geometry.attributes.position;
    for (let i = surface.start; i < surface.start + surface.count; i++) if (position.getY(index.getX(i)) > eave + .05) return true;
    return false;
  });
  assert.ok(gableEnds.length >= 2, 'vertical gable ends rise above the eave as wall');
  const plaster = new THREE.Color(spec.palette.plaster).getHexString();
  const bareRoles = Object.fromEntries(bare.materials.map((descriptor, index) => [index, descriptor]));
  for (const surface of gableEnds) {
    const group = bare.geometry.groups.find(entry => surface.start >= entry.start && surface.start < entry.start + entry.count);
    assert.equal(bareRoles[group.materialIndex].color, `#${plaster}`, 'gable ends take the wall colour');
  }
  // No degenerate triangles anywhere, and the ridge stands at ridge height.
  const index = bare.geometry.index, position = bare.geometry.attributes.position, a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < index.count; i += 3) {
    a.fromBufferAttribute(position, index.getX(i)); b.fromBufferAttribute(position, index.getX(i + 1)); c.fromBufferAttribute(position, index.getX(i + 2));
    assert.ok(b.sub(a).cross(c.sub(a)).length() > 1e-8, `triangle ${i / 3} has area`);
  }
  const mesh = new THREE.Mesh(bare.geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  mesh.updateMatrixWorld();
  const hits = (origin, direction, far = Infinity) => new THREE.Raycaster(new THREE.Vector3(...origin), new THREE.Vector3(...direction), 0, far).intersectObject(mesh, false);
  const ridge = hits([main.position[0], 20, main.position[2]], [0, -1, 0]);
  assert.ok(Math.abs(ridge[0].point.y - (main.size[1] + main.roofHeight)) < 1e-3, 'ridge apex at ridge height');
  bare.geometry.dispose();
});

test('window apertures cut both skins of a gable cottage wall', () => {
  const model = cottageArchitectureModel({ seed: 0 });
  const opening = model.openings.find(entry => entry.kind === 'window' && entry.normal[2] === 1 && entry.formId === 'main');
  // The bare massing: a styled build fills the aperture with a closed window unit (liner
  // boards + an opaque pane), so the cut itself is asserted on the unstyled model.
  const built = buildArchitectureFormGeometry({ ...model, style: undefined });
  const mesh = new THREE.Mesh(built.geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  mesh.updateMatrixWorld();
  const through = new THREE.Raycaster(new THREE.Vector3(opening.position[0], opening.position[1], opening.position[2] + 2), new THREE.Vector3(0, 0, -1), 0, 3);
  assert.equal(through.intersectObject(mesh, false).length, 0, 'the window is a real hole through both skins');
  const beside = new THREE.Raycaster(new THREE.Vector3(opening.position[0] + opening.width, opening.position[1], opening.position[2] + 2), new THREE.Vector3(0, 0, -1), 0, 3);
  assert.ok(beside.intersectObject(mesh, false).length >= 2, 'the wall beside the window keeps both skins');
  built.geometry.dispose();
});

test('a provider-override model survives regeneration; a roof-colour override repaints the generated one', () => {
  const document = createWorldDocument(studySettings);
  const plan = prepareWorldPlan(document);
  const cottage = plan.features.find(feature => feature.id === 'cottage');
  assert.equal(cottage.provider, 'architecture');
  assert.equal(plan.products.get('cottage'), undefined, 'no baked product for an editable building');
  assert.deepEqual(cottage.props.model, cottageArchitectureModel({ style: 'natural', seed: cottage.props.variation, roofColor: cottage.props.roofColor, buildingScale: 1 }));
  plan.dispose();
  const edited = structuredClone(cottage.props.model);
  edited.forms[0].color = '#101010';
  const withModel = createWorldDocument(studySettings);
  withModel.providerOverrides.cottage = { type: 'architecture', props: { model: edited } };
  const kept = prepareWorldPlan(withModel).features.find(feature => feature.id === 'cottage');
  assert.deepEqual(kept.props.model, edited, 'the user model wins over regeneration');
  const withColor = createWorldDocument(studySettings);
  withColor.providerOverrides.cottage = { type: 'architecture', props: { roofColor: '#123456' } };
  const repainted = prepareWorldPlan(withColor).features.find(feature => feature.id === 'cottage');
  assert.notDeepEqual(repainted.props.model, edited);
  assert.ok(repainted.props.model.forms.every(form => form.roofColor === '#123456'), 'a roof-colour override rebuilds the generated model');
  const legacy = prepareWorldPlan(createWorldDocument({ ...studySettings, settlement: { editableBuildings: false } }));
  assert.ok(legacy.products.get('cottage')?.children.length > 0, 'the legacy path still bakes the study cottage');
  assert.equal(legacy.features.find(feature => feature.id === 'cottage').provider, undefined);
  legacy.dispose();
});

// The live commit path: real modules, real component attach, captured overrides.
registerComponent(MeshComponent);
for (const definition of [terrainModule, foliageModule, atmosphereModule, architectureModule, waterModule, worldModule]) {
  registerModuleDefinition(definition);
}
async function fixture(t) {
  const engine = new EventEmitter();
  Object.assign(engine, {
    scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(), entities: new Map(), rootEntities: [], modules: new Map(),
    viewOnlyComponents: new Set(), playing: false, deltaTime: 1 / 60, elapsedTime: 0, settings: {}, sceneName: 'World architecture fixture',
    createEntity: Engine.prototype.createEntity, destroyEntity: Engine.prototype.destroyEntity,
    getEntity(id) { return this.entities.get(id); }, batchHierarchy(fn) { return fn(); },
    onPreRender(fn) { return this.on('preRender', fn); },
  });
  engine.camera.position.set(0, 10, 30);
  vmSingleton('engineInstance', () => ({ instance: null, loader: null })).instance = engine;
  commandBus.clearHistory();
  await enableEngineModule(engine, 'world');
  t.after(async () => {
    for (const root of [...engine.rootEntities]) engine.destroyEntity(root);
    await disposeEngineModules(engine);
    commandBus.clearHistory();
  });
  const root = engine.createEntity({ name: 'Valley' });
  const world = root.addComponent('world', { document: createWorldDocument(studySettings) });
  await world.whenReady();
  assert.equal(world.status, 'Ready', world.error ?? 'world did not generate');
  return { engine, root, world };
}

test('editable buildings commit as real architecture components and capture model edits', async t => {
  const { world } = await fixture(t);
  const house = world.getFeatureEntity('cottage');
  assert.ok(house, 'the study cottage exists');
  assert.equal(house.getComponent('world-feature').props.provider, 'architecture');
  assert.equal(house._worldProduct, undefined, 'no baked product is attached');
  const architecture = house.getComponent('architecture');
  assert.ok(architecture?.props.model, 'an architecture component owns the generated model');
  assert.equal(architecture.props.collision, 'concave');
  const meshComponent = house.getComponent('mesh');
  assert.ok(meshComponent, 'the model adopted a plain mesh component');
  assert.equal(meshComponent.props.collision, 'none');
  assert.ok(architecture.mesh?.geometry.index.count > 0, 'the model built actual geometry');
  assert.deepEqual(architecture.props.model, world.getFeature('cottage').props.model);
  // A user edit (sculpt tool, MCP, inspector) is captured as a provider override…
  const edited = structuredClone(architecture.props.model);
  edited.forms[0].roofColor = '#0a0b0c';
  architecture.setProp('model', edited);
  assert.deepEqual(world.props.document.providerOverrides.cottage?.props?.model, edited);
  // …and survives a full regeneration against a newly computed default model.
  world.regenerate(); await world.whenReady();
  assert.equal(world.status, 'Ready');
  assert.deepEqual(world.getFeatureEntity('cottage').getComponent('architecture').props.model, edited);
  assert.deepEqual(world.getFeature('cottage').props.model, edited);
});
