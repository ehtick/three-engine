// A script file and the class it exports carry the same name, whichever end
// the user renames.
//
//   * rename the asset  → the DEFAULT-EXPORTED class is rewritten
//   * rename that class → the file is renamed back to match
//   * every other class in the file is left alone
//   * open tabs and the entities that reference the script follow the rename
//
//   npx vite --port 5217
//   node scripts/run-script-rename-smoke.mjs [url]
//
// HEADED=1 to watch it run.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5217/";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-scriptrename-"));
fs.writeFileSync(path.join(root, "project.json"), JSON.stringify({ name: "Rename", version: 1 }, null, 2));
fs.mkdirSync(path.join(root, "scripts"), { recursive: true });

// Two helper classes around the real one, because a script file holding several
// classes is the ordinary case and only the exported one may ever move.
const ALPHA = `import { Script } from "engine";

class Trajectory {
  constructor(public speed = 1) {}
}

export default class Alpha extends Script {
  onUpdate(dt: number) {
    void new Trajectory(dt);
  }
}

export class AlphaHelper {
  static of() { return new Trajectory(); }
}
`;
// The other spelling people write: declare, then default-export by name.
const BYNAME = `import { Script } from "engine";

class Sidecar {}

class Named extends Script {
  onStart() { void new Sidecar(); }
}

export default Named;
`;

const scripts = path.join(root, "scripts");
fs.writeFileSync(path.join(scripts, "Alpha.ts"), ALPHA);
fs.writeFileSync(path.join(scripts, "Named.ts"), BYNAME);
fs.writeFileSync(path.join(scripts, "Taken.ts"), "export default class Taken {}\n");
fs.writeFileSync(path.join(scripts, "Occupied.ts"), "export default class Occupied {}\n");

const p = (name) => path.join(scripts, name).replaceAll("\\", "/");

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
await installTauriShim(page, { writableRoot: root, verbose: !!process.env.VERBOSE });

const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (name) => {
  try {
    return fs.readFileSync(path.join(scripts, name), "utf8");
  } catch {
    return null;
  }
};

await page.goto(url, { waitUntil: "load", timeout: 45000 });
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
});
await wait(6000);

await page.evaluate(async (projectRoot) => {
  const importLive = (q) => {
    const prefix = location.origin + q;
    const fetched = performance.getEntriesByType("resource").map((e) => e.name)
      .filter((n) => n === prefix || n.startsWith(`${prefix}?`));
    const live = fetched.find((n) => n.includes("?")) ?? fetched[0];
    return import(/* @vite-ignore */ live ?? q);
  };
  globalThis.__importLive = importLive;
  const { ensureEngine } = await importLive("/src/editor/engineInstance.js");
  globalThis.__engine = await ensureEngine();
  const { useProjectStore } = await importLive("/src/editor/store/projectStore.js");
  globalThis.__openDone = false;
  useProjectStore.getState().openProject(projectRoot).then(() => (globalThis.__openDone = true));
}, root.replaceAll("\\", "/"));
for (let i = 0; i < 90 && !(await page.evaluate(() => globalThis.__openDone === true)); i++) await wait(500);

// An entity whose Scripts component points at Alpha.ts, so the rename has a
// reference to move.
await page.evaluate(async (file) => {
  const { commandBus } = await globalThis.__importLive("/src/editor/commands/CommandBus.js");
  const { CreateEntityCommand } = await globalThis.__importLive("/src/editor/commands/entityCommands.js");
  const { SetComponentPropCommand } = await globalThis.__importLive("/src/editor/commands/componentCommands.js");
  const create = new CreateEntityCommand({ name: "Runner", components: [{ type: "script" }] });
  commandBus.execute(create);
  globalThis.__runnerId = create.entityId;
  commandBus.execute(
    new SetComponentPropCommand(create.entityId, "script", "scripts",
      [{ path: file, enabled: true, attributes: {} }], "Set script"),
  );
}, p("Alpha.ts"));
await wait(600);

const slotPaths = () =>
  page.evaluate(
    () => (globalThis.__engine.getEntity(globalThis.__runnerId)?.getComponent("script")?.props?.scripts ?? [])
      .map((s) => s.path),
  );

/* -------------------------------------------------------------------------- */
/* 1 — rename the asset, the exported class follows                            */
/* -------------------------------------------------------------------------- */

console.log("\nrename the file");
await page.evaluate(async (file) => {
  const { renameEntry } = await globalThis.__importLive("/src/editor/assetOps.js");
  await renameEntry({ path: file, name: "Alpha.ts", is_dir: false }, "Beta.ts");
}, p("Alpha.ts"));
await wait(1500);

const beta = read("Beta.ts");
check("the file is renamed on disk", !!beta && !read("Alpha.ts"));
check("the exported class takes the new name", /export default class Beta\b/.test(beta ?? ""));
check("a helper class in the same file is untouched", /\bclass Trajectory\b/.test(beta ?? ""));
check("a second exported class is untouched", /export class AlphaHelper\b/.test(beta ?? ""));
check(
  "the entity's script slot follows the rename",
  (await slotPaths()).every((s) => /Beta\.ts$/.test(s)),
  JSON.stringify(await slotPaths()),
);

/* -------------------------------------------------------------------------- */
/* 2 — rename the class, the file follows                                      */
/* -------------------------------------------------------------------------- */

