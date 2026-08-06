import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  FileDiff,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  History,
  Loader2,
  Minus,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
  Undo2,
  UploadCloud,
} from "lucide-react";
import { PopoverMenu } from "../fields/PopoverMenu.jsx";
import { useProjectStore, basename } from "../store/projectStore.js";
import { useSceneStore } from "../store/sceneStore.js";
import { getProjectSettings } from "../projectSettings.js";
import { addGitViewer, refreshGit, invalidateGithubAuth, useGitStore } from "../git/gitStore.js";
import { probeTools, readCommitDiff, readDiff, readLog } from "../git/gitCli.js";
import { githubSlug, webUrlForRemote } from "../git/porcelain.js";
import * as service from "../git/gitService.js";

/**
 * Source Control: the whole git workflow, without leaving the editor.
 *
 * ## Why the layout is two columns and not the Inspector's one
 *
 * Reviewing a change is the part of version control people skip, and they skip
 * it when it costs a click per file. So the changed files and the diff are on
 * screen together — select a file on the left, read it on the right — which is
 * also why this panel docks with the Assets strip rather than the 320px
 * Inspector column. A diff rendered at 320px wraps every line and stops being a
 * diff.
 *
 * ## What this panel refuses to do
 *
 * No force push, no history rewriting, no interactive rebase. Those are the
 * operations whose failure mode is "the work is gone", and they are not what
 * someone building a game came here for. Everything offered is either
 * reversible or asks first — and the one destructive action (Discard) says
 * exactly what it will delete before it does it.
 */
export function GitPanel() {
  const rootPath = useProjectStore((s) => s.rootPath);
  const state = useGitStore();
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  // Registering as a visible viewer speeds the store's poll up while the panel
  // is on screen and slows it back down when it is closed.
  useEffect(() => addGitViewer(), []);
  useEffect(() => {
    refreshGit();
  }, [rootPath]);

  /** Runs an action with a label, surfacing failures in the panel itself
   *  rather than only in the console — a push that failed silently is
   *  indistinguishable from one that worked. */
  const run = useCallback(async (label, action) => {
    setBusy(label);
    setError(null);
    try {
      return await action();
    } catch (err) {
      setError(String(err?.message ?? err));
      return null;
    } finally {
      setBusy(null);
    }
  }, []);

  if (!rootPath) return <div className="inspector-panel empty">Open a project to use version control.</div>;
  if (!state.tools) {
    return (
      <div className="inspector-panel empty">
        <Loader2 size={13} className="spin" /> Looking for git…
      </div>
    );
  }
  if (!state.tools.git?.found) return <NoGitView />;
  if (!state.isRepo) return <SetupView busy={busy} error={error} run={run} />;
  return <RepoView state={state} busy={busy} error={error} setError={setError} run={run} />;
}

/** Opens a URL in the user's real browser, not the editor's webview. */
async function openExternal(url) {
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}

function NoGitView() {
  const [checking, setChecking] = useState(false);
  return (
    <div className="inspector-panel git-panel">
      <div className="git-hero">
        <GitBranch size={22} />
        <h3>Git isn&rsquo;t installed</h3>
        <p>
          Version control needs the git command-line tool. It is a small, free install, and the editor will find it
          automatically afterwards.
        </p>
        <div className="git-hero-actions">
          <button className="toolbar-btn" onClick={() => openExternal("https://git-scm.com/downloads")}>
            <ExternalLink size={12} />
            Get git
          </button>
          <button
            className="toolbar-btn"
            disabled={checking}
            onClick={async () => {
              setChecking(true);
              await probeTools({ refresh: true });
              await refreshGit();
              setChecking(false);
            }}
          >
            {checking ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}
            Check again
          </button>
        </div>
      </div>
    </div>
  );
}

/** The project is not in a repository yet. One button, and an honest list of
 *  what that button is going to do. */
