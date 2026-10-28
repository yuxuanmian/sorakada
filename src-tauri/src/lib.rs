//! Sorakada desktop shell.
//!
//! The Rust side boots the Tauri application, installs the single-instance and
//! native dialog plugins, and registers the external-open, file, Workspace and
//! filesystem-watch command IPC surfaces. All byte-level file work lives in
//! [`file_codec`]; all path identity and containment semantics live in
//! [`file_identity`]; structural filesystem operations live in [`workspace_fs`];
//! event-driven watching lives in [`filesystem_watcher`] with its wire shapes in
//! [`watch_event`]; the command modules only adapt those to IPC.

mod commands;
mod external_open;
mod file_codec;
mod file_identity;
mod filesystem_watcher;
#[cfg(test)]
mod test_support;
mod watch_event;
mod workspace_fs;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let external_open_state = external_open::ExternalOpenState::default();
    let cold_start_cwd = std::env::current_dir().unwrap_or_default();
    external_open_state.enqueue(external_open::paths_from_args(
        std::env::args_os(),
        &cold_start_cwd,
    ));
    let secondary_instance_state = external_open_state.clone();

    let mut context = tauri::generate_context!();
    #[cfg(debug_assertions)]
    context.config_mut().identifier.push_str(".dev");

    tauri::Builder::default()
        // The single-instance plugin must be the first registered plugin so a
        // secondary process is redirected before the remaining plugin setup.
        .manage(external_open_state)
        .plugin(tauri_plugin_single_instance::init(move |app, args, cwd| {
            external_open::handle_instance(app, &secondary_instance_state, args, cwd);
        }))
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::external_open::peek_external_open_request,
            commands::external_open::ack_external_open_request,
            commands::external_open::activate_external_open_main_window,
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
        .build(context)
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
            ("external_open.rs", include_str!("external_open.rs")),
            ("workspace_fs.rs", include_str!("workspace_fs.rs")),
            (
                "filesystem_watcher.rs",
                include_str!("filesystem_watcher.rs"),
            ),
            ("watch_event.rs", include_str!("watch_event.rs")),
            ("commands/file.rs", include_str!("commands/file.rs")),
            (
                "commands/external_open.rs",
                include_str!("commands/external_open.rs"),
            ),
            (
                "commands/workspace.rs",
                include_str!("commands/workspace.rs"),
            ),
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
