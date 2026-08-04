//! A public share link for the browser preview.
//!
//! `serve_build_lan` stops at the router: localhost and Wi-Fi. Demoing a build
//! to someone elsewhere means either uploading it or forwarding a public URL
//! to the machine already serving it. This module does the latter with a
//! Cloudflare quick tunnel: `cloudflared tunnel --url http://127.0.0.1:PORT`
//! prints a free `https://<random>.trycloudflare.com` hostname that forwards
//! here for as long as the process runs — no account, no configuration, and a
//! real certificate (unlike the LAN listener's self-signed one, so no browser
//! warning stands between the link and the game).
//!
//! The binary comes from PATH if the user has one, otherwise it is downloaded
//! once into the app's local data directory. The tunnel dies on the explicit
//! stop command or with the editor (`RunEvent::Exit` calls `shutdown`) — an
//! orphaned cloudflared would keep a public hostname alive that forwards to a
//! port nothing listens on any more.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Mutex};
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Keeps every cloudflared invocation (even the `--version` probe) from
/// flashing a console window on Windows.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub(crate) fn command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

#[derive(Default)]
pub struct ShareState {
    /// The single running tunnel, if any. One is enough: it fronts the one
    /// preview server, and quick tunnels are anonymous — a second would just
    /// be a second random hostname for the same content.
    tunnel: Mutex<Option<ShareTunnel>>,
}

struct ShareTunnel {
    port: u16,
    url: String,
    child: Child,
}

impl ShareTunnel {
    fn kill(mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Kills the running tunnel, if any. Called from the `RunEvent::Exit` handler.
pub fn shutdown(app: &tauri::AppHandle) {
    use tauri::Manager;
    let Some(state) = app.try_state::<ShareState>() else {
        return;
    };
    let tunnel = state.tunnel.lock().ok().and_then(|mut guard| guard.take());
    if let Some(tunnel) = tunnel {
        tunnel.kill();
    }
}

fn download_url() -> Result<&'static str, String> {
    if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        Ok("https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe")
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        Ok("https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64")
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        Ok("https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64")
    } else {
        // macOS releases ship as .tgz only; unpacking is not worth owning when
        // a one-line install exists.
        Err("No cloudflared auto-download for this platform. Install it and put it on PATH (macOS: brew install cloudflared).".into())
    }
}

fn managed_binary_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("resolve app data dir: {e}"))?
        .join("bin");
    Ok(dir.join(if cfg!(windows) { "cloudflared.exe" } else { "cloudflared" }))
}

fn path_binary_works() -> bool {
    command("cloudflared")
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

/// The program to spawn, if one is available without downloading: a PATH
/// install wins (it self-updates with the user's package manager), then a
/// previously downloaded managed copy.
fn available_binary(app: &tauri::AppHandle) -> Result<Option<PathBuf>, String> {
    if path_binary_works() {
        return Ok(Some(PathBuf::from("cloudflared")));
    }
    let managed = managed_binary_path(app)?;
    Ok(managed.is_file().then_some(managed))
}

fn download_binary(dest: &Path) -> Result<(), String> {
    let url = download_url()?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    let response = ureq::get(url)
        .timeout(Duration::from_secs(600))
        .call()
        .map_err(|e| format!("download cloudflared: {e}"))?;
    // Download beside the destination and rename, so a killed download can
    // never leave a truncated file that later "is" the binary.
    let tmp = dest.with_extension("partial");
    let mut file =
        std::fs::File::create(&tmp).map_err(|e| format!("create {}: {e}", tmp.display()))?;
    if let Err(error) = std::io::copy(&mut response.into_reader(), &mut file) {
        drop(file);
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("download cloudflared: {error}"));
    }
    drop(file);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755));
    }
    std::fs::rename(&tmp, dest).map_err(|e| format!("install cloudflared: {e}"))
}

/// Pulls the assigned quick-tunnel hostname out of a cloudflared log line.
///
/// The URL arrives inside an ASCII banner box, so it is bounded by spaces and
/// box borders rather than being the whole line. `api.trycloudflare.com` is
/// the registration endpoint cloudflared talks to, not a tunnel — it can show
/// up in error lines and must not be mistaken for the URL.
pub fn extract_quick_tunnel_url(line: &str) -> Option<String> {
    const SUFFIX: &str = ".trycloudflare.com";
    let start = line.find("https://")?;
    let candidate = &line[start..];
    let end = candidate.find(SUFFIX)? + SUFFIX.len();
    let url = &candidate[..end];
    if url.contains(char::is_whitespace) || url == "https://api.trycloudflare.com" {
        return None;
    }
    Some(url.to_string())
}

