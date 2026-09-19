# Implementation Plan: Opened Document External Change

**Implementation Branch**: `feature-core` (intentionally retained; Spec Kit feature pointer: `specs/005-opened-document-external-change`) | **Date**: 2026-09-19 | **Spec**: `specs/005-opened-document-external-change/spec.md`

**Input**: Feature specification from `/specs/005-opened-document-external-change/spec.md`

## Summary

005 adds a reusable filesystem-watch foundation plus an opened-document coordinator. Disk-bound `DocumentSession`s register watch interest independently of Workspace membership. The Rust/Tauri filesystem layer owns event-driven OS watching and emits normalized hints; the React/TypeScript application validates those hints against the current bound path and existing saved baseline/revision before changing document state. Clean external changes auto-reload, dirty divergence blocks ordinary Save until explicit overwrite, external deletion preserves the tab as `missing`, and Save recreates a missing file when possible.

The implementation deliberately stops before Workspace tree watching. It must be reusable by 006 but must not update Explorer from external events in 005.

## Technical Context

**Language/Version**: Existing Sorakada TypeScript/React frontend and Rust/Tauri backend; keep repository-pinned compiler/runtime versions rather than upgrading as part of 005.

**Primary Dependencies**: React, CodeMirror 6, Tauri, and one new Rust `notify` dependency at a version compatible with the current lockfile/toolchain. Repository inspection confirmed that no watcher dependency currently exists. `notify` supplies the event-driven native watcher required by 005; do not introduce a second watcher framework or upgrade unrelated dependencies.

**Storage**: Existing local filesystem only; no new persistent database or index.

**Testing**: Existing frontend unit/integration test runner plus Rust unit/integration tests. Add deterministic watcher-normalizer/coordinator tests that can inject synthetic events and controlled filesystem state; do not make the entire test suite depend on nondeterministic OS event timing.

**Target Platform**: Windows-first Tauri desktop application; watcher abstraction must not encode Windows-only business semantics above the backend layer.

**Project Type**: Desktop application (React UI + Tauri/Rust native filesystem layer).

**Performance Goals**:
- Idle opened-document watching is event-driven and performs no repeated whole-file scanning.
- Multiple opened files in one parent directory share one non-recursive watch where practical.
- Bursty events are coalesced before expensive validation/reload work.
- With 50 unchanged bound documents, a 60-second idle interval performs no periodic full-content reads; one focus-regain pass performs at most one cheap inspection per document, no full-content reads, and no synchronous content-read wait in the focus handler.

**Constraints**:
- Preserve 001–004 document/path/save behavior except where 005 explicitly adds external-change validation.
- Preserve stable `documentId` and existing `DocumentManager` ownership.
- Preserve 003 Explorer external-change contract; do not implement Workspace watcher/tree synchronization.
- Watcher callbacks never mutate `DocumentSession` directly.
- Do not suppress internal filesystem events by count/time heuristics such as “ignore next N events.”
- Do not guess external rename/move using content, size, timestamps, or path heuristics.
- Do not move/rename existing core modules merely to match this plan's suggested structure.

**Scale/Scope**: Normal editor usage from a few to dozens of open disk-bound documents, potentially outside the active Workspace and potentially distributed across multiple parent directories. Pathological hundreds-of-unrelated-directory tabs are not an optimization target for 005.

## Constitution Check

### Pre-design check

