/**
 * Directional focus navigation — the thing that makes a menu playable without
 * a mouse.
 *
 * Driven by the existing `UI` action map (Navigate / Submit / Cancel), so it
 * works from arrow keys, a d-pad and a stick on day one, and is rebindable in
 * the Input panel like everything else.
 */

/** How far a stick has to move before it counts as a direction. */
const DEADZONE = 0.5;
/** Held-direction repeat: a pause, then a steady rate. */
const REPEAT_DELAY = 0.4;
const REPEAT_RATE = 0.12;

const centre = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

/**
 * The best candidate to move to from `fromRect` heading `dir` (a unit vector
 * in UI space, y down), or null.
 *
 * Scored as `along + PERPENDICULAR_PENALTY × across` rather than by straight
 * distance: pressing Right in a grid should reach the item beside you, not the
 * one diagonally down-right that happens to be a few pixels closer. Candidates
 * behind you are excluded outright — a menu where Down sometimes moves up is
 * worse than one where Down occasionally does nothing.
 */
const PERPENDICULAR_PENALTY = 2;

export function pickNeighbour(fromRect, candidates, dir) {
  const from = centre(fromRect);
  let best = null;
  let bestScore = Infinity;
  for (const candidate of candidates) {
    const to = centre(candidate.rect);
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const along = dx * dir.x + dy * dir.y;
    if (along <= 1e-3) continue; // behind, or exactly beside
    const across = Math.abs(dx * dir.y - dy * dir.x);
    const score = along + PERPENDICULAR_PENALTY * across;
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

/** Snaps a stick/dpad vector to one of the four directions, or null. */
export function toDirection(x, y) {
  if (Math.hypot(x, y) < DEADZONE) return null;
  // UI space is y-down; input's +y is up.
  return Math.abs(x) > Math.abs(y)
    ? { x: Math.sign(x), y: 0 }
    : { x: 0, y: -Math.sign(y) };
}

const OVERRIDE_KEYS = {
  "0,-1": "navUp",
  "0,1": "navDown",
  "-1,0": "navLeft",
  "1,0": "navRight",
};

export class FocusNavigator {
  constructor(uiSystem) {
    this.ui = uiSystem;
    this.current = null; // UiButtonComponent
    this.screen = null;
    this.heldDir = null;
    this.holdTime = 0;
    this.repeatIn = 0;
  }

  get focused() {
    return this.current;
  }

  /** Moves focus to `button` (or clears it with null). */
  set(button) {
    if (this.current === button) return;
    this.current?.setFocused?.(false);
    this.current = button ?? null;
    this.screen = button ? this.ui.screenOf(button.entity) : null;
    this.current?.setFocused?.(true);
    this.ui.engine.emit("ui-focus-changed", this.current?.entity ?? null);
  }

  clear() {
    this.set(null);
    this.heldDir = null;
    this.holdTime = 0;
  }

  /** Every interactable button on `screen`, with its laid-out rect. */
  candidates(screen) {
    const out = [];
    const seen = new Set();
    for (const item of screen?.hitList ?? []) {
      const button = item.entity.getComponent?.("uibutton");
      if (!button || button.props.interactable === false) continue;
      if (seen.has(button)) continue;
      // A button with no element has no rect to navigate by.
      if (!item.rect) continue;
      seen.add(button);
      out.push({ button, rect: item.rect });
    }
    return out;
  }

  /** The screen focus should start on: the topmost one that has buttons. */
  #defaultScreen() {
    const screens = [...this.ui.screens]
      .filter((s) => s.entity?.object3D.visible !== false)
      .sort((a, b) => (b.props.sortOrder ?? 0) - (a.props.sortOrder ?? 0));
    for (const screen of screens) {
      if (this.candidates(screen).length) return screen;
    }
    return null;
  }

  #resolveOverride(button, dir) {
    const key = OVERRIDE_KEYS[`${dir.x},${dir.y}`];
    const id = key ? button.props[key] : null;
    if (!id) return undefined; // no override authored
    const entity = this.ui.engine.getEntity?.(id);
    const target = entity?.getComponent?.("uibutton");
    // An override naming a missing or non-interactable entity means "stop
    // here", not "fall back to geometry": someone deliberately drew the edge
    // of the menu, and silently jumping somewhere else is worse than a
    // dead end they will notice.
    return target && target.props.interactable !== false ? target : null;
  }

  move(dir) {
    if (!dir) return;
    if (!this.current) {
      const screen = this.#defaultScreen();
      const first = this.candidates(screen)[0];
      if (first) this.set(first.button);
      return;
    }
    const override = this.#resolveOverride(this.current, dir);
    if (override !== undefined) {
      if (override) this.set(override);
      return;
    }
    const screen = this.screen ?? this.ui.screenOf(this.current.entity);
    const rect = this.current.entity.getComponent?.("uielement")?.rect;
    if (!rect) return;
    const pool = this.candidates(screen).filter((c) => c.button !== this.current);
    const next = pickNeighbour(rect, pool, dir);
    if (next) this.set(next.button);
  }

  update() {
    const engine = this.ui.engine;
    if (!engine.playing) return;
    const input = engine.input;
    if (!input) return;

    // Wall-clock, not game time: a pause menu is exactly where focus
    // navigation matters most, and game time is zero there.
    const dt = engine.unscaledDeltaTime ?? engine.deltaTime ?? 0;

    const nav = input.readValue?.("Navigate");
    const dir = nav ? toDirection(nav.x ?? 0, nav.y ?? 0) : null;
    const same = dir && this.heldDir && dir.x === this.heldDir.x && dir.y === this.heldDir.y;
    if (!dir) {
      this.heldDir = null;
      this.holdTime = 0;
    } else if (!same) {
      this.heldDir = dir;
      this.holdTime = 0;
      this.repeatIn = REPEAT_DELAY;
      this.move(dir);
    } else {
      this.holdTime += dt;
      this.repeatIn -= dt;
      if (this.repeatIn <= 0) {
        this.repeatIn = REPEAT_RATE;
        this.move(dir);
      }
    }

    if (input.wasPressedThisFrame?.("Submit")) {
      if (!this.current) this.move({ x: 0, y: 1 });
      else this.current.click();
    }
    if (input.wasPressedThisFrame?.("Cancel")) {
      engine.emit("ui-cancel", this.current?.entity ?? null);
      this.current?.entity.getComponent?.("script")?.dispatch?.("onCancel");
    }

    // A focused button that stopped being interactable (or was destroyed)
    // must not keep the highlight — the player would press Submit on nothing.
    if (this.current && (!this.current.entity?.engine || this.current.props.interactable === false)) {
      this.clear();
    }
  }
}
