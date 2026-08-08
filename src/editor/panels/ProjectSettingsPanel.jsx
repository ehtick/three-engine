import { useEffect, useState } from "react";
import { Save, X, RotateCcw } from "lucide-react";
import { useProjectStore, basename } from "../store/projectStore.js";
import {
  getProjectSettings,
  saveProjectSettings,
  PROJECT_SETTINGS_DEFAULTS,
} from "../projectSettings.js";
import { currentScenePath } from "../sceneIO.js";
import { KEY_BINDING_ACTIONS, describeBinding } from "../keybindings.js";
import {
  isViewportFreezeEnabled,
  onViewportFreezeChanged,
  setViewportFreezeEnabled,
} from "../viewportFreeze.js";

const MAIN_SCENE_KEY = "mainScene";

/** Project-relative path used as the boot scene. Stored on projectMeta
 *  alongside lastScene (same shape), not in `settings`. */
function projectRelative(root, absPath) {
  const norm = (p) => p.replaceAll("\\", "/");
  const r = norm(root);
  const p = norm(absPath);
  return p.toLowerCase().startsWith(`${r.toLowerCase()}/`) ? p.slice(r.length + 1) : absPath;
}

/** Normalize a user-typed main-scene path into the form we store and boot from:
 *  forward slashes, no leading "./" or "/", no trailing slash, lowercase
 *  extension preserved (the editor treats both .scene and .json as scenes). */
function normalizeMainPath(raw) {
  if (!raw) return "";
  let p = String(raw).replaceAll("\\", "/").trim();
  while (p.startsWith("./")) p = p.slice(2);
  while (p.startsWith("/")) p = p.slice(1);
  while (p.endsWith("/") && p.length > 1) p = p.slice(0, -1);
  return p;
}

/** Async stat — does the file exist at this path? Catches both stale saved
 *  values and user typos before the editor silently fails on boot. */
async function pathExists(absPath) {
  if (!absPath) return false;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("stat_file", { path: absPath });
    return true;
  } catch {
    return false;
  }
}

function Row({ label, children }) {
  return (
    <div className="field-row">
      <span className="field-label">{label}</span>
      {children}
    </div>
  );
}

function Num({ value, onChange, min, max, step = 0.1 }) {
  return (
    <input
      className="number-field"
      type="number"
      step={step}
      min={min}
      max={max}
      value={value}
      onChange={(e) => {
        const v = parseFloat(e.target.value);
        if (!Number.isNaN(v)) onChange(v);
      }}
    />
  );
}

/**
 * Capture-on-focus binding input. Click into the field, press the desired
 * chord (modifiers included), and we store it through `onChange`. The
 * visible text only updates on a valid chord so users immediately see
 * whether the editor accepted their input. Empty input is allowed and
 * means "unbound" — clicking the reset icon restores the default.
 */
