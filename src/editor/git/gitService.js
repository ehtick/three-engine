// @ts-check
/**
 * The write side of git: the actions a button or a tool performs, and the
 * editor-side consequences of them.
 *
 * ## Why this is not just "run the command"
 *
 * A checkout, a pull, a stash pop and a discard all do the same thing from the
 * editor's point of view: they rewrite files on disk that the editor is
 * currently showing. Textures are cached as blob URLs, materials as compiled
 * node graphs, geometry as decoded buffers — none of which can notice that the
 * bytes underneath them changed. Before this existed the symptom was the one
 * described in `projectWatcher.js`: the operation worked, and the editor kept
 * rendering the old world until it was restarted.
 *
 * So every tree-changing action here is wrapped in {@link withTreeChange},
 * which records HEAD before and after and asks git which paths differ. That is
 * deliberately not left to the filesystem watcher: the watcher is a best-effort
 * signal that only exists inside Tauri and coalesces bursts, whereas
 * `git diff --name-only <before> <after>` is an exact, ordered answer that also
 * works in the harness. The watcher still fires and is still welcome — the two
 * paths converge on the same idempotent refresh.
 */
import {
  git,
  gh,
  findRepoRoot,
  readIdentity,
  readStatus,
  toAbsolute,
} from "./gitCli.js";
import { defaultGitattributes, defaultGitignore, mergeLines, initialCommitMessage } from "./defaults.js";
import { useProjectStore } from "../store/projectStore.js";
import { noteExternalChanges } from "../projectWatcher.js";

/** The open project's repository root, or a clear reason there isn't one. */
export async function requireRepo() {
  const rootPath = useProjectStore.getState().rootPath;
  if (!rootPath) throw new Error("No project is open.");
  const repo = await findRepoRoot(rootPath);
  if (!repo) {
    throw new Error(
      "This project is not in a git repository yet. Create one from the Git panel, or with the git.init tool.",
    );
  }
  return repo;
}

/** HEAD's sha, or null in a repository with no commits yet. */
async function headSha(root) {
  const result = await git(root, ["rev-parse", "HEAD"], { allowFailure: true });
  return result.ok ? result.stdout.trim() : null;
}

/**
 * Runs an action that may rewrite the working tree, then makes the editor show
 * what is now on disk.
 *
 * The path list is computed from the two HEADs where possible. When one of them
 * is null (a repository before its first commit) or the action does not move
 * HEAD at all (a discard), the caller passes the paths it already knows about —
 * `touched` — and they are used instead.
 *
 * @template T
 * @param {string} root
 * @param {() => Promise<T>} action
 * @param {{ touched?: string[] }} [options] Repo-relative paths the action is
 *   known to affect, for the cases where HEAD does not move.
 */
export async function withTreeChange(root, action, { touched = [] } = {}) {
  const before = await headSha(root);
  const result = await action();
  const after = await headSha(root);

  /** @type {string[]} */
  let changed = [...touched];
  if (before && after && before !== after) {
    const diff = await git(root, ["diff", "--name-only", before, after], { allowFailure: true });
    changed = [...changed, ...diff.stdout.split("\n").map((line) => line.trim()).filter(Boolean)];
  }
  if (changed.length) {
    noteExternalChanges([...new Set(changed)].map((relative) => toAbsolute(root, relative)));
  }
  // Always re-list, even when no path was named: a checkout that only adds or
  // removes files still changes what the Assets panel should show.
  await useProjectStore.getState().refresh().catch(() => {});
  return result;
}

// ---- creating a repository ---------------------------------------------------

/**
 * Turns the open project folder into a repository.
 *
 * The order matters and is the whole reason this is one function rather than
 * three ops: `.gitattributes` must exist and LFS must be installed BEFORE the
 * first `git add`, or the assets go into the repository as ordinary blobs and
 * only files added later use LFS. Fixing that afterwards means rewriting
 * history.
 *
 * @param {{ lfs?: boolean, commit?: boolean, branch?: string, outDir?: string,
 *           projectName?: string }} [options]
 */
