import assert from "node:assert/strict";
import test from "node:test";
import { createGltfLoader } from "../src/engine/gltfLoader.js";

test("converts legacy spec/gloss materials before GLTFLoader warns or builds materials", async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    const json = {
      asset: { version: "2.0" },
      extensionsUsed: ["KHR_materials_pbrSpecularGlossiness"],
      extensionsRequired: ["KHR_materials_pbrSpecularGlossiness"],
      materials: [{
        extensions: {
          KHR_materials_pbrSpecularGlossiness: {
            diffuseFactor: [0.2, 0.3, 0.4, 1],
            specularFactor: [0.5, 0.6, 0.7],
            glossinessFactor: 0.75,
          },
        },
      }],
      scenes: [{ nodes: [] }],
      nodes: [],
      scene: 0,
    };
    const result = await createGltfLoader().parseAsync(JSON.stringify(json), "");
    const material = result.parser.json.materials[0];
    assert.deepEqual(material.pbrMetallicRoughness.baseColorFactor, [0.2, 0.3, 0.4, 1]);
    assert.equal(material.pbrMetallicRoughness.metallicFactor, 0);
    assert.equal(material.pbrMetallicRoughness.roughnessFactor, 0.25);
    assert.deepEqual(material.extensions.KHR_materials_specular.specularColorFactor, [0.5, 0.6, 0.7]);
    assert.equal(warnings.some((line) => line.includes("Unknown extension")), false);
  } finally {
    console.warn = originalWarn;
  }
});