- **I. User Data Is Inviolable — PASS**: watcher events are hints only; failed reads and stale completions never replace the editor buffer. Dirty divergence blocks ordinary Save until explicit Overwrite, and baseline/path/external state advance only after a successful current write.
- **II. State Has One Owner — PASS**: CodeMirror continues to own live text and selection. `DocumentManager` owns document lifecycle, saved baseline, dirty/external state, and path rebinding. Rust owns byte/format interpretation and native filesystem watching; frontend watcher adapters carry typed hints and never mutate sessions directly.
- **III. Contracts Are Verified From Both Sides — PASS BY REQUIRED TASKS**: every new Tauri watcher command/event DTO and any extended inspection payload is pinned by Rust serialization tests and matching TypeScript adapter/decoding tests. Failure, cancellation, stale-result, missing, and overwrite paths receive deterministic regression coverage. All four repository gates remain mandatory.
- **IV. Commands Have One Execution Path — PASS**: Save, Save As, Rename, and Delete retain their existing commands and canonical handlers. External conflict handling branches inside the existing Save path; no alternate writer or UI-only mutation path is introduced.
- **V. Scope and Complexity Must Be Earned — PASS**: the reusable watcher, independent validation, external state, and internal-operation guard are required by the approved race/data-safety scenarios and recorded in Complexity Tracking. No Workspace sync, rename inference, diff/merge, database, polling loop, or new UI framework is added.

### Post-design check

The completed design preserves all five principles without an exception. The watcher callback only emits typed hints; validation and `DocumentManager` remain the transition boundary; all path changes use existing identity/ownership rules; and the minimal UI is a projection of manager-owned state. Phase 8 repeats this check against the actual diff. Any IPC change without synchronized Rust/TypeScript wire tests, any direct watcher-to-session mutation, any second command/write path, or any baseline/path advancement before successful disk completion fails this gate and must be corrected before completion.

## Existing Architecture to Preserve

Repository review established these concrete existing locations:

```text
src/app/App.tsx
src/app/document/documentManager.ts
src/app/document/documentSession.ts
src/app/commands/commandRegistry.ts
src/app/tabs/TabBar.tsx
src/editor/Editor.tsx
src/editor/editorConfig.ts
src/services/fileService.ts
src/styles/
src-tauri/src/commands/file.rs
src-tauri/src/file_identity.rs
src-tauri/src/lib.rs
```

Implementation MUST verify these paths still exist before editing and MUST modify the existing modules rather than creating duplicate managers/services. `tasks.md` retains symbolic aliases only as concise names for these resolved files.

## Path Alias Contract for Implementation Tasks

Before any feature code is changed, resolve these aliases to actual existing repository files and keep the mapping for the implementation session:

```text
$DOC_MANAGER          = src/app/document/documentManager.ts
$DOC_SESSION          = src/app/document/documentSession.ts
$COMMAND_REGISTRY     = src/app/commands/commandRegistry.ts
$TAB_BAR              = src/app/tabs/TabBar.tsx
$FILE_SERVICE_TS      = src/services/fileService.ts
$FILE_IDENTITY_RS     = src-tauri/src/file_identity.rs
$FILE_COMMAND_RS      = src-tauri/src/commands/file.rs
$TAURI_LIB_RS         = src-tauri/src/lib.rs
$APP_TSX              = src/app/App.tsx
$EDITOR_TSX           = src/editor/Editor.tsx
$EDITOR_CONFIG_TS     = src/editor/editorConfig.ts
```

If a named module moves before implementation, update the alias to its actual replacement. Do not resurrect obsolete architecture.

## Project Structure

### Documentation (this feature)

```text
specs/005-opened-document-external-change/
├── spec.md
├── plan.md
└── tasks.md
```

### Source Code (target structure; preserve existing equivalents)

New watcher-specific modules should be narrow and reusable. Suggested new files may be adapted to the repository's existing naming convention, but existing modules must not be duplicated.

