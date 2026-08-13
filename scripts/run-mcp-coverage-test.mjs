// MCP coverage: can an agent do what a person can do?
//
//   node scripts/run-mcp-coverage-test.mjs
//
// No browser, no dev server — a source scan over the module catalogue and the
// op registry.
//
// ## Why this is a test and not a checklist
//
// "Every feature ships with MCP tools" is a rule that cannot be enforced by
// remembering it. A module that ships without ops breaks nothing: the panel
// works, every test passes, and the missing capability is invisible from inside
// the editor — you only find it much later, when an agent is asked to do
// something and quietly cannot. By then the feature is "finished" and nobody
// wants to reopen it.
//
// So the catalogue is the source of truth here. A new module under src/modules/
// joins this test the moment it registers an id, and it must either have ops or
// say — in COMPONENT_ONLY below, with a reason — why its whole surface is
// already reachable through component.setProp. "I forgot" is not one of the
// available answers.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

// --- the op registry, read out of the source ---------------------------------

const opDir = path.join(ROOT, "src/editor/api/ops");
const opFiles = fs.readdirSync(opDir).filter((f) => f.endsWith(".js"));
const ops = [];
for (const file of opFiles) {
  const src = fs.readFileSync(path.join(opDir, file), "utf8");
  for (const match of src.matchAll(/name:\s*"([\w.]+)"/g)) ops.push({ name: match[1], file });
}
const opNames = ops.map((op) => op.name);
const has = (prefix) => opNames.some((name) => name === prefix || name.startsWith(`${prefix}.`));

check("the op registry is readable from source", ops.length > 60, `${ops.length} ops across ${opFiles.length} files`);

// Every op must describe itself: the description IS the tool documentation an
// agent reads, and an undescribed tool is one it will not reach for.
const descriptions = [];
for (const file of opFiles) {
  const src = fs.readFileSync(path.join(opDir, file), "utf8");
  for (const block of src.split("defineOp({").slice(1)) {
    const name = /name:\s*"([\w.]+)"/.exec(block)?.[1];
    if (!name) continue;
    const description = /description:\s*(?:\n\s*)?"([^"]*)/.exec(block)?.[1] ?? "";
    descriptions.push({ name, length: description.length });
  }
}
const thin = descriptions.filter((d) => d.length < 40);
check("every op explains itself to the model calling it", thin.length === 0, thin.map((d) => d.name).join(", "));

// `defineOp` throws at import time when the implementation is missing — which
// means the editor fails to boot, but only once someone opens it: the build
// succeeds, every source-scanning test passes, and nothing here noticed. It has
// happened (an ops file written with `handler:` instead of `run:`), so the scan
// checks the shape it can actually see.
const unimplemented = [];
for (const file of opFiles) {
  const src = fs.readFileSync(path.join(opDir, file), "utf8");
  for (const block of src.split("defineOp({").slice(1)) {
    const name = /name:\s*"([\w.]+)"/.exec(block)?.[1];
    if (!name) continue;
    // Only the portion belonging to this op — the next defineOp's body must not
    // satisfy this one's check.
    if (!/\brun\s*[:(]/.test(block)) unimplemented.push(name);
  }
}
check("every op has a run() implementation", unimplemented.length === 0, unimplemented.join(", "));

// --- component properties: the half of the surface that is not an op ---------
//
// COMPONENT_ONLY below is only honest if `component.setProp` really can reach
// everything, and reaching a property means being able to name a legal VALUE
// for it. `component.types` is the one channel for that: it projects each
// schema's key/label/type/options, and for a `select` the `options` array IS
// the enum. A select that declares none is a property an assistant can only set
// by guessing — and guessing wrong is silent, because the command bus stores
// whatever it is handed and the inspector is the only thing that would have
// constrained it. That is the failure this file exists to catch, one layer down
// from a missing op: the tool is there, the property is there, and the agent
// still cannot use it.
//
// The mesh's giMobility/giTrace pair (the 2026-08-07 split of `giDynamic`) is
// exactly this case — neither tag has an op of its own, and neither needs one,
// so their options list is the whole of their MCP surface.

const schemaFiles = [];
const collectSchemas = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectSchemas(full);
    else if (entry.name.endsWith(".js") && fs.readFileSync(full, "utf8").includes("static schema = [")) {
      schemaFiles.push(full);
    }
  }
};
collectSchemas(path.join(ROOT, "src/engine/components"));
collectSchemas(path.join(ROOT, "src/modules"));

