# Data Model: Single-File Editing Lifecycle

## 1. ActiveDocumentSession

Represents the metadata and saved relationship for the one document currently hosted by CodeMirror.

| Field | Type | Meaning |
|---|---|---|
| `path` | `string | null` | Current disk destination; null for Untitled |
| `displayName` | `string` | Filename derived from path or `Untitled` |
| `format` | `TextFormat` | Encoding/BOM/EOL metadata used for save |
| `dirty` | `boolean` | Whether current CodeMirror document differs from saved baseline |

The live text itself is **not** a field in React session state. CodeMirror owns it.

### Validation rules

- `path=null` implies the document is untitled.
- A newly created session starts with `dirty=false`.
- `displayName` changes only when a document is newly opened/created or Save As succeeds.
- `dirty` is derived from current CodeMirror `Text` versus `SavedBaseline`, never from path or timestamps.

## 2. TextFormat

Represents disk-oriented format metadata retained separately from the normalized editor text.

| Field | Type | Meaning |
|---|---|---|
| `encoding` | `"utf8"` | M1 supported encoding; enum-shaped for future expansion |
| `bom` | `"none" | "utf8"` | Whether UTF-8 BOM should be emitted on save |
| `detectedLineEnding` | `"none" | "lf" | "crlf" | "mixed"` | What was observed when the document was opened/created |
| `preferredLineEnding` | `"lf" | "crlf"` | Concrete output EOL to use when a write is required |

### Rules

- New document: `encoding=utf8`, `bom=none`, `detectedLineEnding=none`, `preferredLineEnding=crlf`.
- Uniform LF file: detected/preferred are `lf`.
- Uniform CRLF file: detected/preferred are `crlf`.
- Mixed: detected=`mixed`; preferred is dominant observed style; tie=`crlf`.
- No EOL bytes: detected=`none`; preferred=`crlf`.
- Save command never passes `mixed` or `none` as a physical output EOL.

## 3. SavedBaseline

A CodeMirror immutable `Text` snapshot corresponding to the exact logical content of the most recent successful save/open baseline.

### Ownership

Held by `DocumentController` outside React render state (for example, a ref/field).

### Transitions

```text
New/Open success
    -> savedBaseline = newly loaded CodeMirror document

Document edit
    -> baseline unchanged
    -> dirty = !currentDoc.eq(savedBaseline)

Undo/Redo
    -> baseline unchanged
    -> dirty recomputed

Save starts
    -> savingSnapshot = currentDoc
    -> baseline unchanged until success

Save success
    -> savedBaseline = savingSnapshot
    -> dirty = !currentDoc.eq(savedBaseline)

Save failure/cancel
    -> baseline unchanged
```

This makes edit-during-save correct: if current document advances after `savingSnapshot`, save success still leaves the newer current document dirty.

## 4. OpenTextFileResult (Rust → frontend)

Returned only after the selected path has been read and decoded successfully.

| Field | Type | Meaning |
|---|---|---|
| `text` | `string` | UTF-8/JS Unicode text normalized to LF |
| `format` | `TextFormat` | Detected file metadata |

Path is already known by the frontend picker and does not need to be trusted from the Rust response.

## 5. WriteTextFileRequest (frontend → Rust)

| Field | Type | Meaning |
|---|---|---|
| `path` | `string` | Destination chosen/current path |
| `text` | `string` | Snapshot serialized from CodeMirror; logical LF separators |
| `bom` | `"none" | "utf8"` | Output BOM |
| `lineEnding` | `"lf" | "crlf"` | Concrete output separator |

### Validation rules

- `lineEnding` cannot be `mixed` or `none`.
- Only UTF-8 output exists in M1.
- A successful return means all requested bytes were written by the write operation; only then may frontend session/baseline state advance.

## 6. FileCommandError

Serializable error returned by Rust commands.

| Field | Example values | Meaning |
|---|---|---|
| `code` | `io_read`, `io_write`, `unsupported_encoding`, `unsupported_binary`, `unsupported_line_ending` | Stable programmatic category |
| `message` | human-readable string | Text suitable for the M1 native error dialog |

The active document is never replaced as a side effect of an Open error.

## 7. CommandDefinition

Represents a stable application action independent of menu/shortcut surface.

| Field | Type | Meaning |
|---|---|---|
| `id` | `CommandId` | Stable identifier |
| `execute` | `() => void | Promise<void>` | Handler bound to current application/editor context |

### M1 CommandId values

```text
file.new
file.open
file.save
file.saveAs
app.exit
editor.undo
editor.redo
```

## 8. KeymapProfile

Maps a command ID to a platform-native accelerator string.

```text
idea/windows-m1
├── file.new       Ctrl+N
├── file.open      Ctrl+O
├── file.save      Ctrl+S
├── file.saveAs    Ctrl+Shift+S
├── editor.undo    Ctrl+Z
└── editor.redo    Ctrl+Shift+Z
```

The profile is data rather than hard-coded business behavior so later Windows/Custom profiles can replace bindings without changing command handlers.

## 9. UnsavedGuardResult

Conceptual state returned by the unsaved-work decision flow.

```text
proceed | cancel
```

Dialog choice mapping:

- clean document → `proceed` without dialog
- Don't Save → `proceed`
- Cancel → `cancel`
- Save → `proceed` only when Save completes successfully; otherwise `cancel`

## 10. Document lifecycle state transitions

```text
                         edit
                    +------------+
                    |            v
[Clean Untitled/Open] -------> [Dirty]
       ^   |                     |  |
       |   | Save success        |  | Undo to baseline
       |   +---------------------+  |
       |                            |
       +----------------------------+

New requested while Dirty, or Open target selected and decoded while Dirty
       -> Unsaved Guard
           -> Cancel: remain Dirty/current document
           -> Don't Save: replace document
           -> Save success: replace document
           -> Save cancel/fail: remain Dirty/current document

Open picker cancel or read/decode failure
       -> current document, path, format, and dirty state unchanged; no guard shown

Save As success
       -> path/displayName changes
       -> saved baseline = written snapshot
       -> dirty recomputed against current document
```