function SetupView({ busy, error, run }) {
  const projectName = useProjectStore((s) => s.projectMeta?.name);
  const rootPath = useProjectStore((s) => s.rootPath);
  const lfsAvailable = useGitStore((s) => !!s.tools?.lfs?.found);
  const [lfs, setLfs] = useState(true);
  const [result, setResult] = useState(null);
  const outDir = getProjectSettings()?.build?.outDir ?? "Build";

  return (
    <div className="inspector-panel git-panel">
      <div className="git-hero">
        <GitBranch size={22} />
        <h3>Track {projectName ?? basename(rootPath)} with git</h3>
        <p>
          A repository keeps every version of this project, so you can look at what changed, go back to a version that
          worked, and publish it. Creating one changes nothing about how the editor behaves.
        </p>
        <ul className="git-hero-list">
          <li>
            Ignores <code>{outDir}/</code> and <code>engine-types/</code> — build output and generated type
            definitions, both rebuilt on demand.
          </li>
          <li>Keeps <code>.meta</code> sidecars: they hold import settings you authored, not derived data.</li>
          <li>
            {lfsAvailable
              ? "Stores models, textures and audio in Git LFS, so the repository stays small."
              : "Git LFS is not installed, so binary assets will be stored directly. Installing it later is possible but means rewriting history."}
          </li>
        </ul>
        <label className="git-check" title="Track binary asset formats with Git LFS from the first commit.">
          <input type="checkbox" checked={lfs && lfsAvailable} disabled={!lfsAvailable} onChange={(e) => setLfs(e.target.checked)} />
          Use Git LFS for binary assets
        </label>
        <div className="git-hero-actions">
          <button
            className="toolbar-btn primary"
            disabled={!!busy}
            onClick={() =>
              run("Creating repository…", async () => {
                const created = await service.initRepository({
                  lfs: lfs && lfsAvailable,
                  commit: true,
                  outDir,
                  projectName: projectName ?? "",
                });
                setResult(created);
                await refreshGit();
              })
            }
          >
            {busy ? <Loader2 size={12} className="spin" /> : <GitBranch size={12} />}
            Create repository
          </button>
        </div>
        {error ? <div className="git-error">{error}</div> : null}
        {result?.notes?.map((note) => (
          <div key={note} className="git-note">
            <AlertTriangle size={11} /> {note}
          </div>
        ))}
      </div>
    </div>
  );
}

