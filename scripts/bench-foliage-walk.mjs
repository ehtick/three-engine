// Foliage CPU on a moving camera: how often chunk tier masks change, how many
// batch commits and instance-buffer uploads a walk causes, and update() ms.
// usage: node scripts/bench-foliage-walk.mjs [speed m/frame=0.1] [frames=900] [instances=10000]
import * as THREE from 'three/webgpu';
import Attributes from 'three/src/renderers/common/Attributes.js';
import { AttributeType } from 'three/src/renderers/common/Constants.js';
import { Entity } from '../src/engine/Entity.js';
import { EventEmitter } from '../src/engine/EventEmitter.js';
import { FoliageComponent } from '../src/modules/foliage/FoliageComponent.js';

const speed = Number(process.argv[2] ?? .1), frames = Number(process.argv[3] ?? 900), count = Number(process.argv[4] ?? 10000);
const engine = new EventEmitter();
Object.assign(engine, { scene: new THREE.Scene(), entities: new Map(), rootEntities: [], camera: new THREE.PerspectiveCamera(), playing: false, deltaTime: .016, viewOnlyComponents: new Set() });
engine.getEntity = id => engine.entities.get(id); engine.onPreRender = fn => engine.on('preRender', fn);
const entity = new Entity(engine, { id: 'plants' }); engine.entities.set(entity.id, entity); entity.setParent(null);
let seed = 7; const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const placements = [];
for (let i = 0; i < count; i++) placements.push({ id: `p${i}`, position: [(rand() - .5) * 600, 0, (rand() - .5) * 600], rotation: [0, rand() * 6, 0], scale: .8 + rand() * .4 });
const component = entity.addComponent(new FoliageComponent({ species: 'grass', drawnGrass: false, distribution: 'placements', placements,
  height: 1.8, width: 2.9, chunkSize: 12, lodNear: Number(process.env.NEAR ?? 30), lodFar: Number(process.env.FAR ?? 90), maxDistance: 220, runInEditor: true, castShadow: true }));
component._atlasEntry = { atlas: { center: new THREE.Vector3(0, .9, 0), radius: 1.7, dispose() {} }, material: new THREE.MeshStandardNodeMaterial(), refs: 1, cache: new Map(), key: 'bench', settled: true };
component._buildImpostors();
let commits = 0, uploads = 0, versions = 0;
const commit = component._commitBatches;
component._commitBatches = function () { commits++; return commit.call(this); };
const attributes = new Attributes({ createAttribute() {}, updateAttribute() { uploads++; } }, { createAttribute() {} });
const submit = () => component.renderMeshes.forEach(mesh => {
  if (!mesh) return;
  if (mesh.instanceMatrix) attributes.update(mesh.instanceMatrix, AttributeType.VERTEX);
  else for (const name of ['aCenter', 'aSize', 'aAxisX', 'aAxisY']) attributes.update(mesh.geometry.attributes[name], AttributeType.VERTEX);
});
engine.camera.position.set(-200, 2, 0); engine.camera.lookAt(0, 2, 0);
for (let i = 0; i < 120; i++) { component.update(); submit(); }
commits = uploads = 0;
let ms = 0, worst = 0, v0 = component._batchVersion;
for (let i = 0; i < frames; i++) {
  engine.camera.position.x += speed; engine.camera.updateMatrixWorld();
  const t = performance.now();
  component.update();
  const dt = performance.now() - t; ms += dt; worst = Math.max(worst, dt);
  submit();
}
versions = component._batchVersion - v0;
console.log(JSON.stringify({ speed, frames, instances: count, chunks: component.chunks.length,
  updateMs: +(ms / frames).toFixed(3), worstMs: +worst.toFixed(2), commitsPerFrame: +(commits / frames).toFixed(2),
  uploadsPerFrame: +(uploads / frames).toFixed(2), versionBumpsPerFrame: +(versions / frames).toFixed(2) }));
entity.removeComponent('foliage');
