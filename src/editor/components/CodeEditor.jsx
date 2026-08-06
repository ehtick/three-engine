// @ts-nocheck
import { useEffect, useRef, useState, useCallback } from "react";
import { Save, ExternalLink, RotateCcw, WrapText, Braces, Command } from "lucide-react";
import { loadMonaco, getModel, ensureThreeTypes, languageForPath } from "../code/monaco.js";
import { useProjectStore } from "../store/projectStore.js";
import { openInIDE } from "../openInIde.js";

async function invoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

/**
 * Vim mode is a preference, not a per-editor setting: someone who wants modal
 * editing wants it in every pane, and having to re-enable it after opening a
 * second file would make the feature worse than not having it. Stored in
 * localStorage rather than project settings for the same reason — it describes
 * the person, not the project.
 */
const VIM_KEY = "engine.code.vim.v1";
const readVimPref = () => {
  try {
    return localStorage.getItem(VIM_KEY) === "1";
  } catch {
    return false;
  }
};

/**
 * How short and how tall a resizable editor may be dragged.
 *
 * The floor is not arbitrary: below about six visible lines Monaco's suggestion
 * popup has nowhere to open and reflows the moment you type, which is worse
 * than the pane being a little too tall. The ceiling stops a drag that leaves
 * the window from making a pane taller than any screen it will be read on.
 */
const MIN_HEIGHT = 120;
const MAX_HEIGHT = 1400;

const clampHeight = (value) => Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(value)));

/** Remembered height for a resizable editor, or its default. */
function readHeight(storageKey, fallback) {
  const initial = typeof fallback === "number" ? fallback : 320;
  if (!storageKey) return initial;
  try {
    const stored = Number(localStorage.getItem(`engine.code.height.${storageKey}`));
    return Number.isFinite(stored) && stored > 0 ? clampHeight(stored) : initial;
  } catch {
    return initial;
  }
}

/**
 * A file, open and editable, inside the editor.
 *
 * Used in two places with the same code: the Asset Inspector embeds a short
 * one for the selected script, and the Code panel gives it the whole pane.
 * They share the underlying Monaco *model* (see `code/monaco.js`), so the two
 * are the same document — typing in the Inspector and then switching to the
 * Code panel shows the same unsaved text, with the same undo history, and one
 * save covers both.
 *
 * ## Saving
 *
 * Explicit, on ⌘/Ctrl+S or the button, and on unmount if the buffer is dirty.
 * Not on every keystroke: script files are watched for hot reload, so an
 * autosave would recompile the user's game on a half-typed identifier, several
 * times a second, and fill the console with errors about code they are still
 * in the middle of writing.
 *
 * ## Files changing underneath
 *
 * The same file can be rewritten by an import, an AI action, or the user's own
 * IDE. On regaining focus this re-reads from disk and adopts the new contents
 * *only when the buffer is clean* — a dirty buffer means unsaved user work,
 * and silently replacing that is the one unforgivable thing a text editor can
 * do. When both changed, it says so and leaves the choice alone.
 */
