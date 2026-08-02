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
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddrV4, TcpListener, UdpSocket};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rcgen::{CertificateParams, KeyPair, SanType};
use rustls::pki_types::PrivatePkcs8KeyDer;
use rustls::{ServerConfig, ServerConnection, StreamOwned};

// Stable ports keep the phone bookmark and firewall permission useful across
// editor restarts. If another process owns one, bind an ephemeral port rather
// than failing the preview entirely.
const PREFERRED_LOCAL_PORT: u16 = 50845;
const PREFERRED_LAN_TLS_PORT: u16 = 50846;

#[derive(Default)]
pub struct PreviewState {
    /// Canonicalized directory -> port already serving it. Re-previewing the
    /// same build reuses its server instead of leaking a thread per click.
    servers: Mutex<HashMap<String, u16>>,
    /// Generated build directory -> its two listeners and shared stop signal.
    lan_servers: Mutex<HashMap<String, LanPreviewServer>>,
}

#[derive(Clone)]
struct LanPreviewServer {
    local_port: u16,
    lan_port: u16,
    stop: Arc<AtomicBool>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewUrls {
    local_url: String,
    lan_url: Option<String>,
}

/// Creates a stable OS-temporary output directory for one project. Building
/// directly below a project path proved fragile on Windows when the folder was
/// opened through an extended/virtualized path. Returning a canonical native
/// path also keeps the later exporter/server handoff unambiguous.
#[tauri::command]
pub fn prepare_browser_preview(project_root: String) -> Result<String, String> {
    let root = std::fs::canonicalize(&project_root)
        .map_err(|e| format!("project path {project_root}: {e}"))?;
    let mut hasher = DefaultHasher::new();
    root.hash(&mut hasher);
    let dir = std::env::temp_dir()
        .join("three-engine-browser-preview")
        .join(format!("{:016x}", hasher.finish()));
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("create preview directory {}: {e}", dir.display()))?;
    std::fs::canonicalize(&dir)
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|e| format!("resolve preview directory {}: {e}", dir.display()))
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

