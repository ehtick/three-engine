import { isBuiltinMaterial } from "../../engine/builtinMaterials.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { Code, Box } from "../icons/index.jsx";
import { ReactFlowProvider } from "@xyflow/react";
import * as THREE from "three/webgpu";
import { useSelectionStore } from "../store/selectionStore.js";
import { useSceneStore } from "../store/sceneStore.js";
import {
  NODE_TYPES,
  CATEGORY_LABELS,
  DEFAULT_MATERIAL_CLASS,
  nodeDefaults,
  compileShaderGraph,
  migrateGraph,
  generateTslCode,
  outputSlotsFor,
  setUniformValue,
} from "../../engine/tslGraph.js";
import { migrateLegacyGraph } from "../../engine/shaderGraph.js";
import {
  MATERIAL_DEFAULTS,
  getDefaultMaterial,
  getMaterialClass,
  getMaterialDef,
  loadMaterialAsset,
  updateMaterialAsset,
  syncMaterialRenderState,
  applyGraphMutations,
} from "../../engine/materialAsset.js";
import { renderNodeThumb } from "../nodegraph/nodePreview.js";
import { GraphEditor } from "../nodegraph/GraphEditor.jsx";
import { stripHelpers } from "../nodegraph/graphUtils.js";
import { useProjectStore } from "../store/projectStore.js";
import { commandBus } from "../commands/CommandBus.js";
import { SetComponentPropCommand } from "../commands/componentCommands.js";
import { engine } from "../engineInstance.js";
import { createDefaultMaterialFork } from "../defaultMaterialFork.js";
import { throttlePreviewFrame, stopPreviewRenderer } from "../previewLoop.js";
import { invalidateBlobUrl } from "../assetLoader.js";

/** Resolve the existing material def for `matPath`. Prefers the in-memory
 *  cache (which has whatever the user has been editing this session), but
 *  falls back to reading the file from disk if the cache is cold. Without
 *  this fallback, every Shader Graph save would clobber the file's
 *  `color`/`roughness`/`metalness`/`map` fields with the placeholder
 *  MATERIAL_DEFAULTS just because the cache hadn't been populated yet. */
async function resolveMaterialDefForSave(matPath) {
  const cached = getMaterialDef(matPath);
  if (cached) return cached;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return JSON.parse(await invoke("read_text_file", { path: matPath })) ?? {};
  } catch {
    return {};
  }
}

/** Fresh materials: the Material Output on its own. It carries Color /
 *  Roughness / Metalness / … itself, so an untouched graph already compiles to
 *  the same plain white Physical material the old Principled BSDF starting
 *  point did — with nothing between the value nodes and the material. */
const DEFAULT_GRAPH = {
  nodes: [{ id: "output", type: "output", props: { material: DEFAULT_MATERIAL_CLASS }, position: { x: 420, y: 150 } }],
  edges: [],
};

/**
 * Adapter from the TSL node registry to the shared toolkit's descriptor shape.
 *
 * The one piece of real translation: a shader input carries a *socket* type
 * (`float`, `color`, `any`, …) that drives wire validation, but its inline
 * editor has to be chosen from the shape of its default value — a `math` node's
 * inputs are typed `any` yet still want a number box, and a `#ffffff` default
 * means a colour picker regardless of socket type.
 */
function inputWidget(spec) {
  if (typeof spec.default === "string") return "color";
  if (typeof spec.default === "number") return "number";
  if (Array.isArray(spec.default)) return spec.default.length === 3 ? "vec3" : null;
  return null;
}

/** The Material Output's socket list depends on its `material` param, but a
 *  socket may NEVER simply disappear while a wire is attached to it: React Flow
 *  drops any edge whose handle unmounts, which would silently delete the user's
 *  wiring the moment they looked at another material class.
 *
 *  So a class narrows the list to its own slots PLUS every slot that still has
 *  something plugged into it, and those extras render as inactive — visible,
 *  still wired, ignored by the compiler until the class that reads them comes
 *  back. `ctx` is absent when the caller only wants types (wire validation,
 *  palette, edge colouring); then the full union is the right answer. */
