// @ts-check
import { Component } from "../Component.js";
import { runActions } from "../../events/actions.js";

/**
 * Makes an entity clickable — and, since a game has to be playable on a pad,
 * focusable. The UiSystem drives hover/press from the pointer and focus from
 * the UI action map; visual feedback is a tint applied to the sibling UiImage.
 *
 * The three interaction flags are independent rather than one `state` string.
 * They genuinely overlap — a focused button can also be hovered, and releasing
 * the mouse over a focused button must return to the *focused* look, not to
 * normal — and collapsing them into one value is what produces menus where the
 * gamepad highlight vanishes the first time someone touches the mouse.
 *
 * On click:
 *   - every script component on this entity gets `onClick()` (same convention
 *     as the physics collision hooks), and
 *   - the engine emits "ui-click" with the entity.
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
    focusColor: "#d6e9ff",
    // Explicit navigation targets. Empty = pick the nearest button in that
    // direction; set one to hand-author a menu's wiring (or to wrap around,
    // which geometry alone can never produce).
    navUp: "",
    navDown: "",
    navLeft: "",
    navRight: "",
    // Inspector-authored responses, the way Unity's `Button.onClick` works —
    // and in the same place, on the button itself, because "what does this
    // button do" is a question you ask while looking at the button.
    //
    // Additive to the two mechanisms that were already here: scripts on this
    // entity still get `onClick()` dispatched, and `ui-click` still fires on
    // the engine. A button whose behaviour lives in a script does not have to
    // move it here, and a menu with no scripts at all no longer needs one.
    onClick: [],
    onPointerEnter: [],
    onPointerExit: [],
    onFocus: [],
    onBlur: [],
  };
  static schema = [
    { key: "interactable", label: "Interactable", type: "boolean" },
    { key: "normalColor", label: "Normal Tint", type: "color" },
    { key: "hoverColor", label: "Hover Tint", type: "color" },
    { key: "pressedColor", label: "Pressed Tint", type: "color" },
    { key: "disabledColor", label: "Disabled Tint", type: "color" },
    { key: "focusColor", label: "Focus Tint", type: "color" },
    { key: "navUp", label: "Nav Up", type: "entity" },
    { key: "navDown", label: "Nav Down", type: "entity" },
    { key: "navLeft", label: "Nav Left", type: "entity" },
    { key: "navRight", label: "Nav Right", type: "entity" },
    // Rendered by the inspector's Actions sections rather than the generic
    // field list, but declared here so the scene loader's entity-id remap finds
    // the ids inside them — a duplicated menu must point at its own screens.
    { key: "onClick", label: "On Click", type: "actions", hidden: true },
    { key: "onPointerEnter", label: "On Pointer Enter", type: "actions", hidden: true },
    { key: "onPointerExit", label: "On Pointer Exit", type: "actions", hidden: true },
    { key: "onFocus", label: "On Focus", type: "actions", hidden: true },
    { key: "onBlur", label: "On Blur", type: "actions", hidden: true },
  ];

  onAttach() {
    this.hovered = false;
    this.pressed = false;
    this.focused = false;
    this.#applyTint();
  }

  onDetach() {
    this.hovered = false;
    this.pressed = false;
    this.focused = false;
    this.entity.getComponent("uiimage")?.setTint("#ffffff");
  }

  onPropChanged() {
    this.#applyTint();
  }

  /** Compatibility with the old single-state API. */
  get state() {
    if (this.props.interactable === false) return "disabled";
    if (this.pressed) return "pressed";
    if (this.hovered) return "hover";
    if (this.focused) return "focused";
    return "normal";
  }

  setHovered(on) {
    if (this.hovered === !!on) return;
    this.hovered = !!on;
    this.#applyTint();
    this.entity.getComponent("script")?.dispatch(on ? "onPointerEnter" : "onPointerExit");
    this.#run(on ? "onPointerEnter" : "onPointerExit");
  }

  setPressed(on) {
    if (this.pressed === !!on) return;
    this.pressed = !!on;
    this.#applyTint();
  }

  setFocused(on) {
    if (this.focused === !!on) return;
    this.focused = !!on;
    this.#applyTint();
    this.entity.getComponent("script")?.dispatch(on ? "onFocus" : "onBlur");
    this.#run(on ? "onFocus" : "onBlur");
  }

  /** Legacy setter, kept so existing scripts keep working. */
  setState(state) {
    this.setPressed(state === "pressed");
    this.setHovered(state === "hover");
  }

  #applyTint() {
    const image = this.entity.getComponent("uiimage");
    if (!image) return;
    const p = this.props;
    // Priority: disabled beats everything, then the most transient signal
    // wins — press, then hover, then focus.
    const tint =
      p.interactable === false
        ? p.disabledColor
        : this.pressed
          ? p.pressedColor
          : this.hovered
            ? p.hoverColor
            : this.focused
              ? (p.focusColor ?? p.hoverColor)
              : p.normalColor;
    image.setTint(tint);
  }

  click() {
    if (this.props.interactable === false) return;
    this.entity.getComponent("script")?.dispatch("onClick");
    this.entity.engine.emit("ui-click", this.entity);
    this.#run("onClick");
  }

  /**
   * Runs one of the inspector-authored response lists.
   *
   * Gated on `engine.playing` for the same reason the binding component is:
   * the editor drives hover and focus while a menu is merely being *looked* at
   * in the viewport, and a response that loads a scene would take the author's
   * work with it. Deliberately last in each handler, after the script dispatch
   * and the global event, so the three mechanisms have a defined order.
   */
  #run(key) {
    const actions = this.props[key];
    if (!actions?.length) return;
    const engine = this.entity?.engine;
    if (!engine?.playing) return;
    runActions(actions, { engine, self: this.entity, args: [], params: [] });
  }
}
