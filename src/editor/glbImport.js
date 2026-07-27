import { toBlobUrl, writeBinaryFile } from "./assetLoader.js";
import { useProjectStore, basename } from "./store/projectStore.js";
import { useAssetProcessingStore } from "./store/assetProcessingStore.js";
import { MATERIAL_DEFAULTS } from "../engine/materialAsset.js";
import { GEOMETRY_BINARY_VERSION, encodeGeometryAsset } from "../engine/geometryAsset.js";
import { createGltfLoader } from "../engine/gltfLoader.js";
import { buildPbrGraph } from "./pbrMaterialGraph.js";
import { buildMeshEntities, buildBoneEntities } from "./rigPrefab.js";

/**
 * GLB unpack pipeline: turns an imported .glb into a self-contained asset
 * folder of plain engine assets. Static models (the common case) become
 * ordinary mesh entities — no model component, no runtime GLB parsing:
 *
 *   Model/
 *     Model.prefab         (mesh-entity tree: geometry + material assets)
 *     Geometry/<name>.geom (one per mesh, authored normals preserved)
 *     Materials/<name>.mat (full PBR: diffuse/normal/rough/metal/AO wired
 *                           into a Principled BSDF shader graph)
 *     Textures/<name>.png  (extracted images, color-space tagged via .meta)
 *
 * The source .glb is deleted after a successful static unpack — everything
 * it carried now lives in editable assets.
 *
 * Skinned or animated models also extract editable .geom assets, including
 * skin weights and morph targets. They retain the GLB only because skeletons
 * and animation clips still live in that container.
 */

// Draco-enabled so re-unpacking an already-compressed .glb still decodes.
const loader = createGltfLoader();

async function invoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

/**
 * How many asset writes may be in flight at once.
 *
 * Each write is one IPC round-trip that spends nearly all its time waiting on
 * the Rust side, so issuing them one at a time made a several-hundred-mesh
 * import latency-bound. The cap keeps peak memory (each in-flight write holds
 * its encoded payload) and Basis' CPU use bounded.
 */
const WRITE_CONCURRENCY = 8;

/** `Promise.all(items.map(fn))` with at most `limit` running concurrently. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

const stemOf = (name) => name.replace(/\.[^.]+$/, "");
const safeName = (name) => name.replace(/[^\w\- ]+/g, "_").trim() || "Unnamed";
const round6 = (v) => Math.round(v * 1e6) / 1e6;

/**
 * Writes a `virtualGeometry` .meta sidecar for a freshly-imported .geom when
 * the Virtual Geometry module is enabled and configured to auto-enable — so
 * dense meshes render through cluster LOD without a manual trip to the asset
 * inspector. Light meshes (below the module's triangle threshold) are left
 * alone: cluster LOD is pure overhead on them. Best-effort; never blocks import.
 */
async function maybeAutoEnableVirtualGeometry(geomPath, triangleCount) {
  try {
    const { useModulesStore, getModuleSettings } = await import("./modules.js");
    if (!useModulesStore.getState().enabled.includes("virtual-geometry")) return;
    const s = await getModuleSettings("virtual-geometry");
    if (!s.autoEnableOnImport) return;
    if (triangleCount < (s.minTriangles ?? 0)) return;
    const meta = {
      virtualGeometry: {
        enabled: true,
        pixelError: s.pixelError ?? 1,
        hysteresis: s.hysteresis ?? 0.02,
      },
    };
    await invoke("save_scene", { path: `${geomPath}.meta`, contents: JSON.stringify(meta, null, 2) });
  } catch (err) {
    console.warn(`Virtual geometry auto-enable skipped for ${geomPath}: ${err.message ?? err}`);
  }
}

/** First "name", "name 1", … not present in the directory listing. */
async function uniqueChildName(dir, name) {
  let entries = [];
  try {
    entries = await invoke("list_dir", { path: dir });
  } catch {
    return name;
  }
  const names = new Set(entries.map((e) => e.name));
  if (!names.has(name)) return name;
  for (let i = 1; ; i++) {
    if (!names.has(`${name} ${i}`)) return `${name} ${i}`;
  }
}

