use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::Path;
use tauri::Manager;

mod mcp_clients;
mod preview;
mod pty;

#[derive(Serialize)]
struct BasisCompressionInfo {
    original: u64,
    compressed: u64,
}

/// Encodes a source image to an ETC1S Basis Universal KTX2 derivative.
/// The source remains untouched; runtime loading selects `<source>.basis`
/// through the image's metadata and can always fall back to the original.
#[tauri::command]
async fn compress_texture_basis(
    app: tauri::AppHandle,
    path: String,
) -> Result<BasisCompressionInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let exe_name = if cfg!(windows) {
            "basisu.exe"
        } else {
            "basisu"
        };
        let platform_dir = match (std::env::consts::OS, std::env::consts::ARCH) {
            ("windows", "x86_64") => "win32-x64",
            ("linux", "x86_64") => "linux-x64",
            ("linux", "aarch64") => "linux-arm64",
            ("macos", "x86_64") => "darwin-x64",
            ("macos", "aarch64") => "darwin-arm64",
            (os, arch) => return Err(format!("Basis encoder unsupported on {os}/{arch}")),
        };
        let mut candidates = vec![
            Path::new("../node_modules/@gpu-tex-enc/basis/bin")
                .join(platform_dir)
                .join(exe_name),
            Path::new("node_modules/@gpu-tex-enc/basis/bin")
                .join(platform_dir)
                .join(exe_name),
        ];
        if let Ok(resources) = app.path().resource_dir() {
            candidates.insert(
                0,
                resources
                    .join("basisu/bin")
                    .join(platform_dir)
                    .join(exe_name),
            );
        }
        let encoder = candidates
            .into_iter()
            .find(|candidate| candidate.exists())
            .ok_or("Basis encoder resource not found")?;

        let output_path = format!("{path}.basis");
        let result = std::process::Command::new(&encoder)
            .args([
                path.as_str(),
                "-ktx2",
                "-mipmap",
                "-linear",
                "-q",
                "180",
                "-output_file",
                output_path.as_str(),
            ])
            .output()
            .map_err(|e| format!("start {}: {e}", encoder.display()))?;
        if !result.status.success() {
            let stderr = String::from_utf8_lossy(&result.stderr);
            let stdout = String::from_utf8_lossy(&result.stdout);
            return Err(format!("basisu failed: {}{}", stdout, stderr));
        }

        Ok(BasisCompressionInfo {
            original: fs::metadata(&path).map_err(|e| e.to_string())?.len(),
            compressed: fs::metadata(&output_path).map_err(|e| e.to_string())?.len(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn save_scene(path: String, contents: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, contents).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_scene(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[derive(Serialize)]
struct DirEntryInfo {
    name: String,
    path: String,
    is_dir: bool,
    ext: String,
    /// File size in bytes (0 for directories), shown in the Assets details view.
    size: u64,
    /// Last-modified time in seconds since the Unix epoch (0 if unavailable).
    modified: f64,
}

/// Lists the immediate children of `path` (directories first, then files, both A-Z).
#[tauri::command]
fn list_dir(path: String) -> Result<Vec<DirEntryInfo>, String> {
    let mut entries = Vec::new();
    for entry in fs::read_dir(&path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let ext = Path::new(&name)
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let meta = entry.metadata().ok();
        let is_dir = file_type.is_dir();
        let size = match (&meta, is_dir) {
            (Some(m), false) => m.len(),
            _ => 0,
        };
        let modified = meta
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs_f64())
            .unwrap_or(0.0);
        entries.push(DirEntryInfo {
            name,
            path: entry.path().to_string_lossy().into_owned(),
            is_dir,
            ext,
            size,
            modified,
        });
    }
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(entries)
}

/// Reads a file's raw bytes, for feeding into blob URLs (models, textures).
///
/// Returns a `tauri::ipc::Response` rather than `Vec<u8>` on purpose: a plain
/// `Vec<u8>` return value is serialized to the frontend as a JSON array of
/// numbers, which for a multi-MB model means shipping (and parsing) tens of
/// millions of JSON tokens — 15-20s of stall on a large `.glb`. `Response`
/// travels over the raw IPC channel as bytes, and `invoke` resolves it to an
/// `ArrayBuffer` on the JS side, which we wrap in a Blob directly.
#[tauri::command]
fn read_binary_file(path: String) -> Result<tauri::ipc::Response, String> {
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Reads only the beginning of a binary file. Importers use this to validate
/// very large source assets before allocating/copying the complete payload.
#[tauri::command]
fn read_binary_file_head(path: String, max_bytes: u64) -> Result<tauri::ipc::Response, String> {
    let file = fs::File::open(&path).map_err(|e| e.to_string())?;
    let mut bytes = Vec::with_capacity(max_bytes.min(64 * 1024) as usize);
    file.take(max_bytes)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
fn file_size(path: String) -> Result<u64, String> {
    fs::metadata(path)
        .map(|metadata| metadata.len())
        .map_err(|e| e.to_string())
}

/// Reads a file as UTF-8 text (script source).
#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Last-modified time in fractional seconds since the Unix epoch, used to
/// detect script file changes for hot reload without a filesystem watcher.
#[tauri::command]
fn stat_file(path: String) -> Result<f64, String> {
    let modified = fs::metadata(&path)
        .map_err(|e| e.to_string())?
        .modified()
        .map_err(|e| e.to_string())?;
    let duration = modified
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?;
    Ok(duration.as_secs_f64())
}

/// Recursively copies `src` into `dst`, returning the number of files written.
fn copy_dir(src: &Path, dst: &Path) -> std::io::Result<u64> {
    fs::create_dir_all(dst)?;
    let mut copied = 0;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let dest = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copied += copy_dir(&entry.path(), &dest)?;
        } else {
            copied += copy_file_if_changed(&entry.path(), &dest)? as u64;
        }
    }
    Ok(copied)
}

/// Copies one file unless the destination is already at least as new and has
/// the same byte length. Browser preview rebuilds run frequently; avoiding
/// unchanged multi-megabyte geometry/texture copies is what keeps them quick.
fn copy_file_if_changed(src: &Path, dest: &Path) -> std::io::Result<bool> {
    let source_meta = fs::metadata(src)?;
    if let Ok(dest_meta) = fs::metadata(dest) {
        let source_modified = source_meta.modified().ok();
        let dest_modified = dest_meta.modified().ok();
        if source_meta.len() == dest_meta.len()
            && matches!((source_modified, dest_modified), (Some(s), Some(d)) if d >= s)
        {
            return Ok(false);
        }
    }
    replace_atomically(dest, |staging| {
        fs::copy(src, staging).map(|_| ())
    })?;
    Ok(true)
}

/// Produces `dest` via a sibling temporary file and a rename, so a reader never
/// observes a half-written file.
///
/// THIS MATTERS BECAUSE THE BUILD OUTPUT IS SERVED WHILE IT IS BEING WRITTEN.
/// Browser preview keeps a live-rebuild loop pointed at the same directory the
/// preview server hands to the browser (and to a phone over Wi-Fi), so an
/// in-place `fs::copy`/`fs::write` is a window in which a fetch can read a
/// truncated texture — or, far worse, a truncated `scene.json`, which every
/// client fetches and which fails the whole boot rather than one asset.
/// A rename on the same volume is atomic on both Windows and Unix.
fn replace_atomically(
    dest: &Path,
    write: impl FnOnce(&Path) -> std::io::Result<()>,
) -> std::io::Result<()> {
    let staging = dest.with_extension(format!(
        "{}tmp-{}",
        dest.extension()
            .and_then(|e| e.to_str())
            .map(|e| format!("{e}."))
            .unwrap_or_default(),
        std::process::id()
    ));
    write(&staging)?;
    match fs::rename(&staging, dest) {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = fs::remove_file(&staging);
            Err(error)
        }
    }
}

/// Copies the bundled three.js type declarations (`@types/three`) into
/// `dest_dir`, so a project's IDE can resolve `import * as THREE from "three"`
/// while editing gameplay scripts. Returns the number of files written.
///
/// The declarations are a bundle resource rather than something generated or
/// downloaded: scripting has to work in a packaged app with no Node toolchain
/// and no network. `@types/three` is version-locked to the engine's `three` in
/// package.json, so what a script sees while editing is what the runtime
/// actually exposes.
///
/// Resolution order mirrors `compress_texture_basis`: the packaged resource
/// directory first, then the two dev-time `node_modules` locations (the Tauri
/// dev cwd is `src-tauri`, so both `../node_modules` and `node_modules` are
/// worth trying). Callers version-gate this — it is ~1000 small files, cheap
/// but not free, and only changes when the engine's three version does.
#[tauri::command]
fn scaffold_three_types(app: tauri::AppHandle, dest_dir: String) -> Result<u64, String> {
    let mut candidates = vec![
        Path::new("../node_modules/@types/three").to_path_buf(),
        Path::new("node_modules/@types/three").to_path_buf(),
    ];
    if let Ok(resources) = app.path().resource_dir() {
        candidates.insert(0, resources.join("engine-types/three"));
    }
    let src = candidates
        .into_iter()
        .find(|candidate| candidate.join("package.json").exists())
        .ok_or("Bundled three.js type declarations not found")?;
    copy_dir(&src, Path::new(&dest_dir)).map_err(|e| e.to_string())
}

/// Locates the prebuilt player template (`dist-player/`).
///
/// The packaged resource directory comes first: in a shipped editor there is
/// no repo checkout and no `npm run build:player` to run, so the template has
/// to travel inside the app bundle. The two `dist-player` entries are the
/// dev-time fallbacks — `tauri dev` runs with cwd `src-tauri`, so the sibling
/// path is the one that usually hits, and the bare one covers running the
/// binary from the repo root.
fn player_template_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let mut candidates = vec![
        Path::new("../dist-player").to_path_buf(),
        Path::new("dist-player").to_path_buf(),
    ];
    if let Ok(resources) = app.path().resource_dir() {
        candidates.insert(0, resources.join("dist-player"));
    }
    let candidate = candidates
        .into_iter()
        .find(|p| p.join("index.html").exists())
        .ok_or_else(|| {
            "Player template not found — run `npm run build:player` first".to_string()
        })?;
    // Native dialogs and plugins may change the process working directory.
    // Resolve the dev fallback now so the later recursive copy cannot lose it.
    fs::canonicalize(&candidate)
        .map_err(|e| format!("resolve player template {}: {e}", candidate.display()))
}

/// Reads one file out of the player template (the exporter rewrites
/// `index.html` for the game's title, icon and loading-screen colours).
#[tauri::command]
fn read_player_template(app: tauri::AppHandle, rel: String) -> Result<String, String> {
    // Refuse anything that could climb out of the template directory: this
    // takes a path from the frontend and the answer is handed straight back.
    if rel.contains("..") || Path::new(&rel).is_absolute() {
        return Err(format!("invalid template path: {rel}"));
    }
    let dir = player_template_dir(&app)?;
    fs::read_to_string(dir.join(&rel)).map_err(|e| format!("read {rel}: {e}"))
}

/// Copies the prebuilt player template into `out_dir`, writes scene.json,
/// and copies referenced assets to their relative destinations.
#[tauri::command]
fn export_game(
    app: tauri::AppHandle,
    out_dir: String,
    scene_json: String,
    assets: Vec<(String, String)>,
    files: Vec<(String, String)>,
) -> Result<(), String> {
    let player = player_template_dir(&app)?;
    let out = Path::new(&out_dir);
    copy_dir(&player, out).map_err(|e| {
        format!(
            "copy player template {} to {}: {e}",
            player.display(),
            out.display()
        )
    })?;
    let scene_path = out.join("scene.json");
    // Atomic: a live browser preview is serving this exact file while the
    // rebuild runs (see replace_atomically).
    replace_atomically(&scene_path, |staging| fs::write(staging, &scene_json))
        .map_err(|e| format!("write {}: {e}", scene_path.display()))?;
    for (src, rel) in assets {
        let dest = out.join(&rel);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("create asset directory {}: {e}", parent.display()))?;
        }
        copy_file_if_changed(Path::new(&src), &dest)
            .map_err(|e| format!("copy asset {src} to {}: {e}", dest.display()))?;
    }
    for (rel, contents) in files {
        let dest = out.join(&rel);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| {
                format!("create generated-file directory {}: {e}", parent.display())
            })?;
        }
        replace_atomically(&dest, |staging| fs::write(staging, &contents))
            .map_err(|e| format!("write generated file {}: {e}", dest.display()))?;
    }
    Ok(())
}

