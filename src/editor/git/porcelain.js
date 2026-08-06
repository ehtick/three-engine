// @ts-check
/**
 * Parsers for git's machine-readable output.
 *
 * Every function here is pure: text in, plain objects out, no Tauri, no store,
 * no `invoke`. That is what makes `npm run test:git` able to check the awkward
 * cases — a rename with a space in the name, a conflicted file, a detached
 * HEAD, a binary diff — against recorded output in two seconds, instead of
 * needing a real repository in a real editor to find out that a status line was
 * misread.
 *
 * ## Formats chosen, and why
 *
 * - **`status --porcelain=v2 --branch -z`.** v1 cannot express upstream
 *   tracking or ahead/behind, and its rename records are ambiguous. v2 is
 *   explicitly documented as stable for tools, which v1's `XY` shorthand is
 *   not. `-z` is not optional: without it a path containing a newline (legal,
 *   and something an asset importer can produce) silently becomes two entries.
 * - **`--format` with `%x1f`/`%x1e` separators for logs and `%09` tabs for
 *   branches.** Both are field separators that cannot occur in a commit
 *   subject, a ref name or a path, so no escaping scheme is needed.
 *
 * The one thing NOT parsed as porcelain is the diff, because there is no
 * porcelain form of it — a unified diff is the format, and the editor needs it
 * split into hunks and lines to render side numbers.
 */

/**
 * @typedef {object} GitFile
 * @property {string} path              Repo-relative, forward slashes.
 * @property {string | null} orig       Previous path for a rename/copy.
 * @property {string} index             Staged status letter: M A D R C T U or "."
 * @property {string} worktree          Unstaged status letter, same alphabet.
 * @property {boolean} staged           Has something in the index to commit.
 * @property {boolean} unstaged         Has something in the working tree.
 * @property {boolean} untracked        Not tracked by git at all.
 * @property {boolean} conflicted       Unmerged — needs resolving before commit.
 * @property {string} kind              A word for the UI: modified/added/…
 */

/** Status letters to the word the panel shows. */
const KINDS = {
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "typechange",
  U: "conflicted",
};

/** The single word describing a file, preferring the staged side. */
function kindOf(index, worktree, { untracked = false, conflicted = false } = {}) {
  if (untracked) return "untracked";
  if (conflicted) return "conflicted";
  const letter = index !== "." ? index : worktree;
  return KINDS[letter] ?? "modified";
}

/**
 * Parses `git status --porcelain=v2 --branch --untracked-files=all -z`.
 *
 * The `-z` framing has one trap worth stating: a rename record (`2 …`) is
 * followed by its ORIGINAL path as a *separate* NUL-terminated field, where the
 * human-readable form puts both on one line separated by a tab. A parser that
 * splits on NUL and treats every field as a record therefore reads the old path
 * as a malformed entry, and the file count comes out one too high.
 *
 * @param {string} stdout
 * @returns {{ branch: { head: string, oid: string, upstream: string | null,
 *             ahead: number, behind: number, detached: boolean },
 *            files: GitFile[] }}
 */
