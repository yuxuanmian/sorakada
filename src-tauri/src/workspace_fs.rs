//! Structural filesystem primitives for the Workspace Explorer.
//!
//! 003 needs a small set of filesystem *structure* operations that are not text
//! I/O and therefore do not belong in [`crate::file_codec`]:
//!
//! - read exactly one directory level;
//! - create one empty file or one directory;
//! - rename one entry without overwriting anything;
//! - move one entry to the operating system's recycle/trash facility.
//!
//! Every returned path is the *user-facing* path built from the requested parent
//! rather than a canonicalized path, because the Explorer shows and reopens what
//! the user selected. Canonical resolution still happens — but only to derive
//! the comparison identity used for ownership and cycle checks.
//!
//! Containment and identity semantics are shared with 002: path comparison goes
//! through [`crate::file_identity`], never through string prefix matching.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::file_codec::FileCommandError;
use crate::file_identity::{self, comparison_key, ResolvedPathIdentity};

/// Error code reported when a directory cannot be read or is not a directory.
pub const CODE_IO_DIRECTORY: &str = "io_directory";
/// Error code reported when creating a file or directory fails.
pub const CODE_IO_CREATE: &str = "io_create";
/// Error code reported when renaming an entry fails.
pub const CODE_IO_RENAME: &str = "io_rename";
/// Error code reported when moving an entry to the OS trash fails.
pub const CODE_IO_TRASH: &str = "io_trash";

/// What a directory entry is.
///
/// `Other` covers special entries that can be displayed but are never treated
/// as expandable directories: broken links, pipes, devices.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceEntryKind {
    /// A regular file.
    File,
    /// A directory, or a link that resolves to one.
    Directory,
    /// A special or broken entry.
    Other,
}

/// One direct child of a directory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDirectoryEntry {
    /// Final path component, exactly as the filesystem spells it.
    pub name: String,
    /// User-facing path of the entry.
    pub path: String,
    /// What the entry is.
    pub kind: WorkspaceEntryKind,
    /// Whether the entry itself is a link/reparse point.
    pub is_symlink: bool,
    /// Opaque identity of the entry *itself* (006).
    ///
    /// Read from the entry's own metadata without following a final link, so it
    /// describes the logical entry rather than the object a link points at. That
    /// distinction is what lets 006 prove "this Explorer entry was renamed" while
    /// keeping it strictly separate from the resolved-target identity a document
    /// binding stores. It is `None` when the platform cannot supply one, and the
    /// entry then simply falls back to remove/create semantics.
    pub object_identity: Option<String>,
}

/// Result of reading one directory level.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDirectoryResult {
    /// The path exactly as the caller spelled it.
    pub requested_path: String,
    /// Canonical path of the directory actually read.
    pub canonical_path: String,
    /// Canonical comparison identity, used for ancestor-cycle checks.
    pub comparison_key: String,
    /// Whether this directory's entries are compared case-sensitively.
    ///
    /// The frontend must not guess the platform: a pre-mutation check that falls
    /// back to a differently-cased spelling may only do so where the filesystem
    /// really treats the two spellings as one entry. This field reports the
    /// platform rule, strengthened by direct evidence when the listing itself
    /// contains two names that differ only by case (which only a case-sensitive
    /// directory can produce).
    pub case_sensitive: bool,
    /// Direct children only; never a recursive listing.
    pub entries: Vec<WorkspaceDirectoryEntry>,
}

/// Request payload of `read_workspace_directory`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadDirectoryRequest {
    /// Directory to list.
    pub path: String,
}

/// Kind of entry `create_workspace_entry` must create.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CreateEntryKind {
    /// An empty file.
    File,
    /// A directory.
    Directory,
}

/// Request payload of `create_workspace_entry`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateEntryRequest {
    /// Existing directory that receives the new entry.
    pub parent_path: String,
    /// One leaf path component.
    pub name: String,
    /// What to create.
    pub kind: CreateEntryKind,
}

/// Result of `create_workspace_entry`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedEntry {
    /// User-facing path of the new entry.
    pub path: String,
    /// Freshly resolved identity of the new entry.
    pub identity: ResolvedPathIdentity,
}

/// Request payload of `rename_workspace_entry`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameEntryRequest {
    /// Entry to rename.
    pub source_path: String,
    /// New leaf name for the entry, in its existing parent directory.
    pub new_name: String,
}

/// Result of `rename_workspace_entry`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenamedEntry {
    /// Canonical path of the entry before the rename.
    pub old_canonical_path: String,
    /// User-facing path of the entry after the rename.
    pub new_path: String,
    /// Freshly resolved identity of the renamed entry.
    pub new_identity: ResolvedPathIdentity,
}

/// Request payload of `trash_workspace_entry`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashEntryRequest {
    /// Entry to move to the operating system's recycle/trash facility.
    pub path: String,
}

/// Reads exactly one directory level.
///
/// The parent is never walked recursively, so opening a Workspace that contains
/// a very large `node_modules` tree costs one directory listing.
pub fn read_directory(requested_path: &str) -> Result<WorkspaceDirectoryResult, FileCommandError> {
    let requested = Path::new(requested_path);
    let metadata = fs::metadata(requested).map_err(|error| directory_error(requested_path, error))?;

    if !metadata.is_dir() {
        return Err(FileCommandError::new(
            CODE_IO_DIRECTORY,
            format!("Not a directory: {requested_path}"),
        ));
    }

    let canonical =
        fs::canonicalize(requested).map_err(|error| directory_error(requested_path, error))?;

    let read_dir = fs::read_dir(requested).map_err(|error| directory_error(requested_path, error))?;

    let mut entries = Vec::new();
    for entry in read_dir {
        let entry = entry.map_err(|error| directory_error(requested_path, error))?;
        entries.push(describe_entry(requested, &entry)?);
    }

    sort_entries(&mut entries);

    Ok(WorkspaceDirectoryResult {
        requested_path: requested_path.to_string(),
        canonical_path: canonical.to_string_lossy().to_string(),
        comparison_key: comparison_key(&canonical),
        case_sensitive: directory_comparison_contract(&canonical, &entries),
        entries,
    })
}

