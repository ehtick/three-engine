//! One-shot, non-interactive AI agent runs.
//!
//! `pty.rs` hosts the long-lived, interactive `claude`/`codex` session for the
//! terminal panel — a full TUI that needs a real pseudo-terminal. This module
//! is for the opposite case: a SHORT, SCOPED turn fired from a context-menu
//! action ("AI: Diagnose this"), using the CLI's own non-interactive print
//! mode (`claude -p ...`). That is a plain child process, not a TUI, so a PTY
//! would be actively wrong here: there is no DSR handshake to answer (see the
//! pty.rs module comment) and no terminal width to negotiate.
//!
//! ## Shape
//!
//! Closer to `share.rs`'s `spawn_tunnel` than to `pty.rs`: a plain
//! `std::process::Command` with piped stdout AND stderr (errors can land on
//! either), one reader thread per stream doing `BufRead::read_line` and
//! emitting one `agent://line` event per line — line granularity is enough
//! here because `--output-format stream-json` is newline-delimited JSON,
//! unlike a PTY's arbitrary byte stream, which is why pty.rs has to deal with
//! UTF-8 boundaries and this does not.
//!
//! Cancellation kills by PID rather than sharing a `Child` handle: the spawned
//! `Child` is moved entirely into a dedicated waiter thread that does a
//! blocking `wait()` and emits the real exit code when the process ends,
//! whether that is a natural exit or `agent_cancel` killing it out from under
//! that wait. The state map only ever holds the PID, which is `Copy` and needs
//! the lock held for microseconds, not the run's whole lifetime.

use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn no_window_command(program: &str) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// id -> pid of the run currently registered under that id. Only ever holds
/// the pid, not the `Child` itself — see the module note on why.
#[derive(Default)]
pub struct AgentState {
    runs: Mutex<HashMap<String, u32>>,
}

#[derive(Clone, Serialize)]
struct AgentLine {
    id: String,
    stream: &'static str, // "stdout" | "stderr"
    line: String,
}

#[derive(Clone, Serialize)]
struct AgentExit {
    id: String,
    code: Option<i32>,
}

/// Kills a process by pid. `/T` (Windows) matters because `claude` on Windows
/// is typically a `.cmd` shim around a real `node` process — killing only the
/// shim's pid would leave the actual model call running. There is no
/// equivalent process-tree kill attempted on Unix (would need the child
/// spawned into its own process group); a bare `kill` is what we have there
/// today.
fn kill_pid(pid: u32) {
    #[cfg(windows)]
    let (bin, args) = (
        "taskkill",
        vec!["/PID".to_string(), pid.to_string(), "/T".to_string(), "/F".to_string()],
    );
    #[cfg(not(windows))]
    let (bin, args) = ("kill", vec!["-KILL".to_string(), pid.to_string()]);

    let _ = no_window_command(bin)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// Reads `pipe` line by line, emitting one `agent://line` event per line.
/// Stops silently on EOF, a read error, or a failed emit (the window is gone).
fn spawn_reader(app: AppHandle, id: String, stream: &'static str, pipe: impl std::io::Read + Send + 'static) {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(pipe);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let text = line.trim_end_matches(|c| c == '\r' || c == '\n').to_string();
                    if app
                        .emit(
                            "agent://line",
                            AgentLine { id: id.clone(), stream, line: text },
                        )
                        .is_err()
                    {
                        break;
                    }
                }
            }
        }
    });
}

