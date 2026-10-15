# Contract: DocumentManager

**Feature**: `002-multi-document-tabs`

This contract describes the application-layer lifecycle boundary. Exact class names may vary, but callers must not bypass these semantics by editing session collections directly.

## Public read surface

```ts
getSession(id: DocumentId): DocumentSession | undefined;
getActiveSession(): DocumentSession;
listSessions(): readonly DocumentSession[];
getSnapshot(): DocumentManagerSnapshot;
subscribe(listener: (snapshot: DocumentManagerSnapshot) => void): () => void;
```

### Guarantees

- `listSessions()` is ordered in Tab order.
- `getActiveSession()` is valid during normal editing mode.
- Snapshot listeners receive lightweight metadata only.

## Creation/open surface

```ts
createUntitled(): DocumentId;
openFromDialog(): Promise<OpenPathResult>;
openPath(path: string, options?: { ignoreDirectories?: boolean }): Promise<OpenPathResult>;
```

### `createUntitled()`

- Allocates the next monotonic `UntitledN`.
- Appends and activates it.
- Never runs an unsaved guard.

### `openPath(path)`

1. Resolve path identity before reading.
2. If comparison key already belongs to a live session, activate it and return `activated-existing`.
3. Reject/ignore non-file path according to options.
4. Read/decode file.
5. Only after successful read, create/register a new session and activate it.
6. A failure must not modify existing sessions.

## Activation

```ts
activateDocument(id: DocumentId): void;
```

- No-op or safe failure when `id` is already active.
- Captures outgoing `DocumentViewState`.
- Binds target document identity and state to the editor bridge.
- Restores target view state.
- Emits one active-Tab metadata update.
- Does not create/destroy editor views.

## Editor update ingress

```ts
handleEditorStateUpdate(
  id: DocumentId,
  state: EditorState,
  docChanged: boolean,
): void;
```

- If `id` no longer exists, ignore.
- Always update that session's `editorState` reference.
- Recompute dirty only when `docChanged` is true.
- Emit React snapshot only if dirty changes.
- Never infer the session id from the active Tab at callback completion time.

## Save

```ts
saveDocument(id: DocumentId): Promise<CommandResult>;
saveDocumentAs(id: DocumentId): Promise<CommandResult>;
```

### Guarantees

- Snapshot text and document id are captured before awaiting disk work.
- Save on untitled delegates to Save As for the same id.
- Clean same-path Save remains a no-op, preserving 001 mixed-EOL behavior.
- Same-target writes remain serialized in issue order.
- Every explicit save intent increments the document's save generation.
- Only the latest relevant generation may alter path/baseline metadata.
- A closed/missing session ignores completion metadata.

### Save As ownership

- Resolve target comparison key before write.
- If another document owns or claims it: show error, return failure/cancel-safe result, write nothing.
- The same document may target its own current comparison key.
- Reserve a new target key until the operation is failed/stale or successfully committed.

## Close document

```ts
closeDocument(id: DocumentId): Promise<CloseDocumentResult>;
```

- Dirty session: Save / Don't Save / Cancel.
- Save result must be successful before close continues.
- Non-active documents are not activated just to save/close.
- Closing active document chooses left neighbor, otherwise new first.
- Normal close of the final Tab creates the next clean `UntitledN`.

## Window-close guard

```ts
prepareCloseAll(): Promise<boolean>;
```

- Iterate a stable snapshot of current document ids in Tab order.
- Prompt only dirty documents.
- Save targets the explicit id, even if inactive.
- Cancel or failed/cancelled Save returns `false` immediately.
- Earlier successful saves remain committed.
- Does not remove Tabs and does not create replacement Untitled documents.
- Caller destroys the window only when `true` is returned.

## Snapshot emission contract

Emit on:

- document added/removed
- active document changes
- dirty toggles
- Save As changes display name/path

Do not emit merely for:

- cursor/selection movement
- editor-state reference changes with unchanged dirty status
- scroll snapshot changes
- undo-history internal changes that do not alter dirty state
