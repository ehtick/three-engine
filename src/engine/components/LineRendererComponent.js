import * as THREE from "three/webgpu";
import { Component } from "./Component.js";
import { buildRibbon, smoothPolyline } from "../vfx/ribbon.js";
import { RibbonMesh, entitySubtreeVisible } from "../vfx/ribbonMesh.js";
import { createRibbonMaterial, applyRibbonWrap } from "../vfx/vfxMaterial.js";
import { loadTextureAsset } from "../textureAsset.js";

const _color = new THREE.Color();

/** `"#ff8800"` → linear rgba, the space the vertex colours are consumed in. */
function toLinearRgba(hex, alpha) {
  _color.set(hex ?? "#ffffff");
  return [_color.r, _color.g, _color.b, alpha ?? 1];
}

/**
 * A polyline with width — lasers, ropes, tether beams, aim indicators, the
 * lines between a tower and what it is targeting (roadmap item 13).
 *
 * The points are ordinary component data, so the same component covers both
 * uses: authored in the inspector for a static rope, or rewritten every frame
 * from a script for a beam that tracks a moving target:
 *
 *     const line = this.entity.getComponent("line");
 *     line.setPoints([this.muzzle.position, hit.point]);
 *
 * ## Local vs. world points
 *
 * `space: "local"` parents the strip to the entity, so the whole line moves and
 * rotates with it — what a rope on a moving ship wants. `space: "world"` puts
 * it at the scene root and treats the points as absolute, which is what a beam
 * between two *other* objects wants: with local points, aiming it means
 * inverse-transforming both endpoints through an entity whose transform is
 * irrelevant to the effect.
 */
export class LineRendererComponent extends Component {
  static type = "line";
  static label = "Line Renderer";
  static tags = ["vfx", "3d"];
  static defaults = {
    points: [
      [0, 0, 0],
      [0, 0, 1],
    ],
    space: "local",
    loop: false,
    smoothing: 0,
    startWidth: 0.1,
    endWidth: 0.1,
    startColor: "#ffffff",
    endColor: "#ffffff",
    startAlpha: 1,
    endAlpha: 1,
    texture: "",
    textureMode: "stretch",
    tiling: 1,
    alignment: "view",
    blending: "alpha",
  };
  static schema = [
    { key: "space", label: "Space", type: "select", options: ["local", "world"] },
    { key: "loop", label: "Loop", type: "boolean" },
    { key: "smoothing", label: "Smoothing", type: "number", min: 0, max: 12, step: 1 },
    { key: "startWidth", label: "Start Width", type: "number", min: 0, step: 0.01 },
    { key: "endWidth", label: "End Width", type: "number", min: 0, step: 0.01 },
    { key: "startColor", label: "Start Color", type: "color" },
    { key: "startAlpha", label: "Start Alpha", type: "number", min: 0, max: 1, step: 0.01 },
    { key: "endColor", label: "End Color", type: "color" },
    { key: "endAlpha", label: "End Alpha", type: "number", min: 0, max: 1, step: 0.01 },
    { key: "texture", label: "Texture", type: "asset", exts: ["png", "jpg", "jpeg", "webp"] },
    { key: "textureMode", label: "Texture Mode", type: "select", options: ["stretch", "tile"], showIf: (props) => !!props.texture },
    { key: "tiling", label: "Tiling", type: "number", min: 0.01, step: 0.1, showIf: (props) => !!props.texture },
    { key: "alignment", label: "Alignment", type: "select", options: ["view", "local"] },
    { key: "blending", label: "Blending", type: "select", options: ["alpha", "additive"] },
  ];

