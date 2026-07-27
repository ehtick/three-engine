import { VirtualGeometrySystem, setVirtualGeometryRuntimeConfig } from "./VirtualGeometrySystem.js";

export {
  getVirtualGeometryRecord,
  invalidateVirtualGeometryAsset,
  refreshVirtualGeometryAsset,
  setVirtualGeometryDebugVisible,
  setVirtualGeometryRuntimeConfig,
  VIRTUAL_GEOMETRY_META_DEFAULTS,
} from "./VirtualGeometrySystem.js";
export { getCoarsestClusterIndices } from "./clusterBuilder.js";

/**
 * Virtual geometry module — Nanite-style cluster LOD for high-density static
 * meshes. Unreal-style asset workflow: no component to add — a model opts in
 * via its import settings (asset inspector → Virtual Geometry), and every
 * Model component using it renders through the pipeline automatically.
 *
 * The model is preprocessed once into a hierarchy of ~128-triangle clusters
 * with per-cluster error bounds (meshoptimizer WASM, loaded lazily on first
 * use); at runtime the system picks, per frame, the set of clusters whose
 * projected screen-space error stays under the asset's pixel threshold —
 * near geometry renders full detail, distant geometry collapses to a handful
 * of triangles, crack-free, in one draw call per source mesh.
 */
export const virtualGeometryModule = {
  id: "virtual-geometry",
  name: "Virtual Geometry",
  version: "1.0.0",
  category: "Optimization",
  tags: ["lod", "mesh", "cluster", "nanite", "wasm", "rendering"],
  description:
    "Nanite-style cluster LOD: models opted in via their import settings render " +
    "with a triangle count that follows screen-space error instead of mesh density.",
  components: [],
  // Project-level defaults (stored in project.json `moduleSettings`, edited in
  // the Modules panel). `autoEnableOnImport` + `minTriangles` control which
  // freshly imported meshes get virtual geometry turned on automatically;
  // `pixelError` / `hysteresis` are baked into each such asset's .meta;
  // `maxUpdatesPerFrame` is a pure runtime perf knob applied via applySettings.
  settings: [
    {
      key: "autoEnableOnImport",
      label: "Auto-enable on import",
      type: "bool",
      default: true,
      help: "Turn virtual geometry on automatically for newly imported meshes above the triangle threshold.",
    },
    {
      key: "minTriangles",
      label: "Min triangles",
      type: "int",
      default: 20000,
      min: 0,
      step: 1000,
      help: "Skip meshes below this count — cluster LOD only pays off on dense meshes, and adds pure overhead on light ones.",
    },
    {
      key: "pixelError",
      label: "Default pixel error",
      type: "number",
      default: 1,
      min: 0.25,
      step: 0.25,
      help: "Screen-space error budget baked into new imports. Higher is faster, lower is sharper.",
    },
    {
      key: "hysteresis",
      label: "Update dead-band",
      type: "number",
      default: 0.02,
      min: 0,
      max: 0.5,
      step: 0.01,
      help: "How far the camera moves (as a fraction of its distance) before a mesh recomputes its LOD. Higher = less CPU, slightly laggier switches.",
    },
    {
      key: "maxUpdatesPerFrame",
      label: "Max LOD updates / frame",
      type: "int",
      default: 8,
      min: 1,
      step: 1,
      help: "Caps how many meshes rebuild their cut per frame, spreading cost across frames in dense scenes.",
    },
  ],
  /** Host hook: push runtime-affecting settings onto the module (see modules.js). */
  applySettings(settings = {}) {
    setVirtualGeometryRuntimeConfig({ maxUpdatesPerFrame: settings.maxUpdatesPerFrame });
  },
  async setup(engine) {
    const system = new VirtualGeometrySystem(engine);
    return { system, dispose: () => system.dispose() };
  },
};
