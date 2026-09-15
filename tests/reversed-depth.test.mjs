import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as THREE from "three/webgpu";
import * as TSL from "three/tsl";
import {
  RENDERER_REBUILD_KEYS,
  SCENE_SETTINGS_DEFAULTS,
  rendererConstructorOptions,
  rendererNeedsRebuild,
} from "../src/engine/sceneSettings.js";
import {
  frameBufferDepthTexture,
  installFrameBufferFloatDepth,
  installPolygonOffsetGuard,
  installReversedSkyDepthTest,
  isNdcDepthInside,
  ndcDepthRange,
  pipelinePolygonOffset,
} from "../src/engine/reversedDepth.js";
import { frustumFromNdcRect, idsInFrustum } from "../src/editor/boxSelect.js";
import { ViewFrustum } from "../src/engine/viewFrustum.js";
import { fogSurfaceTest } from "../src/modules/postprocessing/volumetricFog.js";
import { ensureGodraysShadowMap } from "../src/modules/postprocessing/godraysShadow.js";

/**
 * REVERSED DEPTH (`settings.renderer.reversedDepth`, opt-in).
 *
 * three r185 reverses clear/compare/projection itself; these gate the
 * hand-rolled depth consumers the engine had to fix on top. Every behaviour has
 * its negative control: the same assertion with the flag off (or the old
 * hard-coded convention) must come out the other way.
 *
 *   node --test tests/reversed-depth.test.mjs
 */

function camera({ reversed = false, ortho = false } = {}) {
  const cam = ortho
    ? new THREE.OrthographicCamera(-10, 10, 10, -10, 0.5, 2000)
    : new THREE.PerspectiveCamera(60, 1, 0.5, 2000);
  cam.coordinateSystem = THREE.WebGPUCoordinateSystem;
  cam._reversedDepth = reversed; // what Renderer._updateCamera does
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);
  return cam;
}

test("reversedDepth is a rebuild key, defaults off, and reaches the constructor", () => {
  assert.ok(RENDERER_REBUILD_KEYS.includes("reversedDepth"));
  assert.equal(SCENE_SETTINGS_DEFAULTS.renderer.reversedDepth, false);
  assert.equal(rendererNeedsRebuild({ reversedDepth: false }, { reversedDepth: true }), true);
  // Negative control: an unrelated key flip of the same shape is not a rebuild.
  assert.equal(rendererNeedsRebuild({ reversedDepth: true }, { reversedDepth: true }), false);
  assert.equal(rendererConstructorOptions({ renderer: {} }).reversedDepthBuffer, false, "default off");
  assert.equal(rendererConstructorOptions({ renderer: { reversedDepth: true } }).reversedDepthBuffer, true);
  assert.equal(rendererConstructorOptions({ renderer: { reversedDepth: "yes" } }).reversedDepthBuffer, false, "strictly true");
});

test("NDC near/far pair per convention", () => {
  assert.deepEqual(ndcDepthRange({ coordinateSystem: THREE.WebGLCoordinateSystem }), { near: -1, far: 1 });
  assert.deepEqual(ndcDepthRange(camera()), { near: 0, far: 1 });
  assert.deepEqual(ndcDepthRange(camera({ reversed: true })), { near: 1, far: 0 });
  // The pair is what the projection really produces.
  for (const reversed of [false, true]) {
    for (const ortho of [false, true]) {
      const cam = camera({ reversed, ortho });
      const { near, far } = ndcDepthRange(cam);
      const n = new THREE.Vector3(0, 0, -cam.near).project(cam).z;
      const f = new THREE.Vector3(0, 0, -cam.far).project(cam).z;
      assert.ok(Math.abs(n - near) < 1e-6, `near ${n} vs ${near} (reversed=${reversed} ortho=${ortho})`);
      assert.ok(Math.abs(f - far) < 1e-4, `far ${f} vs ${far} (reversed=${reversed} ortho=${ortho})`);
    }
  }
});

test("behind-camera test holds for both depth conventions", () => {
  for (const reversed of [false, true]) {
    const cam = camera({ reversed });
    const front = new THREE.Vector3(0, 0, -50).project(cam).z;
    const behind = new THREE.Vector3(0, 0, 50).project(cam).z;
    const beyondFar = new THREE.Vector3(0, 0, -5000).project(cam).z;
    assert.equal(isNdcDepthInside(front, cam), true, `front (reversed=${reversed})`);
    assert.equal(isNdcDepthInside(behind, cam), false, `behind (reversed=${reversed})`);
    assert.equal(isNdcDepthInside(beyondFar, cam), false, `beyond far (reversed=${reversed})`);
  }
  // WebGL NDC keeps its [-1, 1] range.
  assert.equal(isNdcDepthInside(-0.5, { coordinateSystem: THREE.WebGLCoordinateSystem }), true);
  assert.equal(isNdcDepthInside(-0.5, camera()), false, "negative z is in front of the WebGPU near plane");
});