  onAttach() {
    this.generation = (this.generation ?? 0) + 1;
    this.loadedTexture = null;
    this.ribbon = new RibbonMesh(this.#buildMaterial(), { name: "__lineRenderer" });
    this.ribbon.mesh.userData.entityId = this.entity.id;
    // Never batched, never picked as scene geometry by the decal projector:
    // the strip is rebuilt from a spine and has no stable topology to merge.
    this.ribbon.mesh.userData.noBatch = true;
    this.ribbon.mesh.userData.noDecal = true;
    this.#attachMesh();
    if (this.props.texture) this.#loadTexture(this.props.texture);
    this.rebuild();
    this.ribbon.mesh.visible = this.enabled && this.ribbon.buffer.indexCount > 0;
  }

  onDetach() {
    this.generation = (this.generation ?? 0) + 1;
    this.unsubVisibility?.();
    this.unsubVisibility = null;
    this.ribbon?.dispose();
    this.ribbon = null;
    this.loadedTexture?.dispose();
    this.loadedTexture = null;
  }

  onDisable() {
    if (this.ribbon) this.ribbon.mesh.visible = false;
  }

  onEnable() {
    if (this.ribbon) this.ribbon.mesh.visible = this.ribbon.buffer.indexCount > 0;
  }

  #attachMesh() {
    this.unsubVisibility?.();
    this.unsubVisibility = null;
    const world = this.props.space === "world";
    const parent = world ? this.entity.engine?.scene : this.entity.object3D;
    // A world-space line's points are absolute, so its mesh must not inherit
    // the entity's transform — parenting it to the scene root is the whole
    // difference between the two modes.
    parent?.add(this.ribbon.mesh);
    this.ribbon.mesh.matrixAutoUpdate = !world;
    if (world) {
      this.ribbon.mesh.matrix.identity();
      this.ribbon.mesh.matrixWorld.identity();
      // Detached from the entity's transform means detached from its
      // visibility too, so that one bit has to be carried across by hand.
      this.unsubVisibility = this.entity.engine?.onPreRender(() => {
        if (!this.ribbon) return;
        this.ribbon.mesh.visible =
          this.enabled && this.ribbon.buffer.indexCount > 0 && entitySubtreeVisible(this.entity);
      });
    }
  }