function outputInputs(def, ctx) {
  if (!ctx) return def.inputs ?? [];
  const active = new Set(outputSlotsFor(ctx.props?.material ?? DEFAULT_MATERIAL_CLASS).map((s) => s.key));
  return (def.inputs ?? [])
    .filter((s) => active.has(s.key) || ctx.connectedHandles?.has(s.key))
    .map((s) => (active.has(s.key) ? s : { ...s, inactive: true }));
}

const shaderRegistry = {
  describe(type, ctx) {
    const def = NODE_TYPES[type];
    if (!def) return null;
    const isOutput = type === "output";
    const outputKeys = def.outputs ?? (isOutput ? [] : ["out"]);
    const inputs = isOutput ? outputInputs(def, ctx) : def.inputs ?? [];
    return {
      label: def.label,
      cat: def.cat ?? "math",
      out: def.out ?? "any",
      inputs: inputs.map((s) => ({
        key: s.key,
        label: s.key,
        type: s.type ?? "any",
        sect: s.sect ?? null,
        inactive: !!s.inactive,
        widget: inputWidget(s),
        // Wire-only inputs (normal, clearcoat, transmission …) deliberately
        // have no inline default: three switches their expensive lighting path
        // on the moment the node is non-null, even at 0. An inactive slot has
        // no editor either — the class on screen would not read the value.
        editable: s.default != null && !Array.isArray(s.default) && !s.inactive,
        default: s.default,
        step: 0.05,
      })),
      outputs: outputKeys.map((o) => ({ key: o, label: o, type: def.out ?? "any" })),
      params: def.params ?? [],
      noPreview: isOutput,
    };
  },
  items: Object.entries(NODE_TYPES)
    .filter(([type]) => type !== "output")
    .map(([type, def]) => ({
      type,
      label: def.label,
      cat: def.cat ?? "math",
      catLabel: CATEGORY_LABELS[def.cat] ?? def.cat,
      inputTypes: (def.inputs ?? []).map((s) => s.type ?? "any"),
      outputTypes: [def.out ?? "any"],
    })),
  defaults: nodeDefaults,
  // Deleting the Material Output leaves a graph that can never compile to
  // anything, and there is no UI to bring it back.
  protectedTypes: ["output"],
};

const PREVIEW_GEOMS = {
  sphere: () => new THREE.SphereGeometry(0.85, 48, 24),
  box: () => new THREE.BoxGeometry(1.15, 1.15, 1.15),
  torus: () => new THREE.TorusKnotGeometry(0.6, 0.22, 128, 24),
  // Rotated flat so the turntable spin (around Y) never presents the
  // geometry's backface to the camera — a plane spinning in its own plane
  // would go edge-on/invisible for half of every rotation otherwise.
  plane: () => new THREE.PlaneGeometry(1.6, 1.6).rotateX(-Math.PI / 2),
};

/** Corner live preview: its own WebGPURenderer + turntable, rendering the
 *  SHARED .mat material (so it always matches the scene). Pattern copied
 *  from AssetInspector's ModelPreview. */
