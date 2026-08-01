import * as THREE from "three/webgpu";
import {
  ELEMENT_DEFAULTS,
  STRETCH_FILL_SPEC,
  computeElementRect,
  pivotPoint,
  intersectRects,
  rectContains,
  computeScreenScale,
  layoutChildren,
  clampScroll,
} from "./layout.js";
import { isEditor } from "../editorBridge.js";
import { FocusNavigator } from "./uiFocus.js";

/**
 * Dedicated three.js layer for UI meshes. Scene cameras never enable it, so
 * UI quads (which live in the scene tree at pixel-scale coordinates) are
 * invisible to the 3D render; the UiSystem renders this layer itself, either
 * through its own orthographic camera (screen overlay) or through the scene
 * camera (world-space panels).
 */
export const UI_LAYER = 30;

const CLICK_SLOP_PX = 5;

/**
 * How a screen is presented on a given frame.
 *
 *   "overlay" — a full-viewport HUD drawn with an orthographic camera.
 *   "world"   — a panel in the scene, at the entity's transform.
 *   "plane"   — a screen-space screen shown *as* a world panel.
 *
 * The third one exists for the editor. A screen-space HUD covering the whole
 * viewport is exactly right in a running game and unusable while authoring: it
 * sits on top of the scene, so you cannot see what you are building and cannot
 * click past it. Unity and PlayCanvas both solve this the same way — the canvas
 * is a rectangle in the world that you fly to and edit on its own — and that is
 * what "plane" is. Pressing Play (or ticking Show UI Overlay) puts it back
 * where the player will see it.
 */
export function screenMode(screen, engine, { overlayPreview = false } = {}) {
  if (screen.props.renderMode === "world") return "world";
  if (engine?.playing || overlayPreview || !isEditor()) return "overlay";
  return "plane";
}

/**
 * Per-engine UI runtime. Created lazily by the first UiScreenComponent.
 *
 * Responsibilities:
 *  - Layout: every frame, walk each screen's entity subtree, compute element
 *    rects from anchors/layout containers/scroll offsets, write positions into
 *    the entities' Object3Ds and push uniforms into visual components.
 *  - Render: an overlay pass with an orthographic camera for screen-space
 *    screens (0..w, 0..-h — UI y-down maps to negative three.js y), and a pass
 *    through the scene camera for world panels.
 *  - Input: pointer/wheel on the canvas → hover/press/click and scrolling, plus
 *    directional focus navigation from the UI action map.
 *  - Editor services: hitTest() for viewport picking and a selection highlight.
 */
export class UiSystem {
  constructor(engine) {
    this.engine = engine;
    this.screens = new Set(); // UiScreenComponent instances
    this.camera = new THREE.OrthographicCamera(0, 100, 0, -100, -1000, 1000);
    this.camera.layers.set(UI_LAYER);
    this.boundCanvas = null;
    this.pointer = { downButton: null, downX: 0, downY: 0, hover: null, scrollDrag: null };
    this.highlight = null; // { entityId } — editor selection outline
    this.highlightMesh = null;
    /** Editor: show screen-space screens as real overlays without pressing Play. */
    this.overlayPreview = false;
    this.focus = new FocusNavigator(this);
    this.unsubUpdate = engine.onUpdate(() => this.update());
    this.unsubPost = engine.onPostRender(() => this.render());
    this.onPlayChanged = (playing) => {
      if (!playing) {
        this.#clearInteraction();
        this.focus.clear();
      }
    };
    engine.on("play-changed", this.onPlayChanged);
  }

  addScreen(screenComponent) {
    this.screens.add(screenComponent);
  }

  removeScreen(screenComponent) {
    this.screens.delete(screenComponent);
    if (this.focus.screen === screenComponent) this.focus.clear();
  }

  /** Editor toggle: preview screen-space UI as an overlay while not playing. */
  setOverlayPreview(on) {
    this.overlayPreview = !!on;
  }

  /** How `screen` will be drawn this frame. */
  modeOf(screen) {
    return screenMode(screen, this.engine, { overlayPreview: this.overlayPreview });
  }

  // -- Layout pass -----------------------------------------------------------

