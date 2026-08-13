// @ts-check
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
import { Row, Toggle, Note, Section } from "./settingsUi.jsx";

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

/**
 * @param {{ value: number, onCommit: (value: number) => void, min?: number,
 *           max?: number, step?: number }} props
 */
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

function Color({ value, onChange }) {
  return (
    <input className="color-field" type="color" value={value} onChange={(e) => onChange(e.target.value)} />
  );
}

/**
 * Per-scene environment settings (saved inside the .scene file, undoable).
 * Every change is one command on the bus, applied live to the engine.
 *
 * Shares its layout language with Project Settings — see settingsUi.jsx for why
 * these rows are not the inspector's `.field-row`.
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
  const shadowsOn = settings.shadows !== false;

  return (
    <div className="inspector-panel settings-panel scene-settings-panel">
      <div className="panel-toolbar">
        <span className="asset-path" title={sceneName}>
          {sceneName}
        </span>
      </div>

      <Section id="scene.environment" title="Environment">
        <Row label="Background" hint="Shows wherever the sky is off.">
          <Color
            value={settings.background}
            onChange={(v) => commit({ background: v }, "Change background")}
          />
        </Row>
        <Row label="Ambient" hint="Flat light added everywhere, before any lamp.">
          <Color
            value={settings.ambientColor}
            onChange={(v) => commit({ ambientColor: v }, "Change ambient color")}
          />
        </Row>
        <Row label="Ambient intensity">
          <NumberInput
            value={settings.ambientIntensity}
            min={0}
            step={0.05}
            onCommit={(v) => commit({ ambientIntensity: v }, "Change ambient intensity")}
          />
        </Row>
        <Row label="Cube map" hint="Drives both the skybox and image-based lighting.">
          <AssetField
            descriptor={{ exts: CUBEMAP_EXTENSIONS, emptyLabel: "None" }}
            value={env.cubemap}
            onCommit={(value) => commitEnv({ cubemap: value }, "Change scene cube map")}
          />
        </Row>
        {env.cubemap && (
          <>
            <Row label="Show as sky" sub>
              <Toggle
                checked={env.background !== false}
                onChange={(v) => commitEnv({ background: v }, "Toggle skybox")}
              />
            </Row>
            <Row label="Use for lighting" sub>
              <Toggle
                checked={env.lighting !== false}
                onChange={(v) => commitEnv({ lighting: v }, "Toggle environment lighting")}
              />
            </Row>
            <Row label="Intensity" sub>
              <NumberInput
                value={env.intensity ?? 1}
                min={0}
                step={0.05}
                onCommit={(v) => commitEnv({ intensity: v }, "Change environment intensity")}
              />
            </Row>
            <Row label="Rotation" sub>
              <NumberInput
                value={env.rotation ?? 0}
                min={0}
                max={360}
                step={1}
                onCommit={(v) => commitEnv({ rotation: v }, "Change environment rotation")}
              />
              <span className="settings-unit">°</span>
            </Row>
            <Row label="Sky blur" sub>
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
      </Section>

      <Section id="scene.fog" title="Fog">
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
            <Color value={settings.fog.color} onChange={(v) => commitFog({ color: v })} />
          </Row>
        )}
        {settings.fog.type === "linear" && (
          <>
            <Row label="Near">
              <NumberInput
                value={settings.fog.near}
                min={0}
                step={1}
                onCommit={(v) => commitFog({ near: v })}
              />
            </Row>
            <Row label="Far">
              <NumberInput
                value={settings.fog.far}
                min={0}
                step={1}
                onCommit={(v) => commitFog({ far: v })}
              />
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
      </Section>

      <Section id="scene.rendering" title="Rendering">
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
        <Row label="Shadows" hint="Lights and meshes still have their own cast/receive toggles.">
          <Toggle
            checked={shadowsOn}
            onChange={(v) => commit({ shadows: v }, "Toggle shadows")}
          />
        </Row>
        {/* The three shadow knobs used to be their own section, which read as a
            second, competing shadow switch. Nested under the one that gates
            them, greyed out when it is off, they read as what they are. */}
        <Row label="Map type" sub disabled={!shadowsOn}>
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
        <Row
          label="Auto update"
          sub
          disabled={!shadowsOn}
          hint="Redraw shadow maps every frame. Off freezes them until something asks for an update."
        >
          <Toggle
            checked={shadow.autoUpdate !== false}
            onChange={(v) => commitShadow({ autoUpdate: v }, "Toggle shadow auto-update")}
          />
        </Row>
        <Row
          label="Force update"
          sub
          disabled={!shadowsOn}
          hint="Redraw the frozen maps once on the next frame."
        >
          <Toggle
            checked={shadow.needsUpdate === true}
            onChange={(v) => commitShadow({ needsUpdate: v }, "Toggle shadow needs-update")}
          />
        </Row>
      </Section>

      <Section id="scene.performance" title="Performance">
        <Row
          label="Max pixel ratio"
          hint="Upper bound on devicePixelRatio — the cheapest win on a HiDPI display."
        >
          <NumberInput
            value={perf.maxDevicePixelRatio ?? 2}
            min={0.5}
            max={4}
            step={0.25}
            onCommit={(v) => commitPerf({ maxDevicePixelRatio: v }, "Change max device pixel ratio")}
          />
        </Row>
        <Row label="Render scale" hint="Render below the canvas size and upscale.">
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
        <Row label="Dynamic res" hint="Move the render scale automatically to hold the target FPS.">
          <Toggle
            checked={perf.dynamicResolution === true}
            onChange={(v) => commitPerf({ dynamicResolution: v }, "Toggle dynamic resolution")}
          />
        </Row>
        <Row label="Target FPS" sub disabled={perf.dynamicResolution !== true}>
          <select
            className="select-field"
            value={String(perf.targetFps ?? 60)}
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
        <Row label="Volume quality" hint="Ray-march step size for volumetric materials. Lower is faster.">
          <NumberInput
            value={perf.volumeStepScale ?? 1}
            min={0.1}
            max={1}
            step={0.05}
            onCommit={(v) => commitPerf({ volumeStepScale: v }, "Change volume quality")}
          />
        </Row>
        <Row
          label="Occlusion culling"
          hint="Hide objects the depth buffer says are behind something else. Costs a low-res depth pass every frame: a win indoors and in dense cities, a small loss in open landscape. Watch Draw calls in the viewport stats — that is the number it moves."
        >
          <Toggle
            checked={perf.occlusionCulling === true}
            onChange={(v) => commitPerf({ occlusionCulling: v }, "Toggle occlusion culling")}
          />
        </Row>
        <Note>Applied live. Tune against the GPU ms readout — 16.7 ms = 60 fps.</Note>
      </Section>

      <Section id="scene.renderer" title="Renderer" defaultOpen={false}>
        <Note>Changing these rebuilds the renderer.</Note>
        <Row label="Antialias">
          <Toggle
            checked={renderer.antialias !== false}
            onChange={(v) => commitRenderer({ antialias: v }, "Toggle antialiasing")}
          />
        </Row>
        <Row label="MSAA samples" sub disabled={renderer.antialias === false}>
          <select
            className="select-field"
            value={renderer.antialias === false ? 1 : (renderer.samples ?? 4)}
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
        <Row label="Transparent canvas" hint="Let the page behind the canvas show through.">
          <Toggle
            checked={renderer.transparent !== false}
            onChange={(v) => commitRenderer({ transparent: v }, "Toggle transparent canvas")}
          />
        </Row>
      </Section>

      <Note footer>Saved with the scene. Project-wide settings live in Project Settings.</Note>
    </div>
  );
}
