//! Sorakada desktop shell.
//!
//! The Rust side boots the Tauri application, installs the native dialog
//! plugin, and registers the file and Workspace command IPC surfaces. All
//! byte-level file work lives in [`file_codec`]; all path identity and
//! containment semantics live in [`file_identity`]; structural filesystem
//! operations live in [`workspace_fs`]; the command modules only adapt those to
//! IPC.

mod commands;
mod file_codec;
mod file_identity;
#[cfg(test)]
mod test_support;
mod workspace_fs;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::file::read_text_file,
            commands::file::write_text_file,
            commands::file::inspect_file_path,
            commands::workspace::read_workspace_directory,
            commands::workspace::create_workspace_entry,
            commands::workspace::rename_workspace_entry,
            commands::workspace::trash_workspace_entry,
            commands::workspace::resolve_workspace_relation
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
