import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * The editor's confirmation for destructive actions, in the DOM.
 *
 * ## Why this replaced the native dialog
 *
 * Asset deletion used to ask through `@tauri-apps/plugin-dialog`'s `confirm()`,
 * which opens an OS message box, with `window.confirm()` as a fallback. Both
 * were reported appearing and vanishing on their own — the box flashed up,
 * dismissed itself, and `confirm()` resolved `false`, so the delete silently did
 * nothing and logged nothing. Nothing in the JS could be shown to cause it: the
 * plugin was permitted (`dialog:default`), it never threw, and the editor had
 * not reloaded. The dismissal was happening below us, in the OS modal.
 *
 * A DOM dialog removes the question. It also fixes three things that were
 * wrong with the native one independently of the bug:
 *
 *   - `window.confirm()` **blocks the main thread**, which in an engine editor
 *     means the render loop stops dead while the box is up. A modal that
 *     freezes the viewport it is asking about is the wrong tool.
 *   - A native box can only show a sentence. Deleting eleven things should show
 *     you the eleven things; this lists them.
 *   - It could not be tested headlessly, so the one confirmation guarding the
 *     only unrecoverable operation in the asset pipeline had no coverage.
 *
 * ## Two rules that make a destructive dialog safe
 *
 * **Cancel takes focus, not the destructive button.** A stray Enter — from the
 * keystroke that opened the dialog, from muscle memory — must not delete the
 * user's files. Enter still confirms if you mean it; you have to Tab there.
 *
 * **A dialog cannot be dismissed by the interaction that opened it.** That is
 * the precise failure being fixed, and it is easy to reintroduce: a backdrop
 * that closes on `pointerdown` will eat the `pointerup`/`click` of the menu
 * item that opened it. The backdrop here closes on `click` only, and a mount
 * guard ignores anything arriving in the same tick.
 */

/** The single live request, if any. Set by `confirmDestructive`. */
let pending = null;
let notify = null;

/**
 * Asks the user to confirm a destructive action. Resolves `true` to proceed.
 *
 * Imperative rather than a hook because the callers are plain modules —
 * `assetOps.js` is not a component and should not become one to ask a question.
 *
 *     if (!(await confirmDestructive({
 *       title: "Delete asset",
 *       message: `Delete "${name}"? This can't be undone.`,
 *       items: paths,
 *     }))) return;
 *
 * Resolves `false` when no host is mounted, which is the safe answer: a
 * destructive action whose confirmation cannot be shown must not proceed.
 */
export function confirmDestructive({
  title = "Are you sure?",
  message = "",
  items = [],
  confirmLabel = "Delete",
  cancelLabel = "Cancel",
} = {}) {
  if (!notify) {
    console.warn("No confirmation host is mounted — refusing the destructive action.");
    return Promise.resolve(false);
  }
  // One at a time. A second request while one is open answers `false` rather
  // than stacking dialogs or silently replacing the first one's promise.
  if (pending) return Promise.resolve(false);
  return new Promise((resolve) => {
    pending = { title, message, items, confirmLabel, cancelLabel, resolve };
    notify(pending);
  });
}

const settle = (answer) => {
  const request = pending;
  pending = null;
  notify?.(null);
  request?.resolve(answer);
};

/**
 * Mounted once, near the root. Renders whatever `confirmDestructive` asked for.
 */
export function ConfirmDialogHost() {
  const [request, setRequest] = useState(null);
  const cancelRef = useRef(null);
  // Set for the tick in which the dialog appears; see the backdrop handler.
  const armedRef = useRef(false);

  useEffect(() => {
    notify = setRequest;
    return () => {
      notify = null;
    };
  }, []);

  useEffect(() => {
    if (!request) return undefined;
    armedRef.current = false;
    // One frame, not one microtask: the click that opened this is still
    // propagating, and a `setTimeout(0)` would already be armed by the time a
    // slow pointerup lands.
    const raf = requestAnimationFrame(() => {
      armedRef.current = true;
      // Focus the SAFE button. Deliberately after the arming frame so the
      // keystroke that opened the dialog cannot land on it either.
      cancelRef.current?.focus();
    });
    const onKey = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        settle(false);
      } else if (event.key === "Enter" && armedRef.current) {
        // Only when the destructive button actually has focus — see the header.
        if (document.activeElement?.dataset?.confirmAction === "confirm") {
          event.preventDefault();
          event.stopPropagation();
          settle(true);
        }
      } else if (event.key === "Tab") {
        // Keep focus inside: a modal you can Tab out of is a modal that can be
        // answered by a keystroke aimed at the panel behind it.
        const buttons = [cancelRef.current, cancelRef.current?.nextElementSibling].filter(Boolean);
        if (buttons.length === 2) {
          event.preventDefault();
          const next = document.activeElement === buttons[0] ? buttons[1] : buttons[0];
          next.focus();
        }
      }
    };
    // Capture phase, so a panel's own Escape/Enter handler does not act on the
    // keystroke meant for this dialog.
    window.addEventListener("keydown", onKey, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [request]);

  if (!request) return null;

  const shown = request.items.slice(0, 8);
  const extra = request.items.length - shown.length;

  return createPortal(
    <div
      className="texture-dialog-backdrop confirm-backdrop"
      // `click`, never `pointerdown`: the menu item that opened this dialog has
      // not delivered its own pointerup yet, and a pointerdown handler here
      // would answer the question with the tail of the gesture that asked it.
      onClick={(event) => {
        if (event.target === event.currentTarget && armedRef.current) settle(false);
      }}
    >
      <div className="texture-dialog confirm-dialog" role="alertdialog" aria-modal="true">
        <h3>{request.title}</h3>
        {request.message && <p className="texture-dialog-note">{request.message}</p>}
        {shown.length > 0 && (
          <ul className="confirm-items">
            {shown.map((item) => (
              <li key={item}>{item}</li>
            ))}
            {extra > 0 && <li className="confirm-items-more">and {extra} more…</li>}
          </ul>
        )}
        <div className="confirm-actions">
          <button
            ref={cancelRef}
            type="button"
            className="toolbar-btn"
            data-confirm-action="cancel"
            onClick={() => settle(false)}
          >
            {request.cancelLabel}
          </button>
          <button
            type="button"
            className="toolbar-btn danger"
            data-confirm-action="confirm"
            onClick={() => settle(true)}
          >
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Test seam: whether a request is currently open. */
export const isConfirmOpen = () => pending !== null;
