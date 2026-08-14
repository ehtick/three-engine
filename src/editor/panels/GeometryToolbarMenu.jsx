import { createContext, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";

/**
 * The geometry editor's header menus.
 *
 * These were plain `<details>` elements with a `position: fixed` popover, which
 * broke in two ways that this component exists to fix:
 *
 *   * `.geometry-editor-toolbar` carries `backdrop-filter`, and a filtered
 *     element is a CONTAINING BLOCK for its fixed-position descendants. The
 *     viewport coordinates the panel measured were therefore re-interpreted as
 *     offsets from the toolbar, and every popover landed a few hundred pixels
 *     down and to the right of its button. Portalling to `<body>` takes the
 *     popover out from under any such ancestor — and the placement below still
 *     subtracts the measured origin, so a filter on `<body>` could not bring
 *     the bug back either.
 *   * `<details>` has no notion of a menu bar, so opening one never closed the
 *     others and the header ended up with six overlapping popovers. One `openId`
 *     for the whole bar is the fix, which also buys the rest of the menu-bar
 *     grammar every desktop app has: hovering a sibling while a menu is open
 *     switches to it, Escape and an outside click close.
 */

const ToolbarMenuContext = createContext(null);

/**
 * Wraps the header. Controlled, so the panel that owns the action handlers can
 * close the open menu after one of them runs without having to reach into a
 * context it is itself providing.
 */
export function ToolbarMenuProvider({ openId, onOpenChange, children }) {
  const value = useMemo(() => ({
    openId,
    open: (id) => onOpenChange(id),
    close: () => onOpenChange(null),
    toggle: (id) => onOpenChange(openId === id ? null : id),
  }), [openId, onOpenChange]);
  return <ToolbarMenuContext.Provider value={value}>{children}</ToolbarMenuContext.Provider>;
}

/**
 * Places `popover` under `summary` in viewport coordinates, flipping above and
 * clamping sideways rather than running off-screen.
 */
function place(summary, popover) {
  const anchor = summary.getBoundingClientRect();
  // Measured at the origin first: reading a size while the element still
  // carries the previous open's coordinates can push it off-screen and shrink
  // it against the viewport edge. The rect this returns also *is* the origin of
  // whatever containing block the popover ended up in, so subtracting it makes
  // the coordinates below viewport-absolute whatever the ancestors do.
  popover.style.left = "0px";
  popover.style.top = "0px";
  popover.style.maxHeight = "";
  const box = popover.getBoundingClientRect();
  const margin = 6;
  const below = window.innerHeight - anchor.bottom - margin * 2;
  const above = anchor.top - margin * 2;
  // Blender drops its header menus downwards and only flips when there is
  // genuinely more room the other way.
  const flip = box.height > below && above > below;
  const height = Math.min(box.height, Math.max(flip ? above : below, 120));
  popover.style.maxHeight = `${height}px`;
  const left = Math.max(margin, Math.min(anchor.left, window.innerWidth - box.width - margin));
  const top = flip ? Math.max(margin, anchor.top - height - margin) : anchor.bottom + margin;
  popover.style.left = `${left - box.left}px`;
  popover.style.top = `${top - box.top}px`;
}

/**
 * One header menu. `children` are the popover's contents; they render into a
 * portal on `<body>`, so nothing in the header's overflow or filter chain can
 * clip or displace them.
 */
export function ToolbarMenu({ label, title, popoverClassName = "", disabled = false, children }) {
  const menus = useContext(ToolbarMenuContext);
  const id = useId();
  const open = menus?.openId === id;
  const summaryRef = useRef(null);
  const popoverRef = useRef(null);

  useLayoutEffect(() => {
    const summary = summaryRef.current;
    const popover = popoverRef.current;
    if (!open || !summary || !popover) return undefined;
    const reposition = () => place(summary, popover);
    reposition();
    // The header scrolls sideways under the menu, and the popover's own height
    // changes as its contents do (a mode switch swaps half the entries out).
    const observer = new ResizeObserver(reposition);
    observer.observe(popover);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open, children]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (popoverRef.current?.contains(event.target)) return;
      if (summaryRef.current?.contains(event.target)) return;
      // A field inside the menu can open its own portalled dropdown — the
      // material slot picker does. That portal lives on <body>, outside the
      // popover's subtree, so without this a click anywhere in the picker (or
      // on its dismiss overlay) closed the menu it was opened from and
      // unmounted the picker mid-choice.
      if (event.target.closest?.(".portal-menu, .dropdown-overlay, .context-menu")) return;
      menus.close();
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        menus.close();
      }
    };
    // Capture, so a click that the viewport would otherwise swallow still
    // dismisses the menu.
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, menus]);

  return (
    <div className={`geometry-toolbar-menu ${open ? "open" : ""}`}>
      <button
        type="button"
        ref={summaryRef}
        className="geometry-toolbar-menu-summary"
        title={title}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        // Opening a menu must not take keyboard focus. The panel's keymap is
        // bound to the editor root, so focus landing on a header button — or
        // worse, falling back to <body> when the next click lands on the
        // canvas — silently kills every shortcut until the viewport is clicked
        // again. Blender's menus never move focus; neither do these.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => menus.toggle(id)}
        // Menu-bar grammar: once one is open, sliding across the header moves
        // the open menu with the pointer instead of needing a second click.
        onPointerEnter={() => { if (menus.openId && !open && !disabled) menus.open(id); }}
      >
        {label}
      </button>
      {open && createPortal(
        <div
          ref={popoverRef}
          className={`geometry-toolbar-popover ${popoverClassName}`}
          role="menu"
          // Same reason as the summary: clicking an entry must not pull focus
          // out of the viewport. The fields inside a menu still need it.
          onMouseDown={(event) => { if (!event.target.closest("input, textarea, select")) event.preventDefault(); }}
          onContextMenu={(event) => event.stopPropagation()}
        >
          {children}
        </div>,
        document.body,
      )}
    </div>
  );
}
