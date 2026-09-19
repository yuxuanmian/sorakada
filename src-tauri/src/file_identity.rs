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
//!
//! 005 adds the validation-facing counterpart for a document that is already
//! bound to a path: [`inspect_document_path`] answers "still there / definitely
//! gone / cannot tell right now", so an external change can be classified
//! without ever turning a transient read failure into a missing document. It
//! reads metadata only, so the rule above still holds.

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
    /// Opaque identity of the object `canonical_path` resolves to (006).
    ///
    /// It is *not* an ownership key: [`Self::comparison_key`] keeps owning path
    /// and destination semantics, exactly as it did before 006. This token only
    /// adds the one fact a canonical path cannot carry — whether the object at a
    /// *different* path is the same filesystem object, which is what makes a
    /// confirmed external rename/move provable instead of guessed. It follows
    /// the final link exactly like the rest of this identity, and it is `None`
    /// when the platform cannot supply a reliable value.
    pub object_identity: Option<String>,
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

/// Request payload of the `resolve_workspace_relation` command.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveWorkspaceRelationRequest {
    /// The active Workspace root.
    pub root_path: String,
    /// The disk-backed path whose relation is being derived.
    pub target_path: String,
}

/// How a disk path relates to the active Workspace root.
///
/// This is a *derived* value in 003: it is never stored on a document session,
/// so saving or renaming a document inside or outside the Workspace changes the
/// answer immediately without reopening the document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum WorkspaceRelation {
    /// The target is the root itself or one of its descendants.
    Inside {
        /// Path of the target relative to the root, using the platform separator.
        #[serde(rename = "relativePath")]
        relative_path: String,
    },
    /// The target lives outside the root, or on a different volume.
    Outside,
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
            disk_revision: Some(disk_revision_for(&metadata)),
            object_identity: object_identity(&canonical, true),
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
        // A destination that does not exist yet has no object to identify. The
        // token appears only once the object really exists, which is what keeps
        // "not created yet" from masquerading as "same object".
        object_identity: None,
    })
}

/// Builds the identity error the frontend normalizes into `path_resolution`.
fn resolution_error(requested_path: &str, error: std::io::Error) -> FileCommandError {
    FileCommandError::new(
        CODE_PATH_RESOLUTION,
        format!("Cannot resolve {requested_path}: {error}"),
    )
}

/// Derives the Workspace relation of `target_path` to `root_path`.
///
/// Both sides are canonicalized first, so equivalent spellings, `..` detours,
/// symlinks and junctions all compare through the object they actually name.
/// Containment is decided component by component rather than by string prefix,
/// so a sibling such as `D:\project-old` is never treated as inside
/// `D:\project`.
pub fn resolve_workspace_relation(
    root_path: &str,
    target_path: &str,
) -> Result<WorkspaceRelation, FileCommandError> {
    let root = canonical_directory(root_path)?;
    let target = fs::canonicalize(target_path).map_err(|error| {
        FileCommandError::new(
            CODE_PATH_RESOLUTION,
            format!("Cannot resolve {target_path}: {error}"),
        )
    })?;

    match relative_within(&root, &target) {
        Some(relative_path) => Ok(WorkspaceRelation::Inside { relative_path }),
        None => Ok(WorkspaceRelation::Outside),
    }
}

/// Resolves a path that must name an existing directory.
fn canonical_directory(path: &str) -> Result<std::path::PathBuf, FileCommandError> {
    let canonical = fs::canonicalize(path).map_err(|error| {
        FileCommandError::new(
            CODE_PATH_RESOLUTION,
            format!("Cannot resolve {path}: {error}"),
        )
    })?;
    let metadata = fs::metadata(&canonical).map_err(|error| {
        FileCommandError::new(
            CODE_PATH_RESOLUTION,
            format!("Cannot resolve {path}: {error}"),
        )
    })?;

    if !metadata.is_dir() {
        return Err(FileCommandError::new(
            CODE_PATH_RESOLUTION,
            format!("Not a directory: {path}"),
        ));
    }

    Ok(canonical)
}

/* -------------------------------------------------------------------- */
/* Directory comparison contract (006 / T156)                            */
/* -------------------------------------------------------------------- */

/// How one *directory* compares the names it contains.
///
/// Case sensitivity is a property of a directory rather than of a platform:
/// Windows 10 1803+ can mark a single directory case-sensitive (the WSL
/// interoperability flag), a Linux filesystem compares exactly everywhere, and a
/// network share may answer neither way. Every consumer that has to decide "may
/// a differently-cased spelling name the same entry here?" therefore asks this
/// one contract instead of re-implementing a platform check.
///
/// `Some(true)` means the directory distinguishes case, `Some(false)` means it
/// does not, and `None` means the platform could not report it. A caller that
/// needs a decision uses [`directory_case_sensitive`], which resolves `None`
/// conservatively.
pub(crate) trait CaseComparator {
    /// The rule of `directory`, or `None` when it cannot be determined.
    fn case_sensitivity(&self, directory: &Path) -> Option<bool>;
}

/// The operating system's own answer.
pub(crate) struct PlatformCaseComparator;

impl CaseComparator for PlatformCaseComparator {
    fn case_sensitivity(&self, directory: &Path) -> Option<bool> {
        platform_directory_case_sensitive(directory)
    }
}

/// Whether names inside `directory` are compared case-sensitively.
///
/// Conservative by construction: a directory whose rule cannot be reported is
/// treated as case-*sensitive*, so nothing may fall back to a differently-cased
/// spelling — a Rename/Delete source (FR-066) or a relocation source
/// (FR-045/FR-056) — without real evidence that the two spellings can be one
/// entry. The price of the conservative answer is a refused convenience, never a
/// mutation of an entry the user did not select (Constitution I).
pub(crate) fn directory_case_sensitive(directory: &Path) -> bool {
    directory_case_sensitive_with(&PlatformCaseComparator, directory)
}

/// [`directory_case_sensitive`] against an injected comparator.
pub(crate) fn directory_case_sensitive_with(
    comparator: &impl CaseComparator,
    directory: &Path,
) -> bool {
    comparator.case_sensitivity(directory).unwrap_or(true)
}

/// The one place a name is folded for comparison.
///
/// Windows compares names with its own upcase table; this Unicode lowercase is
/// the approximation the application already used, kept in a single function so
/// no caller can invent a second rule.
pub(crate) fn folded_name(name: &str) -> String {
    name.to_lowercase()
}