export async function initRepository({
  lfs = true,
  commit = true,
  branch = "main",
  outDir = "Build",
  projectName = "",
} = {}) {
  const rootPath = useProjectStore.getState().rootPath;
  if (!rootPath) throw new Error("No project is open.");
  const existing = await findRepoRoot(rootPath);
  if (existing) throw new Error(`This folder is already in a repository (${existing}).`);

  // `-b main`: git's default branch name is still `master` on installations
  // that predate `init.defaultBranch`, while every host now defaults to `main`
  // — mismatching them makes the first push create a second branch.
  await git(rootPath, ["init", "-b", branch]);

  const { writeTextFile, readTextFileIfPresent } = await fileIo();
  const notes = [];

  const ignorePath = `${rootPath}/.gitignore`;
  const wantIgnore = defaultGitignore({ outDir });
  const haveIgnore = await readTextFileIfPresent(ignorePath);
  if (haveIgnore === null) await writeTextFile(ignorePath, wantIgnore);
  else {
    const merged = mergeLines(haveIgnore, wantIgnore, "# Added by the editor.");
    if (merged) await writeTextFile(ignorePath, merged);
  }

  let lfsEnabled = false;
  if (lfs) {
    // `--local` writes the filter config into this repository only. The global
    // form edits the user's ~/.gitconfig, which is not the editor's to change.
    const install = await git(rootPath, ["lfs", "install", "--local"], { allowFailure: true });
    lfsEnabled = install.ok;
    if (!lfsEnabled) {
      notes.push(
        "Git LFS is not installed, so large binary assets will be committed directly. " +
          "Install it from git-lfs.com and run Track Assets with LFS in the Git panel — " +
          "doing it before the assets are committed is much easier than after.",
      );
    }
  }

  const attributesPath = `${rootPath}/.gitattributes`;
  const wantAttributes = defaultGitattributes({ lfs: lfsEnabled });
  const haveAttributes = await readTextFileIfPresent(attributesPath);
  if (haveAttributes === null) await writeTextFile(attributesPath, wantAttributes);
  else {
    const merged = mergeLines(haveAttributes, wantAttributes, "# Added by the editor.");
    if (merged) await writeTextFile(attributesPath, merged);
  }

  const identity = await readIdentity(rootPath);
  let committed = null;
  if (commit) {
    if (!identity.name || !identity.email) {
      notes.push(
        "Nothing was committed yet: git has no name and email configured for you. " +
          "Fill those in at the top of the Git panel and press Commit.",
      );
    } else {
      await git(rootPath, ["add", "-A"]);
      const message = initialCommitMessage(projectName);
      await git(rootPath, ["commit", "-m", message], { timeoutMs: 300_000 });
      committed = message;
    }
  }

  await useProjectStore.getState().refresh().catch(() => {});
  return { root: rootPath, branch, lfs: lfsEnabled, committed, notes };
}

/**
 * File IO for the two dotfiles above.
 *
 * Lazy and behind a helper because this module is imported by the op registry
 * at boot, and `assetOps` pulls in the project store's Tauri surface.
 */
async function fileIo() {
  const { invoke } = await import("../assetOps.js");
  return {
    /** @param {string} path @param {string} contents */
    writeTextFile: (path, contents) => invoke("save_scene", { path, contents }),
    /** @param {string} path @returns {Promise<string | null>} */
    readTextFileIfPresent: async (path) => {
      try {
        return /** @type {string} */ (await invoke("read_text_file", { path }));
      } catch {
        return null;
      }
    },
  };
}

// ---- staging -----------------------------------------------------------------

/** @param {string[]} paths Repo-relative. Empty means everything. */
export async function stage(paths = []) {
  const root = await requireRepo();
  await git(root, paths.length ? ["add", "--", ...paths] : ["add", "-A"], { timeoutMs: 300_000 });
  return readStatus(root);
}

/** @param {string[]} paths Repo-relative. Empty means everything. */
export async function unstage(paths = []) {
  const root = await requireRepo();
  // `restore --staged` rather than `reset`: in a repository with no commits
  // there is no HEAD to reset against, and `git reset -- path` fails outright
  // — which is precisely the moment (the very first commit) when someone is
  // most likely to unstage something by mistake.
  await git(root, ["restore", "--staged", "--", ...(paths.length ? paths : [":/"])], { allowFailure: true });
  return readStatus(root);
}

