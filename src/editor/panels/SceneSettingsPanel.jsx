import { useEffect, useState } from "react";
import { ensureEngine } from "../engineInstance.js";
import { commandBus } from "../commands/CommandBus.js";
import { SetSceneSettingsCommand } from "../commands/settingsCommands.js";
import { useSceneStore } from "../store/sceneStore.js";
import { MSAA_SAMPLES, SHADOW_TYPES, SCENE_SETTINGS_DEFAULTS } from "../../engine/sceneSettings.js";
import { CUBEMAP_EXTENSIONS } from "../assetLoader.js";
import { AssetField } from "../fields/AssetField.jsx";
import { useSelectionStore } from "../store/selectionStore.js";
import { openPanel } from "../EditorShell.jsx";

const TONE_MAPPING_OPTIONS = [
  ["neutral", "Neutral (Khronos)"],
  ["aces", "ACES Filmic"],
  ["agx", "AgX"],
  ["reinhard", "Reinhard"],
  ["cineon", "Cineon"],
  ["linear", "Linear"],
  ["none", "None"],
];

const SHADOW_TYPE_OPTIONS = Object.keys(SHADOW_TYPES).map((k) => [k, k.replace("ShadowMap", "")]);

function Row({ label, children }) {
  return (
    <div className="field-row">
      <span className="field-label">{label}</span>
      {children}
    </div>
  );
}

function NumberInput({ value, onCommit, min, max, step = 0.1 }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(Math.round(value * 1000) / 1000)), [value]);
  const commit = () => {
    let v = parseFloat(text);
    if (Number.isNaN(v)) return setText(String(value));
    if (min !== undefined) v = Math.max(min, v);
    if (max !== undefined) v = Math.min(max, v);
    if (v !== value) onCommit(v);
  };
  return (
    <input
      className="number-field"
      type="number"
      step={step}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && e.target.blur()}
    />
  );
}

/**
 * Per-scene environment settings (saved inside the .scene file, undoable).
 * Every change is one command on the bus, applied live to the engine.
 */
