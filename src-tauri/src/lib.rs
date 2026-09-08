use std::path::Path;

use tauri::fs::{Event as FsScopeEvent, Pattern};
use tauri::ipc::CapabilityBuilder;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_fs::FsExt;

// tao only sets the Loom icon on windows it creates itself (via `gtk_window_set_icon`);
// native dialogs opened through rfd/tauri-plugin-dialog create their own top-level GTK
// windows and fall back to the desktop's generic icon unless we set a process-wide
// default here.
#[cfg(any(
    target_os = "linux",
    target_os = "dragonfly",
    target_os = "freebsd",
    target_os = "openbsd",
    target_os = "netbsd"
))]
fn set_gtk_default_icon<R: tauri::Runtime>(app: &tauri::App<R>) {
    let Some(icon) = app.default_window_icon() else {
        return;
    };
    let width = icon.width() as i32;
    let height = icon.height() as i32;
    let pixbuf = gtk::gdk_pixbuf::Pixbuf::from_bytes(
        &gtk::glib::Bytes::from(icon.rgba()),
        gtk::gdk_pixbuf::Colorspace::Rgb,
        true,
        8,
        width,
        height,
        width * 4,
    );
    gtk::Window::set_default_icon(&pixbuf);
}

/// The `fs` plugin's scope-only permission — the same identifier the static
/// grant in `capabilities/default.json` uses. It carries no commands, so the
/// ACL resolver folds whatever scope entries accompany it into the plugin's
/// app-wide filesystem scope rather than into one command's scope.
const FS_SCOPE_PERMISSION: &str = "fs:scope";

/// Identifier every mirrored grant is added under. One constant is enough:
/// `Manager::add_capability` merges each call's scope entries into the `fs`
/// plugin's app-wide scope and keeps nothing keyed by the capability's own
/// identifier, and this capability declares no commands, so repeated calls
/// accumulate nothing but the scope entries themselves.
const RUNTIME_GRANT_CAPABILITY: &str = "loom-runtime-fs-grant";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .invoke_handler(tauri::generate_handler![grant_project_scope])
        .setup(|app| {
            #[cfg(any(
                target_os = "linux",
                target_os = "dragonfly",
                target_os = "freebsd",
                target_os = "openbsd",
                target_os = "netbsd"
            ))]
            set_gtk_default_icon(app);

            mirror_runtime_fs_scope(app.handle());

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Grants the app filesystem access to `path` and everything under it, for
/// the life of this process. The frontend calls this for a project folder
/// Loom points itself at — a restored session's root, or a Recent Projects
/// entry — rather than one the user just handed it through the folder
/// picker, a drag-and-drop, or the save dialog. Only those native gestures
/// grow the `fs` plugin's runtime scope, so a remembered root outside
/// `$HOME`/`$CONFIG` is refused before its first listing without this.
///
/// The grant goes into the capability scope through [`mirror_scope_entry`],
/// not into the plugin's runtime scope, so it covers dot-prefixed paths —
/// the project's own `.loom` folder included — exactly as a mirrored
/// gesture grant does.
///
/// # Arguments
///
/// * `app` - The handle the capability is added through.
/// * `path` - The project folder to grant.
///
/// # Returns
///
/// `Ok(())` once the grant is in place, or the failure's message.
#[tauri::command]
fn grant_project_scope<R: Runtime>(app: AppHandle<R>, path: String) -> Result<(), String> {
    match mirror_scope_entry(&app, Path::new(&path), true) {
        Ok(()) => {
            log::info!("granted the filesystem scope for the remembered project root {path}");

            Ok(())
        }
        Err(error) => {
            log::warn!("could not grant the filesystem scope for the remembered project root {path}: {error}");

            Err(error.to_string())
        }
    }
}

/// Copies every change the `fs` plugin makes to its in-memory runtime scope
/// into the app's capability scope, which is the only one of the two that
/// honours `plugins.fs.requireLiteralLeadingDot` from `tauri.conf.json`.
/// Without this, a folder picked outside `$HOME`/`$CONFIG` is reachable only
/// through the runtime scope, whose wildcards never match a path component
/// starting with a `.` — so `.gitignore` and the project's own `.loom` folder
/// stay refused there while opening fine under `$HOME`.
///
/// A failed mirror is logged and swallowed: the runtime grant itself already
/// succeeded, so the folder still opens, minus its dotfiles.
///
/// # Arguments
///
/// * `app` - The handle the mirrored capabilities are added through.
fn mirror_runtime_fs_scope<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();

    app.fs_scope().listen(move |event| {
        let (path, allowed) = match event {
            FsScopeEvent::PathAllowed(path) => (path, true),
            FsScopeEvent::PathForbidden(path) => (path, false),
        };

        match mirror_scope_entry(&handle, path, allowed) {
            Ok(()) => log::info!("mirrored the runtime filesystem scope for {}", path.display()),
            Err(error) => log::warn!(
                "could not mirror the runtime filesystem scope for {}: {error}",
                path.display()
            ),
        }
    });
}

/// Adds `path`'s scope entries to the app's capability scope, as an allow or
/// a deny.
///
/// # Arguments
///
/// * `app` - The handle the capability is added through.
/// * `path` - The path the runtime scope just allowed or forbade.
/// * `allowed` - Whether to mirror `path` as an allow rather than a deny.
///
/// # Returns
///
/// Whatever `Manager::add_capability` reports.
fn mirror_scope_entry<R: Runtime>(app: &AppHandle<R>, path: &Path, allowed: bool) -> tauri::Result<()> {
    let entries = scope_entries(path);

    let (allow, deny) = if allowed {
        (entries, Vec::new())
    } else {
        (Vec::new(), entries)
    };

    app.add_capability(
        CapabilityBuilder::new(RUNTIME_GRANT_CAPABILITY)
            .permission_scoped(FS_SCOPE_PERMISSION, allow, deny),
    )
}

/// The `fs:scope` entries covering `path`. Glob metacharacters in `path` are
/// escaped so a folder named `notes [2026]` is matched literally rather than
/// read as a character class. A directory also gets a `/**` entry, because
/// `**` matches what is *under* a directory and never the directory itself.
///
/// # Arguments
///
/// * `path` - The path to build entries for.
///
/// # Returns
///
/// One entry for a file, two for a directory.
fn scope_entries(path: &Path) -> Vec<String> {
    let literal = Pattern::escape(&path.to_string_lossy());

    if path.is_dir() {
        vec![format!("{literal}/**"), literal]
    } else {
        vec![literal]
    }
}