/** Encodes a loaded texture's image to PNG bytes (null if not encodable). */
async function textureToPng(texture) {
  const image = texture?.image;
  if (!image || texture.isCompressedTexture) return null;
  const width = image.width;
  const height = image.height;
  if (!width || !height) return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").drawImage(image, 0, 0);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) return null;
  return new Uint8Array(await blob.arrayBuffer());
}

const colorHex = (color) => `#${color?.getHexString?.() ?? "ffffff"}`;

/**
 * Copies a BufferAttribute's values into a tightly packed typed array.
 *
 * glTF optimizers commonly interleave tangent/color/skin attributes.
 * InterleavedBufferAttribute exposes its storage through `.data.array`, not
 * `.array`, and its values are strided — reading the raw array would pick up
 * neighbouring attributes' bytes.
 *
 * Values are copied verbatim. The previous writer rounded every component to
 * six decimals, which existed purely to keep the JSON text smaller; the binary
 * container has no such pressure, so imported meshes now keep the exact floats
 * the artist exported.
 */
function attributeArray(attribute, ArrayType) {
  const source = attribute.array ?? attribute.data?.array;
  if (!source) throw new Error("Unsupported vertex attribute storage");
  const { itemSize, count } = attribute;
  const interleaved = !!attribute.isInterleavedBufferAttribute;
  // Already exactly what we want: hand the buffer straight through.
  if (!interleaved && source instanceof ArrayType && source.length === count * itemSize) {
    return source;
  }
  const stride = interleaved ? attribute.data.stride : itemSize;
  const offset = interleaved ? attribute.offset : 0;
  const out = new ArrayType(count * itemSize);
  for (let i = 0; i < count; i++) {
    const from = i * stride + offset;
    const to = i * itemSize;
    for (let component = 0; component < itemSize; component++) {
      out[to + component] = source[from + component];
    }
  }
  return out;
}

/** Serializes a BufferGeometry to the .geom definition shape (authored normals kept). */
function geometryAssetFromMesh(geometry) {
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const uv = geometry.getAttribute("uv");
  const vertexCount = position.count;
  const IndexType = vertexCount > 65535 ? Uint32Array : Uint16Array;

  let indices;
  if (geometry.index) {
    indices = attributeArray(geometry.index, IndexType);
  } else {
    // Non-indexed primitive: the .geom shape is always indexed, so emit the
    // trivial 0..n-1 index run.
    indices = new IndexType(vertexCount);
    for (let i = 0; i < vertexCount; i++) indices[i] = i;
  }

  const attributeAsset = (attribute) => {
    const source = attribute.array ?? attribute.data?.array;
    if (!source) throw new Error("Unsupported vertex attribute storage");
    const ArrayType = source.constructor;
    return {
      itemSize: attribute.itemSize,
      normalized: !!attribute.normalized,
      arrayType: ArrayType.name,
      array: attributeArray(attribute, ArrayType),
    };
  };
  const attributes = {};
  for (const [name, attribute] of Object.entries(geometry.attributes)) {
    if (name !== "position" && name !== "normal" && name !== "uv") {
      attributes[name] = attributeAsset(attribute);
    }
  }
  const morphAttributes = {};
  for (const [name, targets] of Object.entries(geometry.morphAttributes)) {
    morphAttributes[name] = targets.map(attributeAsset);
  }
  return {
    version: GEOMETRY_BINARY_VERSION,
    positions: attributeArray(position, Float32Array),
    indices,
    uvs: uv ? attributeArray(uv, Float32Array) : null,
    normals: normal ? attributeArray(normal, Float32Array) : null,
    attributes,
    morphAttributes,
    morphTargetsRelative: !!geometry.morphTargetsRelative,
    groups: geometry.groups.map(({ start, count, materialIndex }) => ({ start, count, materialIndex })),
  };
}

/** Unpacks a .glb in place; returns the created folder path (or null). */
export async function unpackGlb(glbPath, { assetStem = null, cleanupPaths = [] } = {}) {
  return useAssetProcessingStore.getState().track(
    (p) => `Unpacking ${basename(p)}…`,
    (p) => unpackGlbImpl(p, { assetStem, cleanupPaths }),
    glbPath,
  );
}

