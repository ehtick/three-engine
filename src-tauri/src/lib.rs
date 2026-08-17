use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use tauri::Manager;

mod agent;
mod git;
mod mcp_clients;
mod preview;
mod pty;
mod publish;
mod share;
mod watcher;

#[derive(Serialize)]
struct BasisCompressionInfo {
    original: u64,
    compressed: u64,
}

/// Encodes a source image to a Basis Universal KTX2 derivative.
/// The source remains untouched; runtime loading selects `<source>.basis`
/// through the image's metadata and can always fall back to the original.
///
/// ── `mode` IS NOT COSMETIC (plan §12.78) ──────────────────────────────────
///
/// This command used to take a path and nothing else, and hardcoded
/// `-linear -q 180` for every image. Both halves of that were wrong, in
/// opposite directions, and between them they damaged a whole asset set:
///
///   * ETC1S is a PERCEPTUAL COLOUR codec. Pointed at a metal-rough map it
///     crushed the metalness channel to ~0 at thread scale while the source
///     PNG histogrammed fine (mean 0.072, 31% of texels > 0.06) — dead
///     reflections that no SSR threshold could find. Never ETC1S a data map.
///   * `-linear` on an sRGB map is the mirror mistake. basisu's own help:
///     textures are converted sRGB→linear before mipmap filtering and back
///     again *unless* `-linear` is passed, which also swaps the codec's sRGB
///     error metric for a linear one. So every compressed albedo was
///     mip-filtered in the wrong space with its bits spent against the wrong
///     metric.
///
/// The caller picks from the asset's own metadata — see `basisModeFor` in
/// `basisCompress.js`; `colorSpace` has been in every `.meta` since import.
///
///   "srgb"   — albedo, emissive, any colour map. ETC1S, sRGB metrics.
///   "linear" — ORM / roughness / metalness / AO. UASTC, linear metrics.
///   "normal" — tangent-space normals. UASTC with the encoder's normal tuning
///              (`-normal_map` sets linear metrics, linear mip filtering, no
///              selector RDO and no sRGB in one flag).
///
/// UASTC RDO is deliberately NOT enabled. RDO trades quality for LZ size, and
/// UASTC transcodes to BC7 either way — so it would shrink the file on disk
/// and buy nothing in VRAM, while giving back exactly the precision this
/// change exists to restore. KTX2 still Zstd-compresses UASTC payloads.
#[tauri::command]
async fn compress_texture_basis(
    app: tauri::AppHandle,
    path: String,
    mode: Option<String>,
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
        // Unknown / absent mode falls back to "srgb": it is the common case and
        // it is the one the old invocation got wrong. A data map reaching here
        // unlabelled is a caller bug, and an ETC1S data map is loud (dead
        // reflections) rather than silent, which is the failure we want.
        let mode = mode.as_deref().unwrap_or("srgb");
        let mut args: Vec<&str> = vec![path.as_str(), "-ktx2", "-mipmap"];
        match mode {
            "linear" => args.extend_from_slice(&["-linear", "-uastc", "-uastc_level", "2"]),
            "normal" => args.extend_from_slice(&["-normal_map", "-uastc", "-uastc_level", "2"]),
            // `-q` is an ETC1S-only knob and is ignored under `-uastc`.
            _ => args.extend_from_slice(&["-q", "180"]),
        }
        args.extend_from_slice(&["-output_file", output_path.as_str()]);
        let result = std::process::Command::new(&encoder)
            .args(&args)
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
    watcher::note_self_write(&path);
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

#[derive(Serialize)]
struct TextFileEntry {
    path: String,
    contents: String,
}

/// Reads every file under `root` whose name ends with `suffix`, recursively.
///
/// This exists for exactly one caller — feeding the in-editor code editor's
/// TypeScript service the project's vendored `@types/three`, which is ~970
/// `.d.ts` files. Doing that as one `read_text_file` per file means ~970 IPC
/// round trips and several seconds of stall before autocomplete knows what a
/// `Vector3` is; doing it here is one round trip and a few tens of
/// milliseconds, because the cost was never the reading.
///
/// `max_files` and `max_bytes` are a guard against being pointed at a project
/// root by accident: the command stops early and reports what it read rather
/// than trying to serialize a whole disk.
#[tauri::command]
fn read_text_files(
    root: String,
    suffix: String,
    max_files: Option<usize>,
    max_bytes: Option<u64>,
) -> Result<Vec<TextFileEntry>, String> {
    let max_files = max_files.unwrap_or(4000);
    let max_bytes = max_bytes.unwrap_or(64 * 1024 * 1024);
    let mut out: Vec<TextFileEntry> = Vec::new();
    let mut total: u64 = 0;
    let mut stack = vec![PathBuf::from(&root)];
    while let Some(dir) = stack.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            // A missing subdirectory is not an error worth failing the whole
            // read for — the caller wants whatever declarations exist.
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            if out.len() >= max_files || total >= max_bytes {
                return Ok(out);
            }
            let path = entry.path();
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                stack.push(path);
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.ends_with(&suffix) {
                continue;
            }
            if let Ok(contents) = fs::read_to_string(&path) {
                total += contents.len() as u64;
                out.push(TextFileEntry {
                    path: path.to_string_lossy().into_owned(),
                    contents,
                });
            }
        }
    }
    Ok(out)
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
    copy_dir_tracking(src, dst, "", &mut Vec::new(), &std::collections::HashSet::new())
}

