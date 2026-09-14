import { Matrix4, Object3D, ShadowBaseNode, Vector3 } from "three/webgpu";
import {
  Fn, If, float, lightShadowMatrix, max, min, reference, renderGroup,
  shadowPositionWorld, smoothstep, vec4,
} from "three/tsl";
import { ClipmapShadowCache, createClipmapLevelShadowNode } from "./clipmapShadowCache.js";

const worldUp = new Vector3(0, 1, 0);
const DEPTH_GUARD = 0.0001;
const DEPTH_BLEND = 0.01;

function smoothEdge(a, b, value) {
  const t = Math.max(0, Math.min(1, (value - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** CPU counterpart for coverage receipts; coordinates are shadow.matrix * world. */
export function clipmapCoverage(uv, mapSize, blendWidth = 0.08, guardTexels = 4) {
  const edge = Math.min(uv.x, uv.y, 1 - uv.x, 1 - uv.y);
  const guard = guardTexels / Math.max(1, Math.min(mapSize.x, mapSize.y));
  return smoothEdge(guard, guard + blendWidth, edge)
    * smoothEdge(DEPTH_GUARD, DEPTH_GUARD + DEPTH_BLEND, Math.min(uv.z, 1 - uv.z));
}

/**
 * Fixed nested light-space maps. Camera rotation and projection never affect
 * coverage, texel density or cascade selection. Each native shadow node keeps
 * Three's caster alpha tests, skinning, deformation and shadow filters.
 */
export class ClipmapShadowNode extends ShadowBaseNode {
  constructor(light, data = {}) {
    super(light);
    this.isClipmapShadowNode = true;
    this.levels = Math.min(4, Math.max(1, Math.round(data.levels ?? 3)));
    this.cascades = this.levels;
    this.nearSize = Math.max(0.01, Number(data.nearSize ?? 20));
    this.scale = Math.max(2, Number(data.scale ?? 4));
    this.lightMargin = Math.max(0, Number(data.lightMargin ?? 200));
    this.blendWidth = Math.min(0.25, Math.max(0.001, Number(data.blendWidth ?? 0.08)));
    this.guardTexels = Math.max(1, Number(data.guardTexels ?? 4));
    this.beforePrepare = data.beforePrepare ?? null;
    this._createLevelShadowNode = data.createLevelShadowNode ?? null;
    this.camera = null;
    this.renderer = null;
    this.lights = [];
    this._shadowNodes = [];
    this._initialized = false;
    this._cacheEnabled = data.cache !== false;
    this.cache = new ClipmapShadowCache();
    this._lightWorld = new Vector3();
    this._targetWorld = new Vector3();
    this._directionWorld = new Vector3();
    this._viewer = new Vector3();
    this._center = new Vector3();
    this._point = new Vector3();
    this._orientation = new Matrix4();
    this._worldToLight = new Matrix4();
    this._worldToParent = new Matrix4();

    for (let i = 0; i < this.levels; i++) {
      const levelLight = new Object3D();
      levelLight.name = `Shadow clipmap ${i + 1}`;
      levelLight.castShadow = true;
      levelLight.target = new Object3D();
      levelLight.shadow = light.shadow.clone();
      // LightShadow.copy omits the per-light filter callback in this Three.
      levelLight.shadow.filterNode = light.shadow.filterNode;
      this.lights.push(levelLight);
      this._shadowNodes.push(this.createLevelShadowNode(levelLight, levelLight.shadow, i));
    }
    this.updateFrustums();
  }

  createLevelShadowNode(light, lightShadow, level) {
    return this._createLevelShadowNode?.(light, lightShadow, level, this)
      ?? createClipmapLevelShadowNode(light, lightShadow, level, { cache: this.cache, enabled: this.cacheEnabled, levels: this.levels });
  }

  get cacheEnabled() {
    return this._cacheEnabled;
  }

  set cacheEnabled(value) {
    const enabled = value !== false;
    if (enabled === this._cacheEnabled) return;
    this._cacheEnabled = enabled;
    for (const node of this._shadowNodes) node.cacheEnabled = enabled;
    this.invalidateCache();
  }

  invalidateCache() {
    this.cache.invalidate();
    for (const node of this._shadowNodes) node.invalidateCache?.();
  }

  _init({ camera, renderer }) {
    this.renderer = renderer;
    this._initialized = true;
    for (const light of this.lights) {
      light.shadow.camera.coordinateSystem = renderer.coordinateSystem;
      light.shadow.camera.updateProjectionMatrix();
    }
    this.prepare(this.camera ?? camera);
  }

  updateFrustums() {
    for (let i = 0; i < this.levels; i++) {
      const camera = this.lights[i].shadow.camera;
      const half = this.nearSize * this.scale ** i * 0.5;
      if (camera.left === -half && camera.right === half && camera.top === half && camera.bottom === -half) continue;
      camera.left = camera.bottom = -half;
      camera.right = camera.top = half;
      camera.updateProjectionMatrix();
    }
  }

  prepare(camera) {
    if (!camera || !this.light.parent) return;
    this.camera = camera;
    this.updateFrustums();
    const parent = this.light.parent;
    camera.updateWorldMatrix(true, false);
    this.light.updateWorldMatrix(true, false);
    this.light.target.updateWorldMatrix(true, false);
    this._lightWorld.setFromMatrixPosition(this.light.matrixWorld);
    this._targetWorld.setFromMatrixPosition(this.light.target.matrixWorld);
    this._directionWorld.subVectors(this._targetWorld, this._lightWorld).normalize();
    this._orientation.lookAt(this._lightWorld, this._targetWorld, worldUp);
    this._worldToLight.copy(this._orientation).invert();
    this._worldToParent.copy(parent.matrixWorld).invert();
    this._viewer.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(this._worldToLight);

    for (const light of this.lights) {
      const lightShadow = light.shadow;
      const shadowCamera = lightShadow.camera;
      const width = shadowCamera.right - shadowCamera.left;
      const stepX = width / Math.max(1, lightShadow.mapSize.width);
      const stepY = width / Math.max(1, lightShadow.mapSize.height);
      // All depth origins share a fixed world cell, independent of view depth
      // and map resolution. Snapping affects the covered slab, never the light.
      const stepZ = Math.max(this.nearSize / 8, 0.01);
      this._center.set(
        Math.round(this._viewer.x / stepX) * stepX,
        Math.round(this._viewer.y / stepY) * stepY,
        Math.round(this._viewer.z / stepZ) * stepZ + (shadowCamera.near + shadowCamera.far) * 0.5,
      ).applyMatrix4(this._orientation);
      if (light.parent !== parent) parent.add(light);
      if (light.target.parent !== parent) parent.add(light.target);
      light.position.copy(this._center).applyMatrix4(this._worldToParent);
      light.target.position.copy(this._center).add(this._directionWorld).applyMatrix4(this._worldToParent);
      light.updateWorldMatrix(false, false);
      light.target.updateWorldMatrix(false, false);
    }
    this.beforePrepare?.(camera, this);
  }

  updateBefore() {
    this.prepare(this.camera);
  }

  setup(builder) {
    if (!this._initialized) this._init(builder);
    return Fn(() => {
      this.setupShadowPosition(builder);
      const result = vec4(0).toVar("clipmapShadow");
      const remaining = float(1).toVar("clipmapRemaining");
      for (let i = 0; i < this.levels; i++) {
        // Once a finer level covers the point fully, neither the sample nor
        // the coarser matrix transforms and coverage tests can affect output.
        If(remaining.greaterThan(0), () => {
          const light = this.lights[i];
          const mapSize = reference("mapSize", "vec2", light.shadow).setGroup(renderGroup);
          const coordinate = lightShadowMatrix(light).mul(vec4(shadowPositionWorld, 1)).xyz.toVar();
          const edge = min(min(coordinate.x, coordinate.y), min(coordinate.x.oneMinus(), coordinate.y.oneMinus()));
          const guard = float(this.guardTexels).div(max(min(mapSize.x, mapSize.y), 1));
          const planarWeight = smoothstep(guard, guard.add(this.blendWidth), edge);
          const depthWeight = smoothstep(DEPTH_GUARD, DEPTH_GUARD + DEPTH_BLEND, min(coordinate.z, coordinate.z.oneMinus()));
          const coverage = planarWeight.mul(depthWeight).toVar();
          If(coverage.greaterThan(0), () => {
            result.addAssign(this._shadowNodes[i].mul(remaining.mul(coverage)));
            remaining.mulAssign(coverage.oneMinus());
          });
        });
      }
      return result.add(vec4(remaining));
    })();
  }

  /** Coverage weights of the actual rendered maps, useful to inspect a seam. */
  getLevelWeights(worldPosition, target = []) {
    target.length = this.levels + 1;
    let remaining = 1;
    for (let i = 0; i < this.levels; i++) {
      const lightShadow = this.lights[i].shadow;
      this._point.copy(worldPosition).applyMatrix4(lightShadow.matrix);
      const coverage = clipmapCoverage(this._point, lightShadow.mapSize, this.blendWidth, this.guardTexels);
      target[i] = remaining * coverage;
      remaining *= 1 - coverage;
    }
    target[this.levels] = remaining;
    return target;
  }

  dispose() {
    for (let i = 0; i < this.lights.length; i++) {
      this._shadowNodes[i].dispose?.();
      this.lights[i].removeFromParent();
      this.lights[i].target.removeFromParent();
    }
    this.beforePrepare = null;
    this.cache.dispose();
    super.dispose();
  }
}
