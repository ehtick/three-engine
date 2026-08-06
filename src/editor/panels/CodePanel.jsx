// @ts-nocheck
import { useEffect, useMemo, useState } from "react";
import { FileCode2, X, Circle } from "lucide-react";
import { CodeEditor } from "../components/CodeEditor.jsx";
import { useSelectionStore } from "../store/selectionStore.js";
import { basename } from "../store/projectStore.js";
import { isTextEditablePath } from "../code/monaco.js";
import { usePanelVisible } from "../usePanelVisible.js";
import { useCodeStore } from "../codeStore.js";

/**
 * The full-size code editor, with the open files across the top.
 *
 * Tabs rather than "whatever is selected in Assets": editing code means moving
 * between files — a script and the component it drives, a script and the one
 * it imports — and a pane that follows the Assets selection loses your place
 * every time you look at a texture. Selecting a script *does* open a tab, so
 * the connection to the rest of the editor is intact; it just doesn't close
 * the file you were working in.
 */
export function CodePanel({ api }) {
  const visible = usePanelVisible(api);
  const files = useCodeStore((state) => state.files);
  const activePath = useCodeStore((state) => state.activePath);
  const dirty = useCodeStore((state) => state.dirty);
  const selectedAsset = useSelectionStore((state) => state.assetPath);

  // Following the selection is what makes double-clicking a script in Assets
  // land here. Only for files this editor can actually show — selecting a
  // `.png` should not blank the code you were reading.
  useEffect(() => {
    if (!selectedAsset || !isTextEditablePath(selectedAsset)) return;
    // The store, not `openCodeFile` — this panel is already open, and asking
    // dockview to open it again on every selection change would yank focus
    // away from whatever the user was actually doing.
    useCodeStore.getState().open(selectedAsset);
  }, [selectedAsset]);

  const active = files.includes(activePath) ? activePath : files[0] ?? null;

  if (!files.length) {
    return (
      <div className="code-panel empty">
        <FileCode2 size={26} strokeWidth={1.4} />
        <p>No file open.</p>
        <p className="asset-hint">
          Double-click a script in Assets, or use Open in Code Editor from an asset's Inspector.
        </p>
      </div>
    );
  }

  return (
    <div className="code-panel">
      <div className="code-tabs">
        {files.map((path) => (
          <div
            key={path}
            className={`code-tab${path === active ? " active" : ""}`}
            onMouseDown={() => useCodeStore.getState().activate(path)}
            title={path}
          >
            {dirty[path] && <Circle size={7} className="code-tab-dot" fill="currentColor" />}
            <span className="code-tab-name">{basename(path)}</span>
            <button
              className="code-tab-close"
              onClick={(event) => {
                event.stopPropagation();
                useCodeStore.getState().close(path);
              }}
              title="Close"
            >
              <X size={11} />
            </button>
          </div>
        ))}
      </div>
      {/* Every open file stays mounted so switching tabs keeps scroll position
          and undo history; only the active one is displayed. Hidden editors
          are cheap — Monaco stops laying out an element with no box. */}
      {files.map((path) => (
        <div key={path} className="code-panel-body" style={{ display: path === active ? "flex" : "none" }}>
          {visible && (
            <CodeEditor
              path={path}
              minimap
              onDirtyChange={(value) => useCodeStore.getState().setDirty(path, value)}
            />
          )}
        </div>
      ))}
    </div>
  );
}