function RepoView({ state, busy, error, setError, run }) {
  const [tab, setTab] = useState("diff");
  /** @type {[null | { path: string, staged: boolean, untracked: boolean }, Function]} */
  const [selected, setSelected] = useState(null);
  const [message, setMessage] = useState("");
  const [amend, setAmend] = useState(false);

  const staged = useMemo(() => state.files.filter((file) => file.staged && !file.conflicted), [state.files]);
  const changed = useMemo(() => state.files.filter((file) => !file.staged && !file.conflicted), [state.files]);
  const conflicts = useMemo(() => state.files.filter((file) => file.conflicted), [state.files]);

  // A selection that no longer exists (it was committed, staged, or discarded)
  // must not keep showing a stale diff.
  useEffect(() => {
    if (selected && !state.files.some((file) => file.path === selected.path)) setSelected(null);
  }, [state.files, selected]);

  const act = (label, action) => run(label, async () => {
    const result = await action();
    await refreshGit();
    return result;
  });

  return (
    <div className="inspector-panel git-panel">
      <GitToolbar state={state} busy={busy} act={act} />
      {error ? <div className="git-error">{error}</div> : null}
      {state.operation ? <OperationBanner state={state} conflicts={conflicts} busy={busy} act={act} /> : null}
      {!state.identity.name || !state.identity.email ? <IdentityBanner identity={state.identity} act={act} /> : null}
      <DirtySceneBanner />

      <div className="git-body">
        <div className="git-changes">
          <CommitBox
            message={message}
            setMessage={setMessage}
            amend={amend}
            setAmend={setAmend}
            stagedCount={staged.length}
            busy={busy}
            onCommit={() =>
              act("Committing…", async () => {
                await service.commit({ message, amend });
                setMessage("");
                setAmend(false);
              })
            }
          />
          {conflicts.length ? (
            <FileSection
              title="Conflicts"
              tone="conflict"
              files={conflicts}
              selected={selected}
              onSelect={setSelected}
              actions={(file) => [
                {
                  icon: <Check size={12} />,
                  title: "Mark resolved — stage the file as it now stands on disk",
                  onClick: () => act("Staging…", () => service.stage([file.path])),
                },
              ]}
            />
          ) : null}
          <FileSection
            title="Staged"
            files={staged}
            selected={selected}
            onSelect={(file) => setSelected({ path: file.path, staged: true, untracked: false })}
            headerAction={
              staged.length
                ? {
                    icon: <Minus size={12} />,
                    title: "Unstage everything",
                    onClick: () => act("Unstaging…", () => service.unstage([])),
                  }
                : null
            }
            actions={(file) => [
              {
                icon: <Minus size={12} />,
                title: "Unstage",
                onClick: () => act("Unstaging…", () => service.unstage([file.path])),
              },
            ]}
          />
          <FileSection
            title="Changes"
            files={changed}
            selected={selected}
            onSelect={(file) => setSelected({ path: file.path, staged: false, untracked: file.untracked })}
            headerAction={
              changed.length
                ? {
                    icon: <Plus size={12} />,
                    title: "Stage everything, including new files",
                    onClick: () => act("Staging…", () => service.stage([])),
                  }
                : null
            }
            actions={(file) => [
              {
                icon: <Plus size={12} />,
                title: "Stage",
                onClick: () => act("Staging…", () => service.stage([file.path])),
              },
              {
                icon: file.untracked ? <Trash2 size={12} /> : <Undo2 size={12} />,
                title: file.untracked
                  ? "Delete this file — it is not in any commit, so this cannot be undone"
                  : "Discard these changes and go back to the committed version",
                confirm: file.untracked ? "Delete?" : "Discard?",
                danger: true,
                onClick: () => act("Discarding…", () => service.discard([file.path])),
              },
            ]}
          />
          {!state.files.length ? (
            <div className="git-empty">
              <Check size={14} />
              Nothing has changed since the last commit.
            </div>
          ) : null}
          <GithubSection state={state} busy={busy} act={act} setError={setError} />
        </div>

        <div className="git-detail">
          <div className="git-tabs">
            <button className={`git-tab ${tab === "diff" ? "active" : ""}`} onClick={() => setTab("diff")}>
              <FileDiff size={12} /> Changes
            </button>
            <button className={`git-tab ${tab === "history" ? "active" : ""}`} onClick={() => setTab("history")}>
              <History size={12} /> History
            </button>
            {busy ? (
              <span className="git-busy">
                <Loader2 size={11} className="spin" /> {busy}
              </span>
            ) : null}
          </div>
          {tab === "diff" ? (
            <DiffPane root={state.root} selected={selected} refreshedAt={state.refreshedAt} />
          ) : (
            <HistoryPane root={state.root} refreshedAt={state.refreshedAt} />
          )}
        </div>
      </div>
    </div>
  );
}

function GitToolbar({ state, busy, act }) {
  const branchRef = useRef(null);
  const [menu, setMenu] = useState(false);
  const { ahead, behind, upstream, head, detached } = state.branch;
  const hasRemote = state.remotes.length > 0;

  return (
    <div className="panel-toolbar git-toolbar">
      <button ref={branchRef} className="toolbar-btn git-branch-btn" onClick={() => setMenu(!menu)} title="Switch or create a branch">
        <GitBranch size={13} />
        {detached ? "detached HEAD" : head || "no commits yet"}
        <ChevronDown size={11} />
      </button>
      {menu ? <BranchMenu anchorRef={branchRef} state={state} act={act} onClose={() => setMenu(false)} /> : null}

      <button
        className="toolbar-btn"
        disabled={!!busy || !hasRemote}
        title={hasRemote ? "Check the remote for new commits. Changes nothing on disk." : "No remote is configured yet."}
        onClick={() => act("Fetching…", () => service.fetch({}))}
      >
        <RefreshCw size={12} />
        Fetch
      </button>
      <button
        className="toolbar-btn"
        disabled={!!busy || !hasRemote || !upstream}
        title={upstream ? `Pull from ${upstream}` : "This branch has no upstream yet — push it first."}
        onClick={() => act("Pulling…", () => service.pull({}))}
      >
        <ArrowDown size={12} />
        Pull{behind ? ` ${behind}` : ""}
      </button>
      <button
        className="toolbar-btn"
        disabled={!!busy || !hasRemote}
        title={upstream ? `Push to ${upstream}` : "Push this branch and start tracking it on the remote."}
        onClick={() => act("Pushing…", () => service.push({}))}
      >
        <ArrowUp size={12} />
        Push{ahead ? ` ${ahead}` : ""}
      </button>
      <div className="menu-spacer" />
      <button
        className="toolbar-btn icon-only"
        title="Re-read the repository"
        disabled={state.loading}
        onClick={() => refreshGit()}
      >
        {state.loading ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}
      </button>
    </div>
  );
}

