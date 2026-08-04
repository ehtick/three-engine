//! One-click publishing of a web build to Cloudflare Pages.
//!
//! The share tunnel (share.rs) is a demo that lives as long as the editor;
//! this is the counterpart with a stable, presentable URL — the build is
//! uploaded to Pages and served at `https://<project>.pages.dev` whether or
//! not the machine that built it is on.
//!
//! Everything goes through wrangler via npx, the same "the dev environment
//! has node" assumption `rebuild_player_template` already makes. Auth is
//! wrangler's own OAuth: the deploy is attempted first, and an auth-shaped
//! failure is reported as `NeedsLogin` so the frontend can run `pages_login`
//! (which opens the browser) and retry — that stays correct across wrangler
//! versions, unlike parsing `whoami` output up front.

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::share::command;

fn npx_wrangler(args: &[&str]) -> Command {
    // Windows npm ships npx as a .cmd shim, which CreateProcess will not run
    // directly — go through cmd like rebuild_player_template does.
    #[cfg(windows)]
    {
        let mut cmd = command("cmd");
        cmd.arg("/C").arg("npx").arg("--yes").arg("wrangler").args(args);
        cmd
    }
    #[cfg(not(windows))]
    {
        let mut cmd = command("npx");
        cmd.arg("--yes").arg("wrangler").args(args);
        cmd
    }
}

fn npx_probe() -> Command {
    #[cfg(windows)]
    {
        let mut cmd = command("cmd");
        cmd.arg("/C").arg("npx").arg("--version");
        cmd
    }
    #[cfg(not(windows))]
    {
        let mut cmd = command("npx");
        cmd.arg("--version");
        cmd
    }
}

struct CmdOutput {
    success: bool,
    combined: String,
}

fn drain<R: Read + Send + 'static>(pipe: Option<R>) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(mut pipe) = pipe {
            let _ = pipe.read_to_end(&mut bytes);
        }
        String::from_utf8_lossy(&bytes).into_owned()
    })
}

/// Runs a command to completion with a hard cap. The cap matters because two
/// of these calls wait on things outside our control — a first-run `npx`
/// package download and a human finishing an OAuth flow — and an invoke that
/// never resolves would wedge the publish button until an editor restart.
fn run_with_timeout(mut cmd: Command, timeout: Duration, what: &str) -> Result<CmdOutput, String> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("{what}: {e}"))?;
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
                    return Err(format!("{what} timed out after {}s", timeout.as_secs()));
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            Err(error) => return Err(format!("{what}: {error}")),
        }
    };
    let out = stdout.join().unwrap_or_default();
    let err = stderr.join().unwrap_or_default();
    Ok(CmdOutput {
        success: status.success(),
        combined: format!("{out}\n{err}"),
    })
}

/// The last non-empty lines of a command's output — enough to say why it
/// failed without dumping a full npm install log into an error toast.
fn tail(text: &str) -> String {
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    let start = lines.len().saturating_sub(15);
    lines[start..].join("\n")
}

/// Whether a wrangler failure means "log in first" rather than a real error.
/// Matched broadly on purpose: wrangler's wording shifts between versions,
/// and misclassifying an auth failure as fatal loses the retry-after-login
/// path, while the reverse just runs one redundant login.
pub fn looks_like_auth_failure(output: &str) -> bool {
    const MARKERS: [&str; 5] = [
        "CLOUDFLARE_API_TOKEN",
        "wrangler login",
        "not authenticated",
        "Authentication error",
        "[code: 10000]",
    ];
    MARKERS.iter().any(|marker| output.contains(marker))
}

/// The production URL a deployment URL implies.
///
/// This exists because `https://<project>.pages.dev` CANNOT be fabricated
/// from the project name: pages.dev subdomains are global, and when the name
/// is already taken by someone else's project Cloudflare silently assigns
/// `<project>-<random>.pages.dev` instead. The only trustworthy source is
/// the hash-prefixed deployment URL wrangler prints — production is that
/// host minus its first label.
pub fn production_url_from_deployment(deployment: &str) -> Option<String> {
    let host = deployment.strip_prefix("https://")?;
    let (_, rest) = host.split_once('.')?;
    if rest.ends_with(".pages.dev") {
        // <hash>.<subdomain>.pages.dev — drop the deployment hash.
        Some(format!("https://{rest}"))
    } else if rest == "pages.dev" {
        // Already the bare production host.
        Some(format!("https://{host}"))
    } else {
        None
    }
}