fn spawn_tunnel(binary: &Path, port: u16) -> Result<(String, Child), String> {
    let mut child = command(binary)
        .args([
            "tunnel",
            "--url",
            &format!("http://127.0.0.1:{port}"),
            "--no-autoupdate",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("start cloudflared: {e}"))?;

    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "cloudflared stderr unavailable".to_string())?;
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut tail: Vec<String> = Vec::new();
        let mut found = false;
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            if found {
                // Keep draining to EOF: a full pipe would eventually block
                // cloudflared's logger and stall the tunnel itself.
                continue;
            }
            if let Some(url) = extract_quick_tunnel_url(&line) {
                found = true;
                let _ = sender.send(Ok(url));
                continue;
            }
            tail.push(line.trim_end().to_string());
            if tail.len() > 20 {
                tail.remove(0);
            }
        }
        if !found {
            let _ = sender.send(Err(tail.join("\n")));
        }
    });

    match receiver.recv_timeout(Duration::from_secs(45)) {
        Ok(Ok(url)) => Ok((url, child)),
        Ok(Err(log)) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(format!(
                "cloudflared exited before printing a tunnel URL:\n{log}"
            ))
        }
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            Err("Timed out waiting for the tunnel URL. Check the network connection and try again.".into())
        }
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareBinaryStatus {
    ready: bool,
}

/// Whether a tunnel can start without the one-time binary download. The
/// frontend only uses this to pick a progress message ("downloading ~55 MB"
/// vs "creating link"); `start_share_tunnel` does the actual ensuring.
#[tauri::command]
pub async fn share_binary_status(app: tauri::AppHandle) -> Result<ShareBinaryStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        Ok(ShareBinaryStatus {
            ready: available_binary(&app)?.is_some(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Starts (or returns the already-running) public quick tunnel for the local
/// preview port. Downloads cloudflared on first use.
#[tauri::command]
pub async fn start_share_tunnel(app: tauri::AppHandle, port: u16) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let state = app.state::<ShareState>();
        // The lock is held across download + spawn on purpose: a second click
        // while the first is still downloading must wait for that attempt and
        // then hit the idempotent path, not race a second download into the
        // same destination file.
        let mut tunnel = state.tunnel.lock().map_err(|e| e.to_string())?;
        if let Some(existing) = tunnel.as_mut() {
            let alive = existing
                .child
                .try_wait()
                .map(|status| status.is_none())
                .unwrap_or(false);
            if alive && existing.port == port {
                // Idempotent like serve_build: a dockview remount asking again
                // gets the running tunnel's URL, not a second process.
                return Ok(existing.url.clone());
            }
        }
        if let Some(previous) = tunnel.take() {
            previous.kill();
        }
        let binary = match available_binary(&app)? {
            Some(binary) => binary,
            None => {
                let managed = managed_binary_path(&app)?;
                download_binary(&managed)?;
                managed
            }
        };
        let (url, child) = spawn_tunnel(&binary, port)?;
        *tunnel = Some(ShareTunnel {
            port,
            url: url.clone(),
            child,
        });
        Ok(url)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Stops the running tunnel. Returns whether one was running.
#[tauri::command]
pub async fn stop_share_tunnel(app: tauri::AppHandle) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let state = app.state::<ShareState>();
        let tunnel = state.tunnel.lock().map_err(|e| e.to_string())?.take();
        match tunnel {
            Some(tunnel) => {
                tunnel.kill();
                Ok(true)
            }
            None => Ok(false),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::extract_quick_tunnel_url;

    #[test]
    fn finds_the_url_inside_the_banner_box() {
        let line = "2026-08-04T10:00:00Z INF |  https://witty-fox-heavy-mole.trycloudflare.com                                            |";
        assert_eq!(
            extract_quick_tunnel_url(line).as_deref(),
            Some("https://witty-fox-heavy-mole.trycloudflare.com")
        );
    }

    #[test]
    fn ignores_the_registration_endpoint() {
        let line = "2026-08-04T10:00:00Z ERR failed to request quick Tunnel: POST https://api.trycloudflare.com/tunnel: dial tcp: timeout";
        assert_eq!(extract_quick_tunnel_url(line), None);
    }

    #[test]
    fn ignores_unrelated_https_urls() {
        let line = "2026-08-04T10:00:00Z INF Requesting new quick Tunnel: see https://developers.cloudflare.com/cloudflare-one/ for limits";
        assert_eq!(extract_quick_tunnel_url(line), None);
    }

    #[test]
    fn ignores_lines_without_urls() {
        assert_eq!(
            extract_quick_tunnel_url("INF Registered tunnel connection connIndex=0"),
            None
        );
    }
}