function BranchMenu({ anchorRef, state, act, onClose }) {
  const [creating, setCreating] = useState("");
  const local = state.branches.filter((branch) => !branch.remote);
  const remote = state.branches.filter((branch) => branch.remote);

  const switchTo = (name, create = false) => {
    onClose();
    act(`Switching to ${name}…`, () => service.checkout(name, { create }));
  };

  return (
    <PopoverMenu anchorRef={anchorRef} onClose={onClose} minWidth={240} className="git-branch-menu">
      <div className="git-menu-section">Branches</div>
      {local.map((branch) => (
        <button key={branch.ref} className="dropdown-item" onClick={() => switchTo(branch.name)}>
          <span>{branch.name}</span>
          <span className="git-menu-note">{branch.current ? "current" : branch.when}</span>
        </button>
      ))}
      {remote.length ? <div className="git-menu-section">On the remote</div> : null}
      {remote.map((branch) => {
        // Checking out `origin/x` detaches HEAD; what the user means is "make a
        // local branch that follows it", which is what `checkout <shortname>`
        // does when only one remote has it.
        const short = branch.name.split("/").slice(1).join("/");
        const exists = local.some((entry) => entry.name === short);
        return (
          <button key={branch.ref} className="dropdown-item" disabled={exists} onClick={() => switchTo(short)}>
            <span>{branch.name}</span>
            <span className="git-menu-note">{exists ? "already local" : "check out"}</span>
          </button>
        );
      })}
      <div className="git-menu-section">New branch</div>
      <form
        className="git-menu-form"
        onSubmit={(event) => {
          event.preventDefault();
          const name = creating.trim();
          if (name) switchTo(name, true);
        }}
      >
        <input
          className="text-field"
          value={creating}
          placeholder="feature/lighting"
          autoFocus
          onChange={(event) => setCreating(event.target.value)}
        />
        <button className="toolbar-btn" type="submit" disabled={!creating.trim()}>
          Create
        </button>
      </form>
    </PopoverMenu>
  );
}

/** A merge (or pull, or cherry-pick) that stopped. The most confusing state a
 *  repository can be in, so it gets a banner that names it and offers the exit. */
function OperationBanner({ state, conflicts, busy, act }) {
  return (
    <div className="git-banner warn">
      <GitMerge size={13} />
      <div>
        <strong>A {state.operation} is in progress.</strong>{" "}
        {conflicts.length
          ? `${conflicts.length} file${conflicts.length === 1 ? "" : "s"} need a decision: open each one, keep the lines you want, then mark it resolved and commit.`
          : "Everything is resolved — commit to finish it."}
      </div>
      <button
        className="toolbar-btn"
        disabled={!!busy}
        title="Undo the whole operation and put the working tree back as it was"
        onClick={() => act("Aborting…", () => service.abortMerge())}
      >
        <RotateCcw size={12} />
        Abort
      </button>
    </div>
  );
}

/** Commits are signed with a name and email git does not have yet. Shown as a
 *  form rather than an error, because the error only appears at the moment the
 *  user tries to commit — which is the worst time to learn about it. */
function IdentityBanner({ identity, act }) {
  const [name, setName] = useState(identity.name);
  const [email, setEmail] = useState(identity.email);
  return (
    <form
      className="git-banner"
      onSubmit={(event) => {
        event.preventDefault();
        act("Saving identity…", () => service.setIdentity({ name, email, global: true }));
      }}
    >
      <div>
        <strong>Who is committing?</strong> Git stamps a name and email onto every commit.
      </div>
      <input className="text-field" value={name} placeholder="Your name" onChange={(e) => setName(e.target.value)} />
      <input className="text-field" value={email} placeholder="you@example.com" onChange={(e) => setEmail(e.target.value)} />
      <button className="toolbar-btn" type="submit" disabled={!name.trim() || !email.trim()}>
        Save
      </button>
    </form>
  );
}

