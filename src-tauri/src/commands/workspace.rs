//! Tauri Workspace filesystem commands.
//!
//! These commands are the structural counterpart of the text commands in
//! [`crate::commands::file`]: they list a directory level, create an entry,
//! rename an entry, move an entry to the OS recycle bin, and derive a
//! document-to-Workspace relation. They contain no filesystem logic of their
//! own — every primitive lives in [`crate::workspace_fs`] and
//! [`crate::file_identity`], so the IPC layer can stay a thin adapter.
//!
//! Failures keep the same `code + message` shape as the 002 commands.

use crate::file_codec::FileCommandError;
use crate::file_identity::{self, ResolveWorkspaceRelationRequest, WorkspaceRelation};
use crate::workspace_fs::{
    self, CreateEntryRequest, CreatedEntry, ReadDirectoryRequest, RenameEntryRequest, RenamedEntry,
    TrashEntryRequest, WorkspaceDirectoryResult,
};

/// Lists one directory level of the active Workspace.
#[tauri::command]
pub fn read_workspace_directory(
    request: ReadDirectoryRequest,
) -> Result<WorkspaceDirectoryResult, FileCommandError> {
    workspace_fs::read_directory(&request.path)
}

/// Creates one empty file or one directory without overwriting anything.
#[tauri::command]
pub fn create_workspace_entry(
    request: CreateEntryRequest,
) -> Result<CreatedEntry, FileCommandError> {
    workspace_fs::create_entry(&request)
}

/// Renames one entry inside its current parent directory.
#[tauri::command]
pub fn rename_workspace_entry(
    request: RenameEntryRequest,
) -> Result<RenamedEntry, FileCommandError> {
    workspace_fs::rename_entry(&request)
}

/// Moves one entry to the operating system's recycle/trash facility.
///
/// There is no permanent-delete fallback: FR-066 and FR-067 require Delete to
/// stay recoverable.
#[tauri::command]
pub fn trash_workspace_entry(request: TrashEntryRequest) -> Result<(), FileCommandError> {
    workspace_fs::trash_entry(&request.path)
}

