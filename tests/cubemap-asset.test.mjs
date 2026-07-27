import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";

import {
  CUBEMAP_DEFAULTS,
  CUBEMAP_FACES,
  cubemapFacePaths,
  guessCubemapFaces,
  isCubemapComplete,
  normalizeCubemapDef,
} from "../src/engine/cubemapAsset.js";
import {
  SCENE_SETTINGS_DEFAULTS,
  applySettingsToScene,
  mergeSettings,
} from "../src/engine/sceneSettings.js";

const FULL = {
  px: "sky/px.png",
  nx: "sky/nx.png",
  py: "sky/py.png",
  ny: "sky/ny.png",
  pz: "sky/pz.png",
  nz: "sky/nz.png",
};

test("face order matches three's CubeTextureLoader (+X −X +Y −Y +Z −Z)", () => {
  assert.deepEqual(
    CUBEMAP_FACES.map((f) => f.key),
    ["px", "nx", "py", "ny", "pz", "nz"],
  );
  assert.deepEqual(cubemapFacePaths({ faces: FULL }), [
    "sky/px.png",
    "sky/nx.png",
    "sky/py.png",
    "sky/ny.png",
    "sky/pz.png",
    "sky/nz.png",
  ]);
});

test("normalizes partial and malformed defs to all six slots", () => {
  const def = normalizeCubemapDef({ faces: { px: "a.png", bogus: "b.png", ny: 7 } });
  assert.deepEqual(Object.keys(def.faces).sort(), ["nx", "ny", "nz", "px", "py", "pz"]);
  assert.equal(def.faces.px, "a.png");
  assert.equal(def.faces.ny, ""); // non-string dropped
  assert.equal(def.faces.bogus, undefined);
  assert.deepEqual(normalizeCubemapDef(null).faces, CUBEMAP_DEFAULTS.faces);
});

test("completeness requires every face", () => {
  assert.equal(isCubemapComplete({ faces: FULL }), true);
  assert.equal(isCubemapComplete({ faces: { ...FULL, nz: "" } }), false);
  assert.equal(isCubemapComplete(CUBEMAP_DEFAULTS), false);
});

test("guesses faces from the usual filename conventions", () => {
  assert.deepEqual(
    guessCubemapFaces(["a/px.png", "a/nx.png", "a/py.png", "a/ny.png", "a/pz.png", "a/nz.png"]),
    {
      px: "a/px.png",
      nx: "a/nx.png",
      py: "a/py.png",
      ny: "a/ny.png",
      pz: "a/pz.png",
      nz: "a/nz.png",
    },
  );
  const worded = guessCubemapFaces([
    "sky_right.jpg",
    "sky_left.jpg",
    "sky_top.jpg",
    "sky_bottom.jpg",
    "sky_front.jpg",
    "sky_back.jpg",
  ]);
  assert.equal(worded.px, "sky_right.jpg");
  assert.equal(worded.ny, "sky_bottom.jpg");
  assert.equal(worded.nz, "sky_back.jpg");
  const posneg = guessCubemapFaces(["cube_posz.png", "cube_negz.png"]);
  assert.equal(posneg.pz, "cube_posz.png");
  assert.equal(posneg.nz, "cube_negz.png");
  // Unrecognizable names leave the slots for the user to fill in.
  assert.deepEqual(guessCubemapFaces(["one.png", "two.png"]), CUBEMAP_DEFAULTS.faces);
});

// ---------------------------------------------------------------------------
// Scene settings integration
// ---------------------------------------------------------------------------

function makeScene() {
  const scene = new THREE.Scene();
  return scene;
}
const ambient = () => new THREE.AmbientLight();

test("environment settings survive a partial merge", () => {
  const merged = mergeSettings(SCENE_SETTINGS_DEFAULTS, {
    environment: { cubemap: "Sky.cubemap", intensity: 2 },
  });
  assert.equal(merged.environment.cubemap, "Sky.cubemap");
  assert.equal(merged.environment.intensity, 2);
  // Untouched keys keep their defaults rather than vanishing.
  assert.equal(merged.environment.background, true);
  assert.equal(merged.environment.lighting, true);
  assert.equal(merged.environment.blur, 0);
  // A scene saved before cube maps existed still merges cleanly.
  const legacy = mergeSettings({ ...SCENE_SETTINGS_DEFAULTS, environment: undefined }, {});
  assert.deepEqual(legacy.environment, SCENE_SETTINGS_DEFAULTS.environment);
});

test("no cube map means the flat background color", () => {
  const scene = makeScene();
  applySettingsToScene({ ...SCENE_SETTINGS_DEFAULTS, background: "#112233" }, scene, ambient(), null);
  assert.equal(scene.background.getHexString(), "112233");
  assert.equal(scene.environment, null);
});

test("a component-owned environment texture is never clobbered by a settings apply", () => {
  // The HDRI EnvironmentComponent installs its own texture; touching an
  // unrelated scene setting must not wipe the sky out from under it.
  const scene = makeScene();
  const hdri = new THREE.Texture();
  scene.background = hdri;
  scene.environment = hdri;
  applySettingsToScene({ ...SCENE_SETTINGS_DEFAULTS, exposure: 2 }, scene, ambient(), null);
  assert.equal(scene.background, hdri);
  assert.equal(scene.environment, hdri);
});

test("a scene-owned environment texture is cleared when the cube map is removed", () => {
  const scene = makeScene();
  const ours = new THREE.Texture();
  ours.userData.sceneEnvironment = true;
  scene.background = ours;
  scene.environment = ours;
  applySettingsToScene({ ...SCENE_SETTINGS_DEFAULTS, background: "#000000" }, scene, ambient(), null);
  assert.equal(scene.environment, null);
  assert.equal(scene.background.isColor, true);
});
