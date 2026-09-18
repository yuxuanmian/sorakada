# Data Model: Multi-Document Tabs

**Feature**: `002-multi-document-tabs`  
**Date**: 2026-09-17

All models in 002 are process-memory models unless explicitly marked as an IPC DTO. No session persistence is introduced.

## 1. DocumentId

A stable opaque identifier assigned when a document session is created.

```ts
export type DocumentId = string;
```

### Rules

- Unique among all live sessions.
- Never derived from `displayName`, `UntitledN`, or file path.
- Does not change after Save As.
- Async operations capture this id and use it to find the originating session on completion.
- A completion for a document id that no longer exists must not mutate another session.

---

## 2. DocumentSession

Represents one open document.

```ts
interface DocumentSession {
  id: DocumentId;

  path: string | null;
  pathIdentity: ResolvedPathIdentity | null;
  displayName: string;

  format: TextFormat;
  dirty: boolean;
  savedBaseline: Text;

  editorState: EditorState;
  viewState: DocumentViewState;

  latestSaveGeneration: number;
}
```

### Field rules

- `path`: user-facing/current real path; `null` for untitled documents.
- `pathIdentity`: internal comparison/revision metadata; `null` while untitled.
- `displayName`: `UntitledN` or basename derived from `path`.
- `format`: existing 001 UTF-8/BOM/EOL metadata.
- `dirty`: derived from current `editorState.doc` compared with `savedBaseline`.
- `savedBaseline`: exact CodeMirror `Text` snapshot represented by the latest relevant successful Save/Save As.
- `editorState`: always tracks the newest CodeMirror state reported for this document.
- `viewState`: scroll/read position captured when the document leaves the shared view.
- `latestSaveGeneration`: incremented for each explicit save intent and used to reject stale completion metadata.

### Invariants

1. `dirty === !editorState.doc.eq(savedBaseline)` after any document-text change or relevant save completion.
2. A disk-backed live session owns exactly one comparison key.
3. No two live sessions own the same comparison key.
4. Only a relevant successful save may change `savedBaseline` or adopt a new path identity.
5. A session may exist while not active; saving/closing it must not require temporary activation.

---

## 3. TextFormat

Reuses the 001 model.

```ts
type Encoding = "utf8";
type Bom = "none" | "utf8";
type DetectedLineEnding = "none" | "lf" | "crlf" | "mixed";
type LineEnding = "lf" | "crlf";

interface TextFormat {
  encoding: Encoding;
  bom: Bom;
  detectedLineEnding: DetectedLineEnding;
  preferredLineEnding: LineEnding;
}
```

002 does not expand supported encodings or line endings.

---

## 4. DocumentViewState

View-only reading position not guaranteed by `EditorState`.

```ts
interface DocumentViewState {
  scrollTop: number;
  scrollLeft: number;
}
```

### Rules

- Default is `{ scrollTop: 0, scrollLeft: 0 }`.
- Capture immediately before switching the shared view away from an active document.
- Restore after the target `EditorState` is bound.
- Do not emit React/application metadata updates merely because this value changes.
- Future versions may add an anchor document position/offset for theme/font reflow without changing the session ownership model.

---

## 5. ResolvedPathIdentity (IPC + frontend model)

Result of Rust-side path inspection.

```ts
type ResolvedPathKind = "file" | "directory" | "missing";

interface ResolvedPathIdentity {
  requestedPath: string;
  canonicalPath: string;
  comparisonKey: string;
  kind: ResolvedPathKind;
  diskRevision: DiskRevision | null;
}
```

### Rules

- `canonicalPath` is internal resolved/candidate path representation; UI should continue using the normal document path for display.
- `comparisonKey` is the only key used by 002's open-session ownership map and in-flight Save As target-claim map.
- Existing files/directories resolve the full path.
- A missing final target may be resolved only when Save As asks for candidate-target identity; the existing parent is resolved and the leaf is joined.
- Directory drops are identified through `kind === "directory"` and skipped.
- `comparisonKey` comparison follows target-platform semantics (case-insensitive on Windows).
- A future native file ID may be added to this DTO/entity without replacing `documentId` or manager APIs.

