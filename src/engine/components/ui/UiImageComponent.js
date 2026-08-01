import * as THREE from "three/webgpu";
import { Component } from "../Component.js";
import { createUiImageMaterial, applyElementUniforms } from "../../ui/uiMaterial.js";
import { UI_LAYER } from "../../ui/UiSystem.js";
import { loadTextureAsset } from "../../textureAsset.js";

// One shared unit plane for every UI quad — meshes scale it per-rect.
let sharedPlane = null;
function getPlane() {
  if (!sharedPlane) sharedPlane = new THREE.PlaneGeometry(1, 1);
  return sharedPlane;
}

/**
 * Visual rectangle: solid color and/or texture with SDF rounded corners,
 * border stroke, and a fill cutoff for progress bars. All styling is
 * shader-side (one quad, uniform updates only) except texture/fillMode
 * changes, which rebuild the node material.
 */
export class UiImageComponent extends Component {
  static type = "uiimage";
  static label = "UI Image";
  static defaults = {
    color: "#ffffff",
    opacity: 1,
    texture: "", // image asset path; empty = flat color
    cornerRadius: 0,
    borderWidth: 0,
    borderColor: "#000000",
    fillMode: "none", // none | horizontal | vertical
    fillAmount: 1,
    // How a texture maps onto the quad:
    //   simple — stretch the whole image (the old, only, behaviour)
    //   sliced — nine-slice: corners keep their pixel size, edges stretch
    //   tiled  — nine-slice with the middle repeated instead of stretched
    imageType: "simple",
    // Nine-slice insets, in TEXTURE pixels. They are a property of the
    // artwork, not of the element, so they stay in texture space and survive
    // the element being resized.
    sliceLeft: 0,
    sliceRight: 0,
    sliceTop: 0,
    sliceBottom: 0,
  };
  static schema = [
    { key: "color", label: "Color", type: "color" },
    { key: "opacity", label: "Opacity", type: "number", min: 0, max: 1, step: 0.05 },
    { key: "texture", label: "Texture", type: "asset", exts: ["png", "jpg", "jpeg", "webp"] },
    { key: "imageType", label: "Image Type", type: "select", options: ["simple", "sliced", "tiled"] },
    { key: "sliceLeft", label: "Slice L", type: "number", min: 0, step: 1 },
    { key: "sliceRight", label: "Slice R", type: "number", min: 0, step: 1 },
    { key: "sliceTop", label: "Slice T", type: "number", min: 0, step: 1 },
    { key: "sliceBottom", label: "Slice B", type: "number", min: 0, step: 1 },
    { key: "cornerRadius", label: "Corner Radius", type: "number", min: 0, step: 1 },
    { key: "borderWidth", label: "Border Width", type: "number", min: 0, step: 1 },
    { key: "borderColor", label: "Border Color", type: "color" },
    { key: "fillMode", label: "Fill Mode", type: "select", options: ["none", "horizontal", "vertical"] },
    { key: "fillAmount", label: "Fill Amount", type: "number", min: 0, max: 1, step: 0.01 },
  ];

  onAttach() {
    this.texture = null;
    this.tint = new THREE.Color(1, 1, 1); // runtime-only (button states)
    this.generation = 0;
    this.mesh = new THREE.Mesh(getPlane(), createUiImageMaterial({ fillMode: this.props.fillMode }));
    this.mesh.layers.set(UI_LAYER);
    this.mesh.frustumCulled = false;
    this.mesh.userData.entityId = this.entity.id;
    // UI meshes sit at pixel-scale coordinates in the scene tree — keep the
    // editor's 3D raycaster from ever hitting them (picking goes through
    // UiSystem.hitTest instead).
    this.mesh.raycast = () => {};
    this.entity.object3D.add(this.mesh);
    if (this.props.texture) this.#loadTexture(this.props.texture);
  }

  onDetach() {
    this.generation++;
    if (this.mesh) {
      this.entity.object3D.remove(this.mesh);
      this.mesh.material.dispose();
      this.mesh = null;
    }
    this.texture?.dispose();
    this.texture = null;
  }

  onPropChanged(key) {
    if (!this.mesh) return;
    if (key === "texture") {
      this.texture?.dispose();
      this.texture = null;
      if (this.props.texture) this.#loadTexture(this.props.texture);
      else this.#rebuildMaterial();
    } else if (key === "fillMode" || key === "imageType") {
      this.#rebuildMaterial();
    }
    // Everything else is a uniform, written on the next layout pass.
  }

  #rebuildMaterial() {
    if (!this.mesh) return;
    this.mesh.material.dispose();
    this.mesh.material = createUiImageMaterial({
      texture: this.texture,
      fillMode: this.props.fillMode,
      imageType: this.props.imageType,
    });
  }

  async #loadTexture(path) {
    const generation = ++this.generation;
    try {
      const tex = await loadTextureAsset(path, { colorSpace: THREE.SRGBColorSpace });
      if (generation !== this.generation || !this.mesh) {
        tex.dispose();
        return;
      }
      this.texture = tex;
      this.#rebuildMaterial();
    } catch (err) {
      console.warn(`UI image texture failed to load: ${path}`, err);
    }
  }

  /** Runtime tint (button hover/pressed states) — not serialized. */
  setTint(color) {
    this.tint.set(color);
  }

  /** Called by the UiSystem layout pass with the computed frame. */
  onUiLayout({ rect, clipRect, alpha, k, order, spec, unit = 1, depthTest = false }) {
    const mesh = this.mesh;
    if (!mesh) return;
    const { w, h } = rect;
    // `unit` is world units per UI px — 1 for a screen overlay, small for a
    // world-space panel. The rect stays in UI px so the SDF, the slice insets
    // and hit testing all keep working in one coordinate system.
    mesh.scale.set(Math.max(w, 1e-4) * unit, Math.max(h, 1e-4) * unit, 1);
    mesh.position.set((0.5 - spec.pivot[0]) * w * unit, -(0.5 - spec.pivot[1]) * h * unit, 0);
    mesh.renderOrder = order;

    const p = this.props;
    const u = mesh.material.userData.uiUniforms;
    u.size.value.set(w, h);
    u.radius.value = Math.min(p.cornerRadius, Math.min(w, h) / 2);
    u.borderWidth.value = p.borderWidth;
    u.borderColor.value.set(p.borderColor);
    u.color.value.set(p.color);
    u.tint.value.copy(this.tint);
    u.fillAmount.value = p.fillAmount;
    const image = this.texture?.image;
    if (image?.width) {
      u.texSize.value.set(image.width, image.height);
      // Insets are clamped to the texture so a typo can't invert the middle
      // region (which shows up as the panel's centre sampling backwards).
      const maxX = image.width / 2;
      const maxY = image.height / 2;
      u.slice.value.set(
        Math.min(p.sliceLeft ?? 0, maxX),
        Math.min(p.sliceRight ?? 0, maxX),
        Math.min(p.sliceTop ?? 0, maxY),
        Math.min(p.sliceBottom ?? 0, maxY),
      );
    }
    applyElementUniforms(mesh.material, {
      clipRect,
      alpha: alpha * (p.opacity ?? 1),
      k,
      depthTest,
    });
  }
}