fn respond<W: Write>(
    stream: &mut W,
    status: &str,
    content_type: &str,
    body: &[u8],
    head_only: bool,
) {
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

fn handle<S: Read + Write>(mut stream: S, root: PathBuf) {
    let mut line = String::new();
    {
        let mut reader = BufReader::new(&mut stream);
        if reader.read_line(&mut line).is_err() {
            return;
        }
        // Drain the rest of the headers so the client doesn't see a reset
        // before it has finished writing its request.
        let mut header = String::new();
        while reader.read_line(&mut header).unwrap_or(0) > 2 {
            header.clear();
        }
    }

    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("/");
    if method != "GET" && method != "HEAD" {
        respond(
            &mut stream,
            "405 Method Not Allowed",
            "text/plain",
            b"",
            false,
        );
        return;
    }
    let head_only = method == "HEAD";

    let Some(path) = resolve_request_path(&root, target) else {
        respond(
            &mut stream,
            "403 Forbidden",
            "text/plain",
            b"forbidden",
            head_only,
        );
        return;
    };
    let path = if path.is_dir() {
        path.join("index.html")
    } else {
        path
    };

    match std::fs::File::open(&path) {
        Ok(mut file) => {
            let mut body = Vec::new();
            if file.read_to_end(&mut body).is_err() {
                respond(
                    &mut stream,
                    "500 Internal Server Error",
                    "text/plain",
                    b"",
                    head_only,
                );
                return;
            }
            respond(&mut stream, "200 OK", content_type(&path), &body, head_only);
        }
        Err(_) => respond(
            &mut stream,
            "404 Not Found",
            "text/plain",
            b"not found",
            head_only,
        ),
    }
}

/// Serves `dir` on a loopback port and returns the URL. Idempotent per
/// directory — asking twice gets the same server back.
#[tauri::command]
pub fn serve_build(state: tauri::State<'_, PreviewState>, dir: String) -> Result<String, String> {
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
    let listener = bind_preferred(Ipv4Addr::LOCALHOST, PREFERRED_LOCAL_PORT)
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

/// Serves a generated game build to this machine and the local network.
/// Unlike `serve_build`, this intentionally binds all interfaces; callers
/// should only pass a disposable/generated build directory, never a project
/// root. The returned LAN URL is best-effort because a machine can be offline
/// or have several VPN/network adapters with no single obvious address.
#[tauri::command]
pub fn serve_build_lan(
    state: tauri::State<'_, PreviewState>,
    dir: String,
) -> Result<PreviewUrls, String> {
    let root = std::fs::canonicalize(&dir).map_err(|e| format!("{dir}: {e}"))?;
    if !root.is_dir() {
        return Err(format!("{dir} is not a directory"));
    }
    let key = root.to_string_lossy().into_owned();
    {
        let servers = state.lan_servers.lock().map_err(|e| e.to_string())?;
        if let Some(server) = servers.get(&key) {
            return Ok(preview_urls(server.local_port, server.lan_port));
        }
    }

    let lan_ip = local_lan_ipv4();
    let tls = preview_tls_config(lan_ip)?;
    let local_listener = bind_preferred(Ipv4Addr::LOCALHOST, PREFERRED_LOCAL_PORT)
        .map_err(|e| format!("could not start local preview server: {e}"))?;
    let local_port = local_listener
        .local_addr()
        .map_err(|e| e.to_string())?
        .port();
    let lan_listener = bind_preferred(Ipv4Addr::UNSPECIFIED, PREFERRED_LAN_TLS_PORT)
        .map_err(|e| format!("could not start LAN preview server: {e}"))?;
    let lan_port = lan_listener.local_addr().map_err(|e| e.to_string())?.port();
    local_listener
        .set_nonblocking(true)
        .map_err(|e| format!("configure local preview listener: {e}"))?;
    lan_listener
        .set_nonblocking(true)
        .map_err(|e| format!("configure LAN preview listener: {e}"))?;
    let stop = Arc::new(AtomicBool::new(false));
    state.lan_servers.lock().map_err(|e| e.to_string())?.insert(
        key,
        LanPreviewServer {
            local_port,
            lan_port,
            stop: stop.clone(),
        },
    );

    let local_root = root.clone();
    let local_stop = stop.clone();
    std::thread::spawn(move || {
        while !local_stop.load(Ordering::Relaxed) {
            match local_listener.accept() {
                Ok((stream, _)) => {
                    let root = local_root.clone();
                    std::thread::spawn(move || handle(stream, root));
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(_) => break,
            }
        }
    });
    let lan_stop = stop;
    std::thread::spawn(move || {
        while !lan_stop.load(Ordering::Relaxed) {
            match lan_listener.accept() {
                Ok((stream, _)) => {
                    let root = root.clone();
                    let tls = tls.clone();
                    std::thread::spawn(move || {
                        let Ok(connection) = ServerConnection::new(tls) else {
                            return;
                        };
                        handle(StreamOwned::new(connection, stream), root);
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(_) => break,
            }
        }
    });

    Ok(preview_urls(local_port, lan_port))
}

#[tauri::command]
pub fn stop_build_lan(state: tauri::State<'_, PreviewState>, dir: String) -> Result<bool, String> {
    let root = std::fs::canonicalize(&dir).map_err(|e| format!("{dir}: {e}"))?;
    let key = root.to_string_lossy().into_owned();
    let server = state
        .lan_servers
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&key);
    let Some(server) = server else {
        return Ok(false);
    };
    server.stop.store(true, Ordering::Relaxed);
    // Give the non-blocking listener loops time to release the preferred ports
    // before a rapid third click starts the server again.
    std::thread::sleep(Duration::from_millis(30));
    Ok(true)
}

fn preview_urls(local_port: u16, lan_port: u16) -> PreviewUrls {
    PreviewUrls {
        local_url: format!("http://localhost:{local_port}/"),
        lan_url: local_lan_ipv4().map(|ip| format!("https://{ip}:{lan_port}/")),
    }
}

fn bind_preferred(address: Ipv4Addr, preferred_port: u16) -> std::io::Result<TcpListener> {
    TcpListener::bind(SocketAddrV4::new(address, preferred_port))
        .or_else(|_| TcpListener::bind(SocketAddrV4::new(address, 0)))
}

fn preview_tls_config(lan_ip: Option<Ipv4Addr>) -> Result<Arc<ServerConfig>, String> {
    let mut names = vec!["localhost".to_string()];
    if let Some(ip) = lan_ip {
        names.push(ip.to_string());
    }
    let mut params = CertificateParams::new(names).map_err(|e| e.to_string())?;
    if let Some(ip) = lan_ip {
        params
            .subject_alt_names
            .push(SanType::IpAddress(IpAddr::V4(ip)));
    }
    let key = KeyPair::generate().map_err(|e| format!("generate preview TLS key: {e}"))?;
    let cert = params
        .self_signed(&key)
        .map_err(|e| format!("generate preview TLS certificate: {e}"))?;
    let private_key = PrivatePkcs8KeyDer::from(key.serialize_der()).into();
    let config = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(vec![cert.der().clone()], private_key)
        .map_err(|e| format!("configure preview TLS: {e}"))?;
    Ok(Arc::new(config))
}

fn local_lan_ipv4() -> Option<Ipv4Addr> {
    // UDP connect selects the adapter/route without sending a packet. It is a
    // compact, dependency-free way to find the address another device on the
    // current network can normally reach.
    let socket = UdpSocket::bind(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    match socket.local_addr().ok()?.ip() {
        std::net::IpAddr::V4(ip) if !ip.is_loopback() => Some(ip),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serves_index_for_directory_targets() {
        let root = Path::new("/srv");
        assert_eq!(
            resolve_request_path(root, "/").unwrap(),
            root.join("index.html")
        );
        assert_eq!(
            resolve_request_path(root, "/sub/").unwrap(),
            root.join("sub").join("index.html")
        );
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

    #[test]
    fn prepares_a_native_temporary_preview_directory() {
        let project = std::env::temp_dir().join("three-engine-preview-project-test");
        std::fs::create_dir_all(&project).unwrap();
        let dir = prepare_browser_preview(project.to_string_lossy().into_owned()).unwrap();
        let path = Path::new(&dir);
        assert!(path.is_dir());
        assert!(path.ends_with(format!("{:016x}", {
            let root = std::fs::canonicalize(&project).unwrap();
            let mut hasher = DefaultHasher::new();
            root.hash(&mut hasher);
            hasher.finish()
        })));
        let _ = std::fs::remove_dir_all(project);
    }

    #[test]
    fn builds_lan_tls_config_for_an_ip_address() {
        // Exercise crypto-provider selection and the certificate's IP SAN.
        // Both would otherwise fail only when Open in browser is pressed.
        assert!(preview_tls_config(Some(Ipv4Addr::new(192, 168, 1, 42))).is_ok());
    }
}
