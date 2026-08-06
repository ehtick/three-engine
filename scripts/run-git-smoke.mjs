// Source Control smoke: does the panel a user actually sees really drive git?
//
//   npx vite --port 5211 --strictPort
//   node scripts/run-git-smoke.mjs [url]
//
// HEADED=1 to watch it run.
//
// ## What this covers that run-git-test.mjs cannot
//
// `test:git` proves the parsers and the command vectors are right, by calling
// them directly. That is exactly the shape of test that once let a real bug
// through elsewhere in this editor: a panel whose switch only set React state,
// so the feature never ran while every automated check passed (see
// run-mcp-ui-smoke.mjs). So this harness touches nothing but the DOM — it
// clicks Create repository, clicks the stage button on a row, types into the
// commit box and presses Commit — and then verifies the result by running REAL
// git in the scratch folder from Node. The editor's claims are never taken as
// evidence of the editor's behaviour.
//
// Git itself is real here: `git_exec` is shimmed onto child_process, which is
// the same thing `src-tauri/src/git.rs` does with the same arguments. No
// network: no remote is configured, so nothing here can push anywhere.
//
// START THE DEV SERVER FRESH — see the `?t=` note in run-editor-ui-smoke.mjs.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5211/";

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const gitVersion = spawnSync("git", ["--version"], { encoding: "utf8" });
if (gitVersion.status !== 0) {
  console.log("GIT-SMOKE SKIPPED — git is not installed on this machine.");
  process.exit(0);
}

// --- the scratch project ------------------------------------------------------

const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-git-smoke-"));
fs.writeFileSync(path.join(root, "project.json"), JSON.stringify({ name: "GitSmoke", version: 1 }, null, 2));
fs.mkdirSync(path.join(root, "scenes"));
fs.writeFileSync(path.join(root, "scenes", "main.scene"), '{\n  "entities": []\n}\n');
fs.writeFileSync(path.join(root, "Red.mat"), '{ "color": "#ff0000" }\n');
// Build output, to prove the generated .gitignore keeps it out of the repository.
fs.mkdirSync(path.join(root, "Build"));
fs.writeFileSync(path.join(root, "Build", "index.html"), "<!doctype html>\n");

const GIT_PREFIX = ["--no-pager", "-c", "color.ui=false", "-c", "core.quotepath=false"];
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", LANG: "C" };
/** Runs git the way `src-tauri/src/git.rs` does. Used both as the shim and, at
 *  the end of each step, as the independent check on what the panel did. */
function runGit(dir, args) {
  const out = spawnSync("git", [...GIT_PREFIX, ...args], { cwd: dir, encoding: "utf8", env: GIT_ENV });
  if (out.error) throw out.error;
  return { ok: out.status === 0, code: out.status ?? -1, stdout: out.stdout ?? "", stderr: out.stderr ?? "" };
}
const gitOut = (...args) => runGit(root, args).stdout.trim();

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1700, height: 1000, deviceScaleFactor: 1 });
await installTauriShim(page, {
  writableRoot: root,
  verbose: !!process.env.VERBOSE,
  extraCommands: {
    git_probe: () => ({
      git: { found: true, version: gitVersion.stdout.trim(), path: "git" },
      // LFS off in the harness on purpose: it is the path most machines take
      // when it is not installed, and it must not block creating a repository.
      lfs: { found: false, version: "", path: "" },
      gh: { found: false, version: "", path: "" },
    }),
    git_exec: ({ dir, args }) => runGit(dir, args),
    gh_exec: () => {
      throw new Error("gh is not installed");
    },
  },
});