/// Starts `command` as a one-shot, non-interactive process and streams its
/// output back as `agent://line` events keyed by `id`, followed by exactly one
/// `agent://exit` once it ends. Replacing an existing id kills the previous
/// run first — the same "second call restarts" contract as `pty_spawn`.
#[tauri::command]
pub fn agent_run(
    app: AppHandle,
    state: tauri::State<'_, AgentState>,
    id: String,
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
) -> Result<(), String> {
    if let Ok(mut runs) = state.runs.lock() {
        if let Some(pid) = runs.remove(&id) {
            kill_pid(pid);
        }
    }

    let mut builder = no_window_command(&command);
    builder.args(&args);
    if let Some(dir) = cwd.as_ref().filter(|d| !d.is_empty()) {
        builder.current_dir(dir);
    }
    builder.stdin(Stdio::null());
    builder.stdout(Stdio::piped());
    builder.stderr(Stdio::piped());

    let mut child = builder
        .spawn()
        .map_err(|e| format!("Could not start \"{command}\": {e}"))?;
    let pid = child.id();
    let stdout = child.stdout.take().ok_or("agent stdout unavailable")?;
    let stderr = child.stderr.take().ok_or("agent stderr unavailable")?;

    spawn_reader(app.clone(), id.clone(), "stdout", stdout);
    spawn_reader(app.clone(), id.clone(), "stderr", stderr);

    {
        let mut runs = state.runs.lock().map_err(|_| "agent state poisoned")?;
        runs.insert(id.clone(), pid);
    }

    // Owns `child` outright so it can block on wait() without holding the
    // `runs` lock for the run's whole lifetime. Only removes its OWN id->pid
    // entry, and only if nothing has replaced it since — a rapid restart
    // under the same id must not let this thread delete the NEW run's
    // bookkeeping out from under it.
    let wait_app = app;
    std::thread::spawn(move || {
        let status = child.wait();
        if let Some(state) = wait_app.try_state::<AgentState>() {
            if let Ok(mut runs) = state.runs.lock() {
                if runs.get(&id) == Some(&pid) {
                    runs.remove(&id);
                }
            }
        }
        let _ = wait_app.emit(
            "agent://exit",
            AgentExit { id, code: status.ok().and_then(|s| s.code()) },
        );
    });

    Ok(())
}

/// Cancels a run. Idempotent — cancelling a run that already finished, or was
/// never started under this id, is not an error, same contract as `pty_kill`.
#[tauri::command]
pub fn agent_cancel(state: tauri::State<'_, AgentState>, id: String) -> Result<(), String> {
    let pid = state
        .runs
        .lock()
        .map_err(|_| "agent state poisoned")?
        .get(&id)
        .copied();
    if let Some(pid) = pid {
        kill_pid(pid);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    /// Proves the underlying mechanism — spawn, read stdout line by line,
    /// wait for a real exit code — works. Goes through `std::process::Command`
    /// directly rather than the `agent_run` tauri command, which needs a live
    /// `AppHandle` to emit through (same constraint pty.rs's test notes for
    /// the PTY case).
    #[test]
    fn spawns_and_captures_stdout_and_exit_code() {
        let mut child = if cfg!(windows) {
            no_window_command("cmd.exe")
                .args(["/C", "echo agent-smoke-ok"])
                .stdout(Stdio::piped())
                .spawn()
        } else {
            no_window_command("sh")
                .args(["-c", "echo agent-smoke-ok"])
                .stdout(Stdio::piped())
                .spawn()
        }
        .expect("spawn");

        let stdout = child.stdout.take().expect("stdout");
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        reader.read_line(&mut line).expect("read_line");
        assert!(
            line.trim_end_matches(|c| c == '\r' || c == '\n') == "agent-smoke-ok",
            "expected the child's echoed line, got {line:?}"
        );

        let status = child.wait().expect("wait");
        assert!(status.success(), "expected a zero exit code, got {status:?}");
        assert_eq!(status.code(), Some(0));
    }

    /// Proves `kill_pid` actually terminates a running process rather than
    /// silently no-op'ing, which is the entire safety story for the Cancel
    /// button on a headless AI run.
    #[test]
    fn kill_pid_terminates_a_running_process() {
        // A real standalone binary, spawned directly (no shell in between) —
        // deliberately not `cmd.exe /C timeout /T 30`: on a machine whose PATH
        // has Git for Windows' `usr/bin` ahead of System32, `cmd.exe`'s own
        // PATH search can resolve `timeout` to GNU coreutils' version instead
        // of the Windows builtin. GNU timeout treats "/T" as a malformed
        // duration and exits immediately, which made an earlier version of
        // this test pass for the wrong reason: the process died on its own
        // before `kill_pid` ever ran, and a dead process still satisfies
        // `try_wait() == Ok(Some(_))`. `ping` is unambiguous on both sides.
        let mut child = if cfg!(windows) {
            no_window_command("ping").args(["-n", "31", "127.0.0.1"]).stdout(Stdio::null()).spawn()
        } else {
            no_window_command("sh").args(["-c", "sleep 30"]).stdout(Stdio::null()).spawn()
        }
        .expect("spawn");

        // Prove it's actually alive before killing it — otherwise a process
        // that (for whatever environment-specific reason) exits on its own
        // would make this test pass without `kill_pid` doing anything.
        std::thread::sleep(Duration::from_millis(200));
        assert!(
            matches!(child.try_wait(), Ok(None)),
            "expected the process to still be running before kill_pid"
        );

        kill_pid(child.id());

        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Ok(Some(_status)) = child.try_wait() {
                break;
            }
            assert!(Instant::now() < deadline, "kill_pid did not terminate the process within 10s");
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}