test("box select catches an object in front of a reversed camera", () => {
  const rect = { minX: -0.5, maxX: 0.5, minY: -0.5, maxY: 0.5 };
  const candidates = [
    { id: "front", box: new THREE.Box3(new THREE.Vector3(-1, -1, -101), new THREE.Vector3(1, 1, -99)) },
    { id: "behind", box: new THREE.Box3(new THREE.Vector3(-1, -1, 99), new THREE.Vector3(1, 1, 101)) },
    { id: "aside", box: new THREE.Box3(new THREE.Vector3(200, -1, -101), new THREE.Vector3(202, 1, -99)) },
  ];
  for (const ortho of [false, true]) {
    const reversedCam = camera({ reversed: true, ortho });
    const ids = idsInFrustum(candidates, frustumFromNdcRect(rect, reversedCam));
    assert.deepEqual([...ids], ["front"], `reversed ortho=${ortho}`);
    const standard = idsInFrustum(candidates, frustumFromNdcRect(rect, camera({ ortho })));
    assert.deepEqual([...standard], ["front"], `standard ortho=${ortho}`);
  }
  // Negative control: the old hard-coded z = -1/1 unprojection on a reversed
  // perspective camera puts the "near" quad behind the camera and the "far" one
  // at the near plane, so the object in front is missed.
  const cam = camera({ reversed: true });
  const legacy = legacyFrustum(rect, cam);
  assert.equal(legacy.intersectsBox(candidates[0].box), false, "old unprojection misses it");
});

function legacyFrustum(rect, cam) {
  const near = [], far = [];
  for (const [x, y] of [[rect.minX, rect.minY], [rect.maxX, rect.minY], [rect.maxX, rect.maxY], [rect.minX, rect.maxY]]) {
    near.push(new THREE.Vector3(x, y, -1).unproject(cam));
    far.push(new THREE.Vector3(x, y, 1).unproject(cam));
  }
  const centre = new THREE.Vector3();
  for (const p of [...near, ...far]) centre.add(p);
  centre.multiplyScalar(1 / 8);
  const frustum = new THREE.Frustum();
  const faces = [[near[0], near[3], far[0]], [near[1], near[2], far[1]], [near[0], near[1], far[0]],
    [near[3], near[2], far[3]], [near[0], near[1], near[2]], [far[0], far[1], far[2]]];
  faces.forEach(([a, b, c], i) => {
    frustum.planes[i].setFromCoplanarPoints(a, b, c);
    if (frustum.planes[i].distanceToPoint(centre) < 0) frustum.planes[i].negate();
  });
  return frustum;
}

test("view frustum keeps near and far planes under a reversed camera", () => {
  const view = new ViewFrustum();
  const cam = camera({ reversed: true });
  view.refresh(cam);
  const at = (z) => view.testSphere(new THREE.Vector3(0, 0, z), 0.1);
  assert.equal(at(-100), true, "in front");
  assert.equal(at(100), false, "behind");
  assert.equal(at(-3000), false, "past far");
  // Negative control: without the convention three assumes WebGL, and the
  // reversed matrix yields a frustum with no real far plane — past-far passes.
  const legacy = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse),
  );
  assert.equal(legacy.intersectsSphere(new THREE.Sphere(new THREE.Vector3(0, 0, -3000), 0.1)), true);
});