/**
 * Throws away changes. The only destructive action in this module, and the one
 * the panel puts behind a confirmation.
 *
 * Untracked files are deleted outright — `restore` has nothing to restore them
 * to — so they are handled separately and named in the return value, because
 * "discarded" meaning "deleted forever" is a different promise from "reverted
 * to the committed version".
 *
 * @param {string[]} paths Repo-relative.
 */
export async function discard(paths) {
  const root = await requireRepo();
  if (!paths?.length) throw new Error("Nothing to discard — pass the paths to revert.");
  const status = await readStatus(root);
  const untracked = new Set(status.files.filter((file) => file.untracked).map((file) => file.path));
  const toDelete = paths.filter((path) => untracked.has(path));
  const toRestore = paths.filter((path) => !untracked.has(path));

  return withTreeChange(
    root,
    async () => {
      if (toRestore.length) {
        await git(root, ["restore", "--staged", "--worktree", "--", ...toRestore]);
      }
      if (toDelete.length) {
        await git(root, ["clean", "-f", "-d", "--", ...toDelete]);
      }
      return { reverted: toRestore, deleted: toDelete };
    },
    { touched: paths },
  );
}

// ---- committing --------------------------------------------------------------

/**
 * @param {{ message: string, amend?: boolean, all?: boolean }} options
 *   `all` stages every tracked modification first (git's `-a`), which is what
 *   "Commit all" means in every other client. Untracked files are still not
 *   included — that would commit build output the moment a `.gitignore` is
 *   imperfect.
 */
export async function commit({ message, amend = false, all = false }) {
  const root = await requireRepo();
  const text = String(message ?? "").trim();
  if (!text && !amend) throw new Error("A commit needs a message.");
  const identity = await readIdentity(root);
  if (!identity.name || !identity.email) {
    throw new Error(
      "Git doesn't know who you are yet. Set your name and email at the top of the Git panel (or with git.setIdentity) — they are stamped onto every commit.",
    );
  }
  const args = ["commit"];
  if (all) args.push("--all");
  if (amend) args.push("--amend");
  args.push("-m", text || "amend");
  // Hooks run here (a pre-commit formatter, an LFS filter over a big asset), so
  // the cap is minutes rather than the default minute.
  const result = await git(root, args, { timeoutMs: 600_000, allowFailure: true });
  if (!result.ok) {
    // "nothing to commit" is not an error worth a red banner, but it IS worth
    // saying — a commit that silently did nothing is how people lose an hour.
    if (/nothing to commit|no changes added/i.test(`${result.stdout}${result.stderr}`)) {
      throw new Error("Nothing is staged, so there is nothing to commit. Stage a file first.");
    }
    throw new Error(`${result.stderr || result.stdout}`.trim());
  }
  const sha = (await git(root, ["rev-parse", "HEAD"], { allowFailure: true })).stdout.trim();
  return { sha, message: text, amended: amend };
}

// ---- branches ----------------------------------------------------------------

/** @param {string} ref @param {{ create?: boolean, from?: string }} [options] */
export async function checkout(ref, { create = false, from } = {}) {
  const root = await requireRepo();
  const args = create ? ["checkout", "-b", ref, ...(from ? [from] : [])] : ["checkout", ref];
  return withTreeChange(root, async () => {
    await git(root, args, { timeoutMs: 300_000 });
    return { ref, created: create };
  });
}

/** @param {string} name @param {{ force?: boolean }} [options] */
export async function deleteBranch(name, { force = false } = {}) {
  const root = await requireRepo();
  await git(root, ["branch", force ? "-D" : "-d", name]);
  return { deleted: name };
}

/** @param {string} ref */
export async function merge(ref) {
  const root = await requireRepo();
  return withTreeChange(root, async () => {
    const result = await git(root, ["merge", "--no-edit", ref], { allowFailure: true, timeoutMs: 300_000 });
    const status = await readStatus(root);
    const conflicts = status.files.filter((file) => file.conflicted).map((file) => file.path);
    if (!result.ok && !conflicts.length) throw new Error(`${result.stderr || result.stdout}`.trim());
    return {
      ref,
      merged: result.ok,
      // Conflicts are a normal outcome, not a failure: the merge is in
      // progress and the editor's job is to say which files need a decision.
      conflicts,
      output: `${result.stdout}${result.stderr}`.trim(),
    };
  });
}

