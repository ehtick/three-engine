//! One-click registration of the `three-engine` MCP server with local AI CLIs.
//!
//! Replaces telling the user to paste
//! `claude mcp add three-engine -- node <path>/mcp/server.mjs` into a terminal.
//!
//! ## Why we shell out to the CLI instead of writing the config file
//!
//! Both clients keep their MCP servers in a config we could edit directly:
//! Claude Code in `~/.claude.json`, Codex in `~/.codex/config.toml`. Doing that
//! would be a mistake. `~/.claude.json` is a large, live file that a running
//! Claude Code session rewrites — a read-modify-write from here races it and can
//! lose unrelated state, and the format is not ours to depend on. `codex` uses
//! TOML, where a naive merge would drop comments and reorder the user's file.
//!
//! `claude mcp add` / `codex mcp add` are the supported interfaces, they know
//! their own formats, and they are already installed if the user has anything to
//! register with. The cost is that we have to find the binary and parse a CLI
//! error, which is much cheaper than corrupting someone's config.

use serde::Serialize;
use std::path::PathBuf;
use std::process::Command;

#[derive(Serialize)]
pub struct ClientStatus {
    /// "claude" | "codex"
    client: String,
    installed: bool,
    /// Absolute path we resolved, for the UI to show on hover.
    path: Option<String>,
    /// Whether a server with the requested name is already registered.
    registered: bool,
    /// Populated when we could not determine `registered` (CLI errored).
    error: Option<String>,
}

#[derive(Serialize)]
pub struct RegisterResult {
    ok: bool,
    message: String,
}

