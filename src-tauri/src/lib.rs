//! Sorakada desktop shell.
//!
//! At this stage the Rust side only boots the Tauri application. System
//! capabilities (file I/O and other heavy work) will be added here as the
//! editor grows.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