/** The open scene has edits that are not on disk, so they are not in anything
 *  git can see. Worth saying before someone commits and believes they are safe. */
function DirtySceneBanner() {
  const dirty = useSceneStore((s) => s.dirty);
  const sceneName = useSceneStore((s) => s.sceneName);
  if (!dirty) return null;
  return (
    <div className="git-banner">
      <AlertTriangle size={13} />
      <div>
        <strong>{sceneName} has unsaved edits.</strong> They are only in memory — save the scene (Ctrl+S) before
        committing, or they will not be part of it.
      </div>
    </div>
  );
}

function CommitBox({ message, setMessage, amend, setAmend, stagedCount, busy, onCommit }) {
  return (
    <div className="git-commit-box">
      <textarea
        className="text-field git-commit-message"
        value={message}
        rows={3}
        placeholder={stagedCount ? `Message for ${stagedCount} staged file${stagedCount === 1 ? "" : "s"}…` : "Stage a file, then describe the change…"}
        onChange={(event) => setMessage(event.target.value)}
        onKeyDown={(event) => {
          // Ctrl+Enter commits, the convention every git client shares.
          if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && message.trim()) onCommit();
        }}
      />
      <div className="git-commit-row">
        <label className="git-check" title="Replace the previous commit instead of adding one. Do not use on a commit that is already pushed.">
          <input type="checkbox" checked={amend} onChange={(event) => setAmend(event.target.checked)} />
          Amend
        </label>
        <button
          className="toolbar-btn primary"
          disabled={!!busy || (!message.trim() && !amend) || (!stagedCount && !amend)}
          title="Ctrl+Enter"
          onClick={onCommit}
        >
          <GitCommitHorizontal size={12} />
          Commit{stagedCount ? ` ${stagedCount}` : ""}
        </button>
      </div>
    </div>
  );
}

const KIND_LETTER = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  copied: "C",
  typechange: "T",
  untracked: "?",
  conflicted: "!",
};

function FileSection({ title, files, selected, onSelect, actions, headerAction, tone = "" }) {
  if (!files.length) return null;
  return (
    <div className={`git-section ${tone}`}>
      <div className="git-section-head">
        <span>
          {title} <span className="git-count">{files.length}</span>
        </span>
        {headerAction ? (
          <button className="toolbar-btn icon-only tiny" title={headerAction.title} onClick={headerAction.onClick}>
            {headerAction.icon}
          </button>
        ) : null}
      </div>
      {files.map((file) => (
        <FileRow
          key={`${title}:${file.path}`}
          file={file}
          active={selected?.path === file.path}
          onSelect={() => onSelect(file)}
          actions={actions(file)}
        />
      ))}
    </div>
  );
}

function FileRow({ file, active, onSelect, actions }) {
  // Two-step confirmation in place, rather than a modal: a dialog for "discard
  // one file" is heavier than the action, and an undoable-looking button for a
  // destructive one is worse.
  const [confirming, setConfirming] = useState(null);
  useEffect(() => {
    if (!confirming) return undefined;
    const timer = setTimeout(() => setConfirming(null), 3000);
    return () => clearTimeout(timer);
  }, [confirming]);

  const folder = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
  const name = file.path.slice(file.path.lastIndexOf("/") + 1);
  return (
    <div className={`git-file ${active ? "active" : ""} ${file.kind}`} onClick={onSelect} title={file.orig ? `${file.orig} → ${file.path}` : file.path}>
      <span className={`git-letter ${file.kind}`}>{KIND_LETTER[file.kind] ?? "M"}</span>
      <span className="git-file-name">{name}</span>
      {folder ? <span className="git-file-folder">{folder}</span> : null}
      <span className="git-file-actions">
        {actions.map((action, index) =>
          action.confirm && confirming !== index ? (
            <button
              key={index}
              className={`toolbar-btn icon-only tiny ${action.danger ? "danger" : ""}`}
              title={action.title}
              onClick={(event) => {
                event.stopPropagation();
                setConfirming(index);
              }}
            >
              {action.icon}
            </button>
          ) : action.confirm ? (
            <button
              key={index}
              className="toolbar-btn tiny danger"
              onClick={(event) => {
                event.stopPropagation();
                setConfirming(null);
                action.onClick();
              }}
            >
              {action.confirm}
            </button>
          ) : (
            <button
              key={index}
              className="toolbar-btn icon-only tiny"
              title={action.title}
              onClick={(event) => {
                event.stopPropagation();
                action.onClick();
              }}
            >
              {action.icon}
            </button>
          ),
        )}
      </span>
    </div>
  );
}