/// Windows: the directory's own `FileCaseSensitiveInfo` flag.
///
/// The flag is read through a handle opened for attribute queries only: no
/// descendant level is enumerated and no file content is touched. `None` covers
/// everything the platform cannot answer — a filesystem driver that does not
/// implement the information class, a share that refuses it, a path that is not
/// a directory — and every caller then treats the directory as case-sensitive.
#[cfg(windows)]
fn platform_directory_case_sensitive(directory: &Path) -> Option<bool> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FileCaseSensitiveInfo, GetFileInformationByHandleEx,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ,
        FILE_SHARE_WRITE, OPEN_EXISTING,
    };

    /// The four-byte output buffer of `FileCaseSensitiveInfo`
    /// (`FILE_CASE_SENSITIVE_INFO`).
    ///
    /// `windows-sys` 0.59 binds the information class in
    /// `Win32::Storage::FileSystem` but the matching struct only in its WDK
    /// module, so the layout is declared here instead of pulling a second
    /// binding surface in for one `u32`.
    #[repr(C)]
    struct CaseSensitiveInformation {
        flags: u32,
    }

    /// `FILE_CS_FLAG_CASE_SENSITIVE_DIR`.
    const CASE_SENSITIVE_DIRECTORY: u32 = 0x0000_0001;

    let wide: Vec<u16> = directory
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    // SAFETY: `wide` is a NUL-terminated buffer that outlives the call, the
    // security attributes are absent and no argument is retained by the callee.
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            std::ptr::null_mut(),
        )
    };

    if handle == INVALID_HANDLE_VALUE {
        return None;
    }

    let mut information = CaseSensitiveInformation { flags: 0 };
    // SAFETY: the handle was opened for attribute queries above, and
    // `information` is a valid, writable, properly aligned value of exactly the
    // size reported to the callee.
    let read = unsafe {
        GetFileInformationByHandleEx(
            handle,
            FileCaseSensitiveInfo,
            std::ptr::addr_of_mut!(information).cast(),
            std::mem::size_of::<CaseSensitiveInformation>() as u32,
        )
    };
    // SAFETY: the handle is owned by this function and is not used afterwards.
    unsafe { CloseHandle(handle) };

    if read == 0 {
        return None;
    }

    Some(information.flags & CASE_SENSITIVE_DIRECTORY != 0)
}

/// Other supported platforms: the platform rule *is* the directory rule.
#[cfg(not(windows))]
fn platform_directory_case_sensitive(_directory: &Path) -> Option<bool> {
    Some(!PATHS_ARE_CASE_INSENSITIVE)
}

/// The path of `target` relative to `root`, or `None` when it is not contained.
///
/// Comparison walks the components of `root` against `target` under the rule of
/// the directory that contains each one, which is why this replaces both a
/// `starts_with`-style text check and any platform-wide folding. `Some("")` means
/// the two paths name the same object.
pub(crate) fn relative_within(root: &Path, target: &Path) -> Option<String> {
    relative_within_with(&PlatformCaseComparator, root, target)
}

/// [`relative_within`] against an injected comparator.
pub(crate) fn relative_within_with(
    comparator: &impl CaseComparator,
    root: &Path,
    target: &Path,
) -> Option<String> {
    let root_components: Vec<_> = root.components().collect();
    let target_components: Vec<_> = target.components().collect();

    if target_components.len() < root_components.len() {
        return None;
    }

    // Component `index` is contained by the components before it, and that prefix
    // is the directory whose rule decides whether the two spellings can name one
    // entry. A volume/share prefix and the root itself have no containing
    // directory, so the platform rule governs them.
    let mut container: Option<std::path::PathBuf> = None;
    for (root_component, target_component) in
        root_components.iter().zip(target_components.iter())
    {
        if !same_component(
            comparator,
            container.as_deref(),
            root_component,
            target_component,
        ) {
            return None;
        }

        let mut next = container.unwrap_or_default();
        next.push(root_component.as_os_str());
        container = Some(next);
    }

    let remainder = &target_components[root_components.len()..];
    if remainder.is_empty() {
        return Some(String::new());
    }

    let mut relative = std::path::PathBuf::new();
    for component in remainder {
        relative.push(component.as_os_str());
    }

    Some(relative.to_string_lossy().to_string())
}

/// Whether two path components name one entry under `directory`'s rule.
///
/// `directory` is the container of the component being compared, or `None` for a
/// prefix/root component, which the platform rule governs. Two identical
/// spellings are answered without asking any directory at all, which is what
/// keeps the per-event containment checks free of filesystem access in the
/// common case (FR-013, FR-014).
fn same_component(
    comparator: &impl CaseComparator,
    directory: Option<&Path>,
    left: &std::path::Component<'_>,
    right: &std::path::Component<'_>,
) -> bool {
    let left = left.as_os_str();
    let right = right.as_os_str();

    if left == right {
        return true;
    }

    let case_insensitive = match directory {
        Some(directory) => !directory_case_sensitive_with(comparator, directory),
        None => PATHS_ARE_CASE_INSENSITIVE,
    };

    if !case_insensitive {
        return false;
    }

    folded_name(&left.to_string_lossy()) == folded_name(&right.to_string_lossy())
}

/// The comparison key of a canonical path, component by component.
///
/// This stays the *only* path-ownership key 002 uses, and it is still derived
/// from the canonical path rather than from a native file id, so distinct
/// hard-link paths keep distinct keys. What changed with T156 is that a name is
/// folded only when the directory that contains it really compares names
/// case-insensitively: two paths that differ by case inside a case-sensitive
/// directory stay two keys instead of collapsing into one.
pub(crate) fn comparison_key(canonical: &Path) -> String {
    comparison_key_with(&PlatformCaseComparator, canonical)
}

/// [`comparison_key`] against an injected comparator.
///
/// A name whose folding would not change it is rendered without asking its
/// directory at all: the answer cannot affect the key, which keeps the
/// per-event watcher path (and every one-level read) from opening handles it
/// does not need.
pub(crate) fn comparison_key_with(
    comparator: &impl CaseComparator,
    canonical: &Path,
) -> String {
    use std::ffi::OsString;
    use std::path::Component;

    let mut parts: Vec<OsString> = Vec::new();
    // The directory that contains the component being rendered next.
    let mut container = std::path::PathBuf::new();

    for component in canonical.components() {
        let text = component.as_os_str();

        match component {
            Component::Prefix(_) => parts.push(text.to_os_string()),
            // `C:` + `\` and `\\?\C:` + `\` keep one volume prefix, while a Unix
            // root contributes the leading separator the join below supplies.
            Component::RootDir => match parts.last_mut() {
                Some(last) => last.push(std::path::MAIN_SEPARATOR.to_string()),
                None => parts.push(OsString::new()),
            },
            Component::ParentDir => parts.push(text.to_os_string()),
            // A `.` never names an entry, so it contributes neither text nor a
            // directory level.
            Component::CurDir => continue,
            Component::Normal(_) => {
                let spelled = text.to_string_lossy();
                let folded = folded_name(&spelled);
                let rendered = if folded == spelled
                    || directory_case_sensitive_with(comparator, &container)
                {
                    text.to_os_string()
                } else {
                    OsString::from(folded)
                };
                parts.push(rendered);
            }
        }

        container.push(text);
    }

    let separator = std::path::MAIN_SEPARATOR.to_string();
    parts
        .iter()
        .map(|part| part.to_string_lossy().to_string())
        .collect::<Vec<String>>()
        .join(&separator)
}

/// Whether this *platform* compares paths case-insensitively.
///
/// This is no longer the whole rule — [`directory_case_sensitive`] reports the
/// rule of a concrete directory and is what every consumer must ask — but it
/// stays the fallback for the one kind of path component that has no containing
/// directory: a volume prefix (`C:`) or a UNC share, and the root itself.
/// Windows is the case-insensitive platform this application targets; every
/// other supported platform compares exactly.
pub(crate) const PATHS_ARE_CASE_INSENSITIVE: bool = cfg!(windows);

/* -------------------------------------------------------------------- */
/* Filesystem-object identity (006)                                      */
/* -------------------------------------------------------------------- */