export function SceneSettingsPanel() {
  const sceneName = useSceneStore((s) => s.sceneName);
  const [settings, setSettings] = useState(null);

  useEffect(() => {
    let unsub = null;
    let live = true;
    ensureEngine().then((engine) => {
      if (!live) return;
      setSettings(structuredClone(engine.settings));
      unsub = engine.on("settings-changed", (s) => setSettings(structuredClone(s)));
    });
    return () => {
      live = false;
      unsub?.();
    };
  }, []);

  if (!settings) return <div className="inspector-panel empty">Loading…</div>;

  // Top-level settings commit. Merging via the engine keeps "old" snapshots
  // correct on undo, even when the patch only names one key.
  const commit = (patch, label) => commandBus.execute(new SetSceneSettingsCommand(patch, label));
  const commitFog = (fogPatch, label) =>
    commit({ fog: { ...settings.fog, ...fogPatch } }, label ?? "Change fog");
  const commitRenderer = (rendererPatch, label) =>
    commit(
      { renderer: { ...settings.renderer, ...rendererPatch } },
      label ?? "Change renderer settings",
    );
  const commitShadow = (shadowPatch, label) =>
    commit(
      { shadow: { ...settings.shadow, ...shadowPatch } },
      label ?? "Change shadow settings",
    );
  const commitPerf = (perfPatch, label) =>
    commit(
      { performance: { ...settings.performance, ...perfPatch } },
      label ?? "Change performance settings",
    );
  const env = { ...SCENE_SETTINGS_DEFAULTS.environment, ...(settings.environment ?? {}) };
  const commitEnv = (envPatch, label) =>
    commit({ environment: { ...env, ...envPatch } }, label ?? "Change environment settings");

  const perf = settings.performance ?? {
    maxDevicePixelRatio: 2,
    renderScale: 1,
    dynamicResolution: false,
    targetFps: 60,
    volumeStepScale: 1,
  };
  const renderer = settings.renderer ?? { antialias: true, samples: 4, transparent: false };
  const shadow = settings.shadow ?? { type: "PCFSoftShadowMap", autoUpdate: true, needsUpdate: false };

  return (
    <div className="inspector-panel scene-settings-panel">
      <div className="inspector-section">
        <div className="section-header">Scene · {sceneName}</div>
      </div>

      <div className="inspector-section">
        <div className="section-header">Environment</div>
        <Row label="Background">
          <input
            className="color-field"
            type="color"
            value={settings.background}
            onChange={(e) => commit({ background: e.target.value }, "Change background")}
          />
        </Row>
        <Row label="Ambient">
          <input
            className="color-field"
            type="color"
            value={settings.ambientColor}
            onChange={(e) => commit({ ambientColor: e.target.value }, "Change ambient color")}
          />
        </Row>
        <Row label="Intensity">
          <NumberInput
            value={settings.ambientIntensity}
            min={0}
            step={0.05}
            onCommit={(v) => commit({ ambientIntensity: v }, "Change ambient intensity")}
          />
        </Row>
        <Row label="Cube Map">
          <AssetField
            descriptor={{ exts: CUBEMAP_EXTENSIONS, emptyLabel: "None" }}
            value={env.cubemap}
            onCommit={(value) => commitEnv({ cubemap: value }, "Change scene cube map")}
          />
        </Row>
        {env.cubemap && (
          <>
            <Row label="Show as Sky">
              <input
                type="checkbox"
                checked={env.background !== false}
                onChange={(e) => commitEnv({ background: e.target.checked }, "Toggle skybox")}
              />
            </Row>
            <Row label="Use for Lighting">
              <input
                type="checkbox"
                checked={env.lighting !== false}
                onChange={(e) => commitEnv({ lighting: e.target.checked }, "Toggle environment lighting")}
              />
            </Row>
            <Row label="Intensity">
              <NumberInput
                value={env.intensity ?? 1}
                min={0}
                step={0.05}
                onCommit={(v) => commitEnv({ intensity: v }, "Change environment intensity")}
              />
            </Row>
            <Row label="Rotation°">
              <NumberInput
                value={env.rotation ?? 0}
                min={0}
                max={360}
                step={1}
                onCommit={(v) => commitEnv({ rotation: v }, "Change environment rotation")}
              />
            </Row>
            <Row label="Sky Blur">
              <NumberInput
                value={env.blur ?? 0}
                min={0}
                max={1}
                step={0.05}
                onCommit={(v) => commitEnv({ blur: v }, "Change sky blur")}
              />
            </Row>
            <button
              className="toolbar-btn wide"
              onClick={() => {
                useSelectionStore.getState().selectAsset(env.cubemap);
                openPanel("inspector");
              }}
            >
              Edit Cube Map Faces
            </button>
          </>
        )}
        <div className="asset-hint" style={{ padding: "4px 4px 0" }}>
          A cube map drives both the skybox and image-based lighting. Background color still shows
          wherever the sky is off.
        </div>
      </div>

      <div className="inspector-section">
        <div className="section-header">Fog</div>
        <Row label="Type">
          <select
            className="select-field"
            value={settings.fog.type}
            onChange={(e) => commitFog({ type: e.target.value })}
          >
            <option value="none">None</option>
            <option value="linear">Linear</option>
            <option value="exp2">Exponential²</option>
          </select>
        </Row>
        {settings.fog.type !== "none" && (
          <Row label="Color">
            <input
              className="color-field"
              type="color"
              value={settings.fog.color}
              onChange={(e) => commitFog({ color: e.target.value })}
            />
          </Row>
        )}
        {settings.fog.type === "linear" && (
          <>
            <Row label="Near">
              <NumberInput value={settings.fog.near} min={0} step={1} onCommit={(v) => commitFog({ near: v })} />
            </Row>
            <Row label="Far">
              <NumberInput value={settings.fog.far} min={0} step={1} onCommit={(v) => commitFog({ far: v })} />
            </Row>
          </>
        )}
        {settings.fog.type === "exp2" && (
          <Row label="Density">
            <NumberInput
              value={settings.fog.density}
              min={0}
              max={1}
              step={0.005}
              onCommit={(v) => commitFog({ density: v })}
            />
          </Row>
        )}
      </div>

      <div className="inspector-section">
        <div className="section-header">Rendering</div>
        <Row label="Tone mapping">
          <select
            className="select-field"
            value={settings.toneMapping}
            onChange={(e) => commit({ toneMapping: e.target.value }, "Change tone mapping")}
          >
            {TONE_MAPPING_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Row>
        <Row label="Exposure">
          <NumberInput
            value={settings.exposure}
            min={0}
            step={0.05}
            onCommit={(v) => commit({ exposure: v }, "Change exposure")}
          />
        </Row>
        <Row label="Shadows">
          <input
            type="checkbox"
            checked={settings.shadows !== false}
            onChange={(e) => commit({ shadows: e.target.checked }, "Toggle shadows")}
          />
        </Row>
      </div>

      <div className="inspector-section">
        <div className="section-header">Performance</div>
        <div className="asset-hint" style={{ padding: "0 4px 6px" }}>
          Applied live — no renderer rebuild. Watch the GPU ms readout in the
          viewport stats while tuning (8.3 ms = 120 fps, 16.7 ms = 60 fps).
        </div>
        <Row label="Max device pixel ratio">
          <NumberInput
            value={perf.maxDevicePixelRatio ?? 2}
            min={0.5}
            max={4}
            step={0.25}
            onCommit={(v) =>
              commitPerf({ maxDevicePixelRatio: v }, "Change max device pixel ratio")
            }
          />
        </Row>
        <Row label="Render scale">
          <select
            className="select-field"
            value={String(perf.renderScale ?? 1)}
            onChange={(e) =>
              commitPerf({ renderScale: parseFloat(e.target.value) }, "Change render scale")
            }
          >
            <option value="1">100%</option>
            <option value="0.85">85%</option>
            <option value="0.75">75%</option>
            <option value="0.66">66%</option>
            <option value="0.5">50%</option>
            <option value="0.33">33%</option>
            <option value="0.25">25%</option>
          </select>
        </Row>
        <Row label="Dynamic res">
          <input
            type="checkbox"
            checked={perf.dynamicResolution === true}
            onChange={(e) =>
              commitPerf({ dynamicResolution: e.target.checked }, "Toggle dynamic resolution")
            }
          />
        </Row>
        <Row label="Target FPS">
          <select
            className="select-field"
            value={String(perf.targetFps ?? 60)}
            disabled={perf.dynamicResolution !== true}
            onChange={(e) =>
              commitPerf({ targetFps: parseInt(e.target.value, 10) }, "Change target FPS")
            }
          >
            <option value="30">30</option>
            <option value="60">60</option>
            <option value="90">90</option>
            <option value="120">120</option>
          </select>
        </Row>
        <Row label="Volume quality">
          <NumberInput
            value={perf.volumeStepScale ?? 1}
            min={0.1}
            max={1}
            step={0.05}
            onCommit={(v) => commitPerf({ volumeStepScale: v }, "Change volume quality")}
          />
        </Row>
        <Row label="Occlusion culling">
          <input
            type="checkbox"
            checked={perf.occlusionCulling === true}
            onChange={(e) =>
              commitPerf({ occlusionCulling: e.target.checked }, "Toggle occlusion culling")
            }
          />
        </Row>
        <div className="asset-hint" style={{ padding: "0 4px 6px" }}>
          Hides objects the depth buffer says are behind something else. It costs a
          low-resolution depth pass over the scene's big geometry every frame, so it is a
          win indoors and in dense cities, and a small loss in an open landscape with
          nothing to hide behind. Watch Draw calls in the viewport stats while you toggle
          it — that is the number it is trying to move.
        </div>
      </div>

      <div className="inspector-section">
        <div className="section-header">Renderer</div>
        <div className="asset-hint" style={{ padding: "0 4px 6px" }}>
          MSAA / canvas options — changing them rebuilds the renderer.
        </div>
        <Row label="Antialias">
          <input
            type="checkbox"
            checked={renderer.antialias !== false}
            onChange={(e) =>
              commitRenderer({ antialias: e.target.checked }, "Toggle antialiasing")
            }
          />
        </Row>
        <Row label="MSAA samples">
          <select
            className="select-field"
            value={renderer.antialias === false ? 1 : (renderer.samples ?? 4)}
            disabled={renderer.antialias === false}
            onChange={(e) =>
              commitRenderer({ samples: parseInt(e.target.value, 10) }, "Change MSAA samples")
            }
          >
            {MSAA_SAMPLES.map((n) => (
              <option key={n} value={n}>
                {n}×
              </option>
            ))}
          </select>
        </Row>
        <Row label="Transparent">
          <input
            type="checkbox"
            checked={renderer.transparent !== false}
            onChange={(e) =>
              commitRenderer({ transparent: e.target.checked }, "Toggle transparent canvas")
            }
          />
        </Row>
      </div>

      <div className="inspector-section">
        <div className="section-header">Shadows</div>
        <Row label="Map type">
          <select
            className="select-field"
            value={shadow.type}
            onChange={(e) => commitShadow({ type: e.target.value }, "Change shadow type")}
          >
            {SHADOW_TYPE_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Row>
        <Row label="Auto update">
          <input
            type="checkbox"
            checked={shadow.autoUpdate !== false}
            onChange={(e) =>
              commitShadow({ autoUpdate: e.target.checked }, "Toggle shadow auto-update")
            }
          />
        </Row>
        <Row label="Force update">
          <input
            type="checkbox"
            checked={shadow.needsUpdate === true}
            onChange={(e) =>
              commitShadow({ needsUpdate: e.target.checked }, "Toggle shadow needs-update")
            }
          />
        </Row>
      </div>

      <div className="asset-hint" style={{ padding: "4px 10px" }}>
        Saved with the scene. Lights and meshes have their own Cast/Receive Shadow toggles.
      </div>
    </div>
  );
}