const optionless = [];
let selects = 0;
for (const file of schemaFiles) {
  const src = fs.readFileSync(file, "utf8");
  // Scoped to `static schema = [ … ]` so a `type: "select"` in unrelated code
  // cannot be mistaken for a property descriptor. Inside it, descriptors run
  // one after another and each opens with `key:`, so splitting on that gives
  // one chunk per property without matching a single bracket.
  for (const [, region] of src.matchAll(/static schema = \[([\s\S]*?)\n\s*\];/g)) {
    for (const chunk of region.split(/\bkey:\s*"/).slice(1)) {
      const key = /^(\w+)"/.exec(chunk)?.[1];
      if (!key || !/type:\s*"select"/.test(chunk)) continue;
      selects++;
      if (!/\boptions:/.test(chunk)) optionless.push(`${path.basename(file, ".js")}.${key}`);
    }
  }
}
check(
  "every select property tells an agent its legal values",
  optionless.length === 0 && selects > 20,
  optionless.length
    ? `no options on ${optionless.join(", ")}`
    : `${selects} select props across ${schemaFiles.length} components`,
);

// --- modules: each one either has ops, or says why it does not ----------------

const moduleIds = [];
for (const dir of fs.readdirSync(path.join(ROOT, "src/modules"), { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  const index = path.join(ROOT, "src/modules", dir.name, "index.js");
  if (!fs.existsSync(index)) continue;
  const id = /id:\s*"([\w-]+)"/.exec(fs.readFileSync(index, "utf8"))?.[1];
  if (id) moduleIds.push(id);
}
check("found the module catalogue", moduleIds.length >= 15, moduleIds.join(", "));

/**
 * Modules whose entire surface really is component properties, plus the reason.
 *
 * This list is allowed to exist because for some modules it is the truth:
 * enabling `postprocessing` and setting bloom threshold is `module.setEnabled`
 * followed by `component.setProp`, and inventing `post.setBloom` would be a
 * second way to do the same thing that drifts from the first. What is NOT
 * allowed is a module with buttons — a bake, an import, a compress — and no op
 * for them, because a button is a capability `component.setProp` cannot reach.
 */
const COMPONENT_ONLY = {
  gi: "Global illumination is properties — the gi component for the volume, and giMobility/giTrace on each mesh; the bake is automatic and driven by the scene, not by a button.",
  postprocessing: "Effects are properties of the post component; enabling the module is module.setEnabled.",
  "physics-rapier": "Bodies, colliders and joints are components; the layer matrix is scene.setSettings.",
  "virtual-geometry": "Cluster building happens on import when the module is on; the flag is a component/.meta property.",
};

/** Which op group answers for each module. */
const MODULE_OPS = {
  ambientcg: "library",
  polyhaven: "library",
  sketchfab: "library",
  polypizza: "library",
  itchio: "library",
  "audio-library": "audio.library",
  "audio-editor": "audio",
  "texture-editor": "texture",
  navigation: "nav",
  terrain: "terrain",
  basis: "asset.compress",
  draco: "asset.compress",
};

for (const id of moduleIds) {
  const reason = COMPONENT_ONLY[id];
  if (reason) {
    check(`${id} is component-only, and says why`, reason.length > 30, reason.slice(0, 60));
    continue;
  }
  const group = MODULE_OPS[id];
  check(
    `${id} is drivable by an agent`,
    !!group && has(group),
    group ? `via ${group}.*` : "no ops and not listed as component-only — add ops or explain",
  );
}

// --- the editor's own panels -------------------------------------------------
//
// Modules are only half of it: the built-in panels are features too, and the
// same rule applies to them.

const PANEL_SURFACES = [
  ["the Hierarchy", "entity"],
  ["the Inspector", "component"],
  ["the Assets panel", "asset"],
  ["the viewport", "viewport"],
  ["Play controls", "play"],
  ["undo/redo", "history"],
  ["the Console", "console"],
  ["scene settings", "scene"],
  ["Project Settings", "project"],
  ["materials", "material"],
  ["prefabs", "prefab"],
  ["the Modules panel", "module"],
  ["the Build panel", "build"],
  ["the Texture Editor", "texture"],
  ["the Geometry Editor", "geometry"],
  ["the Audio Editor", "audio"],
  ["the asset library browsers", "library"],
  ["Source Control", "git"],
  ["the Events panel", "events"],
];
for (const [label, group] of PANEL_SURFACES) {
  check(`${label} has tools`, has(group), `${group}.*`);
}

// --- the facade and the tools stay in step -----------------------------------

const facade = fs.readFileSync(path.join(ROOT, "src/editor/api/index.js"), "utf8");
for (const file of opFiles) {
  check(`ops/${file} is registered at boot`, facade.includes(`./ops/${file}`), "api/index.js imports every op module");
}

// ---------------------------------------------------------------------------
const failed = results.filter((r) => !r.ok);
console.log(
  `\nMCP-COVERAGE ${failed.length === 0 ? "PASS" : "FAIL"} — ${results.length - failed.length}/${results.length} checks, ${ops.length} ops`,
);
process.exit(failed.length === 0 ? 0 : 1);