const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.stack ?? e.message}`));

await page.goto(url, { waitUntil: "load", timeout: 45000 });
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
});
await wait(6000);

await page.evaluate(async (projectRoot) => {
  const importLive = (p) => {
    const prefix = location.origin + p;
    const fetched = performance
      .getEntriesByType("resource")
      .map((e) => e.name)
      .filter((n) => n === prefix || n.startsWith(`${prefix}?`));
    return import(/* @vite-ignore */ (fetched.find((n) => n.includes("?")) ?? fetched[0]) ?? p);
  };
  globalThis.__importLive = importLive;
  const { ensureEngine } = await importLive("/src/editor/engineInstance.js");
  await ensureEngine();
  const { useProjectStore } = await importLive("/src/editor/store/projectStore.js");
  globalThis.__openDone = false;
  useProjectStore
    .getState()
    .openProject(projectRoot)
    .then(() => (globalThis.__openDone = true));
}, root.replaceAll("\\", "/"));

for (let i = 0; i < 60 && !(await page.evaluate(() => globalThis.__openDone === true)); i++) await wait(500);
check("the scratch project opens", await page.evaluate(() => globalThis.__openDone === true));

const openGitPanel = () =>
  page.evaluate(async () => {
    const { openPanel } = await globalThis.__importLive("/src/editor/EditorShell.jsx");
    openPanel("git");
  });
const text = (selector) => page.evaluate((s) => document.querySelector(s)?.textContent ?? "", selector);
const exists = (selector) => page.evaluate((s) => !!document.querySelector(s), selector);
/** Clicks the first element matching a selector whose text contains `label`. */
const clickText = (selector, label) =>
  page.evaluate(
    (s, l) => {
      const target = [...document.querySelectorAll(s)].find((el) => (el.textContent ?? "").includes(l));
      target?.click();
      return !!target;
    },
    selector,
    label,
  );

// --- 1. a project with no repository -----------------------------------------

await openGitPanel();
await wait(2500);
check("the Source Control panel opens", await exists(".git-panel"));
check(
  "…and offers to create a repository rather than showing an empty file list",
  (await text(".git-hero")).includes("Create repository"),
);
check(
  "…saying what it will ignore, in this project's own terms",
  (await text(".git-hero-list")).includes("Build/") && (await text(".git-hero-list")).includes("engine-types/"),
);

// --- 2. creating it -----------------------------------------------------------

check("Create repository is clickable", await clickText(".git-hero-actions .toolbar-btn", "Create repository"));
for (let i = 0; i < 40 && !(await exists(".git-toolbar")); i++) await wait(500);

check("a real repository now exists on disk", fs.existsSync(path.join(root, ".git")));
check("…on the branch the editor said it would use", gitOut("rev-parse", "--abbrev-ref", "HEAD") === "main");
check("…with an initial commit", /Initial commit/.test(gitOut("log", "--format=%s")));
check("…that names the project, so a repository page says what it holds", /GitSmoke/.test(gitOut("log", "--format=%s")));

const ignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
check(".gitignore was written", ignore.includes("/Build/") && ignore.includes("/engine-types/"));
check(".gitattributes was written", fs.existsSync(path.join(root, ".gitattributes")));
// The point of the ignore list, verified against git rather than against the
// file's contents: a build folder in the first commit is the failure this
// prevents.
const tracked = gitOut("ls-files").split("\n");
check("the build output did NOT get committed", !tracked.some((file) => file.startsWith("Build/")), tracked.join(", "));
check("…but the scene and material did", tracked.includes("scenes/main.scene") && tracked.includes("Red.mat"));
check(
  "…and so did .gitignore itself, so a clone behaves the same",
  tracked.includes(".gitignore") && tracked.includes(".gitattributes"),
);

check("the panel switched to the repository view", await exists(".git-toolbar"));
check("…showing the branch", (await text(".git-branch-btn")).includes("main"));
check("…and an empty state rather than a phantom change list", (await text(".git-changes")).includes("Nothing has changed"));

// --- 3. a change made outside the editor shows up -----------------------------

fs.writeFileSync(path.join(root, "scenes", "main.scene"), '{\n  "entities": [\n    { "name": "Cube" }\n  ]\n}\n');
fs.writeFileSync(path.join(root, "Blue.mat"), '{ "color": "#0000ff" }\n');
await page.evaluate(async () => {
  const { refreshGit } = await globalThis.__importLive("/src/editor/git/gitStore.js");
  await refreshGit();
});
await wait(800);

const rows = await page.evaluate(() =>
  [...document.querySelectorAll(".git-file")].map((row) => ({
    name: row.querySelector(".git-file-name")?.textContent ?? "",
    letter: row.querySelector(".git-letter")?.textContent ?? "",
  })),
);
check("both changes appear in the list", rows.length === 2, JSON.stringify(rows));
check(
  "…a modified file and a new one are distinguishable at a glance",
  rows.some((row) => row.name === "main.scene" && row.letter === "M") &&
    rows.some((row) => row.name === "Blue.mat" && row.letter === "?"),
  JSON.stringify(rows),
);

// --- 4. the diff ---------------------------------------------------------------

await page.evaluate(() => {
  [...document.querySelectorAll(".git-file")].find((row) => row.textContent?.includes("main.scene"))?.click();
});
await wait(1200);
const diffText = await text(".git-diff");
check("selecting a file shows its diff", await exists(".git-diff .git-line"), diffText.slice(0, 60));
check("…with the added line in it", diffText.includes("Cube"));
check(
  "…and line numbers on both sides",
  await page.evaluate(() => {
    const line = document.querySelector(".git-line.context");
    return [...(line?.querySelectorAll(".git-gutter") ?? [])].filter((g) => g.textContent?.trim()).length === 2;
  }),
);

// --- 5. staging ----------------------------------------------------------------

await page.evaluate(() => {
  const row = [...document.querySelectorAll(".git-file")].find((r) => r.textContent?.includes("main.scene"));
  // The first action on an unstaged row is Stage.
  row?.querySelector(".git-file-actions button")?.click();
});
await wait(1500);
check("clicking Stage really stages the file in git", gitOut("diff", "--cached", "--name-only") === "scenes/main.scene");
check(
  "…and the panel moves it into a Staged section",
  await page.evaluate(() =>
    [...document.querySelectorAll(".git-section")].some(
      (section) =>
        section.querySelector(".git-section-head")?.textContent?.includes("Staged") &&
        section.textContent?.includes("main.scene"),
    ),
  ),
);

// --- 6. committing --------------------------------------------------------------

await page.evaluate(() => {
  const box = document.querySelector(".git-commit-message");
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  // React tracks the previous value on the node; assigning `.value` directly
  // makes it ignore the input event as a no-op.
  setter.call(box, "Add a cube to the scene");
  box.dispatchEvent(new Event("input", { bubbles: true }));
});
await wait(300);
check("Commit is offered once something is staged and described", await clickText(".git-commit-row .toolbar-btn", "Commit"));
for (let i = 0; i < 30 && gitOut("log", "--format=%s", "-1") !== "Add a cube to the scene"; i++) await wait(400);
check("…and it really commits, with the typed message", gitOut("log", "--format=%s", "-1") === "Add a cube to the scene");
check("…leaving only the still-uncommitted file behind", gitOut("status", "--porcelain") === "?? Blue.mat");
check(
  "…and the message box is cleared, so the next commit cannot reuse it by accident",
  (await page.evaluate(() => document.querySelector(".git-commit-message")?.value)) === "",
);

// --- 7. history ------------------------------------------------------------------

check("the History tab is there", await clickText(".git-tab", "History"));
await wait(1500);
const history = await page.evaluate(() => [...document.querySelectorAll(".git-subject")].map((el) => el.textContent));
check("history lists both commits, newest first", history[0] === "Add a cube to the scene" && history.length === 2, JSON.stringify(history));
await page.evaluate(() => document.querySelector(".git-commit-row-btn")?.click());
await wait(1200);
check("…and opening one shows what it changed", (await text(".git-history")).includes("Cube"));

// --- 8. branches -----------------------------------------------------------------

await page.evaluate(() => document.querySelector(".git-branch-btn")?.click());
await wait(600);
check("the branch menu opens", await exists(".git-menu-form"));
await page.evaluate(() => {
  const input = document.querySelector(".git-menu-form input");
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(input, "feature/lighting");
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
await wait(200);
await page.evaluate(() => document.querySelector(".git-menu-form button")?.click());
for (let i = 0; i < 30 && gitOut("rev-parse", "--abbrev-ref", "HEAD") !== "feature/lighting"; i++) await wait(400);
check("creating a branch from the menu checks it out", gitOut("rev-parse", "--abbrev-ref", "HEAD") === "feature/lighting");
await wait(1200);
check("…and the toolbar says which branch you are on", (await text(".git-branch-btn")).includes("feature/lighting"));

// --- 9. the menu-bar chip ---------------------------------------------------------

const chip = await page.evaluate(() => {
  const el = document.querySelector(".git-chip");
  return el ? { text: el.textContent ?? "", title: el.getAttribute("title") ?? "", tone: el.className } : null;
});
check("the menu bar carries a branch chip", !!chip, JSON.stringify(chip));
check("…naming the current branch", (chip?.text ?? "").includes("feature/lighting"), chip?.text);
check("…and counting the uncommitted files", (chip?.text ?? "").includes("1"), chip?.text);
check("…with a tooltip that says the same thing in words", /On feature\/lighting/.test(chip?.title ?? ""), chip?.title);

// --- 10. discard is the only destructive button, and it confirms -------------------

await page.evaluate(async () => {
  const { openPanel } = await globalThis.__importLive("/src/editor/EditorShell.jsx");
  openPanel("git");
});
await wait(800);
const discardArmed = await page.evaluate(() => {
  const row = [...document.querySelectorAll(".git-file")].find((r) => r.textContent?.includes("Blue.mat"));
  const buttons = [...(row?.querySelectorAll(".git-file-actions button") ?? [])];
  buttons.at(-1)?.click(); // the discard/delete action
  return true;
});
await wait(400);
check("the destructive action arms instead of firing", discardArmed && fs.existsSync(path.join(root, "Blue.mat")));
check(
  "…and asks for a second click, in words",
  await page.evaluate(() =>
    [...document.querySelectorAll(".git-file-actions button")].some((b) => /Delete\?|Discard\?/.test(b.textContent ?? "")),
  ),
);
await page.evaluate(() => {
  [...document.querySelectorAll(".git-file-actions button")]
    .find((b) => /Delete\?|Discard\?/.test(b.textContent ?? ""))
    ?.click();
});
for (let i = 0; i < 20 && fs.existsSync(path.join(root, "Blue.mat")); i++) await wait(300);
check("…then really deletes the untracked file", !fs.existsSync(path.join(root, "Blue.mat")));

// ---------------------------------------------------------------------------

const realErrors = errors.filter((message) => !/favicon|WebGPU|Failed to load resource/i.test(message));
check("no unexpected console errors", realErrors.length === 0, realErrors.slice(0, 3).join(" | "));

await browser.close();
try {
  fs.rmSync(root, { recursive: true, force: true });
} catch {
  // Windows keeps a handle on .git objects for a moment after the last git
  // process exits; a leftover temp folder is not worth failing the run over.
}

const failed = results.filter((result) => !result.ok);
console.log(
  `\nGIT-SMOKE ${failed.length === 0 ? "PASS" : "FAIL"} — ${results.length - failed.length}/${results.length} checks`,
);
process.exit(failed.length === 0 ? 0 : 1);