console.log("\nrename the class");
// Through the Code panel's own save path, editing the Monaco buffer the way a
// user would rather than writing the file behind the editor's back.
await page.evaluate(async (file) => {
  const { openCodeFile } = await globalThis.__importLive("/src/editor/codeStore.js");
  openCodeFile(file);
}, p("Beta.ts"));
for (let i = 0; i < 120; i++) {
  if (await page.evaluate(() => !!document.querySelector(".monaco-editor textarea"))) break;
  await wait(100);
}
await wait(1200);

const edited = await page.evaluate(async (file) => {
  const { getModel } = await globalThis.__importLive("/src/editor/code/monaco.js");
  const model = await getModel(file);
  model.setValue(model.getValue().replace("export default class Beta", "export default class Gamma"));
  return model.getValue().includes("class Gamma");
}, p("Beta.ts"));
check("the buffer holds the new class name", edited);

// The Save button, not a direct call: this gates the wiring, not the helper.
await wait(400);
const saved = await page.evaluate(() => {
  const button = [...document.querySelectorAll(".code-editor-bar .toolbar-btn")]
    .find((b) => /Save/i.test(b.textContent ?? "") && !b.disabled);
  button?.click();
  return !!button;
});
check("the Save button is live once the buffer is dirty", saved);
await wait(2500);

check("the file is renamed to match the class", !!read("Gamma.ts") && !read("Beta.ts"));
check("its contents are the edited ones", /export default class Gamma\b/.test(read("Gamma.ts") ?? ""));
check("the helper classes survived the second rename", /\bclass Trajectory\b/.test(read("Gamma.ts") ?? ""));
check(
  "the entity's script slot follows the class rename",
  (await slotPaths()).every((s) => /Gamma\.ts$/.test(s)),
  JSON.stringify(await slotPaths()),
);
const tabs = await page.evaluate(async () => {
  const { useCodeStore } = await globalThis.__importLive("/src/editor/codeStore.js");
  return useCodeStore.getState().files;
});
check(
  "the open tab points at the new file",
  tabs.some((t) => /Gamma\.ts$/.test(t)) && !tabs.some((t) => /Beta\.ts$/.test(t)),
  JSON.stringify(tabs.map((t) => t.split("/").pop())),
);

/* -------------------------------------------------------------------------- */
/* 3 — the declare-then-export spelling, and a name that is already taken       */
/* -------------------------------------------------------------------------- */

console.log("\nthe other spelling, and collisions");
const byName = await page.evaluate(async (file) => {
  const m = await globalThis.__importLive("/src/editor/scriptClassSync.js");
  const source = await (await globalThis.__importLive("/src/editor/assetOps.js")).invoke(
    "read_text_file", { path: file },
  );
  return {
    detected: m.defaultExportedClassName(source),
    // Renaming the class in that spelling must still move the file.
    target: m.filenameForScriptSource(file, source.replace("class Named", "class Renamed")
      .replace("export default Named", "export default Renamed")),
    // A stem that already PascalCases to the class name is in sync already.
    noop: m.filenameForScriptSource(file, source),
  };
}, p("Named.ts"));
check("`export default <Name>` is recognised", byName.detected === "Named", String(byName.detected));
check(
  "renaming it moves the file too",
  /Renamed\.ts$/.test(byName.target ?? ""),
  String(byName.target?.split("/").pop()),
);
check("a name that already agrees renames nothing", byName.noop === null, String(byName.noop));

const helperOnly = await page.evaluate(async () => {
  const m = await globalThis.__importLive("/src/editor/scriptClassSync.js");
  return {
    noDefault: m.defaultExportedClassName("class A {}\nexport class B {}\n"),
    valueDefault: m.defaultExportedClassName("class A {}\nexport default { a: 1 };\n"),
    commented: m.defaultExportedClassName("// export default class Ghost {}\nclass A {}\n"),
  };
});
check("a file with no default export names nothing", helperOnly.noDefault === null);
check("a default-exported value is not a class", helperOnly.valueDefault === null);
check("a commented-out declaration does not count", helperOnly.commented === null);

const collided = await page.evaluate(async (file) => {
  const m = await globalThis.__importLive("/src/editor/scriptClassSync.js");
  return m.renameScriptToMatchClass(file, "export default class Occupied {}\n");
}, p("Taken.ts"));
check("a rename onto an existing file is refused", collided === null, String(collided));
check("…and both files are still there", !!read("Taken.ts") && !!read("Occupied.ts"));

/* -------------------------------------------------------------------------- */

const failed = results.filter((r) => !r.ok);
const realErrors = errors.filter((e) => !/WebGPU|GPUAdapter|Deprecation|favicon|Failed to load resource/i.test(e));
if (realErrors.length) {
  console.log("\nConsole errors:");
  for (const e of realErrors.slice(0, 12)) console.log(`  ${e}`);
}
console.log(
  `\nSCRIPT-RENAME ${failed.length || realErrors.length ? "FAIL" : "PASS"} — ` +
    `${results.length - failed.length}/${results.length} checks, ${realErrors.length} console errors`,
);
await browser.close();
fs.rmSync(root, { recursive: true, force: true });
process.exit(failed.length || realErrors.length ? 1 : 0);
