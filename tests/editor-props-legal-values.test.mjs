import test from "node:test";
import assert from "node:assert/strict";
import { LightComponent } from "../src/engine/components/LightComponent.js";
import { registerComponent } from "../src/engine/components/registry.js";
import { assertLegalValue } from "../src/editor/api/props.js";

registerComponent(LightComponent);

// 09-14: `light.shadowMode` has two schema rows (directional: map/clipmap/gi,
// point/spot: map/gi). The validator kept only the last row and refused the
// directional light's legal `clipmap`, so no agent could switch a sun to
// clipmap shadows.
test("a select key with several schema rows accepts a value any row allows", () => {
  const type = LightComponent.type ?? "light";
  assert.doesNotThrow(() => assertLegalValue(type, "shadowMode", "clipmap"));
  assert.doesNotThrow(() => assertLegalValue(type, "shadowMode", "map"));
  assert.throws(() => assertLegalValue(type, "shadowMode", "bogus"), /not a legal value/);
});
