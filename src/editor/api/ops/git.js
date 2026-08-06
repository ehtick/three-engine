/**
 * Version control, as tools.
 *
 * Same rule as everywhere else in this registry: these are not a parallel
 * agent-only path into git. Each one calls the function the Git panel's own
 * button calls (`editor/git/gitService.js`), so an agent's commit is made
 * exactly the way a person's is — same LFS setup, same identity check, same
 * reload of the working tree afterwards.
 *
 * Nothing here is `undoable`. The editor's undo stack is a list of scene
 * commands; git has its own history and its own inverse operations, and
 * pretending Ctrl+Z could take back a push would be worse than not offering it.
 * `git.status` is the op to call first — it says whether there is a repository
 * at all, who you are committing as, and what is uncommitted.
 */
import { defineOp } from "../registry.js";
import {
  readCommitDiff,
  readDiff,
  readLfsPatterns,
  readLog,
  readStatus,
  probeTools,
} from "../../git/gitCli.js";
import * as service from "../../git/gitService.js";
import { refreshGit, invalidateGithubAuth, useGitStore } from "../../git/gitStore.js";
import { githubSlug } from "../../git/porcelain.js";

/** Runs an action, then makes the panel and the menu-bar chip agree with it. */
async function andRefresh(run) {
  try {
    return await run();
  } finally {
    await refreshGit();
  }
}

defineOp({
  name: "git.status",
  readOnly: true,
  description:
    "The state of the project's git repository: whether there is one, the branch, how far ahead/behind its remote, every changed file with whether it is staged, any merge in progress, the configured commit identity, and which of git/git-lfs/gh are installed. Call this before any other git tool — it answers 'is there a repository' and 'can this machine commit at all' in one round trip.",
  params: {},
  async run() {
    const state = await refreshGit();
    return {
      installed: !!state.tools?.git?.found,
      gitVersion: state.tools?.git?.version ?? "",
      lfsInstalled: !!state.tools?.lfs?.found,
      ghInstalled: !!state.tools?.gh?.found,
      isRepo: state.isRepo,
      root: state.root,
      branch: state.branch,
      operation: state.operation,
      identity: state.identity,
      remotes: state.remotes,
      github: state.github,
      files: state.files.map((file) => ({
        path: file.path,
        orig: file.orig,
        kind: file.kind,
        staged: file.staged,
        unstaged: file.unstaged,
        untracked: file.untracked,
        conflicted: file.conflicted,
      })),
      error: state.error,
    };
  },
});

defineOp({
  name: "git.init",
  description:
    "Create a git repository for the open project: writes a .gitignore that excludes the build folder and the generated type definitions, sets up Git LFS for binary assets (models, textures, audio), writes .gitattributes, and makes the first commit. Do this before any other git tool. LFS is configured up front because moving assets into it after they are committed means rewriting history.",
  params: {
    lfs: { type: "boolean", default: true, description: "Track binary asset formats with Git LFS. Silently skipped, with a note in the result, when git-lfs is not installed." },
    commit: { type: "boolean", default: true, description: "Make the initial commit. Skipped if git has no user identity configured yet." },
    branch: { type: "string", default: "main", description: "Name for the first branch." },
  },
  async run({ lfs = true, commit = true, branch = "main" }) {
    const { useProjectStore } = await import("../../store/projectStore.js");
    const { getProjectSettings } = await import("../../projectSettings.js");
    const project = useProjectStore.getState();
    return andRefresh(() =>
      service.initRepository({
        lfs,
        commit,
        branch,
        outDir: getProjectSettings()?.build?.outDir ?? "Build",
        projectName: project.projectMeta?.name ?? "",
      }),
    );
  },
});

defineOp({
  name: "git.stage",
  description:
    "Stage changes for the next commit. Pass repo-relative paths, or omit them to stage everything including new files. Staging is what decides the contents of the next commit — a modified file that is not staged stays out of it.",
  params: {
    paths: { type: "array", items: { type: "string" }, description: "Repo-relative paths from git.status. Omit to stage every change." },
  },
  async run({ paths = [] }) {
    return andRefresh(async () => {
      const status = await service.stage(paths);
      return { staged: paths.length ? paths : "all", files: status.files.length };
    });
  },
});

defineOp({
  name: "git.unstage",
  description:
    "Take changes back out of the staging area, leaving the edits themselves untouched in the working tree. The inverse of git.stage, and safe — nothing is lost.",
  params: {
    paths: { type: "array", items: { type: "string" }, description: "Repo-relative paths. Omit to unstage everything." },
  },
  async run({ paths = [] }) {
    return andRefresh(async () => {
      const status = await service.unstage(paths);
      return { unstaged: paths.length ? paths : "all", files: status.files.length };
    });
  },
});