/// The deployment URL wrangler printed, if any. The last match wins: deploy
/// output can mention other *.pages.dev URLs (aliases, previous deploys)
/// before the "Take a peek over at ..." line.
pub fn extract_pages_url(text: &str) -> Option<String> {
    const SUFFIX: &str = ".pages.dev";
    let mut found = None;
    for (idx, _) in text.match_indices("https://") {
        let candidate = &text[idx..];
        let Some(end) = candidate.find(SUFFIX) else {
            continue;
        };
        let url = &candidate[..end + SUFFIX.len()];
        if !url.contains(char::is_whitespace) {
            found = Some(url.to_string());
        }
    }
    found
}

/// Also the argument-injection guard: the name is passed to a shell on
/// Windows, so it must never contain anything but the characters Pages
/// itself allows.
pub fn valid_project_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 58
        && !name.starts_with('-')
        && !name.ends_with('-')
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// `\\?\`-free form of a canonical Windows path: it goes to a Node CLI as an
/// argument, and the extended-length prefix confuses path printing/joining in
/// enough tooling to not be worth shipping.
fn native_path(path: &Path) -> String {
    let s = path.to_string_lossy();
    s.strip_prefix(r"\\?\").unwrap_or(&s).to_string()
}

#[derive(serde::Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum PagesDeployOutcome {
    #[serde(rename_all = "camelCase")]
    Ok {
        url: String,
        deployment_url: Option<String>,
    },
    NeedsLogin,
}