/// The comparison contract of one directory: what the filesystem itself says,
/// made stricter by direct evidence from the listing.
///
/// The rule is asked of the filesystem ([`file_identity::directory_case_sensitive`])
/// instead of being inferred from the platform, because Windows can enable case
/// sensitivity for a single directory and the directory is the only thing that
/// knows. Direct evidence from the listing can only ever make the answer
/// stricter: two names that differ by case alone cannot coexist in a
/// case-insensitive directory, so observing such a pair proves case-sensitive
/// comparison even where the platform refused to say (FR-038, FR-066).
fn directory_comparison_contract(
    canonical: &Path,
    entries: &[WorkspaceDirectoryEntry],
) -> bool {
    file_identity::directory_case_sensitive(canonical) || has_case_colliding_names(entries)
}

/// Whether a listing itself proves that its directory compares case-sensitively.
///
/// The converse is deliberately not concluded: a case-sensitive directory may
/// simply contain no such pair, so an absence of evidence never narrows the
/// contract.
fn has_case_colliding_names(entries: &[WorkspaceDirectoryEntry]) -> bool {
    let mut folded: Vec<String> = entries
        .iter()
        .map(|entry| file_identity::folded_name(&entry.name))
        .collect();
    folded.sort();
    folded.windows(2).any(|pair| pair[0] == pair[1])
}

/// Creates one empty file or one directory without overwriting anything.
pub fn create_entry(request: &CreateEntryRequest) -> Result<CreatedEntry, FileCommandError> {
    validate_leaf_name(&request.name, CODE_IO_CREATE)?;

    let parent_metadata = fs::metadata(&request.parent_path)
        .map_err(|error| create_error(&request.parent_path, error))?;
    if !parent_metadata.is_dir() {
        return Err(FileCommandError::new(
            CODE_IO_CREATE,
            format!("Not a directory: {}", request.parent_path),
        ));
    }

    // The user-facing parent path is preserved so the new node matches how the
    // Explorer already spells that directory.
    let target = Path::new(&request.parent_path).join(&request.name);
    if entry_exists(&target) {
        return Err(FileCommandError::new(
            CODE_IO_CREATE,
            format!("Already exists: {}", target.to_string_lossy()),
        ));
    }

    let created = match request.kind {
        // `create_new` is the only non-overwriting file creation std offers, so
        // an existing target is refused by the filesystem itself.
        CreateEntryKind::File => fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map(|_| ()),
        CreateEntryKind::Directory => fs::create_dir(&target),
    };

    created.map_err(|error| create_error(&target.to_string_lossy(), error))?;

    let path = target.to_string_lossy().to_string();
    let identity = file_identity::resolve_path_identity(&path, false)?;

    Ok(CreatedEntry { path, identity })
}

/// Renames one entry inside its current parent directory.
pub fn rename_entry(request: &RenameEntryRequest) -> Result<RenamedEntry, FileCommandError> {
    validate_leaf_name(&request.new_name, CODE_IO_RENAME)?;

    let source = Path::new(&request.source_path);
    let old_canonical =
        fs::canonicalize(source).map_err(|error| rename_error(&request.source_path, error))?;

    let parent = match source.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.to_path_buf(),
        _ => PathBuf::from("."),
    };
    let destination = parent.join(&request.new_name);

    // Re-spelling the current name is a successful no-op rather than a conflict;
    // a case-only change still reaches the filesystem because the names differ.
    if source.file_name() == Some(std::ffi::OsStr::new(&request.new_name)) {
        let new_path = source.to_string_lossy().to_string();
        let new_identity = file_identity::resolve_path_identity(&new_path, false)?;
        return Ok(RenamedEntry {
            old_canonical_path: old_canonical.to_string_lossy().to_string(),
            new_path,
            new_identity,
        });
    }

    // A destination that already exists is a conflict unless it *is* the source
    // entry under another spelling. A case-only respelling is the only reuse the
    // rename authorizes: a link or hard link that merely resolves to the source
    // has a name of its own, so it must never be replaced (plan decision 9, US6
    // acceptance 5).
    let destination_exists = entry_exists(&destination);
    let case_only_respelling = destination_exists && is_case_only_respelling(source, &destination);

    if destination_exists && !case_only_respelling {
        return Err(FileCommandError::new(
            CODE_IO_RENAME,
            format!("Already exists: {}", destination.to_string_lossy()),
        ));
    }

    // The validation above cannot close the race by itself: a destination that
    // appears after it has to fail the move rather than be silently replaced
    // (SC-009), so the move itself is issued without a replace flag.
    match move_entry_without_replacement(source, &destination) {
        Ok(()) => {}
        Err(error) if case_only_respelling && error.kind() == std::io::ErrorKind::AlreadyExists => {
            // A case-insensitive filesystem still reports the entry's other
            // spelling as an existing destination for a no-replace move, so the
            // entry steps aside through a temporary name.
            move_entry_through_temporary_name(source, &destination)
                .map_err(|error| rename_error(&request.source_path, error))?;
        }
        Err(error) => return Err(rename_error(&request.source_path, error)),
    }

    let new_path = destination.to_string_lossy().to_string();
    let new_identity = file_identity::resolve_path_identity(&new_path, false)?;

    Ok(RenamedEntry {
        old_canonical_path: old_canonical.to_string_lossy().to_string(),
        new_path,
        new_identity,
    })
}

/// Whether `destination` is the source entry re-spelled with different case.
///
/// Only a spelling change may reuse an existing destination, and the test is
/// deliberately two-sided: the containing directory must really compare names
/// case-insensitively (the one shared contract, not a fold invented here) *and*
/// both paths must still resolve to the same object. A destination link or hard
/// link that merely resolves to the source has a name of its own, so it is a
/// distinct entry and is never authorized here (plan decision 9, US6
/// acceptance 5).
fn is_case_only_respelling(source: &Path, destination: &Path) -> bool {
    is_case_only_respelling_with(&file_identity::PlatformCaseComparator, source, destination)
}