/// `copy_dir`, but records the destination-relative path of every file that
/// was actually (re)written, and skips anything in `exclude`. The live
/// preview's hot-update client decides between an in-place refresh and a full
/// page reload based on WHAT a rebuild touched — a runtime file from the
/// player template in this list means "new engine code, reload the page".
///
/// `exclude` exists because the exporter REGENERATES some template files
/// (index.html gets themed + the preview client injected). Copying the raw
/// template over the themed copy first meant every rebuild rewrote
/// index.html twice — and a manifest that says "index.html changed" on every
/// build downgrades every material tweak to a full page reload.
fn copy_dir_tracking(
    src: &Path,
    dst: &Path,
    prefix: &str,
    changed: &mut Vec<String>,
    exclude: &std::collections::HashSet<&str>,
) -> std::io::Result<u64> {
    fs::create_dir_all(dst)?;
    let mut copied = 0;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let rel = if prefix.is_empty() { name } else { format!("{prefix}/{name}") };
        let dest = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copied += copy_dir_tracking(&entry.path(), &dest, &rel, changed, exclude)?;
        } else if exclude.contains(rel.as_str()) {
            // The generated version is written (and diffed) by the caller.
        } else if copy_file_if_changed(&entry.path(), &dest)? {
            changed.push(rel);
            copied += 1;
        }
    }
    Ok(copied)
}

