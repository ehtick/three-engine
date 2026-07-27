import { useEffect, useState } from "react";
import { Clipboard, ClipboardPaste, LayoutTemplate, Redo2, Scissors, TextCursorInput, Undo2 } from "lucide-react";
import { ContextMenu, isTextEditTarget } from "./ContextMenu.jsx";
import { commandBus, useHistoryStore } from "./commands/CommandBus.js";
import { resetLayout } from "./EditorShell.jsx";

/**
 * Catch-all so the browser's own context menu never appears in the editor.
 *
 * Panels that have something specific to offer call `event.preventDefault()`
 * (via `useContextMenu`) and are left alone — this listener runs on `window`,
 * i.e. after React's root-container handlers, so a handled event arrives here
 * already `defaultPrevented`. Everything else gets a small generic menu rather
 * than the browser's "Reload / View source / Inspect", which is never the right
 * answer inside an editor.
 *
 * Text fields get real edit commands. The webview's own menu would have
 * provided those, so suppressing it without a replacement would be a
 * regression — right-clicking a name field to paste into it is a real workflow.
 */

/** Write `value` into a React-controlled input so React sees the change. */
function setInputValue(el, value) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

const selectionOf = (el) => String(el.value ?? "").slice(el.selectionStart ?? 0, el.selectionEnd ?? 0);

function replaceSelection(el, text) {
  const value = String(el.value ?? "");
  const start = el.selectionStart ?? value.length;
  const end = el.selectionEnd ?? value.length;
  setInputValue(el, value.slice(0, start) + text + value.slice(end));
  const caret = start + text.length;
  requestAnimationFrame(() => el.setSelectionRange?.(caret, caret));
}

function textItems(el) {
  if (el.isContentEditable) {
    return [
      { label: "Cut", shortcut: "Ctrl+X", icon: Scissors, action: () => document.execCommand("cut") },
      { label: "Copy", shortcut: "Ctrl+C", icon: Clipboard, action: () => document.execCommand("copy") },
      { label: "Paste", shortcut: "Ctrl+V", icon: ClipboardPaste, action: () => document.execCommand("paste") },
      { separator: true },
      { label: "Select All", shortcut: "Ctrl+A", icon: TextCursorInput, action: () => document.execCommand("selectAll") },
    ];
  }
  const hasSelection = (el.selectionEnd ?? 0) > (el.selectionStart ?? 0);
  const readOnly = el.readOnly || el.disabled;
  return [
    {
      label: "Cut",
      shortcut: "Ctrl+X",
      icon: Scissors,
      disabled: !hasSelection || readOnly,
      action: async () => {
        await navigator.clipboard.writeText(selectionOf(el)).catch(() => {});
        replaceSelection(el, "");
      },
    },
    {
      label: "Copy",
      shortcut: "Ctrl+C",
      icon: Clipboard,
      disabled: !hasSelection,
      action: () => navigator.clipboard.writeText(selectionOf(el)).catch(() => {}),
    },
    {
      label: "Paste",
      shortcut: "Ctrl+V",
      icon: ClipboardPaste,
      disabled: readOnly,
      action: async () => {
        try {
          replaceSelection(el, await navigator.clipboard.readText());
        } catch (err) {
          console.warn(`Paste failed: ${err.message ?? err}`);
        }
      },
    },
    { separator: true },
    {
      label: "Select All",
      shortcut: "Ctrl+A",
      icon: TextCursorInput,
      action: () => el.select?.(),
    },
  ];
}

function genericItems() {
  const { canUndo, canRedo, undoLabel, redoLabel } = useHistoryStore.getState();
  return [
    {
      label: undoLabel ? `Undo ${undoLabel}` : "Undo",
      shortcut: "Ctrl+Z",
      icon: Undo2,
      disabled: !canUndo,
      action: () => commandBus.undo(),
    },
    {
      label: redoLabel ? `Redo ${redoLabel}` : "Redo",
      shortcut: "Ctrl+Y",
      icon: Redo2,
      disabled: !canRedo,
      action: () => commandBus.redo(),
    },
    { separator: true },
    { label: "Reset Panel Layout", icon: LayoutTemplate, action: resetLayout },
  ];
}

/**
 * Mounted once by EditorChrome. Owns the window-level `contextmenu` listener
 * and renders whichever fallback menu the click deserves.
 */
export function GlobalContextMenu() {
  const [menu, setMenu] = useState(null);

  useEffect(() => {
    const onContextMenu = (event) => {
      // A panel already answered this click with its own menu.
      if (event.defaultPrevented) return;
      event.preventDefault();
      const target = event.target;
      setMenu({
        x: event.clientX,
        y: event.clientY,
        items: isTextEditTarget(target) ? textItems(target) : genericItems(),
      });
    };
    window.addEventListener("contextmenu", onContextMenu);
    return () => window.removeEventListener("contextmenu", onContextMenu);
  }, []);

  if (!menu) return null;
  return <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />;
}