/** Abandons an unfinished merge/cherry-pick/revert and restores the tree. */
export async function abortMerge() {
  const root = await requireRepo();
  return withTreeChange(root, async () => {
    await git(root, ["merge", "--abort"]);
    return { aborted: true };
  });
}

// ---- stash -------------------------------------------------------------------

/** @param {{ message?: string, includeUntracked?: boolean }} [options] */
export async function stashPush({ message = "", includeUntracked = true } = {}) {
  const root = await requireRepo();
  const args = ["stash", "push"];
  if (includeUntracked) args.push("--include-untracked");
  if (message) args.push("-m", message);
  return withTreeChange(root, async () => {
    const result = await git(root, args, { timeoutMs: 300_000 });
    return { stashed: !/No local changes/i.test(result.stdout), output: result.stdout.trim() };
  });
}

/** @param {number} index */
export async function stashPop(index = 0) {
  const root = await requireRepo();
  return withTreeChange(root, async () => {
    await git(root, ["stash", "pop", `stash@{${Math.max(0, index)}}`], { timeoutMs: 300_000 });
    return { popped: index };
  });
}

export async function stashList() {
  const root = await requireRepo();
  const result = await git(root, ["stash", "list", "--format=%gd%x1f%s%x1f%cr"], { allowFailure: true });
  return result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line, index) => {
      const [ref, subject, when] = line.split("\x1f");
      return { index, ref, subject: subject ?? "", when: when ?? "" };
    });
}

// ---- remotes -----------------------------------------------------------------

/** @param {string} name @param {string} url */
export async function addRemote(name, url) {
  const root = await requireRepo();
  await git(root, ["remote", "add", name, url]);
  return { name, url };
}

/** @param {{ remote?: string, prune?: boolean }} [options] */
export async function fetch({ remote = "origin", prune = true } = {}) {
  const root = await requireRepo();
  const args = ["fetch", remote, ...(prune ? ["--prune"] : [])];
  const result = await git(root, args, { timeoutMs: 300_000 });
  const status = await readStatus(root);
  return { remote, ahead: status.branch.ahead, behind: status.branch.behind, output: result.stderr.trim() };
}

/**
 * @param {{ remote?: string, rebase?: boolean }} [options]
 *   Merge, not rebase, by default: a rebase that hits a conflict leaves the
 *   repository in a state whose only exit is `rebase --continue`, and the panel
 *   would be lying if it offered a Commit button there.
 */
export async function pull({ remote = "origin", rebase = false } = {}) {
  const root = await requireRepo();
  return withTreeChange(root, async () => {
    const args = ["pull", ...(rebase ? ["--rebase"] : ["--no-rebase", "--no-edit"]), remote];
    const result = await git(root, args, { allowFailure: true, timeoutMs: 600_000 });
    const status = await readStatus(root);
    const conflicts = status.files.filter((file) => file.conflicted).map((file) => file.path);
    if (!result.ok && !conflicts.length) throw new Error(`${result.stderr || result.stdout}`.trim());
    return { remote, conflicts, output: `${result.stdout}${result.stderr}`.trim() };
  });
}

/**
 * @param {{ remote?: string, branch?: string, setUpstream?: boolean }} [options]
 *
 * There is no force option, on purpose. Force-pushing is how a solo developer
 * discovers that a button can delete work that was already backed up, and
 * nothing the editor offers needs it — the recoveries it is used for (a bad
 * rebase, a wrong amend) are not operations this panel performs.
 */
export async function push({ remote = "origin", branch, setUpstream } = {}) {
  const root = await requireRepo();
  const status = await readStatus(root);
  const target = branch ?? status.branch.head;
  if (!target) throw new Error("HEAD is detached, so there is no branch to push. Check out a branch first.");
  // First push of a new branch: without -u the branch is pushed but not
  // tracked, so the panel keeps reporting "no upstream" afterwards.
  const upstream = setUpstream ?? !status.branch.upstream;
  const args = ["push", ...(upstream ? ["--set-upstream"] : []), remote, target];
  const result = await git(root, args, { timeoutMs: 900_000 });
  const after = await readStatus(root);
  return {
    remote,
    branch: target,
    ahead: after.branch.ahead,
    behind: after.branch.behind,
    output: `${result.stdout}${result.stderr}`.trim(),
  };
}