  update() {
    this.#bindInput();
    const renderer = this.engine.renderer;
    if (!renderer) return;
    const size = renderer.getSize(_v2);
    const dpr = renderer.getPixelRatio?.() ?? 1;
    for (const screen of this.screens) {
      this.#layoutScreen(screen, size.x, size.y, dpr);
    }
    this.focus.update();
    this.#updateHighlight();
  }

  #layoutScreen(screen, canvasW, canvasH, dpr) {
    const entity = screen.entity;
    if (!entity) return;
    const p = screen.props;
    const mode = this.modeOf(screen);
    screen.mode = mode;

    let w;
    let h;
    let unit;
    let s;
    if (mode === "overlay") {
      s = computeScreenScale(p.scaleMode, p.referenceWidth, p.referenceHeight, canvasW, canvasH);
      w = canvasW / s;
      h = canvasH / s;
      unit = 1;
      // The screen root is pinned to the world origin so the ortho camera's
      // 0..w/0..-h window lines up with it regardless of scene transforms.
      entity.object3D.position.set(0, 0, 0);
      entity.object3D.rotation.set(0, 0, 0);
      entity.object3D.scale.set(1, 1, 1);
    } else {
      // A panel has an intrinsic size — the reference resolution — rather than
      // the window's. That also keeps the editing plane from resizing under you
      // when the viewport panel changes shape.
      w = Math.max(1, p.referenceWidth);
      h = Math.max(1, p.referenceHeight);
      unit = p.worldScale > 0 ? p.worldScale : 0.01;
      s = 1;
      if (p.billboard !== false && mode === "world") this.#faceCamera(entity.object3D);
    }

    // Everything the render + input passes need, cached on the component.
    screen.uiWidth = w;
    screen.uiHeight = h;
    screen.scale = s;
    screen.unit = unit;
    // UI px → physical framebuffer px. Exact for an overlay; for a panel the
    // on-screen size depends on the camera, so this is only a hint for the
    // raster-text path (the SDF path needs no such thing, which is most of why
    // it is the default).
    screen.k = mode === "overlay" ? s * dpr : 2;
    screen.hitList = [];