/// Builds a `Command` with a window suppressed on Windows.
///
/// Without `CREATE_NO_WINDOW` every one of these calls flashes a console window
/// over the editor — the CLIs are console applications and the editor is not.
fn command(program: &str) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Finds a CLI by name.
///
/// PATH alone is not enough. A GUI app inherits the environment of whatever
/// launched it, and a desktop shortcut does not get the shell's PATH — so
/// `claude` resolves when the app is started from a terminal (as in `tauri dev`)
/// and silently does not when it is started from the Start menu. Falling back to
/// the documented install locations makes the button work in both.
fn resolve_cli(name: &str) -> Option<PathBuf> {
    let exe_names: Vec<String> = if cfg!(windows) {
        vec![
            format!("{name}.cmd"),
            format!("{name}.exe"),
            format!("{name}.bat"),
            name.to_string(),
        ]
    } else {
        vec![name.to_string()]
    };

    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            for exe in &exe_names {
                let candidate = dir.join(exe);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }

    let home = dirs_home()?;
    let mut roots = vec![
        home.join(".local").join("bin"),
        home.join(".bun").join("bin"),
        home.join("bin"),
    ];
    if cfg!(windows) {
        roots.push(
            home.join("AppData")
                .join("Local")
                .join("Programs")
                .join("OpenAI")
                .join("Codex")
                .join("bin"),
        );
        roots.push(home.join("AppData").join("Roaming").join("npm"));
    } else {
        roots.push(PathBuf::from("/usr/local/bin"));
        roots.push(PathBuf::from("/opt/homebrew/bin"));
    }
    for dir in roots {
        for exe in &exe_names {
            let candidate = dir.join(exe);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

fn run(bin: &PathBuf, args: &[&str]) -> Result<(bool, String), String> {
    let output = command(&bin.to_string_lossy())
        .args(args)
        .output()
        .map_err(|e| format!("Could not run {}: {e}", bin.display()))?;
    let mut text = String::from_utf8_lossy(&output.stdout).to_string();
    let err = String::from_utf8_lossy(&output.stderr);
    if !err.trim().is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&err);
    }
    Ok((output.status.success(), text.trim().to_string()))
}

/// Whether each supported client is installed, and whether `name` is registered.
#[tauri::command]
pub async fn mcp_client_status(name: String) -> Result<Vec<ClientStatus>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        ["claude", "codex"]
            .iter()
            .map(|client| {
                let Some(bin) = resolve_cli(client) else {
                    return ClientStatus {
                        client: client.to_string(),
                        installed: false,
                        path: None,
                        registered: false,
                        error: None,
                    };
                };
                let (ok, text) = match run(&bin, &["mcp", "list"]) {
                    Ok(v) => v,
                    Err(e) => {
                        return ClientStatus {
                            client: client.to_string(),
                            installed: true,
                            path: Some(bin.to_string_lossy().to_string()),
                            registered: false,
                            error: Some(e),
                        }
                    }
                };
                ClientStatus {
                    client: client.to_string(),
                    installed: true,
                    path: Some(bin.to_string_lossy().to_string()),
                    // Both CLIs print one line per server; a name match on the
                    // listing is enough and avoids depending on either's exact
                    // output format.
                    registered: ok && text.lines().any(|line| line.contains(&name)),
                    error: (!ok).then(|| text.clone()),
                }
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

/// Registers (or re-registers) the MCP server with one client.
///
/// Re-registering is the common case — the absolute path to `server.mjs` changes
/// whenever the repo moves — so an existing entry is removed first rather than
/// letting `add` fail with "already exists". That makes the button idempotent,
/// which is what a user expects from something labelled "Connect".
#[tauri::command]
pub async fn mcp_client_register(
    client: String,
    name: String,
    command_path: String,
    args: Vec<String>,
) -> Result<RegisterResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(bin) = resolve_cli(&client) else {
            return Ok(RegisterResult {
                ok: false,
                message: format!(
                    "{client} is not installed, or not on this app's PATH. Install it, or run the \
                     editor from a terminal where `{client}` works."
                ),
            });
        };

        // Ignore failure: "not found" is the normal result the first time.
        let _ = run(&bin, &["mcp", "remove", &name]);

        let mut argv: Vec<&str> = vec!["mcp", "add"];
        // User scope makes the server available in every directory, which is
        // what a single "Connect" button implies. Claude's default is `local`
        // (this directory only), which would silently not apply wherever the
        // user actually runs `claude`. Codex has no scope flag — it is always
        // global.
        if client == "claude" {
            argv.push("--scope");
            argv.push("user");
        }
        argv.push(&name);
        argv.push("--");
        argv.push(&command_path);
        for arg in &args {
            argv.push(arg);
        }

        let (ok, text) = run(&bin, &argv)?;
        Ok(RegisterResult {
            ok,
            message: if ok {
                format!(
                    "Registered \"{name}\" with {client}. Restart any running {client} session to \
                     pick it up."
                )
            } else if text.is_empty() {
                format!("{client} refused the registration (no output).")
            } else {
                text
            },
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Removes the server from one client, for the UI's "Disconnect".
#[tauri::command]
pub async fn mcp_client_unregister(client: String, name: String) -> Result<RegisterResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(bin) = resolve_cli(&client) else {
            return Ok(RegisterResult {
                ok: false,
                message: format!("{client} is not installed."),
            });
        };
        let (ok, text) = run(&bin, &["mcp", "remove", &name])?;
        Ok(RegisterResult {
            ok,
            message: if ok {
                format!("Removed \"{name}\" from {client}.")
            } else {
                text
            },
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Which of the supported terminals are available, for the terminal panel's
/// program picker. Returns absolute paths so the panel can spawn them without
/// depending on the app's PATH.
#[tauri::command]
pub async fn detect_terminal_programs() -> Result<Vec<(String, Option<String>)>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        ["claude", "codex"]
            .iter()
            .map(|name| {
                (
                    name.to_string(),
                    resolve_cli(name).map(|p| p.to_string_lossy().to_string()),
                )
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_a_binary_that_is_definitely_on_path() {
        // `node` is a hard dependency of this project, so if PATH resolution
        // works at all it finds this. Guards the fallback-search logic against
        // a typo that would only show up as "claude is not installed".
        assert!(
            resolve_cli("node").is_some(),
            "expected to resolve node from PATH"
        );
    }

    #[test]
    fn missing_binaries_resolve_to_none() {
        assert!(resolve_cli("definitely-not-a-real-cli-xyzzy").is_none());
    }

    #[test]
    fn run_captures_output() {
        let node = resolve_cli("node").expect("node");
        let (ok, text) = run(&node, &["--version"]).expect("run");
        assert!(ok, "node --version should succeed");
        assert!(text.starts_with('v'), "expected a version, got {text:?}");
    }
}
