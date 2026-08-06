//! Git and GitHub, driven from inside the editor.
//!
//! ## Why the `git` CLI and not libgit2
//!
//! libgit2 (via `git2`) would remove the "git must be installed" requirement,
//! and that is the only thing it would do better. Everything a game project
//! actually needs from version control lives *outside* the plumbing libgit2
//! implements: credentials (Git Credential Manager, the Windows keychain,
//! `gh`'s helper — all of which are `credential.helper` programs the CLI knows
//! how to run and a library does not), Git LFS (a filter driver, i.e. a
//! subprocess), hooks, and `.gitignore`/`.gitattributes` semantics that stay in
//! step with whatever git the user's other tools use. Reimplementing auth alone
//! would be more code than this whole module, and it would be the part that
//! fails on someone else's machine.
//!
//! ## Why this stays a thin exec layer
//!
//! No porcelain is parsed here. The parsers live in `src/editor/git/porcelain.js`
//! where they can be tested against recorded output by `npm run test:git` in two
//! seconds, instead of behind a `cargo test` that needs a real repository on
//! disk to say anything. Rust owns exactly the three things it must: finding the
//! binaries, refusing to run anything but git, and never blocking forever.
//!
//! ## The two failure modes this file exists to prevent
//!
//! 1. **A prompt nobody can answer.** A push to an https remote with no
//!    credential helper asks for a username on the terminal — and there is no
//!    terminal here (the child is spawned with `CREATE_NO_WINDOW` and a null
//!    stdin), so the call would simply never return. `GIT_TERMINAL_PROMPT=0`
//!    turns that into an immediate, reportable error. A *GUI* helper still pops
//!    up normally, which is the flow we want on Windows.
//! 2. **Arbitrary execution through an argument.** These commands are reachable
//!    from the MCP server, so the argument vector can come from a model. `git`
//!    has several options that run a program of the caller's choosing
//!    (`-c core.sshCommand=…`, `--upload-pack`, `--exec-path`), so the
//!    subcommand is allowlisted and those options are rejected outright.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};

use crate::share::command;

/// Subcommands the editor is allowed to run.
///
/// An allowlist rather than a denylist because the interesting question is
/// "what does the Git panel do", and the answer is a closed set. Notably absent:
/// `credential` (prints stored secrets to stdout), `daemon` (opens a server),
/// and `filter-branch` (rewrites history in a way no button offers).
const GIT_SUBCOMMANDS: &[&str] = &[
    "add", "apply", "blame", "branch", "cat-file", "check-ignore", "checkout", "cherry-pick",
    "clean", "clone", "commit", "config", "describe", "diff", "fetch", "for-each-ref", "init",
    "lfs", "log", "ls-files", "ls-remote", "merge", "mv", "pull", "push", "rebase", "remote",
    "reset", "restore", "rev-list", "rev-parse", "revert", "rm", "shortlog", "show", "stash",
    "status", "switch", "symbolic-ref", "tag", "version",
];

/// `gh` subcommands. `api` is included deliberately — it is how the editor asks
/// GitHub anything the typed commands do not cover (repository visibility, the
/// signed-in user) without this module growing a REST client of its own.
const GH_SUBCOMMANDS: &[&str] = &[
    "api", "auth", "browse", "issue", "pr", "release", "repo", "status", "version", "--version",
];

