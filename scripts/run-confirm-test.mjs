/**
 * The destructive-confirmation dialog (`components/ConfirmDialog.jsx`).
 *
 *   node scripts/run-confirm-test.mjs
 *
 * Source-level, because the component needs React and a DOM. That is a real
 * limit and worth naming: what is gated here is the SHAPE of the thing — the
 * handful of decisions that, when wrong, either delete files the user did not
 * agree to delete or dismiss the question before it can be read.
 *
 * The old implementation asked through the OS message box and had no test at
 * all, which is how it shipped a confirmation that dismissed itself. These are
 * the properties that replacement has to keep.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (relative) =>
  readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), "utf8");

let failures = 0;
let checks = 0;
const check = (name, fn) => {
  checks++;
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${error.message.split("\n")[0]}`);
  }
};

const dialog = read("src/editor/components/ConfirmDialog.jsx");
const assetOps = read("src/editor/assetOps.js");
const shell = read("src/editor/EditorShell.jsx");
const css = read("src/editor/theme.css");

/**
 * Source with comments stripped.
 *
 * Needed because these checks assert the ABSENCE of things, and the comment
 * explaining why `window.confirm` was removed contains the string
 * `window.confirm` — so a naive search finds the tombstone and calls it a body.
 */
const code = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

/**
 * A top-level function's source, from its `export` to the next top-level
 * declaration.
 *
 * Not `[\s\S]*?\n\}`: a function whose parameters are a destructured object
 * closes that object with `\n} = {}) {`, and the lazy match ends there — giving
 * back the signature and none of the body, so every assertion about the body
 * fails for a reason that has nothing to do with the body.
 */
const bodyOf = (source, name) => {
  const start = source.indexOf(`function ${name}`);
  assert.ok(start >= 0, `${name} not found`);
  const rest = source.slice(start + 1);
  const end = rest.search(/\n(?:export |const |function |\/\*\*)/);
  return rest.slice(0, end === -1 ? undefined : end);
};

// ---------------------------------------------------------------------------
console.log("\nconfirm — the dialog cannot be dismissed by what opened it");
// ---------------------------------------------------------------------------