export function CodeEditor({
  path,
  height = "100%",
  minimap = false,
  readOnly = false,
  compact = false,
  onDirtyChange,
  toolbar = true,
  resizable = false,
  storageKey = null,
}) {
  const hostRef = useRef(null);
  const rootRef = useRef(null);
  const editorRef = useRef(null);
  const modelRef = useRef(null);
  const savedRef = useRef(""); // last text known to match disk
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState(null);
  const [ready, setReady] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [vim, setVim] = useState(readVimPref);
  const vimStatusRef = useRef(null);
  const vimModeRef = useRef(null);
  const [boxHeight, setBoxHeight] = useState(() => (resizable ? readHeight(storageKey, height) : null));
  const projectRoot = useProjectStore((state) => state.rootPath);

  const markDirty = useCallback(
    (value) => {
      setDirty(value);
      onDirtyChange?.(value);
    },
    [onDirtyChange],
  );

  const save = useCallback(async () => {
    const model = modelRef.current;
    if (!model || readOnly) return false;
    const text = model.getValue();
    try {
      await invoke("save_scene", { path, contents: text });
      savedRef.current = text;
      markDirty(false);
      setStatus("Saved");
      setError(null);
      // The Assets grid shows size and modified date; a save that doesn't
      // move them looks like a save that didn't happen.
      useProjectStore.getState().refresh?.();
      return true;
    } catch (err) {
      setError(`Save failed: ${err?.message ?? err}`);
      return false;
    }
  }, [path, readOnly, markDirty]);

  // Keep the latest save in a ref so the unmount cleanup can call it without
  // re-running this effect (and re-creating the editor) on every render.
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    let disposed = false;
    let editor = null;
    let resizeObserver = null;
    let changeSub = null;
    setReady(false);
    setError(null);

    (async () => {
      let text = "";
      try {
        text = await invoke("read_text_file", { path });
      } catch (err) {
        if (!disposed) setError(`Couldn't read this file: ${err?.message ?? err}`);
        return;
      }
      const monaco = await loadMonaco();
      if (disposed) return;
      const model = await getModel(path, text);
      if (disposed) return;
      // A model that already existed may hold unsaved edits from another pane;
      // only adopt the disk text when they agree, so switching panels never
      // discards work.
      if (model.getValue() !== text && savedRef.current === "") {
        // First mount of this path in this session — the model is stale from a
        // previous open of the same file, so disk wins.
        if (!model.__engineDirty) model.setValue(text);
      }
      savedRef.current = text;
      modelRef.current = model;

      const host = hostRef.current;
      if (!host) return;
      editor = monaco.editor.create(host, {
        model,
        theme: "engine-dark",
        readOnly,
        automaticLayout: false, // handled by the ResizeObserver below
        fontSize: compact ? 11.5 : 13,
        lineHeight: compact ? 17 : 20,
        fontFamily:
          'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
        fontLigatures: true,
        minimap: { enabled: minimap },
        scrollBeyondLastLine: false,
        lineNumbersMinChars: compact ? 3 : 4,
        glyphMargin: false,
        folding: !compact,
        renderLineHighlight: "line",
        // The whole point of showing code in-app is that it reads the way it
        // does on disk — tabs the size the file expects, indent guides on,
        // nothing silently reformatted.
        detectIndentation: true,
        tabSize: 2,
        insertSpaces: true,
        renderWhitespace: "selection",
        guides: { indentation: true, bracketPairs: true },
        bracketPairColorization: { enabled: true },
        smoothScrolling: true,
        cursorBlinking: "smooth",
        padding: { top: compact ? 6 : 10, bottom: compact ? 6 : 40 },
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
        quickSuggestions: { other: true, comments: false, strings: false },
        suggestSelection: "first",
        tabCompletion: "on",
        wordWrap: "off",
        stickyScroll: { enabled: !compact },
        contextmenu: true,
      });
      editorRef.current = editor;

      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current());
      changeSub = model.onDidChangeContent(() => {
        const isDirty = model.getValue() !== savedRef.current;
        model.__engineDirty = isDirty;
        markDirty(isDirty);
        setStatus("");
      });

      resizeObserver = new ResizeObserver(() => editor?.layout());
      resizeObserver.observe(host);
      setReady(true);
    })().catch((err) => {
      if (!disposed) setError(String(err?.message ?? err));
    });

    return () => {
      disposed = true;
      // Unsaved work must not evaporate because a panel was closed. The model
      // survives (it is shared and cached), so this is belt-and-braces for the
      // case where nothing else will ever show this file again.
      if (modelRef.current?.__engineDirty) saveRef.current();
      changeSub?.dispose?.();
      resizeObserver?.disconnect();
      // Dispose the *editor*, never the model — the model is shared.
      editor?.dispose();
      editorRef.current = null;
    };
    // `compact`/`minimap`/`readOnly` are construction options; changing them
    // rebuilds the editor, which is correct and vanishingly rare.
  }, [path, readOnly, compact, minimap, markDirty]);

  /**
   * Attaches or detaches vim mode on the live editor.
   *
   * Separate from the editor's construction effect on purpose: toggling vim
   * must not tear down and rebuild the editor, which would lose the cursor
   * position, the scroll, the selection and the undo stack — a heavy price for
   * a keybinding change. `monaco-vim` attaches to an existing instance, so
   * this can be a pure side effect on the toggle.
   *
   * The dynamic import keeps it out of the bundle for everyone who never turns
   * it on, which is most people.
   */
  useEffect(() => {
    if (!ready) return undefined;
    let disposed = false;
    if (vim) {
      import("monaco-vim")
        .then(({ initVimMode }) => {
          if (disposed || !editorRef.current) return;
          vimModeRef.current = initVimMode(editorRef.current, vimStatusRef.current);
        })
        .catch((err) => {
          // A failed *dynamic import* here is almost never a missing package —
          // it is a stale dep-chunk hash after Vite re-optimized while the page
          // stayed open (quiet mode suppresses the reload that would fix it).
          // Saying "reload" is the difference between a five-second fix and a
          // hunt through node_modules.
          const stale = /dynamically imported module|Importing a module script failed/i.test(
            String(err?.message ?? err),
          );
          setError(
            stale
              ? "Vim mode needs a reload (the editor's module cache is stale) — press F5."
              : `Vim mode unavailable: ${err?.message ?? err}`,
          );
        });
    }
    return () => {
      disposed = true;
      vimModeRef.current?.dispose?.();
      vimModeRef.current = null;
    };
  }, [vim, ready]);

  const toggleVim = () => {
    const next = !vim;
    setVim(next);
    try {
      localStorage.setItem(VIM_KEY, next ? "1" : "0");
    } catch {
      // Private-mode / storage-disabled: the toggle still works for this
      // session, it just won't be remembered. Not worth an error.
    }
  };

  // three's declarations, in the background, once a project is open. Cheap to
  // call repeatedly — it no-ops after the first success.
  useEffect(() => {
    if (!projectRoot) return;
    if (!["typescript", "javascript"].includes(languageForPath(path))) return;
    ensureThreeTypes(projectRoot);
  }, [projectRoot, path]);

  // Adopt on-disk changes when this pane regains focus and nothing is unsaved.
  useEffect(() => {
    const onFocus = async () => {
      const model = modelRef.current;
      if (!model) return;
      let text;
      try {
        text = await invoke("read_text_file", { path });
      } catch {
        return;
      }
      if (text === savedRef.current) return;
      if (model.getValue() !== savedRef.current) {
        setError("This file changed on disk while you had unsaved edits — saving will overwrite it.");
        return;
      }
      savedRef.current = text;
      model.setValue(text);
      model.__engineDirty = false;
      markDirty(false);
      setStatus("Reloaded from disk");
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [path, markDirty]);

  const revert = async () => {
    const model = modelRef.current;
    if (!model) return;
    try {
      const text = await invoke("read_text_file", { path });
      model.setValue(text);
      savedRef.current = text;
      model.__engineDirty = false;
      markDirty(false);
      setError(null);
      setStatus("Reverted");
    } catch (err) {
      setError(`Couldn't revert: ${err?.message ?? err}`);
    }
  };

  const format = () => editorRef.current?.getAction("editor.action.formatDocument")?.run();

  /**
   * Drag the bottom edge to resize.
   *
   * Pointer capture rather than window listeners, so the drag survives the
   * pointer leaving the handle — which it does immediately, because the whole
   * point of the gesture is to move away from where it started.
   *
   * Monaco is told to re-layout on every move: it caches its own dimensions and
   * will happily render a viewport the wrong size until something asks it to
   * measure again. The ResizeObserver already installed on the host covers
   * this, but calling `layout()` directly keeps the text tracking the handle
   * frame-for-frame instead of a beat behind it.
   */
  const startResize = (event) => {
    if (!resizable) return;
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = rootRef.current?.getBoundingClientRect().height ?? boxHeight ?? 320;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);

    const onMove = (move) => {
      setBoxHeight(clampHeight(startHeight + (move.clientY - startY)));
      editorRef.current?.layout();
    };
    const onUp = () => {
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onUp);
      try {
        target.releasePointerCapture(event.pointerId);
      } catch {
        // Already released (the pointer was lost) — nothing to undo.
      }
      // Persisted on release, not on every move: a drag is hundreds of events
      // and localStorage writes are synchronous.
      const settled = rootRef.current?.getBoundingClientRect().height;
      if (storageKey && settled) {
        try {
          localStorage.setItem(`engine.code.height.${storageKey}`, String(Math.round(settled)));
        } catch {
          // Storage unavailable — the size still applies for this session.
        }
      }
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onUp);
  };

  /** Double-clicking the handle toggles between the default and a tall pane. */
  const toggleTall = () => {
    if (!resizable) return;
    const base = typeof height === "number" ? height : 320;
    const next = clampHeight(Math.abs((boxHeight ?? base) - base) < 8 ? base * 2.2 : base);
    setBoxHeight(next);
    if (storageKey) {
      try {
        localStorage.setItem(`engine.code.height.${storageKey}`, String(next));
      } catch {
        // See above — a lost preference is not worth an error.
      }
    }
    requestAnimationFrame(() => editorRef.current?.layout());
  };

  const toggleWrap = () => {
    const next = !wrap;
    setWrap(next);
    editorRef.current?.updateOptions({ wordWrap: next ? "on" : "off" });
  };

  return (
    <div
      ref={rootRef}
      className={`code-editor${compact ? " compact" : ""}${resizable ? " resizable" : ""}`}
      style={{ height: resizable ? boxHeight : height }}
    >
      {toolbar && (
        <div className="code-editor-bar">
          <button className="toolbar-btn" onClick={save} disabled={!dirty || readOnly} title="Save (Ctrl+S)">
            <Save size={13} />
            {dirty ? "Save" : "Saved"}
          </button>
          <button className="toolbar-btn" onClick={revert} disabled={!dirty} title="Discard unsaved edits">
            <RotateCcw size={13} />
          </button>
          <button className={`toolbar-btn${wrap ? " active" : ""}`} onClick={toggleWrap} title="Word wrap">
            <WrapText size={13} />
          </button>
          <button className="toolbar-btn" onClick={format} title="Format document">
            <Braces size={13} />
          </button>
          <button
            className={`toolbar-btn${vim ? " active" : ""}`}
            onClick={toggleVim}
            title={vim ? "Vim mode on — click to disable" : "Vim mode (modal editing)"}
          >
            <Command size={13} />
            VIM
          </button>
          <span className="code-editor-status">
            {error ? <span className="code-editor-error">{error}</span> : dirty ? "Unsaved changes" : status}
          </span>
          <button className="toolbar-btn" onClick={() => openInIDE(path)} title="Open in your external IDE">
            <ExternalLink size={13} />
          </button>
        </div>
      )}
      <div className="code-editor-host" ref={hostRef} />
      {/* The vim status line (mode, pending command, `:` prompt). Always in the
          tree so `initVimMode` has a node to write into the instant it loads,
          and collapsed to nothing while vim is off. */}
      <div className="code-vim-status" ref={vimStatusRef} style={{ display: vim ? "block" : "none" }} />
      {!ready && !error && <div className="code-editor-loading">Loading editor…</div>}
      {!toolbar && error && <div className="code-editor-error inline">{error}</div>}
      {resizable && (
        <div
          className="code-editor-resize"
          onPointerDown={startResize}
          onDoubleClick={toggleTall}
          title="Drag to resize · double-click to toggle a taller pane"
          role="separator"
          aria-orientation="horizontal"
        >
          <span className="code-editor-grip" />
        </div>
      )}
    </div>
  );
}
