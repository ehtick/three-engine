/**
 * Builds the shader graph for a "ready to use" PBR .mat: texture nodes →
 * Principled BSDF → Material Output, exactly as a user would wire it by hand
 * in the Shader Graph panel (so it stays fully editable). Shared by the
 * Poly Haven importer and the GLB unpack pipeline.
 *
 * `maps` holds asset paths per slot: diffuse, normal (GL convention),
 * roughness, ao, metalness, and `arm` — a packed R=AO / G=rough / B=metal
 * image (Poly Haven's arm; glTF's metallicRoughness ORM has the same layout).
 * Packed channels only fill slots without a dedicated map. Pass
 * `armHasAo: false` when the packed image's red channel isn't trustworthy
 * occlusion (glTF metallicRoughness textures leave R undefined unless the
 * material's own aoMap points at the same image).
 */
export function buildPbrGraph(maps, { armHasAo = true, factors = {} } = {}) {
  const nodes = [{ id: "out", type: "output", props: {}, position: { x: 980, y: 200 } }];
  const edges = [];
  const bsdf = {
    id: "bsdf",
    type: "principledBsdf",
    // Prop keys must match what compileShaderGraph reads in tslGraph.js
    // (NODE_TYPES.principledBsdf.inputs). The PBR builder used to write
    // `color` here and `color` as the edge targetHandle, which was correct
    // for the legacy shaderGraph.js runtime; the live runtime reads from
    // tslGraph.js, which uses the same `color` / `specularColor` / `opacity`
    // / `emissive` / `thickness` keys the panel shows in its BSDF node UI,
    // so we keep that mapping here.
    props: {
      color: factors.color ?? "#ffffff",
      roughness: factors.roughness ?? 1,
      metalness: factors.metalness ?? 1,
      ior: factors.ior ?? 1.5,
      specularIntensity: factors.specularIntensity ?? 0.5,
      specularColor: factors.specularColor ?? "#ffffff",
      emissive: factors.emissive ?? "#000000",
      emissiveStrength: factors.emissiveStrength ?? 1,
      opacity: factors.opacity ?? 1,
      anisotropy: factors.anisotropy,
      clearcoat: factors.clearcoat,
      clearcoatRoughness: factors.clearcoatRoughness,
      sheen: factors.sheen,
      sheenRoughness: factors.sheenRoughness,
      transmission: factors.transmission,
      thickness: factors.thickness,
    },
    position: { x: 620, y: 80 },
  };
  nodes.push(bsdf);
  edges.push({ source: "bsdf", sourceHandle: "out", target: "out", targetHandle: "surface" });

  let row = 0;
  const texNode = (slot, path) => {
    const id = `tex_${slot}`;
    nodes.push({ id, type: "texture", props: { path }, position: { x: 120, y: row++ * 240 } });
    return id;
  };
  const wire = (source, sourceHandle, targetHandle) =>
    edges.push({ source, sourceHandle, target: "bsdf", targetHandle });

  // glTF/Three scalar and color factors multiply their corresponding maps;
  // a texture does not replace the factor. Emit that multiply explicitly so
  // the editable graph is faithful to the source material.
  const factoredWire = (slot, tex, channel, target, factor, identity = 1, kind = "float") => {
    if (factor == null || factor === identity) {
      wire(tex, channel, target);
      return;
    }
    const valueId = `factor_${slot}`;
    const mulId = `mul_${slot}`;
    nodes.push({ id: valueId, type: kind, props: { value: factor }, position: { x: 330, y: row * 160 } });
    nodes.push({ id: mulId, type: "multiply", props: {}, position: { x: 450, y: row * 160 } });
    edges.push({ source: tex, sourceHandle: channel, target: mulId, targetHandle: "a" });
    edges.push({ source: valueId, sourceHandle: "out", target: mulId, targetHandle: "b" });
    wire(mulId, "out", target);
  };

  let diffuseId = null;
  if (maps.diffuse) {
    diffuseId = texNode("diffuse", maps.diffuse);
    // Edge handle must match the principledBsdf input name in tslGraph.js.
    factoredWire("color", diffuseId, "out", "color", factors.color, "#ffffff", "color");
    if (factors.useDiffuseAlpha) {
      factoredWire("opacity", diffuseId, "a", "opacity", factors.opacity ?? 1);
    }
  }
  if (maps.roughness) factoredWire("roughness", texNode("roughness", maps.roughness), "g", "roughness", factors.roughness ?? 1);
  if (maps.ao) factoredWire("ao", texNode("ao", maps.ao), "r", "ao", factors.ao ?? 1);
  if (maps.metalness) factoredWire("metalness", texNode("metalness", maps.metalness), "b", "metalness", factors.metalness ?? 1);
  if (maps.arm) {
    const id = texNode("arm", maps.arm);
    if (!maps.ao && armHasAo) wire(id, "r", "ao");
    if (!maps.roughness) factoredWire("roughness", id, "g", "roughness", factors.roughness ?? 1);
    if (!maps.metalness) factoredWire("metalness", id, "b", "metalness", factors.metalness ?? 1);
  }
  if (maps.glossiness) {
    const tex = texNode("glossiness", maps.glossiness);
    let source = tex;
    let sourceHandle = "a";
    if (factors.glossiness != null && factors.glossiness !== 1) {
      const factor = "factor_glossiness";
      const multiply = "mul_glossiness";
      nodes.push({ id: factor, type: "float", props: { value: factors.glossiness }, position: { x: 330, y: row * 160 } });
      nodes.push({ id: multiply, type: "multiply", props: {}, position: { x: 450, y: row * 160 } });
      edges.push({ source: tex, sourceHandle: "a", target: multiply, targetHandle: "a" });
      edges.push({ source: factor, sourceHandle: "out", target: multiply, targetHandle: "b" });
      source = multiply;
      sourceHandle = "out";
    }
    const invert = "invert_glossiness";
    nodes.push({ id: invert, type: "oneMinus", props: {}, position: { x: 530, y: row * 160 } });
    edges.push({ source, sourceHandle, target: invert, targetHandle: "x" });
    wire(invert, "out", "roughness");
  }
  if (maps.normal) {
    const tex = texNode("normal", maps.normal);
    nodes.push({ id: "nmap", type: "normalMap", props: { scale: factors.normalScale ?? 1 }, position: { x: 400, y: 420 } });
    edges.push({ source: tex, sourceHandle: "out", target: "nmap", targetHandle: "color" });
    edges.push({ source: "nmap", sourceHandle: "out", target: "bsdf", targetHandle: "normal" });
  }
  if (maps.emissive) {
    factoredWire("emissive", texNode("emissive", maps.emissive), "out", "emissive", factors.emissive, "#ffffff", "color");
  }
  if (maps.opacity) factoredWire("opacity", texNode("opacity", maps.opacity), "g", "opacity", factors.opacity ?? 1);
  if (maps.anisotropy) factoredWire("anisotropy", texNode("anisotropy", maps.anisotropy), "b", "anisotropy", factors.anisotropy ?? 1);
  if (maps.clearcoat) factoredWire("clearcoat", texNode("clearcoat", maps.clearcoat), "r", "clearcoat", factors.clearcoat ?? 1);
  if (maps.clearcoatRoughness) factoredWire("clearcoatRoughness", texNode("clearcoatRoughness", maps.clearcoatRoughness), "g", "clearcoatRoughness", factors.clearcoatRoughness ?? 1);
  if (maps.transmission) factoredWire("transmission", texNode("transmission", maps.transmission), "r", "transmission", factors.transmission ?? 1);
  if (maps.thickness) factoredWire("thickness", texNode("thickness", maps.thickness), "g", "thickness", factors.thickness ?? 1);
  if (maps.sheen) factoredWire("sheen", texNode("sheen", maps.sheen), "out", "sheen", factors.sheen, "#ffffff", "color");
  if (maps.sheenRoughness) factoredWire("sheenRoughness", texNode("sheenRoughness", maps.sheenRoughness), "a", "sheenRoughness", factors.sheenRoughness ?? 1);
  if (maps.specularIntensity) factoredWire("specularIntensity", texNode("specularIntensity", maps.specularIntensity), "a", "specularIntensity", factors.specularIntensity ?? 1);
  if (maps.specularColor) factoredWire("specularColor", texNode("specularColor", maps.specularColor), "out", "specularColor", factors.specularColor, "#ffffff", "color");
  return { nodes, edges };
}
