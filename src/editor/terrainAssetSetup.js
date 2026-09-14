import { GEOMETRY_ASSET_VERSION } from "../engine/geometryAsset.js";
import { MATERIAL_DEFAULTS } from "../engine/materialAsset.js";
import { useProjectStore } from "./store/projectStore.js";

async function invoke(command, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(command, args);
}

function terrainGeometryAsset(size = 50, resolution = 128) {
  const segments = Math.max(2, Math.floor(resolution));
  const half = size / 2;
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  for (let row = 0; row <= segments; row++) {
    const v = row / segments;
    const z = -half + v * size;
    for (let col = 0; col <= segments; col++) {
      const u = col / segments;
      positions.push(-half + u * size, 0, z);
      normals.push(0, 1, 0);
      uvs.push(u, 1 - v);
    }
  }
  const stride = segments + 1;
  for (let row = 0; row < segments; row++) {
    for (let col = 0; col < segments; col++) {
      const a = row * stride + col;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  return {
    version: GEOMETRY_ASSET_VERSION,
    positions,
    indices,
    uvs,
    normals,
    attributes: {},
    morphAttributes: {},
    morphTargetsRelative: false,
    groups: [],
  };
}

/** Creates a matched Terrain.geom / Terrain.mat pair in the current asset folder. */
export async function createTerrainAssets({ size = 50, resolution = 128 } = {}) {
  const store = useProjectStore.getState();
  const directory = store.currentPath ?? store.rootPath;
  if (!directory) return null;
  const entries = await invoke("list_dir", { path: directory }).catch(() => store.entries ?? []);
  const names = new Set(entries.map((entry) => entry.name));
  let suffix = 0;
  let stem;
  do {
    stem = suffix ? `Terrain ${suffix}` : "Terrain";
    suffix++;
  } while (names.has(`${stem}.geom`) || names.has(`${stem}.mat`));

  const geometryAsset = `${directory}/${stem}.geom`;
  const material = `${directory}/${stem}.mat`;
  const materialDef = {
    ...MATERIAL_DEFAULTS,
    color: "#8a8f7a",
    roughness: 0.95,
    metalness: 0,
  };
  await Promise.all([
    invoke("save_scene", {
      path: geometryAsset,
      contents: JSON.stringify(terrainGeometryAsset(size, resolution)),
    }),
    invoke("save_scene", {
      path: material,
      contents: JSON.stringify(materialDef, null, 2),
    }),
  ]);
  await store.refresh?.();
  return { geometryAsset, material };
}

/** Assigns generated assets only to empty Mesh inputs. */
export function assignTerrainAssets(entity, assets) {
  if (!entity || !assets) return;
  const mesh = entity.getComponent("mesh");
  if (!mesh) return;
  if (!mesh.props.geometryAsset) mesh.setProp("geometryAsset", assets.geometryAsset);
  if (!mesh.props.material) mesh.setProp("material", assets.material);
}
const setupInFlight = new Map();

/** Backfills persistent assets for an existing Terrain entity, once at a time. */
export async function ensureTerrainAssets(entity, options = {}) {
  if (!entity?.getComponent("terrain")) return null;
  // World serializes its generator and artistic layers. Selecting its native
  // Terrain must not replace that base with a newly authored flat material.
  if (entity.getComponent("world-feature")?.props.provider === "terrain") return null;
  const mesh = entity.getComponent("mesh");
  if (mesh?.props.geometryAsset && mesh?.props.material) return null;
  if (setupInFlight.has(entity.id)) return setupInFlight.get(entity.id);
  const promise = createTerrainAssets(options)
    .then((assets) => {
      if (entity.getComponent("terrain")) assignTerrainAssets(entity, assets);
      return assets;
    })
    .finally(() => setupInFlight.delete(entity.id));
  setupInFlight.set(entity.id, promise);
  return promise;
}