/// Runs wrangler's browser OAuth flow. Only called after a deploy came back
/// `NeedsLogin`; wrangler opens the default browser itself and waits for the
/// callback. The generous timeout is a human filling in a login form.
#[tauri::command]
pub async fn pages_login() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        let out = run_with_timeout(
            npx_wrangler(&["login"]),
            Duration::from_secs(300),
            "wrangler login",
        )?;
        if !out.success {
            return Err(format!("Cloudflare login failed:\n{}", tail(&out.combined)));
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Uploads a built web folder to the Pages project, creating the project on
/// first use. Returns `NeedsLogin` instead of an error when wrangler wants
/// auth, so the frontend can login and call this again.
#[tauri::command]
pub async fn pages_deploy(dir: String, project: String) -> Result<PagesDeployOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !valid_project_name(&project) {
            return Err(format!(
                "\"{project}\" is not a valid Pages project name (lowercase letters, digits and hyphens)."
            ));
        }
        let root = std::fs::canonicalize(&dir).map_err(|e| format!("{dir}: {e}"))?;
        if !root.join("index.html").is_file() {
            return Err(format!("{dir} does not look like a web build (no index.html)."));
        }
        // Pages refuses files over 25 MiB. Catch it here, before minutes of
        // upload do, and name the offenders next to the fix.
        const PAGES_FILE_LIMIT: u64 = 25 * 1024 * 1024;
        let mut oversized = Vec::new();
        for entry in walkdir::WalkDir::new(&root).into_iter().flatten() {
            if !entry.file_type().is_file() {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            if meta.len() > PAGES_FILE_LIMIT {
                let rel = entry
                    .path()
                    .strip_prefix(&root)
                    .unwrap_or_else(|_| entry.path());
                oversized.push(format!("{} ({} MiB)", rel.display(), meta.len() >> 20));
            }
        }
        if !oversized.is_empty() {
            return Err(format!(
                "Cloudflare Pages only accepts files up to 25 MiB, and this build contains: {}. \
                 Enable Draco model / Basis texture compression in Build Settings, or shrink these assets.",
                oversized.join(", ")
            ));
        }
        let probe = run_with_timeout(npx_probe(), Duration::from_secs(60), "npx")?;
        if !probe.success {
            return Err("Publishing needs Node.js — `npx` was not found on PATH.".into());
        }

        // Create the project if it does not exist yet; "already exists" is
        // the normal case after the first publish. The long cap covers the
        // very first run, where npx downloads the wrangler package itself.
        let create = run_with_timeout(
            npx_wrangler(&["pages", "project", "create", &project, "--production-branch=main"]),
            Duration::from_secs(900),
            "wrangler pages project create",
        )?;
        if !create.success {
            if looks_like_auth_failure(&create.combined) {
                return Ok(PagesDeployOutcome::NeedsLogin);
            }
            if !create.combined.contains("already exists") {
                return Err(format!(
                    "Could not create the Pages project:\n{}",
                    tail(&create.combined)
                ));
            }
        }

        let dir_arg = native_path(&root);
        let deploy = run_with_timeout(
            npx_wrangler(&[
                "pages",
                "deploy",
                &dir_arg,
                "--project-name",
                &project,
                "--branch=main",
                // The build dir is not a git checkout; without this wrangler
                // warns about uncommitted changes on every deploy.
                "--commit-dirty=true",
            ]),
            Duration::from_secs(900),
            "wrangler pages deploy",
        )?;
        if !deploy.success {
            if looks_like_auth_failure(&deploy.combined) {
                return Ok(PagesDeployOutcome::NeedsLogin);
            }
            return Err(format!("Upload failed:\n{}", tail(&deploy.combined)));
        }
        let deployment_url = extract_pages_url(&deploy.combined);
        let url = deployment_url
            .as_deref()
            .and_then(production_url_from_deployment)
            // Only if wrangler printed no URL at all; the guess is right
            // whenever the subdomain wasn't taken by another account.
            .unwrap_or_else(|| format!("https://{project}.pages.dev"));
        Ok(PagesDeployOutcome::Ok {
            url,
            deployment_url,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::{extract_pages_url, looks_like_auth_failure, valid_project_name};

    #[test]
    fn extracts_the_last_pages_url() {
        let text = "Uploading... (5/5)\n✨ Success! Uploaded 5 files\n🌎 Deploying...\n✨ Deployment complete! Take a peek over at https://ab12cd34.my-game.pages.dev";
        assert_eq!(
            extract_pages_url(text).as_deref(),
            Some("https://ab12cd34.my-game.pages.dev")
        );
    }

    #[test]
    fn url_extraction_ignores_split_matches() {
        // An https:// URL and a later .pages.dev separated by whitespace must
        // not be glued into one "URL".
        let text = "see https://developers.cloudflare.com for docs\nno deploy url here .pages.dev";
        assert_eq!(extract_pages_url(text), None);
    }

    #[test]
    fn production_url_drops_the_deployment_hash() {
        use super::production_url_from_deployment;
        // The suffixed subdomain is the whole point: "game" was taken, so the
        // project really lives at game-abc.pages.dev and fabricating
        // game.pages.dev from the project name reports a dead link.
        assert_eq!(
            production_url_from_deployment("https://ab12cd34.game-abc.pages.dev").as_deref(),
            Some("https://game-abc.pages.dev")
        );
        assert_eq!(
            production_url_from_deployment("https://game-abc.pages.dev").as_deref(),
            Some("https://game-abc.pages.dev")
        );
        assert_eq!(
            production_url_from_deployment("https://developers.cloudflare.com"),
            None
        );
    }

    #[test]
    fn auth_failures_are_recognized() {
        assert!(looks_like_auth_failure(
            "In a non-interactive environment, it is recommended to set a CLOUDFLARE_API_TOKEN environment variable"
        ));
        assert!(looks_like_auth_failure(
            "You are not authenticated. Please run `wrangler login`."
        ));
        assert!(!looks_like_auth_failure("Error: project name is taken"));
    }

    #[test]
    fn project_names_are_validated() {
        assert!(valid_project_name("my-game-2"));
        assert!(!valid_project_name(""));
        assert!(!valid_project_name("-leading"));
        assert!(!valid_project_name("trailing-"));
        assert!(!valid_project_name("My-Game"));
        assert!(!valid_project_name("name;rm -rf"));
        assert!(!valid_project_name(&"a".repeat(59)));
    }
}
