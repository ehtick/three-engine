import * as THREE from 'three/webgpu';
import { attribute, bumpMap, mix, normalWorldGeometry, positionWorld, texture, vec2, vec3 } from 'three/tsl';
import { resolveAssetUrl } from '../../engine/assetResolver.js';

/** Optional local material assets, separate from the deterministic landscape.
 * A caller can supply another manifest with the same grass/soil/rock roles.
 * The returned owner must outlive all materials borrowing its textures. */
/**
 * Roughly what a surface looks like from far enough away that its detail is
 * gone. The grass reads this so a blade's root can be the colour of the ground
 * it grows out of — otherwise the root matches the procedural palette while the
 * terrain renders these textures, and the sward sits on the ground as a
 * separate layer. Drawing to one pixel is the box filter of the whole image.
 */
const FALLBACK_AVERAGE = Object.freeze({
  grass: [.076, .105, .038], soil: [.093, .062, .039], rock: [.132, .118, .098],
});
function averageAlbedo(texture, role) {
  const image = texture?.image;
  if (!image?.width || typeof document === "undefined") return [...FALLBACK_AVERAGE[role]];
  try {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(image, 0, 0, 1, 1);
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    // These maps are sRGB; the tint is consumed in linear light like any albedo.
    const linear = value => { const c = value / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; };
    return [linear(r), linear(g), linear(b)];
  } catch { return [...FALLBACK_AVERAGE[role]]; }
}

export async function loadWorldSurfaceMaps(source = null, { resolve = resolveAssetUrl, loader = new THREE.TextureLoader() } = {}) {
  let manifest = source ?? (await import('./worldBuiltinSurfaces.js')).WORLD_BUILTIN_SURFACES, baseURL = null;
  // Compatibility for standalone callers. Production World embeds role refs
  // so asset discovery sees every path without fetching a separate document.
  if (typeof manifest === 'string') {
    const response = await fetch(await resolve(manifest));
    if (!response.ok) throw new Error(`World surface manifest: HTTP ${response.status}`);
    manifest = await response.json(); baseURL = response.url;
  } else if (!Array.isArray(manifest.assets)) {
    manifest = { provider: 'Project', assets: ['grass', 'soil', 'rock'].map(role => ({
      id: role, role, physicalDimensions: { meters: manifest[role]?.size },
      maps: { albedo: { path: manifest[role]?.albedo }, height: { path: manifest[role]?.height } },
    })) };
  }
  const owned = [], roles = {};
  if (!Array.isArray(manifest.assets)) throw new Error('World surface manifest needs an assets array');
  const jobs = [];
  for (const role of ['grass', 'soil', 'rock']) {
    const matches = manifest.assets.filter(entry => entry.role === role);
    if (matches.length !== 1) throw new Error(`World surface manifest needs exactly one '${role}' layer`);
    const asset = matches[0];
    const size = asset?.physicalDimensions?.meters;
    if (!size || size.length !== 2 || !size.every(value => Number.isFinite(value) && value > 0)) {
      throw new Error(`World surface '${role}' needs two positive tile dimensions in metres`);
    }
    roles[role] = { id: asset.id, size: size.slice() };
    for (const kind of ['albedo', 'height']) {
      const map = asset.maps?.[kind];
      const path = typeof map === 'string' ? map : map?.path;
      const url = path ? await resolve(path) : map?.url ?? map?.publicURL;
      if (!url) throw new Error(`World surface '${role}' has no ${kind} map`);
      jobs.push({ role, kind, url: baseURL ? new URL(url, baseURL).href : url });
    }
  }
  const results = await Promise.allSettled(jobs.map(({ role, kind, url }) => new Promise((resolve, reject) => {
    const map = loader.load(url, () => resolve(map), undefined, () => reject(new Error(`World surface failed to load: ${url}`)));
    owned.push(map);
    map.name = `World surface · ${roles[role].id} ${kind}`;
    map.colorSpace = kind === 'albedo' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    map.wrapS = map.wrapT = THREE.RepeatWrapping;
    map.minFilter = THREE.LinearMipmapLinearFilter; map.magFilter = THREE.LinearFilter;
    map.generateMipmaps = true; map.anisotropy = 4;
    roles[role][kind] = map;
  })));
  const failed = results.find(result => result.status === 'rejected');
  if (failed) { owned.forEach(map => map.dispose()); throw failed.reason; }
  for (const role of ['grass', 'soil', 'rock']) roles[role].average = averageAlbedo(roles[role].albedo, role);
  let disposed = false;
  return { ...roles, report: { mode: 'materials', source: manifest.provider, manifest: typeof source === 'string' ? source : 'embedded',
    textureCount: owned.length, downloadBytes: manifest.totalTextureBytes,
    layers: Object.entries(roles).map(([role, value]) => ({ role, id: value.id, tileMetres: value.size,
      albedo: { width: value.albedo.image.width, height: value.albedo.image.height, colorSpace: value.albedo.colorSpace },
      height: { width: value.height.image.width, height: value.height.image.height, colorSpace: value.height.colorSpace } })),
    heightUse: 'Browser-decoded scalar bump; artistic amplitude, no geometry displacement' },
    dispose() { if (disposed) return; disposed = true; owned.forEach(map => map.dispose()); },
  };
}

