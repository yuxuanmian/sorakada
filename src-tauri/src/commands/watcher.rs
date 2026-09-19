//! Tauri filesystem watch commands.
//!
//! This module is the only IPC surface of [`crate::filesystem_watcher`]. It
//! owns the application-lifetime watcher, forwards normalized payloads to the
//! frontend, and adapts the two subscription commands. It contains no watching
//! logic of its own: scope, refcount and routing rules all live in the manager,
//! which stays reusable and Tauri-free for 006.
//!
//! Failures keep the same `code + message` shape as the 002 and 003 commands.

use std::sync::{Mutex, MutexGuard};

use tauri::{Emitter, Manager};

use crate::file_codec::FileCommandError;
use crate::file_identity::CODE_PATH_RESOLUTION;
use crate::filesystem_watcher::{FilesystemWatcher, WatchPayloadSink};
use crate::watch_event::{
    StartWatchRequest, StopWatchRequest, WATCH_EVENT_NAME, WatchEventPayload, WatchSubscription,
};

/// Application-wide watcher state.
///
/// The manager is created lazily on the first `start_filesystem_watch` call:
/// constructing the native watcher can fail, and a watcher failure must be
/// reported to the frontend as a normal command error rather than preventing
/// the application from booting at all.
pub struct FilesystemWatchState {
    /// The application handle used to emit payloads on the watch channel.
    app: tauri::AppHandle,
    /// The manager, absent until something actually asks to watch a path.
    manager: Mutex<Option<FilesystemWatcher>>,
}

impl FilesystemWatchState {
    /// Builds the state around an application handle.
    fn new(app: tauri::AppHandle) -> Self {
        Self {
            app,
            manager: Mutex::new(None),
        }
    }

    /// Returns the manager, creating it on first use.
    fn manager(&self) -> Result<MutexGuard<'_, Option<FilesystemWatcher>>, FileCommandError> {
        let mut manager = lock(&self.manager);

        if manager.is_none() {
            let app = self.app.clone();
            // Every payload goes out on a plain Tauri event channel: hints
            // arrive when the operating system raises them, so no caller is
            // waiting for a reply. A failed emit means the window is gone, and
            // there is nothing useful to do about that from the watcher thread.
            let sink: WatchPayloadSink = std::sync::Arc::new(move |payload: WatchEventPayload| {
                let _ = app.emit(WATCH_EVENT_NAME, payload);
            });

            let watcher = FilesystemWatcher::new(sink).map_err(|message| {
                FileCommandError::new(
                    CODE_PATH_RESOLUTION,
                    format!("Cannot start the filesystem watcher: {message}"),
                )
            })?;

            *manager = Some(watcher);
        }

        Ok(manager)
    }

    /// Returns the manager only when it already exists.
    ///
    /// Stopping a subscription must never pay for constructing a native
    /// watcher, and it must succeed when nothing was ever started.
    fn existing_manager(&self) -> MutexGuard<'_, Option<FilesystemWatcher>> {
        lock(&self.manager)
    }
}

/// Installs the watcher state. Must never fail: the application boots even if
/// watching is unavailable, and the failure surfaces on the first command.
pub fn install(app: tauri::AppHandle) {
    app.manage(FilesystemWatchState::new(app.clone()));
}

/// Releases every watch. Safe to call when no manager was ever created.
pub fn shutdown(app: &tauri::AppHandle) {
    let Some(state) = app.try_state::<FilesystemWatchState>() else {
        return;
    };

    let manager = lock(&state.manager).take();

    if let Some(manager) = manager {
        manager.shutdown();
    }
}

/// Registers interest in one path and returns its subscription handle.
#[tauri::command]
pub fn start_filesystem_watch(
    state: tauri::State<'_, FilesystemWatchState>,
    request: StartWatchRequest,
) -> Result<WatchSubscription, FileCommandError> {
    let manager = state.manager()?;

    match manager.as_ref() {
        Some(manager) => manager.start(&request.path, request.scope),
        // Unreachable while `manager()` keeps its contract, but the command
        // must still answer with a contract-shaped error rather than panicking.
        None => Err(FileCommandError::new(
            CODE_PATH_RESOLUTION,
            "The filesystem watcher is unavailable.".to_string(),
        )),
    }
}

/// Releases one subscription. Stopping an unknown subscription is not an error.
#[tauri::command]
pub fn stop_filesystem_watch(
    state: tauri::State<'_, FilesystemWatchState>,
    request: StopWatchRequest,
) -> Result<(), FileCommandError> {
    if let Some(manager) = state.existing_manager().as_ref() {
        manager.stop(request.subscription_id);
    }

    Ok(())
}

/// Locks a mutex, recovering from poisoning instead of panicking.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