```text
src/
├── app/
│   └── App.tsx                         # window-focus validation wiring only
├── app/document/
│   ├── documentManager.ts              # session state transitions + save validation integration
│   ├── documentSession.ts              # externalState/revision fields if not already present
│   ├── openedDocumentWatchCoordinator.ts   # NEW: opened-document consumer/orchestrator
│   ├── diskValidation.ts                   # NEW: validate bound path vs session baseline/revision
│   └── internalFsOperationGuard.ts         # NEW: reusable internal mutation reconciliation
├── services/
│   ├── filesystemWatcher.ts                # NEW: frontend subscription/event adapter
│   └── watchEventNormalizer.ts             # NEW only if normalization belongs above Tauri boundary
├── editor/
│   ├── Editor.tsx
│   └── editorConfig.ts                 # helper for external reload state replacement/history reset if appropriate
├── app/tabs/
│   └── TabBar.tsx                      # minimal non-modal external-state indication
└── styles/
    └── [existing styles]               # minimal state indicator styling; no UI redesign

src-tauri/src/
├── commands/
│   └── file.rs                         # existing file inspection/read/write command integration
├── file_identity.rs                    # existing diskRevision/canonical identity reuse
├── filesystem_watcher.rs               # NEW: reusable watcher manager, scopes, refcounts, invalidation
├── watch_event.rs                      # NEW or colocated: normalized backend event DTO
└── lib.rs                              # watcher state/event command registration

tests/ or colocated test directories/
├── document/
├── filesystem/
└── integration/
```

**Structure Decision**: Keep `DocumentManager`, path identity, file IO, and React shell in their existing modules. Add watcher infrastructure as a separate filesystem capability and an opened-document coordinator as the 005 consumer. This keeps the backend watcher reusable for 006 and prevents Explorer/Workspace behavior from leaking into 005.

## Design

### 1. State model

Do not replace `dirty`. Add/activate an orthogonal external state:

```text
ExternalState = normal | modified | missing
```

Required combinations include:

```text
clean + normal
clean + missing

dirty + normal
dirty + modified
dirty + missing
```

A clean `modified` state should normally be transient because successful validation/reload returns it to `normal`; it may exist briefly during async coordination or on reload failure.

`diskRevision` remains the fast revision metadata associated with the last successfully adopted/written disk baseline. Existing format metadata remains part of the persisted baseline semantics.

### 2. Watcher backend

005 subscription policy:

```text
bound document path
→ parent directory
→ NonRecursive watch
→ filter events to interested path(s)
```

Multiple open files with the same parent directory should share the underlying watch/refcount. A file outside Workspace is identical to a file inside Workspace for 005.

Subscription establishment must close the read→watch race: after an opened path is registered, and after any successful path rebinding such as Save As or internal Explorer Rename migrates to a new path, perform a post-subscription validation or use an equivalent ordering that proves no disk change slipped between the previously adopted revision and active watch interest.

The watcher backend must expose a reusable scope abstraction capable of later supporting:

```text
NonRecursive(parent directory)   # 005
Recursive(workspace root)        # 006
```

005 does not instantiate the recursive Workspace mode.

The backend must be able to surface at least:

```text
Changed(path) / hint
Removed(path) / hint
Created(path) / hint
WatchInvalidated(scope, reason)
```

Exact low-level event names are not business contracts. Rename pairs may be preserved by the normalizer for future 006 use, but 005 must not consume them as document path migration.

### 3. Watch events are hints

Raw events flow through debounce/coalescing and then request validation:

```text
OS event
→ watcher backend
→ normalized hint
→ openedDocumentWatchCoordinator
→ validate(documentId, expectedPathBinding, reason)
→ DocumentManager transition
```

No OS callback is allowed to mutate the editor/session directly.

Validation must carry a binding/version token (or equivalent current-path check) so an async result for an old path cannot mutate a session after Save As, Rename, or Close.

### 4. Validation tiers

Use different validation intensity by trigger:

**Watcher hint**
- Inspect current path.
- For a clean document where a meaningful change is suspected, read using the existing text reader and compare/adopt the supported disk snapshot.
- For a dirty document, determine whether the current disk baseline diverged sufficiently to enter `modified`; do not reload the editor.
- A direct Remove hint still validates existence before committing `missing` where practical, because replace/safe-save sequences can produce noisy remove/create events.

**Tab activation**
- Revalidate the activated bound document using current disk revision/path state.
- Read only if inspection indicates a possible change or a previous state/error requires reconciliation.

