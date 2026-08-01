import { Component } from "../Component.js";
import { getUiSystem } from "../../ui/UiSystem.js";

/**
 * Root of a UI hierarchy — the "canvas".
 *
 * **Screen** (`renderMode: "screen"`) is a HUD: children lay out against the
 * render canvas, scaled per the reference resolution + scale mode, so the same
 * layout adapts to any window size:
 *
 *   none   — 1 UI px = 1 canvas px (no scaling).
 *   fit    — the whole reference resolution stays visible (min scale).
 *   fill   — the reference resolution covers the canvas (max scale).
 *   width  — reference width matches exactly, height is free.
 *   height — reference height matches exactly, width is free.
 *
 * **World** (`renderMode: "world"`) is a panel living in the scene at this
 * entity's transform: a health bar over an enemy, a sign on a wall, a floating
 * interaction prompt. It is `referenceWidth × referenceHeight` UI pixels
 * across, converted to metres by `worldScale`, so a 200×40 bar at 0.005 is
 * 1m × 0.2m. Parent it to the thing it describes and turn `billboard` on.
 *
 * In the editor a *screen*-mode canvas is drawn as a world panel too, so it
 * does not sit on top of the scene you are trying to build — press Play (or
 * tick Show UI Overlay in the viewport's Layers menu) to see it where the
 * player will. Its transform is only used for that preview; a HUD ignores it
 * at runtime.
 *
 * Known limit: mask/scroll clipping on a world panel is a projected screen-space
 * box, which is exact for a billboarded panel and conservative for one seen at
 * a steep angle.
 */
export class UiScreenComponent extends Component {
  static type = "uiscreen";
  static label = "UI Screen";
  static defaults = {
    renderMode: "screen", // screen | world
    referenceWidth: 1280,
    referenceHeight: 720,
    scaleMode: "fit",
    sortOrder: 0,
    // World/editor-plane only:
    worldScale: 0.01, // world units per UI pixel
    billboard: true, // face the active camera
    occluded: false, // let scene geometry hide it (depth test)
  };
  static schema = [
    { key: "renderMode", label: "Render Mode", type: "select", options: ["screen", "world"] },
    { key: "referenceWidth", label: "Ref Width", type: "number", min: 1, step: 1 },
    { key: "referenceHeight", label: "Ref Height", type: "number", min: 1, step: 1 },
    { key: "scaleMode", label: "Scale Mode", type: "select", options: ["fit", "fill", "width", "height", "none"] },
    { key: "sortOrder", label: "Sort Order", type: "number", step: 1 },
    { key: "worldScale", label: "World Scale", type: "number", min: 0.0001, step: 0.001 },
    { key: "billboard", label: "Billboard", type: "boolean" },
    { key: "occluded", label: "Occluded", type: "boolean" },
  ];

  onAttach() {
    // Written by the UiSystem layout pass each frame.
    this.uiWidth = 0;
    this.uiHeight = 0;
    this.scale = 1;
    this.unit = 1;
    this.k = 1;
    this.mode = "overlay";
    this.hitList = [];
    getUiSystem(this.entity.engine).addScreen(this);
  }

  onDetach() {
    getUiSystem(this.entity.engine, { create: false })?.removeScreen(this);
  }

  onPropChanged() {}

  /** World-space size of the panel in metres — what the editor frames to. */
  get worldSize() {
    const unit = this.props.worldScale > 0 ? this.props.worldScale : 0.01;
    return { w: this.props.referenceWidth * unit, h: this.props.referenceHeight * unit };
  }
}
