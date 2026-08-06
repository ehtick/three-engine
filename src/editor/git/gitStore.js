// @ts-check
/**
 * The editor's live picture of the repository.
 *
 * One store serves both readers — the Git panel and the branch chip in the menu
 * bar — so they can never disagree about which branch is checked out, and one
 * `git status` answers both.
 *
 * ## How it stays current
 *
 * Three signals, because no one of them is sufficient:
 *
 * 1. **Explicit.** Every action in `gitService.js` ends with a refresh. Covers
 *    everything the editor itself does.
 * 2. **The project watcher's event.** Covers changes made by anything else —
 *    an IDE, an AI agent's file tools, a `git` command run in the Terminal
 *    panel. `watcher.rs` filters the editor's own writes out of that event,
 *    which is right for asset reloading and wrong here (a scene the editor
 *    saved is a file git now sees as modified), so it cannot be the only one.
 * 3. **A slow poll.** The backstop for (2)'s blind spot and for anything the
 *    watcher misses. Deliberately slow, and faster only while the panel is
 *    actually on screen: a `git status` every few seconds forever is a process
 *    spawn nobody asked for.
 */
import { create } from "zustand";
import { vmSingleton } from "../singleton.js";
import { useProjectStore } from "../store/projectStore.js";
import {
  findRepoRoot,
  probeTools,
  readBranches,
  readGithubAuth,
  readIdentity,
  readRemotes,
  readStatus,
} from "./gitCli.js";

/** How often to re-read status, in milliseconds. */
const POLL_VISIBLE = 8_000;
const POLL_BACKGROUND = 45_000;
/** Coalescing window for the watcher's file-change bursts. */
const EVENT_DEBOUNCE = 500;

const EMPTY = {
  /** Probe result: which of git / git-lfs / gh exist. */
  tools: /** @type {any} */ (null),
  /** Repository root, or null when the project is not in one. */
  root: /** @type {string | null} */ (null),
  isRepo: false,
  branch: { head: "", oid: "", upstream: /** @type {string | null} */ (null), ahead: 0, behind: 0, detached: false },
  /** @type {import("./porcelain.js").GitFile[]} */
  files: [],
  /** "merge" | "rebase" | "cherry-pick" | "revert" | null */
  operation: /** @type {string | null} */ (null),
  /** @type {Array<{ name: string, ref: string, upstream: string | null, sha: string, current: boolean, when: string, remote: boolean }>} */
  branches: [],
  /** @type {Array<{ name: string, url: string }>} */
  remotes: [],
  identity: { name: "", email: "" },
  /** @type {{ available: boolean, loggedIn: boolean, account: string | null, scopes: string[], gitConfigured: boolean } | null} */
  github: null,
  loading: false,
  /** Last failure, shown in the panel rather than thrown away into the console. */
  error: /** @type {string | null} */ (null),
  refreshedAt: 0,
};

const shared = vmSingleton("gitStore", () => {
  /** @type {{ timer: any, unlisten: null | (() => void), inFlight: Promise<any> | null,
   *           debounce: any, viewers: number, githubCheckedAt: number }} */
  const runtime = {
    timer: null,
    unlisten: null,
    inFlight: null,
    debounce: null,
    viewers: 0,
    githubCheckedAt: 0,
  };
  const store = create(() => ({ ...EMPTY }));
  return { store, runtime };
});

export const useGitStore = shared.store;

/**
 * Re-reads everything.
 *
 * Concurrent calls share one run rather than queueing: the panel, the chip and
 * a just-finished action can all ask within the same tick, and three overlapping
 * `git status` invocations would be three processes producing one answer.
 */
