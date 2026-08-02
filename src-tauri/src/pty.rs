//! Pseudo-terminal sessions, so the editor can host a real terminal panel.
//!
//! The point of this module is running `claude` and `codex` inside the editor
//! instead of alt-tabbing to a separate terminal. Both are full-screen TUI
//! programs: they use the alternate screen buffer, raw keyboard input, cursor
//! addressing and colour. Piping stdio to them does not work — they detect the
//! absence of a tty and fall back to (or refuse) line mode, and there is no way
//! to deliver arrow keys or Ctrl-C. Only a real PTY behaves like the terminal
//! they expect, which on Windows means ConPTY; `portable-pty` is the
//! cross-platform wrapper over that and forkpty elsewhere.
//!
//! ## Shape
//!
//! One `Session` per terminal panel, keyed by a frontend-generated id. Each owns
//! its master PTY, a writer, the child process, and a reader thread that pumps
//! output to the webview as `pty://data` events. The frontend feeds those bytes
//! straight into xterm.js, which is the thing that actually understands the
//! escape sequences — nothing here parses terminal output.
//!
//! Bytes are base64 on the way out. A PTY emits arbitrary bytes and can split a
//! UTF-8 sequence across reads, so decoding to `String` per chunk corrupts any
//! multi-byte character that lands on a boundary — which for these two CLIs is
//! constant, since both draw box-art borders and spinners. Base64 keeps the
//! stream exactly as produced and lets xterm's own decoder handle framing.

use base64::Engine as _;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

pub struct Session {
    writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

#[derive(Default)]
pub struct PtyState {
    sessions: Mutex<HashMap<String, Session>>,
}

#[derive(Clone, Serialize)]
struct PtyData {
    id: String,
    /// base64 of the raw bytes — see the module note on UTF-8 boundaries.
    data: String,
}

#[derive(Clone, Serialize)]
struct PtyExit {
    id: String,
    code: Option<i32>,
}

/// Starts `command` under a new PTY and streams its output to the frontend.
///
/// `cwd` matters more than it looks: both CLIs are project-scoped, so a session
/// opened from the editor should start in the project the user has open, not in
/// whatever directory the app was launched from.
#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: tauri::State<'_, PtyState>,
    id: String,
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    env: Option<HashMap<String, String>>,
) -> Result<(), String> {
    // Replacing an existing id is the restart path (the panel's Restart button,
    // and switching between Claude/Codex/shell). Kill first so we never leak a
    // child or leave two readers emitting under one id.
    kill_session(&state, &id);

    let pty = native_pty_system();
    let pair = pty
        .openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Could not open a pseudo-terminal: {e}"))?;

    let mut builder = CommandBuilder::new(&command);
    for arg in &args {
        builder.arg(arg);
    }
    if let Some(dir) = cwd.as_ref().filter(|d| !d.is_empty()) {
        builder.cwd(dir);
    }
    for (key, value) in env.unwrap_or_default() {
        builder.env(key, value);
    }
    // Claude Code and Codex both branch on TERM. Without it they assume a dumb
    // terminal and drop colour and cursor addressing, which is most of what
    // makes them usable.
    builder.env("TERM", "xterm-256color");

    let child = pair
        .slave
        .spawn_command(builder)
        .map_err(|e| format!("Could not start \"{command}\": {e}"))?;
    // The slave handle must be dropped or the child never sees EOF on exit.
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Could not read from the terminal: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Could not write to the terminal: {e}"))?;

    let emit_id = id.clone();
    let emit_app = app.clone();
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buffer = [0u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => {
                    let encoded = base64::engine::general_purpose::STANDARD.encode(&buffer[..n]);
                    // A failed emit means the window is gone; stop pumping.
                    if emit_app
                        .emit(
                            "pty://data",
                            PtyData {
                                id: emit_id.clone(),
                                data: encoded,
                            },
                        )
                        .is_err()
                    {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = emit_app.emit(
            "pty://exit",
            PtyExit {
                id: emit_id,
                code: None,
            },
        );
    });

    let mut sessions = state.sessions.lock().map_err(|_| "pty state poisoned")?;
    sessions.insert(
        id,
        Session {
            writer,
            master: pair.master,
            child,
        },
    );
    Ok(())
}

/// Sends keystrokes to a session. `data` is UTF-8 text from xterm's `onData`,
/// which already encodes control keys as the escape sequences a tty expects.
#[tauri::command]
pub fn pty_write(
    state: tauri::State<'_, PtyState>,
    id: String,
    data: String,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|_| "pty state poisoned")?;
    let session = sessions
        .get_mut(&id)
        .ok_or_else(|| format!("No terminal session \"{id}\""))?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("Could not write to the terminal: {e}"))?;
    session
        .writer
        .flush()
        .map_err(|e| format!("Could not flush the terminal: {e}"))
}

