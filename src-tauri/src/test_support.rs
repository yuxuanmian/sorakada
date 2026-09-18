//! Test-only filesystem helpers.
//!
//! Struct/entry metadata for directory links cannot be produced from ordinary
//! files and directories, and link creation is privileged on some platforms.
//! These helpers therefore report success/failure instead of panicking, so a
//! link-dependent test can skip itself on a machine that cannot create the
//! fixture rather than failing for an unrelated reason.
//!
//! This module is compiled for `cargo test` only.

use std::path::Path;

/// Creates a directory link (symlink, or a junction when symlinks are not
/// permitted) that points at `target`. Returns whether the fixture now exists.
pub fn create_directory_link(target: &Path, link: &Path) -> bool {
    if create_directory_link_platform(target, link) {
        return true;
    }

    // A second attempt keeps the fixture available on Windows machines without
    // Developer Mode, where `symlink_dir` needs a privilege that junctions do
    // not.
    create_directory_junction(target, link)
}

/// Creates a file link that points at `target`. Returns whether the fixture
/// now exists.
pub fn create_file_link(target: &Path, link: &Path) -> bool {
    create_file_link_platform(target, link)
}

#[cfg(unix)]
fn create_directory_link_platform(target: &Path, link: &Path) -> bool {
    std::os::unix::fs::symlink(target, link).is_ok()
}

#[cfg(unix)]
fn create_file_link_platform(target: &Path, link: &Path) -> bool {
    std::os::unix::fs::symlink(target, link).is_ok()
}

#[cfg(windows)]
fn create_directory_link_platform(target: &Path, link: &Path) -> bool {
    std::os::windows::fs::symlink_dir(target, link).is_ok()
}

#[cfg(windows)]
fn create_file_link_platform(target: &Path, link: &Path) -> bool {
    std::os::windows::fs::symlink_file(target, link).is_ok()
}

#[cfg(not(any(unix, windows)))]
fn create_directory_link_platform(_target: &Path, _link: &Path) -> bool {
    false
}

#[cfg(not(any(unix, windows)))]
fn create_file_link_platform(_target: &Path, _link: &Path) -> bool {
    false
}

#[cfg(windows)]
fn create_directory_junction(target: &Path, link: &Path) -> bool {
    let command = format!(
        "mklink /J \"{}\" \"{}\"",
        link.display(),
        target.display()
    );

    std::process::Command::new("cmd")
        .arg("/C")
        .arg(command)
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn create_directory_junction(_target: &Path, _link: &Path) -> bool {
    false
}