---

## 6. DiskRevision (IPC + frontend model)

Lightweight metadata captured for a disk object.

```ts
interface DiskRevision {
  size: number;
  modifiedTimeMillis: number | null;
}
```

### 002 behavior

- Populated by path inspection where metadata is available.
- Stored with disk-backed sessions after open/Save As.
- Not continuously compared and does not trigger any external-change UI in 002.
- Exists as the extension point for later focus/save validation and filesystem watcher work.

---

## 7. DocumentManagerSnapshot

Lightweight projection consumed by React.

```ts
interface DocumentManagerSnapshot {
  activeDocumentId: DocumentId;
  tabs: readonly TabSnapshot[];
}

interface TabSnapshot {
  id: DocumentId;
  displayName: string;
  path: string | null;
  dirty: boolean;
  active: boolean;
}
```

### Rules

- Contains no document text and no `EditorState`.
- Emitted when Tab-visible metadata/order/active state changes.
- Normal cursor movement must not emit a snapshot.
- Text edits emit only if they change the Tab-visible dirty flag (for example clean -> dirty or dirty -> clean via undo).

---

## 8. DocumentManager internal indexes

Conceptual manager state:

```ts
interface DocumentManagerState {
  orderedIds: DocumentId[];
  sessions: Map<DocumentId, DocumentSession>;
  activeDocumentId: DocumentId;
  nextUntitledNumber: number;
  openPathIndex: Map<string, DocumentId>;
  pendingPathClaims: Map<string, DocumentId>;
}
```

### Invariants

- `orderedIds.length >= 1` during normal editing mode.
- `activeDocumentId` always exists in `sessions` during normal editing mode.
- Every disk-backed session comparison key exists exactly once in `openPathIndex`.
- A comparison key may not be owned by one document and claimed by a different document.
- `nextUntitledNumber` only increases.

---

## 9. SaveOperation

Ephemeral operation context captured before async disk work.

```ts
interface SaveOperation {
  documentId: DocumentId;
  generation: number;
  snapshot: Text;
  targetPath: string;
  targetIdentity: ResolvedPathIdentity;
  adoptPath: boolean;
  format: TextFormat;
}
```

### State transitions

```text
created
  -> target claimed (Save As only)
  -> queued/writing
  -> success | failure

success + session exists + generation still latest
  -> adopt path if needed
  -> update savedBaseline
  -> recompute dirty
  -> release/commit claim

success + stale generation/session missing
  -> no session metadata mutation
  -> release claim

failure
  -> no path/baseline mutation
  -> release claim
  -> report error
```

The existing same-target write chain remains responsible for disk issue order. Generation is responsible for session metadata relevance.

---

## 10. OpenPathResult

Result used by normal Open and drag/drop orchestration.

```ts
type OpenPathResult =
  | { status: "opened"; documentId: DocumentId }
  | { status: "activated-existing"; documentId: DocumentId }
  | { status: "ignored-directory" }
  | { status: "cancelled" }
  | { status: "failed"; error: FileCommandError };
```

### Rules

- No `DocumentSession` is inserted for `failed`, `cancelled`, or `ignored-directory`.
- `activated-existing` is considered a successful handled path for drag/drop final activation.

---

## 11. Close result

```ts
type CloseDocumentResult =
  | { status: "closed" }
  | { status: "cancelled" }
  | { status: "failed"; error: FileCommandError };
```

`prepareCloseAll()` returns `true` only if every dirty-document decision allows window destruction.

---

## 12. Untitled numbering

```text
initial nextUntitledNumber = 1
create -> use current value, then increment
never decrement or search for holes
```

Example:

```text
Untitled1 -> Save As foo.txt -> close
Untitled2 -> close
next New = Untitled3
```

The number is a process-local display allocation, not a document identifier.
