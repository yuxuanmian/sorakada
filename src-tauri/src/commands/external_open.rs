//! External file-open queue commands.
//!
//! The queue stores every accepted launch batch until the main window's single
//! consumer acknowledges it. The pending event is only a wake-up hint.

use tauri::State;

use crate::external_open::{
    activate_main_window, is_main_window_label, ExternalOpenRequest, ExternalOpenState,
};

/// Returns the current queue head without removing it.
#[tauri::command]
pub fn peek_external_open_request(
    window: tauri::WebviewWindow,
    state: State<'_, ExternalOpenState>,
) -> Option<ExternalOpenRequest> {
    if !is_main_window_label(window.label()) {
        return None;
    }

    state.peek()
}

/// Removes the current queue head only when `requestId` matches it.
#[tauri::command(rename_all = "camelCase")]
pub fn ack_external_open_request(
    window: tauri::WebviewWindow,
    state: State<'_, ExternalOpenState>,
    request_id: u64,
) -> bool {
    if !is_main_window_label(window.label()) {
        return false;
    }

    state.ack(request_id)
}

/// Best-effort activation of the main window.
#[tauri::command]
pub fn activate_external_open_main_window(window: tauri::WebviewWindow, app: tauri::AppHandle) {
    if !is_main_window_label(window.label()) {
        return;
    }

    activate_main_window(&app);
}
