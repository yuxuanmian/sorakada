# Research: Multi-Document Tabs

**Feature**: `002-multi-document-tabs`  
**Date**: 2026-09-17

## Decision 1: Reuse one CodeMirror EditorView and retain one EditorState per document

**Decision**: Sorakada will keep a single mounted CodeMirror `EditorView`. Each `DocumentSession` owns its latest immutable `EditorState`; activating a Tab swaps the view to the target state and restores separately captured view/scroll state.

**Rationale**:

- Avoids one DOM/editor/plugin tree per Tab.
- Keeps hidden documents lightweight while preserving document text, selection, history, folds, and state fields.
- Matches the existing architecture where React owns application UI and CodeMirror owns editor state.
- CodeMirror virtualizes rendered document content, so switching to a large document does not mean materializing the entire file as DOM.

**Alternatives considered**:

- One `EditorView` per Tab, hidden when inactive: simpler mental model for scroll retention, but retains DOM, view plugins, listeners, measurements, and related memory for every Tab.
- Recreate editor state from plain text on every switch: rejected because it loses history/selection and makes large-file switching unnecessarily expensive.

## Decision 2: Synchronize EditorState continuously, but notify React only for UI metadata changes

**Decision**: Every CodeMirror state update stores `update.state` into the owning `DocumentSession`. `docChanged` additionally recomputes dirty state. The DocumentManager only emits a React-facing snapshot when Tab-visible metadata/order/active state changes; normal cursor movement or typing that does not change Tab metadata does not trigger general React UI state churn.

**Rationale**:

- `session.editorState = update.state` is an in-memory reference update, not a deep copy.
- Inactive saves and close-window saves need the latest state without temporarily activating the Tab.
- Prevents the Tab/application React tree from rerendering for every editor transaction.

**Alternatives considered**:

- Snapshot only when leaving a Tab: creates stale inactive session state and makes save/close races harder to reason about.
- Mirror document text into React state: violates the existing repository rule that CodeMirror owns live text.

## Decision 3: Bind editor updates to documentId inside the editor bridge

**Decision**: The editor bridge tracks which `documentId` is currently bound to the shared view. A state switch sets the target document identity before `EditorView.setState`. Update callbacks report `(documentId, state, docChanged)` to the manager.

**Rationale**:

- A Tab switch must never be misclassified as an update belonging to the previously active document.
- The bridge is the narrow place that understands `EditorView`; the manager can reason in document identities.

**Alternatives considered**:

- Read `manager.activeDocumentId` inside every update callback: workable but more coupled and vulnerable to ordering mistakes during state swaps.
- Temporarily suppress listeners during switches: adds a second state machine and can hide legitimate updates.

## Decision 4: Keep logical editor state and view/scroll state separate

**Decision**: `EditorState` remains the source for text, selection, history, and state fields. `DocumentViewState` separately stores scroll/read-position data. Capture view state when leaving an active Tab and restore it after binding the target state.

**Rationale**:

- Scroll position is a view concern, not a document-state concern.
- Avoids continuous React/manager work for every scroll pixel.
- Leaves room to improve from pixel scroll to anchor-based restoration if future theme/font changes require it.

**Alternatives considered**:

- Continuously persist every scroll event: unnecessary update pressure.
- Ignore scroll state: unacceptable Tab switching experience.

## Decision 5: Replace single-document DocumentController with a DocumentManager

**Decision**: The single-document lifecycle owner evolves into a manager that owns ordered sessions, `activeDocumentId`, untitled allocation, path ownership, save generations, and close-all coordination. Commands remain thin and dispatch into this manager.

**Rationale**:

- 001's controller invariants are valuable, but its single saved baseline/session cannot represent multiple Tabs.
- Future file tree, Save All, session persistence, recovery, and external validation need stable document-addressed operations.

**Alternatives considered**:

- Keep one `DocumentController` instance per Tab: multiplies dialog/write coordination and makes duplicate path ownership and window-close coordination awkward.
- Add a thin array around the current controller: still leaves save and editor ownership active-view-centric.

## Decision 6: Resolve file comparison identity in Rust, not with frontend string tricks

**Decision**: Add a lightweight Rust path-inspection command that resolves an existing file/directory to an internal canonical comparison key and returns basic disk revision metadata. For a not-yet-existing Save As target, resolve the existing parent and derive a comparison key for the candidate name. The frontend uses the returned comparison key for duplicate-open ownership and Save As target claims.

**Rationale**:

