//! A local static file server for previewing a game build.
//!
//! An exported build cannot be opened by double-clicking `index.html`: module
//! scripts, `fetch("scene.json")` and the WASM decoders are all blocked over
//! `file://`. Every developer hits this the first time they export, and the
//! usual answer — "install a static server" — is a strange thing for an engine
//! to say about its own output. So the editor ships one.
//!
//! Deliberately minimal (std only, no HTTP crate): GET/HEAD of files under one
//! directory, bound to loopback. It is a preview aid, not a web server.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

#[derive(Default)]
pub struct PreviewState {
    /// Canonicalized directory -> port already serving it. Re-previewing the
    /// same build reuses its server instead of leaking a thread per click.
    servers: Mutex<HashMap<String, u16>>,
}

/// Maps a request target to a path inside `root`, or `None` if it escapes.
///
/// Splitting this out (rather than doing it inline in the request loop) is
/// what makes it testable — a directory traversal in a loopback preview server
/// is still a bug that hands out the user's home directory to any page they
/// happen to have open.
pub fn resolve_request_path(root: &Path, target: &str) -> Option<PathBuf> {
    let path = target.split(['?', '#']).next().unwrap_or("");
    let decoded = percent_decode(path);
    let trimmed = decoded.trim_start_matches('/');
    let rel = if trimmed.is_empty() || trimmed.ends_with('/') {
        format!("{trimmed}index.html")
    } else {
        trimmed.to_string()
    };

    let mut out = root.to_path_buf();
    for component in Path::new(&rel).components() {
        match component {
            Component::Normal(part) => out.push(part),
            // `.` is harmless; everything else (`..`, a root, a Windows drive
            // prefix) is an attempt to leave the served directory.
            Component::CurDir => {}
            _ => return None,
        }
    }
    Some(out)
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(byte) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Content type by extension. The three that matter are `.js` (a wrong type
/// makes the browser refuse a module script outright), `.wasm` (streaming
/// instantiation refuses anything else) and `.scene`, which is the engine's
/// own extension and is JSON.
pub fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "scene" | "mat" | "anim" | "timeline" | "audio" | "meta" | "prefab" => {
            "application/json; charset=utf-8"
        }
        "wasm" => "application/wasm",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "ktx2" | "basis" => "image/ktx2",
        "hdr" => "image/vnd.radiance",
        "glb" | "gltf" => "model/gltf-binary",
        "mp3" => "audio/mpeg",
        "ogg" => "audio/ogg",
        "wav" => "audio/wav",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    }
}

fn respond(stream: &mut TcpStream, status: &str, content_type: &str, body: &[u8], head_only: bool) {
    let header = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n\
         Cache-Control: no-store\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(header.as_bytes());
    if !head_only {
        let _ = stream.write_all(body);
    }
    let _ = stream.flush();
}

fn handle(mut stream: TcpStream, root: PathBuf) {
    let mut line = String::new();
    let mut reader = BufReader::new(match stream.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    });
    if reader.read_line(&mut line).is_err() {
        return;
    }
    // Drain the rest of the headers so the client doesn't see a reset before
    // it has finished writing its request.
    let mut header = String::new();
    while reader.read_line(&mut header).unwrap_or(0) > 2 {
        header.clear();
    }

    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("/");
    if method != "GET" && method != "HEAD" {
        respond(&mut stream, "405 Method Not Allowed", "text/plain", b"", false);
        return;
    }
    let head_only = method == "HEAD";

    let Some(path) = resolve_request_path(&root, target) else {
        respond(&mut stream, "403 Forbidden", "text/plain", b"forbidden", head_only);
        return;
    };
    let path = if path.is_dir() { path.join("index.html") } else { path };

    match std::fs::File::open(&path) {
        Ok(mut file) => {
            let mut body = Vec::new();
            if file.read_to_end(&mut body).is_err() {
                respond(&mut stream, "500 Internal Server Error", "text/plain", b"", head_only);
                return;
            }
            respond(&mut stream, "200 OK", content_type(&path), &body, head_only);
        }
        Err(_) => respond(&mut stream, "404 Not Found", "text/plain", b"not found", head_only),
    }
}

/// Serves `dir` on a loopback port and returns the URL. Idempotent per
/// directory — asking twice gets the same server back.
#[tauri::command]
pub fn serve_build(
    state: tauri::State<'_, PreviewState>,
    dir: String,
) -> Result<String, String> {
    let root = std::fs::canonicalize(&dir).map_err(|e| format!("{dir}: {e}"))?;
    if !root.is_dir() {
        return Err(format!("{dir} is not a directory"));
    }
    let key = root.to_string_lossy().into_owned();
    {
        let servers = state.servers.lock().map_err(|e| e.to_string())?;
        if let Some(port) = servers.get(&key) {
            return Ok(format!("http://localhost:{port}/"));
        }
    }

    // Loopback only. This serves a directory the user chose off their disk;
    // binding 0.0.0.0 would publish it to their entire network.
    let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))
        .map_err(|e| format!("could not start preview server: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    state
        .servers
        .lock()
        .map_err(|e| e.to_string())?
        .insert(key, port);

    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let root = root.clone();
            // A thread per connection: browsers open several in parallel for
            // the bundle and the assets, and a sequential loop would serialise
            // the whole load behind one file.
            std::thread::spawn(move || handle(stream, root));
        }
    });

    Ok(format!("http://localhost:{port}/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serves_index_for_directory_targets() {
        let root = Path::new("/srv");
        assert_eq!(resolve_request_path(root, "/").unwrap(), root.join("index.html"));
        assert_eq!(resolve_request_path(root, "/sub/").unwrap(), root.join("sub").join("index.html"));
    }

    #[test]
    fn strips_query_and_decodes() {
        let root = Path::new("/srv");
        assert_eq!(
            resolve_request_path(root, "/assets/my%20model.glb?v=2").unwrap(),
            root.join("assets").join("my model.glb")
        );
    }

    #[test]
    fn refuses_traversal() {
        let root = Path::new("/srv");
        assert!(resolve_request_path(root, "/../secrets").is_none());
        assert!(resolve_request_path(root, "/assets/../../secrets").is_none());
        assert!(resolve_request_path(root, "/%2e%2e/secrets").is_none());
    }

    #[test]
    fn types_the_three_that_break_loudly() {
        assert!(content_type(Path::new("a/b.js")).starts_with("text/javascript"));
        assert_eq!(content_type(Path::new("a/b.wasm")), "application/wasm");
        assert!(content_type(Path::new("scenes/Level2.scene")).starts_with("application/json"));
    }
}