function MaterialPreview({ material }) {
  const canvasRef = useRef(null);
  const [prim, setPrim] = useState("sphere");
  const meshRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !material) return;
    let disposed = false;
    let renderer;
    let resizeObserver;
    let camera;
    (async () => {
      renderer = new THREE.WebGPURenderer({ canvas, antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      // The camera's aspect MUST be refreshed here, not just the renderer's
      // size. This panel commonly mounts inside a hidden dock tab, where the
      // canvas is 0x0 — deriving the aspect once from clientWidth/clientHeight
      // then yields 0/0 = NaN, which poisons the projection matrix and the
      // preview renders nothing forever (it never recovers, because the tab
      // becoming visible only ever resized the renderer). Hence: no camera
      // aspect is set until we have a real box.
      const resize = () => {
        const width = canvas.clientWidth;
        const height = canvas.clientHeight;
        if (width < 1 || height < 1) return false;
        renderer.setSize(width, height, false);
        if (camera) {
          camera.aspect = width / height;
          camera.updateProjectionMatrix();
        }
        return true;
      };
      // Never initialize a WebGPU swapchain from a hidden dock tab's 0x0 box.
      if (!resize()) renderer.setSize(canvas.width || 220, canvas.height || 170, false);
      await renderer.init();
      if (disposed) return void renderer.dispose();
      resizeObserver = new ResizeObserver(() => resize());
      resizeObserver.observe(canvas);
      const scene = new THREE.Scene();
      scene.add(new THREE.AmbientLight(0xffffff, 0.5));
      const key = new THREE.DirectionalLight(0xffffff, 2.2);
      key.position.set(2, 3, 2);
      scene.add(key);
      const rim = new THREE.DirectionalLight(0x88aaff, 0.8);
      rim.position.set(-2, -1, -2);
      scene.add(rim);
      camera = new THREE.PerspectiveCamera(40, 1, 0.1, 20);
      camera.position.set(0, 0.4, 3);
      camera.lookAt(0, 0, 0);
      resize(); // adopt the real aspect if the tab is (or becomes) visible
      const mesh = new THREE.Mesh(PREVIEW_GEOMS.sphere(), material);
      meshRef.current = mesh;
      scene.add(mesh);
      const timer = new THREE.Timer();
      // Capped at PREVIEW_FPS and skipped while hidden — this is a second
      // renderer competing with the viewport every frame otherwise.
      renderer.setAnimationLoop(
        throttlePreviewFrame(canvas, () => {
          if (disposed) return;
          timer.update();
          mesh.rotation.y += timer.getDelta() * 0.5;
          renderer.render(scene, camera);
        }),
      );
    })();
    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      if (renderer) {
        stopPreviewRenderer(renderer);
        renderer.dispose();
      }
    };
  }, [material]);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    mesh.geometry.dispose();
    mesh.geometry = PREVIEW_GEOMS[prim]();
  }, [prim]);

  // A volume raymarches inside a unit box — preview it on the box so the
  // bounds match what the scene mesh uses.
  useEffect(() => {
    if (material?.userData?.isVolumeMaterial) setPrim("box");
  }, [material]);

  return (
    <div className="shader-preview">
      <canvas ref={canvasRef} width={220} height={170} />
      <div className="shader-preview-prims">
        {Object.keys(PREVIEW_GEOMS).map((p) => (
          <button key={p} className={`shader-preview-prim${prim === p ? " active" : ""}`} title={p} onClick={() => setPrim(p)}>
            <Box size={11} />
          </button>
        ))}
      </div>
    </div>
  );
}

