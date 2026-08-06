//! Watches the open project folder and tells the editor what changed.
//!
//! ## Why the editor needs this at all
//!
//! Everything the editor knows about a project it read once: the Assets panel
//! listed the directory, the asset loader cached a blob URL per path, the engine
//! decoded a `.geom` into a shared BufferGeometry. Nothing in that chain can
//! notice that the bytes on disk changed, so a file written by anything other
//! than the editor itself — an AI agent using its own file tools, a texture
//! exported from another program, a script edited in an IDE — stayed invisible
//! until the editor was restarted. That is the single most common way "the
//! change didn't apply" is reported, and it is not a bug in whatever wrote the
//! file.
//!
//! ## Self-writes are filtered here, not in the webview
//!
//! The editor saves constantly (autosave, texture flattening, `.meta`
//! sidecars). Echoing those back would at best re-invalidate a cache the editor
//! had just populated and at worst make the open scene reload out from under
//! the user mid-edit. Every editor write goes through a Tauri command, so this
//! module records the path as it is written and drops watcher events for it for
//! a short window afterwards. Doing it here rather than in JS means a new write
//! command cannot forget to opt in — it only has to call `note_self_write`,
//! and the ones that exist already do.
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

/// How long after the editor writes a path its own change is ignored.
///
/// Long enough to cover the gap between the write returning and the OS
/// delivering the event (which on Windows can be surprisingly slow under load),
/// short enough that a *different* program editing the same file a moment later
/// is still seen.
const SELF_WRITE_TTL: Duration = Duration::from_millis(1500);

/// Directories that are never project content. `Library` is the editor's own
/// derived-data cache (baked SDFs, thumbnails) and is written constantly during
/// normal work — watching it would produce a permanent event storm.
const IGNORED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "Library",
    "target",
    "dist",
    "dist-player",
    ".vite",
    ".cache",
];

fn recent_writes() -> &'static Mutex<HashMap<PathBuf, Instant>> {
    static WRITES: OnceLock<Mutex<HashMap<PathBuf, Instant>>> = OnceLock::new();
    WRITES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Records that the editor is writing `path`, so the watcher event it causes is
/// not reported back as an external change. Call from every command that
/// creates, overwrites, renames or deletes a project file.
pub fn note_self_write(path: impl AsRef<Path>) {
    let key = normalize(path.as_ref());
    let mut map = match recent_writes().lock() {
        Ok(map) => map,
        Err(poisoned) => poisoned.into_inner(),
    };
    let now = Instant::now();
    // Opportunistic sweep: this map only grows while the editor is saving, and
    // pruning on insert keeps it proportional to writes-in-flight rather than
    // to writes-per-session.
    map.retain(|_, at| now.duration_since(*at) < SELF_WRITE_TTL);
    map.insert(key, now);
}

fn was_self_write(path: &Path) -> bool {
    let key = normalize(path);
    let map = match recent_writes().lock() {
        Ok(map) => map,
        Err(poisoned) => poisoned.into_inner(),
    };
    match map.get(&key) {
        Some(at) => Instant::now().duration_since(*at) < SELF_WRITE_TTL,
        None => false,
    }
}

/// Lower-cased, forward-slashed. Windows hands the same file back with either
/// separator and either case depending on which API produced the path, and a
/// self-write filter that misses because of a capital drive letter is worse
/// than no filter — it would look like random echo events.
fn normalize(path: &Path) -> PathBuf {
    PathBuf::from(
        path.to_string_lossy()
            .replace('\\', "/")
            .to_lowercase(),
    )
}

fn is_ignored(path: &Path) -> bool {
    for component in path.components() {
        let name = component.as_os_str().to_string_lossy();
        if IGNORED_DIRS.iter().any(|dir| name.eq_ignore_ascii_case(dir)) {
            return true;
        }
        // Editors and exporters write to a temp file and rename. The temp file
        // is not project content and reporting it makes the panel flicker.
        if name.ends_with('~') || name.ends_with(".tmp") || name.ends_with(".crswap") {
            return true;
        }
        if name.starts_with(".#") {
            return true;
        }
    }
    false
}

#[derive(Serialize, Clone)]
pub struct FileChange {
    pub path: String,
    /// "create" | "modify" | "remove". Coarse on purpose: the editor's response
    /// to all three is the same (drop the cached bytes, re-list the folder), and
    /// the platform backends disagree about the finer kinds.
    pub kind: &'static str,
}

#[derive(Default)]
pub struct WatchState {
    inner: Mutex<Option<(PathBuf, RecommendedWatcher)>>,
}

fn kind_of(event: &Event) -> Option<&'static str> {
    match event.kind {
        EventKind::Create(_) => Some("create"),
        EventKind::Modify(_) => Some("modify"),
        EventKind::Remove(_) => Some("remove"),
        // Access events (a file being *read*) are noise — the editor reads
        // constantly — and Any/Other carry no information worth a round trip.
        _ => None,
    }
}

/// Starts watching `path` recursively, replacing any previous watch.
///
/// Idempotent for the same path: opening the same project twice (which the
/// editor does on a project-settings save) must not stack watchers, or every
/// change would be reported once per open.
#[tauri::command]
pub fn watch_project(
    app: AppHandle,
    path: String,
    state: tauri::State<'_, WatchState>,
) -> Result<bool, String> {
    let root = PathBuf::from(path.replace('\\', "/"));
    if !root.is_dir() {
        return Err(format!("{} is not a directory", root.display()));
    }

    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    if let Some((current, _)) = guard.as_ref() {
        if normalize(current) == normalize(&root) {
            return Ok(false);
        }
    }

    let emitter = app.clone();
    let mut watcher = RecommendedWatcher::new(
        move |result: notify::Result<Event>| {
            let Ok(event) = result else { return };
            let Some(kind) = kind_of(&event) else { return };
            let changes: Vec<FileChange> = event
                .paths
                .iter()
                .filter(|p| !is_ignored(p))
                .filter(|p| !was_self_write(p))
                .map(|p| FileChange {
                    path: p.to_string_lossy().replace('\\', "/"),
                    kind,
                })
                .collect();
            if changes.is_empty() {
                return;
            }
            // A failed emit means the window is gone; there is nothing useful to
            // do about it from inside a watcher callback.
            let _ = emitter.emit("project-files-changed", changes);
        },
        Config::default(),
    )
    .map_err(|e| e.to_string())?;

    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    *guard = Some((root, watcher));
    Ok(true)
}

/// Stops watching. Dropping the watcher is what unregisters it.
#[tauri::command]
pub fn unwatch_project(state: tauri::State<'_, WatchState>) -> Result<(), String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    *guard = None;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ignores_editor_derived_data_and_temp_files() {
        assert!(is_ignored(Path::new("C:/proj/Library/sdf/abc.bin")));
        assert!(is_ignored(Path::new("C:/proj/.git/index")));
        assert!(is_ignored(Path::new("C:/proj/textures/wall.png.tmp")));
        assert!(!is_ignored(Path::new("C:/proj/textures/wall.png")));
        assert!(!is_ignored(Path::new("C:/proj/scenes/Main.scene")));
    }

    #[test]
    fn self_writes_are_filtered_case_and_separator_insensitively() {
        note_self_write("C:/Proj/Textures/Wall.png");
        // The watcher hands paths back with backslashes on Windows and with
        // whatever case the filesystem stored; both must still match.
        assert!(was_self_write(Path::new("c:\\proj\\textures\\wall.png")));
        assert!(!was_self_write(Path::new("C:/Proj/Textures/Other.png")));
    }
}