/// [`is_case_only_respelling`] against an injected comparison contract.
///
/// The seam exists so both answers can be pinned: a directory that really
/// compares names case-insensitively keeps the spelling change working, and a
/// directory that reports case-sensitive comparison refuses the very same paths.
fn is_case_only_respelling_with(
    comparator: &impl file_identity::CaseComparator,
    source: &Path,
    destination: &Path,
) -> bool {
    let (source_name, destination_name) = match (source.file_name(), destination.file_name()) {
        (Some(source_name), Some(destination_name)) => (source_name, destination_name),
        _ => return false,
    };

    if source_name == destination_name {
        return false;
    }

    // The names must differ by case alone: `real` versus `alias` is never a
    // re-spelling, however the two paths happen to resolve.
    if file_identity::folded_name(&source_name.to_string_lossy())
        != file_identity::folded_name(&destination_name.to_string_lossy())
    {
        return false;
    }

    // In a case-sensitive directory the two spellings are two entries by
    // definition, so an existing destination is a different entry and the rename
    // must refuse it instead of stepping aside.
    let parent = match destination.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        _ => Path::new("."),
    };
    if file_identity::directory_case_sensitive_with(comparator, parent) {
        return false;
    }

    match (fs::canonicalize(source), fs::canonicalize(destination)) {
        (Ok(existing), Ok(other)) => comparison_key(&existing) == comparison_key(&other),
        _ => false,
    }
}

/// Moves `source` onto `destination` without replacing anything that exists.
fn move_entry_without_replacement(source: &Path, destination: &Path) -> std::io::Result<()> {
    platform_move_without_replacement(source, destination)
}

/// Windows moves with `MoveFileExW` and no `MOVEFILE_REPLACE_EXISTING` flag, so
/// an existing destination fails the call instead of being replaced.
#[cfg(windows)]
fn platform_move_without_replacement(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::MoveFileExW;

    let source_wide: Vec<u16> = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let destination_wide: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    // SAFETY: both pointers are NUL-terminated wide strings that outlive the
    // call, and no argument is retained by the callee.
    let moved = unsafe { MoveFileExW(source_wide.as_ptr(), destination_wide.as_ptr(), 0) };

    if moved == 0 {
        return Err(std::io::Error::last_os_error());
    }

    Ok(())
}

/// Other platforms repeat the existence check immediately before the move,
/// which is the closest `std` offers to a no-replace rename there.
#[cfg(not(windows))]
fn platform_move_without_replacement(source: &Path, destination: &Path) -> std::io::Result<()> {
    if fs::symlink_metadata(destination).is_ok() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "the destination already exists",
        ));
    }

    fs::rename(source, destination)
}

/// Re-spells an entry that already occupies its own destination name.
///
/// The destination has been proven to be this same entry, so the move steps
/// aside through a temporary sibling name and then takes the new spelling. A
/// failed second move restores the original name instead of leaving the entry
/// under the temporary one.
fn move_entry_through_temporary_name(source: &Path, destination: &Path) -> std::io::Result<()> {
    let parent = match destination.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        _ => Path::new("."),
    };

    for attempt in 0..16 {
        let temporary = parent.join(format!(".sorakada-rename-{}-{attempt}", std::process::id()));

        if fs::symlink_metadata(&temporary).is_ok() {
            continue;
        }

        match move_entry_without_replacement(source, &temporary) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }

        match move_entry_without_replacement(&temporary, destination) {
            Ok(()) => return Ok(()),
            Err(error) => {
                let _ = move_entry_without_replacement(&temporary, source);
                return Err(error);
            }
        }
    }

    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        "no temporary name is available for the rename",
    ))
}

/// Moves one entry to the operating system's recycle/trash facility.
///
/// There is deliberately no `remove_file`/`remove_dir_all` fallback: FR-066 and
/// FR-067 require Delete to be recoverable and forbid exposing permanent
/// deletion, so a failed trash operation stays a failed Delete.
pub fn trash_entry(path: &str) -> Result<(), FileCommandError> {
    if !entry_exists(Path::new(path)) {
        return Err(FileCommandError::new(
            CODE_IO_TRASH,
            format!("Cannot move to the recycle bin, path does not exist: {path}"),
        ));
    }

    trash::delete(path).map_err(|error| {
        FileCommandError::new(
            CODE_IO_TRASH,
            format!("Cannot move {path} to the recycle bin: {error}"),
        )
    })
}

/// Rejects anything that is not exactly one ordinary path component.
///
/// Platform-specific reserved names are intentionally left to the filesystem,
/// so naming rules follow the platform instead of being re-implemented here.
/// `code` is the caller's operation code, so a rejected Rename name is reported
/// as `io_rename` rather than `io_create`.
pub fn validate_leaf_name(name: &str, code: &str) -> Result<(), FileCommandError> {
    if name.is_empty() {
        return Err(FileCommandError::new(code, "A name is required."));
    }

    if name == "." || name == ".." {
        return Err(FileCommandError::new(
            code,
            format!("\"{name}\" is not a valid name."),
        ));
    }

    if name.chars().any(|character| character.is_control()) {
        return Err(FileCommandError::new(
            code,
            format!("\"{name}\" is not a valid name."),
        ));
    }

    // `Path::components` is platform-aware, so this rejects both separators on
    // Windows while a name containing the other platform's separator stays a
    // legal single component there.
    let mut components = Path::new(name).components();
    let single = components.next();
    if components.next().is_some()
        || !matches!(single, Some(std::path::Component::Normal(_)))
    {
        return Err(FileCommandError::new(
            code,
            format!("\"{name}\" must be a single file or folder name."),
        ));
    }

    Ok(())
}

/// Whether anything (including a broken link) occupies `path`.
fn entry_exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

