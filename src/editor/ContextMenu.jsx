import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * The editor's one right-click menu.
 *
 * Every panel used to hand-roll this (`<div className="dropdown-menu
 * context-menu" style={{left, top}}>` plus its own overlay), which meant three
 * slightly different implementations and a menu that ran off the bottom of the
 * screen whenever you right-clicked near it. This owns the shared behaviour:
 * a portal so no scrolling ancestor can clip it, measurement + clamping so it
 * always lands fully on screen, Escape to dismiss, and one item schema.
 *
 * Items are `{ label, shortcut, hint, icon, disabled, danger, action }`, or
 * `{ separator: true }`, or `{ header: "Text" }`. Falsy entries are skipped so
 * callers can splice with `cond && {…}`.
 */

const MARGIN = 6;

export function ContextMenu({ x, y, items, onClose }) {
  const menuRef = useRef(null);
  const [pos, setPos] = useState(null);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    // Prefer opening down-right of the cursor (what every OS does); flip back
    // over the cursor when that would overhang, then clamp as a last resort so
    // a menu taller than the window still starts at the top edge.
    const left = x + width > window.innerWidth - MARGIN ? Math.max(MARGIN, x - width) : x;
    const top = y + height > window.innerHeight - MARGIN ? Math.max(MARGIN, y - height) : y;
    setPos({ left, top });
  }, [x, y, items]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const visible = (items ?? []).filter(Boolean);

  return createPortal(
    <>
      <div
        className="dropdown-overlay"
        onPointerDown={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div
        ref={menuRef}
        className="dropdown-menu context-menu"
        style={{
          left: pos?.left ?? x,
          top: pos?.top ?? y,
          visibility: pos ? "visible" : "hidden",
        }}
      >
        {visible.map((item, i) => {
          if (item.separator) return <div key={`sep-${i}`} className="menu-separator" />;
          if (item.header) {
            return (
              <div key={`head-${i}`} className="dropdown-section-label">
                {item.header}
              </div>
            );
          }
          const Icon = item.icon;
          return (
            <button
              key={item.label}
              className={`dropdown-item${item.danger ? " danger" : ""}`}
              disabled={item.disabled}
              title={item.hint}
              onClick={() => {
                onClose();
                item.action?.();
              }}
            >
              <span className="menu-item-label">
                {Icon && <Icon size={13} className="menu-item-icon" />}
                {item.label}
              </span>
              {item.shortcut && <span className="menu-shortcut">{item.shortcut}</span>}
            </button>
          );
        })}
      </div>
    </>,
    document.body,
  );
}

/**
 * Right-clicking inside a text field means "cut / copy / paste", never "act on
 * the panel this field happens to sit in". Container-level menus check this and
 * let the event through to the global fallback, which offers the edit commands.
 */
export const isTextEditTarget = (el) =>
  el instanceof HTMLTextAreaElement ||
  (el instanceof HTMLInputElement && !["checkbox", "radio", "color", "range", "button"].includes(el.type)) ||
  (el instanceof HTMLElement && el.isContentEditable);

/**
 * State + handler for one context menu. `open(event, payload)` swallows the
 * native menu and records the cursor position alongside whatever the caller
 * needs to know about the thing that was right-clicked.
 */
export function useContextMenu() {
  const [menu, setMenu] = useState(null);
  const open = useCallback((event, payload = {}) => {
    if (isTextEditTarget(event.target)) return;
    event.preventDefault();
    // Without this a container further up (and the window-level fallback in
    // nativeContextMenu.jsx) would also fire and replace this menu.
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, ...payload });
  }, []);
  const close = useCallback(() => setMenu(null), []);
  return { menu, open, close };
}