/** Renders one file's patch, or the empty state that explains what to click. */
function DiffPane({ root, selected, refreshedAt }) {
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!selected || !root) {
      setFiles([]);
      return undefined;
    }
    setLoading(true);
    readDiff(root, { path: selected.path, staged: selected.staged, untracked: selected.untracked })
      .then((result) => {
        if (!cancelled) setFiles(result);
      })
      .catch(() => {
        if (!cancelled) setFiles([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [root, selected?.path, selected?.staged, selected?.untracked, refreshedAt]);

  if (!selected) {
    return (
      <div className="git-detail-empty">
        <FileDiff size={16} />
        Select a file to see what changed in it.
      </div>
    );
  }
  if (loading && !files.length) {
    return (
      <div className="git-detail-empty">
        <Loader2 size={14} className="spin" /> Reading the diff…
      </div>
    );
  }
  return <DiffBody files={files} />;
}

function DiffBody({ files }) {
  if (!files.length) {
    return <div className="git-detail-empty">No textual difference — the file's contents are identical.</div>;
  }
  return (
    <div className="git-diff">
      {files.map((file) => (
        <div key={file.path} className="git-diff-file">
          <div className="git-diff-head">
            <span>{file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}</span>
            {file.binary ? null : (
              <span className="git-diff-stat">
                <span className="add">+{file.additions}</span> <span className="del">−{file.deletions}</span>
              </span>
            )}
          </div>
          {file.binary ? (
            // A texture diff is a wall of base64 nobody reads. Saying so beats
            // rendering it, and the Assets panel already shows the image.
            <div className="git-diff-binary">Binary file — changed, but there is nothing readable to show.</div>
          ) : (
            file.hunks.map((hunk, index) => (
              <div key={index} className="git-hunk">
                {hunk.header ? <div className="git-hunk-head">{hunk.header}</div> : null}
                {hunk.lines.map((line, lineIndex) => (
                  <div key={lineIndex} className={`git-line ${line.kind}`}>
                    <span className="git-gutter">{line.oldNo ?? ""}</span>
                    <span className="git-gutter">{line.newNo ?? ""}</span>
                    <span className="git-sign">{line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}</span>
                    <span className="git-code">{line.text}</span>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      ))}
    </div>
  );
}

function HistoryPane({ root, refreshedAt }) {
  const [commits, setCommits] = useState([]);
  const [open, setOpen] = useState(null);
  const [patch, setPatch] = useState([]);

  useEffect(() => {
    let cancelled = false;
    if (!root) return undefined;
    readLog(root, { limit: 60 })
      .then((result) => {
        if (!cancelled) setCommits(result);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [root, refreshedAt]);

  const select = async (commit) => {
    setOpen(commit.sha);
    setPatch([]);
    try {
      setPatch(await readCommitDiff(root, commit.sha));
    } catch {
      setPatch([]);
    }
  };

  if (!commits.length) {
    return <div className="git-detail-empty">No commits yet. Stage some files and make the first one.</div>;
  }
  return (
    <div className="git-history">
      {commits.map((commit) => (
        <div key={commit.sha} className="git-commit">
          <button className={`git-commit-row-btn ${open === commit.sha ? "active" : ""}`} onClick={() => select(commit)}>
            <span className="git-sha">{commit.short}</span>
            <span className="git-subject">{commit.subject}</span>
            {commit.refs.map((ref) => (
              <span key={ref} className="git-ref">
                {ref}
              </span>
            ))}
            <span className="git-when">
              {commit.author} · {new Date(commit.date).toLocaleString()}
            </span>
          </button>
          {open === commit.sha ? <DiffBody files={patch} /> : null}
        </div>
      ))}
    </div>
  );
}

/**
 * The GitHub half: sign in, create the repository, and from then on a link.
 *
 * It lives at the bottom of the changes column rather than in a panel of its
 * own because it is a three-step path that each project walks exactly once —
 * afterwards this is one line saying where the project lives.
 */
function GithubSection({ state, busy, act, setError }) {
  const [code, setCode] = useState(null);
  const [copied, setCopied] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [isPrivate, setPrivate] = useState(true);
  const projectName = useProjectStore((s) => s.projectMeta?.name);

  const origin = state.remotes.find((remote) => remote.name === "origin") ?? state.remotes[0] ?? null;
  const slug = origin ? githubSlug(origin.url) : null;
  const gh = state.tools?.gh;

  if (origin) {
    const web = webUrlForRemote(origin.url);
    return (
      <div className="git-github">
        <span className="git-github-label">{slug ? "GitHub" : origin.name}</span>
        {web ? (
          <button className="git-link" title={origin.url} onClick={() => openExternal(web)}>
            {slug ?? origin.url}
            <ExternalLink size={11} />
          </button>
        ) : (
          <span className="git-github-url" title={origin.url}>
            {origin.url}
          </span>
        )}
      </div>
    );
  }

  if (!gh?.found) {
    return (
      <div className="git-github">
        <span className="git-github-label">GitHub</span>
        <button className="git-link" onClick={() => openExternal("https://cli.github.com")}>
          Install the GitHub CLI to publish from here
          <ExternalLink size={11} />
        </button>
      </div>
    );
  }

  if (!state.github?.loggedIn) {
    return (
      <div className="git-github column">
        <div className="git-github-row">
          <span className="git-github-label">GitHub</span>
          <button
            className="toolbar-btn"
            disabled={!!busy}
            onClick={() =>
              act("Waiting for GitHub…", async () => {
                setCode(null);
                try {
                  await service.githubLogin((info) => setCode(info));
                } finally {
                  invalidateGithubAuth();
                }
              })
            }
          >
            <UploadCloud size={12} />
            Sign in
          </button>
        </div>
        {code ? (
          // The device flow: gh has opened the browser, and this code is the
          // only thing the user has to carry across to it.
          <div className="git-auth-code">
            <span>Enter this code on github.com:</span>
            <code>{code.code}</code>
            <button
              className="toolbar-btn icon-only tiny"
              title={copied ? "Copied" : "Copy the code"}
              onClick={() => {
                navigator.clipboard?.writeText(code.code).catch(() => {});
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? <Check size={11} /> : <Copy size={11} />}
            </button>
            <button className="toolbar-btn tiny" onClick={() => openExternal(code.url)}>
              Open page
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  if (!creating) {
    return (
      <div className="git-github">
        <span className="git-github-label">GitHub</span>
        <span className="git-github-url">signed in as {state.github.account}</span>
        <button
          className="toolbar-btn"
          disabled={!!busy}
          onClick={() => {
            setName((projectName ?? "game").replace(/[^\w.-]+/g, "-"));
            setCreating(true);
          }}
        >
          <UploadCloud size={12} />
          Publish to GitHub
        </button>
      </div>
    );
  }

  return (
    <form
      className="git-github column"
      onSubmit={(event) => {
        event.preventDefault();
        act("Creating the repository…", async () => {
          const created = await service.githubCreateRepo({ name, private: isPrivate });
          setCreating(false);
          if (!created?.url) setError("The repository was created, but GitHub did not report its URL.");
        });
      }}
    >
      <div className="git-github-row">
        <span className="git-github-label">New repository</span>
        <input className="text-field" value={name} onChange={(event) => setName(event.target.value)} autoFocus />
      </div>
      <div className="git-github-row">
        <label className="git-check" title="A game project usually contains assets whose licences do not allow redistribution.">
          <input type="checkbox" checked={isPrivate} onChange={(event) => setPrivate(event.target.checked)} />
          Private
        </label>
        <button className="toolbar-btn" type="button" onClick={() => setCreating(false)}>
          Cancel
        </button>
        <button className="toolbar-btn primary" type="submit" disabled={!name.trim() || !!busy}>
          Create &amp; push
        </button>
      </div>
    </form>
  );
}
