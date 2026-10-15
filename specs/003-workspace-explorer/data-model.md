# Data Model: Workspace and Explorer

## WorkContext

Represents the one active Workspace identity. It does not own documents or Explorer UI state.

```ts
interface WorkContext {
  id: WorkContextId;
  rootPath: string;
  canonicalRootPath: string;
  comparisonKey: string;
  displayName: string;
}
```

### Rules

- At most one active WorkContext.
- Reopening the same `comparisonKey` is a no-op.
- Context is committed only after candidate root validation/direct-child read succeeds.
- Context replacement invalidates prior Explorer generation/state.
- Context is not persisted in 003.

## DocumentManagerSnapshot (003 change)

```ts
interface DocumentManagerSnapshot {
  activeDocumentId: DocumentId | null;
  tabs: readonly TabSnapshot[];
}
```

### Rules

- `activeDocumentId === null` iff zero document sessions are open.
- Empty State is UI only and is not represented in `tabs`.
- Creating/opening a document transitions null -> document id.
- Closing the final session transitions document id -> null without creating an Untitled session.

## WorkspaceRelation

Derived from a document's current path and the current WorkContext.

```ts
type WorkspaceRelation =
  | { type: "unbound" }
  | { type: "outside" }
  | { type: "inside"; relativePath: string };
```

### Rules

- Untitled -> `unbound`.
- No active WorkContext -> disk-backed documents are effectively `outside` for Workspace operations.
- Relation is never persisted as authoritative session state.
- Save As/Rename/Workspace replacement may change the derived result immediately.
- `inside.relativePath` uses filesystem-aware canonical component semantics.

## ExplorerEntry

Represents one visible filesystem entry.

```ts
type ExplorerEntryKind = "file" | "directory" | "other";

interface ExplorerEntry {
  name: string;
  path: string;
  kind: ExplorerEntryKind;
  isSymlink: boolean;
}
```

`other` covers special/broken entries that can be displayed but are not treated as normal expandable directories.

## ExplorerDirectoryNode

```ts
type LoadState = "not-loaded" | "loading" | "loaded" | "error";

interface ExplorerDirectoryNode extends ExplorerEntry {
  kind: "directory";
  expanded: boolean;
  loadState: LoadState;
  children?: readonly ExplorerNode[];
  resolvedCanonicalPath?: string;
  errorMessage?: string;
}

type ExplorerNode = ExplorerDirectoryNode | ExplorerFileNode | ExplorerOtherNode;
```

### State transitions

```text
not-loaded --expand--> loading
loading --success--> loaded
loading --failure--> error
error --retry/refresh--> loading
loaded --collapse--> loaded (expanded=false)
loaded --refresh--> loading -> loaded|error
```

Collapsing while `loading` does not cancel the disk read solely because of collapse; completion may populate cache but must not force `expanded=true`.

A WorkContext generation mismatch discards the completion entirely.

## ExplorerState

```ts
interface ExplorerState {
  contextId: WorkContextId | null;
  generation: number;
  root: ExplorerDirectoryNode | null;
  selectedPath: string | null;
  inlineEdit: InlineEditState | null;
  rootUnavailable: boolean;
}
```

### Rules

- Selection is persistent operation context, independent from DOM focus.
- WorkContext replacement replaces Explorer state rather than restoring a prior context's transient Tree state.
- Refresh preserves selection only if the path still exists.
- Inline edit is cancelled by Refresh or WorkContext replacement.

## InlineEditState

```ts
type InlineEditState =
  | {
      type: "create-file" | "create-folder";
      parentPath: string;
      draftName: string;
    }
  | {
      type: "rename";
      sourcePath: string;
      originalName: string;
      draftName: string;
    };
```

Only one inline edit exists at a time.

## FileOperationContext

Derived from active WorkContext plus Explorer selection.

```ts
interface FileOperationContext {
  workContext: WorkContext | null;
  selectedEntry: ExplorerNode | null;
  createParentPath: string | null;
  renameTargetPath: string | null;
  deleteTargetPath: string | null;
  isRootContext: boolean;
}
```

### Target rules

| State | Create parent | Rename target | Delete target |
|---|---|---|---|
| No Workspace | none | none | none |
| Workspace, no node | root | none | none |
| Workspace root | root | none | none |
| Selected directory | selected directory | selected directory | selected directory |
| Selected file | file parent | selected file | selected file |

`File > New` does not use this context; it always creates an Untitled document.

## Application Command Registration

```ts
interface CommandRegistration {
  execute(): void | Promise<void>;
  isEnabled?(): boolean;
}
```

### Rules

- Missing `isEnabled` means enabled.
- `execute()` checks current availability before calling the handler.
- Native menu/context menu/button state queries the same predicate.
- Explorer keyboard focus is a trigger-scope rule for F2/Delete; it is not stored as permanent filesystem operation ownership.

## Destination Ownership / Path Operation State

The exact private representation may stay inside `DocumentManager`, but the model must provide these semantics:

- one live owner per canonical destination comparison key;
- one compatible in-flight reservation per destination transition;
- reservations carry operation identity/generation so stale completion cannot release a newer claim;
- Open, Save As, file Rename, and other path transitions see each other's claims;
- path mutation can wait for relevant document writes/opens before committing;
- directory Rename/Delete can identify affected open/pending sessions by canonical containment without scanning disk descendants.

## UI Layout State

```ts
interface UiLayoutState {
  sidebarVisible: boolean;
  sidebarWidth: number;
}
```

This state is process-local only in 003.