/// Options that make git run a program the caller names. Rejected before the
/// subcommand is even looked at, because every one of them turns "run git" into
/// "run anything".
const FORBIDDEN_PREFIXES: &[&str] = &[
    "-c",
    "--config-env",
    "--exec-path",
    "--upload-pack",
    "--receive-pack",
    "--exec",
    "-C",
    "--git-dir",
    "--work-tree",
    "--namespace",
];

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecOutcome {
    /// The process exited 0. Kept as a field rather than left to the caller
    /// because "exit code 1" means different things to different git
    /// subcommands (`diff --quiet` uses it for "there are changes").
    pub ok: bool,
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolInfo {
    pub found: bool,
    pub version: String,
    pub path: String,
}

impl ToolInfo {
    fn missing() -> Self {
        Self {
            found: false,
            version: String::new(),
            path: String::new(),
        }
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitProbe {
    pub git: ToolInfo,
    pub lfs: ToolInfo,
    pub gh: ToolInfo,
}

fn home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

/// Finds an executable on PATH, then in the places its installer actually puts
/// it.
///
/// The fallback list is not paranoia: a GUI application launched from Explorer
/// or the Dock inherits the *system* environment, not the shell's, so a `git`
/// installed by winget/scoop/Homebrew after the user last logged in — or a
/// PATH edited in a still-open terminal — is invisible to `std::env::var("PATH")`.
/// `mcp_clients::resolve_cli` learned the same lesson about the Claude and
/// Codex CLIs.
fn resolve(name: &str, extra: &[PathBuf]) -> Option<PathBuf> {
    let candidates: Vec<String> = if cfg!(windows) {
        vec![format!("{name}.exe"), format!("{name}.cmd"), name.to_string()]
    } else {
        vec![name.to_string()]
    };

    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            for exe in &candidates {
                let candidate = dir.join(exe);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    for dir in extra {
        for exe in &candidates {
            let candidate = dir.join(exe);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn git_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if cfg!(windows) {
        dirs.push(PathBuf::from(r"C:\Program Files\Git\cmd"));
        dirs.push(PathBuf::from(r"C:\Program Files (x86)\Git\cmd"));
        if let Some(home) = home() {
            dirs.push(home.join("AppData/Local/Programs/Git/cmd"));
            dirs.push(home.join("scoop/shims"));
        }
    } else {
        dirs.push(PathBuf::from("/usr/bin"));
        dirs.push(PathBuf::from("/usr/local/bin"));
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
    }
    dirs
}

fn gh_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if cfg!(windows) {
        dirs.push(PathBuf::from(r"C:\Program Files\GitHub CLI"));
        dirs.push(PathBuf::from(r"C:\Program Files (x86)\GitHub CLI"));
        if let Some(home) = home() {
            dirs.push(home.join("AppData/Local/GitHubCLI/bin"));
            dirs.push(home.join("scoop/shims"));
        }
    } else {
        dirs.push(PathBuf::from("/usr/local/bin"));
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
        dirs.push(PathBuf::from("/usr/bin"));
    }
    dirs
}

fn find_git() -> Option<PathBuf> {
    resolve("git", &git_dirs())
}

fn find_gh() -> Option<PathBuf> {
    resolve("gh", &gh_dirs())
}

/// Whether an argument vector is safe to hand to a binary.
///
/// Returns the reason it is not, so the error the user sees names the offending
/// argument instead of saying "denied".
pub fn check_args(args: &[String], allowed: &[&str]) -> Result<(), String> {
    let Some(sub) = args.first() else {
        return Err("No subcommand given.".into());
    };
    for arg in args {
        if arg.contains('\0') {
            return Err("Arguments may not contain null bytes.".into());
        }
        for bad in FORBIDDEN_PREFIXES {
            // Short options attach their value (`-cfoo=bar`, `-C/tmp` are both
            // valid git), so for those any argument starting with the flag is
            // refused. Long options only take a separate or `=`-joined value,
            // and matching them by prefix would refuse `--configured-thing`.
            // Note `--cached` does NOT start with `-c`: the second character is
            // a dash, not a `c`.
            let hit = if bad.len() == 2 && !bad.starts_with("--") {
                arg.starts_with(bad)
            } else {
                *arg == *bad || arg.starts_with(&format!("{bad}="))
            };
            if hit {
                return Err(format!(
                    "\"{arg}\" is not allowed — it can make git run another program."
                ));
            }
        }
    }
    if !allowed.contains(&sub.as_str()) {
        return Err(format!(
            "\"{sub}\" is not one of the subcommands the editor runs. Allowed: {}.",
            allowed.join(", ")
        ));
    }
    Ok(())
}

fn drain<R: Read + Send + 'static>(pipe: Option<R>) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(mut pipe) = pipe {
            let _ = pipe.read_to_end(&mut bytes);
        }
        // Lossy on purpose. Paths and messages are UTF-8 in practice
        // (`core.quotepath=false` keeps git from octal-escaping them), and a
        // repository with one Latin-1 filename in it should still produce a
        // usable status rather than an error.
        String::from_utf8_lossy(&bytes).into_owned()
    })
}

/// Runs a child to completion with a hard cap, returning its exit code and both
/// streams. Never returns `Err` for "the command failed" — only for "the
/// command could not be run at all", so callers can tell a git error from a
/// missing git.
fn run(
    bin: &Path,
    dir: Option<&str>,
    args: &[String],
    stdin_text: Option<String>,
    timeout: Duration,
    env: &HashMap<&str, &str>,
) -> Result<ExecOutcome, String> {
    let mut cmd = command(bin);
    if let Some(dir) = dir.filter(|d| !d.is_empty()) {
        if !Path::new(dir).is_dir() {
            return Err(format!("{dir} is not a folder."));
        }
        cmd.current_dir(dir);
    }
    cmd.args(args);
    for (key, value) in env {
        cmd.env(key, value);
    }
    cmd.stdin(if stdin_text.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    })
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Could not run {}: {e}", bin.display()))?;

    if let Some(text) = stdin_text {
        // On its own thread: a large write to a child that is not reading yet
        // would block us before we ever start draining its output.
        if let Some(mut pipe) = child.stdin.take() {
            std::thread::spawn(move || {
                let _ = pipe.write_all(text.as_bytes());
                // Dropping closes the pipe, which is what tells `gh auth login
                // --with-token` that the token has ended.
            });
        }
    }
    let stdout = drain(child.stdout.take());
    let stderr = drain(child.stderr.take());

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "git {} timed out after {}s.",
                        args.first().cloned().unwrap_or_default(),
                        timeout.as_secs()
                    ));
                }
                std::thread::sleep(Duration::from_millis(30));
            }
            Err(error) => return Err(format!("Waiting for git failed: {error}")),
        }
    };

    Ok(ExecOutcome {
        ok: status.success(),
        code: status.code().unwrap_or(-1),
        stdout: stdout.join().unwrap_or_default(),
        stderr: stderr.join().unwrap_or_default(),
    })
}