/// Zips a directory's contents with the directory itself as the *root* of the
/// archive, not as a folder inside it.
///
/// That distinction is the whole reason this exists: itch.io serves
/// `index.html` from the top level of the uploaded zip and shows a blank page
/// (with no diagnosis) when it finds `MyGame/index.html` instead. Every
/// "my HTML5 game doesn't work on itch" thread ends here.
#[tauri::command]
fn zip_dir(dir: String, dest: String) -> Result<u64, String> {
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    let root = Path::new(&dir);
    if !root.is_dir() {
        return Err(format!("{dir} is not a directory"));
    }
    let file = fs::File::create(&dest).map_err(|e| format!("create {dest}: {e}"))?;
    // The archive is created before the walk, so an archive written *into* the
    // directory being archived would otherwise add itself — a zip containing a
    // half-written copy of itself, growing as it goes. Callers put the archive
    // beside the build, but this is cheap insurance against the day one
    // doesn't.
    let dest_canonical = fs::canonicalize(&dest).ok();
    let mut zip = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let mut written = 0u64;

    for entry in walkdir::WalkDir::new(root)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        let Ok(rel) = path.strip_prefix(root) else {
            continue;
        };
        if rel.as_os_str().is_empty() {
            continue;
        }
        // Zip entries always use forward slashes, whatever the host OS does.
        let name = rel.to_string_lossy().replace('\\', "/");
        if entry.file_type().is_dir() {
            zip.add_directory(format!("{name}/"), options)
                .map_err(|e| e.to_string())?;
            continue;
        }
        if dest_canonical.is_some() && fs::canonicalize(path).ok() == dest_canonical {
            continue;
        }
        let bytes = fs::read(path).map_err(|e| format!("read {name}: {e}"))?;
        zip.start_file(&name, options).map_err(|e| e.to_string())?;
        zip.write_all(&bytes).map_err(|e| e.to_string())?;
        written += bytes.len() as u64;
    }
    zip.finish().map_err(|e| e.to_string())?;
    Ok(written)
}

