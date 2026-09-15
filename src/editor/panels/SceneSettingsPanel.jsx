// @ts-check
import { useEffect, useState } from "react";
import { Import, MousePointer2, Pencil } from "../icons/index.jsx";
import { engine, ensureEngine } from "../engineInstance.js";
import { commandBus } from "../commands/CommandBus.js";
import { SetSceneSettingsCommand } from "../commands/settingsCommands.js";
import { useSceneStore } from "../store/sceneStore.js";
import { renameScene } from "../sceneIO.js";
import { MSAA_SAMPLES, SHADOW_TYPES, SCENE_SETTINGS_DEFAULTS } from "../../engine/sceneSettings.js";
import { ENVIRONMENT_EXTENSIONS, CUBEMAP_EXTENSIONS } from "../assetLoader.js";
import { AssetField } from "../fields/AssetField.jsx";
import { NumberField } from "../fields/NumberField.jsx";
import { EquirectPreview } from "../components/AssetThumb.jsx";
import { isEquirectPath } from "../../engine/environmentAsset.js";
import { useSelectionStore } from "../store/selectionStore.js";
import { openPanel } from "../EditorShell.jsx";
import { Row, Toggle, Note, Section } from "./settingsUi.jsx";
import { SCENE_WIND_DEFAULTS } from "../../engine/vfx/clothWind.js";

import { Select } from "../fields/Select.jsx";
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
  // A bounded number is the shared slider field (drag by position, click to type).
  if (Number.isFinite(min) && Number.isFinite(max) && max > min) return <NumberField value={value} min={min} max={max} step={step} onCommit={onCommit} />;
  return <PlainNumberInput value={value} onCommit={onCommit} min={min} max={max} step={step} />;
}