  #buildMaterial() {
    return createRibbonMaterial({
      alignment: this.props.alignment,
      blending: this.props.blending,
      map: this.loadedTexture,
      // The ramp colours are baked per vertex (they vary along the line), so
      // the material tint stays white and is left free for runtime modulation.
      color: 0xffffff,
      opacity: 1,
      alignNormal: [0, 1, 0],
    });
  }

  async #loadTexture(path) {
    const generation = this.generation;
    try {
      const texture = await loadTextureAsset(path, { colorSpace: THREE.SRGBColorSpace });
      if (generation !== this.generation || !this.ribbon) {
        texture.dispose();
        return;
      }
      applyRibbonWrap(texture, this.props.textureMode);
      this.loadedTexture?.dispose();
      this.loadedTexture = texture;
      this.#swapMaterial();
    } catch (err) {
      console.warn(`Line renderer texture failed to load: ${path}`, err);
    }
  }

  #swapMaterial() {
    if (!this.ribbon) return;
    const old = this.ribbon.mesh.material;
    this.ribbon.setMaterial(this.#buildMaterial());
    old?.dispose?.();
  }

  // ---- geometry -------------------------------------------------------------

  /** Rebuilds the strip from the current points. Cheap — call it freely. */
  rebuild() {
    if (!this.ribbon) return;
    const source = this.#flatPoints();
    let points = source.points;
    let count = source.count;
    if (count >= 2 && this.props.smoothing > 0) {
      const smoothed = smoothPolyline(points, count, Math.floor(this.props.smoothing), !!this.props.loop);
      points = smoothed.points;
      count = smoothed.count;
    }
    buildRibbon(this.ribbon.buffer, points, count, {
      closed: !!this.props.loop,
      startWidth: this.props.startWidth,
      endWidth: this.props.endWidth,
      startColor: toLinearRgba(this.props.startColor, this.props.startAlpha),
      endColor: toLinearRgba(this.props.endColor, this.props.endAlpha),
      textureMode: this.props.textureMode,
      tiling: this.props.tiling,
    });
    this.ribbon.upload();
    if (!this.enabled) this.ribbon.mesh.visible = false;
  }

  /** Props hold `[[x,y,z], …]` (JSON-friendly); the builder wants one flat
   *  array, and reusing it across frames keeps a script-driven beam from
   *  allocating every frame. */
  #flatPoints() {
    const list = Array.isArray(this.props.points) ? this.props.points : [];
    const count = list.length;
    if (!this._flat || this._flat.length < count * 3) this._flat = new Float32Array(Math.max(8, count) * 3);
    for (let i = 0; i < count; i++) {
      const p = list[i];
      if (Array.isArray(p)) {
        this._flat[i * 3] = p[0] ?? 0;
        this._flat[i * 3 + 1] = p[1] ?? 0;
        this._flat[i * 3 + 2] = p[2] ?? 0;
      } else {
        this._flat[i * 3] = p?.x ?? 0;
        this._flat[i * 3 + 1] = p?.y ?? 0;
        this._flat[i * 3 + 2] = p?.z ?? 0;
      }
    }
    return { points: this._flat, count };
  }

  // ---- script API -----------------------------------------------------------

  get pointCount() {
    return this.props.points?.length ?? 0;
  }

  getPoint(index) {
    const p = this.props.points?.[index];
    return p ? new THREE.Vector3(p[0], p[1], p[2]) : null;
  }

  /** Replaces every point. Accepts Vector3s, `[x,y,z]` tuples, or `{x,y,z}`. */
  setPoints(points) {
    this.props.points = (points ?? []).map((p) =>
      Array.isArray(p) ? [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0] : [p?.x ?? 0, p?.y ?? 0, p?.z ?? 0],
    );
    this.rebuild();
    return this;
  }

  setPoint(index, point) {
    const list = this.props.points;
    if (!list?.[index]) return this;
    list[index] = Array.isArray(point)
      ? [point[0] ?? 0, point[1] ?? 0, point[2] ?? 0]
      : [point?.x ?? 0, point?.y ?? 0, point?.z ?? 0];
    this.rebuild();
    return this;
  }

  addPoint(point) {
    this.props.points = [...(this.props.points ?? [])];
    this.props.points.push(
      Array.isArray(point) ? [point[0] ?? 0, point[1] ?? 0, point[2] ?? 0] : [point?.x ?? 0, point?.y ?? 0, point?.z ?? 0],
    );
    this.rebuild();
    return this;
  }

  clearPoints() {
    this.props.points = [];
    this.rebuild();
    return this;
  }

  /**
   * Control points, drawn while selected.
   *
   * The strip itself is already on screen, so this marks the POINTS — where
   * they are, how many there are, and (for a smoothed line) how far the curve
   * has been pulled away from them. Without it, editing point 4 of 9 in the
   * inspector is guesswork.
   */
  onDrawGizmosSelected(gizmos) {
    const list = this.props.points;
    if (!Array.isArray(list) || !list.length) return;
    if (this.props.space !== "world") {
      this.entity.object3D.updateWorldMatrix(true, false);
      gizmos.transform(this.entity.object3D.matrixWorld);
    }
    gizmos.color("#ffd166");
    const scale = Math.max(0.02, (this.props.startWidth + this.props.endWidth) * 0.5);
    for (const point of list) gizmos.point(point, scale);
    gizmos.transform(null);
  }

  onPropChanged(key) {
    if (!this.ribbon) {
      super.onPropChanged(key);
      return;
    }
    if (key === "space") {
      this.ribbon.mesh.removeFromParent();
      this.#attachMesh();
      return;
    }
    if (key === "texture") {
      if (this.props.texture) {
        this.#loadTexture(this.props.texture);
      } else {
        this.loadedTexture?.dispose();
        this.loadedTexture = null;
        this.#swapMaterial();
      }
      return;
    }
    if (key === "alignment" || key === "blending") {
      this.#swapMaterial();
      return;
    }
    if (key === "textureMode") {
      applyRibbonWrap(this.loadedTexture, this.props.textureMode);
      this.rebuild();
      return;
    }
    this.rebuild();
  }
}