**Window focus regained**
- Revalidate all currently bound open documents using cheap inspection/revision checks first.
- Do not read every open file unconditionally.
- Only escalate to content read/reload when inspection indicates divergence or prior state needs reconciliation.

**Pre-save**
- Mandatory validation immediately before writing the existing bound path.
- If validation detects divergence, transition to external `modified`/`missing` and follow the appropriate save branch before any write.

### 5. Clean auto reload

On confirmed clean external change:

1. Read the full file using existing supported text-file rules.
2. If read/format validation fails, preserve current editor state and surface a non-destructive error.
3. Build a replacement CodeMirror state using the new content/format.
4. Clear previous undo/redo history.
5. Preserve every selection anchor/head at its prior absolute text offset, clamp each to the new document length, and restore a view that keeps the clamped primary head visible. Exact pixel scroll preservation is not required after line-layout changes.
6. Commit the replacement only if the same `documentId` still has the same bound path generation.
7. Update `savedBaseline`, `format`, `diskRevision`, and external state to normal.
8. Keep `dirty = false`.

Do not model this as a user edit transaction that makes the document dirty.

### 6. Dirty external modification and Save

When disk diverges while dirty:

```text
keep EditorState unchanged
keep dirty = true
externalState = modified
show non-modal tab/state indication
```

Ordinary Save flow becomes:

```text
saveDocument(id)
→ capture id/path/operation generation
→ mandatory disk validation
→ if normal: existing save flow
→ if modified: explicit Overwrite / Cancel decision
→ if missing: recreate-original-path flow
```

Overwrite reuses the existing save pipeline and encoding/format behavior. Only a successful write/adoption may update baseline/revision and clear dirty/external state. A failed or stale overwrite may not.

Do not add diff/merge.

### 7. External delete / missing

Confirmed path absence:

```text
keep documentId
keep bound path
keep EditorState/content
keep dirty as-is
externalState = missing
```

Save while missing:

1. Enter this branch before the ordinary `!dirty` Save no-op so a clean missing document can also be recreated; the existing Save command remains available for every active document.
2. Verify parent directory still exists and target ownership rules still allow the write.
3. Immediately revalidate that the target itself is still absent. If it reappeared, leave the recreate branch and apply clean-reappearance or dirty-conflict semantics instead of overwriting it as though it were still missing.
4. Recreate the original file using current session content and existing save semantics.
5. On success update revision/baseline and return to normal clean state.
6. If parent is absent or write fails, keep session/path/content and report failure; do not recursively create directories.

Reappearance at same path:
- clean → read/adopt/reload, normal;
- dirty → modified conflict, no reload.

### 8. Internal filesystem operation guard

Introduce a reusable coordinator, not a watcher-specific counter.

Conceptual lifecycle:

```text
beginMutation(paths, operationId)
→ mark relevant watch hints as pending/reconcile-required
→ perform existing filesystem operation
→ caller commits authoritative successful session/path state
→ obtain/confirm expected post-operation revision/path state
→ endMutation(operationId)
→ reconcile pending hints once
```

Rules:
- Never “ignore next N events.”
- Never use only a short timeout as proof that an event is internal.
- A mismatching final disk state must be validated as potential external divergence.
- Save and Save As use this in 005. The existing Explorer Rename/Delete flows also participate whenever they affect watched open documents: Rename migrates old/new watch interest after successful `commitRenamedPath()`, while successful internal Delete closes/unsubscribes without being misclassified as an external deletion. New/Move may reuse the mechanism in 006.

### 9. User feedback

005 must stay visually small before 007 UI work:

- Extend the existing Tab UI with a minimal non-modal external-state indication for `modified` and `missing`; reuse existing components/tokens.
- Do not introduce a new notification framework solely for 005.
- Save conflict uses the existing dialog/confirmation mechanism and exposes explicit `Overwrite` / `Cancel` semantics.
- Reload/read errors use the existing error-reporting path.
- If a general Reload from Disk action already exists or is exposed later, dirty reload requires an explicit discard confirmation; implementing a new general reload command is not required by 005.