/// Creates a directory (and any missing parents).
#[tauri::command]
fn create_dir(path: String) -> Result<(), String> {
    fs::create_dir_all(&path).map_err(|e| e.to_string())
}

/// Renames or moves a file/directory. Refuses to clobber an existing target.
#[tauri::command]
fn rename_path(from: String, to: String) -> Result<(), String> {
    if Path::new(&to).exists() {
        return Err(format!("\"{to}\" already exists"));
    }
    fs::rename(&from, &to).map_err(|e| e.to_string())
}

/// Deletes a file or directory (recursively).
#[tauri::command]
fn delete_path(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.is_dir() {
        fs::remove_dir_all(p).map_err(|e| e.to_string())
    } else {
        fs::remove_file(p).map_err(|e| e.to_string())
    }
}

/// Copies external files/folders (OS drag-drop import) into `dest_dir`,
/// uniquifying names instead of clobbering. Returns the created paths.
#[tauri::command]
fn import_files(paths: Vec<String>, dest_dir: String) -> Result<Vec<String>, String> {
    let dest_root = Path::new(&dest_dir);
    fs::create_dir_all(dest_root).map_err(|e| e.to_string())?;
    let mut imported = Vec::new();
    for src in paths {
        let src_path = Path::new(&src);
        let name = src_path
            .file_name()
            .ok_or_else(|| format!("bad path: {src}"))?
            .to_string_lossy()
            .into_owned();
        let stem = Path::new(&name)
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| name.clone());
        let ext = Path::new(&name)
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy()))
            .unwrap_or_default();
        let mut dest = dest_root.join(&name);
        for i in 1.. {
            if !dest.exists() {
                break;
            }
            dest = dest_root.join(format!("{stem} {i}{ext}"));
        }
        if src_path.is_dir() {
            copy_dir(src_path, &dest).map_err(|e| e.to_string())?;
        } else {
            fs::copy(src_path, &dest).map_err(|e| format!("copy {src}: {e}"))?;
        }
        imported.push(dest.to_string_lossy().into_owned());
    }
    Ok(imported)
}

