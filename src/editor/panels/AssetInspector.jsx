// @ts-nocheck
import { useEffect, useRef, useState } from "react";
import {
  Archive,
  AudioWaveform,
  Braces,
  Brush,
  ChevronRight,
  Copy,
  CopyPlus,
  ExternalLink,
  FileCode2,
  FolderOpen,
  Globe,
  Grid3x3,
  Layers,
  MousePointerClick,
  Package,
  PackageOpen,
  Palette,
  Play,
  Plus,
  Search,
  Tag,
  Trash2,
  Type,
  Workflow,
} from "lucide-react";
import * as THREE from "three/webgpu";
import { createGltfLoader } from "../../engine/gltfLoader.js";
import { useSelectionStore } from "../store/selectionStore.js";
import { useProjectStore } from "../store/projectStore.js";
import {
  toBlobUrl,
  extOf,
  invalidateBlobUrl,
  readAssetMeta,
  TEXTURE_EXTENSIONS,
  AUDIO_EXTENSIONS,
  FONT_EXTENSIONS,
  SCRIPT_EXTENSIONS,
} from "../assetLoader.js";
import { assetActions } from "../assetActions.js";
import { CodeEditor } from "../components/CodeEditor.jsx";
import { AudioScrubber } from "../components/AudioScrubber.jsx";
import {
  CUBEMAP_DEFAULTS,
  CUBEMAP_FACES,
  invalidateCubemapAsset,
  isCubemapComplete,
  normalizeCubemapDef,
} from "../../engine/cubemapAsset.js";
import { AssetField } from "../fields/AssetField.jsx";
import { TEXTURE_META_DEFAULTS } from "../../engine/textureMeta.js";
import {
  MATERIAL_PIPELINE_DEFAULTS,
  MATERIAL_VOLUME_PIPELINE_DEFAULTS,
  loadMaterialAsset,
  refreshMaterialsUsingTexture,
  updateMaterialPipeline,
} from "../../engine/materialAsset.js";
import { openPanel } from "../EditorShell.jsx";
import { syncScriptClassNameAfterRename } from "../scriptClassSync.js";
import { TagField } from "../fields/TagField.jsx";
import {
  ASSET_FLAG_DEFAULTS,
  allAssetTags,
  readAssetFlags,
  setAssetFlags,
  useAssetFlagsStore,
} from "../assetFlags.js";
import { openPrefabMode } from "../prefab.js";
import { useModulesStore } from "../modules.js";
import { prefabRegistry, resolvePrefab, isPrefabDef } from "../../engine/index.js";
import { throttlePreviewFrame } from "../previewLoop.js";

const fileName = (p) => p?.split(/[\\/]/).pop() ?? "";
const stemOf = (name) => name.replace(/\.[^.]+$/, "");

