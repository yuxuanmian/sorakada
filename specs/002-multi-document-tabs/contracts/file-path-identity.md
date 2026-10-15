# Contract: File Path Identity Inspection

**Feature**: `002-multi-document-tabs`

002 adds one Rust/Tauri IPC command for path identity. Existing `read_text_file` and `write_text_file` contracts stay byte-format focused.

## Command

```text
inspect_file_path(request: InspectPathRequest)
  -> Result<ResolvedPathIdentity, FileCommandError>
```

Request DTO (Rust uses `#[serde(rename_all = "camelCase")]`):

```json
{
  "path": "C:\\work\\notes.txt",
  "allowMissing": false
}
```

Frontend invocation shape:

```ts
invoke<ResolvedPathIdentity>("inspect_file_path", {
  request: { path, allowMissing }
});
```

## Success DTO

Serialized camelCase:

```json
{
  "requestedPath": "C:\\work\\notes.txt",
  "canonicalPath": "C:\\work\\notes.txt",
  "comparisonKey": "c:\\work\\notes.txt",
  "kind": "file",
  "diskRevision": {
    "size": 1234,
    "modifiedTimeMillis": 1789600000000
  }
}
```

`kind` values:

```text
file
folder/directory -> serialized as "directory"
missing
```

For `missing`, `diskRevision` is `null`.

## Existing path rules

- Resolve the full existing path through the filesystem.
- Return `file` or `directory` from metadata.
- Generate a comparison key using platform path equality semantics required by 002. Windows comparison is case-insensitive.
- Equivalent spellings and links that resolve to the same canonical path share a key; distinct hard-link paths are not guaranteed to share one in 002.
- `canonicalPath` is internal and may use a normalized/native-resolved representation; user-facing Tabs keep the normal selected/open path.

## Missing target rules

When `allow_missing=true` and the final path does not exist:

1. Resolve/canonicalize the existing parent directory.
2. Join the requested final filename to the resolved parent.
3. Return `kind="missing"` and a comparison key for that candidate.
4. If the parent cannot be resolved, return a path-resolution error.

When `allow_missing=false`, a missing path is an error.

## Error contract

Add/retain a stable error shape:

```json
{
  "code": "path_resolution",
  "message": "..."
}
```

The frontend `FileCommandCode` union must include any new stable code used by this command.

## Security/correctness constraints

- This command only inspects metadata/path identity; it must not create, truncate, or modify the target.
- Do not use frontend string lowercasing as a substitute for this command.
- The command does not promise a permanent OS-native file id in 002; future native-id fields may be added without changing the current comparison-key consumer contract.