/// Opaque identity of the filesystem object `path` names.
///
/// 006 needs to prove that the object at one path *is* the object that used to
/// be at another path, because a canonical path changes exactly when a rename or
/// move happens and therefore cannot answer that question at all. The token this
/// function returns:
///
/// - stays the same for one object across an in-filesystem rename/move;
/// - differs for a delete/recreate replacement at the same path on the platforms
///   that provide a reliable value;
/// - is `None` when the platform/filesystem cannot supply one, because inventing
///   continuity is worse than admitting it cannot be proven (FR-041, FR-042).
///
/// `follow_final_link` selects which of the two identity domains is reported:
/// `true` identifies the object the path resolves to (what a document binding
/// stores), `false` identifies the entry itself without following a final
/// link/reparse point (what an Explorer entry carries). 006 never substitutes
/// one domain for the other.
///
/// Obtaining the token reads metadata only: never file contents, and never a
/// descendant level of a directory. The token is opaque above this module — no
/// frontend code parses it, folds its case or uses it as a path-ownership key,
/// and this crate never re-derives a path from it.
pub(crate) fn object_identity(path: &Path, follow_final_link: bool) -> Option<String> {
    platform_object_identity(path, follow_final_link)
}

/// Windows: volume identity plus the file index the volume assigns the object.
///
/// The combination is what a rename preserves and what a delete/recreate
/// replacement cannot keep, so it is exactly the continuity evidence 006 needs.
/// The pair is read through a native handle because the safe `std` accessors for
/// it are not stable on this toolchain; the handle is opened for attribute
/// queries only and is closed before returning.
#[cfg(windows)]
fn platform_object_identity(path: &Path, follow_final_link: bool) -> Option<String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };

    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    // `FILE_FLAG_BACKUP_SEMANTICS` is what lets a directory be opened at all,
    // and `FILE_FLAG_OPEN_REPARSE_POINT` is what makes the answer describe a
    // link entry itself instead of the object it points at.
    let mut flags = FILE_FLAG_BACKUP_SEMANTICS;
    if !follow_final_link {
        flags |= FILE_FLAG_OPEN_REPARSE_POINT;
    }

    // SAFETY: `wide` is a NUL-terminated buffer that outlives the call, the
    // security attributes are absent and no argument is retained by the callee.
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            flags,
            std::ptr::null_mut(),
        )
    };

    if handle == INVALID_HANDLE_VALUE {
        return None;
    }

    // SAFETY: the handle was just opened above and `information` is a valid,
    // writable, properly aligned value for the duration of the call.
    let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    let read = unsafe { GetFileInformationByHandle(handle, &mut information) };
    // SAFETY: the handle is owned by this function and is not used afterwards.
    unsafe { CloseHandle(handle) };

    if read == 0 {
        return None;
    }

    let index = ((information.nFileIndexHigh as u64) << 32) | information.nFileIndexLow as u64;
    windows_object_token(Some(information.dwVolumeSerialNumber), Some(index))
}

/// Builds the Windows token, refusing to invent one from unusable parts.
#[cfg(windows)]
fn windows_object_token(volume: Option<u32>, index: Option<u64>) -> Option<String> {
    match (volume, index) {
        (Some(volume), Some(index)) if volume != 0 && index != 0 => {
            Some(format!("win:{volume:08x}:{index:016x}"))
        }
        _ => None,
    }
}

/// Other supported platforms: the device/inode pair the kernel assigns.
#[cfg(unix)]
fn platform_object_identity(path: &Path, follow_final_link: bool) -> Option<String> {
    use std::os::unix::fs::MetadataExt;

    let metadata = if follow_final_link {
        fs::metadata(path)
    } else {
        fs::symlink_metadata(path)
    }
    .ok()?;

    unix_object_token(metadata.dev(), metadata.ino())
}

/// Builds the device/inode token, refusing to invent one from unusable parts.
#[cfg(unix)]
fn unix_object_token(device: u64, inode: u64) -> Option<String> {
    if inode == 0 {
        return None;
    }

    Some(format!("unix:{device:x}:{inode:x}"))
}

/// A platform without a stable object identity reports that honestly.
#[cfg(not(any(windows, unix)))]
fn platform_object_identity(_path: &Path, _follow_final_link: bool) -> Option<String> {
    None
}

/// Modification time in milliseconds since the Unix epoch, when available.
fn modified_time_millis(metadata: &fs::Metadata) -> Option<i64> {
    let modified = metadata.modified().ok()?;
    let since_epoch = modified.duration_since(UNIX_EPOCH).ok()?;
    i64::try_from(since_epoch.as_millis()).ok()
}

/// The cheap disk revision of an already-read metadata value.
///
/// `resolve_path_identity` and `inspect_document_path` both report revisions;
/// sharing this one builder keeps their size/ millisecond conversion identical
/// instead of duplicating it per call site.
fn disk_revision_for(metadata: &fs::Metadata) -> DiskRevision {
    DiskRevision {
        size: metadata.len(),
        modified_time_millis: modified_time_millis(metadata),
    }
}

/* -------------------------------------------------------------------- */
/* Document path inspection (005)                                        */
/* -------------------------------------------------------------------- */

/// Validation-oriented state of a document's bound path.
///
/// External-change validation (005) has to tell three situations apart before
/// it reacts to a watcher event: the file is there, the file is definitely
/// gone, or the answer is simply not available right now. That last one is the
/// reason this enum is separate from [`ResolvedPathKind`], which cannot express
/// it: a document whose path is temporarily unreadable must keep its in-memory
/// content instead of being classified as missing (FR-015).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DocumentPathState {
    /// The bound path currently names an existing regular file.
    File,
    /// The bound path currently names an existing directory.
    Directory,
    /// The bound path is definitely absent: the target itself is gone, and no
    /// parent that could still contain it survives either.
    Missing,
    /// The bound path exists or its absence cannot be confirmed, but inspecting
    /// it failed (permission, lock, I/O error). Never reported as `Missing`.
    Unreadable,
}

/// Result of inspecting a bound document path for external-change validation.
///
/// Every field beyond `requested_path` is optional because the inspection may
/// legitimately end without an identity: a target whose whole directory tree is
/// gone has no candidate path, and an unreadable target has no confirmed one.
/// The caller keeps the document bound to `requested_path` in all cases.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentPathInspection {
    /// The path exactly as the caller spelled it.
    pub requested_path: String,
    /// Canonical path when one could be derived and confirmed.
    pub canonical_path: Option<String>,
    /// The comparison key of [`Self::canonical_path`], when there is one.
    pub comparison_key: Option<String>,
    /// What the bound path currently is.
    pub state: DocumentPathState,
    /// Metadata when the target exists and could be read.
    pub disk_revision: Option<DiskRevision>,
    /// Why the path could not be classified, when that is the outcome.
    pub message: Option<String>,
}

/// Request payload of the `inspect_document_path` command.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectDocumentPathRequest {
    /// The document's bound path to inspect.
    pub path: String,
}

/// Inspects a bound document path without reading its contents.
///
/// Unlike [`resolve_path_identity`] this never fails: a missing target and an
/// uninspectable one are both explicit states, because the caller must not turn
/// a transient read/lock failure into a deleted document.
pub fn inspect_document_path(path: &str) -> DocumentPathInspection {
    classify_document_path(&RealPathProbe, path)
}