/// Tells the child its window changed size. Without this a TUI keeps drawing at
/// the size it started with, so a resized panel shows a wrapped, torn layout.
#[tauri::command]
pub fn pty_resize(
    state: tauri::State<'_, PtyState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|_| "pty state poisoned")?;
    let session = sessions
        .get(&id)
        .ok_or_else(|| format!("No terminal session \"{id}\""))?;
    session
        .master
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Could not resize the terminal: {e}"))
}

/// Ends a session. Idempotent — closing an already-closed panel is not an error.
#[tauri::command]
pub fn pty_kill(state: tauri::State<'_, PtyState>, id: String) -> Result<(), String> {
    kill_session(&state, &id);
    Ok(())
}

/// True if `id` currently has a live session, so a remounted panel (Dockview
/// moves them between containers) can reattach instead of starting a second
/// copy of Claude.
#[tauri::command]
pub fn pty_alive(state: tauri::State<'_, PtyState>, id: String) -> Result<bool, String> {
    let sessions = state.sessions.lock().map_err(|_| "pty state poisoned")?;
    Ok(sessions.contains_key(&id))
}

fn kill_session(state: &tauri::State<'_, PtyState>, id: &str) {
    if let Ok(mut sessions) = state.sessions.lock() {
        if let Some(mut session) = sessions.remove(id) {
            let _ = session.child.kill();
            let _ = session.child.wait();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Proves the PTY layer actually runs a program and produces its output —
    /// the half of the terminal panel that no browser-based harness can reach.
    /// Uses the pty crate directly rather than the tauri commands, which need an
    /// `AppHandle` to emit through.
    ///
    /// ## The DSR handshake, which cost this test 15 minutes of hanging
    ///
    /// ConPTY opens by sending `ESC[6n` — "report cursor position" — and does
    /// not proceed until something answers `ESC[<row>;<col>R`. A real terminal
    /// emulator replies automatically, which is why the actual panel works:
    /// xterm.js handles it before anyone notices. A test that only reads,
    /// though, deadlocks: the first (and only) bytes to arrive are the query
    /// itself, and then both sides wait forever.
    ///
    /// So the test plays terminal. Everything here is bounded by a channel
    /// timeout as well, because the failure mode of getting this wrong is a
    /// hang rather than an assertion, and a suite that hangs is worse than one
    /// that fails.
    #[test]
    fn pty_runs_a_command_and_returns_output() {
        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");

        let mut builder = if cfg!(windows) {
            let mut b = CommandBuilder::new("cmd.exe");
            b.arg("/C");
            b.arg("echo pty-smoke-ok");
            b
        } else {
            let mut b = CommandBuilder::new("sh");
            b.arg("-c");
            b.arg("echo pty-smoke-ok");
            b
        };
        builder.env("TERM", "xterm-256color");

        let mut child = pair.slave.spawn_command(builder).expect("spawn");
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().expect("reader");
        let mut writer = pair.master.take_writer().expect("writer");

        // Reader on its own thread so the main thread can bound the wait.
        let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                    break;
                }
            }
        });

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        let mut collected = Vec::new();
        let mut answered_dsr = false;
        while std::time::Instant::now() < deadline {
            let Ok(chunk) = rx.recv_timeout(std::time::Duration::from_millis(500)) else {
                continue;
            };
            collected.extend_from_slice(&chunk);
            let text = String::from_utf8_lossy(&collected);
            // Play terminal: answer the cursor-position report once.
            if !answered_dsr && text.contains("\u{1b}[6n") {
                answered_dsr = true;
                let _ = writer.write_all(b"\x1b[1;1R");
                let _ = writer.flush();
            }
            if text.contains("pty-smoke-ok") {
                break;
            }
        }

        let _ = child.kill();
        let text = String::from_utf8_lossy(&collected);
        assert!(
            text.contains("pty-smoke-ok"),
            "expected the child's output through the pty, got: {text:?}"
        );
    }
}