async function unpackGlbImpl(glbPath, { assetStem = null, cleanupPaths = [] } = {}) {
  const gltf = await loader.loadAsync(await toBlobUrl(glbPath));

  const dir = glbPath.replace(/[\\/][^\\/]+$/, "");
  const fileName = basename(glbPath);
  const stem = assetStem ?? stemOf(fileName);
  const folder = `${dir}/${await uniqueChildName(dir, stem)}`;
  await invoke("create_dir", { path: folder });

  // Skeletons and clips only exist inside the GLB, so those models keep the
  // legacy model-component path; everything else flattens to mesh entities.
  let skinned = false;
  gltf.scene.traverse((obj) => {
    if (obj.isSkinnedMesh) skinned = true;
  });
  const animated = (gltf.animations ?? []).length > 0;

  // --- collect materials + extract their textures ---------------------------
  const materials = new Map(); // material -> name
  gltf.scene.traverse((obj) => {
    if (!obj.isMesh) return;
    for (const mat of Array.isArray(obj.material) ? obj.material : [obj.material]) {
      if (mat && !materials.has(mat)) {
        const base = safeName(mat.name || `Material ${materials.size + 1}`);
        let name = base;
        for (let i = 1; [...materials.values()].includes(name); i++) name = `${base} ${i}`;
        materials.set(mat, name);
      }
    }
  });

  // uuid -> in-flight-or-settled promise of the written path. Memoizing the
  // PROMISE (not the resolved path) is what makes it safe to extract several
  // materials concurrently: two materials sharing an image await the same
  // single write instead of racing to produce the same file twice.
  const textureFiles = new Map();
  const writeTexture = (texture, fallbackName, { srgb = false } = {}) => {
    const cached = textureFiles.get(texture.uuid);
    if (cached) return cached;
    const pending = (async () => {
      const bytes = await textureToPng(texture);
      if (!bytes) return "";
      const name = safeName(texture.name || texture.image?.name || fallbackName);
      const path = `${folder}/Textures/${name}.png`;
      await writeBinaryFile(path, bytes);
      // glTF UVs have a top-left origin; loaders must not flip these images.
      // Data maps (normal/rough/metal/AO) must not be sRGB-decoded either.
      await invoke("save_scene", {
        path: `${path}.meta`,
        contents: JSON.stringify({ flipY: false, colorSpace: srgb ? "srgb" : "linear" }, null, 2),
      });
      const { autoCompressTexture } = await import("./basisCompress.js");
      await autoCompressTexture(path).catch((err) =>
        console.warn(`Basis compression skipped for ${name}: ${err.message ?? err}`),
      );
      return path;
    })();
    textureFiles.set(texture.uuid, pending);
    return pending;
  };

  // One .mat per GLTF material, with every extractable PBR map wired into a
  // Principled BSDF graph. glTF packs roughness(G)/metalness(B) into one ORM
  // image — same layout as an `arm` map; its R channel is occlusion only when
  // the material's own aoMap points at the same image.
  const materialPaths = new Map(); // material -> .mat path
  // Materials are independent of each other, and each one spends its time
  // waiting on image encodes and file writes rather than on CPU. Running them
  // concurrently (shared textures deduped by the promise cache above) turns the
  // slowest part of a texture-heavy import from a sum into a max.
  await mapLimit([...materials], WRITE_CONCURRENCY, async ([mat, name]) => {
    const maps = {};
    if (mat.map) maps.diffuse = await writeTexture(mat.map, `${name} diffuse`, { srgb: true });
    if (mat.normalMap) maps.normal = await writeTexture(mat.normalMap, `${name} normal`);
    const sharedOrm = mat.roughnessMap && mat.roughnessMap === mat.metalnessMap
      ? mat.roughnessMap
      : null;
    if (sharedOrm) maps.arm = await writeTexture(sharedOrm, `${name} orm`);
    else {
      if (mat.roughnessMap) maps.roughness = await writeTexture(mat.roughnessMap, `${name} roughness`);
      if (mat.metalnessMap) maps.metalness = await writeTexture(mat.metalnessMap, `${name} metalness`);
    }
    if (mat.aoMap && mat.aoMap !== sharedOrm) maps.ao = await writeTexture(mat.aoMap, `${name} ao`);
    if (mat.emissiveMap) maps.emissive = await writeTexture(mat.emissiveMap, `${name} emissive`, { srgb: true });
    if (mat.alphaMap) maps.opacity = await writeTexture(mat.alphaMap, `${name} opacity`);
    if (mat.clearcoatMap) maps.clearcoat = await writeTexture(mat.clearcoatMap, `${name} clearcoat`);
    if (mat.clearcoatRoughnessMap) maps.clearcoatRoughness = await writeTexture(mat.clearcoatRoughnessMap, `${name} clearcoat roughness`);
    if (mat.transmissionMap) maps.transmission = await writeTexture(mat.transmissionMap, `${name} transmission`);
    if (mat.thicknessMap) maps.thickness = await writeTexture(mat.thicknessMap, `${name} thickness`);
    if (mat.sheenColorMap) maps.sheen = await writeTexture(mat.sheenColorMap, `${name} sheen`, { srgb: true });
    if (mat.sheenRoughnessMap) maps.sheenRoughness = await writeTexture(mat.sheenRoughnessMap, `${name} sheen roughness`);
    if (mat.specularIntensityMap) maps.specularIntensity = await writeTexture(mat.specularIntensityMap, `${name} specular intensity`);
    if (mat.specularColorMap) maps.specularColor = await writeTexture(mat.specularColorMap, `${name} specular color`, { srgb: true });
    if (mat.anisotropyMap) maps.anisotropy = await writeTexture(mat.anisotropyMap, `${name} anisotropy`);

    const hasGraphMaps = Object.values(maps).some(Boolean);
    const factors = {
      color: colorHex(mat.color),
      roughness: typeof mat.roughness === "number" ? mat.roughness : MATERIAL_DEFAULTS.roughness,
      metalness: typeof mat.metalness === "number" ? mat.metalness : MATERIAL_DEFAULTS.metalness,
      ior: typeof mat.ior === "number" ? mat.ior : 1.5,
      specularIntensity: typeof mat.specularIntensity === "number" ? mat.specularIntensity : 0.5,
      specularColor: colorHex(mat.specularColor),
      emissive: colorHex(mat.emissive),
      emissiveStrength: typeof mat.emissiveIntensity === "number" ? mat.emissiveIntensity : 1,
      opacity: typeof mat.opacity === "number" ? mat.opacity : 1,
      ao: typeof mat.aoMapIntensity === "number" ? mat.aoMapIntensity : 1,
      normalScale: typeof mat.normalScale?.x === "number" ? mat.normalScale.x : 1,
      anisotropy: typeof mat.anisotropy === "number" ? mat.anisotropy : null,
      clearcoat: typeof mat.clearcoat === "number" ? mat.clearcoat : null,
      clearcoatRoughness: typeof mat.clearcoatRoughness === "number" ? mat.clearcoatRoughness : null,
      sheen: mat.sheenColor ? colorHex(mat.sheenColor) : null,
      sheenRoughness: typeof mat.sheenRoughness === "number" ? mat.sheenRoughness : null,
      transmission: typeof mat.transmission === "number" ? mat.transmission : null,
      thickness: typeof mat.thickness === "number" ? mat.thickness : null,
      useDiffuseAlpha: !!mat.map && (mat.transparent || mat.alphaTest > 0 || mat.opacity < 1),
    };
    const def = {
      ...MATERIAL_DEFAULTS,
      color: factors.color,
      roughness: factors.roughness,
      metalness: factors.metalness,
      map: maps.diffuse ?? "",
      // Diffuse-only materials stay plain scalar .mat files; the graph only
      // appears when there's something for it to wire.
      shaderGraph: hasGraphMaps
        ? buildPbrGraph(maps, { armHasAo: !!sharedOrm && mat.aoMap === sharedOrm, factors })
        : null,
    };
    const matPath = `${folder}/Materials/${name}.mat`;
    await invoke("save_scene", { path: matPath, contents: JSON.stringify(def, null, 2) });
    materialPaths.set(mat, matPath);
  });

  const { makeDef, newFid } = await import("../engine/index.js");
  let prefabRoot;
  let dracoNote = "";
  let geometryCount = 0;

  // Geometry is extracted for both static and skeletal meshes. Skeletal
  // models retain the GLB only as the owner of their skeleton and clips.
  const geomNames = new Set();
  /** Reserves this mesh's unique `.geom` path. Synchronous, so it stays correct
   *  when the writes below run concurrently. */
  const geometryPathFor = (mesh) => {
    const base = safeName(mesh.name || "Mesh");
    let name = base;
    for (let i = 1; geomNames.has(name); i++) name = `${base} ${i}`;
    geomNames.add(name);
    return `${folder}/Geometry/${name}.geom`;
  };
  const geometryFor = async (mesh, path = geometryPathFor(mesh)) => {
    let definition;
    try {
      definition = geometryAssetFromMesh(mesh.geometry);
    } catch (error) {
      throw new Error(`Could not extract geometry "${mesh.name || "Mesh"}": ${error.message ?? error}`);
    }
    await writeBinaryFile(path, encodeGeometryAsset(definition));
    geometryCount++;
    return path;
  };

  if (!skinned && !animated) {
    // --- static path: geometry assets + a mesh-entity tree ------------------
    // Async pass first (file writes), then a sync tree build from the results.
    const meshAssets = new Map(); // mesh -> { geometryAsset, material }
    const meshes = [];
    gltf.scene.traverse((obj) => obj.isMesh && meshes.push(obj));
    // Names/paths are reserved up front (synchronously, so they stay unique and
    // deterministic), then the writes run concurrently. A dense model is
    // hundreds of meshes, and doing one IPC round-trip at a time made the
    // import latency-bound rather than work-bound.
    for (const mesh of meshes) {
      const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      if (Array.isArray(mesh.material) && mesh.material.length > 1) {
        console.warn(`"${mesh.name}": multi-material mesh — using "${mat?.name}" for all faces`);
      }
      meshAssets.set(mesh, {
        geometryAsset: geometryPathFor(mesh),
        material: materialPaths.get(mat) ?? "",
      });
    }
    await mapLimit(meshes, WRITE_CONCURRENCY, async (mesh) => {
      const { geometryAsset } = meshAssets.get(mesh);
      await geometryFor(mesh, geometryAsset);
      const geo = mesh.geometry;
      const tris = (geo.index?.count ?? geo.getAttribute("position")?.count ?? 0) / 3;
      await maybeAutoEnableVirtualGeometry(geometryAsset, tris);
    });

    const nodeFor = (obj) => {
      const children = obj.children.map(nodeFor).filter(Boolean);
      const assets = meshAssets.get(obj);
      if (!assets && children.length === 0) return null; // cameras, lights, empties
      return {
        fid: newFid(),
        name: obj.name || (assets ? "Mesh" : "Node"),
        position: obj.position.toArray().map(round6),
        rotation: [obj.rotation.x, obj.rotation.y, obj.rotation.z].map(round6),
        scale: obj.scale.toArray().map(round6),
        components: assets
          ? [{ type: "mesh", props: { geometry: "box", ...assets, castShadow: true, receiveShadow: true } }]
          : [],
        children,
      };
    };
    prefabRoot = {
      fid: newFid(),
      name: stem,
      position: gltf.scene.position.toArray().map(round6),
      rotation: [gltf.scene.rotation.x, gltf.scene.rotation.y, gltf.scene.rotation.z].map(round6),
      scale: gltf.scene.scale.toArray().map(round6),
      components: [],
      children: gltf.scene.children.map(nodeFor).filter(Boolean),
    };

    // Everything now lives in .geom/.mat/.png — the container is dead weight.
    await invoke("delete_path", { path: glbPath }).catch(() => {});
    await invoke("delete_path", { path: `${glbPath}.meta` }).catch(() => {});
  } else {
    // --- legacy path: skinned/animated models stay GLB-backed ---------------
    const movedGlb = `${folder}/${stem}.glb`;
    await invoke("rename_path", { from: glbPath, to: movedGlb });

    const clips = gltf.animations ?? [];
    let animPath = "";
    if (clips.length) {
      const states = clips.map((clip, i) => ({
        id: `state-${i}`,
        name: clip.name || `Clip ${i + 1}`,
        clip: clip.name,
        speed: 1,
        loop: true,
        x: 240 + (i % 3) * 220,
        y: 80 + Math.floor(i / 3) * 120,
      }));
      animPath = `${folder}/${stem}.anim`;
      await invoke("save_scene", {
        path: animPath,
        contents: JSON.stringify(
          { version: 1, parameters: [], states, entry: states[0].id, transitions: [] },
          null,
          2,
        ),
      });
    }

    const geometryPaths = new Map();
    const rigMeshes = [];
    gltf.scene.traverse((object) => object.isMesh && rigMeshes.push(object));
    for (const mesh of rigMeshes) geometryPaths.set(mesh, geometryPathFor(mesh));
    await mapLimit(rigMeshes, WRITE_CONCURRENCY, (mesh) =>
      geometryFor(mesh, geometryPaths.get(mesh)),
    );

    const meshNodes = buildMeshEntities(
      gltf.scene,
      newFid,
      (mesh) => {
        const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
        return materialPaths.get(mat) ?? "";
      },
      (mesh) => geometryPaths.get(mesh) ?? "",
    );
    const rootMesh = meshNodes.shift() ?? null;

    prefabRoot = {
      fid: newFid(),
      name: stem,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      components: [
        { type: "model", props: { path: movedGlb } },
        // The first render surface lives on the prefab root as the user-facing
        // Mesh component. Multi-mesh rigs keep their remaining surfaces as
        // child Mesh handles because an entity can own one component per type.
        ...(rootMesh?.components ?? []),
        ...(animPath ? [{ type: "animation", props: { controller: animPath, playInEditor: true } }] : []),
      ],
      children: [
        // Additional render surfaces remain independently selectable/editable.
        ...meshNodes,
        // Each joint is a normal prefab entity, so children can be dropped on
        // the rig (for example, put a sword beneath Hand.R). ModelComponent
        // syncs these attachment points from the animated GLB bones at runtime.
        ...buildBoneEntities(gltf.scene, newFid),
      ],
    };

    // Auto-compress the moved .glb in place when the Draco module is enabled;
    // it still loads through the prefab's `model` path transparently.
    try {
      const { isDracoEnabled, compressGlbInPlace, formatBytes } = await import("./dracoCompress.js");
      if (isDracoEnabled()) {
        const info = await compressGlbInPlace(movedGlb);
        if (info && info.compressed < info.original) {
          const pct = Math.round((1 - info.compressed / info.original) * 100);
          dracoNote = `, Draco −${pct}% (${formatBytes(info.original)} → ${formatBytes(info.compressed)})`;
        }
      }
    } catch (err) {
      console.warn(`Draco compression skipped for ${fileName}: ${err.message ?? err}`);
    }
  }

  // --- prefab ----------------------------------------------------------------
  // A real prefab asset: instances of it stay linked, so re-importing the model
  // (or editing the prefab) updates every place it was dropped into a scene.
  const prefabDef = makeDef(prefabRoot, { name: stem });
  const prefabPath = `${folder}/${stem}.prefab`;
  await invoke("save_scene", { path: prefabPath, contents: JSON.stringify(prefabDef, null, 2) });
  const { loadPrefabFile } = await import("./prefab.js");
  await loadPrefabFile(prefabPath); // register it so it can be dropped immediately

  // Converted source formats (FBX today) are retained until conversion,
  // unpack, prefab write, and registration all succeed. A failure leaves the
  // source untouched so the user can inspect or retry it.
  for (const path of cleanupPaths) {
    await invoke("delete_path", { path }).catch(() => {});
    await invoke("delete_path", { path: `${path}.meta` }).catch(() => {});
  }

  await useProjectStore.getState().refresh();
  const clips = gltf.animations ?? [];
  console.log(
    `Unpacked ${fileName}: ${materials.size} material${materials.size === 1 ? "" : "s"}, ` +
      `${textureFiles.size} texture${textureFiles.size === 1 ? "" : "s"}` +
      (geometryCount ? `, ${geometryCount} geometr${geometryCount === 1 ? "y" : "ies"}` : "") +
      (clips.length ? `, ${clips.length} clip${clips.length === 1 ? "" : "s"}` : "") +
      dracoNote,
  );
  return folder;
}
