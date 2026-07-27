import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * A dropdown body rendered into `<body>` and positioned against the viewport,
 * instead of being absolutely positioned inside the trigger's `.dropdown-wrap`.
 *
 * Why: the inspector (and every other side panel) scrolls vertically, and CSS
 * makes `overflow-y: auto` imply `overflow-x: auto`. An in-flow menu wider than
 * the panel therefore grows the panel's scroll width and shoves the whole
 * layout sideways — the "opening a dropdown pushes the page across and hides
 * part of it" bug. A fixed portal contributes to nobody's scroll extent, so it
 * can overhang the panel, flip above the trigger when there is no room below,
 * and stay clamped inside the window.
 *
 * `minWidth` is the menu's own preferred width; the anchor's width is used when
 * it is larger, so a full-width field never gets a menu narrower than itself.
 */

const MARGIN = 8; // keep-off distance from the window edges
const GAP = 4; // trigger ↔ menu gap, matches the old `top: calc(100% + 4px)`

export function PopoverMenu({ anchorRef, className = "", align = "left", minWidth = 0, onClose, children }) {
  const menuRef = useRef(null);
  const [pos, setPos] = useState(null);

  useLayoutEffect(() => {
    const place = () => {
      const anchor = anchorRef?.current;
      const menu = menuRef.current;
      if (!anchor || !menu) return;
      const rect = anchor.getBoundingClientRect();
      const width = Math.max(menu.offsetWidth, minWidth, rect.width);
      const height = menu.offsetHeight;

      let left = align === "right" ? rect.right - width : rect.left;
      left = Math.max(MARGIN, Math.min(left, window.innerWidth - width - MARGIN));

      // Flip above only when below genuinely doesn't fit AND above fits better;
      // otherwise stay below and let the clamp below slide it up.
      const below = window.innerHeight - rect.bottom - GAP - MARGIN;
      const above = rect.top - GAP - MARGIN;
      const top =
        height > below && above > below
          ? Math.max(MARGIN, rect.top - GAP - height)
          : Math.max(MARGIN, Math.min(rect.bottom + GAP, window.innerHeight - height - MARGIN));

      setPos({ left, top, minWidth: Math.max(minWidth, rect.width) });
    };

    place();
    // The menu's height changes as its list is filtered, and the anchor moves
    // whenever an ancestor panel scrolls — capture-phase so panel scrolls (not
    // just window scrolls) are seen.
    const observer = new ResizeObserver(place);
    if (menuRef.current) observer.observe(menuRef.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchorRef, align, minWidth]);

  return createPortal(
    <>
      <div className="dropdown-overlay" onPointerDown={onClose} />
      <div
        ref={menuRef}
        className={`dropdown-menu portal-menu ${className}`.trim()}
        style={{
          left: pos?.left ?? 0,
          top: pos?.top ?? 0,
          minWidth: pos?.minWidth || undefined,
          // Hidden for the single frame between mount and measurement, so the
          // menu never flashes at the top-left of the screen.
          visibility: pos ? "visible" : "hidden",
        }}
      >
        {children}
      </div>
    </>,
    document.body,
  );
}