export function parseStatus(stdout) {
  const branch = { head: "", oid: "", upstream: null, ahead: 0, behind: 0, detached: false };
  /** @type {GitFile[]} */
  const files = [];
  // A trailing NUL leaves an empty final field; every record is non-empty.
  const records = String(stdout ?? "").split("\0");

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;

    if (record.startsWith("# ")) {
      const [key, ...rest] = record.slice(2).split(" ");
      const value = rest.join(" ");
      if (key === "branch.oid") branch.oid = value === "(initial)" ? "" : value;
      else if (key === "branch.head") {
        branch.detached = value === "(detached)";
        branch.head = branch.detached ? "" : value;
      } else if (key === "branch.upstream") branch.upstream = value;
      else if (key === "branch.ab") {
        // "+2 -1" — the signs are part of the format, not of the numbers.
        const [ahead, behind] = value.split(" ");
        branch.ahead = Math.abs(Number(ahead)) || 0;
        branch.behind = Math.abs(Number(behind)) || 0;
      }
      continue;
    }

    if (record.startsWith("? ")) {
      const path = record.slice(2);
      files.push({
        path,
        orig: null,
        index: ".",
        worktree: "?",
        staged: false,
        unstaged: true,
        untracked: true,
        conflicted: false,
        kind: "untracked",
      });
      continue;
    }

    // Ignored entries only appear with --ignored, which the editor never asks
    // for; skipping them keeps the parser total rather than surprised.
    if (record.startsWith("! ")) continue;

    if (record.startsWith("1 ") || record.startsWith("2 ") || record.startsWith("u ")) {
      const fields = record.split(" ");
      const type = fields[0];
      const xy = fields[1] ?? "..";
      const index = xy[0] ?? ".";
      const worktree = xy[1] ?? ".";
      // Field counts differ per record type; the path is everything after the
      // fixed columns, and it can itself contain spaces.
      const fixed = type === "1" ? 8 : type === "2" ? 9 : 10;
      const path = fields.slice(fixed).join(" ");
      let orig = null;
      if (type === "2") {
        orig = records[i + 1] ?? null;
        i += 1; // consume the original-path field
      }
      const conflicted = type === "u";
      files.push({
        path,
        orig,
        index,
        worktree,
        staged: !conflicted && index !== ".",
        unstaged: conflicted || worktree !== ".",
        untracked: false,
        conflicted,
        kind: kindOf(index, worktree, { conflicted }),
      });
    }
  }

  return { branch, files };
}

/**
 * The `--format` string {@link parseBranches} expects.
 *
 * `%(refname)` is carried alongside the short name on purpose: `origin/main`
 * and a local branch literally named `origin/main` are indistinguishable once
 * shortened, and only the full ref says which is a remote-tracking branch —
 * which matters because checking one of those out detaches HEAD.
 */
export const BRANCH_FORMAT =
  "%(refname)%09%(refname:short)%09%(upstream:short)%09%(objectname:short)%09%(HEAD)%09%(committerdate:relative)";

/**
 * Parses `git branch --all --format=BRANCH_FORMAT`.
 *
 * @param {string} stdout
 * @returns {Array<{ name: string, ref: string, upstream: string | null, sha: string,
 *                   current: boolean, when: string, remote: boolean }>}
 */
export function parseBranches(stdout) {
  return String(stdout ?? "")
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter(Boolean)
    .map((line) => {
      const [ref, name, upstream, sha, head, when] = line.split("\t");
      return {
        name: name ?? "",
        ref: ref ?? "",
        upstream: upstream || null,
        sha: sha ?? "",
        current: head?.trim() === "*",
        when: when ?? "",
        remote: (ref ?? "").startsWith("refs/remotes/"),
      };
    })
    // `git branch -a` includes the symbolic `origin/HEAD -> origin/main`, which
    // is a pointer rather than a branch anyone can check out.
    .filter((entry) => entry.name && !entry.name.endsWith("/HEAD"));
}

/** Field/record separators for {@link parseLog}: unit and record separator. */
export const LOG_FORMAT = "%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1f%P%x1f%D%x1e";

/**
 * Parses `git log --format=LOG_FORMAT`.
 *
 * @param {string} stdout
 * @returns {Array<{ sha: string, short: string, author: string, date: string,
 *                   subject: string, parents: string[], refs: string[] }>}
 */
export function parseLog(stdout) {
  return String(stdout ?? "")
    .split("\x1e")
    .map((record) => record.replace(/^[\r\n]+/, ""))
    .filter((record) => record.trim().length)
    .map((record) => {
      const [sha, short, author, date, subject, parents, refs] = record.split("\x1f");
      return {
        sha: sha ?? "",
        short: short ?? "",
        author: author ?? "",
        date: date ?? "",
        subject: subject ?? "",
        parents: (parents ?? "").split(" ").filter(Boolean),
        refs: (refs ?? "")
          .split(", ")
          .map((ref) => ref.replace("HEAD -> ", "").trim())
          .filter(Boolean),
      };
    });
}