/// Lets the frontend surface messages in the dev terminal (WebView console
/// output is otherwise invisible during `tauri dev`).
#[tauri::command]
fn write_binary_file(path: String, contents: Vec<u8>) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, contents).map_err(|e| e.to_string())
}

/// Decodes `%XX` escapes produced by JavaScript's `encodeURIComponent`.
///
/// The destination path travels as an IPC *header*, which may only contain
/// visible ASCII — project paths routinely hold spaces and non-ASCII
/// characters, so the frontend percent-encodes it and we reverse that here.
fn percent_decode(value: &str) -> Result<String, String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes
                .get(i + 1..i + 3)
                .ok_or_else(|| "truncated percent escape in path".to_string())?;
            let hex = std::str::from_utf8(hex).map_err(|e| e.to_string())?;
            out.push(u8::from_str_radix(hex, 16).map_err(|e| e.to_string())?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|e| e.to_string())
}

/// Writes raw bytes taken straight off the IPC channel.
///
/// The sibling `write_binary_file` takes `contents: Vec<u8>`, which Tauri
/// serializes as a JSON array of numbers — roughly 4 bytes of text per payload
/// byte, plus a full JSON parse on the Rust side. For the things that actually
/// need this command (extracted textures, binary `.geom` buffers) that turned a
/// 40MB write into hundreds of megabytes of JSON and many seconds of stall.
///
/// A `Request` with a raw body skips the encoding entirely: the frontend calls
/// `invoke(cmd, uint8Array, { headers: { path: encodeURIComponent(path) } })`
/// and the bytes arrive as-is. Mirrors `read_binary_file`, which already
/// returns `tauri::ipc::Response` for the same reason.
#[tauri::command]
fn write_binary_file_raw(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let path = request
        .headers()
        .get("path")
        .ok_or_else(|| "write_binary_file_raw: missing `path` header".to_string())?
        .to_str()
        .map_err(|e| e.to_string())?;
    let path = percent_decode(path)?;
    let tauri::ipc::InvokeBody::Raw(contents) = request.body() else {
        return Err("write_binary_file_raw: expected a raw byte body".to_string());
    };
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, contents).map_err(|e| e.to_string())
}