/// Derives whether `targetPath` is inside the `rootPath` Workspace.
#[tauri::command]
pub fn resolve_workspace_relation(
    request: ResolveWorkspaceRelationRequest,
) -> Result<WorkspaceRelation, FileCommandError> {
    file_identity::resolve_workspace_relation(&request.root_path, &request.target_path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::fs;
    use std::path::{Path, PathBuf};

    fn work_dir(name: &str) -> PathBuf {
        let mut dir = std::env::temp_dir();
        dir.push(format!("sorakada-workspace-cmd-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn display(path: &Path) -> String {
        path.to_string_lossy().to_string()
    }

    fn to_json<T: serde::Serialize>(value: &T) -> Value {
        serde_json::to_value(value).expect("serialize to json")
    }

    /// Pins the camelCase request the frontend sends and the JSON it reads back.
    #[test]
    fn read_workspace_directory_matches_the_ipc_contract_shape() {
        let dir = work_dir("read-shape");
        fs::create_dir_all(dir.join("src")).expect("create src");
        fs::write(dir.join("a.txt"), b"x").expect("write fixture");

        let request: ReadDirectoryRequest = serde_json::from_value(json!({
            "path": display(&dir),
        }))
        .expect("deserialize the frontend request shape");

        let value = to_json(&read_workspace_directory(request).expect("read should succeed"));

        assert_eq!(value.as_object().expect("object").len(), 5);
        assert_eq!(value["requestedPath"], json!(display(&dir)));
        assert!(value["canonicalPath"].is_string());
        assert!(value["comparisonKey"].is_string());
        assert!(value["caseSensitive"].is_boolean());

        let entries = value["entries"].as_array().expect("entry array");
        assert_eq!(entries.len(), 2, "direct children only");
        assert_eq!(entries[0]["kind"], json!("directory"));
        assert!(entries[0].get("is_symlink").is_none(), "camelCase only");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_workspace_directory_reports_the_io_directory_error() {
        let dir = work_dir("read-error");

        let error = to_json(
            &read_workspace_directory(ReadDirectoryRequest {
                path: display(&dir.join("absent")),
            })
            .expect_err("a missing directory must fail"),
        );

        assert_eq!(error["code"], json!("io_directory"));
        assert_eq!(error.as_object().expect("object").len(), 2);
        assert!(
            error["message"]
                .as_str()
                .is_some_and(|message| !message.is_empty())
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn create_workspace_entry_accepts_the_camel_case_request() {
        let dir = work_dir("create-shape");

        let request: CreateEntryRequest = serde_json::from_value(json!({
            "parentPath": display(&dir),
            "name": "new.txt",
            "kind": "file",
        }))
        .expect("deserialize the frontend request shape");

        let value = to_json(&create_workspace_entry(request).expect("create should succeed"));

        assert_eq!(value.as_object().expect("object").len(), 2);
        assert_eq!(value["path"], json!(display(&dir.join("new.txt"))));
        assert_eq!(value["identity"]["kind"], json!("file"));

        let snake_case = serde_json::from_value::<CreateEntryRequest>(json!({
            "parent_path": display(&dir),
            "name": "new.txt",
            "kind": "file",
        }));
        assert!(snake_case.is_err(), "CreateWorkspaceEntryRequest is camelCase only");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn create_workspace_entry_reports_the_io_create_error() {
        let dir = work_dir("create-error");
        fs::write(dir.join("taken.txt"), b"x").expect("write fixture");

        let error = to_json(
            &create_workspace_entry(CreateEntryRequest {
                parent_path: display(&dir),
                name: "taken.txt".to_string(),
                kind: crate::workspace_fs::CreateEntryKind::File,
            })
            .expect_err("an existing target must fail"),
        );

        assert_eq!(error["code"], json!("io_create"));
        assert_eq!(error.as_object().expect("object").len(), 2);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_workspace_entry_matches_the_ipc_contract_shape() {
        let dir = work_dir("rename-shape");
        fs::write(dir.join("before.txt"), b"x").expect("write fixture");

        let request: RenameEntryRequest = serde_json::from_value(json!({
            "sourcePath": display(&dir.join("before.txt")),
            "newName": "after.txt",
        }))
        .expect("deserialize the frontend request shape");

        let value = to_json(&rename_workspace_entry(request).expect("rename should succeed"));

        assert_eq!(value.as_object().expect("object").len(), 3);
        assert!(value["oldCanonicalPath"].is_string());
        assert_eq!(value["newPath"], json!(display(&dir.join("after.txt"))));
        assert!(value["newIdentity"]["comparisonKey"].is_string());
        assert!(value.get("new_identity").is_none());

        let error = to_json(
            &rename_workspace_entry(RenameEntryRequest {
                source_path: display(&dir.join("absent.txt")),
                new_name: "other.txt".to_string(),
            })
            .expect_err("a missing source must fail"),
        );
        assert_eq!(error["code"], json!("io_rename"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn trash_workspace_entry_reports_the_io_trash_error() {
        let dir = work_dir("trash-shape");

        let request: TrashEntryRequest = serde_json::from_value(json!({
            "path": display(&dir.join("absent.txt")),
        }))
        .expect("deserialize the frontend request shape");

        let error = to_json(&trash_workspace_entry(request).expect_err("a missing path must fail"));

        assert_eq!(error["code"], json!("io_trash"));
        assert_eq!(error.as_object().expect("object").len(), 2);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_workspace_relation_accepts_the_camel_case_request() {
        let root = work_dir("relation-shape");
        let outside = work_dir("relation-shape-outside");
        fs::create_dir_all(root.join("src")).expect("create src");
        fs::write(root.join("src").join("a.ts"), b"x").expect("write fixture");
        fs::write(outside.join("b.ts"), b"x").expect("write fixture");

        let request: ResolveWorkspaceRelationRequest = serde_json::from_value(json!({
            "rootPath": display(&root),
            "targetPath": display(&root.join("src").join("a.ts")),
        }))
        .expect("deserialize the frontend request shape");

        let value = to_json(&resolve_workspace_relation(request).expect("derive inside"));

        assert_eq!(value["type"], json!("inside"));
        assert_eq!(
            value["relativePath"],
            json!(PathBuf::from("src").join("a.ts").to_string_lossy().to_string())
        );

        let outside_value = to_json(
            &resolve_workspace_relation(ResolveWorkspaceRelationRequest {
                root_path: display(&root),
                target_path: display(&outside.join("b.ts")),
            })
            .expect("derive outside"),
        );

        assert_eq!(outside_value, json!({ "type": "outside" }));

        let snake_case = serde_json::from_value::<ResolveWorkspaceRelationRequest>(json!({
            "root_path": display(&root),
            "target_path": display(&root.join("src").join("a.ts")),
        }));
        assert!(
            snake_case.is_err(),
            "ResolveWorkspaceRelationRequest is camelCase only"
        );

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
    }
}