### 10. 006 compatibility constraints

The following are deliberate extension points, not 006 implementation:

- watcher scope supports future recursive root watches;
- normalized event representation is independent of `DocumentSession`;
- watch invalidation/event loss can be surfaced;
- internal mutation guard is path/scope-based and reusable;
- no watcher module imports Explorer/Workspace UI/domain code;
- 005 consumer is `OpenedDocumentWatchCoordinator` or equivalent; 006 will add a different Workspace consumer;
- no content/mtime heuristic external rename guessing.

## Test Strategy

Tests are required because this feature is primarily state/race/data-safety behavior.

Prefer deterministic layers:

1. **Rust watcher and IPC tests**: subscription/refcount bookkeeping, scope mode, normalized event mapping, invalidation propagation, plus exact serialized command/event DTO shapes. Do not rely solely on live OS event timing.
2. **Disk validation unit tests**: unchanged/changed/missing/unreadable/reappeared outcomes using controlled temp files and the existing file reader/identity layer.
3. **DocumentManager/coordinator tests**: state transition matrix across clean/dirty × normal/modified/missing; stale path generation; close during validation; Save As rebinding.
4. **Save protection integration tests**: dirty external change → Save → Overwrite/Cancel; missed-event pre-save detection; missing → recreate.
5. **Internal mutation tests**: own Save/Save As notifications do not produce false conflict; actual external divergence during a guarded mutation is not swallowed.
6. **Frontend adapter/contract tests**: pin watcher command arguments, subscription responses, normalized event decoding, listener cleanup, and error/invalidation payloads against the Rust wire contract. The repository has no React component-test harness, so TabBar rendering is verified manually while manager snapshot/projection behavior is covered in Vitest without adding jsdom/React Testing Library.
7. **Manual smoke tests**: edit same file with Notepad/IDE, delete/recreate externally, Alt+Tab focus validation, background tab changes, outside-Workspace file.

Before completion, run the repository's four mandatory gates exactly:

```text
npm run typecheck
npm run test
npm run build
cd src-tauri && cargo test
```

## Compatibility / Superseded Requirements

005 does **not** rewrite prior specs; it adds a newer contract where those specs explicitly deferred external-file handling.

- **002 deferred File watcher / External modification UI** → now implemented for opened documents only.
- **003 “external filesystem changes converge after Refresh”** → remains valid for Explorer. 005 only updates opened DocumentSessions.
- **003 internal Delete closes successfully deleted opened files** → remains valid. External delete is newly defined to keep the document open as `missing`.
- **Existing Save behavior** → augmented with mandatory disk validation and explicit overwrite protection when external divergence is detected. Encoding/EOL/write semantics remain unchanged.

## Complexity Tracking

| Deliberate complexity | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| Watcher hint + independent disk validation | Filesystem event streams can duplicate, coalesce, reorder, or miss events | Treating raw events as truth can create false missing/conflict states and silent overwrite risk |
| Orthogonal `externalState` beside `dirty` | Dirty and disk divergence describe different dimensions | A single conflict flag cannot represent clean-missing, dirty-missing, or dirty-normal correctly |
| Internal filesystem operation guard | Save/Save As naturally generate watcher events and 006 needs the same mechanism | Ignoring the next N events/time-window suppression is race-prone and can swallow genuine outside edits |
| Path-binding generation/stale-result checks | Validation/reload is asynchronous while Save As/Close/Rename may rebind/close sessions | Applying async results by document ID alone can corrupt a newly rebound session |
| Add the Rust `notify` crate if repository inspection confirms no watcher dependency | 005 requires event-driven native watching and the current manifest has no watcher library; `notify` supplies one reusable cross-platform backend compatible with the Windows-first target | Polling violates SC-008, and writing a bespoke OS watcher would add more platform-specific code and risk than one established dependency |