function ShaderGraphEditor({ matPath, defaultEntity, onFork }) {
  const [saved, setSaved] = useState(true);
  const [material, setMaterial] = useState(null);
  const [initialGraph, setInitialGraph] = useState(null);
  const [structural, setStructural] = useState(0);
  // The material this editor is actually writing to. Normally it mirrors the
  // `matPath` prop, but forking the Default material sets it locally FIRST so
  // the prop catching up is a no-op (see the fork branch in the autosave
  // effect) — that's what makes the Default → real-asset switch seamless
  // instead of a reload that throws the user's first edit away.
  const [path, setPath] = useState(matPath);
  const adoptedRef = useRef(null);

  const compileRef = useRef({ uniforms: {}, taps: {}, generation: 0 });
  const thumbCanvases = useRef(new Map());
  const graphRef = useRef(null);
  const loadedRef = useRef(false);
  // Does this material's look ACTUALLY come from a graph? A .mat authored in
  // the Inspector (a colour, a texture) has no `shaderGraph` at all, and the
  // editor shows it DEFAULT_GRAPH — a white Principled BSDF — as a starting
  // point. Compiling that starting point into the shared material is not a
  // no-op: `applyGraphMutations` nulls every node slot and sets `colorNode`,
  // which overrides the material's own `color` and `map`. So merely SELECTING
  // a mesh turned it (and every other mesh sharing the material) white.
  //
  // Same contract the shared Default material already has: show the graph, and
  // take the material over only once the user actually edits it.
  const authoredRef = useRef(false);
  const touchedRef = useRef(false);

  // Follow the panel when it points at a genuinely different material. A fork
  // we made ourselves arrives here as the value `path` already holds, so React
  // bails out and no reload happens.
  useEffect(() => {
    setPath(matPath);
  }, [matPath]);

  // Load graph + shared material.
  useEffect(() => {
    let live = true;
    // Just-forked: the graph on screen is newer than anything on disk. Adopt
    // the new asset's shared material and compile the live graph into it,
    // leaving node positions, undo history and the user's edit untouched.
    if (adoptedRef.current && adoptedRef.current === path) {
      adoptedRef.current = null;
      // A fork only exists because the user edited; its graph is theirs.
      authoredRef.current = true;
      touchedRef.current = true;
      (async () => {
        const mat = await loadMaterialAsset(path);
        if (!live) return;
        compileRef.current.uniforms = {};
        compileRef.current.taps = {};
        setMaterial(mat);
        setStructural((s) => s + 1);
      })();
      return () => (live = false);
    }
    loadedRef.current = false;
    (async () => {
      const mat = path ? await loadMaterialAsset(path) : getDefaultMaterial();
      let def = path ? getMaterialDef(path) : MATERIAL_DEFAULTS;
      if (path && !def) {
        try {
          const { invoke } = await import("@tauri-apps/api/core");
          def = JSON.parse(await invoke("read_text_file", { path }));
        } catch {}
      }
      if (!live) return;
      authoredRef.current = !!def?.shaderGraph;
      touchedRef.current = false;
      const graph = def?.shaderGraph ? migrateGraph(migrateLegacyGraph(def.shaderGraph, def)) : DEFAULT_GRAPH;
      graphRef.current = graph;
      setMaterial(mat);
      setInitialGraph(graph);
      setSaved(true);
      loadedRef.current = true;
      setStructural((s) => s + 1);
    })();
    return () => (live = false);
  }, [path]);

  const registerThumb = useCallback((id, el) => {
    if (!el) {
      thumbCanvases.current.delete(id);
      return;
    }
    thumbCanvases.current.set(id, el);
    // A canvas can mount *after* the compile that produced its tap (toggling the
    // eye re-renders the node, and the node itself may remount as the graph
    // re-lays out). Without this, that thumbnail stays blank until the next
    // structural edit — the "preview sometimes doesn't work" case. Draw straight
    // away if we already have a tap for this node.
    const tap = compileRef.current.taps?.[id];
    if (tap && !tap.__volume) renderNodeThumb(tap, el);
  }, []);

  /**
   * Every graph change lands here. Value edits patch the live uniform when one
   * exists (no shader rebuild); anything else — wires, node add/remove, params
   * with no uniform behind them (texture paths, step counts), preview toggles
   * that need a fresh tap — schedules a recompile.
   */
  const onChange = useCallback((graph, meta) => {
    graphRef.current = graph;
    if (meta?.reason === "load") return;
    setSaved(false);

    if (meta?.kind === "props") {
      // Pure layout state: persist it, but it can't change a single pixel.
      if (meta.patch?.__collapsed !== undefined) return;
      // A change that reaches the shader is what makes this material the
      // graph's — dragging a node around is not (see `authoredRef`).
      touchedRef.current = true;
      let structuralHit = false;
      for (const [key, value] of Object.entries(meta.patch ?? {})) {
        if (key === "__thumb") {
          structuralHit = true; // a new tap has to be compiled to render it
          continue;
        }
        const u = compileRef.current.uniforms[`${meta.nodeId}.${key}`];
        if (u) setUniformValue(u, value);
        else structuralHit = true;
      }
      if (structuralHit) setStructural((s) => s + 1);
      return;
    }
    // Node moves don't affect the compiled shader — only the saved layout.
    if (meta?.kind === "position") return;
    touchedRef.current = true;
    setStructural((s) => s + 1);
  }, []);

  // Recompile (debounced): apply to the shared material, refresh uniforms,
  // render thumbnails for tapped nodes.
  useEffect(() => {
    // Never compile edits into the shared Default material. Its first change
    // is persisted as a new asset below; this editor then adopts that asset in
    // place and follows the normal live-compile path from the next tick on.
    if (!loadedRef.current || !material || !path || isBuiltinMaterial(path)) return;
    // ...and never compile a starting-point graph into a material that never
    // had one. Reading a .mat must not change how it looks.
    if (!authoredRef.current && !touchedRef.current) return;
    const timer = setTimeout(async () => {
      const full = graphRef.current;
      // Comments and reroute pins are authoring aids; the compiler resolves
      // wires through the pins and never sees either.
      const graph = stripHelpers(full);
      const taps = graph.nodes.filter((n) => n.props?.__thumb).map((n) => n.id);
      const generation = ++compileRef.current.generation;
      try {
        const result = await compileShaderGraph(graph, { taps });
        if (generation !== compileRef.current.generation) return;
        // The Output names the material class. A swap can't be done in place —
        // a MeshPhongNodeMaterial has no roughnessNode to clear — so route it
        // through the asset layer, which replaces the cached shared instance
        // and recompiles, then adopt the new instance for the preview.
        const wantVolume = !!result?.isVolume;
        // The asset layer owns which class the shared instance currently IS,
        // so ask it rather than sniffing the instance or keeping a second copy
        // of the bookkeeping here.
        if ((result?.materialClass ?? DEFAULT_MATERIAL_CLASS) !== getMaterialClass(path)) {
          const existing = await resolveMaterialDefForSave(path);
          const def = { ...MATERIAL_DEFAULTS, ...existing, shaderGraph: full };
          updateMaterialAsset(path, def);
          const swapped = await loadMaterialAsset(path);
          if (generation !== compileRef.current.generation) return;
          compileRef.current.uniforms = {};
          compileRef.current.taps = {};
          setMaterial(swapped); // re-runs this effect against the new class
          return;
        }
        // Volume materials wire scatteringNode/emissive/steps, surface ones map
        // onto *Node slots — the asset layer owns that logic so both paths agree.
        applyGraphMutations(material, result, wantVolume);
        // In-place edit (no class change): refresh renderable state, which now
        // only hides a mesh whose Volume output has no bundle wired — a surface
        // Output is a complete material with nothing plugged into it at all.
        syncMaterialRenderState(path, graph);
        compileRef.current.uniforms = result?.uniforms ?? {};
        // Kept so a thumb canvas mounting after this compile can still draw
        // itself (see registerThumb).
        compileRef.current.taps = result?.taps ?? {};
        for (const id of taps) {
          const canvas = thumbCanvases.current.get(id);
          // A Volume node yields a raymarch bundle, not a TSL value — skip
          // its thumbnail (there is nothing single to preview).
          const tap = result?.taps?.[id];
          if (canvas && tap && !tap.__volume) renderNodeThumb(tap, canvas);
        }
      } catch (err) {
        console.error(`Shader graph compile: ${err.message}`);
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [structural, material, path]);

  // Autosave the .mat (debounced) — keeps the materialAsset cache def in sync
  // without a second compile.
  useEffect(() => {
    if (saved || !loadedRef.current) return;
    // Writing a `shaderGraph` the user never authored would hand the material
    // to the graph on the NEXT load — the same white-out, one reload later.
    // A node someone dragged is not a reason to do that.
    if (path && !authoredRef.current && !touchedRef.current) return;
    const timer = setTimeout(async () => {
      // The FULL graph is saved (comments and reroutes included) so the user's
      // layout survives a reload; only the compiler gets the stripped copy.
      const graph = graphRef.current;
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        if (!path || isBuiltinMaterial(path)) {
          const liveMesh = engine.getEntity(defaultEntity?.id)?.getComponent("mesh");
          // The debounce can overlap an assignment from another editor action.
          // Fork only if Material 1 is still the Default material.
          if (!liveMesh || (liveMesh.props.material && liveMesh.props.material !== path)) return;
          const project = useProjectStore.getState();
          const forkPath = await createDefaultMaterialFork({
            rootPath: project.rootPath,
            entityName: engine.getEntity(defaultEntity.id)?.name ?? defaultEntity.name,
            graph,
            definition: path ? getMaterialDef(path) : MATERIAL_DEFAULTS,
            listDirectory: (dir) => invoke("list_dir", { path: dir }),
            saveFile: (file, contents) => invoke("save_scene", { path: file, contents }),
          });
          if (liveMesh.props.material && liveMesh.props.material !== path) return;
          // Switch this editor onto the new asset BEFORE the scene change comes
          // back as a prop, and tell the panel to keep its React key — between
          // them, the fork happens without unmounting the graph, so the edit
          // that triggered it survives.
          adoptedRef.current = forkPath;
          onFork?.(forkPath);
          setPath(forkPath);
          commandBus.execute(new SetComponentPropCommand(defaultEntity.id, "mesh", "material", forkPath));
          await useProjectStore.getState().refresh();
        } else {
          const existing = await resolveMaterialDefForSave(path);
          const def = { ...MATERIAL_DEFAULTS, ...existing, shaderGraph: graph };
          const cached = getMaterialDef(path);
          if (cached) cached.shaderGraph = graph;
          await invoke("save_scene", { path, contents: JSON.stringify(def, null, 2) });
          // The autosave is invisible to everything that watches for asset
          // changes — the scene didn't change, no command ran, and the file
          // watcher ignores the editor's own writes. Without this, the live
          // browser preview never learns a material was edited and serves the
          // old look until some unrelated edit forces a rebuild.
          invalidateBlobUrl(path);
        }
        setSaved(true);
      } catch (err) {
        console.error(`Shader graph save: ${err.message}`);
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [saved, structural, path, defaultEntity, onFork]);

  const copyCode = async () => {
    const code = generateTslCode(stripHelpers(graphRef.current));
    try {
      await navigator.clipboard.writeText(code);
      console.log("TSL code copied to clipboard");
    } catch {
      console.log(code);
    }
  };

  const toolbar = (
    <>
      <span className="asset-path" title={path ?? "Default material"}>
        {path ? path.split(/[\\/]/).pop() : "Default"}
      </span>
      <span className={`shader-save-state${saved ? " saved" : ""}`}>{saved ? "Saved" : "Saving…"}</span>
      <button className="toolbar-btn" title="Copy graph as three/tsl JavaScript" onClick={copyCode}>
        <Code size={13} />
        Code
      </button>
    </>
  );

  if (!initialGraph) return <div className="shader-graph-panel empty">Loading material…</div>;

  return (
    <GraphEditor
      kind="shader"
      registry={shaderRegistry}
      initialGraph={initialGraph}
      onChange={onChange}
      toolbar={toolbar}
      overlay={material ? <MaterialPreview material={material} /> : null}
      canPreview
      registerThumb={registerThumb}
    />
  );
}

export function ShaderGraphPanel() {
  const selectedId = useSelectionStore((s) => s.ids[0] ?? null);
  const assetPath = useSelectionStore((s) => s.assetPath);
  const entity = useSceneStore((s) => (selectedId ? s.entities[selectedId] : null));
  const matPath = assetPath?.toLowerCase().endsWith(".mat") ? assetPath : entity?.components?.mesh?.material || null;
  const defaultEntity =
    !assetPath && entity?.components?.mesh && (!entity.components.mesh.material || isBuiltinMaterial(entity.components.mesh.material))
      ? { id: entity.id, name: entity.name }
      : null;

  // Forking the Default material assigns a brand-new .mat to the mesh, which
  // would normally change the editor's React key and remount it — throwing away
  // the very edit that caused the fork. Remembering the fork lets the editor
  // keep the key it was mounted with, so the switch is invisible to the user.
  const forkRef = useRef(null);
  const onFork = useCallback((forkPath) => {
    if (forkRef.current) forkRef.current.path = forkPath;
  }, []);

  if (!matPath && !defaultEntity) {
    forkRef.current = null;
    return (
      <div
        className="shader-graph-panel empty"
        title="Select a .mat asset or an entity with a Mesh component to edit its shader graph"
      >
        <Box className="empty-glyph" size={28} />
      </div>
    );
  }

  const naturalKey = matPath ?? `default:${defaultEntity.id}`;
  // The memo is only worth keeping while it names the exact material this
  // session forked; anything else (another entity's Default, a .mat picked in
  // the Assets panel) is a real switch and should remount as usual.
  if (!forkRef.current?.path || forkRef.current.path !== matPath) {
    forkRef.current = defaultEntity ? { key: naturalKey, path: null } : null;
  }
  const key = forkRef.current?.path === matPath ? forkRef.current.key : naturalKey;

  return (
    <ReactFlowProvider>
      <ShaderGraphEditor
        key={key}
        matPath={matPath}
        defaultEntity={defaultEntity}
        onFork={onFork}
      />
    </ReactFlowProvider>
  );
}