/// Minimal filesystem probe the classifier goes through.
///
/// Production code always uses [`RealPathProbe`]. The seam exists so the
/// `Unreadable` branches can be pinned deterministically: a test cannot portably
/// create an existing-but-denied file on Windows, but it can inject the I/O
/// error this trait would have returned.
pub(crate) trait PathProbe {
    /// Metadata of `path` itself, without following a final symlink.
    ///
    /// This is the probe that distinguishes "absent" from "not allowed to
    /// look", which `Path::exists` cannot do because it swallows every error.
    fn symlink_metadata(&self, path: &Path) -> std::io::Result<fs::Metadata>;
    /// Metadata of the object `path` resolves to.
    fn metadata(&self, path: &Path) -> std::io::Result<fs::Metadata>;
    /// The absolute, normalized path `path` names.
    fn canonicalize(&self, path: &Path) -> std::io::Result<std::path::PathBuf>;
}

/// The real filesystem, used by [`inspect_document_path`].
pub(crate) struct RealPathProbe;

impl PathProbe for RealPathProbe {
    fn symlink_metadata(&self, path: &Path) -> std::io::Result<fs::Metadata> {
        fs::symlink_metadata(path)
    }

    fn metadata(&self, path: &Path) -> std::io::Result<fs::Metadata> {
        fs::metadata(path)
    }

    fn canonicalize(&self, path: &Path) -> std::io::Result<std::path::PathBuf> {
        fs::canonicalize(path)
    }
}

/// Classifies a bound document path through `probe`.
///
/// The classification rules, in the order the classifier applies them:
///
/// 1. `symlink_metadata` decides whether the target itself exists, because it
///    reports the probe's own error instead of hiding it.
/// 2. Exists, and resolves to a directory -> [`DocumentPathState::Directory`].
/// 3. Exists, and resolves to a file -> [`DocumentPathState::File`]. Both cases
///    carry the canonical path, comparison key and disk revision; a
///    canonicalize/metadata failure here is [`DocumentPathState::Unreadable`],
///    never `Missing`, because the object is there.
/// 4. `NotFound` -> the target is absent, and the parent decides how far that
///    can be confirmed (see [`classify_absent`]).
/// 5. Any other probe error (`PermissionDenied`, lock, I/O) ->
///    [`DocumentPathState::Unreadable`], never `Missing`.
///
/// A path with no final component (`C:\`, `""`) is classified by those same
/// rules and never panics.
pub(crate) fn classify_document_path(
    probe: &impl PathProbe,
    path: &str,
) -> DocumentPathInspection {
    let requested = Path::new(path);

    match probe.symlink_metadata(requested) {
        Ok(metadata) => classify_present(probe, path, requested, &metadata),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            classify_absent(probe, path, requested)
        }
        Err(error) => unreadable_inspection(path, error),
    }
}

/// Classifies a path whose own metadata the probe could read.
///
/// The probe result describes a link itself, so the object is followed through
/// `metadata` before the state is chosen: this keeps the answer consistent with
/// [`resolve_path_identity`], which also reports what a link points at.
fn classify_present(
    probe: &impl PathProbe,
    path: &str,
    requested: &Path,
    probe_metadata: &fs::Metadata,
) -> DocumentPathInspection {
    let canonical = match probe.canonicalize(requested) {
        Ok(canonical) => canonical,
        Err(error) => return unreadable_inspection(path, error),
    };
    let metadata = match probe.metadata(&canonical) {
        Ok(metadata) => metadata,
        Err(error) => return unreadable_inspection(path, error),
    };

    let state = if probe_metadata.is_dir() || metadata.is_dir() {
        DocumentPathState::Directory
    } else {
        DocumentPathState::File
    };

    DocumentPathInspection {
        requested_path: path.to_string(),
        canonical_path: Some(canonical.to_string_lossy().to_string()),
        comparison_key: Some(comparison_key(&canonical)),
        state,
        disk_revision: Some(disk_revision_for(&metadata)),
        message: None,
    }
}

/// Classifies a target the probe reported as [`std::io::ErrorKind::NotFound`].
///
/// Absence is confirmed through the parent, because a deleted file is still a
/// document with a destination:
///
/// - an existing parent yields the candidate identity `resolve_path_identity`
///   derives for a missing target (canonical parent joined with the requested
///   leaf), so the key matches the one the file will report once it appears;
///   a parent that is not a directory still yields that joined candidate,
///   because the probe confirmed it exists and the leaf simply cannot be
///   created there;
/// - a parent that is also `NotFound` means the whole tree is gone and no
///   candidate identity survives;
/// - a parent that failed for any other reason leaves absence unconfirmed, so
///   the answer is [`DocumentPathState::Unreadable`].
fn classify_absent(
    probe: &impl PathProbe,
    path: &str,
    requested: &Path,
) -> DocumentPathInspection {
    // A relative path with no directory component resolves against the current
    // directory, which is what the filesystem itself would do.
    let parent = match requested.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        _ => Path::new("."),
    };

    match probe.symlink_metadata(parent) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // The parent is gone as well, so the target is definitely absent and
            // there is no surviving object to derive a candidate identity from.
            return missing_inspection(path, None);
        }
        Err(error) => return unreadable_inspection(path, error),
    };

    // Without a final component there is nothing to join onto the parent, so no
    // candidate identity can be derived for this spelling.
    let leaf = match requested.file_name() {
        Some(leaf) => leaf,
        None => return missing_inspection(path, None),
    };

    // Only the canonical parent participates, so equivalent spellings of the
    // same directory produce one key. A failure here still cannot promote the
    // state to `Missing`: the target's absence is confirmed but its identity is
    // not, and the caller is told which of the two happened.
    let canonical_parent = match probe.canonicalize(parent) {
        Ok(canonical_parent) => canonical_parent,
        Err(error) => return unreadable_inspection(path, error),
    };

    missing_inspection(path, Some(canonical_parent.join(leaf)))
}

/// A [`DocumentPathState::Missing`] inspection for `candidate`, if one exists.
fn missing_inspection(
    path: &str,
    candidate: Option<std::path::PathBuf>,
) -> DocumentPathInspection {
    DocumentPathInspection {
        requested_path: path.to_string(),
        canonical_path: candidate
            .as_ref()
            .map(|candidate| candidate.to_string_lossy().to_string()),
        comparison_key: candidate.as_ref().map(|candidate| comparison_key(candidate)),
        state: DocumentPathState::Missing,
        disk_revision: None,
        message: None,
    }
}

