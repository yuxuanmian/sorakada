# Contract: Workspace Filesystem IPC

The exact Rust type names may differ, but the frontend/Rust wire shape and semantics below are part of the 003 plan.

## Error shape

All new Workspace commands reject with the same stable shape used by existing file commands:

```ts
interface FileCommandError {
  code: string;
  message: string;
}
```

Add stable codes as needed for structural operations (for example `io_directory`, `io_create`, `io_rename`, `io_trash`) without replacing existing 002 codes.

## `read_workspace_directory`

### Request

```ts
interface ReadWorkspaceDirectoryRequest {
  path: string;
}
```

### Response

```ts
interface ReadWorkspaceDirectoryResult {
  requestedPath: string;
  canonicalPath: string;
  comparisonKey: string;
  entries: readonly WorkspaceDirectoryEntry[];
}

interface WorkspaceDirectoryEntry {
  name: string;
  path: string;
  kind: "file" | "directory" | "other";
  isSymlink: boolean;
}
```

### Guarantees

- Reads direct children only.
- Does not recurse into child directories.
- `canonicalPath` identifies the directory target actually read and is used for ancestor-cycle checks.
- Entry ordering may be produced by Rust or normalized by the Explorer model, but final UI order is directories first then files/other by case-insensitive name.
- Failure to read one directory does not imply the WorkContext must be destroyed.

## `create_workspace_entry`

### Request

```ts
interface CreateWorkspaceEntryRequest {
  parentPath: string;
  name: string;
  kind: "file" | "directory";
}
```

### Response

```ts
interface CreateWorkspaceEntryResult {
  path: string;
  identity: ResolvedPathIdentity;
}
```

### Guarantees

- `name` must be exactly one leaf component; path separators, `.` and `..` are rejected.
- Existing target is never overwritten.
- A file is created empty.
- Failure leaves no successful-looking frontend node.

## `rename_workspace_entry`

### Request

```ts
interface RenameWorkspaceEntryRequest {
  sourcePath: string;
  newName: string;
}
```

### Response

```ts
interface RenameWorkspaceEntryResult {
  oldCanonicalPath: string;
  newPath: string;
  newIdentity: ResolvedPathIdentity;
}
```

### Guarantees

- `newName` is one leaf component.
- Existing destination is not overwritten.
- Rust returns success only after the filesystem rename succeeds.
- Frontend document/Explorer path state is not committed before this response.

## `trash_workspace_entry`

### Request

```ts
interface TrashWorkspaceEntryRequest {
  path: string;
}
```

### Response

`void` on success.

### Guarantees

- Moves the entry to the OS recycle/trash facility.
- Does not permanently delete as fallback.
- Failure leaves the original path available when the operating system operation itself did not succeed; frontend state must remain unchanged.

## `resolve_workspace_relation`

### Request

```ts
interface ResolveWorkspaceRelationRequest {
  rootPath: string;
  targetPath: string;
}
```

### Response

```ts
type ResolveWorkspaceRelationResult =
  | { type: "inside"; relativePath: string }
  | { type: "outside" };
```

### Guarantees

- Resolves canonical filesystem identity/component semantics.
- `D:\\project-old` is not inside `D:\\project`.
- Equivalent spellings and case variants follow the same platform rules as existing `file_identity` comparison keys.
- Symlink/junction resolution follows canonical targets.

Untitled documents do not invoke this command; the frontend returns `unbound` directly.