/// Describes one directory entry, tolerating entries that cannot be followed.
fn describe_entry(
    parent: &Path,
    entry: &fs::DirEntry,
) -> Result<WorkspaceDirectoryEntry, FileCommandError> {
    let path = parent.join(entry.file_name());

    // `symlink_metadata` never follows the link, which is what makes the
    // `isSymlink` flag report the entry itself rather than its target.
    let link_metadata = fs::symlink_metadata(&path)
        .map_err(|error| directory_error(&path.to_string_lossy(), error))?;
    let is_symlink = link_metadata.file_type().is_symlink();

    // Resolving the target decides whether the entry behaves as a directory. A
    // broken link resolves to nothing and is still listed as `other`, so one
    // bad entry can never fail the whole directory read.
    let kind = match fs::metadata(&path) {
        Ok(target) if target.is_dir() => WorkspaceEntryKind::Directory,
        Ok(target) if target.is_file() => WorkspaceEntryKind::File,
        Ok(_) => WorkspaceEntryKind::Other,
        Err(_) => WorkspaceEntryKind::Other,
    };

    Ok(WorkspaceDirectoryEntry {
        name: entry.file_name().to_string_lossy().to_string(),
        path: path.to_string_lossy().to_string(),
        kind,
        is_symlink,
        // The *entry's* own identity, without following a final link: no second
        // directory listing, no directory recursion and no file content is
        // involved in obtaining 006's entry token.
        object_identity: file_identity::object_identity(&path, false),
    })
}

/// Directories first, then everything else, case-insensitively by name.
///
/// The Explorer model applies the same rule, so the UI order does not depend on
/// the order the filesystem happened to return.
pub fn sort_entries(entries: &mut [WorkspaceDirectoryEntry]) {
    entries.sort_by(|left, right| {
        let left_directory = left.kind == WorkspaceEntryKind::Directory;
        let right_directory = right.kind == WorkspaceEntryKind::Directory;

        right_directory
            .cmp(&left_directory)
            .then_with(|| {
                // Display ordering only: this is the Explorer's presentation rule,
                // not an identity or comparison contract (which lives in
                // `file_identity`), so it may fold more aggressively than the
                // filesystem itself does.
                file_identity::folded_name(&left.name)
                    .cmp(&file_identity::folded_name(&right.name))
            })
            .then_with(|| left.name.cmp(&right.name))
    });
}

/// Builds the `io_directory` error for one failed directory read.
fn directory_error(path: &str, error: std::io::Error) -> FileCommandError {
    FileCommandError::new(
        CODE_IO_DIRECTORY,
        format!("Cannot read directory {path}: {error}"),
    )
}

/// Builds the `io_create` error for one failed creation.
fn create_error(path: &str, error: std::io::Error) -> FileCommandError {
    FileCommandError::new(
        CODE_IO_CREATE,
        format!("Cannot create {path}: {error}"),
    )
}