test("polygon offset is negated in the pipeline only for a reversed backend", () => {
  assert.deepEqual(pipelinePolygonOffset({ polygonOffsetFactor: -1, polygonOffsetUnits: -2 }, true), { factor: 1, units: 2 });
  assert.deepEqual(pipelinePolygonOffset({ polygonOffsetFactor: -1, polygonOffsetUnits: -2 }, false), { factor: -1, units: -2 });

  class FakePipelineUtils {
    constructor(reversed) { this.backend = { parameters: { reversedDepthBuffer: reversed } }; this.seen = null; }
    createRenderPipeline(renderObject) {
      const m = renderObject.material;
      this.seen = { depthBias: m.polygonOffsetUnits, depthBiasSlopeScale: m.polygonOffsetFactor };
      return "pipeline";
    }
  }
  assert.equal(installPolygonOffsetGuard(new FakePipelineUtils(false)), true);
  assert.equal(installPolygonOffsetGuard(new FakePipelineUtils(false)), false, "idempotent");
  const material = { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 };

  const reversed = new FakePipelineUtils(true);
  assert.equal(reversed.createRenderPipeline({ material }), "pipeline");
  assert.deepEqual(reversed.seen, { depthBias: 4, depthBiasSlopeScale: 1 });
  assert.equal(material.polygonOffsetFactor, -1, "material restored");
  assert.equal(material.polygonOffsetUnits, -4, "material restored");

  // Negative controls: standard backend, and offset disabled on the material.
  const standard = new FakePipelineUtils(false);
  standard.createRenderPipeline({ material });
  assert.deepEqual(standard.seen, { depthBias: -4, depthBiasSlopeScale: -1 });
  reversed.createRenderPipeline({ material: { ...material, polygonOffset: false } });
  assert.deepEqual(reversed.seen, { depthBias: -4, depthBiasSlopeScale: -1 });

  // Restored even when three throws mid-build.
  class ThrowingPipelineUtils {
    constructor() { this.backend = { parameters: { reversedDepthBuffer: true } }; }
    createRenderPipeline(renderObject) {
      assert.equal(renderObject.material.polygonOffsetUnits, 4, "flipped while building");
      throw new Error("pipeline failed");
    }
  }
  const throwing = new ThrowingPipelineUtils();
  installPolygonOffsetGuard(throwing);
  assert.throws(() => throwing.createRenderPipeline({ material }), /pipeline failed/);
  assert.equal(material.polygonOffsetUnits, -4, "restored after a throw");
});