export async function refreshGit() {
  if (shared.runtime.inFlight) return shared.runtime.inFlight;
  shared.runtime.inFlight = (async () => {
    const projectRoot = useProjectStore.getState().rootPath;
    shared.store.setState({ loading: true });
    try {
      const tools = await probeTools();
      if (!tools?.git?.found) {
        shared.store.setState({ ...EMPTY, tools, loading: false, refreshedAt: Date.now() });
        return shared.store.getState();
      }
      if (!projectRoot) {
        shared.store.setState({ ...EMPTY, tools, loading: false, refreshedAt: Date.now() });
        return shared.store.getState();
      }
      const root = await findRepoRoot(projectRoot);
      if (!root) {
        shared.store.setState({ ...EMPTY, tools, root: null, isRepo: false, loading: false, refreshedAt: Date.now() });
        return shared.store.getState();
      }

      const [status, branches, remotes, identity] = await Promise.all([
        readStatus(root),
        readBranches(root),
        readRemotes(root),
        readIdentity(root),
      ]);

      // `gh auth status` shells out to a second binary and hits the network on
      // some paths, so it is not part of the poll — once a minute is plenty for
      // "are you signed in", and every action that could change it refreshes it
      // directly.
      let github = shared.store.getState().github;
      if (!github || Date.now() - shared.runtime.githubCheckedAt > 60_000) {
        github = tools?.gh?.found
          ? await readGithubAuth()
          : { available: false, loggedIn: false, account: null, scopes: [], gitConfigured: false };
        shared.runtime.githubCheckedAt = Date.now();
      }

      shared.store.setState({
        tools,
        root,
        isRepo: true,
        branch: status.branch,
        files: status.files,
        operation: status.operation,
        branches,
        remotes,
        identity,
        github,
        loading: false,
        error: null,
        refreshedAt: Date.now(),
      });
    } catch (error) {
      shared.store.setState({
        loading: false,
        error: String(/** @type {any} */ (error)?.message ?? error),
        refreshedAt: Date.now(),
      });
    } finally {
      shared.runtime.inFlight = null;
    }
    return shared.store.getState();
  })();
  return shared.runtime.inFlight;
}

/** Forces the GitHub sign-in state to be re-read on the next refresh. */
export function invalidateGithubAuth() {
  shared.runtime.githubCheckedAt = 0;
}

function schedule() {
  clearInterval(shared.runtime.timer);
  const period = shared.runtime.viewers > 0 ? POLL_VISIBLE : POLL_BACKGROUND;
  shared.runtime.timer = setInterval(() => {
    // A hidden window is not looking at the panel, and a background editor
    // spawning git processes on a timer is the kind of thing people notice in
    // a battery graph.
    if (typeof document !== "undefined" && document.hidden) return;
    refreshGit();
  }, period);
}

/**
 * Starts watching. Idempotent — called from the menu-bar chip, which mounts
 * once for the life of the editor.
 */
export function startGitWatch() {
  if (!shared.runtime.timer) schedule();
  if (shared.runtime.unlisten) return;
  // Marked as attached before the await so a second synchronous call cannot
  // register a second listener while the first is still resolving.
  shared.runtime.unlisten = () => {};
  import("@tauri-apps/api/event")
    .then(({ listen }) =>
      listen("project-files-changed", () => {
        clearTimeout(shared.runtime.debounce);
        shared.runtime.debounce = setTimeout(refreshGit, EVENT_DEBOUNCE);
      }),
    )
    .then((off) => {
      shared.runtime.unlisten = off;
    })
    .catch(() => {
      // No Tauri (a harness, or the browser): the poll alone carries it.
    });
  refreshGit();
}

/**
 * Registers a visible viewer, which speeds the poll up. Returns the function
 * that unregisters it — the panel calls this from a `useEffect`.
 */
export function addGitViewer() {
  shared.runtime.viewers += 1;
  schedule();
  refreshGit();
  return () => {
    shared.runtime.viewers = Math.max(0, shared.runtime.viewers - 1);
    schedule();
  };
}

/** Test seam: drops all state and stops the timers. */
export function resetGitStore() {
  clearInterval(shared.runtime.timer);
  clearTimeout(shared.runtime.debounce);
  shared.runtime.timer = null;
  shared.runtime.viewers = 0;
  shared.runtime.githubCheckedAt = 0;
  shared.store.setState({ ...EMPTY });
}

/**
 * The one-line summary the menu-bar chip shows.
 *
 * Lives here rather than in the chip so the same wording is available to the
 * `git.status` tool — an agent and the person watching it should describe the
 * repository the same way.
 *
 * @param {ReturnType<typeof useGitStore.getState>} state
 */
export function summarize(state) {
  if (!state.tools?.git?.found) return { label: "git", tone: "off", title: "Git is not installed on this machine." };
  if (!state.isRepo) {
    return { label: "git", tone: "off", title: "This project is not in a git repository. Click to create one." };
  }
  const changed = state.files.length;
  const branch = state.branch.detached ? "detached" : state.branch.head || "?";
  const parts = [`On ${branch}`];
  if (changed) parts.push(`${changed} change${changed === 1 ? "" : "s"}`);
  if (state.branch.ahead) parts.push(`${state.branch.ahead} to push`);
  if (state.branch.behind) parts.push(`${state.branch.behind} to pull`);
  if (state.operation) parts.push(`${state.operation} in progress`);
  return {
    label: branch,
    changed,
    ahead: state.branch.ahead,
    behind: state.branch.behind,
    tone: state.operation ? "warn" : changed ? "dirty" : "clean",
    title: `${parts.join(" · ")}. Click to open Source Control.`,
  };
}