defineOp({
  name: "git.discard",
  description:
    "THROW AWAY uncommitted changes to the given paths, reverting tracked files to their committed state and DELETING untracked ones. This is the one destructive git tool: what it removes is not in any commit and cannot be recovered. Confirm with the user before calling it, and prefer git.stash when you only need the changes out of the way.",
  params: {
    paths: { type: "array", items: { type: "string" }, required: true, description: "Repo-relative paths, exactly as git.status reports them." },
  },
  async run({ paths }) {
    return andRefresh(() => service.discard(paths));
  },
});

defineOp({
  name: "git.commit",
  description:
    "Commit what is staged. Fails with an explanation when nothing is staged or when git has no configured name and email (use git.setIdentity). Write the message as a summary line of what changed and why — it is the only record anyone reads later.",
  params: {
    message: { type: "string", required: true, description: "Commit message. A single summary line, optionally followed by a blank line and detail." },
    all: { type: "boolean", default: false, description: "Stage every tracked modification first (git commit -a). Does not include new untracked files." },
    amend: { type: "boolean", default: false, description: "Replace the previous commit instead of adding one. Never use this on a commit that has already been pushed." },
  },
  async run({ message, all = false, amend = false }) {
    return andRefresh(() => service.commit({ message, all, amend }));
  },
});

defineOp({
  name: "git.diff",
  readOnly: true,
  description:
    "The changes in the working tree, parsed into files, hunks and numbered lines. Pass a path to see one file, `staged: true` to see what is about to be committed rather than what is not. Binary assets report as changed without a patch, since a diff of a texture is not readable.",
  params: {
    path: { type: "string", description: "Repo-relative path. Omit for every changed file." },
    staged: { type: "boolean", default: false, description: "Diff the staging area against the last commit instead of the working tree against the staging area." },
    context: { type: "number", default: 3, description: "Lines of unchanged context around each change." },
  },
  async run({ path, staged = false, context = 3 }) {
    const state = useGitStore.getState();
    const root = state.root ?? (await service.requireRepo());
    const untracked = state.files.some((file) => file.path === path && file.untracked);
    const files = await readDiff(root, { path, staged, context, untracked });
    return { staged, files };
  },
});

defineOp({
  name: "git.log",
  readOnly: true,
  description:
    "Commit history, newest first: sha, author, date, subject and any branch or tag names pointing at each commit. Pass a path to see only the commits that touched one file — the fastest way to answer 'when did this scene last change and why'.",
  params: {
    limit: { type: "number", default: 30, description: "How many commits to return (max 1000)." },
    path: { type: "string", description: "Repo-relative path to filter by." },
    ref: { type: "string", description: "Branch, tag or sha to start from. Defaults to the checked-out branch." },
    all: { type: "boolean", default: false, description: "Include commits on every branch, not just the current one." },
  },
  async run({ limit = 30, path, ref, all = false }) {
    const root = useGitStore.getState().root ?? (await service.requireRepo());
    return { commits: await readLog(root, { limit, path, ref, all }) };
  },
});

defineOp({
  name: "git.show",
  readOnly: true,
  description:
    "The full patch a single commit introduced, parsed into files and hunks. Use it after git.log to find out what a commit actually did, before reverting or cherry-picking anything.",
  params: {
    commit: { type: "string", required: true, description: "Commit sha (short or full), or any revision expression like HEAD~2." },
  },
  async run({ commit }) {
    const root = useGitStore.getState().root ?? (await service.requireRepo());
    return { commit, files: await readCommitDiff(root, commit) };
  },
});

defineOp({
  name: "git.branches",
  readOnly: true,
  description:
    "Every local and remote-tracking branch, with which one is checked out, what each tracks, and how recently it moved. Remote-tracking branches are marked as such — checking one out directly detaches HEAD, so create a local branch from it instead.",
  params: {},
  async run() {
    const state = await refreshGit();
    return { current: state.branch.head, detached: state.branch.detached, branches: state.branches };
  },
});

defineOp({
  name: "git.checkout",
  description:
    "Switch to a branch, tag or commit, optionally creating the branch first. This REWRITES FILES ON DISK, including the open scene — the editor reloads what changed automatically, but unsaved edits in the editor are not part of that and should be saved or stashed first.",
  params: {
    ref: { type: "string", required: true, description: "Branch name to switch to, or the name to give a new branch when `create` is true." },
    create: { type: "boolean", default: false, description: "Create the branch before switching to it." },
    from: { type: "string", description: "With `create`, the starting point (branch, tag or sha). Defaults to the current HEAD." },
  },
  async run({ ref, create = false, from }) {
    return andRefresh(() => service.checkout(ref, { create, from }));
  },
});