function PlainNumberInput({ value, onCommit, min, max, step = 0.1 }) {
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

const extOf = (path) => String(path ?? "").split(".").pop()?.toLowerCase() ?? "";
const isCubemap = (path) => CUBEMAP_EXTENSIONS.includes(extOf(path));

/**
 * Finds an `environment` (HDRI) COMPONENT in the open scene.
 *
 * Scenes authored before the sky moved into scene settings hold their HDRI on
 * an entity — Poly Haven's "use as sky" used to spawn one. That component still
 * works and still wins (it applies after settings do), which is exactly why the
 * panel has to say so: otherwise Scene Settings reads "Sky: None" while the
 * viewport is plainly showing an HDRI, and nothing in this panel moves it.
 */
function useLegacyEnvironmentEntity() {
  const [found, setFound] = useState(null);
  useEffect(() => {
    let live = true;
    const unsubs = [];
    ensureEngine().then((engine) => {
      if (!live) return;
      const scan = () => {
        for (const entity of engine.entities.values()) {
          const comp = entity.getComponent?.("environment");
          if (comp) return setFound({ id: entity.id, name: entity.name, props: { ...comp.props } });
        }
        setFound(null);
      };
      scan();
      // Component add/remove has no event of its own; the entity carrying one
      // is created and deleted whole, and every settings commit re-renders the
      // panel anyway, so these three cover it.
      for (const event of ["hierarchy-changed", "entity-spawned", "entity-despawned"]) {
        unsubs.push(engine.on(event, scan));
      }
    });
    return () => {
      live = false;
      for (const off of unsubs) off?.();
    };
  }, []);
  return found;
}

/**
 * The one-click migration: copy the component's HDRI + knobs into scene
 * settings and delete the entity that carried them, as ONE undoable step.
 */
function LegacyEnvironmentNote({ entity }) {
  const move = async () => {
    const { DeleteEntityCommand } = await import("../commands/entityCommands.js");
    const p = entity.props ?? {};
    // Two commands, one Ctrl+Z. Settings first: if the delete were to fail, a
    // scene with the sky in both places still renders, whereas one with the
    // entity gone and the setting unwritten has no sky at all.
    const mark = commandBus.markGroup();
    commandBus.execute(
      new SetSceneSettingsCommand(
        {
          environment: {
            cubemap: p.hdri ?? "",
            background: p.background !== false,
            // The component had no "use for lighting" switch — an HDRI on an
            // entity always lit the scene, so preserve that.
            lighting: true,
            intensity: p.intensity ?? 1,
            rotation: p.rotation ?? 0,
            blur: p.blur ?? 0,
          },
        },
        "Move HDRI into scene settings",
      ),
    );
    if (engine.getEntity(entity.id)) commandBus.execute(new DeleteEntityCommand(entity.id));
    commandBus.collapseFrom(mark, "Move HDRI into scene settings");
  };
  return (
    <>
      {/* The explanation lives in the tooltip — this panel's prose budget is
          one glyph per note, and the polish smoke enforces it. */}
      <Note danger>{`The sky comes from the ${entity.name} entity, not this slot.`}</Note>
      <button
        className="toolbar-btn wide"
        title={
          "An HDRI on an entity overrides this panel — it applies after scene settings do, so the " +
          "Sky slot above and its knobs do not reach it. Moving it in copies the HDRI, intensity, " +
          "rotation and blur into the scene and deletes the entity. One undo puts it back."
        }
        onClick={move}
      >
        <Import size={13} />
        Move into Scene Settings
      </button>
      <button
        className="toolbar-btn icon-only"
        title={`Select ${entity.name}`}
        onClick={() => {
          useSelectionStore.getState().select([entity.id]);
          openPanel("inspector");
        }}
      >
        <MousePointer2 size={13} />
      </button>
    </>
  );
}

/**
 * The scene's one name, editable. Commits on blur/Enter — renaming the file
 * per keystroke is not a thing anyone wants — and snaps back to the store's
 * name when the rename is refused (a file with that name already exists, say).
 * `renameScene` renames scenes/<name>.scene on disk, so this field, the
 * hierarchy label and the Assets entry are one name, not three.
 */
function SceneNameField({ name }) {
  const [text, setText] = useState(name);
  useEffect(() => setText(name), [name]);
  const commit = () => {
    const trimmed = text.trim();
    if (!trimmed || trimmed === name) return setText(name);
    renameScene(trimmed).catch((err) => console.error(`Couldn't rename the scene: ${err}`));
  };
  return (
    <input
      className="text-field"
      type="text"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") setText(name);
      }}
      spellCheck={false}
    />
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
  const scenePath = useSceneStore((s) => s.scenePath);
  const [settings, setSettings] = useState(null);
  const legacyEnv = useLegacyEnvironmentEntity();

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
  // ⚠ A scene saved before the wind existed has no block; the defaults stand in
  // so the panel edits a whole one rather than writing a partial.
  const wind = { ...SCENE_WIND_DEFAULTS, ...(settings.wind ?? {}) };
  const commitWind = (windPatch, label) =>
    commit({ wind: { ...wind, ...windPatch } }, label ?? "Change wind");
  const commitWindAxis = (axis, value) =>
    commitWind({ vector: wind.vector.map((v, i) => (i === axis ? value : v)) });
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
        <span className="asset-path" title={scenePath ?? "Not saved yet — the name becomes the file name on first save"}>
          {/* The name has its own editable row now; the toolbar says where the
              scene lives, which is the fact the field cannot show. */}
          {scenePath ?? `${sceneName} (not saved)`}
        </span>
      </div>

      <Section id="scene.name" title="Scene">
        <Row
          label="Name"
          hint="The scene's one name — this field, the hierarchy label and the .scene file in Assets are the same thing. Renaming here renames the file on disk."
        >
          <SceneNameField name={sceneName} />
        </Row>
      </Section>

      <Section id="scene.environment" title="Environment">
        <Row label="Background" hint="Shows wherever the sky is off. With no sky asset set, it is also the color GI lights the scene with.">
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
        <Row
          label="Sky"
          hint="A .cubemap or an HDRI (.hdr/.exr). Empty = the background color is the sky."
        >
          <AssetField
            descriptor={{ exts: ENVIRONMENT_EXTENSIONS, emptyLabel: "None" }}
            value={env.cubemap}
            onCommit={(value) => commitEnv({ cubemap: value }, "Change scene sky")}
          />
        </Row>
        {legacyEnv && <LegacyEnvironmentNote entity={legacyEnv} />}
        {env.cubemap && (
          <Row label="Show as sky" sub>
            <Toggle
              checked={env.background !== false}
              onChange={(v) => commitEnv({ background: v }, "Toggle skybox")}
            />
          </Row>
        )}
        {/* Not cubemap-gated on purpose: with no sky asset the background
            color IS the sky, and this toggle is what turns that into GI
            light — off leaves the scene lit by lamps alone. */}
        <Row
          label="Use for lighting"
          sub
          hint={
            env.cubemap
              ? "Light the scene with the sky (through GI when the GI component is on)."
              : "No sky asset — the background color lights the scene through GI instead."
          }
        >
          <Toggle
            checked={env.lighting !== false}
            onChange={(v) => commitEnv({ lighting: v }, "Toggle environment lighting")}
          />
        </Row>
        {(env.cubemap || env.lighting !== false) && (
          <Row label="Intensity" sub>
            <NumberInput
              value={env.intensity ?? 1}
              min={0}
              step={0.05}
              onCommit={(v) => commitEnv({ intensity: v }, "Change environment intensity")}
            />
          </Row>
        )}
        {env.cubemap && (
          <>
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
            {isCubemap(env.cubemap) && (
              <button
                className="toolbar-btn icon-only"
                title="Edit cube map faces"
                onClick={() => {
                  useSelectionStore.getState().selectAsset(env.cubemap);
                  openPanel("inspector");
                }}
              >
                <Pencil size={13} />
              </button>
            )}
          </>
        )}
      </Section>

      <Section id="scene.fog" title="Fog">
        <Row label="Type">
          <Select
            className="select-field"
            value={settings.fog.type}
            onChange={(e) => commitFog({ type: e.target.value })}
          >
            <option value="none">None</option>
            <option value="linear">Linear</option>
            <option value="exp2">Exponential²</option>
          </Select>
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

      {/* ⭐ ONE WIND FOR THE SCENE. Cloth reads this unless a cloth opts out with
          its own "Wind source: custom" — ten curtains each running their own
          weather is a visual mismatch, not ten microclimates. */}
      <Section id="scene.wind" title="Wind">
        <Row label="Direction (m/s²)">
          <div style={{ display: "flex", gap: 4, minWidth: 0 }}>
            {["X", "Y", "Z"].map((axis, i) => (
              <PlainNumberInput
                key={axis}
                value={wind.vector[i] ?? 0}
                step={0.1}
                onCommit={(v) => commitWindAxis(i, v)}
              />
            ))}
          </div>
        </Row>
        <Row label="Gust strength">
          <NumberInput
            value={wind.gust}
            min={0}
            max={100}
            step={0.1}
            onCommit={(v) => commitWind({ gust: v })}
          />
        </Row>
        <Row label="Gust frequency (Hz)">
          <NumberInput
            value={wind.gustFrequency}
            min={0}
            max={10}
            step={0.01}
            onCommit={(v) => commitWind({ gustFrequency: v })}
          />
        </Row>
        <Note>
          The gust is a travelling wave, so cloths sharing this field are offset
          by where they stand rather than moving in lockstep. A cloth can opt out
          with its own Wind source.
        </Note>
      </Section>

      <Section id="scene.rendering" title="Rendering">
        <Row label="Tone mapping">
          <Select
            className="select-field"
            value={settings.toneMapping}
            onChange={(e) => commit({ toneMapping: e.target.value }, "Change tone mapping")}
          >
            {TONE_MAPPING_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
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
          <Select
            className="select-field"
            value={shadow.type}
            onChange={(e) => commitShadow({ type: e.target.value }, "Change shadow type")}
          >
            {SHADOW_TYPE_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
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
          <Select
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
          </Select>
        </Row>
        <Row label="Dynamic res" hint="Move the render scale automatically to hold the target FPS.">
          <Toggle
            checked={perf.dynamicResolution === true}
            onChange={(v) => commitPerf({ dynamicResolution: v }, "Toggle dynamic resolution")}
          />
        </Row>
        <Row label="Target FPS" sub disabled={perf.dynamicResolution !== true}>
          <Select
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
          </Select>
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
      </Section>

      <Section id="scene.renderer" title="Renderer" defaultOpen={false}>
        <Note danger>Changing these rebuilds the renderer.</Note>
        <Row label="Antialias">
          <Toggle
            checked={renderer.antialias !== false}
            onChange={(v) => commitRenderer({ antialias: v }, "Toggle antialiasing")}
          />
        </Row>
        <Row label="MSAA samples" sub disabled={renderer.antialias === false}>
          <Select
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
          </Select>
        </Row>
        <Row label="Transparent canvas" hint="Let the page behind the canvas show through.">
          <Toggle
            checked={renderer.transparent !== false}
            onChange={(v) => commitRenderer({ transparent: v }, "Toggle transparent canvas")}
          />
        </Row>
        <Row
          label="Reversed depth (far-range precision)"
          hint="Fixes distant z-fighting on km-scale worlds. Rebuilds the renderer (GI and every material recompile)."
        >
          <Toggle
            checked={renderer.reversedDepth === true}
            onChange={(v) => commitRenderer({ reversedDepth: v }, "Toggle reversed depth")}
          />
        </Row>
      </Section>
    </div>
  );
}
