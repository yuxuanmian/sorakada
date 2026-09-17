//! Path identity inspection.
//!
//! 002 needs one question answered before it opens, deduplicates or reserves a
//! document destination: *which* filesystem object does this path refer to?
//! Raw string comparison cannot answer it, because `..`, equivalent spellings
//! and platform case rules all hide the same file behind different text.
//!
//! This module owns that resolution and nothing else. It never reads, creates,
//! truncates or writes the target — the byte-level text codec in
//! [`crate::file_codec`] stays the only module that touches file contents.

use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

use crate::file_codec::FileCommandError;

/// Error code reported when a path cannot be resolved into an identity.
pub const CODE_PATH_RESOLUTION: &str = "path_resolution";

/// What the resolved path currently is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResolvedPathKind {
    /// An existing regular file.
    File,
    /// An existing directory.
    Directory,
    /// A destination that does not exist yet, resolved through its parent.
    Missing,
}

/// Lightweight metadata captured for a disk object.
///
/// 002 stores it as the extension point for later external-change validation;
/// it is deliberately not polled or compared continuously.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskRevision {
    /// Size in bytes at the time of inspection.
    pub size: u64,
    /// Last modification time in milliseconds since the Unix epoch.
    pub modified_time_millis: Option<i64>,
}

/// Result of inspecting a path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedPathIdentity {
    /// The path exactly as the caller spelled it.
    pub requested_path: String,
    /// Internal resolved/candidate path; user-facing UI keeps the requested path.
    pub canonical_path: String,
    /// The only key 002 uses for open-session ownership and Save As claims.
    pub comparison_key: String,
    /// What the resolved path is.
    pub kind: ResolvedPathKind,
    /// Metadata when the target exists.
    pub disk_revision: Option<DiskRevision>,
}

/// Request payload of the `inspect_file_path` command.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectPathRequest {
    /// Path to inspect.
    pub path: String,
    /// Whether a not-yet-existing final component may be resolved.
    pub allow_missing: bool,
}

/// Resolves `requested_path` into a comparison identity.
///
/// An existing path resolves through the filesystem, so equivalent spellings
/// and links that land on the same object share one comparison key. A
/// not-yet-existing destination is resolved through its nearest existing parent
/// when `allow_missing` is set, which is what lets Save As reserve a target
/// before anything has been written.
pub fn resolve_path_identity(
    requested_path: &str,
    allow_missing: bool,
) -> Result<ResolvedPathIdentity, FileCommandError> {
    let path = Path::new(requested_path);

    if path.exists() {
        let canonical = fs::canonicalize(path)
            .map_err(|error| resolution_error(requested_path, error))?;
        let metadata = fs::metadata(&canonical)
            .map_err(|error| resolution_error(requested_path, error))?;

        let kind = if metadata.is_dir() {
            ResolvedPathKind::Directory
        } else {
            ResolvedPathKind::File
        };

        return Ok(ResolvedPathIdentity {
            requested_path: requested_path.to_string(),
            canonical_path: canonical.to_string_lossy().to_string(),
            comparison_key: comparison_key(&canonical),
            kind,
            disk_revision: Some(DiskRevision {
                size: metadata.len(),
                modified_time_millis: modified_time_millis(&metadata),
            }),
        });
    }

    if !allow_missing {
        return Err(FileCommandError::new(
            CODE_PATH_RESOLUTION,
            format!("Path does not exist: {requested_path}"),
        ));
    }

    // A relative path with no directory component resolves against the current
    // directory, which is what the filesystem itself would do.
    let parent = match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        _ => Path::new("."),
    };
    let leaf = path.file_name().ok_or_else(|| {
        FileCommandError::new(
            CODE_PATH_RESOLUTION,
            format!("Path has no final component: {requested_path}"),
        )
    })?;

    let canonical_parent =
        fs::canonicalize(parent).map_err(|error| resolution_error(requested_path, error))?;
    let canonical = canonical_parent.join(leaf);

    Ok(ResolvedPathIdentity {
        requested_path: requested_path.to_string(),
        canonical_path: canonical.to_string_lossy().to_string(),
        comparison_key: comparison_key(&canonical),
        kind: ResolvedPathKind::Missing,
        disk_revision: None,
    })
}

/// Builds the identity error the frontend normalizes into `path_resolution`.
fn resolution_error(requested_path: &str, error: std::io::Error) -> FileCommandError {
    FileCommandError::new(
        CODE_PATH_RESOLUTION,
        format!("Cannot resolve {requested_path}: {error}"),
    )
}

/// The platform's own path-equality semantics.
///
/// Windows compares paths case-insensitively, so the key is case-folded there.
/// Distinct hard-link paths are deliberately *not* folded together: 002 keys on
/// the canonical path, not on a native file id.
fn comparison_key(canonical: &Path) -> String {
    let text = canonical.to_string_lossy().to_string();

    #[cfg(windows)]
    {
        text.to_lowercase()
    }

    #[cfg(not(windows))]
    {
        text
    }
}

