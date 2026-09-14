/**
 * GI's CPU-side material scans must never pick a LAYERED texture as a plain map.
 *
 * Reported 2026-09-14: enabling GI on a scene with styled architecture filled
 * the console with "no matching call to 'textureSample(texture_2d_array<f32>,
 * sampler, vec2<f32>)'". The styled role material reads
 * `texture(styleArray).depth(layer)`; the roughness classifier and the albedo
 * resolver walked down to that DataArrayTexture and handed it to the shared
 * 2D "GI blit", whose binding then became an array under a vec2 sample.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { attribute, texture, vec4 } from "three/tsl";

import { isFlatTexture, resolveMaterialAlbedo, textureValueOf } from "../src/modules/gi/materialNodeBindings.js";
import { giRoughnessSourceOf } from "../src/modules/gi/giLight.js";

const arrayTexture = () => new THREE.DataArrayTexture(new Uint8Array(4 * 4 * 4 * 2), 4, 4, 2);

test("isFlatTexture accepts 2D maps and rejects layered textures", () => {
  assert.equal(isFlatTexture(new THREE.Texture()), true);
  assert.equal(isFlatTexture(new THREE.DataTexture(new Uint8Array(4), 1, 1)), true);
  assert.equal(isFlatTexture(arrayTexture()), false);
  assert.equal(isFlatTexture(new THREE.Data3DTexture(new Uint8Array(8), 1, 1, 2)), false);
  assert.equal(isFlatTexture(null), false);
});

test("a styled (array-layer) material yields no roughness texture and no albedo map", () => {
  const arrays = { map: arrayTexture(), rough: arrayTexture() };
  const layer = attribute("styleLayer", "float").add(0.5).floor().toInt();
  const material = new THREE.MeshStandardNodeMaterial();
  material.colorNode = vec4(texture(arrays.map).depth(layer).rgb, 1);
  material.roughnessNode = texture(arrays.rough).depth(layer).r;
  assert.equal(giRoughnessSourceOf(material), null);
  assert.equal(textureValueOf(material.colorNode), null);
  assert.equal(resolveMaterialAlbedo(material).map, null);

  // The classic fields get the same guard.
  const classic = new THREE.MeshStandardNodeMaterial();
  classic.map = arrayTexture();
  classic.roughnessMap = arrayTexture();
  assert.equal(resolveMaterialAlbedo(classic).map, null);
  assert.equal(giRoughnessSourceOf(classic), null);
});

test("a 2D roughness map node is still recognised", () => {
  const map = new THREE.Texture();
  const material = new THREE.MeshStandardNodeMaterial();
  material.roughnessNode = texture(map).g;
  const src = giRoughnessSourceOf(material);
  assert.equal(src?.tex, map);
  assert.equal(src?.channel, "g");
  const albedo = new THREE.MeshStandardNodeMaterial();
  albedo.colorNode = texture(map);
  assert.equal(resolveMaterialAlbedo(albedo).map, map);
});