defineOp({
  name: "git.deleteBranch",
  description:
    "Delete a local branch. Refuses by default when the branch holds commits that are not merged anywhere else, which is the check that stops work being lost; `force` overrides it and should be confirmed with the user.",
  params: {
    name: { type: "string", required: true, description: "Local branch name." },
    force: { type: "boolean", default: false, description: "Delete even if it has unmerged commits." },
  },
  async run({ name, force = false }) {
    return andRefresh(() => service.deleteBranch(name, { force }));
  },
});

defineOp({
  name: "git.merge",
  description:
    "Merge another branch into the current one. Conflicts are a normal outcome, not a failure: the result lists the conflicted paths, the repository stays mid-merge, and the fix is to edit those files, git.stage them and git.commit. git.abortMerge backs the whole thing out.",
  params: {
    ref: { type: "string", required: true, description: "Branch, tag or sha to merge in." },
  },
  async run({ ref }) {
    return andRefresh(() => service.merge(ref));
  },
});

defineOp({
  name: "git.abortMerge",
  description:
    "Abandon a merge, pull or cherry-pick that stopped on conflicts and put the working tree back exactly as it was before it started. The escape hatch when a merge turns out to be more than you want to resolve.",
  params: {},
  async run() {
    return andRefresh(() => service.abortMerge());
  },
});

defineOp({
  name: "git.stash",
  description:
    "Put every uncommitted change aside and return the working tree to the last commit, so a branch can be switched or a pull can run cleanly. Nothing is lost — git.stashPop brings it all back. This is the safe alternative to git.discard.",
  params: {
    message: { type: "string", description: "Label for the stash, so a list of them is readable later." },
    includeUntracked: { type: "boolean", default: true, description: "Also stash files git is not tracking yet." },
  },
  async run({ message = "", includeUntracked = true }) {
    return andRefresh(() => service.stashPush({ message, includeUntracked }));
  },
});

defineOp({
  name: "git.stashPop",
  description:
    "Restore a stash into the working tree and drop it from the stash list. Can conflict if the same lines changed since it was made, in which case the conflicted files are reported the same way a merge reports them.",
  params: {
    index: { type: "number", default: 0, description: "Which stash, from git.stashList. 0 is the most recent." },
  },
  async run({ index = 0 }) {
    return andRefresh(() => service.stashPop(index));
  },
});

defineOp({
  name: "git.stashList",
  readOnly: true,
  description:
    "Every stash currently held, with its label and age. Check this before stashing again — an unlabelled pile of stashes is how work gets forgotten.",
  params: {},
  async run() {
    return { stashes: await service.stashList() };
  },
});

defineOp({
  name: "git.remotes",
  readOnly: true,
  description:
    "The remotes this repository can push to and fetch from, with their URLs and, for GitHub ones, the owner/repo slug. An empty list means the project only exists on this machine.",
  params: {},
  async run() {
    const state = await refreshGit();
    return {
      remotes: state.remotes.map((remote) => ({ ...remote, github: githubSlug(remote.url) })),
      upstream: state.branch.upstream,
    };
  },
});

defineOp({
  name: "git.addRemote",
  description:
    "Point the repository at a remote you already created elsewhere. To create the repository on GitHub instead, use git.github.createRepo, which makes it and wires up the remote in one step.",
  params: {
    name: { type: "string", default: "origin", description: "Remote name. 'origin' is the conventional one." },
    url: { type: "string", required: true, description: "Clone URL — https://… or git@host:owner/repo.git." },
  },
  async run({ name = "origin", url }) {
    return andRefresh(() => service.addRemote(name, url));
  },
});

defineOp({
  name: "git.fetch",
  description:
    "Download what the remote has without changing any file in the working tree, then report how far ahead or behind the current branch is. The safe way to find out whether there is anything to pull.",
  params: {
    remote: { type: "string", default: "origin", description: "Which remote to fetch from." },
    prune: { type: "boolean", default: true, description: "Forget remote-tracking branches that no longer exist on the remote." },
  },
  async run({ remote = "origin", prune = true }) {
    return andRefresh(() => service.fetch({ remote, prune }));
  },
});