/// Writes `contents` to `dest` (atomically) only when the bytes differ,
/// returning whether a write happened. This is what keeps the live preview's
/// change manifest honest: a generated file re-emitted identically on every
/// rebuild must not read as "changed", or every material tweak would look
/// like a full scene edit to the hot-update client.
fn write_if_different(dest: &Path, contents: &[u8]) -> std::io::Result<bool> {
    if fs::read(dest).map(|old| old == contents).unwrap_or(false) {
        return Ok(false);
    }
    replace_atomically(dest, |staging| fs::write(staging, contents))?;
    Ok(true)
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
        // In a packaged app the bundled resource is the only copy, so it wins.
        // In `tauri dev` the resource dir ALSO exists (target/debug/, filled by
        // tauri-build at the last cargo relink) — and letting it win there
        // means `npm run build:player` updates ../dist-player while the editor
        // keeps serving the stale relink-time copy until the app restarts.
        // Dev must read the checkout it lives in.
        let index = if cfg!(debug_assertions) {
            candidates.len()
        } else {
            0
        };
        candidates.insert(index, resources.join("dist-player"));
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlayerTemplateStatus {
    template_dir: String,
    /// Epoch ms of the template's index.html — vite rewrites it every build,
    /// so its mtime IS the build time (no ISO-stamp parsing needed).
    built_at_ms: u64,
    /// Epoch ms of the newest file among the player bundle's inputs. 0 when
    /// there is no dev checkout to compare against.
    newest_source_ms: u64,
    /// The file that made the template stale, for diagnostics.
    newest_source_path: String,
    /// True when a dev checkout is reachable, i.e. `rebuild_player_template`
    /// can work. A packaged editor has no checkout and no npm.
    can_rebuild: bool,
    stale: bool,
}

fn epoch_ms(time: std::time::SystemTime) -> u64 {
    time.duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The repo checkout this editor is running from, if any. `tauri dev` runs
/// with cwd `src-tauri`; running the binary from the repo root is the other
/// dev shape. A packaged app matches neither.
fn player_checkout_root() -> Option<std::path::PathBuf> {
    ["..", "."]
        .iter()
        .map(Path::new)
        .find(|root| root.join("vite.player.config.js").exists() && root.join("src/player").exists())
        .and_then(|root| fs::canonicalize(root).ok())
}

/// Compares the prebuilt player template (dist-player/) against the source
/// that produces it. The template is what every export and browser preview
/// actually RUNS — engine edits that never make it into the template read as
/// "the served build behaves nothing like the editor" (it once ran a deleted
/// GI pipeline for a day). The preview flow polls this and rebuilds instead
/// of asking the user to remember `npm run build:player`.
#[tauri::command]
fn player_template_status(app: tauri::AppHandle) -> Result<PlayerTemplateStatus, String> {
    let template = player_template_dir(&app)?;
    let built_at_ms = fs::metadata(template.join("index.html"))
        .and_then(|m| m.modified())
        .map(epoch_ms)
        .unwrap_or(0);
    let Some(root) = player_checkout_root() else {
        return Ok(PlayerTemplateStatus {
            template_dir: template.to_string_lossy().into_owned(),
            built_at_ms,
            newest_source_ms: 0,
            newest_source_path: String::new(),
            can_rebuild: false,
            stale: false,
        });
    };
    let (newest_source_ms, newest_source_path) = newest_player_source(&root);
    Ok(PlayerTemplateStatus {
        template_dir: template.to_string_lossy().into_owned(),
        built_at_ms,
        newest_source_ms,
        newest_source_path,
        can_rebuild: true,
        stale: newest_source_ms > built_at_ms,
    })
}

/// Newest mtime (epoch ms) and path among the files the player bundle is
/// built from — deliberately NOT src/editor: the player ships no editor code,
/// and editor churn must not trigger a multi-second runtime rebuild.
fn newest_player_source(root: &Path) -> (u64, String) {
    let mut newest_ms = 0u64;
    let mut newest_path = String::new();
    let mut consider = |path: &Path| {
        let Ok(modified) = fs::metadata(path).and_then(|m| m.modified()) else {
            return;
        };
        let ms = epoch_ms(modified);
        if ms > newest_ms {
            newest_ms = ms;
            newest_path = path.to_string_lossy().into_owned();
        }
    };
    for file in ["player.html", "vite.player.config.js", "package.json"] {
        consider(&root.join(file));
    }
    for dir in ["src/engine", "src/player", "src/modules", "src/shared"] {
        for entry in walkdir::WalkDir::new(root.join(dir))
            .into_iter()
            .flatten()
            .filter(|e| e.file_type().is_file())
        {
            consider(entry.path());
        }
    }
    (newest_ms, newest_path)
}

/// Runs `npm run build:player` in the dev checkout so the served preview runs
/// runtime code as fresh as the engine source. Long (a full vite build) by
/// nature; callers surface progress text and await completion before
/// exporting, because vite empties dist-player/ mid-build and a concurrent
/// template copy would ship a half-written runtime.
#[tauri::command]
async fn rebuild_player_template() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        let root = player_checkout_root().ok_or(
            "No dev checkout found — a packaged editor cannot rebuild its player template",
        )?;
        let mut command = if cfg!(windows) {
            // npm on Windows is npm.cmd; cmd /C resolves it like a shell would.
            let mut c = std::process::Command::new("cmd");
            c.args(["/C", "npm", "run", "build:player"]);
            c
        } else {
            let mut c = std::process::Command::new("npm");
            c.args(["run", "build:player"]);
            c
        };
        #[cfg(windows)]
        {
            // CREATE_NO_WINDOW: never flash a console over the editor.
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        let output = command
            .current_dir(&root)
            .output()
            .map_err(|e| format!("run npm run build:player: {e}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            let detail = if stderr.trim().is_empty() { stdout } else { stderr };
            let tail = detail
                .lines()
                .rev()
                .take(12)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>()
                .join("\n");
            return Err(format!("npm run build:player failed:\n{tail}"));
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Copies the prebuilt player template into `out_dir`, writes scene.json,
/// and copies referenced assets to their relative destinations. Returns the
/// source paths of referenced assets that no longer exist on disk — a deleted
/// asset a scene still points at is the caller's warning to surface, not a
/// reason to refuse the whole build.
/// What one export actually did: which referenced sources no longer exist, and
/// which build-relative files were (re)written. `changed` feeds the live
/// preview's revision manifest so the browser can update in place instead of
/// reloading the whole page.
#[derive(Serialize)]
struct ExportGameReport {
    missing: Vec<String>,
    changed: Vec<String>,
}

#[tauri::command]
fn export_game(
    app: tauri::AppHandle,
    out_dir: String,
    scene_json: String,
    assets: Vec<(String, String)>,
    files: Vec<(String, String)>,
) -> Result<ExportGameReport, String> {
    let player = player_template_dir(&app)?;
    let out = Path::new(&out_dir);
    let mut changed = Vec::new();
    // Template files the exporter re-emits itself must not be copied raw
    // first — the copy and the regeneration would take turns rewriting them,
    // polluting the change manifest on every single rebuild.
    let generated: std::collections::HashSet<&str> =
        files.iter().map(|(rel, _)| rel.as_str()).collect();
    copy_dir_tracking(&player, out, "", &mut changed, &generated).map_err(|e| {
        format!(
            "copy player template {} to {}: {e}",
            player.display(),
            out.display()
        )
    })?;
    let scene_path = out.join("scene.json");
    // Atomic: a live browser preview is serving this exact file while the
    // rebuild runs (see replace_atomically).
    if write_if_different(&scene_path, scene_json.as_bytes())
        .map_err(|e| format!("write {}: {e}", scene_path.display()))?
    {
        changed.push("scene.json".into());
    }
    let mut missing = Vec::new();
    for (src, rel) in assets {
        let dest = out.join(&rel);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("create asset directory {}: {e}", parent.display()))?;
        }
        match copy_file_if_changed(Path::new(&src), &dest) {
            Ok(true) => changed.push(rel),
            Ok(false) => {}
            // Only a vanished source is survivable. Permission and disk
            // errors still fail: they would ship a silently incomplete build.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => missing.push(src),
            Err(e) => return Err(format!("copy asset {src} to {}: {e}", dest.display())),
        }
    }
    for (rel, contents) in files {
        let dest = out.join(&rel);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| {
                format!("create generated-file directory {}: {e}", parent.display())
            })?;
        }
        if write_if_different(&dest, contents.as_bytes())
            .map_err(|e| format!("write generated file {}: {e}", dest.display()))?
        {
            changed.push(rel);
        }
    }
    Ok(ExportGameReport { missing, changed })
}

/// Atomic sibling of `save_scene`, for files that are READ WHILE BEING
/// REWRITTEN — above all the live preview's revision manifest, which every
/// connected browser polls once a second while the exporter replaces it.
#[tauri::command]
fn write_file_atomic(path: String, contents: String) -> Result<(), String> {
    watcher::note_self_write(&path);
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    replace_atomically(Path::new(&path), |staging| fs::write(staging, &contents))
        .map_err(|e| e.to_string())
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
    watcher::note_self_write(&path);
    fs::create_dir_all(&path).map_err(|e| e.to_string())
}

/// Renames or moves a file/directory. Refuses to clobber an existing target.
#[tauri::command]
fn rename_path(from: String, to: String) -> Result<(), String> {
    if Path::new(&to).exists() {
        return Err(format!("\"{to}\" already exists"));
    }
    watcher::note_self_write(&from);
    watcher::note_self_write(&to);
    fs::rename(&from, &to).map_err(|e| e.to_string())
}

/// Deletes a file or directory (recursively).
#[tauri::command]
fn delete_path(path: String) -> Result<(), String> {
    watcher::note_self_write(&path);
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
    watcher::note_self_write(&path);
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
    watcher::note_self_write(&path);
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

/// itch.io's authenticated endpoints (owned library, uploads, download links)
/// live on `api.itch.io` and, like Sketchfab, don't send CORS headers, so a
/// direct browser fetch from the webview fails. Same shape as
/// `fetch_sketchfab_text`: a hardcoded host allowlist keeps the personal API
/// key from ever being attached to an arbitrary URL, and the key rides as a
/// `Bearer` header rather than through JS `fetch`. Unlike Sketchfab, itch.io
/// has one credential shape — API keys generated from account settings are
/// unscoped bearer tokens — so there's no OAuth/legacy scheme fallback to try.
///
/// Note for future maintenance: the owned-library (`/profile/owned-keys`),
/// per-game upload listing (`/games/{id}/uploads`) and download-link
/// (`/uploads/{id}/download`) endpoints are not part of itch.io's published
/// API reference — they're the same endpoints the official itch.io desktop
/// app calls, reverse-engineered by the community. They've been stable for
/// years but carry no compatibility guarantee; if itch.io ever changes their
/// shape, `src/editor/itchio.js` is where the field names live.
#[tauri::command]
async fn fetch_itchio_text(url: String, token: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let parsed = url::Url::parse(&url).map_err(|e| format!("bad itch.io URL: {e}"))?;
        if parsed.scheme() != "https" || parsed.host_str() != Some("api.itch.io") {
            return Err("itch.io API requests must use https://api.itch.io".to_string());
        }

        let mut req = ureq::get(&url)
            .set("User-Agent", "three-engine/0.1")
            .set("Accept", "application/json");
        if let Some(value) = token.as_deref().filter(|value| !value.is_empty()) {
            req = req.set("Authorization", &format!("Bearer {value}"));
        }
        let response = req.call().map_err(|e| format!("itch.io API: {e}"))?;
        response
            .into_string()
            .map_err(|e| format!("read itch.io response: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Freesound's `apiv2` JSON endpoints. Freesound *does* send
/// `Access-Control-Allow-Origin: *`, so unlike Sketchfab/itch.io this isn't a
/// CORS workaround — it exists so the personal API key is attached
/// server-side and never reaches JS `fetch`, with the same hardcoded host
/// allowlist keeping it from leaking to an arbitrary URL.
///
/// Only the JSON API needs this. Verified against the live CDN: sound
/// previews (`cdn.freesound.org/previews/…`) and waveform images
/// (`…/displays/…`) are served publicly with no credentials, so playback goes
/// through a plain `<audio>`/`<img>` src and the import download reuses the
/// generic `fetch_bytes`.
///
/// Errors arrive as HTTP 401/429 with a JSON `{"detail": "…"}` body, which
/// `ureq` turns into a `Status` error whose body we'd otherwise drop — so the
/// body is read back out and returned, or "Authentication credentials were
/// not provided" surfaces in the panel as a bare `401`.
#[tauri::command]
async fn fetch_freesound_text(url: String, token: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let parsed = url::Url::parse(&url).map_err(|e| format!("bad Freesound URL: {e}"))?;
        if parsed.scheme() != "https" || parsed.host_str() != Some("freesound.org") {
            return Err("Freesound API requests must use https://freesound.org".to_string());
        }

        let mut req = ureq::get(&url)
            .set("User-Agent", "three-engine/0.1")
            .set("Accept", "application/json");
        if let Some(value) = token.as_deref().filter(|value| !value.is_empty()) {
            req = req.set("Authorization", &format!("Token {value}"));
        }
        match req.call() {
            Ok(response) => response
                .into_string()
                .map_err(|e| format!("read Freesound response: {e}")),
            Err(ureq::Error::Status(code, response)) => {
                let body = response.into_string().unwrap_or_default();
                Err(format!("Freesound API {code}: {body}"))
            }
            Err(e) => Err(format!("Freesound API: {e}")),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Poly Pizza's JSON API (`api.poly.pizza/v1.1`) rejects every request without
/// a key — there is no anonymous read tier at all, so unlike Sketchfab the
/// *browse* path needs the credential too, not just the download. Same shape as
/// the proxies above: hardcoded host allowlist so the key cannot be attached to
/// an arbitrary URL, and the key rides server-side rather than through JS
/// `fetch`.
///
/// The credential is a plain `x-auth-token` header, NOT an `Authorization`
/// scheme — sending it as `Bearer`/`Token` returns the same 401 as sending
/// nothing, which reads exactly like a bad key and is worth an hour if you
/// assume the usual shape.
///
/// Only the JSON API needs this. Model binaries live on `static.poly.pizza`
/// and are served publicly (verified against the live CDN: a ranged GET with
/// no credential returns 206), so the download reuses the generic
/// `fetch_bytes` and thumbnails load through a plain `<img>` src.
///
/// Errors arrive as an HTTP status with a JSON body that actually explains the
/// problem ("You need an API key to do that dingus"), which `ureq` turns into a
/// `Status` error whose body we would otherwise drop — so it is read back out,
/// the same way `fetch_freesound_text` does it.
#[tauri::command]
async fn fetch_polypizza_text(url: String, token: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let parsed = url::Url::parse(&url).map_err(|e| format!("bad Poly Pizza URL: {e}"))?;
        if parsed.scheme() != "https" || parsed.host_str() != Some("api.poly.pizza") {
            return Err("Poly Pizza API requests must use https://api.poly.pizza".to_string());
        }

        let mut req = ureq::get(&url)
            .set("User-Agent", "three-engine/0.1")
            .set("Accept", "application/json");
        if let Some(value) = token.as_deref().filter(|value| !value.is_empty()) {
            req = req.set("x-auth-token", value);
        }
        match req.call() {
            Ok(response) => response
                .into_string()
                .map_err(|e| format!("read Poly Pizza response: {e}")),
            Err(ureq::Error::Status(code, response)) => {
                let body = response.into_string().unwrap_or_default();
                Err(format!("Poly Pizza API {code}: {body}"))
            }
            Err(e) => Err(format!("Poly Pizza API: {e}")),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// itch.io has no public catalog/search API — only the per-account endpoints
/// above. Browsing the *whole* store means fetching itch.io's own public
/// browse/search HTML pages and parsing them client-side with the browser's
/// native `DOMParser` (see itchioStore.js); this command only does the
/// fetch, same CORS rationale as `fetch_text`. It's a dedicated command
/// rather than reusing `fetch_text`: itch.io serves these pages to real
/// browsers and, per manual testing against the live site, starts returning
/// HTTP 429 after a handful of rapid requests — a convincing browser
/// User-Agent (`fetch_text`'s is a custom UA string, fine for ambientCG's
/// API but not for a page meant for humans) keeps normal, human-paced usage
/// from tripping that. Host-locking to `itch.io` (not `api.itch.io`, and not
/// the fully generic `fetch_text`) also keeps this proxy from being
/// repurposed to fetch arbitrary URLs.
#[tauri::command]
async fn fetch_itchio_html(url: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let parsed = url::Url::parse(&url).map_err(|e| format!("bad itch.io URL: {e}"))?;
        if parsed.scheme() != "https" || parsed.host_str() != Some("itch.io") {
            return Err("itch.io page requests must use https://itch.io".to_string());
        }
        let response = ureq::get(&url)
            .set(
                "User-Agent",
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            )
            .set("Accept", "text/html,application/xhtml+xml")
            .call()
            .map_err(|e| format!("itch.io: {e}"))?;
        response
            .into_string()
            .map_err(|e| format!("read itch.io page: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Proxies a `chat/completions`-shaped POST to an OpenAI-compatible endpoint
/// (Ollama by default, or any self-hosted server speaking the same API) for
/// the in-editor AI panel's tool-loop provider. Ollama only answers
/// cross-origin browser requests from origins listed in its `OLLAMA_ORIGINS`
/// env var, and a packaged Tauri app's webview origin isn't among the
/// defaults — a direct `fetch` from `toolLoop.js` fails with "Failed to
/// fetch". Routing through Rust sidesteps that the same way `fetch_text`
/// does, without asking every user to set an env var just to use the
/// feature. Unlike `fetch_sketchfab_text` this has no host allowlist: the
/// whole point is the user's own arbitrary local/self-hosted base URL, and
/// `fetch_text` already proxies arbitrary URLs anyway, so this adds no new
/// exposure.
///
/// `body` is already-serialized JSON from JS and is sent verbatim; the
/// response body comes back verbatim too (JS parses it). A non-2xx response
/// is NOT collapsed into a generic message — the status and response body
/// are both surfaced, because e.g. a 404 from Ollama means "that model isn't
/// pulled" and the user needs to see the actual text to know that.
///
/// The timeout is the run's only escape hatch from a wedged model server.
/// `toolLoop.js` cancels BETWEEN round trips, not during one (the request
/// lives here in Rust, so there is no `AbortController` to trip), which means
/// a server that accepts the connection and then never answers would
/// otherwise leave the AI panel stuck on "running" with no way back short of
/// restarting the editor. Five minutes is far longer than any healthy
/// `stream: false` completion — a local model that has produced nothing at
/// all in that window is hung, not slow.
#[tauri::command]
async fn ai_chat(url: String, api_key: Option<String>, body: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut req = ureq::post(&url)
            .timeout(std::time::Duration::from_secs(300))
            .set("Content-Type", "application/json");
        if let Some(key) = api_key.as_deref().filter(|k| !k.is_empty()) {
            req = req.set("Authorization", &format!("Bearer {key}"));
        }
        match req.send_string(&body) {
            Ok(resp) => resp.into_string().map_err(|e| format!("read response from {url}: {e}")),
            Err(ureq::Error::Status(code, resp)) => {
                let text = resp.into_string().unwrap_or_default();
                Err(format!("{url} returned {code}: {text}"))
            }
            Err(e) => Err(format!("{url}: {e}")),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::{
        copy_dir_tracking, newest_player_source, percent_decode, player_checkout_root,
        validate_browser_preview_url, write_if_different, zip_dir,
    };
    use std::fs;

    /// The hot-update client trusts this list to tell a material tweak from an
    /// engine rebuild — an unchanged file reported as changed downgrades every
    /// in-place update to a page reload, and a changed file NOT reported means
    /// the browser keeps running stale bytes.
    #[test]
    fn the_change_manifest_reports_exactly_what_was_written() {
        let base = std::env::temp_dir().join("three-engine-manifest-test");
        let _ = fs::remove_dir_all(&base);
        let src = base.join("src");
        let dst = base.join("dst");
        fs::create_dir_all(src.join("_engine")).unwrap();
        fs::write(src.join("index.html"), "<!doctype html>").unwrap();
        fs::write(src.join("_engine").join("player.js"), "boot()").unwrap();

        let mut changed = Vec::new();
        copy_dir_tracking(&src, &dst, "", &mut changed, &Default::default()).unwrap();
        changed.sort();
        assert_eq!(changed, vec!["_engine/player.js".to_string(), "index.html".to_string()]);

        // Second pass over an unchanged tree: nothing may report as changed.
        let mut second = Vec::new();
        copy_dir_tracking(&src, &dst, "", &mut second, &Default::default()).unwrap();
        assert!(second.is_empty(), "unchanged copies reported: {second:?}");

        // A template file the exporter regenerates (the themed index.html)
        // must be left to the generator. Without the exclusion, the raw copy
        // and the themed write took turns rewriting it — "index.html changed"
        // on EVERY rebuild, which reloaded the page for every material tweak.
        fs::write(dst.join("index.html"), "<themed>").unwrap();
        let mut third = Vec::new();
        let generated = std::collections::HashSet::from(["index.html"]);
        copy_dir_tracking(&src, &dst, "", &mut third, &generated).unwrap();
        assert!(third.is_empty(), "excluded template file was copied: {third:?}");
        assert_eq!(fs::read(dst.join("index.html")).unwrap(), b"<themed>");

        let doc = dst.join("assets").join("m.mat");
        fs::create_dir_all(doc.parent().unwrap()).unwrap();
        assert!(write_if_different(&doc, b"{\"a\":1}").unwrap(), "first write");
        assert!(!write_if_different(&doc, b"{\"a\":1}").unwrap(), "identical re-emit");
        assert!(write_if_different(&doc, b"{\"a\":2}").unwrap(), "real edit");
        assert_eq!(fs::read(&doc).unwrap(), b"{\"a\":2}");

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn finds_the_dev_checkout_from_the_crate_dir() {
        // cargo test runs with cwd src-tauri, the same shape `tauri dev` has.
        // The freshness commands are dev-only conveniences, but if this stops
        // resolving they silently degrade to "never stale" — which is exactly
        // the day-long stale-template failure they exist to prevent.
        let root = player_checkout_root().expect("checkout root");
        assert!(root.join("src/player").is_dir());
        assert!(root.join("src/engine").is_dir());
        assert!(root.join("vite.player.config.js").is_file());
    }

    #[test]
    fn the_staleness_walk_sees_engine_source() {
        let root = player_checkout_root().expect("checkout root");
        let (ms, path) = newest_player_source(&root);
        // If the walk silently stops matching anything, staleness becomes
        // "never" and stale runtimes ship again. A wrong-dir walk shows up
        // here as ms == 0.
        assert!(ms > 0, "no player source files found");
        assert!(!path.is_empty());
        // A freshly-touched engine file must win the walk.
        let probe = root.join("src/engine/.staleness-probe.tmp");
        fs::write(&probe, "x").unwrap();
        let (after, winner) = newest_player_source(&root);
        let _ = fs::remove_file(&probe);
        assert!(after >= ms);
        assert!(
            winner.contains("staleness-probe") || after > ms,
            "a just-written engine file did not advance the walk: {winner}"
        );
    }

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
        // Headless one-shot AI runs, keyed by run id.
        .manage(agent::AgentState::default())
        // Loopback static servers for previewing exported builds.
        .manage(preview::PreviewState::default())
        // The public share tunnel fronting the preview server, if one runs.
        .manage(share::ShareState::default())
        // Watches the open project folder so a file written by anything other
        // than the editor shows up without a restart.
        .manage(watcher::WatchState::default())
        .invoke_handler(tauri::generate_handler![
            save_scene,
            load_scene,
            list_dir,
            read_binary_file,
            read_binary_file_head,
            file_size,
            read_text_file,
            read_text_files,
            stat_file,
            create_dir,
            rename_path,
            delete_path,
            import_files,
            export_game,
            write_file_atomic,
            read_player_template,
            player_template_status,
            rebuild_player_template,
            zip_dir,
            preview::serve_build,
            preview::serve_build_lan,
            preview::stop_build_lan,
            preview::prepare_browser_preview,
            share::share_binary_status,
            share::start_share_tunnel,
            share::stop_share_tunnel,
            publish::pages_login,
            publish::pages_deploy,
            scaffold_three_types,
            write_binary_file,
            write_binary_file_raw,
            compress_texture_basis,
            frontend_log,
            open_browser_url,
            fetch_text,
            fetch_bytes,
            fetch_sketchfab_text,
            fetch_itchio_text,
            fetch_itchio_html,
            fetch_freesound_text,
            fetch_polypizza_text,
            ai_chat,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_alive,
            mcp_clients::mcp_client_status,
            mcp_clients::mcp_client_register,
            mcp_clients::mcp_client_unregister,
            mcp_clients::detect_terminal_programs,
            agent::agent_run,
            agent::agent_cancel,
            watcher::watch_project,
            watcher::unwatch_project,
            git::git_probe,
            git::git_exec,
            git::gh_exec,
            git::github_login
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            // cloudflared is a child process, and on Windows children outlive
            // a dead parent: without this, closing the editor would leave a
            // public hostname forwarding to a port nothing listens on.
            if let tauri::RunEvent::Exit = event {
                share::shutdown(app);
            }
        });
}
