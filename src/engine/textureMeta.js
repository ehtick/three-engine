import * as THREE from "three/webgpu";

/**
 * Texture import settings, stored next to the image as `<file>.meta` JSON.
 * Missing file / missing keys fall back to these defaults.
 */
export const TEXTURE_META_DEFAULTS = {
  filter: "linear", // "linear" | "nearest"
  wrapS: "repeat", // "repeat" | "clamp" | "mirror"
  wrapT: "repeat",
  repeat: [1, 1],
  offset: [0, 0],
  center: [0, 0],
  rotation: 0,
  channel: 0,
  flipY: true, // false for glTF-extracted images (top-left UV origin)
  colorSpace: "", // "" = keep loader default; "srgb" | "linear" force it (PBR data maps)
};

const WRAP = {
  repeat: THREE.RepeatWrapping,
  clamp: THREE.ClampToEdgeWrapping,
  mirror: THREE.MirroredRepeatWrapping,
};

export function applyTextureMeta(texture, meta) {
  const m = { ...TEXTURE_META_DEFAULTS, ...(meta ?? {}) };
  texture.magFilter = m.filter === "nearest" ? THREE.NearestFilter : THREE.LinearFilter;
  texture.minFilter =
    m.filter === "nearest" ? THREE.NearestMipmapNearestFilter : THREE.LinearMipmapLinearFilter;
  texture.wrapS = WRAP[m.wrapS] ?? THREE.RepeatWrapping;
  texture.wrapT = WRAP[m.wrapT] ?? THREE.RepeatWrapping;
  texture.repeat.set(m.repeat?.[0] ?? 1, m.repeat?.[1] ?? 1);
  texture.offset.set(m.offset?.[0] ?? 0, m.offset?.[1] ?? 0);
  texture.center.set(m.center?.[0] ?? 0, m.center?.[1] ?? 0);
  texture.rotation = Number(m.rotation) || 0;
  texture.channel = Math.max(0, Math.min(3, Math.round(Number(m.channel) || 0)));
  texture.flipY = m.flipY !== false;
  // Explicit color space wins over whatever the loading path assumed (the
  // shader-graph texture node defaults to sRGB, which is wrong for normal /
  // roughness / AO maps — their .meta says "linear").
  if (m.colorSpace === "srgb") texture.colorSpace = THREE.SRGBColorSpace;
  else if (m.colorSpace === "linear") texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}