/// Modification time in milliseconds since the Unix epoch, when available.
fn modified_time_millis(metadata: &fs::Metadata) -> Option<i64> {
    let modified = metadata.modified().ok()?;
    let since_epoch = modified.duration_since(UNIX_EPOCH).ok()?;
    i64::try_from(since_epoch.as_millis()).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

    fn work_dir(name: &str) -> PathBuf {
        let mut dir = std::env::temp_dir();
        dir.push(format!("sorakada-identity-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn write_file(dir: &Path, name: &str, contents: &[u8]) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, contents).expect("write fixture");
        path
    }

    fn display(path: &Path) -> String {
        path.to_string_lossy().to_string()
    }

    #[test]
    fn existing_file_reports_file_kind_and_revision() {
        let dir = work_dir("existing-file");
        let path = write_file(&dir, "notes.txt", b"alpha\nbeta");

        let identity = resolve_path_identity(&display(&path), false).expect("resolve existing file");

        assert_eq!(identity.kind, ResolvedPathKind::File);
        assert_eq!(identity.requested_path, display(&path));

        let revision = identity.disk_revision.expect("file carries a revision");
        assert_eq!(revision.size, 10, "byte length of alpha\\nbeta");
        assert!(
            revision.modified_time_millis.is_some(),
            "an existing file must report its modification time"
        );
        assert!(
            !identity.comparison_key.is_empty(),
            "a resolved identity always carries a comparison key"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn directory_paths_report_directory_kind() {
        let dir = work_dir("directory");
        let nested = dir.join("nested");
        fs::create_dir_all(&nested).expect("create nested dir");

        let identity = resolve_path_identity(&display(&nested), false).expect("resolve directory");

        assert_eq!(identity.kind, ResolvedPathKind::Directory);
        assert!(
            identity.disk_revision.is_some(),
            "an existing directory still reports disk metadata"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_final_component_resolves_the_existing_parent() {
        let dir = work_dir("missing-target");
        let target = dir.join("brand-new.txt");

        assert!(!target.exists(), "fixture must not exist yet");

        let identity =
            resolve_path_identity(&display(&target), true).expect("resolve a missing candidate");

        assert_eq!(identity.kind, ResolvedPathKind::Missing);
        assert!(
            identity.disk_revision.is_none(),
            "a missing target has no disk revision"
        );
        assert_eq!(
            PathBuf::from(&identity.canonical_path).file_name(),
            Some(std::ffi::OsStr::new("brand-new.txt")),
            "the requested leaf must survive resolution"
        );

        // The resolved candidate must be the same key an existing file of that
        // name will report once it is written.
        fs::write(&target, b"x").expect("create the file");
        let after = resolve_path_identity(&display(&target), false).expect("resolve written file");
        assert_eq!(after.kind, ResolvedPathKind::File);
        assert_eq!(
            after.comparison_key, identity.comparison_key,
            "candidate and existing identities must agree on the key"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_path_without_allow_missing_is_a_path_resolution_error() {
        let dir = work_dir("missing-strict");
        let target = dir.join("absent.txt");

        let error = resolve_path_identity(&display(&target), false)
            .expect_err("a missing path must be rejected when allow_missing is false");

        assert_eq!(error.code, CODE_PATH_RESOLUTION);
        assert!(!error.message.is_empty());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unresolvable_parent_is_a_path_resolution_error() {
        let dir = work_dir("missing-parent");
        let target = dir.join("no-such-dir").join("file.txt");

        let error = resolve_path_identity(&display(&target), true)
            .expect_err("a missing parent cannot produce a candidate identity");

        assert_eq!(error.code, CODE_PATH_RESOLUTION);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn equivalent_spellings_resolve_to_one_comparison_key() {
        let dir = work_dir("equivalence");
        write_file(&dir, "notes.txt", b"alpha");
        fs::create_dir_all(dir.join("sub")).expect("create sub dir");

        let plain = dir.join("notes.txt");
        let dot_segments = dir.join("sub").join("..").join("notes.txt");
        let dotted = dir.join(".").join("notes.txt");

        let plain_key = resolve_path_identity(&display(&plain), false)
            .expect("resolve plain")
            .comparison_key;
        let dot_key = resolve_path_identity(&display(&dot_segments), false)
            .expect("resolve with ..")
            .comparison_key;
        let dotted_key = resolve_path_identity(&display(&dotted), false)
            .expect("resolve with .")
            .comparison_key;

        assert_eq!(
            plain_key, dot_key,
            "a `..` detour must not create a second identity"
        );
        assert_eq!(
            plain_key, dotted_key,
            "a `.` segment must not create a second identity"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    #[cfg(windows)]
    fn windows_comparison_keys_ignore_case() {
        let dir = work_dir("case");
        write_file(&dir, "Notes.TXT", b"alpha");

        let upper = resolve_path_identity(&display(&dir.join("Notes.TXT")), false)
            .expect("resolve the on-disk spelling");
        let lower = resolve_path_identity(&display(&dir.join("notes.txt")), false)
            .expect("resolve a case-flipped spelling");

        assert_eq!(
            upper.comparison_key, lower.comparison_key,
            "Windows path equality is case-insensitive"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn identity_serializes_the_camel_case_wire_shape() {
        let dir = work_dir("wire-shape");
        let path = write_file(&dir, "notes.txt", b"abc");

        let value = serde_json::to_value(
            resolve_path_identity(&display(&path), false).expect("resolve"),
        )
        .expect("serialize");

        assert_eq!(value.as_object().expect("object").len(), 5);
        assert_eq!(value["kind"], json!("file"));
        assert_eq!(value["requestedPath"], json!(display(&path)));
        assert!(
            value["canonicalPath"].is_string(),
            "canonicalPath is part of the contract"
        );
        assert!(
            value["comparisonKey"].is_string(),
            "comparisonKey is part of the contract"
        );

        let revision = value["diskRevision"].as_object().expect("revision object");
        assert_eq!(revision.len(), 2);
        assert_eq!(value["diskRevision"]["size"], json!(3));
        assert!(
            value["diskRevision"]["modifiedTimeMillis"].is_i64(),
            "an existing file reports a millisecond timestamp"
        );

        assert!(value.get("requested_path").is_none());
        assert!(value.get("comparison_key").is_none());
        assert!(value.get("modified_time_millis").is_none());

        let _ = fs::remove_dir_all(&dir);
    }
}