defineOp({
  name: "git.pull",
  description:
    "Fetch and merge the remote's changes into the current branch. REWRITES FILES ON DISK — the editor reloads what changed, but unsaved editor state is not part of that. Conflicts are reported as a list of paths with the repository left mid-merge, exactly like git.merge.",
  params: {
    remote: { type: "string", default: "origin", description: "Which remote to pull from." },
    rebase: { type: "boolean", default: false, description: "Replay local commits on top of the remote's instead of making a merge commit. Leaves a stopped rebase on conflict, which is harder to get out of than a merge." },
  },
  async run({ remote = "origin", rebase = false }) {
    return andRefresh(() => service.pull({ remote, rebase }));
  },
});

defineOp({
  name: "git.push",
  description:
    "Upload the current branch's commits to the remote, setting up tracking on the first push of a new branch. Needs credentials: on a machine where the GitHub CLI is signed in this just works, otherwise the system credential helper asks. There is deliberately no force option.",
  params: {
    remote: { type: "string", default: "origin", description: "Which remote to push to." },
    branch: { type: "string", description: "Branch to push. Defaults to the one checked out." },
  },
  async run({ remote = "origin", branch }) {
    return andRefresh(() => service.push({ remote, branch }));
  },
});

defineOp({
  name: "git.setIdentity",
  description:
    "Set the name and email stamped onto commits. Without these git refuses to commit at all, and it is the most common reason a first commit fails on a new machine. Writes to this repository only unless `global` is set.",
  params: {
    name: { type: "string", description: "Author name, e.g. 'Jane Dev'." },
    email: { type: "string", description: "Author email." },
    global: { type: "boolean", default: false, description: "Write to the machine-wide git config instead of this repository's." },
  },
  async run({ name, email, global = false }) {
    return andRefresh(() => service.setIdentity({ name, email, global }));
  },
});

defineOp({
  name: "git.lfs",
  description:
    "Inspect or extend which file patterns are stored in Git LFS. Large binaries belong there: without it every version of every texture and model lives in the repository forever and each clone pays for all of them. Pass patterns to add them, omit to just read the current list.",
  params: {
    patterns: {
      type: "array",
      items: { type: "string" },
      description: "Glob patterns to start tracking, e.g. ['*.psd', '*.mp4']. Files already committed are not moved retroactively.",
    },
  },
  async run({ patterns = [] }) {
    const root = useGitStore.getState().root ?? (await service.requireRepo());
    if (patterns.length) await service.trackWithLfs(patterns);
    const tools = await probeTools();
    return { installed: !!tools?.lfs?.found, patterns: await readLfsPatterns(root) };
  },
});

// ---- GitHub ------------------------------------------------------------------

defineOp({
  name: "git.github.status",
  readOnly: true,
  description:
    "Whether the GitHub CLI is installed and signed in, as whom, and with which token scopes. Publishing to GitHub needs all three; check this before offering to create a repository.",
  params: {},
  async run() {
    invalidateGithubAuth();
    const state = await refreshGit();
    return {
      installed: !!state.tools?.gh?.found,
      version: state.tools?.gh?.version ?? "",
      ...(state.github ?? { loggedIn: false, account: null, scopes: [] }),
      remotes: state.remotes.map((remote) => githubSlug(remote.url)).filter(Boolean),
    };
  },
});

defineOp({
  name: "git.github.login",
  description:
    "Sign in to GitHub with a personal access token (needs the 'repo' scope) and wire it into git's credential helper so pushes work. This is the sign-in path that does not need a person present — the browser flow is a button in the Git panel, since it requires typing a one-time code into a web page.",
  params: {
    token: { type: "string", required: true, description: "A GitHub personal access token with 'repo' scope. It is handed to the GitHub CLI, which stores it in the OS keychain; the editor does not keep a copy." },
  },
  async run({ token }) {
    const result = await service.githubLoginWithToken(token);
    invalidateGithubAuth();
    await refreshGit();
    return result;
  },
});

defineOp({
  name: "git.github.createRepo",
  description:
    "Create the repository on GitHub, set it as this project's origin and push everything to it, in one step. Requires at least one commit to exist and the GitHub CLI to be signed in. Returns the repository URL. Defaults to private — say so explicitly if the user asked for a public one.",
  params: {
    name: { type: "string", required: true, description: "Repository name on GitHub. Letters, digits, dots, hyphens and underscores." },
    private: { type: "boolean", default: true, description: "Create it private. A game project usually has assets whose licences do not allow redistribution, so this defaults to true." },
    description: { type: "string", description: "One-line description shown on the repository page." },
    push: { type: "boolean", default: true, description: "Push the current branch immediately after creating it." },
  },
  async run({ name, private: isPrivate = true, description = "", push = true }) {
    return andRefresh(() => service.githubCreateRepo({ name, private: isPrivate, description, push }));
  },
});