function KeybindingInput({ actionId, value, defaultChord, onChange }) {
  const [draft, setDraft] = useState(value ?? defaultChord);
  const [capturing, setCapturing] = useState(false);

  useEffect(() => {
    setDraft(value ?? "");
  }, [value]);

  useEffect(() => {
    if (!capturing) return;
    const onKey = (e) => {
      // Esc cancels capture without changing anything.
      if (e.key === "Escape") {
        e.preventDefault();
        setCapturing(false);
        setDraft(value ?? "");
        return;
      }
      // Backspace/Delete clears the binding outright (no key required).
      if ((e.key === "Backspace" || e.key === "Delete") && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        onChange("");
        setCapturing(false);
        return;
      }
      // Ignore lone modifier presses — wait for the actual key.
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
      e.preventDefault();
      const tokens = [];
      if (e.ctrlKey) tokens.push("Ctrl");
      if (e.shiftKey) tokens.push("Shift");
      if (e.altKey) tokens.push("Alt");
      if (e.metaKey) tokens.push("Meta");
      tokens.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);
      const chord = tokens.join("+");
      setDraft(chord);
      onChange(chord);
      setCapturing(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [capturing, value, onChange]);

  return (
    <div className="keybinding-cell">
      <input
        className={`text-field keybinding-input ${capturing ? "capturing" : ""}`}
        value={capturing ? "Press a key…" : draft || "Unbound"}
        placeholder={defaultChord}
        readOnly
        onFocus={() => setCapturing(true)}
        onBlur={() => setCapturing(false)}
      />
      <button
        type="button"
        className="toolbar-btn icon-only"
        title={`Reset to default (${describeBinding(defaultChord)})`}
        onClick={() => {
          onChange(defaultChord);
          setDraft(defaultChord);
        }}
      >
        <RotateCcw size={12} />
      </button>
    </div>
  );
}

function KeybindingsTable({ keybindings, onChange }) {
  return (
    <div className="keybindings-table">
      {Object.entries(KEY_BINDING_ACTIONS).map(([actionId, def]) => (
        <div key={actionId} className="field-row keybinding-row">
          <span className="field-label" title={actionId}>{def.label}</span>
          <KeybindingInput
            actionId={actionId}
            value={keybindings[actionId] ?? ""}
            defaultChord={def.default}
            onChange={(chord) => onChange({ ...keybindings, [actionId]: chord })}
          />
        </div>
      ))}
    </div>
  );
}

/**
 * Project-wide settings (project.json `settings`): editor behavior, script
 * hot reload, performance, export metadata. Not undoable — these are
 * preferences, not scene edits. Save writes the file and applies live.
 */
/**
 * Layer names + the collision matrix, Unity-style. The matrix is symmetric, so
 * only the lower triangle is editable — showing both halves invites the user to
 * set two contradictory values for one pair.
 *
 * `matrix[i]` is a bitmask of the layers layer `i` collides with; `null` (the
 * default) means everything collides, which is what projects had before layers
 * existed. The first edit materialises a real matrix.
 */
function CollisionMatrixSection({ layers, matrix, onChange }) {
  const names = layers ?? [];
  const rows = matrix ?? names.map(() => 0xffff);
  const collides = (i, j) => !!(rows[i] & (1 << j));

  const toggle = (i, j) => {
    const next = names.map((_, k) => rows[k] ?? 0xffff);
    const on = !collides(i, j);
    if (on) {
      next[i] |= 1 << j;
      next[j] |= 1 << i;
    } else {
      next[i] &= ~(1 << j);
      next[j] &= ~(1 << i);
    }
    onChange({ matrix: next });
  };

  const rename = (index, value) => {
    const next = [...names];
    next[index] = value;
    onChange({ layers: next });
  };

  return (
    <div className="inspector-section">
      <div className="section-header">Physics Layers</div>
      <div className="asset-hint" style={{ padding: "0 2px 6px" }}>
        A collider is on one layer; this matrix decides which layers touch. Queries
        (raycast, overlap) are not filtered by it — they take their own layer list.
      </div>
      {names.map((name, index) => (
        <Row key={index} label={`Layer ${index}`}>
          <input
            className="text-field"
            value={name}
            onChange={(e) => rename(index, e.target.value)}
            // Layer 0 is the fallback for any collider whose layer went
            // missing, so it always has to exist under some name.
            placeholder={index === 0 ? "Default" : `Layer ${index}`}
          />
        </Row>
      ))}
      <div className="collision-matrix">
        {names.map((rowName, i) => (
          <div className="collision-matrix-row" key={i}>
            <span className="collision-matrix-label" title={rowName}>
              {rowName}
            </span>
            {/* Lower triangle including the diagonal: pair {i, j} appears
                exactly once, and the diagonal is a layer against itself
                (debris that should not collide with other debris). */}
            {names.slice(0, i + 1).map((colName, j) => (
              <label
                key={j}
                className="collision-matrix-cell"
                title={`${rowName} ↔ ${colName}`}
              >
                <input type="checkbox" checked={collides(i, j)} onChange={() => toggle(i, j)} />
              </label>
            ))}
          </div>
        ))}
        <div className="collision-matrix-row collision-matrix-footer">
          <span className="collision-matrix-label" />
          {names.map((name, i) => (
            <span className="collision-matrix-vlabel" key={i} title={name}>
              {name}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

export function ProjectSettingsPanel() {
  const rootPath = useProjectStore((s) => s.rootPath);
  const projectName = useProjectStore((s) => s.projectMeta?.name);
  const mainScene = useProjectStore((s) => s.projectMeta?.mainScene ?? "");
  const [settings, setSettings] = useState(null);
  const [dirty, setDirty] = useState(false);
  // Not part of `settings`: this one is a per-machine preference in
  // localStorage (how heavy YOUR scene runs on YOUR hardware), so it applies
  // the moment it is clicked and is untouched by Save. See viewportFreeze.js.
  const [freezeUnfocused, setFreezeUnfocused] = useState(isViewportFreezeEnabled);
  useEffect(() => onViewportFreezeChanged(setFreezeUnfocused), []);
  const [mainDraft, setMainDraft] = useState(mainScene);
  const [mainDirty, setMainDirty] = useState(false);
  // null = unknown/checking, true = exists, false = missing
  const [mainValid, setMainValid] = useState(null);

  useEffect(() => {
    if (rootPath) setSettings(getProjectSettings());
  }, [rootPath]);

  useEffect(() => {
    setMainDraft(mainScene);
    setMainDirty(false);
  }, [mainScene, rootPath]);

  // Live-validate the typed (or saved) path so the user sees "missing" before
  // they hit Save — and so they understand why the editor refuses to open it.
  useEffect(() => {
    if (!rootPath) return;
    const value = normalizeMainPath(mainDirty ? mainDraft : mainScene);
    if (!value) {
      setMainValid(null); // empty = cleared, not an error
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      const ok = await pathExists(`${rootPath}/${value}`);
      if (!cancelled) setMainValid(ok);
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [mainDraft, mainScene, mainDirty, rootPath]);

  if (!rootPath) {
    return <div className="inspector-panel empty">Open a project to edit its settings.</div>;
  }
  if (!settings) return <div className="inspector-panel empty">Loading…</div>;

  const patch = (section, p) => {
    setSettings({ ...settings, [section]: { ...settings[section], ...p } });
    setDirty(true);
  };

  const save = async () => {
    try {
      await saveProjectSettings(settings);
      setDirty(false);
      console.log("Project settings saved");
    } catch (err) {
      console.error(`Failed to save project settings: ${err}`);
    }
  };

  const saveMainScene = async () => {
    const value = normalizeMainPath(mainDraft);
    try {
      await useProjectStore.getState().updateMeta({ [MAIN_SCENE_KEY]: value });
      setMainDraft(value);
      setMainDirty(false);
      console.log(value ? `Main scene set: ${value}` : "Main scene cleared");
    } catch (err) {
      console.error(`Failed to set main scene: ${err}`);
    }
  };

  const useCurrentAsMain = async () => {
    const abs = currentScenePath();
    if (!abs) return;
    const rel = projectRelative(rootPath, abs);
    setMainDraft(rel);
    try {
      await useProjectStore.getState().updateMeta({ [MAIN_SCENE_KEY]: rel });
      setMainDirty(false);
      console.log(`Main scene set to current: ${rel}`);
    } catch (err) {
      console.error(`Failed to set main scene: ${err}`);
    }
  };

  const clearMainScene = async () => {
    setMainDraft("");
    try {
      await useProjectStore.getState().updateMeta({ [MAIN_SCENE_KEY]: "" });
      setMainDirty(false);
    } catch (err) {
      console.error(`Failed to clear main scene: ${err}`);
    }
  };

  const { editor, scripts, rendering, game, physics } = settings;
  const mainValue = normalizeMainPath(mainDirty ? mainDraft : mainScene);
  const mainHint = !mainValue
    ? "No main scene set — boot will fall back to the last-edited scene."
    : mainValid === false
      ? `File not found: ${rootPath}/${mainValue}`
      : mainValid === true
        ? `Opens on editor boot: ${mainValue}`
        : "Checking…";

  return (
    <div className="inspector-panel scene-settings-panel">
      <div className="panel-toolbar">
        <span className="asset-path" title={rootPath}>
          {projectName ?? basename(rootPath)}
        </span>
        <button className="toolbar-btn" disabled={!dirty} onClick={save}>
          <Save size={13} />
          Save{dirty ? " •" : ""}
        </button>
      </div>

      <div className="inspector-section">
        <div className="section-header">Editor</div>
        <Row label="Autosave (s)">
          <Num value={editor.autosaveSeconds} min={0} step={5} onChange={(v) => patch("editor", { autosaveSeconds: v })} />
        </Row>
        <Row label="Snap move">
          <Num value={editor.snapTranslate} min={0.01} step={0.1} onChange={(v) => patch("editor", { snapTranslate: v })} />
        </Row>
        <Row label="Snap rotate°">
          <Num value={editor.snapRotateDeg} min={1} max={90} step={1} onChange={(v) => patch("editor", { snapRotateDeg: v })} />
        </Row>
        <Row label="Snap scale">
          <Num value={editor.snapScale} min={0.01} step={0.05} onChange={(v) => patch("editor", { snapScale: v })} />
        </Row>
        <Row label="Show grid">
          <input type="checkbox" checked={editor.showGrid !== false} onChange={(e) => patch("editor", { showGrid: e.target.checked })} />
        </Row>
        <Row label="Grid size">
          <Num value={editor.gridSize} min={2} step={2} onChange={(v) => patch("editor", { gridSize: v })} />
        </Row>
        <Row label="Divisions">
          <Num value={editor.gridDivisions} min={1} step={1} onChange={(v) => patch("editor", { gridDivisions: v })} />
        </Row>
        <Row label="Freeze unfocused viewport">
          <input
            type="checkbox"
            checked={freezeUnfocused}
            title="Stop rendering the viewport while another panel has focus. It wakes up whenever something it draws changes; turn this off if you need an unattended simulation to keep ticking."
            onChange={(e) => setViewportFreezeEnabled(e.target.checked)}
          />
        </Row>
        <div className="asset-hint" style={{ padding: "0 2px 6px" }}>
          Freezing applies immediately and is remembered per machine, not saved
          into the project.
        </div>
      </div>

      <div className="inspector-section">
        <div className="section-header">Keybindings</div>
        <KeybindingsTable
          keybindings={editor.keybindings ?? {}}
          onChange={(keybindings) => patch("editor", { keybindings })}
        />
      </div>

      <div className="inspector-section">
        <div className="section-header">Scripts</div>
        <Row label="Hot reload">
          <input type="checkbox" checked={scripts.hotReload !== false} onChange={(e) => patch("scripts", { hotReload: e.target.checked })} />
        </Row>
        <Row label="Poll (ms)">
          <Num value={scripts.reloadIntervalMs} min={100} step={50} onChange={(v) => patch("scripts", { reloadIntervalMs: v })} />
        </Row>
      </div>

      <div className="inspector-section">
        <div className="section-header">Performance</div>
        <Row label="Pixel ratio cap">
          <Num value={rendering.pixelRatioCap} min={0.5} max={4} step={0.25} onChange={(v) => patch("rendering", { pixelRatioCap: v })} />
        </Row>
      </div>

      <div className="inspector-section">
        <div className="section-header">Game</div>
        <Row label="Title">
          <input
            className="text-field"
            type="text"
            value={game.title}
            placeholder={projectName ?? basename(rootPath)}
            onChange={(e) => patch("game", { title: e.target.value })}
          />
        </Row>
        <Row label="Main scene">
          <div style={{ display: "flex", flexDirection: "column", gap: 4, width: "100%" }}>
            <div style={{ display: "flex", gap: 4, width: "100%" }}>
              <input
                className="text-field"
                type="text"
                value={mainDraft}
                placeholder="scenes/main.scene"
                onChange={(e) => {
                  setMainDraft(e.target.value);
                  setMainDirty(normalizeMainPath(e.target.value) !== normalizeMainPath(mainScene));
                }}
                style={{ flex: 1 }}
              />
              {mainDirty ? (
                <button
                  className="toolbar-btn"
                  title="Save the typed path as the main scene"
                  disabled={mainValid === false}
                  onClick={saveMainScene}
                >
                  <Save size={13} />
                </button>
              ) : null}
              <button
                className="toolbar-btn"
                title="Use the currently open scene as the main scene"
                disabled={!currentScenePath()}
                onClick={useCurrentAsMain}
              >
                Use current
              </button>
              {mainScene ? (
                <button
                  className="toolbar-btn"
                  title="Clear main scene (boot will fall back to last-edited scene)"
                  onClick={clearMainScene}
                >
                  <X size={13} />
                </button>
              ) : null}
            </div>
            <span
              className="asset-hint"
              style={{
                color: mainValid === false ? "var(--danger, #e26d6d)" : undefined,
                padding: "0 2px",
              }}
            >
              {mainHint}
            </span>
          </div>
        </Row>
      </div>

      <div className="inspector-section">
        <div className="section-header">Saves</div>
        <div className="asset-hint" style={{ padding: "0 2px 6px" }}>
          Save slots and preferences are stored under this id, so two games served from
          the same origin can't read each other's saves. Empty = the title above — which
          means renaming the game orphans existing saves; pin an id to keep them.
        </div>
        <Row label="Save id">
          <input
            className="text-field"
            type="text"
            value={game.saveId ?? ""}
            placeholder={game.title || projectName || basename(rootPath)}
            onChange={(e) => patch("game", { saveId: e.target.value })}
          />
        </Row>
        <Row label="Save version">
          <Num
            value={game.saveVersion ?? 1}
            min={1}
            step={1}
            onChange={(v) => patch("game", { saveVersion: Math.max(1, Math.round(v)) })}
          />
        </Row>
        <div className="asset-hint" style={{ padding: "6px 2px 0" }}>
          Bump the version when what your scripts write in <code>onSave</code> changes, and
          register a migration with <code>engine.saves.registerMigration(n, fn)</code>. A
          save with no path to the current version is refused rather than loaded wrong.
        </div>
      </div>

      <CollisionMatrixSection
        layers={physics.layers}
        matrix={physics.matrix}
        onChange={(next) => patch("physics", next)}
      />

      <div className="asset-hint" style={{ padding: "4px 10px" }}>
        Stored in project.json. Scene look (background, fog, tone mapping…) lives in Scene Settings.
      </div>
    </div>
  );
}