#[tauri::command]
fn frontend_log(message: String) {
    println!("[frontend] {message}");
}

/// Fallback for Windows machines where the opener plugin cannot resolve the
/// default-browser association (it reports os error 3 even for a valid URL).
/// Restricted to the preview server on localhost so this is not a general
/// frontend-controlled process launcher.
#[tauri::command]
fn open_browser_url(url: String) -> Result<(), String> {
    validate_browser_preview_url(&url)?;

    #[cfg(target_os = "windows")]
    let mut command = std::process::Command::new("explorer.exe");
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = std::process::Command::new("xdg-open");

    command
        .arg(&url)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("could not launch the system browser: {e}"))
}

fn validate_browser_preview_url(value: &str) -> Result<(), String> {
    let parsed = url::Url::parse(value).map_err(|e| format!("invalid preview URL: {e}"))?;
    if parsed.scheme() == "http"
        && parsed.host_str() == Some("localhost")
        && parsed.port().is_some()
    {
        Ok(())
    } else {
        Err("browser fallback only opens the localhost preview server".to_string())
    }
}

/// Proxies a GET request to `url` and returns the response body as UTF-8 text.
/// Used by the AmbientCG asset browser: `ambientcg.com`'s API and download
/// endpoints don't send CORS headers, so a direct `fetch` from the webview
/// fails with "Failed to fetch". Routing through Rust bypasses the browser
/// sandbox and lets the engine read the catalog. `User-Agent` is required:
/// ambientCG returns a 403 to the default libcurl UA, and the redirect
/// target (`acg-download.struffelproductions.com`) refuses empty UAs too.
#[tauri::command]
async fn fetch_text(url: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let original = url.clone();
        let mut current = url;
        // Follow up to 5 hops manually — `ureq`'s default of 5 covers the
        // ambientCG case (`/get?file=…` 302s to the CDN). We re-parse after
        // each hop because ureq doesn't expose the redirect target as a URL.
        for _ in 0..5 {
            let resp = ureq::get(&current)
                .set(
                    "User-Agent",
                    "three-engine/0.1 (+https://github.com/three-engine)",
                )
                .set("Accept", "application/json,text/html;q=0.9,*/*;q=0.5")
                .call()
                .map_err(|e| format!("fetch {current}: {e}"))?;
            if resp.status() >= 300 && resp.status() < 400 {
                let loc = resp
                    .header("Location")
                    .ok_or_else(|| format!("redirect from {current} with no Location"))?;
                current = if loc.starts_with("http://") || loc.starts_with("https://") {
                    loc.to_string()
                } else {
                    // relative redirect — resolve against current
                    let base =
                        url::Url::parse(&current).map_err(|e| format!("bad url {current}: {e}"))?;
                    base.join(&loc)
                        .map_err(|e| format!("resolve {loc}: {e}"))?
                        .to_string()
                };
                continue;
            }
            return resp.into_string().map_err(|e| format!("read body: {e}"));
        }
        Err(format!("too many redirects for {original}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Proxies a GET request and returns the raw response body bytes.
/// Same CORS rationale as `fetch_text`: ambientCG's ZIP endpoint 302s to
/// `acg-download.struffelproductions.com` which also refuses direct browser
/// fetches. Returning bytes via `tauri::ipc::Response` ships them over the
/// raw IPC channel (no JSON serialisation), so the frontend gets an
/// `ArrayBuffer` it can hand straight to JSZip. ZIPs are typically a few MB,
/// well within memory.
#[tauri::command]
async fn fetch_bytes(url: String) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let original = url.clone();
        let mut current = url;
        for _ in 0..5 {
            let resp = ureq::get(&current)
                .set(
                    "User-Agent",
                    "three-engine/0.1 (+https://github.com/three-engine)",
                )
                .call()
                .map_err(|e| format!("fetch {current}: {e}"))?;
            if resp.status() >= 300 && resp.status() < 400 {
                let loc = resp
                    .header("Location")
                    .ok_or_else(|| format!("redirect from {current} with no Location"))?;
                current = if loc.starts_with("http://") || loc.starts_with("https://") {
                    loc.to_string()
                } else {
                    let base =
                        url::Url::parse(&current).map_err(|e| format!("bad url {current}: {e}"))?;
                    base.join(&loc)
                        .map_err(|e| format!("resolve {loc}: {e}"))?
                        .to_string()
                };
                continue;
            }
            let mut buf = Vec::new();
            resp.into_reader()
                .read_to_end(&mut buf)
                .map_err(|e| format!("read body: {e}"))?;
            return Ok(tauri::ipc::Response::new(buf));
        }
        Err(format!("too many redirects for {original}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Sketchfab's public catalog is readable without a token, while its download
/// endpoint requires the current user's OAuth/API token. Keep the credential
/// out of browser fetches and refuse non-Sketchfab hosts so it cannot be sent
/// to an arbitrary URL. OAuth tokens use `Bearer`; legacy personal API tokens
/// use `Token`, so a 401 retries once with the latter scheme.
#[tauri::command]
async fn fetch_sketchfab_text(url: String, token: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let parsed = url::Url::parse(&url).map_err(|e| format!("bad Sketchfab URL: {e}"))?;
        if parsed.scheme() != "https" || parsed.host_str() != Some("api.sketchfab.com") {
            return Err("Sketchfab API requests must use https://api.sketchfab.com".to_string());
        }

        let request = |scheme: &str| {
            let mut req = ureq::get(&url)
                .set("User-Agent", "three-engine/0.1")
                .set("Accept", "application/json");
            if let Some(value) = token.as_deref().filter(|value| !value.is_empty()) {
                req = req.set("Authorization", &format!("{scheme} {value}"));
            }
            req.call()
        };

        let response = match request("Bearer") {
            Err(ureq::Error::Status(401, _)) if token.is_some() => request("Token"),
            result => result,
        }
        .map_err(|e| format!("Sketchfab API: {e}"))?;
        response
            .into_string()
            .map_err(|e| format!("read Sketchfab response: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::{percent_decode, validate_browser_preview_url, zip_dir};
    use std::fs;

    #[test]
    fn decodes_paths_the_frontend_encodes() {
        // What `encodeURIComponent` produces for a Windows project path with a
        // space and a non-ASCII character — the reason the path is encoded at
        // all is that IPC headers may only carry visible ASCII.
        assert_eq!(
            percent_decode("C%3A%2FUsers%2FA%20B%2FCaf%C3%A9%2Fmesh.geom").unwrap(),
            "C:/Users/A B/Café/mesh.geom"
        );
        assert_eq!(percent_decode("plain.png").unwrap(), "plain.png");
        assert!(percent_decode("truncated%2").is_err());
    }

    #[test]
    fn browser_fallback_only_accepts_local_preview_urls() {
        assert!(validate_browser_preview_url("http://localhost:41234/").is_ok());
        assert!(validate_browser_preview_url("https://localhost:41234/").is_err());
        assert!(validate_browser_preview_url("http://example.com:41234/").is_err());
        assert!(validate_browser_preview_url("C:/preview/index.html").is_err());
    }

    /// itch.io serves whatever sits at the top of the uploaded archive. A zip
    /// containing `MyGame/index.html` produces a blank page with no error, and
    /// it is the single most common way an HTML5 upload fails — so the entries
    /// must be relative to the directory, not include it.
    #[test]
    fn zips_with_the_build_at_the_archive_root() {
        let base = std::env::temp_dir().join("three-engine-zip-test");
        let _ = fs::remove_dir_all(&base);
        let src = base.join("MyGame");
        fs::create_dir_all(src.join("assets")).unwrap();
        fs::write(src.join("index.html"), "<!doctype html>").unwrap();
        fs::write(src.join("assets").join("a.png"), [1u8, 2, 3]).unwrap();
        let dest = base.join("out.zip");

        let written = zip_dir(
            src.to_string_lossy().into_owned(),
            dest.to_string_lossy().into_owned(),
        )
        .unwrap();
        assert_eq!(written, 15 + 3);

        let file = fs::File::open(&dest).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let names: Vec<String> = (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_string())
            .collect();
        assert!(names.contains(&"index.html".to_string()), "{names:?}");
        assert!(names.contains(&"assets/a.png".to_string()), "{names:?}");
        assert!(
            !names.iter().any(|n| n.starts_with("MyGame")),
            "the directory itself must not be in the archive: {names:?}"
        );

        let _ = fs::remove_dir_all(&base);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // Live PTY sessions for the terminal panel, keyed by panel id.
        .manage(pty::PtyState::default())
        // Loopback static servers for previewing exported builds.
        .manage(preview::PreviewState::default())
        .invoke_handler(tauri::generate_handler![
            save_scene,
            load_scene,
            list_dir,
            read_binary_file,
            read_binary_file_head,
            file_size,
            read_text_file,
            stat_file,
            create_dir,
            rename_path,
            delete_path,
            import_files,
            export_game,
            read_player_template,
            zip_dir,
            preview::serve_build,
            preview::serve_build_lan,
            preview::stop_build_lan,
            preview::prepare_browser_preview,
            scaffold_three_types,
            write_binary_file,
            write_binary_file_raw,
            compress_texture_basis,
            frontend_log,
            open_browser_url,
            fetch_text,
            fetch_bytes,
            fetch_sketchfab_text,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_alive,
            mcp_clients::mcp_client_status,
            mcp_clients::mcp_client_register,
            mcp_clients::mcp_client_unregister,
            mcp_clients::detect_terminal_programs
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