/// The environment every git invocation gets.
fn git_env() -> HashMap<&'static str, &'static str> {
    HashMap::from([
        // See the module header: without this a missing credential helper hangs
        // the editor instead of failing.
        ("GIT_TERMINAL_PROMPT", "0"),
        // Porcelain formats are locale-independent, but error text is not, and
        // the editor matches a few known messages ("would be overwritten by
        // checkout") to explain them.
        ("LC_ALL", "C"),
        ("LANG", "C"),
    ])
}

/// Arguments prepended to every git call.
///
/// `--no-pager` because a pager on a piped stdout is a hang waiting to happen;
/// `color.ui=false` because escape codes would land in the parsers; and
/// `core.quotepath=false` because otherwise every non-ASCII filename comes back
/// octal-escaped and no longer matches the path the editor holds.
fn git_prefix() -> Vec<String> {
    [
        "--no-pager",
        "-c",
        "color.ui=false",
        "-c",
        "core.quotepath=false",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

fn version_of(bin: &Path, args: &[&str]) -> String {
    let owned: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    match run(
        bin,
        None,
        &owned,
        None,
        Duration::from_secs(20),
        &HashMap::new(),
    ) {
        Ok(out) if out.ok => out.stdout.lines().next().unwrap_or("").trim().to_string(),
        _ => String::new(),
    }
}

/// What version control is available on this machine.
///
/// Called before the Git panel renders anything, so it can say "install git"
/// rather than showing an empty repository. LFS and `gh` are probed at the same
/// time because both change what the panel offers, and three probes in one
/// round trip beats three states arriving separately.
#[tauri::command]
pub async fn git_probe() -> Result<GitProbe, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let git = match find_git() {
            Some(path) => ToolInfo {
                found: true,
                version: version_of(&path, &["--version"]),
                path: path.to_string_lossy().into_owned(),
            },
            None => ToolInfo::missing(),
        };
        // git-lfs is reached through git itself (`git lfs version`): it installs
        // as a git subcommand, and on Windows it frequently is not a standalone
        // entry on PATH.
        let lfs = match find_git() {
            Some(ref path) if git.found => {
                let version = version_of(path, &["lfs", "version"]);
                ToolInfo {
                    found: !version.is_empty(),
                    version,
                    path: String::new(),
                }
            }
            _ => ToolInfo::missing(),
        };
        let gh = match find_gh() {
            Some(path) => ToolInfo {
                found: true,
                version: version_of(&path, &["--version"]),
                path: path.to_string_lossy().into_owned(),
            },
            None => ToolInfo::missing(),
        };
        Ok(GitProbe { git, lfs, gh })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Runs one git command in `dir`.
///
/// The editor's entire git surface goes through here — there is no second path
/// that skips the allowlist.
#[tauri::command]
pub async fn git_exec(
    dir: String,
    args: Vec<String>,
    stdin: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<ExecOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        check_args(&args, GIT_SUBCOMMANDS)?;
        let bin = find_git().ok_or_else(|| {
            "Git is not installed, or not on this machine's PATH. Install it from git-scm.com and reopen the editor."
                .to_string()
        })?;
        let mut full = git_prefix();
        full.extend(args);
        run(
            &bin,
            Some(&dir),
            &full,
            stdin,
            Duration::from_millis(timeout_ms.unwrap_or(60_000)),
            &git_env(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Runs one GitHub CLI command. `dir` matters for the repository-scoped ones
/// (`gh repo create --source=.`), and is optional for the rest.
#[tauri::command]
pub async fn gh_exec(
    dir: Option<String>,
    args: Vec<String>,
    stdin: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<ExecOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        check_args(&args, GH_SUBCOMMANDS)?;
        let bin = find_gh().ok_or_else(|| {
            "The GitHub CLI (gh) is not installed. Get it from cli.github.com — it is what signs the editor in to GitHub and creates the repository."
                .to_string()
        })?;
        run(
            &bin,
            dir.as_deref(),
            &args,
            stdin,
            Duration::from_millis(timeout_ms.unwrap_or(120_000)),
            &HashMap::from([("GH_PROMPT_DISABLED", "1"), ("NO_COLOR", "1")]),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The one-time code `gh auth login --web` prints, if this line carries it.
///
/// Extracted rather than shown as raw output because the code is the one thing
/// the user must copy, and it arrives in a line of prose surrounded by an
/// unrelated URL. Verified against gh 2.70: the line reads
/// `! First copy your one-time code: 149C-4F54`.
pub fn one_time_code(line: &str) -> Option<String> {
    let (_, rest) = line.split_once("one-time code:")?;
    let code = rest.trim();
    let code = code.split_whitespace().next()?;
    if code.len() >= 4 && code.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        Some(code.to_string())
    } else {
        None
    }
}

/// Signs in to GitHub with the browser device flow.
///
/// This is the only command here that streams instead of returning output at
/// the end, and it has to: gh prints a one-time code the user must type into
/// the page it opens, and then blocks for as long as they take. A batch
/// invocation would show them the code once the login had already timed out.
///
/// Verified in a non-interactive process (gh 2.70): `--web` does not wait on
/// stdin, it prints the code and polls, so no terminal is needed — which is why
/// this does not have to go through the PTY the Terminal panel uses.
#[tauri::command]
pub async fn github_login(app: AppHandle) -> Result<ExecOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bin = find_gh().ok_or_else(|| {
            "The GitHub CLI (gh) is not installed. Get it from cli.github.com.".to_string()
        })?;
        let mut cmd = command(&bin);
        cmd.args([
            "auth",
            "login",
            "--web",
            "--hostname",
            "github.com",
            "--git-protocol",
            "https",
        ])
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| format!("Could not run gh: {e}"))?;

        // Both streams are scanned: gh writes the code to stderr today, and
        // which stream a CLI uses for human-facing text is not something to
        // depend on across versions.
        let mut readers = Vec::new();
        for pipe in [
            child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>),
            child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>),
        ]
        .into_iter()
        .flatten()
        {
            let emitter = app.clone();
            readers.push(std::thread::spawn(move || {
                let mut collected = String::new();
                for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                    if let Some(code) = one_time_code(&line) {
                        let _ = emitter.emit(
                            "github-auth-code",
                            serde_json::json!({
                                "code": code,
                                "url": "https://github.com/login/device",
                            }),
                        );
                    }
                    collected.push_str(&line);
                    collected.push('\n');
                }
                collected
            }));
        }

        // Long, because the timer is a person finding their password manager.
        let deadline = Instant::now() + Duration::from_secs(600);
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) => {
                    if Instant::now() >= deadline {
                        let _ = child.kill();
                        let _ = child.wait();
                        return Err("The GitHub sign-in timed out.".into());
                    }
                    std::thread::sleep(Duration::from_millis(120));
                }
                Err(error) => return Err(format!("Waiting for gh failed: {error}")),
            }
        };
        let output: String = readers
            .into_iter()
            .filter_map(|handle| handle.join().ok())
            .collect::<Vec<_>>()
            .join("");

        Ok(ExecOutcome {
            ok: status.success(),
            code: status.code().unwrap_or(-1),
            stdout: output,
            stderr: String::new(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::{check_args, one_time_code, GH_SUBCOMMANDS, GIT_SUBCOMMANDS};

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn ordinary_commands_are_allowed() {
        assert!(check_args(&args(&["status", "--porcelain=v2"]), GIT_SUBCOMMANDS).is_ok());
        assert!(check_args(&args(&["commit", "-m", "a -c b"]), GIT_SUBCOMMANDS).is_ok());
        assert!(check_args(&args(&["auth", "status"]), GH_SUBCOMMANDS).is_ok());
    }

    #[test]
    fn secret_reading_and_server_subcommands_are_refused() {
        // `git credential fill` prints the stored password for a host on
        // stdout. Nothing in the editor needs it, and an MCP caller must not
        // be able to ask for it.
        let denied = check_args(&args(&["credential", "fill"]), GIT_SUBCOMMANDS).unwrap_err();
        assert!(denied.contains("credential"), "{denied}");
        assert!(check_args(&args(&["daemon"]), GIT_SUBCOMMANDS).is_err());
        assert!(check_args(&args(&["filter-branch"]), GIT_SUBCOMMANDS).is_err());
        // gh's allowlist is separate: a git subcommand must not pass it.
        assert!(check_args(&args(&["status"]), GH_SUBCOMMANDS).is_ok());
        assert!(check_args(&args(&["commit"]), GH_SUBCOMMANDS).is_err());
    }

    #[test]
    fn config_injection_is_refused() {
        // `-c core.sshCommand=…` is arbitrary code execution wearing a git
        // option, and it is the reason this check exists at all.
        for bad in [
            vec!["-c", "core.sshCommand=calc.exe", "fetch"],
            vec!["-c", "alias.x=!sh", "status"],
            vec!["--exec-path=/tmp/evil", "status"],
            vec!["fetch", "--upload-pack=calc.exe"],
            vec!["-C", "/somewhere/else", "status"],
            // Attached forms of the same two options — `git -C/tmp status` and
            // `git -ccore.sshCommand=calc.exe fetch` are both valid git, so a
            // check that only compared for equality would wave them through.
            vec!["-C/somewhere/else", "status"],
            vec!["-ccore.sshCommand=calc.exe", "fetch"],
        ] {
            let err = check_args(&args(&bad), GIT_SUBCOMMANDS)
                .expect_err(&format!("{bad:?} should be refused"));
            assert!(err.contains("another program"), "{err}");
        }
    }

    #[test]
    fn a_flag_that_merely_starts_with_a_forbidden_one_is_fine() {
        // `-c` is forbidden; `--cached` and `--committer-date-is-author-date`
        // start with the same letters and are ordinary arguments.
        assert!(check_args(&args(&["diff", "--cached"]), GIT_SUBCOMMANDS).is_ok());
        assert!(check_args(&args(&["config", "user.name"]), GIT_SUBCOMMANDS).is_ok());
    }

    #[test]
    fn the_one_time_code_is_read_out_of_ghs_prose() {
        assert_eq!(
            one_time_code("! First copy your one-time code: 149C-4F54").as_deref(),
            Some("149C-4F54")
        );
        assert_eq!(one_time_code("Open this URL to continue: https://…"), None);
    }
}
