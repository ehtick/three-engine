// @ts-check
/**
 * The read side of git: running the binary, and asking a repository about
 * itself.
 *
 * Everything above this file (the panel, the store, the editor ops) speaks in
 * objects; everything below it (Rust, the git process) speaks in text. This is
 * the seam, and it is deliberately the ONLY one — there is no second place that
 * calls `invoke("git_exec")`, so the allowlist, the timeouts and the error
 * shaping cannot be bypassed by a caller in a hurry.
 *
 * See `src-tauri/src/git.rs` for why the CLI is used at all rather than a
 * library, and `porcelain.js` for the formats.
 */
import {
  BRANCH_FORMAT,
  LOG_FORMAT,
  explainFailure,
  parseBranches,
  parseGhAuth,
  parseDiff,
  parseLog,
  parseRemotes,
  parseStatus,
} from "./porcelain.js";
import { vmSingleton } from "../singleton.js";

/**
 * @typedef {{ ok: boolean, code: number, stdout: string, stderr: string }} ExecOutcome
 */

/**
 * VM-wide, because it caches a probe and a running command's promise.
 *
 * A `?t=` module twin with its own cache is not merely wasteful here: the panel
 * would read "git: not installed" from a copy that had never probed while the
 * store on the other copy knew perfectly well where git was. That is the exact
 * failure `singleton.js` exists for.
 */
const state = vmSingleton("gitCliState", () => ({
  /** @type {null | { git: any, lfs: any, gh: any }} */ probe: null,
  /** @type {Promise<any> | null} */ probing: null,
}));

async function invoke(command, args) {
  const { invoke: call } = await import("@tauri-apps/api/core");
  return call(command, args);
}

/**
 * Which of git, git-lfs and gh exist on this machine.
 *
 * Cached: the answer changes only when the user installs something, and the
 * panel asks on every mount. `refresh: true` is what the "I installed it, look
 * again" button passes.
 *
 * @param {{ refresh?: boolean }} [options]
 */
export async function probeTools({ refresh = false } = {}) {
  if (state.probe && !refresh) return state.probe;
  if (!state.probing || refresh) {
    state.probing = invoke("git_probe", {})
      .then((result) => {
        state.probe = result;
        return result;
      })
      .catch((error) => {
        // Outside Tauri there is no way to run anything; reporting "not
        // installed" is both true from the editor's point of view and the only
        // answer that lets the panel render its install prompt.
        state.probe = {
          git: { found: false, version: "", path: "", error: String(error?.message ?? error) },
          lfs: { found: false, version: "", path: "" },
          gh: { found: false, version: "", path: "" },
        };
        return state.probe;
      })
      .finally(() => {
        state.probing = null;
      });
  }
  return state.probing;
}

/**
 * Runs one git command.
 *
 * Throws on failure by default, because almost every caller is a button whose
 * only sensible response to "that didn't work" is to say so. The exceptions
 * pass `allowFailure` and read the exit code themselves — `rev-parse` in a
 * folder that is not a repository, and `diff --quiet`, both use a non-zero exit
 * to mean something other than an error.
 *
 * @param {string} cwd
 * @param {string[]} args
 * @param {{ stdin?: string, timeoutMs?: number, allowFailure?: boolean }} [options]
 * @returns {Promise<ExecOutcome>}
 */
export async function git(cwd, args, { stdin, timeoutMs, allowFailure = false } = {}) {
  if (!cwd) throw new Error("No project folder is open.");
  /** @type {ExecOutcome} */
  const result = await invoke("git_exec", { dir: cwd, args, stdin: stdin ?? null, timeoutMs: timeoutMs ?? null });
  if (!result.ok && !allowFailure) throw new Error(explainFailure(result));
  return result;
}

/**
 * Runs one `gh` command. Same contract as {@link git}.
 *
 * @param {string | null} cwd
 * @param {string[]} args
 * @param {{ stdin?: string, timeoutMs?: number, allowFailure?: boolean }} [options]
 * @returns {Promise<ExecOutcome>}
 */
export async function gh(cwd, args, { stdin, timeoutMs, allowFailure = false } = {}) {
  /** @type {ExecOutcome} */
  const result = await invoke("gh_exec", { dir: cwd ?? null, args, stdin: stdin ?? null, timeoutMs: timeoutMs ?? null });
  if (!result.ok && !allowFailure) {
    throw new Error(`${result.stderr || result.stdout || "The GitHub CLI failed."}`.trim());
  }
  return result;
}

/**
 * The repository containing `dir`, or null if there isn't one.
 *
 * Returns the TOP LEVEL rather than answering yes/no, because the project
 * folder is frequently not the repository root — a game living in `games/mine/`
 * of a larger repository is normal — and every path git reports is relative to
 * the top level. Getting this wrong makes staging silently target the wrong
 * file.
 *
 * @param {string} dir
 */
export async function findRepoRoot(dir) {
  if (!dir) return null;
  const result = await git(dir, ["rev-parse", "--show-toplevel"], { allowFailure: true });
  if (!result.ok) return null;
  const root = result.stdout.trim().replaceAll("\\", "/");
  return root || null;
}

/** Repo-relative path (forward slashes) for an absolute one. */
export function toRepoRelative(root, absolute) {
  const normalRoot = String(root ?? "").replaceAll("\\", "/").replace(/\/$/, "");
  const normal = String(absolute ?? "").replaceAll("\\", "/");
  if (normalRoot && normal.toLowerCase().startsWith(`${normalRoot.toLowerCase()}/`)) {
    return normal.slice(normalRoot.length + 1);
  }
  return normal;
}