    const ctx = { k: screen.k, order: 1, screen, unit, mode, depthTest: mode === "world" && p.occluded === true };
    // Overlay: UI (0,0) is the root, which sits at the camera window's top
    // left. Panel: the root is the panel's *centre*, which is what a transform
    // gizmo on a floating health bar should grab.
    const originPivot = mode === "overlay" ? { x: 0, y: 0 } : { x: w / 2, y: h / 2 };
    this.#layoutChildrenOf(entity, { x: 0, y: 0, w, h }, originPivot, null, 1, ctx);
  }

  /** Turns `object3D` to face the active camera, preserving its position. */
  #faceCamera(object3D) {
    const camera = this.engine.camera;
    if (!camera) return;
    camera.getWorldQuaternion(_q);
    if (object3D.parent) {
      // Cancel the parent's rotation so the panel faces the camera in world
      // space even when it is bolted to a rotating enemy — which is the whole
      // point of a billboarded health bar.
      object3D.parent.getWorldQuaternion(_q2);
      _q2.invert();
      _q.premultiply(_q2);
    }
    object3D.quaternion.copy(_q);
  }

  /** Recursively lays out `entity`'s children against `parentRect`. */
  #layoutChildrenOf(entity, parentRect, parentPivotAbs, clipRect, alpha, ctx) {
    // Scroll: children see a shifted parent rect and get clipped to it.
    const scroll = entity.getComponent?.("uiscroll");
    let childParentRect = parentRect;
    let childClip = clipRect;
    if (scroll) {
      scroll.scrollX = clampScroll(scroll.scrollX ?? 0, scroll.contentW ?? 0, parentRect.w);
      scroll.scrollY = clampScroll(scroll.scrollY ?? 0, scroll.contentH ?? 0, parentRect.h);
      childParentRect = {
        x: parentRect.x - scroll.scrollX,
        y: parentRect.y - scroll.scrollY,
        w: parentRect.w,
        h: parentRect.h,
      };
      childClip = intersectRects(clipRect, parentRect);
    }
    const mask = entity.getComponent?.("uimask");
    if (mask && mask.props.enabled !== false) {
      childClip = intersectRects(childClip, parentRect);
    }

    // Layout container: precompute rects for children, overriding anchors.
    const layout = entity.getComponent?.("uilayout");
    let layoutRects = null;
    if (layout) {
      const sizes = entity.children.map((child) => {
        const el = child.getComponent("uielement");
        return el ? [el.props.size[0] ?? 0, el.props.size[1] ?? 0] : [100, 100];
      });
      const result = layoutChildren(childParentRect, layout.props, sizes);
      layoutRects = result.rects;
      layout.contentMain = result.contentMain;
      if (layout.props.fitContent) {
        // Grow the container's own rect along the main axis so scroll views
        // (and hit testing) see the content extent.
        if (layout.props.direction === "row") childParentRect.w = Math.max(childParentRect.w, result.contentMain);
        else childParentRect.h = Math.max(childParentRect.h, result.contentMain);
      }
    }

    let maxX = childParentRect.x;
    let maxY = childParentRect.y;

    for (let i = 0; i < entity.children.length; i++) {
      const child = entity.children[i];
      const el = child.getComponent("uielement");
      const spec = el ? { ...ELEMENT_DEFAULTS, ...el.props } : STRETCH_FILL_SPEC;
      const rect = layoutRects ? layoutRects[i] : computeElementRect(childParentRect, spec);
      const pivotAbs = layoutRects
        ? { x: rect.x + spec.pivot[0] * rect.w, y: rect.y + spec.pivot[1] * rect.h }
        : pivotPoint(rect, spec);

      child.object3D.position.set(
        (pivotAbs.x - parentPivotAbs.x) * ctx.unit,
        -(pivotAbs.y - parentPivotAbs.y) * ctx.unit,
        0,
      );
      const visible = el ? el.props.visible !== false : true;
      child.object3D.visible = visible;
      if (!visible) continue;

      const childAlpha = alpha * (el ? (el.props.opacity ?? 1) : 1);
      if (el) {
        el.rect = rect;
        el.clipRect = childClip ? { ...childClip } : null;
        el.worldAlpha = childAlpha;
        el.layoutControlled = !!layoutRects;
      }

      // Hit list in draw order (topmost last).
      ctx.screen.hitList.push({ entity: child, el, rect, clipRect: childClip });

      const frame = {
        rect,
        // A shader clip rect is screen-space, so for a panel it is projected
        // per frame (see #projectClip) rather than used directly.
        clipRect: ctx.mode === "overlay" ? childClip : this.#projectClip(childClip, ctx),
        alpha: childAlpha,
        k: ctx.k,
        order: ctx.order,
        spec,
        unit: ctx.unit,
        depthTest: ctx.depthTest,
      };
      child.getComponent("uiimage")?.onUiLayout?.(frame);
      child.getComponent("uitext")?.onUiLayout?.(frame);
      ctx.order += 2; // image + text on the same entity stay ordered

      this.#layoutChildrenOf(child, rect, pivotAbs, childClip, childAlpha, ctx);
      // Content extent AFTER the recursion: a child's fitContent layout may
      // have grown its rect (the rect object is shared by reference), and
      // scroll views need to see the grown extent.
      maxX = Math.max(maxX, rect.x + rect.w);
      maxY = Math.max(maxY, rect.y + rect.h);
    }

    if (scroll) {
      scroll.contentW = maxX - childParentRect.x;
      scroll.contentH = maxY - childParentRect.y;
      scroll.viewportW = parentRect.w;
      scroll.viewportH = parentRect.h;
    }
  }

  /**
   * Screen-space bounding box (physical px) of a UI-space clip rect on a
   * world panel, by projecting its four corners.
   *
   * Exact for a panel that faces the camera — which a billboarded one always
   * does, and which is where scroll views and masks actually get used. For a
   * panel seen at an angle it is a conservative box: the mask clips a little
   * less than it should rather than cutting into content, which is the
   * failure direction you can live with.
   */
  #projectClip(clipRect, ctx) {
    if (!clipRect) return null;
    const camera = this.engine.camera;
    const renderer = this.engine.renderer;
    const root = ctx.screen.entity?.object3D;
    if (!camera || !renderer || !root) return null;
    const size = renderer.getSize(_v2b);
    const dpr = renderer.getPixelRatio?.() ?? 1;
    const w = ctx.screen.uiWidth;
    const h = ctx.screen.uiHeight;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < 4; i++) {
      const ux = i === 0 || i === 3 ? clipRect.x : clipRect.x + clipRect.w;
      const uy = i < 2 ? clipRect.y : clipRect.y + clipRect.h;
      _v3.set((ux - w / 2) * ctx.unit, -(uy - h / 2) * ctx.unit, 0);
      root.localToWorld(_v3);
      _v3.project(camera);
      const px = ((_v3.x + 1) / 2) * size.x * dpr;
      const py = ((1 - _v3.y) / 2) * size.y * dpr;
      minX = Math.min(minX, px);
      maxX = Math.max(maxX, px);
      minY = Math.min(minY, py);
      maxY = Math.max(maxY, py);
    }
    // Returned in UI px because applyElementUniforms multiplies by k; undo it
    // here so the two callers agree on one contract.
    const k = ctx.k;
    return { x: minX / k, y: minY / k, w: (maxX - minX) / k, h: (maxY - minY) / k };
  }

  // -- Render pass -----------------------------------------------------------

  render() {
    const renderer = this.engine.renderer;
    if (!renderer || !this.engine.rendererReady || this.screens.size === 0) return;

    const all = [...this.screens].filter((s) => s.entity && s.entity.object3D.visible !== false);
    // Panels are part of the scene and belong under the HUD; within each group,
    // sortOrder decides.
    const panels = all.filter((s) => s.mode !== "overlay").sort(bySortOrder);
    const overlays = all.filter((s) => s.mode === "overlay").sort(bySortOrder);
    if (!panels.length && !overlays.length) return;

    const prevAutoClear = renderer.autoClear;
    const prevAutoClearColor = renderer.autoClearColor;
    const prevAutoClearDepth = renderer.autoClearDepth;
    renderer.autoClear = false;
    renderer.autoClearColor = false;
    renderer.autoClearDepth = false;
    try {
      // Panels: one pass through the scene camera with the UI layer switched
      // on. Borrowing the real camera (rather than cloning it) means the panel
      // is guaranteed to use the exact projection the frame was drawn with —
      // a clone that drifts by one frame shows up as UI that lags the world.
      const camera = this.engine.camera;
      if (panels.length && camera) {
        const mask = camera.layers.mask;
        camera.layers.set(UI_LAYER);
        try {
          this.#renderGroup(renderer, panels, camera, null);
        } finally {
          camera.layers.mask = mask;
        }
      }
      for (const screen of overlays) {
        if (!screen.uiWidth || !screen.uiHeight) continue;
        this.camera.left = 0;
        this.camera.right = screen.uiWidth;
        this.camera.top = 0;
        this.camera.bottom = -screen.uiHeight;
        this.camera.updateProjectionMatrix();
        this.#renderGroup(renderer, [screen], this.camera, all);
      }
    } finally {
      renderer.autoClear = prevAutoClear;
      renderer.autoClearColor = prevAutoClearColor;
      renderer.autoClearDepth = prevAutoClearDepth;
    }
  }

  /**
   * Renders `visible` screens, hiding every other screen for the duration.
   *
   * Every UI mesh shares UI_LAYER and every screen may have a different scale,
   * so an overlay pass has to see its own subtree and nothing else. Panels can
   * all go in one pass — they share the scene camera and their own transforms
   * keep them apart.
   */
  #renderGroup(renderer, visible, camera, allScreens) {
    const hidden = [];
    if (allScreens) {
      for (const s of allScreens) {
        if (!visible.includes(s) && s.entity?.object3D.visible) {
          s.entity.object3D.visible = false;
          hidden.push(s.entity.object3D);
        }
      }
    }
    try {
      renderer.render(this.engine.scene, camera);
    } finally {
      for (const object3D of hidden) object3D.visible = true;
    }
  }

  // -- Hit testing / picking -------------------------------------------------

  /** Canvas-relative CSS px → UI px of the given screen (any render mode). */
  cssToUi(screen, clientX, clientY) {
    const canvas = this.engine.renderer?.domElement;
    if (!canvas || !screen.uiWidth) return null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    if (screen.mode === "overlay") {
      return {
        x: ((clientX - rect.left) / rect.width) * screen.uiWidth,
        y: ((clientY - rect.top) / rect.height) * screen.uiHeight,
      };
    }
    return this.#panelPointToUi(screen, clientX, clientY, rect);
  }

  /**
   * Where a pointer ray crosses a world panel, in that panel's UI px.
   *
   * The panel is an infinite plane for this purpose; the caller's rect test
   * discards points outside it. A ray parallel to the plane (or hitting its
   * back) returns null rather than a point behind the camera.
   */
  #panelPointToUi(screen, clientX, clientY, canvasRect) {
    const camera = this.engine.camera;
    const root = screen.entity?.object3D;
    if (!camera || !root) return null;
    _ndc.set(
      ((clientX - canvasRect.left) / canvasRect.width) * 2 - 1,
      -((clientY - canvasRect.top) / canvasRect.height) * 2 + 1,
    );
    _raycaster.setFromCamera(_ndc, camera);
    root.updateMatrixWorld();
    root.getWorldQuaternion(_q);
    _normal.set(0, 0, 1).applyQuaternion(_q).normalize();
    root.getWorldPosition(_v3);
    _plane.setFromNormalAndCoplanarPoint(_normal, _v3);
    if (!_raycaster.ray.intersectPlane(_plane, _v3b)) return null;
    root.worldToLocal(_v3b);
    const unit = screen.unit || 1;
    return {
      x: _v3b.x / unit + screen.uiWidth / 2,
      y: -_v3b.y / unit + screen.uiHeight / 2,
    };
  }

  /**
   * Topmost element under a client-space point. `interactiveOnly` restricts
   * to raycastTarget elements (runtime input); the editor passes false so
   * any visible element is pickable.
   * Returns { entity, el, screen, point } or null.
   */
  hitTest(clientX, clientY, { interactiveOnly = true } = {}) {
    // Overlays sit above panels, so they get first refusal regardless of
    // sortOrder — a HUD button must win over a world label behind it.
    const screens = [...this.screens].sort((a, b) => {
      const layer = (s) => (s.mode === "overlay" ? 1 : 0);
      return layer(b) - layer(a) || (b.props.sortOrder ?? 0) - (a.props.sortOrder ?? 0);
    });
    for (const screen of screens) {
      if (!screen.hitList || screen.entity?.object3D.visible === false) continue;
      const pt = this.cssToUi(screen, clientX, clientY);
      if (!pt) continue;
      for (let i = screen.hitList.length - 1; i >= 0; i--) {
        const item = screen.hitList[i];
        if (interactiveOnly && item.el && item.el.props.raycastTarget === false) continue;
        if (interactiveOnly && !item.el) continue;
        if (!rectContains(item.rect, pt.x, pt.y)) continue;
        if (item.clipRect && !rectContains(item.clipRect, pt.x, pt.y)) continue;
        // Skip invisible ancestors (visibility already pruned in layout via
        // continue, so hitList only contains visible entities).
        return { entity: item.entity, el: item.el, screen, point: pt };
      }
    }
    return null;
  }

  /** Nearest scroll component on `entity` or its ancestors. */
  #findScroll(entity) {
    for (let e = entity; e; e = e.parent) {
      const scroll = e.getComponent?.("uiscroll");
      if (scroll) return scroll;
    }
    return null;
  }

  /** Nearest button component on `entity` or its ancestors. */
  findButton(entity) {
    for (let e = entity; e; e = e.parent) {
      const btn = e.getComponent?.("uibutton");
      if (btn && btn.props.interactable !== false) return btn;
    }
    return null;
  }

  // -- Input -----------------------------------------------------------------

  #bindInput() {
    const canvas = this.engine.renderer?.domElement;
    if (!canvas || canvas === this.boundCanvas) return;
    if (this.boundCanvas) this.#unbindInput();
    this.boundCanvas = canvas;
    this._onMove = (e) => this.#onPointerMove(e);
    this._onDown = (e) => this.#onPointerDown(e);
    this._onUp = (e) => this.#onPointerUp(e);
    this._onWheel = (e) => this.#onWheel(e);
    this._onLeave = () => this.#clearInteraction();
    canvas.addEventListener("pointermove", this._onMove);
    canvas.addEventListener("pointerdown", this._onDown);
    canvas.addEventListener("pointerup", this._onUp);
    canvas.addEventListener("wheel", this._onWheel, { passive: false });
    canvas.addEventListener("pointerleave", this._onLeave);
  }

  #unbindInput() {
    const canvas = this.boundCanvas;
    if (!canvas) return;
    canvas.removeEventListener("pointermove", this._onMove);
    canvas.removeEventListener("pointerdown", this._onDown);
    canvas.removeEventListener("pointerup", this._onUp);
    canvas.removeEventListener("wheel", this._onWheel);
    canvas.removeEventListener("pointerleave", this._onLeave);
    this.boundCanvas = null;
  }

  #clearInteraction() {
    if (this.pointer.hover) this.pointer.hover.setHovered?.(false);
    if (this.pointer.downButton) this.pointer.downButton.setPressed?.(false);
    this.pointer = { downButton: null, downX: 0, downY: 0, hover: null, scrollDrag: null };
  }

  #onPointerMove(e) {
    if (!this.engine.playing) return;
    const p = this.pointer;

    // Drag-scroll: past the slop threshold the press becomes a scroll drag.
    if (p.scrollDrag) {
      const { scroll, startScrollX, startScrollY, screen } = p.scrollDrag;
      const dx = (e.clientX - p.downX) / (screen.scale ?? 1);
      const dy = (e.clientY - p.downY) / (screen.scale ?? 1);
      if (!p.scrollDrag.active && Math.hypot(dx, dy) > CLICK_SLOP_PX) {
        p.scrollDrag.active = true;
        if (p.downButton) {
          p.downButton.setPressed?.(false);
          p.downButton = null; // drag cancels the pending click
        }
      }
      if (p.scrollDrag.active) {
        if (scroll.props.horizontal) {
          scroll.scrollX = clampScroll(startScrollX - dx, scroll.contentW ?? 0, scroll.viewportW ?? 0);
        }
        if (scroll.props.vertical !== false) {
          scroll.scrollY = clampScroll(startScrollY - dy, scroll.contentH ?? 0, scroll.viewportH ?? 0);
        }
        return;
      }
    }

    const hit = this.hitTest(e.clientX, e.clientY);
    const button = hit ? this.findButton(hit.entity) : null;
    if (button !== p.hover) {
      p.hover?.setHovered?.(false);
      button?.setHovered?.(true);
      p.hover = button;
      const canvas = this.boundCanvas;
      if (canvas) canvas.style.cursor = button ? "pointer" : "";
    }
    if (p.downButton) p.downButton.setPressed?.(button === p.downButton);
  }

  #onPointerDown(e) {
    if (!this.engine.playing || e.button !== 0) return;
    const hit = this.hitTest(e.clientX, e.clientY);
    if (!hit) return;
    const p = this.pointer;
    p.downX = e.clientX;
    p.downY = e.clientY;
    const button = this.findButton(hit.entity);
    if (button) {
      p.downButton = button;
      button.setPressed?.(true);
      // Clicking is also a focus change, so a gamepad picking up after a mouse
      // click continues from where the player last touched rather than from
      // wherever the keyboard happened to be.
      this.focus.set(button);
    }
    const scroll = this.#findScroll(hit.entity);
    if (scroll && scroll.props.dragScroll !== false) {
      p.scrollDrag = {
        scroll,
        screen: hit.screen,
        startScrollX: scroll.scrollX ?? 0,
        startScrollY: scroll.scrollY ?? 0,
        active: false,
      };
    }
  }

  #onPointerUp(e) {
    if (e.button !== 0) return;
    const p = this.pointer;
    const downButton = p.downButton;
    p.downButton = null;
    p.scrollDrag = null;
    if (!this.engine.playing || !downButton) return;
    downButton.setPressed?.(false);
    const moved = Math.hypot(e.clientX - p.downX, e.clientY - p.downY);
    if (moved > CLICK_SLOP_PX) return;
    const hit = this.hitTest(e.clientX, e.clientY);
    if (hit && this.findButton(hit.entity) === downButton) {
      downButton.click();
    }
  }

  #onWheel(e) {
    if (!this.engine.playing) return;
    const hit = this.hitTest(e.clientX, e.clientY);
    const scroll = hit ? this.#findScroll(hit.entity) : null;
    if (!scroll) return;
    e.preventDefault();
    const speed = scroll.props.wheelSpeed ?? 1;
    if (scroll.props.vertical !== false) {
      scroll.scrollY = clampScroll(
        (scroll.scrollY ?? 0) + e.deltaY * speed,
        scroll.contentH ?? 0,
        scroll.viewportH ?? 0,
      );
    } else if (scroll.props.horizontal) {
      scroll.scrollX = clampScroll(
        (scroll.scrollX ?? 0) + e.deltaY * speed,
        scroll.contentW ?? 0,
        scroll.viewportW ?? 0,
      );
    }
  }

  // -- Editor selection highlight ---------------------------------------------

  /** Editor-only: outline the given entity's computed rect (null = hide). */
  setHighlight(entityId) {
    this.highlight = entityId ? { entityId } : null;
    if (!this.highlight && this.highlightMesh) this.highlightMesh.visible = false;
  }

  #updateHighlight() {
    if (!this.highlight) {
      if (this.highlightMesh) this.highlightMesh.visible = false;
      return;
    }
    const entity = this.engine.getEntity(this.highlight.entityId);
    const el = entity?.getComponent?.("uielement");
    const rect = el?.rect;
    if (!rect || !entity) {
      if (this.highlightMesh) this.highlightMesh.visible = false;
      return;
    }
    if (!this.highlightMesh) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(15), 3));
      const material = new THREE.LineBasicMaterial({ color: 0x4da3ff, depthTest: false, transparent: true });
      this.highlightMesh = new THREE.Line(geometry, material);
      this.highlightMesh.layers.set(UI_LAYER);
      this.highlightMesh.renderOrder = 100000;
      this.highlightMesh.frustumCulled = false;
      this.highlightMesh.userData.editorOnly = true;
      this.highlightMesh.raycast = () => {};
    }
    // Parented to the highlighted element rather than to the scene root: a
    // world panel's outline has to travel with the panel, and the element's
    // own transform already carries the layout position.
    if (this.highlightMesh.parent !== entity.object3D) {
      this.highlightMesh.removeFromParent();
      entity.object3D.add(this.highlightMesh);
    }
    const screen = this.#screenOf(entity);
    const unit = screen?.unit ?? 1;
    const spec = { ...ELEMENT_DEFAULTS, ...(el.props ?? {}) };
    // Local to the element: its pivot is at the origin.
    const ox = spec.pivot[0] * rect.w;
    const oy = spec.pivot[1] * rect.h;
    const a = this.highlightMesh.geometry.attributes.position;
    const pts = [
      [0, 0],
      [rect.w, 0],
      [rect.w, rect.h],
      [0, rect.h],
      [0, 0],
    ];
    for (let i = 0; i < 5; i++) {
      a.setXYZ(i, (pts[i][0] - ox) * unit, -(pts[i][1] - oy) * unit, 0.002 * unit);
    }
    a.needsUpdate = true;
    this.highlightMesh.geometry.computeBoundingSphere();
    this.highlightMesh.visible = !this.engine.playing;
  }

  /** The screen component whose subtree contains `entity`. */
  #screenOf(entity) {
    for (let e = entity; e; e = e.parent) {
      const screen = e.getComponent?.("uiscreen");
      if (screen) return screen;
    }
    return null;
  }

  /** The screen an entity belongs to (public — the editor frames it). */
  screenOf(entity) {
    return this.#screenOf(entity);
  }

  dispose() {
    this.unsubUpdate?.();
    this.unsubPost?.();
    this.#unbindInput();
    this.engine.off?.("play-changed", this.onPlayChanged);
    if (this.highlightMesh) {
      this.highlightMesh.removeFromParent();
      this.highlightMesh.geometry.dispose();
      this.highlightMesh.material.dispose();
      this.highlightMesh = null;
    }
  }
}

const bySortOrder = (a, b) => (a.props.sortOrder ?? 0) - (b.props.sortOrder ?? 0);

const _v2 = new THREE.Vector2();
const _v2b = new THREE.Vector2();
const _v3 = new THREE.Vector3();
const _v3b = new THREE.Vector3();
const _ndc = new THREE.Vector2();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _normal = new THREE.Vector3();
const _plane = new THREE.Plane();
const _raycaster = new THREE.Raycaster();

/**
 * Lazily creates the per-engine UiSystem (or returns the existing one).
 * Stored as a property on the engine (not a WeakMap keyed by identity) so
 * the editor's lazy-engine Proxy shim — a different object that forwards
 * property access to the real instance — resolves the same system.
 */
export function getUiSystem(engine, { create = true } = {}) {
  let system = engine.uiSystem ?? null;
  if (!system && create) {
    system = new UiSystem(engine);
    engine.uiSystem = system;
  }
  return system;
}