check("the backdrop closes on click, never on pointerdown", () => {
  // THE bug. A menu item's `click` fires on pointerup; a backdrop listening on
  // `pointerdown` would be armed in time to eat the tail of the very gesture
  // that opened the dialog, which is indistinguishable from "it vanished".
  assert.ok(/onClick=\{\(event\) =>/.test(dialog), "backdrop should handle click");
  assert.ok(
    !/onPointerDown/.test(dialog),
    "a pointerdown dismissal reintroduces the self-closing dialog",
  );
});

check("a mount guard blocks any dismissal in the opening frame", () => {
  assert.ok(/armedRef/.test(dialog), "no arming guard");
  assert.ok(
    /requestAnimationFrame\(\(\) => \{\s*armedRef\.current = true;/.test(dialog),
    "arming must wait a frame, not a microtask — a slow pointerup outlives setTimeout(0)",
  );
  assert.ok(/&& armedRef\.current\) settle\(false\)/.test(dialog), "backdrop ignores the guard");
});

check("only the backdrop itself dismisses, not a click inside the dialog", () => {
  assert.ok(
    /event\.target === event\.currentTarget/.test(dialog),
    "a click on the dialog body would bubble to the backdrop and cancel",
  );
});

// ---------------------------------------------------------------------------
console.log("\nconfirm — a stray keystroke must not delete anything");
// ---------------------------------------------------------------------------

check("focus lands on Cancel, not on the destructive button", () => {
  assert.ok(/cancelRef\.current\?\.focus\(\)/.test(dialog), "Cancel is not focused");
  assert.ok(
    !/confirmRef\.current\?\.focus\(\)/.test(dialog),
    "focusing the destructive button makes Enter a delete",
  );
});

check("Enter only confirms when the destructive button actually has focus", () => {
  assert.ok(
    /dataset\?\.confirmAction === "confirm"/.test(dialog),
    "Enter must check what is focused, or it deletes from anywhere in the dialog",
  );
});

check("Escape cancels, and is taken in the capture phase", () => {
  assert.ok(/"Escape"/.test(dialog), "no Escape handling");
  assert.ok(
    /window\.addEventListener\("keydown", onKey, true\)/.test(dialog),
    "must capture — a panel's own Escape handler would otherwise act on it too",
  );
});

check("focus is trapped between the two buttons", () => {
  // A modal you can Tab out of is a modal that can be answered by a keystroke
  // aimed at the panel behind it.
  assert.ok(/"Tab"/.test(dialog), "no focus trap");
});

// ---------------------------------------------------------------------------
console.log("\nconfirm — failure modes default to not deleting");
// ---------------------------------------------------------------------------

check("no mounted host answers false, not true", () => {
  const fn = bodyOf(dialog, "confirmDestructive");
  assert.ok(
    /if \(!notify\)[\s\S]*?resolve\(false\)/.test(fn),
    "a destructive action whose dialog cannot be shown must not proceed",
  );
});

check("a second request while one is open answers false rather than stacking", () => {
  const fn = bodyOf(dialog, "confirmDestructive");
  assert.ok(/if \(pending\) return Promise\.resolve\(false\)/.test(fn), "no re-entrancy guard");
});

check("settling always clears the pending request before resolving", () => {
  // Resolving first would let a `.then` handler open a second dialog that the
  // stale `pending` then rejects.
  const fn = dialog.match(/const settle = [\s\S]*?\n\};/)[0];
  const clearAt = fn.indexOf("pending = null");
  const resolveAt = fn.indexOf("request?.resolve");
  assert.ok(clearAt > 0 && resolveAt > 0 && clearAt < resolveAt, "clear before resolve");
});

// ---------------------------------------------------------------------------
console.log("\nconfirm — wiring");
// ---------------------------------------------------------------------------

check("the host is mounted, and not behind Suspense", () => {
  assert.ok(/<ConfirmDialogHost \/>/.test(shell), "host is never mounted");
  assert.ok(
    /import \{ ConfirmDialogHost \} from "\.\/components\/ConfirmDialog\.jsx";/.test(shell),
    "must be a static import — a lazy host that arrives late refuses a real delete",
  );
});

check("asset deletion asks through it, and no longer through the OS", () => {
  const src = code(assetOps);
  assert.ok(/confirmDestructive\(\{/.test(src), "deleteEntries does not confirm");
  assert.ok(
    !/@tauri-apps\/plugin-dialog/.test(src),
    "the native dialog was the thing dismissing itself",
  );
  assert.ok(
    !/window\.confirm/.test(src),
    "window.confirm blocks the main thread and stops the render loop",
  );
});

check("the delete still bails out when the answer is no", () => {
  const fn = assetOps.match(/export async function deleteEntries[\s\S]*?\n\}/)[0];
  const askAt = fn.indexOf("confirmDestructive");
  const bailAt = fn.indexOf("if (!ok) return;");
  const deleteAt = fn.indexOf('invoke("delete_path"');
  assert.ok(askAt > 0 && bailAt > askAt, "no bail-out after asking");
  assert.ok(deleteAt > bailAt, "files are deleted before the answer is checked");
});

check("a multi-delete names what it is about to destroy", () => {
  assert.ok(/items: list\.length > 1 \? list\.map/.test(assetOps), "no item list for multi-select");
  assert.ok(/const shown = request\.items\.slice\(0, 8\)/.test(dialog), "unbounded list");
  assert.ok(/and \{extra\} more/.test(dialog), "truncation is silent — it must say how many");
});

check("the dialog outranks the context menu that opens it", () => {
  const menuZ = Number(css.match(/\.dropdown-overlay[^}]*z-index:\s*(\d+)/)?.[1] ?? 0);
  const confirmZ = Number(css.match(/\.confirm-backdrop \{ z-index: (\d+); \}/)?.[1] ?? 0);
  assert.ok(confirmZ > 0, "no z-index on the confirm backdrop");
  assert.ok(confirmZ > menuZ, `confirm (${confirmZ}) must sit above the menu overlay (${menuZ})`);
});

// ---------------------------------------------------------------------------
console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} FAILED`);
  process.exit(1);
}
