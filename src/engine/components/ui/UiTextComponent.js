import * as THREE from "three/webgpu";
import { Component } from "../Component.js";
import {
  createUiTextMaterial,
  createUiSdfTextMaterial,
  applyElementUniforms,
} from "../../ui/uiMaterial.js";
import { UI_LAYER } from "../../ui/UiSystem.js";
import { drawTextToCanvas } from "../../ui/uiText.js";
import { getSdfFont, layoutGlyphs, outlineToField } from "../../ui/sdfFont.js";

let sharedPlane = null;
function getPlane() {
  if (!sharedPlane) sharedPlane = new THREE.PlaneGeometry(1, 1);
  return sharedPlane;
}

/**
 * UI text, in two flavours.
 *
 * **SDF (default)** builds one quad per glyph against a shared signed-distance
 * atlas, so the same text is sharp at 8px, at 800px, and while a tween scales
 * it — and, critically, when it is a world-space label you walk toward. It also
 * gets outlines effectively for free, which is what makes a HUD readable over
 * arbitrary scenery.
 *
 * **Raster** keeps the old canvas-2D path: text drawn into a texture at the
 * element's physical pixel size. It stays because an SDF is a coverage mask —
 * it cannot represent colour emoji, and it will not reproduce a script face's
 * hinting at small sizes. Those are real cases, not indecision, so the choice
 * is a prop rather than a silent policy.
 */
export class UiTextComponent extends Component {
  static type = "uitext";
  static label = "UI Text";
  static defaults = {
    text: "Text",
    fontSize: 16,
    color: "#ffffff",
    fontFamily: "system-ui, sans-serif",
    fontWeight: "400",
    align: "center", // left | center | right
    valign: "middle", // top | middle | bottom
    wrap: true,
    lineHeight: 1.25,
    opacity: 1,
    // Rendering path. Off = canvas raster (colour emoji, exotic scripts).
    sdf: true,
    outlineWidth: 0, // UI px
    outlineColor: "#000000",
    weightBias: 0, // -0.2 … 0.2, thinner … fatter
  };
  static schema = [
    { key: "text", label: "Text", type: "text" },
    { key: "fontSize", label: "Font Size", type: "number", min: 1, step: 1 },
    { key: "color", label: "Color", type: "color" },
    { key: "fontFamily", label: "Font", type: "text" },
    { key: "fontWeight", label: "Weight", type: "select", options: ["300", "400", "500", "600", "700", "800"] },
    { key: "align", label: "Align", type: "select", options: ["left", "center", "right"] },
    { key: "valign", label: "V-Align", type: "select", options: ["top", "middle", "bottom"] },
    { key: "wrap", label: "Wrap", type: "boolean" },
    { key: "lineHeight", label: "Line Height", type: "number", min: 0.5, max: 3, step: 0.05 },
    { key: "opacity", label: "Opacity", type: "number", min: 0, max: 1, step: 0.05 },
    { key: "sdf", label: "Sharp (SDF)", type: "boolean" },
    { key: "outlineWidth", label: "Outline", type: "number", min: 0, max: 8, step: 0.5 },
    { key: "outlineColor", label: "Outline Color", type: "color" },
    { key: "weightBias", label: "Weight Bias", type: "number", min: -0.2, max: 0.2, step: 0.01 },
  ];

  onAttach() {
    if (typeof document === "undefined") return; // headless (tests)
    this.mode = null; // "sdf" | "raster" — built lazily on the first layout
    this.drawKey = null;
    this.mesh = null;
    this.geometry = null;
    this.canvas = null;
    this.canvasTexture = null;
  }

  onDetach() {
    this.#teardown();
  }