/** Human-readable byte size, e.g. "2.4 MB". */
function formatBytes(n) {
  if (!Number.isFinite(n)) return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

async function invoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

const TYPE_LABELS = {
  png: "Texture",
  jpg: "Texture",
  jpeg: "Texture",
  webp: "Texture",
  glb: "Model",
  fbx: "FBX Source",
  geom: "Geometry",
  mat: "Material",
  cubemap: "Cube Map",
  anim: "Animator",
  timeline: "Timeline",
  atlas: "Sprite Atlas",
  prefab: "Prefab",
  entity: "Prefab (legacy)",
  js: "Script",
  ts: "Script",
  scene: "Scene",
  json: "JSON",
  ttf: "Font",
  otf: "Font",
  woff: "Font",
  woff2: "Font",
  ogg: "Audio",
  wav: "Audio",
  mp3: "Audio",
  flac: "Audio",
  m4a: "Audio",
  opus: "Audio",
  oga: "Audio",
  audio: "Audio Settings",
};

/**
 * Lucide components for the icon names `assetActions.js` hands back.
 *
 * The registry deals in names rather than components so it can be imported by
 * the headless API layer, which has no business pulling in React — this map is
 * where the two meet.
 */
const ACTION_ICONS = {
  Archive,
  AudioWaveform,
  Braces,
  Brush,
  Copy,
  CopyPlus,
  ExternalLink,
  FileCode2,
  FolderOpen,
  Globe,
  Grid3x3,
  Layers,
  MousePointerClick,
  Package,
  PackageOpen,
  Palette,
  Play,
  Plus,
  Search,
  Trash2,
  Type,
  Workflow,
};

/** Assets stored as JSON, which can therefore be shown (and hand-edited) raw. */
const JSON_SOURCE_EXTS = ["mat", "scene", "prefab", "entity", "anim", "timeline", "atlas", "cubemap", "audio"];

/**
 * Extensions with a dedicated section above. Anything else falls through to
 * `GenericPreview` — which is the difference between an unrecognised file
 * showing an empty panel and showing its facts plus what can be done with it.
 */
const KNOWN_EXTS = new Set([
  ...TEXTURE_EXTENSIONS,
  ...FONT_EXTENSIONS,
  ...SCRIPT_EXTENSIONS,
  ...AUDIO_EXTENSIONS,
  ...JSON_SOURCE_EXTS,
  "glb",
  "geom",
  "json",
]);

/** Local date/time for a mtime in seconds, or "" when unknown. */
function formatDate(seconds) {
  if (!seconds) return "";
  return new Date(seconds * 1000).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Renames the asset (and its .meta sidecar), keeping it selected. */
async function renameAsset(path, newStem) {
  const name = newStem.trim();
  const ext = extOf(path);
  const oldName = fileName(path);
  if (!name || name === stemOf(oldName)) return;
  const dir = path.slice(0, path.length - oldName.length);
  const newPath = `${dir}${name}${ext ? `.${ext}` : ""}`;
  try {
    await invoke("rename_path", { from: path, to: newPath });
    // Keep texture import settings attached across the rename.
    await invoke("rename_path", { from: `${path}.meta`, to: `${newPath}.meta` }).catch(() => {});
    await invoke("rename_path", { from: `${path}.basis`, to: `${newPath}.basis` }).catch(() => {});
    // Scripts: keep the default-exported class name in sync with the new
    // filename stem, and inject `extends Script` if missing.
    await syncScriptClassNameAfterRename(newPath, name);
    await useProjectStore.getState().refresh();
    useSelectionStore.getState().selectAsset(newPath);
    console.log(`Renamed to ${fileName(newPath)}`);
  } catch (err) {
    console.error(`Rename failed: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Texture preview + import settings (.meta sidecar)
// ---------------------------------------------------------------------------

function TexturePreview({ path }) {
  const [url, setUrl] = useState(null);
  const [dims, setDims] = useState(null);
  useEffect(() => {
    let live = true;
    setUrl(null);
    setDims(null);
    toBlobUrl(path).then((u) => live && setUrl(u)).catch(() => {});
    return () => (live = false);
  }, [path]);
  return (
    <div className="asset-preview texture-preview">
      {url && (
        <img
          src={url}
          alt=""
          draggable={false}
          onLoad={(e) => setDims({ w: e.target.naturalWidth, h: e.target.naturalHeight })}
        />
      )}
      {dims && (
        <div className="asset-preview-caption">
          {dims.w} × {dims.h}
        </div>
      )}
    </div>
  );
}

function TextureSettings({ path }) {
  const [meta, setMeta] = useState(null);
  const [basisBusy, setBasisBusy] = useState(false);
  const basisModuleEnabled = useModulesStore((s) => s.enabled.includes("basis"));

  useEffect(() => {
    let live = true;
    setMeta(null);
    (async () => {
      let m = null;
      try {
        m = JSON.parse(await invoke("read_text_file", { path: `${path}.meta` }));
      } catch {}
      if (live) setMeta({ ...TEXTURE_META_DEFAULTS, ...(m ?? {}) });
    })();
    return () => (live = false);
  }, [path]);

  if (!meta) return null;

  const patch = async (p) => {
    const next = { ...meta, ...p };
    setMeta(next);
    try {
      await invoke("save_scene", { path: `${path}.meta`, contents: JSON.stringify(next, null, 2) });
      refreshMaterialsUsingTexture(path); // live-update materials using it
      // Shipped as a sidecar — the live browser preview must rebuild too.
      invalidateBlobUrl(`${path}.meta`);
    } catch (err) {
      console.error(`Failed to save settings: ${err}`);
    }
  };

  const wrapSelect = (key) => (
    <select className="select-field" value={meta[key]} onChange={(e) => patch({ [key]: e.target.value })}>
      <option value="repeat">Repeat</option>
      <option value="clamp">Clamp</option>
      <option value="mirror">Mirror</option>
    </select>
  );

  const toggleBasis = async (enabled) => {
    setBasisBusy(true);
    try {
      const { setTextureBasisEnabled } = await import("../basisCompress.js");
      const info = await setTextureBasisEnabled(path, enabled);
      setMeta((current) => ({
        ...current,
        basis: enabled ? { enabled: true, ...info } : { enabled: false },
      }));
      refreshMaterialsUsingTexture(path);
      await useProjectStore.getState().refresh();
    } catch (err) {
      console.error(`Basis compression failed: ${err.message ?? err}`);
    } finally {
      setBasisBusy(false);
    }
  };

  return (
    <div className="inspector-section">
      <div className="section-header">Import Settings</div>
      <div className="field-row">
        <span className="field-label">Filtering</span>
        <select className="select-field" value={meta.filter} onChange={(e) => patch({ filter: e.target.value })}>
          <option value="linear">Linear</option>
          <option value="nearest">Nearest (pixel art)</option>
        </select>
      </div>
      <div className="field-row">
        <span className="field-label">Wrap U</span>
        {wrapSelect("wrapS")}
      </div>
      <div className="field-row">
        <span className="field-label">Wrap V</span>
        {wrapSelect("wrapT")}
      </div>
      <div className="field-row">
        <span className="field-label">Tiling</span>
        <div className="vector-fields">
          {[0, 1].map((i) => (
            <input
              key={i}
              className="number-field"
              type="number"
              step={0.5}
              value={meta.repeat?.[i] ?? 1}
              onChange={(e) => {
                const repeat = [...(meta.repeat ?? [1, 1])];
                repeat[i] = parseFloat(e.target.value) || 1;
                patch({ repeat });
              }}
            />
          ))}
        </div>
      </div>
      <div className="field-row">
        <span className="field-label">Flip Y</span>
        <input type="checkbox" checked={meta.flipY !== false} onChange={(e) => patch({ flipY: e.target.checked })} />
      </div>
      <div className="field-row">
        <span className="field-label">Basis</span>
        <input
          type="checkbox"
          checked={meta.basis?.enabled === true}
          disabled={basisBusy || !basisModuleEnabled}
          title={
            basisModuleEnabled
              ? "Override Basis compression for this texture"
              : "Enable the Basis Compression module first"
          }
          onChange={(e) => toggleBasis(e.target.checked)}
        />
      </div>
      {meta.basis?.enabled && meta.basis.original > 0 && (
        <div className="asset-info-row">
          {meta.basis.compressed < meta.basis.original
            ? `Basis −${Math.round((1 - meta.basis.compressed / meta.basis.original) * 100)}% · ${formatBytes(meta.basis.original)} → ${formatBytes(meta.basis.compressed)}`
            : `Basis ${formatBytes(meta.basis.compressed)}`}
        </div>
      )}
    </div>
  );
}

function MultiTextureSettings({ paths }) {
  const [metas, setMetas] = useState(null);
  useEffect(() => {
    let live = true;
    Promise.all(paths.map(async (path) => ({
      path,
      meta: { ...TEXTURE_META_DEFAULTS, ...((await readAssetMeta(`${path}.meta`)) ?? {}) },
    }))).then((value) => live && setMetas(value));
    return () => { live = false; };
  }, [paths.join("|")]);
  if (!metas?.length) return null;

  const allSame = (read) => metas.every((entry) => Object.is(read(entry.meta), read(metas[0].meta)));
  const patch = async (createPatch) => {
    const next = metas.map(({ path, meta }) => ({ path, meta: { ...meta, ...createPatch(meta) } }));
    setMetas(next);
    await Promise.all(next.map(async ({ path, meta }) => {
      await invoke("save_scene", { path: `${path}.meta`, contents: JSON.stringify(meta, null, 2) });
      refreshMaterialsUsingTexture(path);
      invalidateBlobUrl(`${path}.meta`);
    })).catch((error) => console.error(`Failed to save texture settings: ${error}`));
  };
  const select = (key, options) => {
    const same = allSame((meta) => meta[key]);
    return (
      <select className="select-field" value={same ? metas[0].meta[key] : ""} onChange={(event) => patch(() => ({ [key]: event.target.value }))}>
        {!same && <option value="">— Mixed —</option>}
        {options.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
      </select>
    );
  };
  const mixedCheckbox = (key, read = (meta) => meta[key]) => {
    const same = allSame(read);
    const ref = (element) => { if (element) element.indeterminate = !same; };
    return (
      <input
        ref={ref}
        type="checkbox"
        checked={same && !!read(metas[0].meta)}
        onChange={(event) => patch(() => ({ [key]: event.target.checked }))}
      />
    );
  };

  return (
    <div className="inspector-section">
      <div className="section-header">Shared Import Settings</div>
      <div className="field-row">
        <span className="field-label">Filtering</span>
        {select("filter", [["linear", "Linear"], ["nearest", "Nearest (pixel art)"]])}
      </div>
      <div className="field-row">
        <span className="field-label">Wrap U</span>
        {select("wrapS", [["repeat", "Repeat"], ["clamp", "Clamp"], ["mirror", "Mirror"]])}
      </div>
      <div className="field-row">
        <span className="field-label">Wrap V</span>
        {select("wrapT", [["repeat", "Repeat"], ["clamp", "Clamp"], ["mirror", "Mirror"]])}
      </div>
      <div className="field-row">
        <span className="field-label">Tiling</span>
        <div className="vector-fields">
          {[0, 1].map((axis) => {
            const same = allSame((meta) => meta.repeat?.[axis] ?? 1);
            return (
              <input
                key={axis}
                className="number-field"
                type="number"
                step={0.5}
                value={same ? (metas[0].meta.repeat?.[axis] ?? 1) : ""}
                placeholder={same ? undefined : "—"}
                onChange={(event) => {
                  const value = Number.parseFloat(event.target.value);
                  if (!Number.isFinite(value)) return;
                  patch((meta) => {
                    const repeat = [...(meta.repeat ?? [1, 1])];
                    repeat[axis] = value;
                    return { repeat };
                  });
                }}
              />
            );
          })}
        </div>
      </div>
      <div className="field-row">
        <span className="field-label">Flip Y</span>
        {mixedCheckbox("flipY", (meta) => meta.flipY !== false)}
      </div>
      <div className="asset-hint">Changes apply to all {paths.length} selected textures.</div>
    </div>
  );
}

function MultiAssetInspector({ paths }) {
  const extensions = paths.map(extOf);
  const allTextures = extensions.every((ext) => TEXTURE_EXTENSIONS.includes(ext));
  const allVirtualGeometry = extensions.every((ext) => ext === "geom" || ext === "glb");
  const sameType = extensions.every((ext) => ext === extensions[0]);
  return (
    <div className="inspector-panel">
      <div className="inspector-section multi-selection-summary">
        <div className="section-header">{paths.length} Assets Selected</div>
        <div className="field-row">
          <span className="field-label">Type</span>
          <span className="asset-type-badge">{allTextures ? "Textures" : sameType ? (TYPE_LABELS[extensions[0]] ?? extensions[0].toUpperCase()) : "Mixed"}</span>
        </div>
      </div>
      {/* Tags and build flags apply to any asset, so they batch-edit even for
          a mixed selection — which is exactly when you want them. */}
      <AssetSettingsSection paths={paths} />
      {allTextures ? <MultiTextureSettings paths={paths} /> : allVirtualGeometry ? (
        <MultiVirtualGeometrySettings paths={paths} />
      ) : (
        <div className="asset-hint">Batch editing of import settings is available when the selected assets share a type.</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Model (.glb) 3D preview: its own small WebGPU renderer + slow turntable.
// ---------------------------------------------------------------------------

function ModelPreview({ path }) {
  const canvasRef = useRef(null);
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let disposed = false;
    let renderer = null;
    let resizeObserver = null;
    setInfo(null);
    setError(null);

    (async () => {
      try {
        const gltf = await createGltfLoader().loadAsync(await toBlobUrl(path));
        let meshes = 0;
        let tris = 0;
        gltf.scene.traverse((o) => {
          const mesh = /** @type {import("three/webgpu").Mesh} */ (o);
          if (mesh.isMesh) {
            meshes++;
            tris += (mesh.geometry.index?.count ?? mesh.geometry.attributes.position?.count ?? 0) / 3;
          }
        });
        const draco = (await readAssetMeta(`${path}.meta`))?.draco ?? null;
        if (disposed) return;
        setInfo({ meshes, tris: Math.round(tris), clips: (gltf.animations ?? []).map((c) => c.name), draco });

        const canvas = canvasRef.current;
        if (!canvas) return;
        renderer = new THREE.WebGPURenderer({ canvas, antialias: true, alpha: true });
        renderer.setPixelRatio(window.devicePixelRatio ?? 1);
        await renderer.init();
        if (disposed) return;
        const width = canvas.clientWidth || 280;
        const height = canvas.clientHeight || 190;
        renderer.setSize(width, height, false);
        resizeObserver = new ResizeObserver(() => {
          const nextWidth = canvas.clientWidth;
          const nextHeight = canvas.clientHeight;
          if (nextWidth > 0 && nextHeight > 0) renderer?.setSize(nextWidth, nextHeight, false);
        });
        resizeObserver.observe(canvas);

        const scene = new THREE.Scene();
        scene.add(new THREE.HemisphereLight(0xffffff, 0x30343c, 1.4));
        const key = new THREE.DirectionalLight(0xffffff, 2.2);
        key.position.set(3, 5, 4);
        scene.add(key);
        scene.add(gltf.scene);

        const bounds = new THREE.Box3().setFromObject(gltf.scene);
        const center = bounds.getCenter(new THREE.Vector3());
        const radius = Math.max(bounds.getSize(new THREE.Vector3()).length() / 2, 0.001);
        const camera = new THREE.PerspectiveCamera(40, width / height, radius / 50, radius * 20);

        let mixer = null;
        if (gltf.animations?.length) {
          mixer = new THREE.AnimationMixer(gltf.scene);
          mixer.clipAction(gltf.animations[0]).play();
        }

        const timer = new THREE.Timer();
        let angle = 0.7;
        // Capped at PREVIEW_FPS and skipped while hidden — see previewLoop.js.
        renderer.setAnimationLoop(throttlePreviewFrame(canvas, () => {
          timer.update();
          const dt = timer.getDelta();
          angle += dt * 0.5;
          mixer?.update(dt);
          camera.position.set(
            center.x + Math.sin(angle) * radius * 2.4,
            center.y + radius * 1.1,
            center.z + Math.cos(angle) * radius * 2.4,
          );
          camera.lookAt(center);
          renderer.render(scene, camera);
        }));
      } catch (err) {
        if (!disposed) setError(String(err.message ?? err));
      }
    })();

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      renderer?.setAnimationLoop(null);
      renderer?.dispose();
    };
  }, [path]);

  return (
    <>
      <div className="asset-preview model-preview">
        {error ? <div className="asset-hint">Preview unavailable: {error}</div> : <canvas ref={canvasRef} />}
      </div>
      {info && (
        <div className="inspector-section">
          <div className="section-header">Contents</div>
          <div className="asset-info-row">
            {info.meshes} mesh{info.meshes === 1 ? "" : "es"} · {info.tris.toLocaleString()} tris
          </div>
          {info.draco?.original > 0 && (
            <div className="asset-info-row draco-info">
              {info.draco.compressed < info.draco.original ? (
                <>
                  Draco −{Math.round((1 - info.draco.compressed / info.draco.original) * 100)}% ·{" "}
                  {formatBytes(info.draco.original)} → {formatBytes(info.draco.compressed)}
                </>
              ) : (
                <>Draco: already minimal ({formatBytes(info.draco.original)})</>
              )}
            </div>
          )}
          {info.clips.length > 0 && (
            <>
              <div className="asset-info-label">Animation clips</div>
              {info.clips.map((c) => (
                <div className="asset-info-row clip" key={c}>
                  {c}
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Virtual geometry import settings (.meta sidecar) — Unreal-style: the asset
// opts in, and every Model or static Mesh using it renders through cluster LOD
// pipeline. Only shown while the virtual-geometry module is enabled.
// ---------------------------------------------------------------------------

function VirtualGeometrySettings({ path }) {
  const modulesEnabled = useModulesStore((s) => s.enabled);
  const [vg, setVg] = useState(null);

  useEffect(() => {
    let live = true;
    setVg(null);
    (async () => {
      const meta = await readAssetMeta(`${path}.meta`);
      const { VIRTUAL_GEOMETRY_META_DEFAULTS } = await import("../../modules/virtual-geometry/index.js");
      const stored = meta?.virtualGeometry ?? {};
      const merged = {
        ...VIRTUAL_GEOMETRY_META_DEFAULTS,
        enabled: stored.enabled === true,
        pixelError: stored.pixelError ?? VIRTUAL_GEOMETRY_META_DEFAULTS.pixelError,
        hysteresis: stored.hysteresis ?? VIRTUAL_GEOMETRY_META_DEFAULTS.hysteresis,
      };
      if (live) setVg(merged);
    })();
    return () => (live = false);
  }, [path]);

  if (!modulesEnabled.includes("virtual-geometry") || !vg) return null;

  const patch = async (p) => {
    const next = { ...vg, ...p };
    setVg(next);
    try {
      // Merge into the full meta — other sections (draco, …) must survive.
      const meta = (await readAssetMeta(`${path}.meta`)) ?? {};
      meta.virtualGeometry = next;
      await invoke("save_scene", { path: `${path}.meta`, contents: JSON.stringify(meta, null, 2) });
      const { refreshVirtualGeometryAsset } = await import("../../modules/virtual-geometry/index.js");
      refreshVirtualGeometryAsset(path); // live-update every open engine
      invalidateBlobUrl(`${path}.meta`);
    } catch (err) {
      console.error(`Failed to save virtual geometry settings: ${err}`);
    }
  };

  return (
    <div className="inspector-section">
      <div className="section-header">Virtual Geometry</div>
      <div className="field-row">
        <span className="field-label">Enabled</span>
        <input type="checkbox" checked={vg.enabled === true} onChange={(e) => patch({ enabled: e.target.checked })} />
      </div>
      {vg.enabled && (
        <>
          <div className="field-row">
            <span className="field-label">Pixel Error</span>
            <input
              className="number-field"
              type="number"
              min={0.25}
              max={32}
              step={0.25}
              value={vg.pixelError}
              onChange={(e) => patch({ pixelError: Math.max(0.05, parseFloat(e.target.value) || 1) })}
            />
          </div>
          <div className="field-row" title="How far the camera moves (fraction of its distance) before this mesh recomputes its LOD. Higher = less CPU, slightly laggier switches.">
            <span className="field-label">Update Dead-band</span>
            <input
              className="number-field"
              type="number"
              min={0}
              max={0.5}
              step={0.01}
              value={vg.hysteresis}
              onChange={(e) => patch({ hysteresis: Math.min(0.5, Math.max(0, parseFloat(e.target.value) || 0)) })}
            />
          </div>
          <div className="asset-hint">
            Renders static meshes through Nanite-style cluster LOD wherever this asset is used. Pixel Error is the
            screen-space error budget — higher is faster, lower is sharper. Update Dead-band trades a touch of LOD
            lag for fewer per-frame recomputes. Use the viewport's Virtual Geometry layer to color every triangle in
            the live LOD cut.
          </div>
        </>
      )}
    </div>
  );
}

function MultiVirtualGeometrySettings({ paths }) {
  const modulesEnabled = useModulesStore((state) => state.enabled);
  const [entries, setEntries] = useState(null);

  useEffect(() => {
    let live = true;
    (async () => {
      const { VIRTUAL_GEOMETRY_META_DEFAULTS } = await import("../../modules/virtual-geometry/index.js");
      const loaded = await Promise.all(paths.map(async (path) => {
        const meta = (await readAssetMeta(`${path}.meta`)) ?? {};
        const stored = meta.virtualGeometry ?? {};
        const vg = {
          ...VIRTUAL_GEOMETRY_META_DEFAULTS,
          enabled: stored.enabled === true,
          pixelError: stored.pixelError ?? VIRTUAL_GEOMETRY_META_DEFAULTS.pixelError,
          hysteresis: stored.hysteresis ?? VIRTUAL_GEOMETRY_META_DEFAULTS.hysteresis,
        };
        return { path, meta, vg };
      }));
      if (live) setEntries(loaded);
    })().catch((error) => console.error(`Failed to load virtual geometry settings: ${error}`));
    return () => { live = false; };
  }, [paths.join("|")]);

  if (!modulesEnabled.includes("virtual-geometry") || !entries?.length) return null;

  const same = (key) => entries.every((entry) => Object.is(entry.vg[key], entries[0].vg[key]));
  const patch = async (partial) => {
    const next = entries.map((entry) => ({ ...entry, vg: { ...entry.vg, ...partial } }));
    setEntries(next);
    try {
      const { refreshVirtualGeometryAsset } = await import("../../modules/virtual-geometry/index.js");
      await Promise.all(next.map(async ({ path, meta, vg }) => {
        const nextMeta = { ...meta, virtualGeometry: vg };
        await invoke("save_scene", { path: `${path}.meta`, contents: JSON.stringify(nextMeta, null, 2) });
        refreshVirtualGeometryAsset(path);
        invalidateBlobUrl(`${path}.meta`);
      }));
    } catch (error) {
      console.error(`Failed to save virtual geometry settings: ${error}`);
    }
  };

  const enabledSame = same("enabled");
  const anyEnabled = entries.some((entry) => entry.vg.enabled === true);
  const pixelSame = same("pixelError");
  return (
    <div className="inspector-section">
      <div className="section-header">Virtual Geometry</div>
      <div className="field-row">
        <span className="field-label">Enabled</span>
        <input
          ref={(element) => { if (element) element.indeterminate = !enabledSame; }}
          type="checkbox"
          checked={enabledSame && entries[0].vg.enabled === true}
          onChange={(event) => patch({ enabled: event.target.checked })}
        />
      </div>
      {(anyEnabled || !enabledSame) && (
        <>
          <div className="field-row">
            <span className="field-label">Pixel Error</span>
            <input
              className="number-field"
              type="number"
              min={0.25}
              max={32}
              step={0.25}
              key={pixelSame ? entries[0].vg.pixelError : "mixed"}
              defaultValue={pixelSame ? entries[0].vg.pixelError : ""}
              placeholder={pixelSame ? undefined : "—"}
              onBlur={(event) => {
                const value = Number.parseFloat(event.target.value);
                if (Number.isFinite(value) && (!pixelSame || value !== entries[0].vg.pixelError)) {
                  patch({ pixelError: Math.max(0.05, value) });
                }
              }}
              onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
            />
          </div>
        </>
      )}
      <div className="asset-hint">Changes apply to all {paths.length} selected geometry assets.</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cube map (.cubemap): six face slots + "use as the scene's skybox"
// ---------------------------------------------------------------------------

/** Where each face sits in the unfolded-cube preview (row/col in a 3×4 grid). */
const CUBEMAP_CROSS_CELL = {
  py: { row: 1, col: 2 },
  nx: { row: 2, col: 1 },
  pz: { row: 2, col: 2 },
  px: { row: 2, col: 3 },
  nz: { row: 2, col: 4 },
  ny: { row: 3, col: 2 },
};

/** Unfolded-cube preview — the fastest way to spot a face in the wrong slot. */
function CubemapCross({ faces }) {
  const [urls, setUrls] = useState({});
  const signature = CUBEMAP_FACES.map((face) => faces[face.key]).join("|");
  useEffect(() => {
    let live = true;
    (async () => {
      const entries = await Promise.all(
        CUBEMAP_FACES.map(async ({ key }) => {
          const path = faces[key];
          return [key, path ? await toBlobUrl(path).catch(() => null) : null];
        }),
      );
      if (live) setUrls(Object.fromEntries(entries));
    })();
    return () => {
      live = false;
    };
  }, [signature]);

  return (
    <div className="asset-preview cubemap-cross">
      {CUBEMAP_FACES.map(({ key, label, hint }) => (
        <div
          key={key}
          className={`cubemap-cross-cell${urls[key] ? "" : " empty"}`}
          style={{ gridRow: CUBEMAP_CROSS_CELL[key].row, gridColumn: CUBEMAP_CROSS_CELL[key].col }}
          title={`${label} · ${hint}`}
        >
          {urls[key] ? <img src={urls[key]} alt="" draggable={false} /> : <span>{label}</span>}
        </div>
      ))}
    </div>
  );
}

function CubemapEditor({ path }) {
  const [def, setDef] = useState(null);
  const [activeSkybox, setActiveSkybox] = useState(null); // engine's current cubemap path
  const saveQueue = useRef(Promise.resolve());

  useEffect(() => {
    let live = true;
    setDef(null);
    (async () => {
      let parsed = null;
      try {
        parsed = JSON.parse(await invoke("read_text_file", { path }));
      } catch (err) {
        console.error(`Failed to read cube map "${path}": ${err}`);
      }
      if (live) setDef(normalizeCubemapDef(parsed ?? CUBEMAP_DEFAULTS));
    })();
    return () => {
      live = false;
    };
  }, [path]);

  // Track which cube map the open scene uses, so the button reads as a toggle.
  useEffect(() => {
    let live = true;
    let unsub = null;
    import("../engineInstance.js").then(({ ensureEngine }) =>
      ensureEngine().then((engine) => {
        if (!live) return;
        const read = (settings) => setActiveSkybox(settings?.environment?.cubemap ?? "");
        read(engine.settings);
        unsub = engine.on("settings-changed", read);
      }),
    );
    return () => {
      live = false;
      unsub?.();
    };
  }, []);

  if (!def) return null;
  const samePath = (a, b) => !!a && !!b && a.replaceAll("\\", "/") === b.replaceAll("\\", "/");
  const isActive = samePath(activeSkybox, path);
  const complete = isCubemapComplete(def);

  const setFace = (key, value) => {
    const next = { ...def, faces: { ...def.faces, [key]: value || "" } };
    setDef(next);
    saveQueue.current = saveQueue.current
      .catch(() => {})
      .then(async () => {
        await invoke("save_scene", { path, contents: JSON.stringify(next, null, 2) });
        invalidateBlobUrl(path);
        // Drop the decoded texture and re-apply scene settings so a skybox
        // built from this asset picks up the new face immediately. Resolve the
        // engine BEFORE disposing: an await between dispose and re-apply would
        // leave a rendered frame pointing at a destroyed GPU texture.
        const { ensureEngine } = await import("../engineInstance.js");
        const engine = await ensureEngine();
        invalidateCubemapAsset(path);
        await engine.applySettings({});
      })
      .catch((err) => console.error(`Failed to save cube map: ${err}`));
  };

  const useAsSkybox = async (enable) => {
    const { commandBus } = await import("../commands/CommandBus.js");
    const { SetSceneSettingsCommand } = await import("../commands/settingsCommands.js");
    commandBus.execute(
      new SetSceneSettingsCommand(
        { environment: { cubemap: enable ? path : "" } },
        enable ? "Set scene skybox" : "Clear scene skybox",
      ),
    );
  };

  return (
    <>
      <CubemapCross faces={def.faces} />
      <div className="inspector-section">
        <div className="section-header">Faces</div>
        {CUBEMAP_FACES.map(({ key, label, hint }) => (
          <div className="field-row" key={key}>
            <span className="field-label" title={`${label} (${hint})`}>
              {label} {hint}
            </span>
            <AssetField
              descriptor={{ exts: TEXTURE_EXTENSIONS, emptyLabel: "None" }}
              value={def.faces[key]}
              onCommit={(value) => setFace(key, value)}
            />
          </div>
        ))}
        {!complete && (
          <div className="asset-hint">
            All six faces are required before the cube map can be used. Drop textures onto the slots
            or pick them from the dropdowns.
          </div>
        )}
      </div>
      <div className="inspector-section">
        <div className="section-header">Scene</div>
        <button
          className="toolbar-btn wide"
          disabled={!complete && !isActive}
          onClick={() => useAsSkybox(!isActive)}
        >
          <Globe size={13} />
          {isActive ? "Remove from Scene Environment" : "Set as Scene Environment"}
        </button>
        <div className="asset-hint">
          {isActive
            ? "This cube map is the scene's skybox and image-based lighting source. Tune intensity, rotation and blur in Scene Settings → Environment."
            : "Sets Scene Settings → Environment → Cube Map, which drives both the skybox and image-based lighting."}
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Animator / prefab summaries
// ---------------------------------------------------------------------------

function JsonSummary({ path, render }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    let live = true;
    setData(null);
    invoke("read_text_file", { path })
      .then((text) => live && setData(JSON.parse(text)))
      .catch(() => {});
    return () => (live = false);
  }, [path]);
  return data ? render(data) : null;
}

function MaterialSummary({ path }) {
  const [def, setDef] = useState(null);
  const defRef = useRef(null);
  const saveQueue = useRef(Promise.resolve());

  useEffect(() => {
    let live = true;
    defRef.current = null;
    setDef(null);
    Promise.all([
      invoke("read_text_file", { path }).then((text) => JSON.parse(text)),
      loadMaterialAsset(path),
    ]).then(([loaded]) => {
      if (!live) return;
      defRef.current = loaded;
      setDef(loaded);
    }).catch((error) => console.error(`Failed to inspect material: ${error}`));
    return () => { live = false; };
  }, [path]);

  if (!def) return null;
  const output = def.shaderGraph?.nodes?.find((node) => node.type === "output");
  const isVolume = !!output && (def.shaderGraph?.edges ?? []).some(
    (edge) => edge.target === output.id && edge.targetHandle === "volume",
  );
  const defaults = isVolume ? MATERIAL_VOLUME_PIPELINE_DEFAULTS : MATERIAL_PIPELINE_DEFAULTS;
  const pipeline = { ...defaults, ...(def.pipeline ?? {}) };

  const patchPipeline = (patch) => {
    const current = defRef.current;
    if (!current) return;
    const nextPipeline = { ...defaults, ...(current.pipeline ?? {}), ...patch };
    const next = { ...current, pipeline: nextPipeline };
    defRef.current = next;
    setDef(next);
    updateMaterialPipeline(path, nextPipeline);
    saveQueue.current = saveQueue.current.catch(() => {}).then(async () => {
      await invoke("save_scene", { path, contents: JSON.stringify(next, null, 2) });
      invalidateBlobUrl(path);
    }).catch((error) => console.error(`Failed to save material pipeline: ${error}`));
  };

  const toggle = (key, label, title) => (
    <div className="field-row" title={title}>
      <span className="field-label">{label}</span>
      <input type="checkbox" checked={!!pipeline[key]} onChange={(event) => patchPipeline({ [key]: event.target.checked })} />
    </div>
  );

  /** @type {(key: string, label: string, opts?: { min?: number, max?: number, step?: number }) => any} */
  const number = (key, label, { min, max, step = 0.1 } = {}) => (
    <div className="field-row">
      <span className="field-label">{label}</span>
      <input
        key={`${key}-${pipeline[key]}`}
        className="number-field"
        type="number"
        defaultValue={pipeline[key]}
        min={min}
        max={max}
        step={step}
        onBlur={(event) => {
          let value = Number(event.target.value);
          if (!Number.isFinite(value)) return;
          if (min != null) value = Math.max(min, value);
          if (max != null) value = Math.min(max, value);
          patchPipeline({ [key]: value });
        }}
        onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
      />
    </div>
  );

  return (
    <>
      <div className="inspector-section">
          <div className="section-header">Material</div>
          <div className="asset-info-row">
            {def.shaderGraph?.nodes?.length
              ? `${def.shaderGraph.nodes.length} nodes · ${(def.shaderGraph.edges ?? []).length} connections`
              : "No shader graph — open the editor to build one"}
          </div>
          <button
            className="toolbar-btn wide"
            onClick={() => {
              useSelectionStore.getState().selectAsset(path);
              openPanel("shaderGraph");
            }}
          >
            <Workflow size={13} />
            Open Shader Graph
          </button>
      </div>
      <div className="inspector-section">
        <div className="section-header">Pipeline</div>
        <div className="field-row">
          <span className="field-label">Cull Mode</span>
          <select className="select-field" value={pipeline.cullMode} onChange={(event) => patchPipeline({ cullMode: event.target.value })}>
            <option value="back">Back Faces</option>
            <option value="front">Front Faces</option>
            <option value="none">None (Double-Sided)</option>
          </select>
        </div>
        {toggle("depthTest", "Depth Test")}
        {toggle("depthWrite", "Depth Write")}
        <div className="field-row">
          <span className="field-label">Depth Function</span>
          <select className="select-field" value={pipeline.depthFunc} disabled={!pipeline.depthTest} onChange={(event) => patchPipeline({ depthFunc: event.target.value })}>
            <option value="less-equal">Less or Equal</option>
            <option value="less">Less</option>
            <option value="equal">Equal</option>
            <option value="greater-equal">Greater or Equal</option>
            <option value="greater">Greater</option>
            <option value="not-equal">Not Equal</option>
            <option value="always">Always</option>
            <option value="never">Never</option>
          </select>
        </div>
        {toggle("colorWrite", "Color Write")}
        {toggle("transparent", "Transparent")}
        <div className="field-row">
          <span className="field-label">Blend Mode</span>
          <select className="select-field" value={pipeline.blendMode} onChange={(event) => patchPipeline({ blendMode: event.target.value })}>
            <option value="normal">Normal</option>
            <option value="additive">Additive</option>
            <option value="subtractive">Subtractive</option>
            <option value="multiply">Multiply</option>
            <option value="none">Disabled</option>
          </select>
        </div>
        {number("alphaTest", "Alpha Clip", { min: 0, max: 1, step: 0.01 })}
        {toggle("alphaHash", "Alpha Hash", "Stochastic alpha testing for dithered cutouts")}
        {toggle("premultipliedAlpha", "Premultiplied Alpha")}
        {toggle("polygonOffset", "Polygon Offset")}
        {pipeline.polygonOffset && number("polygonOffsetFactor", "Offset Factor", { step: 1 })}
        {pipeline.polygonOffset && number("polygonOffsetUnits", "Offset Units", { step: 1 })}
        {toggle("wireframe", "Wireframe")}
        {toggle("toneMapped", "Tone Mapped")}
        {toggle("fog", "Affected by Fog")}
        <div className="asset-hint">Pipeline changes update every mesh using this material.</div>
      </div>
    </>
  );
}

function AnimatorSummary({ path }) {
  return (
    <JsonSummary
      path={path}
      render={(graph) => (
        <div className="inspector-section">
          <div className="section-header">Controller</div>
          <div className="asset-info-row">
            {(graph.states ?? []).length} states · {(graph.transitions ?? []).length} transitions ·{" "}
            {(graph.parameters ?? []).length} parameters
          </div>
          <button
            className="toolbar-btn wide"
            onClick={() => {
              useSelectionStore.getState().selectAsset(path);
              openPanel("animator");
            }}
          >
            <Workflow size={13} />
            Edit Animator
          </button>
        </div>
      )}
    />
  );
}

/** Entities in a resolved prefab tree, counted for the summary line. */
function countNodes(node) {
  if (!node) return 0;
  return 1 + (node.children ?? []).reduce((sum, child) => sum + countNodes(child), 0);
}

function PrefabSummary({ path }) {
  return (
    <JsonSummary
      path={path}
      render={(file) => {
        // `.prefab` files are defs; legacy `.entity` files are bare snapshots.
        const def = isPrefabDef(file) ? file : null;
        const guid = def?.guid ?? prefabRegistry.guidForPath(path);
        const resolved = guid ? resolvePrefab(guid) : null;
        const base = def?.variantOf ? prefabRegistry.getDef(prefabRegistry.resolveLink(def.variantOf)) : null;
        const name = def?.name ?? file.name ?? "Prefab";
        const entities = resolved ? countNodes(resolved) : countNodes(file);
        const components = resolved
          ? (resolved.components ?? []).map((c) => c.type)
          : (file.components ?? []).map((c) => c.type);

        return (
          <div className="inspector-section">
            <div className="section-header">Prefab</div>
            <div className="asset-info-row">
              <Package size={13} /> {name} · {entities} {entities === 1 ? "entity" : "entities"}
              {components.length ? ` · ${components.join(", ")}` : ""}
            </div>
            {base && <div className="asset-info-row">Variant of {base.name}</div>}
            {!def && (
              <div className="asset-hint">
                Legacy snapshot — it still works, but it isn't linked. Instances of it won't track edits to this file.
              </div>
            )}
            <button className="toolbar-btn wide" onClick={() => openPrefabMode(path)}>
              <Package size={13} />
              Open Prefab
            </button>
            <div className="asset-hint">Drag into the viewport or hierarchy to add a linked instance.</div>
          </div>
        );
      }}
    />
  );
}

// ---------------------------------------------------------------------------

/** Shown when an Assets-panel file is selected instead of an entity. */
/**
 * Tags + build behaviour for one or more assets.
 *
 * The three load modes are the whole story of how an asset reaches the game:
 * preloaded (resident before the first frame), on-demand (the default —
 * fetched when the scene first asks for it), or excluded (present in the
 * project, absent from the build). Presenting them as two toggles with an
 * explicit "on demand" resting state keeps that legible instead of hiding it
 * behind a pair of unrelated checkboxes.
 */
/**
 * Audition an audio asset without leaving the Inspector.
 *
 * A bare `<audio controls>` would have been one line, and it's the wrong answer:
 * it renders the browser's chrome (which matches nothing else in the editor),
 * and it shows a scrub bar with no waveform — so you can't see where the sound
 * actually is, which is the one thing you want when checking whether a file is
 * the footstep you meant. This decodes through the same core the Audio Editor
 * uses and draws the real peaks, so what you see here and there agree.
 *
 * Decoding is the expensive part, so it happens once per path and is abandoned
 * cleanly if the selection changes mid-decode.
 */
/**
 * How big a sound may be before the Inspector stops drawing its waveform.
 *
 * Decoding is *expensive in a way that is not obvious from the file size*.
 * Getting a waveform for a 55 MB FLAC means holding, at the same moment: the
 * raw bytes, a copy of them (decodeAudioData detaches the buffer it is given),
 * the decoded AudioBuffer — 3 minutes of 48 kHz stereo float is ~70 MB — and,
 * previously, another full copy of that as Float32Arrays. Next to a WebGPU
 * renderer that is enough to run the tab out of memory and take the editor with
 * it, which is exactly what happened.
 *
 * Past this size the preview still plays and still reports duration (the media
 * element knows both); it just doesn't draw. The Audio Editor is where a long
 * file gets opened properly.
 */
const PREVIEW_DECODE_LIMIT = 24 * 1024 * 1024;

function AudioPreview({ path }) {
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);
  const [src, setSrc] = useState(null);

  useEffect(() => {
    let live = true;
    setInfo(null);
    setError(null);
    setSrc(null);
    (async () => {
      try {
        // The blob URL is what plays; it's cheap and independent of decoding.
        const url = await toBlobUrl(path);
        if (!live) return;
        setSrc(url);

        const raw = await invoke("read_binary_file", { path });
        if (!live) return;
        const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array(raw);

        // Measured from the bytes we already hold, deliberately NOT from a
        // `file_size` round trip: reading is cheap (one buffer) and decoding is
        // what costs, so the check belongs after the read and before the decode.
        // Asking the backend for a size would also make this silently
        // unenforceable anywhere that command isn't available — which is exactly
        // how the first version of this cap failed to fire.
        if (bytes.byteLength > PREVIEW_DECODE_LIMIT) {
          setInfo({ peaks: null, tooLarge: true, sizeMb: bytes.byteLength / 1048576 });
          return;
        }

        const { decodeAudioBytes } = await import("../audio/decode.js");
        const pcm = await decodeAudioBytes(bytes);
        if (!live) return;

        const { buildPeaks } = await import("../audio/peaks.js");
        const { peak } = await import("../audio/pcm.js");
        const peaks = buildPeaks(pcm);
        const level = peak(pcm);
        const frames = pcm.channels[0]?.length ?? 0;
        // Keep the summary, drop the samples. `peaks` is well under 1% of the
        // decoded audio, and the Inspector only ever draws the whole file at
        // once — the zoomed-in path that would need real samples belongs to the
        // Audio Editor. Holding `pcm` here was tens of megabytes retained for
        // a 52-pixel-tall drawing.
        setInfo({
          peaks,
          sampleRate: pcm.sampleRate,
          channels: pcm.channels.length,
          seconds: frames / pcm.sampleRate,
          peakDb: level > 0 ? 20 * Math.log10(level) : null,
          clipping: level > 1,
        });
      } catch (err) {
        if (live) setError(err.message ?? String(err));
      }
    })();
    return () => {
      live = false;
    };
  }, [path]);

  return (
    <div className="inspector-section audio-preview">
      <div className="inspector-section-title">Preview</div>
      {error ? (
        <div className="audio-preview-error">{error}</div>
      ) : (
        <>
          {/* The same control the Audio Library rows use, sharing one player —
              auditioning a search result stops this, and vice versa. */}
          <AudioScrubber
            id={`asset:${path}`}
            src={src}
            peaks={info?.peaks ?? null}
            duration={info?.seconds ?? 0}
            variant="block"
            disabled={!src}
          />
          <div className="audio-preview-row">
            <span className="audio-preview-meta">
              {info?.tooLarge
                ? `${info.sizeMb.toFixed(0)} MB — too large to draw here; open it in the Audio Editor`
                : info
                  ? `${info.sampleRate} Hz · ${info.channels === 1 ? "mono" : `${info.channels}ch`}${
                      info.peakDb != null ? ` · peak ${info.peakDb.toFixed(1)} dB` : ""
                    }${info.clipping ? " · CLIPPING" : ""}`
                  : "Decoding…"}
            </span>
          </div>
          <button
            className="toolbar-btn wide"
            onClick={() => import("../openAsset.js").then((m) => m.openAssetPath(path))}
          >
            Open in Audio Editor
          </button>
        </>
      )}
    </div>
  );
}

function AssetSettingsSection({ paths }) {
  // Select the map, not a derived array: a selector that builds a new array on
  // every call gives useSyncExternalStore a different snapshot each render and
  // spins.
  const flagMap = useAssetFlagsStore((s) => s.flags);
  const key = paths.join("|");
  useEffect(() => {
    // Read straight from disk rather than going through the folder-listing
    // loader: the inspector can be showing an asset the grid never listed, and
    // one read per selected asset is nothing at inspector scale.
    let live = true;
    (async () => {
      const patch = {};
      for (const path of paths) patch[path] = await readAssetFlags(path);
      if (live) useAssetFlagsStore.getState().merge(patch);
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const values = paths.map((path) => flagMap[path] ?? ASSET_FLAG_DEFAULTS);
  const every = (read) => values.length > 0 && values.every(read);
  const preload = every((entry) => entry.preload);
  const exclude = every((entry) => entry.exclude);
  const mixed = (read) => !values.every((entry) => read(entry) === read(values[0]));

  // Only tags shared by every selected asset are editable together.
  const tagLists = values.map((entry) => entry.tags ?? []);
  const sharedTags = (tagLists[0] ?? []).filter((tag) => tagLists.every((list) => list.includes(tag)));

  const commitTags = (next) => {
    const added = next.filter((tag) => !sharedTags.includes(tag));
    const removed = sharedTags.filter((tag) => !next.includes(tag));
    // Per-asset merge, so an asset's own extra tags survive a multi-edit.
    Promise.all(
      paths.map((path, index) => {
        const own = tagLists[index] ?? [];
        const merged = [...new Set([...own.filter((tag) => !removed.includes(tag)), ...added])];
        return setAssetFlags([path], { tags: merged });
      }),
    ).catch((err) => console.error(`Couldn't update tags: ${err}`));
  };

  const mode = exclude ? "exclude" : preload ? "preload" : "demand";

  return (
    <div className="inspector-section">
      <div className="section-header">
        <span className="section-title">
          <Tag size={13} style={{ color: "#3fd0c9" }} />
          Tags &amp; Build
        </span>
      </div>
      <div className="field-row tags-row">
        <span className="field-label">Tags</span>
        <TagField tags={sharedTags} suggestions={allAssetTags()} onChange={commitTags} />
      </div>
      <div className="field-row">
        <span className="field-label" title="Load during the boot phase so this is ready before the first frame">
          Preload
        </span>
        <input
          type="checkbox"
          checked={preload}
          ref={(el) => el && (el.indeterminate = mixed((entry) => entry.preload))}
          onChange={(e) => setAssetFlags(paths, { preload: e.target.checked })}
        />
      </div>
      <div className="field-row">
        <span className="field-label" title="Keep the file in the project, but leave it out of exported games">
          Exclude
        </span>
        <input
          type="checkbox"
          checked={exclude}
          ref={(el) => el && (el.indeterminate = mixed((entry) => entry.exclude))}
          onChange={(e) => setAssetFlags(paths, { exclude: e.target.checked })}
        />
      </div>
      <div className="asset-hint">
        {mode === "exclude"
          ? "Stays in the project; never ships in a build."
          : mode === "preload"
            ? "Loaded up front — ready the moment the game starts."
            : "Loaded on demand, the first time the scene needs it."}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cross-type sections: file facts and the action list
// ---------------------------------------------------------------------------

/**
 * Size and last-modified, for any file.
 *
 * Trivial, and it was missing from every asset type — so the Inspector could
 * not answer "is this the 4K version or the 1K one" or "did my import actually
 * overwrite it", both of which are questions you ask of the Inspector because
 * that is where an asset's facts are supposed to live.
 */
function FileFacts({ path }) {
  const [facts, setFacts] = useState(null);
  useEffect(() => {
    let live = true;
    setFacts(null);
    Promise.all([
      invoke("file_size", { path }).catch(() => null),
      invoke("stat_file", { path }).catch(() => null),
    ]).then(([size, modified]) => live && setFacts({ size, modified }));
    return () => {
      live = false;
    };
  }, [path]);
  if (!facts?.size && !facts?.modified) return null;
  return (
    <div className="asset-facts">
      {facts.size != null && <span>{formatBytes(facts.size)}</span>}
      {facts.modified ? <span>{formatDate(facts.modified)}</span> : null}
    </div>
  );
}

/**
 * Everything you can do with this asset, spelled out.
 *
 * The old Inspector had a scattering of one-off buttons — "Open Shader Graph"
 * on materials, "Open Prefab" on prefabs — and nothing at all on half the
 * types, so the answer to "what can I do with a `.timeline`?" was to right-
 * click in a different panel and hope. Listing the actions with a sentence
 * each turns the Inspector into the place that answers that, which is what
 * someone selecting an unfamiliar file is asking.
 *
 * Actions that can't run right now (assign-to-selection with nothing selected)
 * are shown disabled with the reason, rather than hidden: a control that
 * appears and disappears teaches nothing about why.
 */
function AssetActionsSection({ path }) {
  const [visible, setVisible] = useState([]);
  const [running, setRunning] = useState(null);
  // Subscribing to the entity selection is what keeps "Assign to Selected"
  // enabling itself the moment something is clicked in the viewport.
  const selectedIds = useSelectionStore((state) => state.ids);

  useEffect(() => {
    let live = true;
    (async () => {
      const actions = assetActions(path);
      const allowed = [];
      for (const action of actions) {
        // `available` is async because some checks (is this text-editable, is
        // the Draco module on) live behind a lazy import we don't want in the
        // boot graph.
        if (action.available && !(await action.available())) continue;
        allowed.push(action);
      }
      if (live) setVisible(allowed);
    })();
    return () => {
      live = false;
    };
  }, [path]);

  if (!visible.length) return null;

  const run = async (action) => {
    setRunning(action.id);
    try {
      await action.run();
    } catch (error) {
      console.error(`${action.label} failed: ${error?.message ?? error}`);
    } finally {
      setRunning(null);
    }
  };

  return (
    <div className="inspector-section asset-actions">
      <div className="section-header">Actions</div>
      {visible.map((action) => {
        const Icon = ACTION_ICONS[action.icon] ?? ChevronRight;
        const enabled = action.enabled ? action.enabled() : true;
        return (
          <button
            key={action.id}
            className={`asset-action${action.primary ? " primary" : ""}${action.danger ? " danger" : ""}`}
            disabled={!enabled || running === action.id}
            onClick={() => run(action)}
            title={enabled ? action.hint : `${action.hint} (select an entity first)`}
          >
            <Icon size={14} className="asset-action-icon" />
            <span className="asset-action-text">
              <span className="asset-action-label">{action.label}</span>
              <span className="asset-action-hint">{action.hint}</span>
            </span>
          </button>
        );
      })}
      {!selectedIds.length && visible.some((action) => action.enabled) && (
        <div className="asset-hint">Some actions need an entity selected in the scene.</div>
      )}
    </div>
  );
}

/**
 * A collapsible raw-source view for anything the code editor can render.
 *
 * Offered on JSON-backed assets (`.mat`, `.scene`, `.atlas`, `.meta`) because
 * they are readable, occasionally need a hand edit, and the alternative was
 * launching an external editor. Collapsed by default — Monaco is several
 * megabytes, so nothing loads until it is opened.
 */
function SourceSection({ path, label = "Source", defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="inspector-section">
      <button className={`section-header toggle${open ? " open" : ""}`} onClick={() => setOpen(!open)}>
        <ChevronRight size={12} className="section-chevron" />
        {label}
      </button>
      {open && (
        <div className="asset-source">
          {/* Keyed by section rather than by file: how tall you want a raw-JSON
              pane is a property of the job, not of the particular `.mat` open
              at the time, and a per-file size would mean re-dragging it for
              every asset. */}
          <CodeEditor path={path} height={260} compact toolbar resizable storageKey="inspector-source" />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Script assets
// ---------------------------------------------------------------------------

/** Rough facts about a script, read from its text without compiling it. */
function summarizeScript(text) {
  const lines = text.split("\n");
  const className = /export\s+default\s+class\s+([A-Za-z0-9_$]+)/.exec(text)?.[1] ?? null;
  const extendsScript = /class\s+[A-Za-z0-9_$]+\s+extends\s+Script\b/.test(text);
  const attributes = [...text.matchAll(/@attribute\s*\(([^)]*)\)\s*\n?\s*([A-Za-z0-9_$]+)/g)].map(
    (match) => match[2],
  );
  const hooks = ["onStart", "onUpdate", "onFixedUpdate", "onDestroy", "onEnable", "onDisable"].filter(
    (hook) => new RegExp(`\\b${hook}\\s*\\(`).test(text),
  );
  return { lines: lines.length, className, extendsScript, attributes, hooks };
}

/**
 * A script, editable in place.
 *
 * The Inspector is where you land after clicking a file, and for a script the
 * only useful thing to show there is the code — which meant, until now, a
 * button that opened a different application. The editor is the real one
 * (autocompletion against `engine.d.ts`, diagnostics, formatting), just short:
 * the Inspector column is 320px, so it's for reading and small fixes, and the
 * Code panel is one click away when the edit gets real.
 */
function ScriptInspector({ path }) {
  const [facts, setFacts] = useState(null);
  useEffect(() => {
    let live = true;
    setFacts(null);
    invoke("read_text_file", { path })
      .then((text) => live && setFacts(summarizeScript(text)))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [path]);

  return (
    <>
      {facts && (
        <div className="inspector-section">
          <div className="section-header">Script</div>
          <div className="asset-info-row">
            {facts.className ? `class ${facts.className}` : "No default-exported class"}
            {" · "}
            {facts.lines} lines
          </div>
          {facts.className && !facts.extendsScript && (
            <div className="asset-hint warn">
              This class doesn't extend <code>Script</code>, so the engine can't attach it to an entity.
            </div>
          )}
          {facts.hooks.length > 0 && (
            <div className="asset-info-row">Hooks: {facts.hooks.join(", ")}</div>
          )}
          {facts.attributes.length > 0 && (
            <div className="asset-info-row">
              Inspector fields: {facts.attributes.join(", ")}
            </div>
          )}
        </div>
      )}
      <div className="inspector-section asset-code">
        <div className="section-header">Code</div>
        <CodeEditor path={path} height={320} compact resizable storageKey="inspector-script" />
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

/** Sample lines a specimen shows, from headline down to body. */
const SPECIMEN_SIZES = [32, 22, 16, 12];

/**
 * A font specimen plus everything the file declares about itself.
 *
 * A font asset has no visual thumbnail worth the name — the only useful
 * preview is the alphabet, at several sizes, in the actual face. The metadata
 * underneath answers the questions you can't answer by looking: does it have
 * the glyphs my localisation needs, is it hinted, and — the one that matters
 * before shipping — does its embedding permission allow it in a build.
 */
function FontPreview({ path }) {
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  const [sample, setSample] = useState("Sphinx of black quartz, judge my vow");

  useEffect(() => {
    let live = true;
    setState(null);
    setError(null);
    import("../../engine/ui/fontAsset.js")
      .then(({ ensureFontLoaded }) => ensureFontLoaded(path))
      .then((entry) => live && setState(entry))
      .catch((err) => live && setError(String(err?.message ?? err)));
    return () => {
      live = false;
    };
  }, [path]);

  const meta = state?.meta ?? null;
  const family = state?.loaded ? `"${state.family}"` : "inherit";

  return (
    <>
      <div className="asset-preview font-preview">
        {error ? (
          <div className="asset-hint">Can't load this font: {error}</div>
        ) : (
          <>
            <div className="font-specimen-alphabet" style={{ fontFamily: family }}>
              ABCDEFGHIJKLMNOPQRSTUVWXYZ
              <br />
              abcdefghijklmnopqrstuvwxyz
              <br />
              0123456789 &amp;.,;:!? @#$%
            </div>
            {SPECIMEN_SIZES.map((size) => (
              <div key={size} className="font-specimen-line" style={{ fontFamily: family, fontSize: size }}>
                {sample || "The quick brown fox"}
              </div>
            ))}
          </>
        )}
      </div>
      <div className="inspector-section">
        <div className="field-row">
          <span className="field-label">Sample</span>
          <input
            className="text-field"
            type="text"
            value={sample}
            onChange={(event) => setSample(event.target.value)}
          />
        </div>
      </div>
      {meta && (
        <div className="inspector-section">
          <div className="section-header">Font</div>
          {state.displayName && <div className="asset-info-row">{state.displayName}</div>}
          {meta.readable ? (
            <>
              {meta.subfamily && (
                <div className="asset-info-row">
                  {meta.subfamily}
                  {meta.weight ? ` · weight ${meta.weight}` : ""}
                  {meta.width && meta.width !== "normal" ? ` · ${meta.width}` : ""}
                  {meta.italic ? " · italic" : ""}
                </div>
              )}
              <div className="asset-info-row">
                {meta.glyphs != null ? `${meta.glyphs.toLocaleString()} glyphs` : ""}
                {meta.codepoints != null ? ` · ${meta.codepoints.toLocaleString()} codepoints` : ""}
                {meta.unitsPerEm ? ` · ${meta.unitsPerEm} upem` : ""}
              </div>
              <div className="asset-info-row">
                {[
                  meta.outlines,
                  meta.variable ? "variable" : null,
                  meta.monospaced ? "monospaced" : null,
                  meta.hinted ? "hinted" : null,
                  meta.kerning ? "kerning" : null,
                  meta.colorGlyphs ? "colour glyphs" : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
              {meta.coverage?.length > 0 && (
                <>
                  <div className="asset-info-label">Scripts covered</div>
                  <div className="font-coverage">
                    {meta.coverage.map((block) => (
                      <span className="font-coverage-chip" key={block}>
                        {block}
                      </span>
                    ))}
                  </div>
                </>
              )}
              {meta.embedding && (
                <div className={`asset-hint${meta.embeddable ? "" : " warn"}`}>
                  {meta.embeddable
                    ? `Embedding: ${meta.embedding} — this font may ship inside a build.`
                    : "Embedding: restricted — the licence in this file forbids shipping it inside a game. Check with the foundry before building."}
                </div>
              )}
              {meta.designer && <div className="asset-info-row">Designed by {meta.designer}</div>}
              {meta.license && <div className="asset-info-row license">{meta.license.slice(0, 220)}</div>}
              {meta.licenseUrl && (
                <div className="asset-info-row">
                  <a href={meta.licenseUrl} target="_blank" rel="noreferrer">
                    {meta.licenseUrl}
                  </a>
                </div>
              )}
            </>
          ) : (
            <div className="asset-hint">
              {meta.format === "woff2"
                ? "WOFF2 files are compressed in a way that hides their metadata — the font works, but its name, licence and glyph coverage can't be read here. Import the TTF or OTF if you need those."
                : "This file's tables couldn't be read, so only the preview is available."}
            </div>
          )}
          <div className="asset-info-row css-family" title="The CSS family name to use in a script or a canvas">
            family: {state.family}
          </div>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Scenes, timelines, atlases, geometry
// ---------------------------------------------------------------------------

function SceneSummary({ path }) {
  const mainScene = useProjectStore((state) => state.projectMeta?.mainScene ?? "");
  const rootPath = useProjectStore((state) => state.rootPath ?? "");
  const relative = path.replaceAll("\\", "/").replace(`${rootPath.replaceAll("\\", "/")}/`, "");
  const isMain = mainScene && mainScene.replaceAll("\\", "/") === relative;
  return (
    <JsonSummary
      path={path}
      render={(scene) => {
        const entities = scene.entities ?? [];
        const componentCounts = new Map();
        for (const entity of entities) {
          for (const type of Object.keys(entity.components ?? {})) {
            componentCounts.set(type, (componentCounts.get(type) ?? 0) + 1);
          }
        }
        const top = [...componentCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
        return (
          <div className="inspector-section">
            <div className="section-header">Scene</div>
            <div className="asset-info-row">
              <Layers size={13} /> {entities.length} {entities.length === 1 ? "entity" : "entities"}
              {isMain ? " · main scene" : ""}
            </div>
            {top.length > 0 && (
              <>
                <div className="asset-info-label">Components used</div>
                {top.map(([type, count]) => (
                  <div className="asset-info-row" key={type}>
                    {type} × {count}
                  </div>
                ))}
              </>
            )}
            {scene.settings?.environment?.cubemap && (
              <div className="asset-info-row">Skybox: {fileName(scene.settings.environment.cubemap)}</div>
            )}
          </div>
        );
      }}
    />
  );
}

function TimelineSummary({ path }) {
  return (
    <JsonSummary
      path={path}
      render={(def) => {
        const tracks = def.tracks ?? [];
        const byKind = new Map();
        for (const track of tracks) byKind.set(track.type, (byKind.get(track.type) ?? 0) + 1);
        return (
          <div className="inspector-section">
            <div className="section-header">Timeline</div>
            <div className="asset-info-row">
              {tracks.length} {tracks.length === 1 ? "track" : "tracks"}
              {def.duration ? ` · ${Number(def.duration).toFixed(2)}s` : ""}
              {def.frameRate ? ` · ${def.frameRate} fps` : ""}
            </div>
            {[...byKind.entries()].map(([kind, count]) => (
              <div className="asset-info-row" key={kind}>
                {kind} × {count}
              </div>
            ))}
          </div>
        );
      }}
    />
  );
}

/**
 * A sprite atlas over its sheet, with the regions drawn on top.
 *
 * The regions are the whole content of the asset, and a list of names and
 * numbers does not tell you whether they line up with the artwork — which is
 * the only thing anyone checks an atlas for.
 */
function AtlasPreview({ path }) {
  const [state, setState] = useState(null);
  useEffect(() => {
    let live = true;
    setState(null);
    (async () => {
      try {
        const { readAtlas } = await import("../atlasFile.js");
        const def = await readAtlas(path);
        const image = def.image ? await toBlobUrl(def.image).catch(() => null) : null;
        if (live) setState({ def, image });
      } catch (error) {
        if (live) setState({ error: String(error?.message ?? error) });
      }
    })();
    return () => {
      live = false;
    };
  }, [path]);

  if (!state) return null;
  if (state.error) return <div className="asset-hint">Can't read this atlas: {state.error}</div>;
  const regions = state.def.regions ?? [];
  const [sheetW, sheetH] = state.def.size ?? [0, 0];

  return (
    <>
      <div className="asset-preview atlas-preview">
        {state.image ? (
          <div className="atlas-preview-frame">
            <img src={state.image} alt="" draggable={false} />
            {/* Regions are `[x, y, w, h]` in image space; percentages of the
                sheet let the overlay follow the image however it is scaled to
                fit the 320px column. Skipped entirely when the atlas has no
                recorded sheet size, since every rect would land at 0. */}
            {sheetW > 0 &&
              sheetH > 0 &&
              regions.map((region) => {
                const [x, y, w, h] = region.rect;
                return (
                  <span
                    key={region.name}
                    className="atlas-preview-region"
                    title={`${region.name} — ${w}×${h}`}
                    style={{
                      left: `${(x / sheetW) * 100}%`,
                      top: `${(y / sheetH) * 100}%`,
                      width: `${(w / sheetW) * 100}%`,
                      height: `${(h / sheetH) * 100}%`,
                    }}
                  />
                );
              })}
          </div>
        ) : (
          <div className="asset-hint">No sheet assigned yet.</div>
        )}
      </div>
      <div className="inspector-section">
        <div className="section-header">Atlas</div>
        <div className="asset-info-row">
          {regions.length} {regions.length === 1 ? "region" : "regions"}
          {state.def.animations?.length ? ` · ${state.def.animations.length} animations` : ""}
          {sheetW ? ` · sheet ${sheetW}×${sheetH}` : ""}
        </div>
        {state.def.image && <div className="asset-info-row">Sheet: {fileName(state.def.image)}</div>}
      </div>
    </>
  );
}

/**
 * A `.geom` thumbnail plus its counts.
 *
 * Reuses the Assets panel's cached thumbnail renderer rather than standing up
 * a second WebGPU context in the Inspector — one offscreen renderer for the
 * whole app was a deliberate choice there (see `geometryThumb.js`), and a
 * second one here would double the GPU cost of clicking through a folder.
 */
function GeometryPreview({ path }) {
  const [url, setUrl] = useState(null);
  const [info, setInfo] = useState(null);
  useEffect(() => {
    let live = true;
    setUrl(null);
    setInfo(null);
    import("../geometryThumb.js")
      .then((m) => m.requestGeometryThumb(path))
      .then((value) => live && setUrl(value))
      .catch(() => {});
    invoke("read_text_file", { path })
      .then((text) => {
        const def = JSON.parse(text);
        if (!live) return;
        const positions = def.attributes?.position?.length ?? def.positions?.length ?? 0;
        setInfo({
          vertices: Math.round(positions / 3),
          triangles: Math.round((def.index?.length ?? positions / 3) / 3),
          groups: def.groups?.length ?? 0,
        });
      })
      // Binary `.geom` v2 files aren't JSON — the thumbnail still renders, and
      // counts are a bonus rather than the point.
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [path]);
  return (
    <>
      <div className="asset-preview geometry-preview">
        {url ? <img src={url} alt="" draggable={false} /> : <div className="asset-hint">Rendering…</div>}
      </div>
      {info && (
        <div className="inspector-section">
          <div className="section-header">Geometry</div>
          <div className="asset-info-row">
            {info.vertices.toLocaleString()} vertices · {info.triangles.toLocaleString()} triangles
            {info.groups ? ` · ${info.groups} material groups` : ""}
          </div>
        </div>
      )}
    </>
  );
}

/**
 * The fallback: a file the Inspector has nothing specific to say about.
 *
 * Still gets a name, a size, tags, build flags and the shared actions — which
 * is more than the old Inspector gave a `.txt`, a `.hdr` or an unrecognised
 * import, all of which used to render an empty panel that looked broken.
 */
function GenericPreview({ path, ext }) {
  return (
    <div className="inspector-section">
      <div className="section-header">File</div>
      <div className="asset-hint">
        No dedicated editor for <code>.{ext || "?"}</code> files. It's still part of the project — tag it,
        control whether it ships, and open it with whatever your OS uses for it.
      </div>
    </div>
  );
}

export function AssetInspector({ path }) {
  const assetPaths = useSelectionStore((state) => state.assetPaths);
  if (assetPaths.length > 1) return <MultiAssetInspector paths={assetPaths} />;
  const ext = extOf(path);
  const isTexture = TEXTURE_EXTENSIONS.includes(ext);
  const isFont = FONT_EXTENSIONS.includes(ext);
  const isScript = SCRIPT_EXTENSIONS.includes(ext);
  // `.audio` is the import-settings sidecar, not samples — there is nothing to
  // play, so it takes the generic path rather than the waveform.
  const isAudio = AUDIO_EXTENSIONS.includes(ext) && ext !== "audio";
  const isUnknown = !KNOWN_EXTS.has(ext);

  return (
    <div className="inspector-panel">
      <div className="inspector-section">
        <div className="field-row">
          <span className="field-label">Name</span>
          <input
            className="text-field"
            type="text"
            key={path}
            defaultValue={stemOf(fileName(path))}
            onBlur={(e) => renameAsset(path, e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && e.target.blur()}
          />
        </div>
        <div className="field-row">
          <span className="field-label">Type</span>
          <span className="asset-type-badge">{TYPE_LABELS[ext] ?? ext.toUpperCase()}</span>
        </div>
        <div className="asset-inspector-path" title={path}>
          {path}
        </div>
        <FileFacts path={path} />
      </div>

      {/* Preview first, then what you can do with it, then its settings. That
          order matches how someone reads an unfamiliar asset: see it, learn
          what it's for, then tune it. */}
      {isTexture && <TexturePreview path={path} />}
      {ext === "glb" && <ModelPreview path={path} />}
      {ext === "geom" && <GeometryPreview path={path} />}
      {isFont && <FontPreview path={path} />}
      {ext === "atlas" && <AtlasPreview path={path} />}
      {ext === "cubemap" && <CubemapEditor path={path} />}
      {isAudio && <AudioPreview path={path} />}
      {ext === "scene" && <SceneSummary path={path} />}
      {ext === "timeline" && <TimelineSummary path={path} />}
      {ext === "mat" && <MaterialSummary path={path} />}
      {ext === "anim" && <AnimatorSummary path={path} />}
      {(ext === "prefab" || ext === "entity") && <PrefabSummary path={path} />}
      {isScript && <ScriptInspector path={path} />}
      {isUnknown && <GenericPreview path={path} ext={ext} />}

      <AssetActionsSection path={path} />
      <AssetSettingsSection paths={[path]} />

      {isTexture && <TextureSettings path={path} />}
      {(ext === "glb" || ext === "geom") && <VirtualGeometrySettings path={path} />}
      {/* JSON-backed assets get their raw form, collapsed. Everything here is
          authored through a proper editor, but being able to look — and fix a
          hand-editable field — without launching another app is the point. */}
      {JSON_SOURCE_EXTS.includes(ext) && <SourceSection path={path} label="Raw JSON" />}
      {ext === "json" && <SourceSection path={path} label="JSON" defaultOpen />}
    </div>
  );
}
