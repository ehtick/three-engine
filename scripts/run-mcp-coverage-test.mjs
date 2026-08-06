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
  gi: "Global illumination is one component with properties; the bake is automatic and driven by the scene, not by a button.",
  postprocessing: "Effects are properties of the post component; enabling the module is module.setEnabled.",
  "physics-rapier": "Bodies, colliders and joints are components; the layer matrix is scene.setSettings.",
  "virtual-geometry": "Cluster building happens on import when the module is on; the flag is a component/.meta property.",
};

/** Which op group answers for each module. */
const MODULE_OPS = {
  ambientcg: "library",
  polyhaven: "library",
  sketchfab: "library",
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
  ["materials", "material"],
  ["prefabs", "prefab"],
  ["the Modules panel", "module"],
  ["the Build panel", "build"],
  ["the Texture Editor", "texture"],
  ["the Geometry Editor", "geometry"],
  ["the Audio Editor", "audio"],
  ["the asset library browsers", "library"],
  ["Source Control", "git"],
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
