/**
 * `resolveBootScene` is the whole fix for the "editor boots into mainScene,
 * then a moment later throws that away for lastScene" double load: a reload
 * used to guess from project.json, fully deserialize the wrong scene (assets,
 * GI build, shader compiles), and only THEN correct itself by loading the
 * right one on top. These three cases are the entire contract — reload
 * handoff beats lastScene beats mainScene, and never any other order.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { resolveBootScene } from "../src/editor/bootScene.js";

test("an editor.reload handoff wins over everything project.json says", () => {
  const projectMeta = { lastScene: "scenes/Complex.scene", mainScene: "scenes/Sponza.scene" };
  const reopenRequest = { scene: "C:/GAME/scenes/Complex.scene" };
  assert.equal(resolveBootScene(projectMeta, reopenRequest), "C:/GAME/scenes/Complex.scene");
});

test("with no reload handoff, the project's last scene wins over its main scene", () => {
  const projectMeta = { lastScene: "scenes/Complex.scene", mainScene: "scenes/Sponza.scene" };
  assert.equal(resolveBootScene(projectMeta, null), "scenes/Complex.scene");
  // A handoff with no scene (a reload with no scene ever open) is the same as none.
  assert.equal(resolveBootScene(projectMeta, { scene: null }), "scenes/Complex.scene");
});

test("main scene is the last resort, tried only once nothing else is known", () => {
  const projectMeta = { mainScene: "scenes/Sponza.scene" };
  assert.equal(resolveBootScene(projectMeta, null), "scenes/Sponza.scene");
  assert.equal(resolveBootScene({}, null), null);
  assert.equal(resolveBootScene(null, undefined), null);
});

test("never main-then-last: mainScene never outranks lastScene or a reload handoff", () => {
  const projectMeta = { lastScene: "scenes/Complex.scene", mainScene: "scenes/Sponza.scene" };
  assert.notEqual(resolveBootScene(projectMeta, null), projectMeta.mainScene);
  assert.notEqual(
    resolveBootScene(projectMeta, { scene: "scenes/Handoff.scene" }),
    projectMeta.mainScene,
  );
});