test("the real three pipeline builder reads the offset where the guard patches it", async () => {
  // Tripwire for a three upgrade: the guard swaps material values around
  // `createRenderPipeline`, which is only right while that method reads them.
  const source = await readFile(new URL("../node_modules/three/src/renderers/webgpu/utils/WebGPUPipelineUtils.js", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("createRenderPipeline( renderObject, promises ) {"));
  const end = body.indexOf("createRenderPipelineAsync");
  assert.ok(end > 0);
  assert.match(body.slice(0, end), /depthStencil\.depthBias = material\.polygonOffsetUnits;/);
  assert.match(body.slice(0, end), /depthStencil\.depthBiasSlopeScale = material\.polygonOffsetFactor;/);
});

test("framebuffer target gets float depth only under a reversed buffer", () => {
  const make = (reversed) => {
    const target = new THREE.RenderTarget(8, 8, { depthBuffer: true });
    const renderer = { reversedDepthBuffer: reversed, _getFrameBufferTarget: () => target };
    installFrameBufferFloatDepth(renderer);
    return renderer._getFrameBufferTarget();
  };
  const reversed = make(true);
  assert.equal(reversed.depthTexture?.type, THREE.FloatType);
  assert.equal(reversed.depthTexture.renderTarget, reversed);
  assert.equal(make(false).depthTexture, null, "negative control: three keeps its default");
  const stencil = frameBufferDepthTexture(new THREE.RenderTarget(4, 4, { depthBuffer: true, stencilBuffer: true }));
  assert.equal(stencil.format, THREE.DepthStencilFormat);
});

/** A depth texture the bare builder can size: without `renderTarget` three
 *  asks the (never-initialised) backend's renderer for the sample count. */
function depthTex() {
  const depth = new THREE.DepthTexture(4, 4);
  depth.renderTarget = { samples: 1 };
  return depth;
}

function buildFragment(reversed, colorNode) {
  const renderer = new THREE.WebGPURenderer({
    canvas: { width: 64, height: 64, style: {}, addEventListener() {}, setAttribute() {} },
    reversedDepthBuffer: reversed,
  });
  renderer.backend.device = { features: new Set() }; renderer.hasFeature = () => false;
  const geometry = new THREE.PlaneGeometry(), material = new THREE.MeshBasicNodeMaterial();
  material.colorNode = colorNode;
  try {
    const builder = renderer.backend.createNodeBuilder(new THREE.Mesh(geometry, material), renderer);
    builder.scene = new THREE.Scene(); builder.camera = new THREE.PerspectiveCamera();
    builder.build();
    return builder.fragmentShader;
  } finally {
    geometry.dispose(); material.dispose();
  }
}

const comparisons = (wgsl) => (wgsl.match(/[^\n;]*(?:>=|<=|>|<)\s*[-\d.e]+[^\n;]*/g) || []).join("\n");

test("addon sky test `rawDepth >= 1.0` flips to `<= 0.0` only when reversed", () => {
  installReversedSkyDepthTest();
  const depthTexture = depthTex();
  const colorTexture = new THREE.Texture();
  // The addons' exact shape: `this.depthNode.sample( uv ).r` → `.toVar()` → compare.
  const graph = () => TSL.Fn(() => {
    const depth = TSL.texture(depthTexture).sample(TSL.uv()).r.toVar();
    depth.greaterThanEqual(1.0).discard();
    const uvBound = TSL.uv().x.greaterThanEqual(1.0); // not a depth read
    const colourSample = TSL.texture(colorTexture).sample(TSL.uv()).r.toVar().greaterThanEqual(1.0); // not depth
    const half = depth.greaterThanEqual(0.5); // not the clear value
    return TSL.vec3(uvBound.select(1, 0), colourSample.select(1, 0), half.select(1, 0));
  })();

  const reversed = comparisons(buildFragment(true, graph()));
  const standard = comparisons(buildFragment(false, graph()));
  const count = (s, re) => (s.match(re) || []).length;
  assert.equal(count(reversed, /<=\s*0\.0/g), 1, `one sky test rewritten:\n${reversed}`);
  assert.equal(count(standard, /<=\s*0\.0/g), 0, `negative control untouched:\n${standard}`);
  assert.equal(count(standard, />=\s*1\.0/g), 3, `standard keeps depth, uv and colour tests:\n${standard}`);
  assert.equal(count(reversed, />=\s*1\.0/g), 2, `reversed keeps uv and colour tests:\n${reversed}`);
  assert.equal(count(reversed, />=\s*0\.5/g), 1, "a non-clear threshold is untouched");
});

test("three's addons still carry the sky test the rewrite targets", async () => {
  // If a three upgrade changes this shape, the rewrite silently stops matching.
  for (const [file, re] of [
    ["GTAONode.js", /this\.depthNode\.sample\( uv \)\.r;[\s\S]*depth\.greaterThanEqual\( 1\.0 \)\.discard\(\)/],
    ["SSRNode.js", /this\.depthNode\.sample\( uv \)\.r;[\s\S]*depth\.greaterThanEqual\( 1\.0 \)\.discard\(\)/],
    ["SSGINode.js", /this\.depthNode\.sample\( uv \)\.r;[\s\S]*depth\.greaterThanEqual\( 1\.0 \)\.discard\(\)/],
    ["DenoiseNode.js", /this\.depthNode\.sample\( uv \)\.x;[\s\S]*depth\.greaterThanEqual\( 1\.0 \)\.or\(/],
  ]) {
    const source = await readFile(new URL(`../node_modules/three/examples/jsm/tsl/display/${file}`, import.meta.url), "utf8");
    assert.match(source, re, file);
    assert.doesNotMatch(source, /reversedDepthBuffer/, `${file} became reversed-aware — drop it from the rewrite notes`);
  }
});

test("volumetric fog sky branch compares against the right clear value", () => {
  const depthTexture = depthTex();
  const graph = () => TSL.Fn((builder) => {
    const depth = TSL.texture(depthTexture).sample(TSL.uv()).r;
    return TSL.vec3(fogSurfaceTest(depth, builder?.renderer?.reversedDepthBuffer === true).select(1, 0));
  })();
  const reversed = comparisons(buildFragment(true, graph()));
  const standard = comparisons(buildFragment(false, graph()));
  assert.match(reversed, />\s*0\.0001/, reversed);
  assert.doesNotMatch(reversed, /<\s*0\.9999/, reversed);
  assert.match(standard, /<\s*0\.9999/, standard);
  assert.doesNotMatch(standard, />\s*0\.0001/, standard);
});

test("god-rays shadow map compare flips with the renderer and rebuilds on toggle", () => {
  const light = new THREE.DirectionalLight();
  light.castShadow = true;
  light.userData.giShadowMode = "gi";
  const engine = { renderer: { reversedDepthBuffer: false }, scene: new THREE.Scene() };
  assert.equal(typeof ensureGodraysShadowMap(engine, light, { size: 16 }), "function");
  assert.equal(light.shadow.map.depthTexture.compareFunction, THREE.LessCompare, "standard");
  const first = light.shadow.map;
  engine.renderer = { reversedDepthBuffer: true };
  ensureGodraysShadowMap(engine, light, { size: 16 });
  assert.notEqual(light.shadow.map, first, "a toggle re-creates the target");
  assert.equal(light.shadow.map.depthTexture.compareFunction, THREE.GreaterCompare, "reversed");
});
