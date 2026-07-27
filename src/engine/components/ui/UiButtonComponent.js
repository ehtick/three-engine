import { Component } from "../Component.js";

/**
 * Makes an entity clickable while the game is playing. The UiSystem drives
 * hover/pressed states via `setState`; visual feedback is a tint applied to
 * the sibling UiImage.
 *
 * On click:
 *   - every script component on this entity gets `onClick()` called
 *     (same convention as physics' onCollisionEnter hooks), and
 *   - the engine emits a "ui-click" event with the entity.
 */
export class UiButtonComponent extends Component {
  static type = "uibutton";
  static label = "UI Button";
  static defaults = {
    interactable: true,
    normalColor: "#ffffff",
    hoverColor: "#e8e8e8",
    pressedColor: "#c2c2c2",
    disabledColor: "#7a7a7a",
  };
  static schema = [
    { key: "interactable", label: "Interactable", type: "boolean" },
    { key: "normalColor", label: "Normal Tint", type: "color" },
    { key: "hoverColor", label: "Hover Tint", type: "color" },
    { key: "pressedColor", label: "Pressed Tint", type: "color" },
    { key: "disabledColor", label: "Disabled Tint", type: "color" },
  ];

  onAttach() {
    this.state = "normal";
    this.#applyTint();
  }

  onDetach() {
    this.state = "normal";
    this.entity.getComponent("uiimage")?.setTint("#ffffff");
  }

  onPropChanged() {
    this.#applyTint();
  }

  setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.#applyTint();
    const hook = state === "hover" ? "onPointerEnter" : state === "normal" ? "onPointerExit" : null;
    if (hook) this.entity.getComponent("script")?.dispatch(hook);
  }

  #applyTint() {
    const image = this.entity.getComponent("uiimage");
    if (!image) return;
    const p = this.props;
    const tint =
      p.interactable === false
        ? p.disabledColor
        : this.state === "pressed"
          ? p.pressedColor
          : this.state === "hover"
            ? p.hoverColor
            : p.normalColor;
    image.setTint(tint);
  }

  click() {
    if (this.props.interactable === false) return;
    this.entity.getComponent("script")?.dispatch("onClick");
    this.entity.engine.emit("ui-click", this.entity);
  }
}