/// Builds the `io_rename` error for one failed rename.
fn rename_error(path: &str, error: std::io::Error) -> FileCommandError {
    FileCommandError::new(
        CODE_IO_RENAME,
        format!("Cannot rename {path}: {error}"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support;
    use serde_json::{json, Value};

    fn work_dir(name: &str) -> PathBuf {
        let mut dir = std::env::temp_dir();
        dir.push(format!("sorakada-workspace-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn display(path: &Path) -> String {
        path.to_string_lossy().to_string()
    }

    fn to_json<T: Serialize>(value: &T) -> Value {
        serde_json::to_value(value).expect("serialize to json")
    }

    fn names(result: &WorkspaceDirectoryResult) -> Vec<String> {
        result
            .entries
            .iter()
            .map(|entry| entry.name.clone())
            .collect()
    }

    fn kind_of(result: &WorkspaceDirectoryResult, name: &str) -> WorkspaceEntryKind {
        result
            .entries
            .iter()
            .find(|entry| entry.name == name)
            .unwrap_or_else(|| panic!("{name} must be listed"))
            .kind
    }

    /// FR-002/FR-006: one level only, plus the identity of the directory read.
    #[test]
    fn read_directory_returns_direct_children_and_the_directory_identity() {
        let dir = work_dir("read-one-level");
        fs::create_dir_all(dir.join("src").join("deep")).expect("create nested dirs");
        fs::write(dir.join("src").join("deep").join("hidden.ts"), b"x").expect("write nested file");
        fs::write(dir.join("readme.md"), b"x").expect("write root file");
        fs::create_dir_all(dir.join("node_modules")).expect("create node_modules");

        let result = read_directory(&display(&dir)).expect("read the root");

        // No recursive walk: `deep` and `hidden.ts` must not appear.
        assert_eq!(names(&result), vec!["node_modules", "src", "readme.md"]);
        assert_eq!(result.requested_path, display(&dir));
        assert!(!result.comparison_key.is_empty());
        assert!(
            !result.canonical_path.is_empty(),
            "the directory identity is part of the contract"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_directory_reports_the_identity_of_the_directory_actually_read() {
        let dir = work_dir("read-identity");
        fs::create_dir_all(dir.join("src")).expect("create src");
        let requested = dir.join("src").join("..").join("src");

        let result = read_directory(&display(&requested)).expect("read through a detour");
        let identity = file_identity::resolve_path_identity(&display(&dir.join("src")), false)
            .expect("resolve the plain spelling");

        assert_eq!(
            result.comparison_key, identity.comparison_key,
            "equivalent spellings must share one directory identity"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_directory_sorts_directories_first_then_case_insensitive_names() {
        let dir = work_dir("read-sorting");
        for name in ["zeta.txt", "Alpha", "beta.txt", "delta"] {
            fs::write(dir.join(name), b"x").expect("write fixture");
        }
        fs::create_dir_all(dir.join("gamma")).expect("create dir");

        let result = read_directory(&display(&dir)).expect("read the root");

        assert_eq!(names(&result), vec!["gamma", "Alpha", "beta.txt", "delta", "zeta.txt"]);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_directory_errors_for_missing_paths_and_for_files() {
        let dir = work_dir("read-errors");
        let file = dir.join("notes.txt");
        fs::write(&file, b"x").expect("write fixture");

        let missing = read_directory(&display(&dir.join("absent")))
            .expect_err("a missing directory must fail");
        assert_eq!(missing.code, CODE_IO_DIRECTORY);
        assert!(!missing.message.is_empty());

        let not_a_directory =
            read_directory(&display(&file)).expect_err("a file is not a directory");
        assert_eq!(not_a_directory.code, CODE_IO_DIRECTORY);

        let _ = fs::remove_dir_all(&dir);
    }

    /// The comparison contract the pre-mutation source check relies on: the
    /// filesystem's own answer for the directory, strengthened only by direct
    /// evidence from the listing.
    #[test]
    fn read_directory_reports_the_case_comparison_contract() {
        let dir = work_dir("read-case-contract");
        fs::write(dir.join("notes.txt"), b"x").expect("write fixture");

        let result = read_directory(&display(&dir)).expect("read the root");

        // No case-distinct pair in this listing, so the directory's own rule is
        // the whole contract (T156).
        assert_eq!(
            result.case_sensitive,
            file_identity::directory_case_sensitive(Path::new(&result.canonical_path)),
            "without direct evidence the directory's own comparison rule is the contract"
        );

        // A case-distinct pair cannot exist in a case-insensitive directory, so
        // observing one is proof of a case-sensitive directory on any platform.
        let colliding = vec![
            WorkspaceDirectoryEntry {
                name: "Alpha".to_string(),
                path: display(&dir.join("Alpha")),
                kind: WorkspaceEntryKind::File,
                is_symlink: false,
                object_identity: None,
            },
            WorkspaceDirectoryEntry {
                name: "alpha".to_string(),
                path: display(&dir.join("alpha")),
                kind: WorkspaceEntryKind::File,
                is_symlink: false,
                object_identity: None,
            },
        ];
        assert!(
            has_case_colliding_names(&colliding),
            "a case-distinct pair proves case-sensitive comparison"
        );
        assert!(
            directory_comparison_contract(Path::new(&result.canonical_path), &colliding),
            "the contract can only become stricter, never looser"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// The JSON shapes the frontend's Workspace DTOs read.
    #[test]
    fn read_directory_matches_the_ipc_contract_shape() {
        let dir = work_dir("read-shape");
        fs::write(dir.join("a.txt"), b"x").expect("write fixture");
        fs::create_dir_all(dir.join("src")).expect("create src");

        let value = to_json(&read_directory(&display(&dir)).expect("read the root"));

        assert_eq!(value.as_object().expect("object").len(), 5);
        assert!(value["requestedPath"].is_string());
        assert!(value["canonicalPath"].is_string());
        assert!(value["comparisonKey"].is_string());
        assert!(
            value["caseSensitive"].is_boolean(),
            "the platform comparison contract is part of the wire shape"
        );
        assert!(value.get("requested_path").is_none());

        let entries = value["entries"].as_array().expect("entry array");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["name"], json!("src"));
        assert_eq!(entries[0]["kind"], json!("directory"));
        assert_eq!(entries[0]["isSymlink"], json!(false));
        assert_eq!(entries[1]["kind"], json!("file"));
        assert_eq!(
            entries[0].as_object().expect("object").len(),
            5,
            "a directory entry carries exactly name/path/kind/isSymlink/objectIdentity"
        );
        assert!(
            entries[0]["objectIdentity"].is_string(),
            "a listed entry carries the opaque 006 entry identity"
        );
        assert!(entries[0].get("is_symlink").is_none());
        assert!(entries[0].get("object_identity").is_none());

        // The entry path is built from the requested parent, so it is what the
        // user selected rather than an internal canonical spelling.
        assert_eq!(
            entries[0]["path"],
            json!(display(&dir.join("src")))
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// FR-026/FR-031/FR-034 entry metadata, including link flagging.
    #[test]
    fn read_directory_flags_links_and_classifies_their_targets() {
        let dir = work_dir("read-links");
        let target = dir.join("targets");
        fs::create_dir_all(&target).expect("create target dir");
        fs::write(dir.join("plain.txt"), b"x").expect("write plain file");

        let link = dir.join("linked");
        if !test_support::create_directory_link(&target, &link) {
            let _ = fs::remove_dir_all(&dir);
            return;
        }

        let result = read_directory(&display(&dir)).expect("read the root");
        let entry = result
            .entries
            .iter()
            .find(|entry| entry.name == "linked")
            .expect("the link must be listed");

        assert!(entry.is_symlink, "a directory link must be flagged");
        assert_eq!(
            entry.kind,
            WorkspaceEntryKind::Directory,
            "a link that resolves to a directory behaves as one"
        );
        assert_eq!(
            kind_of(&result, "plain.txt"),
            WorkspaceEntryKind::File
        );
        assert_eq!(kind_of(&result, "targets"), WorkspaceEntryKind::Directory);

        let _ = fs::remove_dir_all(&dir);
    }

    /// 006: one-level reads carry a usable identity for every entry that the
    /// platform can identify, and reading the directory twice reports the same
    /// token — without ever reading a descendant level.
    #[test]
    fn read_directory_reports_a_stable_object_identity_per_entry() {
        let dir = work_dir("read-object-identity");
        fs::write(dir.join("a.txt"), b"x").expect("write fixture file");
        fs::create_dir_all(dir.join("src").join("deep")).expect("create nested dirs");
        fs::write(dir.join("src").join("deep").join("hidden.ts"), b"x").expect("write nested file");

        let first = read_directory(&display(&dir)).expect("read the root");
        let second = read_directory(&display(&dir)).expect("read the root again");

        for (entry, again) in first.entries.iter().zip(second.entries.iter()) {
            assert_eq!(entry.name, again.name);
            assert_eq!(
                entry.object_identity, again.object_identity,
                "{} must report a stable identity across reads",
                entry.name
            );
        }

        for name in ["a.txt", "src"] {
            let entry = first
                .entries
                .iter()
                .find(|entry| entry.name == name)
                .expect("the entry must be listed");
            assert!(
                entry.object_identity.is_some(),
                "{name} must carry an object identity on a platform that provides one"
            );
        }

        // The nested file is never part of a one-level read, so no recursion
        // happened to produce these identities.
        assert!(
            !names(&first).contains(&"hidden.ts".to_string()),
            "a one-level read must not enumerate descendants"
        );

        // Recreating the entry produces a different object, so the identity is
        // not merely a hash of the path.
        let before = first
            .entries
            .iter()
            .find(|entry| entry.name == "a.txt")
            .expect("the file must be listed")
            .object_identity
            .clone();
        fs::remove_file(dir.join("a.txt")).expect("delete the fixture file");
        fs::write(dir.join("a.txt"), b"x").expect("recreate the fixture file");
        let after = read_directory(&display(&dir))
            .expect("read the root after the replacement")
            .entries
            .iter()
            .find(|entry| entry.name == "a.txt")
            .expect("the file must be listed")
            .object_identity
            .clone();

        if let (Some(before), Some(after)) = (before, after) {
            assert_ne!(before, after, "a recreated entry is a different object");
        }

        let _ = fs::remove_dir_all(&dir);
    }

    /// 006 keeps the two identity domains apart: a link entry is identified by
    /// its own reparse point, not by the directory it resolves to.
    #[test]
    fn read_directory_identifies_a_link_entry_itself() {
        let dir = work_dir("read-link-identity");
        let target = dir.join("targets");
        fs::create_dir_all(&target).expect("create target dir");

        let link = dir.join("linked");
        if !test_support::create_directory_link(&target, &link) {
            let _ = fs::remove_dir_all(&dir);
            return;
        }

        let result = read_directory(&display(&dir)).expect("read the root");
        let link_entry = result
            .entries
            .iter()
            .find(|entry| entry.name == "linked")
            .expect("the link must be listed");
        let target_entry = result
            .entries
            .iter()
            .find(|entry| entry.name == "targets")
            .expect("the target must be listed");

        assert!(link_entry.is_symlink);
        if let (Some(link_identity), Some(target_identity)) =
            (&link_entry.object_identity, &target_entry.object_identity)
        {
            assert_ne!(
                link_identity, target_identity,
                "a link entry must not simply borrow its target's identity"
            );
        }

        let _ = fs::remove_dir_all(&dir);
    }

    /// A broken link still carries the identity of the entry that exists, which
    /// is what lets 006 reconcile its removal or replacement.
    #[test]
    fn read_directory_identifies_a_broken_link_entry() {
        let dir = work_dir("read-broken-link-identity");
        let link = dir.join("dangling");

        if !test_support::create_file_link(&dir.join("absent.txt"), &link) {
            let _ = fs::remove_dir_all(&dir);
            return;
        }

        let result = read_directory(&display(&dir)).expect("read the root");
        let entry = result
            .entries
            .iter()
            .find(|entry| entry.name == "dangling")
            .expect("the broken link must be listed");

        assert!(entry.is_symlink);
        assert!(
            entry.object_identity.is_some(),
            "the entry itself exists, so its identity is available"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_directory_lists_a_broken_link_as_other_without_failing() {
        let dir = work_dir("read-broken-link");
        let link = dir.join("dangling");

        if !test_support::create_file_link(&dir.join("absent.txt"), &link) {
            let _ = fs::remove_dir_all(&dir);
            return;
        }

        let result = read_directory(&display(&dir)).expect("one broken link must not fail the read");
        let entry = result
            .entries
            .iter()
            .find(|entry| entry.name == "dangling")
            .expect("the broken link must still be listed");

        assert_eq!(entry.kind, WorkspaceEntryKind::Other);
        assert!(entry.is_symlink);

        let _ = fs::remove_dir_all(&dir);
    }

    /* ---------------------------------------------------------------- */
    /* create                                                             */
    /* ---------------------------------------------------------------- */

    #[test]
    fn create_entry_makes_an_empty_file_and_a_directory() {
        let dir = work_dir("create-kinds");

        let file = create_entry(&CreateEntryRequest {
            parent_path: display(&dir),
            name: "new.txt".to_string(),
            kind: CreateEntryKind::File,
        })
        .expect("create the file");

        assert_eq!(file.path, display(&dir.join("new.txt")));
        assert_eq!(fs::metadata(&file.path).expect("stat").len(), 0);
        assert_eq!(file.identity.kind, file_identity::ResolvedPathKind::File);

        let folder = create_entry(&CreateEntryRequest {
            parent_path: display(&dir),
            name: "sub".to_string(),
            kind: CreateEntryKind::Directory,
        })
        .expect("create the directory");

        assert!(Path::new(&folder.path).is_dir());
        assert_eq!(
            folder.identity.kind,
            file_identity::ResolvedPathKind::Directory
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn create_entry_never_overwrites_an_existing_target() {
        let dir = work_dir("create-conflict");
        let existing = dir.join("keep.txt");
        fs::write(&existing, b"original").expect("write fixture");
        fs::create_dir_all(dir.join("existing-dir")).expect("create dir");

        for (name, kind) in [
            ("keep.txt", CreateEntryKind::File),
            ("existing-dir", CreateEntryKind::Directory),
            // A file may not be created where a directory already exists, and
            // the check is on the target itself, not on its type.
            ("existing-dir", CreateEntryKind::File),
            ("keep.txt", CreateEntryKind::Directory),
        ] {
            let error = create_entry(&CreateEntryRequest {
                parent_path: display(&dir),
                name: name.to_string(),
                kind,
            })
            .expect_err("an existing target must be refused");

            assert_eq!(error.code, CODE_IO_CREATE);
            assert!(!error.message.is_empty());
        }

        assert_eq!(
            fs::read(&existing).expect("read back"),
            b"original".to_vec(),
            "the existing file must be untouched"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn create_entry_rejects_names_that_are_not_one_leaf_component() {
        let dir = work_dir("create-names");

        for name in ["", ".", "..", "a/b", "a\\b", "a\0b", "a\nb"] {
            let error = create_entry(&CreateEntryRequest {
                parent_path: display(&dir),
                name: name.to_string(),
                kind: CreateEntryKind::File,
            })
            .expect_err("an invalid name must be refused");

            assert_eq!(error.code, CODE_IO_CREATE, "name {name:?}");
            assert!(!error.message.is_empty());
        }

        assert_eq!(
            fs::read_dir(&dir).expect("read dir").count(),
            0,
            "no invalid name may leave an entry behind"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn create_entry_reports_a_missing_parent() {
        let dir = work_dir("create-missing-parent");

        let error = create_entry(&CreateEntryRequest {
            parent_path: display(&dir.join("absent")),
            name: "new.txt".to_string(),
            kind: CreateEntryKind::File,
        })
        .expect_err("a missing parent must fail");

        assert_eq!(error.code, CODE_IO_CREATE);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn create_entry_request_accepts_the_camel_case_frontend_shape() {
        let request: CreateEntryRequest = serde_json::from_value(json!({
            "parentPath": "C:\\work",
            "name": "new.txt",
            "kind": "file",
        }))
        .expect("deserialize the frontend request shape");

        assert_eq!(request.parent_path, "C:\\work");
        assert_eq!(request.kind, CreateEntryKind::File);

        let snake_case = serde_json::from_value::<CreateEntryRequest>(json!({
            "parent_path": "C:\\work",
            "name": "new.txt",
            "kind": "file",
        }));
        assert!(snake_case.is_err(), "the request is camelCase only");
    }

    #[test]
    fn created_entry_serializes_the_camel_case_wire_shape() {
        let dir = work_dir("create-wire");
        let created = create_entry(&CreateEntryRequest {
            parent_path: display(&dir),
            name: "new.txt".to_string(),
            kind: CreateEntryKind::File,
        })
        .expect("create");

        let value = to_json(&created);

        assert_eq!(value.as_object().expect("object").len(), 2);
        assert!(value["path"].is_string());
        assert!(value["identity"]["comparisonKey"].is_string());
        // `identity` is the 002 `ResolvedPathIdentity` shape, unchanged.
        assert_eq!(value["identity"]["kind"], json!("file"));

        let _ = fs::remove_dir_all(&dir);
    }

    /* ---------------------------------------------------------------- */
    /* rename                                                             */
    /* ---------------------------------------------------------------- */

    #[test]
    fn rename_entry_returns_the_old_identity_and_the_new_identity() {
        let dir = work_dir("rename-file");
        let source = dir.join("before.txt");
        fs::write(&source, b"content").expect("write fixture");

        let before =
            file_identity::resolve_path_identity(&display(&source), false).expect("resolve before");

        let renamed = rename_entry(&RenameEntryRequest {
            source_path: display(&source),
            new_name: "after.txt".to_string(),
        })
        .expect("rename the file");

        assert!(!source.exists(), "the source must be gone");
        assert_eq!(renamed.new_path, display(&dir.join("after.txt")));
        assert_eq!(
            Path::new(&renamed.old_canonical_path).file_name(),
            Some(std::ffi::OsStr::new("before.txt")),
            "the old canonical path describes the pre-rename entry"
        );
        assert_ne!(
            renamed.new_identity.comparison_key, before.comparison_key,
            "a rename must produce a new comparison key"
        );
        assert_eq!(
            renamed.new_identity.comparison_key,
            file_identity::resolve_path_identity(&renamed.new_path, false)
                .expect("resolve after")
                .comparison_key
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_entry_renames_a_directory_and_keeps_its_contents() {
        let dir = work_dir("rename-directory");
        fs::create_dir_all(dir.join("src").join("nested")).expect("create nested dirs");
        fs::write(dir.join("src").join("nested").join("a.ts"), b"x").expect("write nested file");

        let renamed = rename_entry(&RenameEntryRequest {
            source_path: display(&dir.join("src")),
            new_name: "lib".to_string(),
        })
        .expect("rename the directory");

        assert!(dir.join("lib").join("nested").join("a.ts").is_file());
        assert!(!dir.join("src").exists());
        assert_eq!(
            renamed.new_identity.kind,
            file_identity::ResolvedPathKind::Directory
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_entry_refuses_an_existing_destination() {
        let dir = work_dir("rename-conflict");
        let source = dir.join("source.txt");
        let destination = dir.join("taken.txt");
        fs::write(&source, b"source").expect("write source");
        fs::write(&destination, b"taken").expect("write destination");

        let error = rename_entry(&RenameEntryRequest {
            source_path: display(&source),
            new_name: "taken.txt".to_string(),
        })
        .expect_err("an existing destination must be refused");

        assert_eq!(error.code, CODE_IO_RENAME);
        assert!(source.is_file(), "the source must be untouched");
        assert_eq!(
            fs::read(&destination).expect("read back"),
            b"taken".to_vec(),
            "the destination must not be overwritten"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_entry_rejects_names_that_are_not_one_leaf_component() {
        let dir = work_dir("rename-names");
        let source = dir.join("a.txt");
        fs::write(&source, b"x").expect("write fixture");

        for name in ["", ".", "..", "a/b", "a\\b"] {
            let error = rename_entry(&RenameEntryRequest {
                source_path: display(&source),
                new_name: name.to_string(),
            })
            .expect_err("an invalid name must be refused");

            assert_eq!(error.code, CODE_IO_RENAME, "name {name:?}");
        }

        assert!(source.is_file(), "the source must be untouched");

        let _ = fs::remove_dir_all(&dir);
    }

    /// On a case-insensitive filesystem a spelling-only rename targets the
    /// source itself and must still succeed.
    #[test]
    #[cfg(windows)]
    fn rename_entry_allows_a_case_only_change_on_windows() {
        let dir = work_dir("rename-case");
        let source = dir.join("case.txt");
        fs::write(&source, b"x").expect("write fixture");

        let renamed = rename_entry(&RenameEntryRequest {
            source_path: display(&source),
            new_name: "CASE.TXT".to_string(),
        })
        .expect("a case-only rename must succeed");

        assert_eq!(
            Path::new(&renamed.new_path).file_name(),
            Some(std::ffi::OsStr::new("CASE.TXT"))
        );
        assert!(dir.join("CASE.TXT").is_file());

        let _ = fs::remove_dir_all(&dir);
    }

    /// A comparison contract that reports one fixed answer for every directory.
    #[cfg(windows)]
    struct FixedCaseContract {
        case_sensitive: bool,
    }

    #[cfg(windows)]
    impl file_identity::CaseComparator for FixedCaseContract {
        fn case_sensitivity(&self, _directory: &Path) -> Option<bool> {
            Some(self.case_sensitive)
        }
    }

    /// T156: the directory's reported contract is what decides whether a
    /// case-only re-spelling names the same entry. The very same paths must be
    /// accepted where the directory is case-insensitive and refused where it is
    /// not, so a case-sensitive directory can never let a rename step aside onto
    /// a differently-cased entry (Constitution I, FR-066).
    #[test]
    #[cfg(windows)]
    fn a_case_sensitive_directory_refuses_a_case_only_respelling() {
        let dir = work_dir("rename-case-contract");
        let source = dir.join("case.txt");
        fs::write(&source, b"x").expect("write fixture");
        let destination = dir.join("CASE.TXT");

        // On a case-insensitive filesystem both spellings really name one entry,
        // so nothing but the reported contract can decide.
        assert!(
            source.exists() && destination.exists(),
            "the fixture must name one existing entry under both spellings"
        );

        assert!(
            is_case_only_respelling_with(
                &FixedCaseContract {
                    case_sensitive: false,
                },
                &source,
                &destination,
            ),
            "a case-insensitive directory keeps the spelling-only rename working"
        );
        assert!(
            !is_case_only_respelling_with(
                &FixedCaseContract {
                    case_sensitive: true,
                },
                &source,
                &destination,
            ),
            "a case-sensitive directory must treat it as a different entry"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// A destination link that resolves to the source is a *different* entry, so
    /// the rename must refuse it instead of replacing the link (US6
    /// acceptance 5).
    #[test]
    fn rename_entry_refuses_a_destination_link_to_the_source() {
        let dir = work_dir("rename-alias");
        let source = dir.join("real");
        fs::create_dir(&source).expect("create source directory");
        fs::write(source.join("a.ts"), b"x").expect("write nested file");

        let alias = dir.join("alias");
        if !test_support::create_directory_link(&source, &alias) {
            // Link creation needs a privilege this machine may not grant, so the
            // fixture simply does not exist here.
            let _ = fs::remove_dir_all(&dir);
            return;
        }

        let error = rename_entry(&RenameEntryRequest {
            source_path: display(&source),
            new_name: "alias".to_string(),
        })
        .expect_err("a destination link must be refused");

        assert_eq!(error.code, CODE_IO_RENAME);
        assert!(
            error.message.contains("Already exists"),
            "the destination must be refused as an existing entry, not by a failed move: {}",
            error.message
        );
        assert!(
            source.join("a.ts").is_file(),
            "the source must be untouched by the refused rename"
        );
        assert!(
            alias.join("a.ts").is_file(),
            "the destination link must still name its target"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// The move itself refuses a destination that appeared after the caller's
    /// validation, so the check-then-rename window cannot replace anything
    /// (plan decision 9, SC-009).
    #[test]
    fn move_entry_without_replacement_refuses_a_destination_that_appeared() {
        let dir = work_dir("rename-appeared");
        let source = dir.join("source.txt");
        let destination = dir.join("appeared.txt");
        fs::write(&source, b"source").expect("write fixture");
        // The destination appears between the validation and the move.
        fs::write(&destination, b"appeared").expect("write fixture");

        let error = move_entry_without_replacement(&source, &destination)
            .expect_err("an existing destination must not be replaced");

        assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read(&source).expect("read source"), b"source".to_vec());
        assert_eq!(
            fs::read(&destination).expect("read destination"),
            b"appeared".to_vec(),
            "the destination must not be overwritten"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_entry_to_the_current_name_is_a_no_op_success() {
        let dir = work_dir("rename-same-name");
        let source = dir.join("same.txt");
        fs::write(&source, b"x").expect("write fixture");

        let renamed = rename_entry(&RenameEntryRequest {
            source_path: display(&source),
            new_name: "same.txt".to_string(),
        })
        .expect("re-spelling the current name must succeed");

        assert_eq!(renamed.new_path, display(&source));
        assert!(source.is_file());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_entry_reports_a_missing_source() {
        let dir = work_dir("rename-missing");

        let error = rename_entry(&RenameEntryRequest {
            source_path: display(&dir.join("absent.txt")),
            new_name: "other.txt".to_string(),
        })
        .expect_err("a missing source must fail");

        assert_eq!(error.code, CODE_IO_RENAME);

        let _ = fs::remove_dir_all(&dir);
    }

    /* ---------------------------------------------------------------- */
    /* trash                                                              */
    /* ---------------------------------------------------------------- */

    /// FR-066/FR-067: a trash failure is surfaced and the entry is left alone.
    #[test]
    fn trash_entry_reports_a_missing_path_without_deleting_anything() {
        let dir = work_dir("trash-missing");
        let absent = dir.join("absent.txt");

        let error = trash_entry(&display(&absent)).expect_err("a missing path must fail");

        assert_eq!(error.code, CODE_IO_TRASH);
        assert!(
            !error.message.is_empty(),
            "the failure must reach the error dialog"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// A successful trash moves the entry out of its directory; a failure leaves
    /// it in place, and neither outcome permanently deletes it silently.
    #[test]
    fn trash_entry_moves_the_target_or_leaves_it_untouched() {
        let dir = work_dir("trash-entry");
        let target = dir.join("disposable.txt");
        fs::write(&target, b"x").expect("write fixture");

        match trash_entry(&display(&target)) {
            Ok(()) => {
                assert!(
                    !target.exists(),
                    "a successful trash removes the entry from its directory"
                );
            }
            Err(error) => {
                assert_eq!(error.code, CODE_IO_TRASH);
                assert!(
                    target.is_file(),
                    "a failed trash must leave the entry available"
                );
            }
        }

        let _ = fs::remove_dir_all(&dir);
    }
}
