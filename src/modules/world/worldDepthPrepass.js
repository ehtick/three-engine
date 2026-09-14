import * as THREE from 'three/webgpu';
import { Discard, Fn, If, vec4 } from 'three/tsl';

// Restricted to World's native opaque trees and the ordinary main raster pass.
// This shares source attributes, never a second renderer or override scene.
// Alternate render pipelines withdraw the borrowers before their next draw.
function contextEligible(engine) {
  return !engine.modules?.has?.('gi') && engine._registrant?.id !== 'gi' &&
    !engine.modules?.has?.('postprocessing') && engine._registrant?.id !== 'postprocessing' &&
    !engine.renderOverrides?.size &&
    !engine.scene?.overrideMaterial && !engine.renderer?.getMRT?.() && !engine.renderer?.clippingPlanes?.length;
}

function sourceEligible(layer, source, lod, retiredSource, retiredGeometry, retiredMaterial) {
  const material = source?.material, geometry = source?.geometry;
  return ['oak', 'birch', 'pine'].includes(layer.props.species) && lod < 2 && source?.isInstancedMesh &&
    source.parent === layer.root && layer.root?.parent && layer.renderMeshes[lod] === source &&
    geometry === layer.geometries?.[lod] && material === layer.material && source.userData.foliageOwned === true &&
    !retiredSource.has(source) && !retiredGeometry.has(geometry) && !retiredMaterial.has(material) &&
    geometry?.attributes?.treeLeafAxis && geometry.attributes.treeBranchAxis && geometry.attributes.color?.itemSize === 3 &&
    material?.isMeshStandardNodeMaterial && material.vertexColors === true && material.positionNode?.isNode && material.opacityNode?.isNode &&
    material.transparent === false && material.depthWrite === true && material.depthTest === true && material.depthFunc === THREE.LessEqualDepth &&
    material.side === THREE.DoubleSide && material.blending === THREE.NormalBlending && material.opacity === 1 &&
    Number.isFinite(material.alphaTest) && material.alphaTest > 0 && material.alphaTest < 1 &&
    !material.alphaHash && !material.alphaToCoverage && !material.polygonOffset && !material.stencilWrite &&
    !material.clippingPlanes?.length && !material.alphaMap && !material.map && !material.displacementMap &&
    !(material.transmission > 0) && !material.transmissionNode &&
    !material.alphaTestNode && !material.maskNode && !material.fragmentNode && !material.vertexNode && !material.geometryNode && !material.depthNode;
}

const depthSignature = material => [material.positionNode, material.opacityNode, material.alphaTest, material.side];
const sameSignature = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);

export function installWorldDepthPrepass(engine, populations) {
  const entries = [], materials = new Map(), bySource = new Map();
  const retiredSource = new WeakSet(), retiredGeometry = new WeakSet(), retiredMaterial = new WeakSet();
  let disposed = false, off, offModules;
  const withdraw = entry => {
    if (!entry.active) return;
    entry.active = false;
    for (const unsubscribe of entry.unsubscribe) unsubscribe();
    // Native Foliage removes its old draw objects before retiring geometry.
    // The source's removed event therefore withdraws our borrower immediately.
    entry.mesh.removeFromParent(); bySource.delete(entry.source);
    entries.splice(entries.indexOf(entry), 1);
    const record = entry.materialRecord;
    if (--record.refs === 0) { record.material.dispose(); if (materials.get(entry.original) === record) materials.delete(entry.original); }
  };
  const create = (layer, source, signature) => {
      const original = source.material;
      let record = materials.get(original);
      if (!record || !sameSignature(record.signature, signature)) {
        const material = original.clone(); material.alphaTest = original.alphaTest;
        material.name = 'World tree depth specimen';
        material.positionNode = original.positionNode;
        material.colorWrite = false; material.depthWrite = true; material.depthTest = true;
        material.fragmentNode = Fn(() => {
          if (original.opacityNode) If(original.opacityNode.lessThanEqual(original.alphaTest), () => { Discard(); });
          return vec4(0);
        })();
        material.userData = { ...original.userData, noWeather: true };
        record = { material, signature, refs: 0 }; materials.set(original, record);
      }
      const mesh = new THREE.InstancedMesh(source.geometry, record.material, 1);
      mesh.instanceMatrix = source.instanceMatrix;
      mesh.userData = { ...source.userData, worldDepthPrepass: true };
      mesh.name = `${source.name} depth specimen`; mesh.renderOrder = -100;
      mesh.castShadow = false; mesh.receiveShadow = false;
      mesh.matrixAutoUpdate = false; mesh.matrix.copy(source.matrix);
      const entry = { layer, source, mesh, geometry: source.geometry, original, signature, materialRecord: record, active: true, unsubscribe: [] };
      const listen = (object, type, callback) => { object.addEventListener(type, callback); entry.unsubscribe.push(() => object.removeEventListener(type, callback)); };
      listen(source, 'removed', () => withdraw(entry));
      listen(source, 'dispose', () => { retiredSource.add(source); withdraw(entry); });
      listen(source.geometry, 'dispose', () => { retiredGeometry.add(entry.geometry); withdraw(entry); });
      listen(original, 'dispose', () => { retiredMaterial.add(original); withdraw(entry); });
      record.refs++; source.parent.add(mesh); entries.push(entry); bySource.set(source, entry);
  };
  const sync = () => {
    if (disposed) return;
    const wanted = new Map();
    if (contextEligible(engine)) for (const layer of populations) for (const [lod, source] of (layer.renderMeshes ?? []).entries()) {
      if (sourceEligible(layer, source, lod, retiredSource, retiredGeometry, retiredMaterial)) wanted.set(source, { layer, signature: depthSignature(source.material) });
    }
    for (const entry of [...entries]) {
      const next = wanted.get(entry.source);
      if (!next || entry.geometry !== entry.source.geometry || entry.original !== entry.source.material || !sameSignature(entry.signature, next.signature)) withdraw(entry);
    }
    for (const [source, { layer, signature }] of wanted) if (!bySource.has(source)) create(layer, source, signature);
    for (const { source, mesh } of entries) {
      mesh.visible = source.visible; mesh.frustumCulled = source.frustumCulled;
      mesh.count = source.count; mesh.instanceMatrix = source.instanceMatrix;
      mesh.boundingBox = source.boundingBox; mesh.boundingSphere = source.boundingSphere;
      mesh.layers.mask = source.layers.mask;
      mesh.matrix.copy(source.matrix); mesh.matrixWorldNeedsUpdate = true;
    }
  };
  off = engine.onPreRender(sync); offModules = engine.on?.('modules-changed', sync); sync();
  return { entries, sync, dispose() {
    if (disposed) return;
    disposed = true; off?.(); offModules?.();
    for (const entry of [...entries]) withdraw(entry);
  } };
}