/**
 * Parses `git remote -v` into one entry per remote (not per direction).
 *
 * @param {string} stdout
 * @returns {Array<{ name: string, url: string }>}
 */
export function parseRemotes(stdout) {
  /** @type {Map<string, string>} */
  const remotes = new Map();
  for (const line of String(stdout ?? "").split("\n")) {
    const [name, rest] = line.trim().split(/\s+/, 2);
    if (!name || !rest) continue;
    const url = rest.replace(/\s+\((fetch|push)\)$/, "");
    // Fetch and push URLs can differ; the fetch one is what the panel links to,
    // and it is listed first.
    if (!remotes.has(name)) remotes.set(name, url);
  }
  return [...remotes].map(([name, url]) => ({ name, url }));
}

/**
 * A browsable https URL for a remote, or null if it isn't one we can linkify.
 *
 * Handles the three spellings of the same GitHub repository — `https://`,
 * `git@host:owner/repo.git` and `ssh://git@host/owner/repo` — because which one
 * a user has depends on how they cloned, and "Open on GitHub" should work in
 * all three cases.
 *
 * @param {string} url
 */
export function webUrlForRemote(url) {
  const text = String(url ?? "").trim().replace(/\.git$/, "");
  if (!text) return null;
  const scp = /^(?:ssh:\/\/)?(?:[\w.-]+@)?([\w.-]+)[:/]([\w.-]+\/[\w.-]+)$/.exec(text);
  if (text.startsWith("http://") || text.startsWith("https://")) return text;
  if (scp) return `https://${scp[1]}/${scp[2]}`;
  return null;
}

