//! Tauri command layer.
//!
//! Commands are the only IPC surface between the React application layer and
//! the Rust native layer.

pub mod external_open;
pub mod file;
pub mod watcher;
pub mod workspace;