  #teardown() {
    if (this.mesh) {
      this.entity?.object3D.remove(this.mesh);
      this.mesh.material.dispose();
      this.mesh = null;
    }
    this.geometry?.dispose();
    this.geometry = null;
    this.canvasTexture?.dispose();
    this.canvasTexture = null;
    this.canvas = null;
    this.mode = null;
    this.drawKey = null;
  }

  onPropChanged(key) {
    // Switching path or font means a different material and a different mesh
    // shape; everything else is re-laid-out on the next frame.
    if (key === "sdf" || key === "fontFamily" || key === "fontWeight") this.#teardown();
    this.drawKey = null;
  }

  #buildRaster() {
    this.canvas = document.createElement("canvas");
    this.canvasTexture = new THREE.CanvasTexture(this.canvas);
    this.canvasTexture.colorSpace = THREE.SRGBColorSpace;
    this.canvasTexture.anisotropy = 1;
    this.mesh = new THREE.Mesh(getPlane(), createUiTextMaterial(this.canvasTexture));
    this.mode = "raster";
    this.#adopt();
  }

  #buildSdf() {
    this.font = getSdfFont(this.props.fontFamily, this.props.fontWeight);
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(0), 3));
    this.geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(0), 2));
    this.mesh = new THREE.Mesh(this.geometry, createUiSdfTextMaterial(this.font.texture));
    this.mode = "sdf";
    this.#adopt();
  }

  #adopt() {
    this.mesh.layers.set(UI_LAYER);
    this.mesh.frustumCulled = false;
    this.mesh.userData.entityId = this.entity.id;
    this.mesh.raycast = () => {};
    this.entity.object3D.add(this.mesh);
  }

  /**
   * Rebuilds the glyph geometry. Positions are in UI px relative to the
   * element's pivot, with y negated — the UI lays out y-down while the scene
   * graph is y-up, and doing the flip here (rather than by scaling the mesh
   * by -1) keeps the winding, and therefore backface culling, intact.
   */
  #buildGlyphs(w, h, spec) {
    const { quads } = layoutGlyphs(this.font, w, h, this.props);
    const count = quads.length;
    const positions = new Float32Array(count * 4 * 3);
    const uvs = new Float32Array(count * 4 * 2);
    const indices = new Uint32Array(count * 6);
    const ox = spec.pivot[0] * w;
    const oy = spec.pivot[1] * h;

    for (let i = 0; i < count; i++) {
      const q = quads[i];
      const x0 = q.x - ox;
      const x1 = q.x + q.w - ox;
      const y0 = -(q.y - oy); // top edge
      const y1 = -(q.y + q.h - oy); // bottom edge
      const p = i * 12;
      positions.set([x0, y0, 0, x1, y0, 0, x1, y1, 0, x0, y1, 0], p);
      // The atlas is a DataTexture (no flipY), so row 0 is v = 0 and the
      // glyph's top row is v0.
      uvs.set([q.u0, q.v0, q.u1, q.v0, q.u1, q.v1, q.u0, q.v1], i * 8);
      const v = i * 4;
      indices.set([v, v + 2, v + 1, v, v + 3, v + 2], i * 6);
    }
    this.geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    this.geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    this.geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    this.geometry.setDrawRange(0, count * 6);
    // Recomputed rather than left stale: the editor's Focus Selected framing
    // (and any Box3.setFromObject) reads these, and a bounding box left over
    // from the previous string frames the camera on the wrong thing.
    this.geometry.computeBoundingBox();
    this.geometry.computeBoundingSphere();
  }

  onUiLayout({
    rect, clipRect, alpha, k, order, spec, unit = 1, depthTest = false,
    screenSpace = false, uiWidth = 1, uiHeight = 1,
  }) {
    if (typeof document === "undefined") return;
    const wantSdf = this.props.sdf !== false;
    if (!this.mesh || this.mode !== (wantSdf ? "sdf" : "raster")) {
      this.#teardown();
      if (wantSdf) this.#buildSdf();
      else this.#buildRaster();
    }
    const mesh = this.mesh;
    if (!mesh) return;
    const { w, h } = rect;
    const p = this.props;
    mesh.renderOrder = order + 1; // above a sibling image on the same entity

    if (this.mode === "sdf") {
      // Geometry is authored in UI px; `unit` converts to world units for a
      // world-space screen and is 1 for an overlay.
      mesh.scale.set(unit, unit, 1);
      mesh.position.set(0, 0, 0.001 * unit);
      const key = [
        Math.round(w * 100), Math.round(h * 100), p.text, p.fontSize, p.align, p.valign,
        p.wrap, p.lineHeight, spec.pivot[0], spec.pivot[1],
      ].join(" ");
      if (key !== this.drawKey) {
        this.drawKey = key;
        this.#buildGlyphs(w, h, spec);
      }
      const u = mesh.material.userData.uiUniforms;
      u.color.value.set(p.color);
      u.outlineColor.value.set(p.outlineColor ?? "#000000");
      u.outlineWidth.value = outlineToField(p.outlineWidth ?? 0, p.fontSize);
      u.weightBias.value = p.weightBias ?? 0;
    } else {
      mesh.scale.set(Math.max(w, 1e-4) * unit, Math.max(h, 1e-4) * unit, 1);
      mesh.position.set(
        (0.5 - spec.pivot[0]) * w * unit,
        -(0.5 - spec.pivot[1]) * h * unit,
        0.001 * unit,
      );
      const key = [
        Math.round(w * k), Math.round(h * k), p.text, p.fontSize, p.color, p.fontFamily,
        p.fontWeight, p.align, p.valign, p.wrap, p.lineHeight,
      ].join(" ");
      if (key !== this.drawKey) {
        this.drawKey = key;
        if (drawTextToCanvas(this.canvas, w, h, k, p)) this.canvasTexture.needsUpdate = true;
      }
    }
    applyElementUniforms(mesh.material, {
      clipRect,
      alpha: alpha * (p.opacity ?? 1),
      k,
      depthTest,
      screenSpace,
      uiWidth,
      uiHeight,
    });
  }

  /** Natural size of the current text in UI px — for auto-sizing a label. */
  measure(maxWidth = Infinity) {
    if (this.props.sdf === false || typeof document === "undefined") return { w: 0, h: 0 };
    const font = this.font ?? getSdfFont(this.props.fontFamily, this.props.fontWeight);
    const { width, height } = layoutGlyphs(font, maxWidth, 0, this.props);
    return { w: width, h: height };
  }
}