/** `owner/repo` for a GitHub remote, else null. */
export function githubSlug(url) {
  const web = webUrlForRemote(url);
  if (!web || !/^https:\/\/(www\.)?github\.com\//.test(web)) return null;
  return web.replace(/^https:\/\/(www\.)?github\.com\//, "");
}

/**
 * Parses `gh auth status`, whose exit code alone doesn't say *who* is signed in.
 *
 * Written against gh 2.70's output:
 *
 *     github.com
 *       ✓ Logged in to github.com account khudiiash (keyring)
 *       - Token scopes: 'gist', 'read:org', 'repo', 'workflow'
 *
 * @param {string} text  stdout and stderr together — gh writes this to stderr.
 * @param {number} code  exit status; 0 means signed in to at least one host.
 */
export function parseGhAuth(text, code = 0) {
  const body = String(text ?? "");
  const account = /account\s+([\w.-]+)/.exec(body)?.[1] ?? null;
  const scopes = (/Token scopes:\s*(.+)/.exec(body)?.[1] ?? "")
    .split(",")
    .map((scope) => scope.trim().replace(/^'|'$/g, ""))
    .filter(Boolean);
  return {
    // The account name is the reliable signal: gh exits 1 when *any* configured
    // host is logged out, even while another one is fine.
    loggedIn: code === 0 || !!account,
    account,
    scopes,
    // Pushing needs the credential helper wired up, which is a separate step
    // from having a token — and skipping it is why a first push can still ask
    // for a password after a successful sign-in.
    gitConfigured: /Git operations protocol/.test(body) || /configured to use/.test(body),
  };
}

/**
 * Splits a unified diff into files, hunks and numbered lines.
 *
 * The line numbers are the reason this exists rather than showing the raw
 * patch: reviewing a change to a scene file means knowing you are looking at
 * line 812, and a raw diff only states that once per hunk.
 *
 * @param {string} patch
 * @returns {Array<{ path: string, oldPath: string | null, binary: boolean,
 *                   additions: number, deletions: number,
 *                   hunks: Array<{ header: string, lines: Array<{ kind: string,
 *                     text: string, oldNo: number | null, newNo: number | null }> }> }>}
 */
export function parseDiff(patch) {
  const files = [];
  let file = null;
  let hunk = null;
  let oldNo = 0;
  let newNo = 0;

  for (const raw of String(patch ?? "").split("\n")) {
    const line = raw.replace(/\r$/, "");

    if (line.startsWith("diff --git ")) {
      // `diff --git a/path b/path` — take the b-side, which is the path the
      // file has now (for a rename, the a-side is the old one).
      const match = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      file = {
        path: match?.[2] ?? line.slice(11),
        oldPath: match?.[1] && match[1] !== match[2] ? match[1] : null,
        binary: false,
        additions: 0,
        deletions: 0,
        hunks: [],
      };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;

    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      file.binary = true;
      continue;
    }
    // Headers between the file line and the first hunk (index, mode, ---, +++)
    // carry nothing the panel shows; the rename ones are already covered by the
    // a/b paths above.
    if (line.startsWith("@@")) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
      oldNo = Number(match?.[1] ?? 1);
      newNo = Number(match?.[2] ?? 1);
      hunk = { header: match?.[3]?.trim() ?? "", lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;

    if (line.startsWith("+")) {
      hunk.lines.push({ kind: "add", text: line.slice(1), oldNo: null, newNo });
      newNo += 1;
      file.additions += 1;
    } else if (line.startsWith("-")) {
      hunk.lines.push({ kind: "del", text: line.slice(1), oldNo, newNo: null });
      oldNo += 1;
      file.deletions += 1;
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file" belongs to the line before it and must
      // not advance either counter.
      hunk.lines.push({ kind: "meta", text: line.slice(2), oldNo: null, newNo: null });
    } else if (line.startsWith(" ") || line === "") {
      hunk.lines.push({ kind: "context", text: line.slice(1), oldNo, newNo });
      oldNo += 1;
      newNo += 1;
    }
  }
  return files;
}

/**
 * What a repository is in the middle of, read from the files git leaves in
 * `.git` while an operation is unfinished.
 *
 * Surfaced because a half-finished merge is a state the editor must not hide:
 * every commit button in that state means "conclude the merge", and a user who
 * doesn't know they are mid-merge cannot make sense of the conflicts.
 *
 * @param {string[]} presentPaths  Names found inside the .git directory.
 */
export function repoOperation(presentPaths) {
  const names = new Set(presentPaths.map((p) => p.replaceAll("\\", "/").split("/").pop()));
  if (names.has("MERGE_HEAD")) return "merge";
  if (names.has("rebase-merge") || names.has("rebase-apply")) return "rebase";
  if (names.has("CHERRY_PICK_HEAD")) return "cherry-pick";
  if (names.has("REVERT_HEAD")) return "revert";
  return null;
}

/**
 * Turns a failed git invocation into a sentence worth showing.
 *
 * git's own stderr is usually good, but three cases are worth intercepting
 * because the raw text names a cause the user cannot act on from inside the
 * editor. Everything else is passed through — inventing wording for messages we
 * have not seen would make rarer failures *less* clear, not more.
 *
 * @param {{ code: number, stdout: string, stderr: string }} result
 */
export function explainFailure(result) {
  const text = `${result?.stderr ?? ""}\n${result?.stdout ?? ""}`.trim();
  if (/Please tell me who you are|unable to auto-detect email address/i.test(text)) {
    return "Git doesn't know who you are yet. Set a name and email in the Git panel's identity fields, then commit again.";
  }
  if (/could not read Username|Authentication failed|terminal prompts disabled/i.test(text)) {
    return "GitHub refused the credentials for this remote. Sign in to GitHub from the Git panel, then try again.";
  }
  if (/would be overwritten by (checkout|merge)/i.test(text)) {
    return "You have local changes to files this would replace. Commit or stash them first.";
  }
  return text || "The git command failed without saying why.";
}