/// An [`DocumentPathState::Unreadable`] inspection describing `error`.
///
/// No identity is reported alongside the state: the point of `Unreadable` is
/// that the path could not be confirmed to be anything, so the caller keeps
/// whatever binding it already had.
fn unreadable_inspection(path: &str, error: std::io::Error) -> DocumentPathInspection {
    DocumentPathInspection {
        requested_path: path.to_string(),
        canonical_path: None,
        comparison_key: None,
        state: DocumentPathState::Unreadable,
        disk_revision: None,
        message: Some(format!("Cannot inspect {path}: {error}")),
    }
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

    /// Builds an absolute path the same way on every platform, so the injected
    /// comparison tests below exercise the component walk everywhere.
    fn rooted(parts: &[&str]) -> PathBuf {
        let mut path = if cfg!(windows) {
            PathBuf::from("C:\\")
        } else {
            PathBuf::from("/")
        };
        for part in parts {
            path.push(part);
        }
        path
    }

    /// A comparator that models a filesystem whose directories can differ.
    ///
    /// A case-sensitive Windows directory cannot be created portably in a test
    /// (the flag needs a volume/driver that supports it and cannot be assumed
    /// here), so the per-directory contract is pinned against this model instead
    /// — including the directories it was actually asked about, which is what
    /// proves which directory governs which path component.
    struct ModelComparator {
        case_sensitive: Vec<PathBuf>,
        unreported: Vec<PathBuf>,
        queried: std::cell::RefCell<Vec<PathBuf>>,
    }

    impl ModelComparator {
        fn new(case_sensitive: &[PathBuf]) -> Self {
            Self {
                case_sensitive: case_sensitive.to_vec(),
                unreported: Vec::new(),
                queried: std::cell::RefCell::new(Vec::new()),
            }
        }

        fn unreported(directory: PathBuf) -> Self {
            Self {
                case_sensitive: Vec::new(),
                unreported: vec![directory],
                queried: std::cell::RefCell::new(Vec::new()),
            }
        }

        fn was_asked_about(&self, directory: &Path) -> bool {
            self.queried.borrow().iter().any(|asked| asked == directory)
        }
    }

    impl CaseComparator for ModelComparator {
        fn case_sensitivity(&self, directory: &Path) -> Option<bool> {
            self.queried.borrow_mut().push(directory.to_path_buf());

            if self.unreported.iter().any(|other| other == directory) {
                return None;
            }

            Some(
                self.case_sensitive
                    .iter()
                    .any(|other| other == directory),
            )
        }
    }

    /// T156: the platform rule is not the directory rule. A directory that is
    /// case-sensitive on its own (and contains no case-colliding pair to prove
    /// it) must keep two differently-cased names apart in the key.
    #[test]
    fn comparison_key_follows_the_rule_of_the_containing_directory() {
        let work = rooted(&["work"]);
        let sensitive = rooted(&["work", "real"]);
        let model = ModelComparator::new(&[sensitive.clone()]);

        // Inside the case-sensitive directory, case is part of the name.
        assert_ne!(
            comparison_key_with(&model, &rooted(&["work", "real", "Notes.txt"])),
            comparison_key_with(&model, &rooted(&["work", "real", "notes.txt"])),
            "a case-sensitive directory keeps two spellings apart"
        );

        // The directory that contains `real` is the parent, which is not
        // case-sensitive, so `REAL` and `real` still name that same directory.
        assert_eq!(
            comparison_key_with(&model, &rooted(&["work", "real", "a.ts"])),
            comparison_key_with(&model, &rooted(&["work", "REAL", "a.ts"])),
            "the rule of the containing directory is what decides, per component"
        );

        // Which directory governs which component: `real` is decided by `work`,
        // and `Notes.txt` by `real` itself.
        assert!(
            model.was_asked_about(&work),
            "the name `real` must be decided by its containing directory"
        );
        assert!(
            model.was_asked_about(&sensitive),
            "the name `Notes.txt` must be decided by the case-sensitive directory"
        );

        // And the same names inside a case-insensitive directory do fold.
        let insensitive = ModelComparator::new(&[]);
        assert_eq!(
            comparison_key_with(&insensitive, &rooted(&["work", "real", "Notes.txt"])),
            comparison_key_with(&insensitive, &rooted(&["work", "real", "notes.txt"])),
            "a case-insensitive directory folds its names"
        );
    }

    /// T156: an answer the platform cannot give is treated as case-sensitive, so
    /// no convenience may reuse a differently-cased spelling without evidence.
    #[test]
    fn an_unreported_directory_rule_is_treated_as_case_sensitive() {
        let directory = rooted(&["work"]);
        let model = ModelComparator::unreported(directory.clone());

        assert!(
            directory_case_sensitive_with(&model, &directory),
            "an unavailable answer is conservative"
        );
        assert_ne!(
            comparison_key_with(&model, &rooted(&["work", "Notes.txt"])),
            comparison_key_with(&model, &rooted(&["work", "notes.txt"])),
            "without a reported rule no two spellings may share one key"
        );
    }

    /// T156: containment walks components under the rule of each component's own
    /// containing directory rather than one platform-wide rule.
    #[test]
    fn relative_within_uses_the_rule_of_the_directory_containing_each_component() {
        let model = ModelComparator::new(&[rooted(&["work", "real"])]);

        // `Sub` and `sub` are two entries inside the case-sensitive directory.
        assert_eq!(
            relative_within_with(
                &model,
                &rooted(&["work", "real", "Sub"]),
                &rooted(&["work", "real", "sub", "a.ts"]),
            ),
            None,
            "a case-distinct component inside a case-sensitive directory is not containment"
        );

        // The case-sensitive directory's *own* name is still decided by its
        // parent, so a case-flipped spelling of it names the same directory.
        assert_eq!(
            relative_within_with(
                &model,
                &rooted(&["work", "real"]),
                &rooted(&["work", "REAL", "a.ts"]),
            ),
            Some("a.ts".to_string()),
            "the parent's rule governs the case-sensitive directory's own name"
        );

        // A case-insensitive directory keeps folding, so nothing regressed there.
        assert_eq!(
            relative_within_with(
                &model,
                &rooted(&["work", "other"]),
                &rooted(&["work", "OTHER", "a.ts"]),
            ),
            Some("a.ts".to_string())
        );
    }

    /// T156: the filesystem's real answer is what the application uses. The
    /// directory's own behaviour is the oracle: two names that differ only by
    /// case can coexist only in a case-sensitive directory.
    #[test]
    fn the_directory_rule_matches_what_the_filesystem_actually_does() {
        let dir = work_dir("case-rule");
        let observed = case_distinct_names_can_coexist(&dir);

        assert_eq!(
            directory_case_sensitive(&dir),
            observed,
            "the reported rule must match what this directory really does"
        );

        // Where the platform answers at all, it must answer the same thing: this
        // is the native call the whole contract is built on.
        if let Some(reported) = PlatformCaseComparator.case_sensitivity(&dir) {
            assert_eq!(reported, observed, "the platform's own answer agrees");
        }

        // A path that cannot be asked at all answers `None`, and the conservative
        // answer is what every caller then sees.
        let absent = dir.join("absent");
        assert_eq!(PlatformCaseComparator.case_sensitivity(&absent), None);
        assert!(directory_case_sensitive(&absent));

        let _ = fs::remove_dir_all(&dir);
    }

    /// Whether two names that differ only by case can both be created in
    /// `directory`, asked of the filesystem itself.
    fn case_distinct_names_can_coexist(directory: &Path) -> bool {
        let lower = directory.join("case-probe.txt");
        let upper = directory.join("CASE-PROBE.TXT");

        let created = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&lower)
            .is_ok()
            && fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&upper)
                .is_ok();

        let _ = fs::remove_file(&lower);
        let _ = fs::remove_file(&upper);
        created
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

        assert_eq!(value.as_object().expect("object").len(), 6);
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
        assert!(
            value["objectIdentity"].is_string(),
            "an existing object carries its opaque 006 identity"
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
        assert!(value.get("object_identity").is_none());

        let _ = fs::remove_dir_all(&dir);
    }

    /// FR-042: a destination that does not exist yet has no object identity, and
    /// the wire field is nullable rather than absent.
    #[test]
    fn missing_identity_serializes_a_null_object_identity() {
        let dir = work_dir("wire-shape-missing");
        let target = dir.join("brand-new.txt");

        let value =
            serde_json::to_value(resolve_path_identity(&display(&target), true).expect("resolve"))
                .expect("serialize");

        assert_eq!(value.as_object().expect("object").len(), 6);
        assert_eq!(value["kind"], json!("missing"));
        assert_eq!(value["objectIdentity"], json!(null));

        let _ = fs::remove_dir_all(&dir);
    }

    /* ---------------------------------------------------------------- */
    /* Filesystem-object identity (006)                                  */
    /* ---------------------------------------------------------------- */

    /// The identity of an object must survive a rename inside one filesystem,
    /// which is the entire reason 006 needs a token that is not a path.
    #[test]
    fn object_identity_is_stable_across_a_rename() {
        let dir = work_dir("object-rename");
        let before = write_file(&dir, "before.txt", b"content");

        let original = resolve_path_identity(&display(&before), false)
            .expect("resolve the original path")
            .object_identity;

        let after = dir.join("after.txt");
        fs::rename(&before, &after).expect("rename the fixture");

        let renamed = resolve_path_identity(&display(&after), false)
            .expect("resolve the renamed path")
            .object_identity;

        match (&original, &renamed) {
            (Some(original), Some(renamed)) => assert_eq!(
                original, renamed,
                "one object must keep one identity across a rename"
            ),
            (None, None) => {
                // A filesystem without usable identity must degrade to `None`
                // rather than to a token, and the comparison key must still have
                // followed the rename.
                assert_ne!(
                    resolve_path_identity(&display(&before), true)
                        .expect("resolve the old spelling")
                        .comparison_key,
                    resolve_path_identity(&display(&after), false)
                        .expect("resolve the new spelling")
                        .comparison_key,
                    "without an object token the path identity still changes"
                );
            }
            other => panic!("one side of the rename reported an identity and the other did not: {other:?}"),
        }

        let _ = fs::remove_dir_all(&dir);
    }

    /// A delete/recreate replacement at the same path must not inherit the old
    /// token: path equality is not object continuity (FR-034).
    #[test]
    fn object_identity_distinguishes_a_recreated_replacement() {
        let dir = work_dir("object-recreate");
        let target = write_file(&dir, "notes.txt", b"first");

        let before = resolve_path_identity(&display(&target), false)
            .expect("resolve the original")
            .object_identity;

        fs::remove_file(&target).expect("delete the fixture");
        write_file(&dir, "notes.txt", b"second");

        let after = resolve_path_identity(&display(&target), false)
            .expect("resolve the replacement")
            .object_identity;

        if let (Some(before), Some(after)) = (&before, &after) {
            assert_ne!(
                before, after,
                "a recreated file is a different filesystem object"
            );
        }

        let _ = fs::remove_dir_all(&dir);
    }

    /// Unusable platform parts must produce `None` rather than a token that
    /// would compare equal to every other unavailable object.
    #[test]
    #[cfg(windows)]
    fn unusable_windows_parts_produce_no_object_token() {
        assert_eq!(windows_object_token(None, None), None);
        assert_eq!(windows_object_token(Some(0), Some(42)), None);
        assert_eq!(windows_object_token(Some(7), None), None);
        assert_eq!(windows_object_token(Some(7), Some(0)), None);
        assert!(
            windows_object_token(Some(7), Some(42)).is_some(),
            "a complete volume/index pair is a usable token"
        );
    }

    /// The same rule for the device/inode spelling.
    #[test]
    #[cfg(unix)]
    fn unusable_unix_parts_produce_no_object_token() {
        assert_eq!(unix_object_token(3, 0), None);
        assert!(unix_object_token(3, 9).is_some());
    }

    /// Directories and files both carry an identity, and a directory keeps it
    /// across a rename just like a file does.
    #[test]
    fn object_identity_covers_directories() {
        let dir = work_dir("object-directory");
        let before = dir.join("before");
        fs::create_dir(&before).expect("create the fixture directory");

        let original = resolve_path_identity(&display(&before), false)
            .expect("resolve the directory")
            .object_identity;

        let after = dir.join("after");
        fs::rename(&before, &after).expect("rename the fixture directory");

        let renamed = resolve_path_identity(&display(&after), false)
            .expect("resolve the renamed directory")
            .object_identity;

        if let (Some(original), Some(renamed)) = (&original, &renamed) {
            assert_eq!(original, renamed);
        }

        let _ = fs::remove_dir_all(&dir);
    }

    /* ---------------------------------------------------------------- */
    /* Workspace relation (003)                                          */
    /* ---------------------------------------------------------------- */

    /// The JSON the frontend's `ResolveWorkspaceRelationResult` DTO reads.
    #[test]
    fn workspace_relation_serializes_the_tagged_wire_shape() {
        let inside = serde_json::to_value(WorkspaceRelation::Inside {
            relative_path: "src\\a.ts".to_string(),
        })
        .expect("serialize inside");

        assert_eq!(inside.as_object().expect("object").len(), 2);
        assert_eq!(inside["type"], json!("inside"));
        assert_eq!(inside["relativePath"], json!("src\\a.ts"));
        assert!(inside.get("relative_path").is_none());

        let outside = serde_json::to_value(WorkspaceRelation::Outside).expect("serialize outside");
        assert_eq!(outside.as_object().expect("object").len(), 1);
        assert_eq!(outside["type"], json!("outside"));
    }

    #[test]
    fn relation_reports_inside_with_a_relative_path() {
        let root = work_dir("relation-inside");
        fs::create_dir_all(root.join("src").join("nested")).expect("create nested dirs");
        let target = root.join("src").join("nested").join("a.ts");
        fs::write(&target, b"x").expect("write fixture");

        let relation =
            resolve_workspace_relation(&display(&root), &display(&target)).expect("derive relation");

        assert_eq!(
            relation,
            WorkspaceRelation::Inside {
                relative_path: std::path::PathBuf::from("src")
                    .join("nested")
                    .join("a.ts")
                    .to_string_lossy()
                    .to_string(),
            }
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn relation_reports_the_root_itself_as_inside() {
        let root = work_dir("relation-root");

        let relation =
            resolve_workspace_relation(&display(&root), &display(&root)).expect("derive relation");

        assert_eq!(
            relation,
            WorkspaceRelation::Inside {
                relative_path: String::new(),
            }
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn relation_rejects_a_sibling_with_a_shared_name_prefix() {
        let parent = work_dir("relation-sibling");
        let root = parent.join("project");
        let sibling = parent.join("project-old");
        fs::create_dir_all(&root).expect("create root");
        fs::create_dir_all(&sibling).expect("create sibling");
        let target = sibling.join("a.ts");
        fs::write(&target, b"x").expect("write fixture");

        // Naive string prefix comparison would wrongly accept this target.
        assert!(display(&target).starts_with(&display(&root)));

        let relation =
            resolve_workspace_relation(&display(&root), &display(&target)).expect("derive relation");

        assert_eq!(relation, WorkspaceRelation::Outside);

        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn relation_reports_a_disjoint_path_as_outside() {
        let root = work_dir("relation-outside");
        let other = work_dir("relation-elsewhere");
        let target = other.join("a.ts");
        fs::write(&target, b"x").expect("write fixture");

        let relation =
            resolve_workspace_relation(&display(&root), &display(&target)).expect("derive relation");

        assert_eq!(relation, WorkspaceRelation::Outside);

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&other);
    }

    #[test]
    fn relation_resolves_equivalent_spellings_and_parent_detours() {
        let root = work_dir("relation-spellings");
        fs::create_dir_all(root.join("src")).expect("create src");
        let target = root.join("src").join("a.ts");
        fs::write(&target, b"x").expect("write fixture");

        let detour = root.join("src").join("..").join("src").join("a.ts");
        let dotted = root.join(".").join("src").join("a.ts");

        for spelling in [detour, dotted] {
            let relation = resolve_workspace_relation(&display(&root), &display(&spelling))
                .expect("derive relation");
            assert_eq!(
                relation,
                WorkspaceRelation::Inside {
                    relative_path: std::path::PathBuf::from("src")
                        .join("a.ts")
                        .to_string_lossy()
                        .to_string(),
                },
                "equivalent spelling {} must stay inside",
                display(&spelling)
            );
        }

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    #[cfg(windows)]
    fn relation_follows_windows_case_rules() {
        let root = work_dir("relation-case");
        fs::create_dir_all(root.join("SRC")).expect("create SRC");
        let target = root.join("SRC").join("A.TS");
        fs::write(&target, b"x").expect("write fixture");

        let flipped = root.join("src").join("a.ts");
        let relation =
            resolve_workspace_relation(&display(&root), &display(&flipped)).expect("derive relation");

        assert_eq!(
            relation,
            WorkspaceRelation::Inside {
                relative_path: std::path::PathBuf::from("SRC")
                    .join("A.TS")
                    .to_string_lossy()
                    .to_string(),
            },
            "canonicalization must report the on-disk spelling"
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn relation_errors_when_the_root_is_missing_or_not_a_directory() {
        let dir = work_dir("relation-root-errors");
        let file = write_file(&dir, "notes.txt", b"x");
        let missing = dir.join("absent");

        let missing_error = resolve_workspace_relation(&display(&missing), &display(&file))
            .expect_err("a missing root cannot resolve");
        assert_eq!(missing_error.code, CODE_PATH_RESOLUTION);

        let file_error = resolve_workspace_relation(&display(&file), &display(&file))
            .expect_err("a file root is not a Workspace");
        assert_eq!(file_error.code, CODE_PATH_RESOLUTION);
        assert!(!file_error.message.is_empty());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn relation_errors_when_the_target_is_missing() {
        let root = work_dir("relation-target-errors");
        let missing = root.join("absent.ts");

        let error = resolve_workspace_relation(&display(&root), &display(&missing))
            .expect_err("a missing target cannot resolve");
        assert_eq!(error.code, CODE_PATH_RESOLUTION);

        let _ = fs::remove_dir_all(&root);
    }

    /// A directory link is followed, so the relation describes the canonical
    /// target rather than the link's own location.
    #[test]
    fn relation_follows_a_directory_link_to_its_target() {
        let root = work_dir("relation-link-root");
        let outside = work_dir("relation-link-target");
        let link = root.join("linked");

        if !crate::test_support::create_directory_link(&outside, &link) {
            return;
        }

        let target = outside.join("a.ts");
        fs::write(&target, b"x").expect("write fixture");

        let relation =
            resolve_workspace_relation(&display(&root), &display(&link.join("a.ts")))
                .expect("derive relation");

        assert_eq!(
            relation,
            WorkspaceRelation::Outside,
            "a link out of the root must resolve outside it"
        );

        let inside_relation = resolve_workspace_relation(&display(&outside), &display(&link.join("a.ts")))
            .expect("derive relation through the target root");
        assert_eq!(
            inside_relation,
            WorkspaceRelation::Inside {
                relative_path: "a.ts".to_string(),
            }
        );

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
    }

    /* ---------------------------------------------------------------- */
    /* Document path inspection (005)                                    */
    /* ---------------------------------------------------------------- */

    /// The I/O failure the probes below inject.
    fn permission_denied() -> std::io::Error {
        std::io::Error::new(std::io::ErrorKind::PermissionDenied, "access is denied")
    }

    /// Probe that denies the very first look at the target.
    ///
    /// Windows cannot portably create an existing-but-denied file inside a test,
    /// so this pins the "probe failed for a reason other than NotFound" rule
    /// (which must never be `Missing`) deterministically.
    struct DeniedProbe;

    impl PathProbe for DeniedProbe {
        fn symlink_metadata(&self, _path: &Path) -> std::io::Result<fs::Metadata> {
            Err(permission_denied())
        }

        fn metadata(&self, _path: &Path) -> std::io::Result<fs::Metadata> {
            Err(permission_denied())
        }

        fn canonicalize(&self, _path: &Path) -> std::io::Result<std::path::PathBuf> {
            Err(permission_denied())
        }
    }

    /// Probe whose first look succeeds through the real filesystem while every
    /// follow-up inspection is denied, which pins the "the object exists but
    /// cannot be read" rule.
    struct MetadataDeniedProbe;

    impl PathProbe for MetadataDeniedProbe {
        fn symlink_metadata(&self, path: &Path) -> std::io::Result<fs::Metadata> {
            fs::symlink_metadata(path)
        }

        fn metadata(&self, _path: &Path) -> std::io::Result<fs::Metadata> {
            Err(permission_denied())
        }

        fn canonicalize(&self, _path: &Path) -> std::io::Result<std::path::PathBuf> {
            Err(permission_denied())
        }
    }

    /// Probe that reports the target as absent but denies its parent, which
    /// pins the "absence cannot be confirmed" rule.
    struct ParentDeniedProbe;

    impl PathProbe for ParentDeniedProbe {
        fn symlink_metadata(&self, path: &Path) -> std::io::Result<fs::Metadata> {
            if path
                .file_name()
                .is_some_and(|name| name.to_string_lossy() == "notes.txt")
            {
                Err(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "the target is gone",
                ))
            } else {
                Err(permission_denied())
            }
        }

        fn metadata(&self, _path: &Path) -> std::io::Result<fs::Metadata> {
            Err(permission_denied())
        }

        fn canonicalize(&self, _path: &Path) -> std::io::Result<std::path::PathBuf> {
            Err(permission_denied())
        }
    }

    #[test]
    fn inspection_reports_an_unchanged_existing_file() {
        let dir = work_dir("inspect-existing");
        let path = write_file(&dir, "notes.txt", b"alpha\nbeta");

        let inspection = inspect_document_path(&display(&path));

        assert_eq!(inspection.state, DocumentPathState::File);
        assert_eq!(inspection.requested_path, display(&path));
        assert!(
            inspection.canonical_path.is_some(),
            "an existing file carries its canonical path"
        );
        assert!(
            inspection.comparison_key.is_some(),
            "an existing file carries its comparison key"
        );
        assert_eq!(
            inspection.disk_revision.expect("a file carries a revision").size,
            10,
            "byte length of alpha\\nbeta"
        );
        assert!(
            inspection.message.is_none(),
            "a classified path needs no message"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn inspection_reports_a_changed_disk_revision() {
        let dir = work_dir("inspect-changed");
        let path = write_file(&dir, "notes.txt", b"alpha\nbeta");

        let before = inspect_document_path(&display(&path));
        fs::write(&path, b"alpha\nbeta\ngamma").expect("rewrite fixture");
        let after = inspect_document_path(&display(&path));

        assert_eq!(after.state, DocumentPathState::File);
        assert_ne!(
            before.disk_revision, after.disk_revision,
            "different bytes must produce a different revision"
        );
        assert_eq!(
            after.disk_revision.expect("revision").size,
            16,
            "byte length of alpha\\nbeta\\ngamma"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn inspection_of_a_missing_target_matches_the_key_the_file_reports() {
        let dir = work_dir("inspect-missing-target");
        let target = dir.join("notes.txt");

        assert!(!target.exists(), "fixture must not exist yet");

        let missing = inspect_document_path(&display(&target));
        assert_eq!(missing.state, DocumentPathState::Missing);
        assert_eq!(
            missing.disk_revision, None,
            "a missing target has no disk revision"
        );
        assert!(missing.message.is_none());
        assert!(
            missing.canonical_path.is_some(),
            "an existing parent still yields a candidate path"
        );

        let candidate_key = missing
            .comparison_key
            .clone()
            .expect("an existing parent yields a candidate comparison key");

        fs::write(&target, b"x").expect("create the file");
        let present = inspect_document_path(&display(&target));

        assert_eq!(present.state, DocumentPathState::File);
        assert_eq!(
            present.comparison_key.as_deref(),
            Some(candidate_key.as_str()),
            "the candidate key must be the key the created file reports"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn inspection_of_a_missing_parent_reports_no_candidate_identity() {
        let dir = work_dir("inspect-missing-parent");
        let target = dir.join("no-such-dir").join("notes.txt");

        let inspection = inspect_document_path(&display(&target));

        assert_eq!(
            inspection.state,
            DocumentPathState::Missing,
            "a deleted directory means the target is definitely absent"
        );
        assert_eq!(inspection.canonical_path, None);
        assert_eq!(inspection.comparison_key, None);
        assert_eq!(inspection.disk_revision, None);
        assert!(inspection.message.is_none());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn inspection_of_a_recreated_target_keeps_the_same_identity() {
        let dir = work_dir("inspect-recreated");
        let target = dir.join("notes.txt");

        let before = inspect_document_path(&display(&target));
        assert_eq!(before.state, DocumentPathState::Missing);

        fs::write(&target, b"one").expect("create the file");
        let created = inspect_document_path(&display(&target));
        assert_eq!(created.state, DocumentPathState::File);
        assert_eq!(
            created.comparison_key, before.comparison_key,
            "recreating the file must not change the document's identity"
        );
        assert_eq!(created.canonical_path, before.canonical_path);

        // An external delete returns the document to the same candidate
        // identity, so a later recreation stays the same document.
        fs::remove_file(&target).expect("remove the file");
        let deleted = inspect_document_path(&display(&target));
        assert_eq!(deleted.state, DocumentPathState::Missing);
        assert_eq!(deleted.comparison_key, before.comparison_key);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn inspection_reports_an_existing_but_unreadable_target() {
        let dir = work_dir("inspect-unreadable");
        let path = write_file(&dir, "notes.txt", b"alpha");

        // The target really exists; the probe denies looking at it at all.
        let denied = classify_document_path(&DeniedProbe, &display(&path));
        assert_eq!(denied.state, DocumentPathState::Unreadable);
        assert_ne!(
            denied.state,
            DocumentPathState::Missing,
            "a read failure must never be reported as a missing document"
        );
        assert!(
            denied.message.as_deref().is_some_and(|m| !m.is_empty()),
            "an unreadable path explains itself"
        );

        // The target exists and its own metadata was readable, but following it
        // failed: still unreadable, still not missing.
        let followed = classify_document_path(&MetadataDeniedProbe, &display(&path));
        assert_eq!(followed.state, DocumentPathState::Unreadable);
        assert_ne!(followed.state, DocumentPathState::Missing);
        assert!(
            followed.message.as_deref().is_some_and(|m| !m.is_empty()),
            "an unreadable path explains itself"
        );

        // Absence reported by the target probe is worthless when the parent
        // cannot be inspected, because the target may simply have moved.
        let unconfirmed = classify_document_path(&ParentDeniedProbe, "C:\\locked\\notes.txt");
        assert_eq!(unconfirmed.state, DocumentPathState::Unreadable);
        assert_ne!(unconfirmed.state, DocumentPathState::Missing);
        assert!(unconfirmed.message.is_some());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn inspection_reports_a_directory_path() {
        let dir = work_dir("inspect-directory");
        let nested = dir.join("nested");
        fs::create_dir_all(&nested).expect("create nested dir");

        let inspection = inspect_document_path(&display(&nested));

        assert_eq!(inspection.state, DocumentPathState::Directory);
        assert!(inspection.canonical_path.is_some());
        assert!(inspection.comparison_key.is_some());
        assert!(
            inspection.disk_revision.is_some(),
            "an existing directory still reports disk metadata"
        );
        assert!(inspection.message.is_none());

        let _ = fs::remove_dir_all(&dir);
    }

    /// The whole point of the state enum: three outcomes, three wire spellings.
    #[test]
    fn inspection_serializes_the_camel_case_wire_shape() {
        let dir = work_dir("inspect-wire-shape");
        let path = write_file(&dir, "notes.txt", b"abc");

        let value = serde_json::to_value(inspect_document_path(&display(&path)))
            .expect("serialize a present file");
        assert_eq!(
            value.as_object().expect("object").len(),
            6,
            "DocumentPathInspection must carry exactly six fields"
        );
        assert_eq!(value["state"], json!("file"));
        assert_eq!(value["requestedPath"], json!(display(&path)));
        assert_eq!(value["diskRevision"]["size"], json!(3));
        assert_eq!(value["message"], json!(null));
        assert!(value.get("requested_path").is_none());
        assert!(value.get("comparison_key").is_none());

        let unreadable = serde_json::to_value(classify_document_path(
            &DeniedProbe,
            &display(&path),
        ))
        .expect("serialize an unreadable path");
        assert_eq!(unreadable["state"], json!("unreadable"));
        assert_eq!(unreadable["canonicalPath"], json!(null));
        assert_eq!(unreadable["comparisonKey"], json!(null));
        assert!(
            unreadable["message"].as_str().is_some_and(|m| !m.is_empty()),
            "an unreadable path carries a non-empty message"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// A path with no final component is classified like any other, never
    /// panicking on the missing `file_name()`.
    #[test]
    fn inspection_classifies_a_path_without_a_final_component() {
        let empty = inspect_document_path("");

        assert_eq!(empty.requested_path, "");
        assert!(
            matches!(
                empty.state,
                DocumentPathState::Missing | DocumentPathState::Unreadable
            ),
            "an empty path names no object, got {:?}",
            empty.state
        );
        assert_eq!(
            empty.comparison_key, None,
            "there is no leaf to derive a candidate identity from"
        );
    }

    /// A volume root (`D:\`) is a valid spelling with no final component, and
    /// the probes must describe it instead of panicking on the absent leaf.
    #[test]
    fn inspection_classifies_a_volume_root() {
        let dir = work_dir("inspect-root");
        let root = dir
            .ancestors()
            .last()
            .expect("a temporary directory always has a root")
            .to_path_buf();
        assert!(
            root.file_name().is_none(),
            "the fixture must be the root itself, got {}",
            display(&root)
        );

        let inspection = inspect_document_path(&display(&root));

        assert_eq!(inspection.state, DocumentPathState::Directory);
        assert!(inspection.canonical_path.is_some());
        assert!(inspection.comparison_key.is_some());
        assert!(inspection.message.is_none());

        let _ = fs::remove_dir_all(&dir);
    }
}
