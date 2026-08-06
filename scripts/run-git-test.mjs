// Version control: parsers, defaults, and a real repository.
//
//   node scripts/run-git-test.mjs
//
// No browser, no dev server, no editor. Two halves:
//
// 1. **Recorded output.** The awkward shapes — a rename with the old path in a
//    separate NUL field, a conflicted file, a detached HEAD, "Binary files
//    differ" — asserted against text captured from real git. These are the
//    cases that are tedious to reproduce live and easy to get wrong once.
//
// 2. **A real repository.** A scratch repo is built in the OS temp directory
//    and driven through `src/editor/git/gitCli.js` itself, with the Tauri
//    command shimmed onto `child_process`. That half is what stops the
//    recorded fixtures from quietly becoming fiction: if a future git changes
//    a format, the fixture still passes and this fails.
//
// What it deliberately does NOT cover: the panel, and the service layer's
// editor side effects (reloading the scene after a checkout). Those need the
// editor and live in `npm run smoke:git`.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};
const eq = (name, actual, expected) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}`);

// ---------------------------------------------------------------------------
// 1. Recorded output
// ---------------------------------------------------------------------------

const {
  parseStatus,
  parseBranches,
  parseLog,
  parseRemotes,
  parseDiff,
  parseGhAuth,
  webUrlForRemote,
  githubSlug,
  explainFailure,
} = await import(pathToFileURL(path.join(ROOT, "src/editor/git/porcelain.js")).href);

// Captured from git 2.51 with:
//   git status --porcelain=v2 --branch --untracked-files=all -z
// A staged+unstaged file, a worktree-only delete, a staged rename, and two
// untracked files (one in a folder, with a space in the name).
const STATUS_Z = [
  "# branch.oid f4ad4c54d74ea5c4b76310ce385e2172fe2fcc98",
  "# branch.head main",
  "# branch.upstream origin/main",
  "# branch.ab +2 -1",
  "1 MM N... 100644 100644 100644 4cb29ea ddc897f a.txt",
  "1 .D N... 100644 100644 000000 abaddc0 abaddc0 gone.txt",
  "2 R. N... 100644 100644 100644 587be6b 587be6b R100 new.txt",
  "old.txt",
  "? sub/deep file.txt",
  "? untracked.txt",
  "",
].join("\0");

const status = parseStatus(STATUS_Z);
eq("the branch, its upstream and the ahead/behind counts are read", [status.branch.head, status.branch.upstream, status.branch.ahead, status.branch.behind], ["main", "origin/main", 2, 1]);
check("a rename does not leave its old path parsed as a sixth file", status.files.length === 5, `${status.files.length} files`);
const renamed = status.files.find((file) => file.kind === "renamed");
eq("…the rename carries both paths", [renamed?.path, renamed?.orig], ["new.txt", "old.txt"]);
const both = status.files.find((file) => file.path === "a.txt");
check("a file changed in BOTH the index and the worktree is reported as both", both.staged && both.unstaged);
const deleted = status.files.find((file) => file.path === "gone.txt");
check("a worktree-only delete is unstaged, not staged", deleted.kind === "deleted" && !deleted.staged && deleted.unstaged);
check("a path containing a space survives", status.files.some((file) => file.path === "sub/deep file.txt"));
check("untracked files are flagged as such", status.files.filter((file) => file.untracked).length === 2);

const conflicted = parseStatus(
  [
    "# branch.oid ab86916",
    "# branch.head main",
    "u UU N... 100644 100644 100644 100644 df967b9 351be5b 950b81b f.txt",
    "",
  ].join("\0"),
);
check("an unmerged file is conflicted and not silently 'staged'", conflicted.files[0].conflicted === true && conflicted.files[0].staged === false);

const detached = parseStatus(["# branch.oid abc123", "# branch.head (detached)", ""].join("\0"));
check("a detached HEAD is recognised rather than named '(detached)'", detached.branch.detached === true && detached.branch.head === "");

const initial = parseStatus(["# branch.oid (initial)", "# branch.head main", "? first.txt", ""].join("\0"));
check("a repository with no commits parses", initial.branch.oid === "" && initial.files.length === 1);

const branches = parseBranches(
  [
    "refs/heads/main\tmain\torigin/main\tab86916\t*\t0 seconds ago",
    "refs/remotes/origin/main\torigin/main\t\t489ea59\t \t1 second ago",
    "refs/remotes/origin/HEAD\torigin/HEAD\t\t489ea59\t \t1 second ago",
  ].join("\n"),
);
check("branches: the local one is current", branches[0].current === true && branches[0].remote === false);
check("…a remote-tracking ref is marked remote", branches[1].remote === true);
check("…and origin/HEAD, which is a pointer and not a branch, is dropped", branches.length === 2);

const log = parseLog(
  "ab86916ab8Test2026-08-05T23:29:30+03:00mine76f8ba2HEAD -> main" +
    "489ea59489Test2026-08-05T23:29:29+03:00theirs76f8ba2origin/main",
);
eq("log records split on the record separator", [log.length, log[0].subject, log[1].subject], [2, "mine", "theirs"]);
eq("…and 'HEAD -> main' is reported as the branch name", log[0].refs, ["main"]);

eq(
  "remotes are one entry per remote, not one per direction",
  parseRemotes("origin\thttps://github.com/o/r.git (fetch)\norigin\thttps://github.com/o/r.git (push)\n"),
  [{ name: "origin", url: "https://github.com/o/r.git" }],
);

eq("an ssh remote linkifies to https", webUrlForRemote("git@github.com:khudiiash/game.git"), "https://github.com/khudiiash/game");
eq("…as does the ssh:// spelling", webUrlForRemote("ssh://git@github.com/khudiiash/game.git"), "https://github.com/khudiiash/game");
eq("…and the slug is extracted", githubSlug("git@github.com:khudiiash/game.git"), "khudiiash/game");
eq("a non-GitHub remote has no slug", githubSlug("https://gitlab.com/a/b.git"), null);

const patch = parseDiff(
  [
    "diff --git a/a.txt b/a.txt",
    "index 4cb29ea..ddc897f 100644",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1,3 +1,4 @@ context header",
    " one",
    "-two",
    "+TWO",
    " three",
    "+four",
    "\\ No newline at end of file",
    "diff --git a/logo.png b/logo.png",
    "index 1111111..2222222 100644",
    "Binary files a/logo.png and b/logo.png differ",
  ].join("\n"),
);
eq("a diff splits into files", patch.map((file) => file.path), ["a.txt", "logo.png"]);
eq("…with add/delete counts", [patch[0].additions, patch[0].deletions], [2, 1]);
check("…a binary file is flagged instead of rendered", patch[1].binary === true && patch[1].hunks.length === 0);
const lines = patch[0].hunks[0].lines;
eq("…context lines carry BOTH line numbers", [lines[0].oldNo, lines[0].newNo], [1, 1]);
eq("…an added line has only a new-side number", [lines[2].kind, lines[2].oldNo, lines[2].newNo], ["add", null, 2]);
eq("…a deleted line has only an old-side number", [lines[1].kind, lines[1].oldNo, lines[1].newNo], ["del", 2, null]);
// "\ No newline at end of file" is not a line of the file; counting it would
// shift every number after it by one.
check("…the no-newline marker does not advance the counters", lines.at(-1).kind === "meta" && lines.at(-2).newNo === 4);

const auth = parseGhAuth("github.com\n  ✓ Logged in to github.com account khudiiash (keyring)\n  - Git operations protocol: https\n  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'\n", 0);
eq("gh auth status yields the account and scopes", [auth.loggedIn, auth.account, auth.scopes.includes("repo")], [true, "khudiiash", true]);
check("…and a logged-out gh is not reported as signed in", parseGhAuth("You are not logged into any GitHub hosts.", 1).loggedIn === false);

check(
  "a missing identity is explained in terms of the fix, not git's wording",
  /name and email/i.test(explainFailure({ code: 128, stdout: "", stderr: "*** Please tell me who you are." })),
);
check(
  "an unknown failure is passed through rather than replaced with a guess",
  explainFailure({ code: 1, stdout: "", stderr: "fatal: some new error" }) === "fatal: some new error",
);

// --- defaults ---------------------------------------------------------------

const { defaultGitignore, defaultGitattributes, mergeLines, LFS_PATTERNS } = await import(
  pathToFileURL(path.join(ROOT, "src/editor/git/defaults.js")).href,
);

const ignore = defaultGitignore({ outDir: "Dist" });
check("the ignore list uses the project's configured build folder", ignore.includes("/Dist/") && !ignore.includes("/Build/"));
check("…ignores the vendored type definitions", ignore.includes("/engine-types/"));
// .meta sidecars hold authored import settings. Committing them is the whole
// reason a teammate's clone looks the same as yours.
// The rules, not the prose: the file's own header explains why .meta files are
// kept, so a naive search for ".meta" matches the explanation and passes.
const ignoreRules = ignore.split("\n").filter((line) => line.trim() && !line.trim().startsWith("#"));
check("…and does NOT ignore .meta sidecars", !ignoreRules.some((rule) => rule.includes(".meta")), ignoreRules.join(" "));

const attributes = defaultGitattributes({ lfs: true });
check("LFS filters cover models, textures and audio", ["*.glb", "*.png", "*.wav"].every((p) => attributes.includes(`${p} filter=lfs`)));
check("…text formats are NOT in LFS, so they still diff", !attributes.includes("*.scene filter=lfs") && !LFS_PATTERNS.includes("*.gltf"));
check("…and without git-lfs the same file is written without filters", !defaultGitattributes({ lfs: false }).includes("filter=lfs"));

const merged = mergeLines("node_modules/\n/Build/\n", ignore);
check("merging into an existing ignore file keeps what was there", merged.startsWith("node_modules/\n/Build/\n"));
check("…adds only the missing rules", merged.includes("/engine-types/") && merged.split("node_modules/").length === 2);
check("…and returns null when there is nothing to add", mergeLines(ignore, ignore) === null);

// ---------------------------------------------------------------------------
// 2. A real repository, through the editor's own module
// ---------------------------------------------------------------------------
//
// `gitCli.js` reaches Rust through `invoke("git_exec")`. Here that command is
// implemented with child_process instead, mirroring what `src-tauri/src/git.rs`
// does: the same prefix arguments and the same environment. The parsers,
// argument vectors and result handling under test are the real ones.

const GIT_PREFIX = ["--no-pager", "-c", "color.ui=false", "-c", "core.quotepath=false"];
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", LANG: "C" };

function runGit(dir, args) {
  const out = spawnSync("git", [...GIT_PREFIX, ...args], { cwd: dir, encoding: "utf8", env: GIT_ENV });
  if (out.error) throw out.error;
  return { ok: out.status === 0, code: out.status ?? -1, stdout: out.stdout ?? "", stderr: out.stderr ?? "" };
}

const probe = spawnSync("git", ["--version"], { encoding: "utf8" });
if (probe.status !== 0) {
  console.log("\nGIT-TEST SKIPPED the live half — git is not installed on this machine.");
} else {
  globalThis.window = globalThis.window ?? /** @type {any} */ ({});
  globalThis.window.__TAURI_INTERNALS__ = {
    invoke: async (command, args) => {
      if (command === "git_exec") return runGit(args.dir, args.args);
      if (command === "git_probe") {
        return {
          git: { found: true, version: probe.stdout.trim(), path: "git" },
          lfs: { found: false, version: "", path: "" },
          gh: { found: false, version: "", path: "" },
        };
      }
      throw new Error(`unexpected command ${command}`);
    },
  };

  const cli = await import(pathToFileURL(path.join(ROOT, "src/editor/git/gitCli.js")).href);

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "engine-git-test-"));
  const repo = path.join(scratch, "project");
  fs.mkdirSync(repo);
  runGit(repo, ["init", "-b", "main"]);
  runGit(repo, ["config", "user.name", "Test Runner"]);
  runGit(repo, ["config", "user.email", "test@example.com"]);
  // A scene, a material in a folder, and a "binary" asset — the shape of a real
  // project, so path handling and binary detection are exercised.
  fs.writeFileSync(path.join(repo, "main.scene"), '{\n  "entities": []\n}\n');
  fs.mkdirSync(path.join(repo, "materials"));
  fs.writeFileSync(path.join(repo, "materials", "Red.mat"), '{ "color": "#ff0000" }\n');
  fs.writeFileSync(path.join(repo, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));

  const outside = await cli.findRepoRoot(scratch);
  check("a folder that is not a repository reports none", outside === null, String(outside));

  runGit(repo, ["add", "-A"]);
  runGit(repo, ["commit", "-m", "first"]);

  const root = await cli.findRepoRoot(repo);
  check("the repository root is found", !!root && fs.existsSync(path.join(root, ".git")), String(root));

  const clean = await cli.readStatus(root);
  check("a freshly committed tree has no changes", clean.files.length === 0, JSON.stringify(clean.files));
  eq("…and is on the branch it was created with", clean.branch.head, "main");
  check("…with no operation in progress", clean.operation === null);

  fs.writeFileSync(path.join(repo, "main.scene"), '{\n  "entities": [1]\n}\n');
  fs.writeFileSync(path.join(repo, "new.ts"), "export default class {}\n");
  fs.writeFileSync(path.join(repo, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9, 9]));
  fs.rmSync(path.join(repo, "materials", "Red.mat"));

  const dirty = await cli.readStatus(root);
  const byPath = Object.fromEntries(dirty.files.map((file) => [file.path, file]));
  eq(
    "every kind of change is seen, with repo-relative forward-slash paths",
    Object.keys(byPath).sort(),
    ["logo.png", "main.scene", "materials/Red.mat", "new.ts"],
  );
  eq("…a deleted file reads as deleted", byPath["materials/Red.mat"].kind, "deleted");
  eq("…a new file reads as untracked", byPath["new.ts"].kind, "untracked");

  runGit(repo, ["add", "main.scene"]);
  const partly = await cli.readStatus(root);
  check(
    "staging one file separates the two lists",
    partly.files.find((file) => file.path === "main.scene").staged === true &&
      partly.files.find((file) => file.path === "new.ts").staged === false,
  );

  const stagedDiff = await cli.readDiff(root, { path: "main.scene", staged: true });
  check("the staged diff shows the staged change", stagedDiff[0]?.hunks?.[0]?.lines?.some((line) => line.kind === "add" && line.text.includes("1")));

  const binaryDiff = await cli.readDiff(root, { path: "logo.png" });
  check("a changed binary asset is reported as binary, with no hunks", binaryDiff[0]?.binary === true, JSON.stringify(binaryDiff[0] ?? null));

  // The untracked case takes a different code path (`--no-index` against the
  // null device) because git has nothing to compare an untracked file to.
  const untrackedDiff = await cli.readDiff(root, { path: "new.ts", untracked: true });
  check("an untracked file still shows its contents as added", untrackedDiff[0]?.hunks?.[0]?.lines?.some((line) => line.kind === "add"), JSON.stringify(untrackedDiff[0] ?? null));

  const identity = await cli.readIdentity(root);
  eq("the commit identity is read back", [identity.name, identity.email], ["Test Runner", "test@example.com"]);

  const history = await cli.readLog(root, { limit: 10 });
  eq("history reports the commit that was made", [history.length, history[0].subject], [1, "first"]);

  runGit(repo, ["checkout", "-b", "feature"]);
  const branchList = await cli.readBranches(root);
  eq(
    "both branches are listed with the checked-out one marked",
    branchList.map((branch) => `${branch.name}${branch.current ? "*" : ""}`).sort(),
    ["feature*", "main"],
  );

  check("a repository with no remotes reports an empty list", (await cli.readRemotes(root)).length === 0);

  // An empty repository is the state every new project starts in, and `git log`
  // calls it a fatal error rather than an empty history.
  const empty = path.join(scratch, "empty");
  fs.mkdirSync(empty);
  runGit(empty, ["init", "-b", "main"]);
  const emptyRoot = await cli.findRepoRoot(empty);
  eq("a repository with no commits yields an empty history, not an error", await cli.readLog(emptyRoot), []);
  const emptyStatus = await cli.readStatus(emptyRoot);
  eq("…and still reports its branch", emptyStatus.branch.head, "main");

  fs.rmSync(scratch, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 3. The tool surface
// ---------------------------------------------------------------------------
//
// Same rule as `run-mcp-coverage-test.mjs`: a feature is not done when the
// panel works, it is done when an agent can do the same things. Read from
// source so this cannot pass by importing a stale build.

const opSource = fs.readFileSync(path.join(ROOT, "src/editor/api/ops/git.js"), "utf8");
const opNames = [...opSource.matchAll(/name:\s*"([\w.]+)"/g)].map((match) => match[1]);
const REQUIRED_OPS = [
  "git.status",
  "git.init",
  "git.stage",
  "git.unstage",
  "git.discard",
  "git.commit",
  "git.diff",
  "git.log",
  "git.show",
  "git.branches",
  "git.checkout",
  "git.deleteBranch",
  "git.merge",
  "git.abortMerge",
  "git.stash",
  "git.stashPop",
  "git.stashList",
  "git.remotes",
  "git.addRemote",
  "git.fetch",
  "git.pull",
  "git.push",
  "git.setIdentity",
  "git.lfs",
  "git.github.status",
  "git.github.login",
  "git.github.createRepo",
];
for (const name of REQUIRED_OPS) {
  check(`${name} exists`, opNames.includes(name));
}
const thin = [...opSource.split("defineOp({").slice(1)].filter((block) => {
  const description = /description:\s*(?:\n\s*)?"([^"]*)/.exec(block)?.[1] ?? "";
  return description.length < 40;
});
check("every git op describes itself to the model calling it", thin.length === 0, `${thin.length} too short`);

const facade = fs.readFileSync(path.join(ROOT, "src/editor/api/index.js"), "utf8");
check("the op module is registered at boot", facade.includes('./ops/git.js'));
check("…and the script-facing facade exposes git", /git:\s*\{/.test(facade) && facade.includes('callOp("git.commit"'));

// The panel and the tools must call the SAME functions. A panel that talked to
// git directly would drift from the ops within a week.
const panel = fs.readFileSync(path.join(ROOT, "src/editor/panels/GitPanel.jsx"), "utf8");
check("the panel goes through the shared service, not its own git calls", panel.includes('from "../git/gitService.js"') && !panel.includes('invoke("git_exec"'));

const rust = fs.readFileSync(path.join(ROOT, "src-tauri/src/git.rs"), "utf8");
check("the Rust layer refuses `git credential`, which prints stored secrets", !/"credential"/.test(rust.split("GIT_SUBCOMMANDS")[1]?.split("]")[0] ?? ""));
check("…and blocks terminal prompts, so a missing credential cannot hang the editor", rust.includes('GIT_TERMINAL_PROMPT'));

// ---------------------------------------------------------------------------
const failed = results.filter((result) => !result.ok);
console.log(
  `\nGIT-TEST ${failed.length === 0 ? "PASS" : "FAIL"} — ${results.length - failed.length}/${results.length} checks`,
);
process.exit(failed.length === 0 ? 0 : 1);
