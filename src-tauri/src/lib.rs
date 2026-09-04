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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .setup(|app| {
            #[cfg(any(
                target_os = "linux",
                target_os = "dragonfly",
                target_os = "freebsd",
                target_os = "openbsd",
                target_os = "netbsd"
            ))]
            set_gtk_default_icon(app);

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