/** Six sampled textures, zero storage buffers. Geological projections share
 * world height so bedding stays horizontal around a cliff. Weights must use
 * geometric normals: feeding the bumped normal back into bump is recursive. */
export function applyGroundSurfaceMaps(material, maps, { scale = 1, bump = 1 } = {}) {
  const tileScale = THREE.MathUtils.clamp(Number.isFinite(scale) ? scale : 1, .5, 2);
  const bumpStrength = THREE.MathUtils.clamp(Number.isFinite(bump) ? bump : 1, 0, 2);
  const masks = attribute('worldSurface', 'vec4'); // soil, exposed rock, moisture, forest
  const uv = layer => positionWorld.xz.div(vec2(layer.size[0] * tileScale, layer.size[1] * tileScale));
  const grassColor = texture(maps.grass.albedo, uv(maps.grass)).rgb;
  const soilColor = texture(maps.soil.albedo, uv(maps.soil)).rgb;
  const grassHeight = texture(maps.grass.height, uv(maps.grass)).r;
  const soilHeight = texture(maps.soil.height, uv(maps.soil)).r;
  const weightsRaw = normalWorldGeometry.abs().pow(4);
  const weights = weightsRaw.div(weightsRaw.x.add(weightsRaw.y).add(weightsRaw.z));
  const bed = positionWorld.y.add(positionWorld.x.mul(.14)).sub(positionWorld.z.mul(.09));
  const rockUV = [vec2(positionWorld.z, bed), positionWorld.xz, vec2(positionWorld.x, bed)]
    .map(value => value.div(vec2(maps.rock.size[0] * tileScale, maps.rock.size[1] * tileScale)));
  const stone = map => texture(map, rockUV[0]).mul(weights.x)
    .add(texture(map, rockUV[1]).mul(weights.y)).add(texture(map, rockUV[2]).mul(weights.z));
  const stoneColor = stone(maps.rock.albedo).rgb, stoneHeight = stone(maps.rock.height).r;
  // Height variation breaks the half-metre field interpolation at transitions.
  // All masks remain clamped; no albedo tint from the old dark vertex palette.
  const soil = masks.x.add(soilHeight.sub(.5).mul(.20)).smoothstep(.05, .95);
  const exposed = masks.y.add(stoneHeight.sub(.5).mul(.12)).smoothstep(.10, .85);
  const wet = masks.z.smoothstep(.60, .98);
  const color = mix(mix(grassColor, soilColor, soil), stoneColor, exposed);
  // The vertex `color` attribute is otherwise unused in this mode — the
  // averaged textures above are the actual albedo — but `worldPlanData.js`
  // bakes a near-white TINT into it wherever the drawn grass field covers the
  // ground, biased toward the sward's own base colour, so a covered cell's
  // soil texture reads as the sward's tone rather than bare dirt in the gaps
  // between blades. Everywhere else the tint is ~1 and this is a no-op.
  material.colorNode = color.mul(mix(vec3(1), vec3(.61, .65, .63), wet)).mul(attribute('color', 'vec3'));
  // BumpMapNode rebuilds texture reads under offset-UV contexts. Reusing the
  // reads already compiled for color caches their unshifted result, subtracts
  // it from itself and silently removes all soil/stone relief. Share texture
  // resources, but give the normal branch independent sample nodes.
  const soilBump = texture(maps.soil.height, uv(maps.soil)).r;
  const stoneBump = stone(maps.rock.height).r;
  const soilNormal = masks.x.add(soilBump.sub(.5).mul(.20)).smoothstep(.05, .95);
  const exposedNormal = masks.y.add(stoneBump.sub(.5).mul(.12)).smoothstep(.10, .85);
  // These are relative bump amplitudes, not metres of displaced geometry.
  // Three normalizes the surface derivatives; tiny metre-like constants make
  // a correctly sampled height map practically flat at this viewing scale.
  const relief = mix(mix(grassHeight.mul(.35), soilBump.mul(.45), soilNormal), stoneBump, exposedNormal);
  material.normalNode = bumpMap(relief, bumpStrength);
  material.roughnessNode = mix(mix(.94, .86, exposed), .52, wet);
  material.name = 'World landscape · layered ground materials';
  material.userData.landscape = { ...material.userData.landscape, surfaceMode: 'materials',
    materialTextures: 6, surfaceScale: tileScale, surfaceBump: bumpStrength, vertexField: 'worldSurface' };
}
