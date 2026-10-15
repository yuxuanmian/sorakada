//! Sorakada desktop shell.
//!
//! The Rust side boots the Tauri application, installs the native dialog
//! plugin, and registers the file, Workspace and filesystem-watch command IPC
//! surfaces. All byte-level file work lives in [`file_codec`]; all path
//! identity and containment semantics live in [`file_identity`]; structural
//! filesystem operations live in [`workspace_fs`]; event-driven watching lives
//! in [`filesystem_watcher`] with its wire shapes in [`watch_event`]; the
//! command modules only adapt those to IPC.

mod commands;
mod file_codec;
mod file_identity;
mod filesystem_watcher;
#[cfg(test)]
mod test_support;
mod watch_event;
mod workspace_fs;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::file::read_text_file,
            commands::file::write_text_file,
            commands::file::create_text_file_if_absent,
            commands::file::inspect_file_path,
            commands::file::inspect_document_path,
            commands::workspace::read_workspace_directory,
            commands::workspace::create_workspace_entry,
            commands::workspace::rename_workspace_entry,
            commands::workspace::trash_workspace_entry,
            commands::workspace::resolve_workspace_relation,
            commands::watcher::start_filesystem_watch,
            commands::watcher::stop_filesystem_watch
        ])
        // The watcher manager is installed here but created lazily, so a
        // watcher failure cannot stop the application from booting.
        .setup(|app| {
            commands::watcher::install(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Application shutdown is the one place that must release every
            // native watch, because the watcher state has no other owner.
            if let tauri::RunEvent::Exit = event {
                commands::watcher::shutdown(app_handle);
            }
        });
}

#[cfg(test)]
mod architecture_tests {
    /// 006 adds filesystem-object identity, mixed-scope watching and directory
    /// listings, and none of that may start interpreting file bytes:
    /// `file_codec` stays the only module that reads or writes raw file content
    /// (Constitution II), so BOM/EOL/encoding rules keep exactly one home.
    ///
    /// The audit is static because the property is structural: a module either
    /// touches raw bytes or it does not. Only the production half of each file
    /// is audited — the colocated tests deliberately write fixtures with
    /// `std::fs`, which is not a production byte path.
    #[test]
    fn file_codec_remains_the_only_byte_interpreter() {
        let modules = [
            ("file_identity.rs", include_str!("file_identity.rs")),
            ("workspace_fs.rs", include_str!("workspace_fs.rs")),
            ("filesystem_watcher.rs", include_str!("filesystem_watcher.rs")),
            ("watch_event.rs", include_str!("watch_event.rs")),
            ("commands/file.rs", include_str!("commands/file.rs")),
            ("commands/workspace.rs", include_str!("commands/workspace.rs")),
            ("commands/watcher.rs", include_str!("commands/watcher.rs")),
        ];

        for (name, source) in modules {
            let production = source.split("#[cfg(test)]").next().unwrap_or(source);

            for forbidden in ["fs::read(", "fs::write(", "read_to_string", "write_all"] {
                assert!(
                    !production.contains(forbidden),
                    "{name} must not interpret file bytes; `{forbidden}` belongs in file_codec.rs",
                );
            }
        }
    }
}