// ---- configuration -----------------------------------------------------------

/**
 * @param {{ name?: string, email?: string, global?: boolean }} options
 *   Written to the repository by default. Global would be the friendlier
 *   default for a first-time user, but it edits a file shared with every other
 *   tool on the machine, and an editor should not do that without being asked.
 */
export async function setIdentity({ name, email, global = false }) {
  const root = await requireRepo();
  const scope = global ? "--global" : "--local";
  if (name) await git(root, ["config", scope, "user.name", name]);
  if (email) await git(root, ["config", scope, "user.email", email]);
  return readIdentity(root);
}

/** @param {string[]} patterns e.g. `["*.png", "*.glb"]` */
export async function trackWithLfs(patterns) {
  const root = await requireRepo();
  const install = await git(root, ["lfs", "install", "--local"], { allowFailure: true });
  if (!install.ok) {
    throw new Error("Git LFS is not installed on this machine. Get it from git-lfs.com, then try again.");
  }
  await git(root, ["lfs", "track", ...patterns], { timeoutMs: 120_000 });
  return { patterns };
}

// ---- GitHub ------------------------------------------------------------------

/**
 * Signs in with the browser device flow.
 *
 * `onCode` is called with the one-time code as soon as gh prints it — which is
 * before the login finishes, and is the point: the code is what the user types
 * into the page. Waiting for the command to return would show it to them after
 * it had expired.
 *
 * @param {(info: { code: string, url: string }) => void} [onCode]
 */
export async function githubLogin(onCode) {
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = await listen("github-auth-code", (event) => {
    onCode?.(/** @type {any} */ (event.payload));
  });
  try {
    const result = /** @type {{ ok: boolean, stdout: string }} */ (await invoke("github_login", {}));
    if (!result.ok) throw new Error(result.stdout.trim() || "The GitHub sign-in did not complete.");
    // Without this, a signed-in gh still leaves `git push` asking for a
    // password: the token lives in gh's config and only this wires it into
    // git's credential helper.
    await gh(null, ["auth", "setup-git"], { allowFailure: true });
    return { ok: true };
  } finally {
    unlisten();
  }
}

/**
 * Signs in with a personal access token instead of the browser.
 *
 * The path that works without a person present, which is what makes GitHub
 * reachable from an MCP session. The token needs `repo` scope (and `workflow`
 * if the project has Actions).
 *
 * @param {string} token
 */
export async function githubLoginWithToken(token) {
  const text = String(token ?? "").trim();
  if (!text) throw new Error("No token given.");
  await gh(null, ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--with-token"], {
    stdin: `${text}\n`,
    timeoutMs: 60_000,
  });
  await gh(null, ["auth", "setup-git"], { allowFailure: true });
  return { ok: true };
}

/**
 * Creates the repository on GitHub and pushes this project into it.
 *
 * `--source` makes gh set `origin` and push in one step, which matters for more
 * than convenience: creating the repository and wiring the remote are the two
 * halves of one intention, and a failure between them leaves a stranded empty
 * repository that the next attempt then collides with.
 *
 * @param {{ name: string, private?: boolean, description?: string, push?: boolean }} options
 */
export async function githubCreateRepo({ name, private: isPrivate = true, description = "", push: doPush = true }) {
  const root = await requireRepo();
  const repoName = String(name ?? "").trim();
  if (!/^[\w.-]+$/.test(repoName)) {
    throw new Error("A GitHub repository name can only contain letters, digits, dots, hyphens and underscores.");
  }
  const head = await headSha(root);
  if (!head) {
    throw new Error("There is nothing to publish yet — make your first commit, then create the repository.");
  }
  const args = [
    "repo",
    "create",
    repoName,
    isPrivate ? "--private" : "--public",
    "--source",
    ".",
    "--remote",
    "origin",
  ];
  if (description) args.push("--description", description);
  if (doPush) args.push("--push");
  const result = await gh(root, args, { timeoutMs: 900_000 });
  const url = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+/.exec(`${result.stdout}\n${result.stderr}`)?.[0] ?? null;
  return { name: repoName, url, private: isPrivate, pushed: doPush };
}