/** Absolute path for a repo-relative one. */
export function toAbsolute(root, relative) {
  const normalRoot = String(root ?? "").replaceAll("\\", "/").replace(/\/$/, "");
  return `${normalRoot}/${String(relative ?? "").replaceAll("\\", "/")}`;
}

/**
 * Working-tree status, branch, tracking and what operation is in progress.
 *
 * `--untracked-files=all` rather than the default `normal`: normal collapses an
 * untracked directory into one entry, and "Textures/" is not something you can
 * review before committing — an imported model brings in a folder of them.
 *
 * @param {string} root
 */
export async function readStatus(root) {
  const [status, operation] = await Promise.all([
    git(root, ["status", "--porcelain=v2", "--branch", "--untracked-files=all", "-z"]),
    readOperation(root),
  ]);
  const parsed = parseStatus(status.stdout);
  return { ...parsed, operation };
}

/**
 * Whether a merge, rebase, cherry-pick or revert is unfinished.
 *
 * Asked via `rev-parse --verify` rather than by listing `.git`, because the
 * editor has no reason to be able to read inside `.git` at all — and in a
 * worktree or a submodule that directory is not where it looks.
 *
 * @param {string} root
 */
export async function readOperation(root) {
  const checks = /** @type {const} */ ([
    ["MERGE_HEAD", "merge"],
    ["CHERRY_PICK_HEAD", "cherry-pick"],
    ["REVERT_HEAD", "revert"],
    ["REBASE_HEAD", "rebase"],
  ]);
  for (const [ref, name] of checks) {
    const result = await git(root, ["rev-parse", "--verify", "--quiet", ref], { allowFailure: true });
    if (result.ok && result.stdout.trim()) return name;
  }
  return null;
}

/** Local and remote-tracking branches. @param {string} root */
export async function readBranches(root) {
  const result = await git(root, ["branch", "--all", `--format=${BRANCH_FORMAT}`]);
  return parseBranches(result.stdout);
}

/**
 * Commit history.
 * @param {string} root
 * @param {{ limit?: number, path?: string, ref?: string, all?: boolean }} [options]
 */
export async function readLog(root, { limit = 50, path, ref, all = false } = {}) {
  const args = ["log", `--max-count=${Math.max(1, Math.min(1000, limit))}`, `--format=${LOG_FORMAT}`];
  if (all) args.push("--all");
  if (ref) args.push(ref);
  if (path) args.push("--", path);
  // An empty repository has no HEAD, and `git log` calls that a fatal error
  // rather than an empty list. It is the state every new repository starts in,
  // so it must not surface as a failure.
  const result = await git(root, args, { allowFailure: true });
  if (!result.ok) return [];
  return parseLog(result.stdout);
}

/**
 * A patch for one path (or the whole tree), parsed into hunks.
 *
 * @param {string} root
 * @param {{ path?: string, staged?: boolean, untracked?: boolean, context?: number }} [options]
 */
export async function readDiff(root, { path, staged = false, untracked = false, context = 3 } = {}) {
  // An untracked file has nothing to diff against — git only knows about it as
  // a name. `--no-index` against the null device produces the "all of it is
  // new" patch a reviewer actually wants to see.
  const args = untracked
    ? ["diff", "--no-color", `--unified=${context}`, "--no-index", "--", "/dev/null", path ?? "."]
    : ["diff", "--no-color", `--unified=${context}`, ...(staged ? ["--cached"] : []), ...(path ? ["--", path] : [])];
  // `--no-index` exits 1 when the files differ, which is the whole point of
  // calling it, so failure is not an error here.
  const result = await git(root, args, { allowFailure: true });
  return parseDiff(result.stdout);
}

/**
 * The patch a single commit introduced.
 * @param {string} root
 * @param {string} sha
 */
export async function readCommitDiff(root, sha) {
  const result = await git(root, ["show", "--no-color", "--format=", "--unified=3", sha]);
  return parseDiff(result.stdout);
}

/** Configured remotes. @param {string} root */
export async function readRemotes(root) {
  const result = await git(root, ["remote", "-v"], { allowFailure: true });
  return parseRemotes(result.stdout);
}

/**
 * The identity commits will be attributed to.
 *
 * Read separately from everything else because it is the one piece of
 * configuration whose absence stops the first commit dead, with an error most
 * people meet for the first time inside a GUI that cannot fix it.
 *
 * @param {string} root
 */
export async function readIdentity(root) {
  const [name, email] = await Promise.all([
    git(root, ["config", "--get", "user.name"], { allowFailure: true }),
    git(root, ["config", "--get", "user.email"], { allowFailure: true }),
  ]);
  return { name: name.stdout.trim(), email: email.stdout.trim() };
}

/** Whether this repository routes anything through Git LFS. @param {string} root */
export async function readLfsPatterns(root) {
  const result = await git(root, ["lfs", "track"], { allowFailure: true });
  if (!result.ok) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes("filter=lfs") || /^\S+\s+\(.+\)$/.test(line))
    .map((line) => line.split(/\s+/)[0])
    .filter((pattern) => pattern && !pattern.startsWith("Listing"));
}

/** Who `gh` is signed in as, if anyone. */
export async function readGithubAuth() {
  const result = await gh(null, ["auth", "status"], { allowFailure: true, timeoutMs: 20_000 }).catch(() => null);
  if (!result) return { available: false, loggedIn: false, account: null, scopes: [], gitConfigured: false };
  return { available: true, ...parseGhAuth(`${result.stdout}\n${result.stderr}`, result.code) };
}