- Raw `path.toLowerCase()` does not handle `..`, symlinks/junctions, relative forms, or platform path semantics.
- Drag/drop needs to distinguish directories without adding a separate frontend filesystem plugin.
- Save As must be able to reserve a target before the file exists to prevent two sessions claiming the same new destination.

**Alternatives considered**:

- Compare display paths only: rejected as incorrect.
- Add a full native file-ID implementation in 002: deferred; canonical path comparison satisfies the 002 duplicate/open target invariant for equivalent path spellings and resolved links, while distinct hard-link paths may remain separate Tabs. The model leaves room for native IDs later.

## Decision 7: Keep read/write codec behavior stable; add path inspection as a separate contract

**Decision**: Existing `read_text_file` / `write_text_file` byte-format contracts stay focused on text/BOM/EOL. A new `inspect_file_path` command handles identity/kind/revision metadata.

**Rationale**:

- Minimizes regression risk to the 001 IPC contract and its tests.
- Duplicate detection can happen before rereading a large file.
- Save As can inspect/reserve targets independently from writing.

**Alternatives considered**:

- Add identity fields to `read_text_file`: simpler payload count but forces duplicate re-reads before the app can discover a file is already open.

## Decision 8: Use per-document operation generations plus per-target write ordering/claims

**Decision**: Each document increments a save-operation generation when a save/save-as intent starts. Only the latest still-relevant generation may adopt path/baseline metadata. Existing per-destination write serialization is retained. A target-claim map prevents another session from claiming an already owned or currently reserved Save As destination.

**Rationale**:

- Fixes the known cross-target race: Save As X followed by Save As Y, with X completing last.
- Keeps same-destination disk write ordering safe.
- Guarantees one destination belongs to at most one live document session, including not-yet-created targets.

**Alternatives considered**:

- Disable all save commands while any save is in flight: simpler but unnecessarily blocks normal multi-document work.
- Rely only on per-path write chains: does not solve metadata/path adoption races across different targets.

## Decision 9: Process dropped paths sequentially for 002

**Decision**: A dropped batch is handled in supplied order with an async `for...of`. Each entry completes (success, duplicate activation, directory skip, or failure) before the next begins. Failure is reported and processing continues.

**Rationale**:

- Deterministic Tab order with minimal coordination.
- Naturally handles duplicates within the same dropped batch.
- Reads are asynchronous, so sequential processing does not freeze the UI thread.

**Alternatives considered**:

- `Promise.all` reads: higher aggregate throughput but needs extra commit-order and duplicate/reservation coordination. Not needed for 002.

## Decision 10: Use Tauri's native drag/drop event surface

**Decision**: In the desktop shell, install one `onDragDropEvent` listener and handle `enter`, `over`, `drop`, and `leave`. `drop` provides native paths; `enter/over` controls a lightweight overlay state. Dispose the listener with the application effect.

**Rationale**:

- Tauri 2 exposes native file-drop paths directly and enables drag/drop handlers by default.
- Avoids browser HTML5 file APIs and path limitations on Windows.
- Fits existing Tauri runtime guards in `App.tsx`.

**Alternatives considered**:

- HTML5 drag/drop: conflicts with Tauri/WebView2 native drag-drop handling on Windows unless native handling is disabled.

**Reference**: Tauri 2 `onDragDropEvent` API and `dragDropEnabled` configuration, current documentation accessed 2026-09-17.

## Decision 11: Keep theme/appearance configuration application-scoped

**Decision**: 002 does not add theme UI. Editor configuration is refactored so the current appearance extension is behind an application-level reconfiguration boundary (for example, a CodeMirror compartment/helper) shared by every document state. Per-document sessions do not own independent theme preferences.

**Rationale**:

- Avoids baking the current `{ dark: true }` assumption permanently into document ownership.
- Future theme switching can reconfigure current/inactive states without redesigning the multi-document model.

**Alternatives considered**:

- Defer all appearance structure: risks later touching every session/state creation path.
- Build the full theme system now: out of scope.

## Decision 12: Defer watcher, recovery, persisted session, and autosave behavior

**Decision**: 002 carries stable document identity and disk-revision fields/interfaces only. It does not start filesystem watchers, write recovery snapshots, persist sessions, or automatically write real files.

**Rationale**:

- Keeps 002 centered on Tabs and multi-document correctness.
- The new manager boundaries are sufficient extension points for those later subsystems.
- Preserves Sorakada's current explicit Save/Save As user model.

**Alternatives considered**:

- Implement watcher/recovery simultaneously: significantly increases edge-case surface and obscures the core multi-document migration.
