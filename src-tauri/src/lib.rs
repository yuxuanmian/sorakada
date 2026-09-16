//! Sorakada desktop shell.
//!
//! The Rust side boots the Tauri application, installs the native dialog
//! plugin, and registers the file-command IPC surface. All byte-level file
//! work lives in [`file_codec`]; the command layer only adapts it to IPC.

mod commands;
mod file_codec;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::file::read_text_file,
            commands::file::write_text_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
