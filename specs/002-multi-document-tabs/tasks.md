# Tasks: Multi-Document Tabs

**Input**: Design documents from `/specs/002-multi-document-tabs/`

**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/`, `quickstart.md`

**Tests**: Required for lifecycle/state/path-identity logic. Native GUI actions remain manual per `AGENTS.md`.

**Agent audience**: This task list is intentionally explicit enough for a lower-context implementation agent. Do not silently broaden scope. Follow the pseudocode/invariants under complex tasks.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel because it edits different files and does not depend on an incomplete task.
- **[Story]**: Maps to the user story in `spec.md`.
- Requirement IDs are included for traceability.

---

## Phase 1: Setup and Baseline

**Purpose**: Prove the 001 branch is green before refactoring and create no new dependency unless a later task explicitly requires it.

- [X] T001 Run the existing verification gates defined by `package.json`, `src-tauri/Cargo.toml`, and `AGENTS.md` before code changes: `npm run typecheck`, `npm run test`, `npm run build`, and `cd src-tauri && cargo test`; record any pre-existing failure before continuing.

**Checkpoint**: 001 baseline is known-good or any pre-existing failure is explicitly recorded.

---

## Phase 2: Foundational Multi-Document Infrastructure

**Purpose**: Add the shared data/path/editor primitives that every user story depends on.

**⚠️ CRITICAL**: Do not start Tab/open/save UI integration until these foundations compile and their focused tests pass.

- [X] T002 Add failing Rust unit tests for existing-file, directory, missing-target, `..`/equivalent-path resolution, disk revision shape, and Windows case-insensitive comparison behavior in `src-tauri/src/file_identity.rs` (FR-010, FR-011, FR-019, FR-020, FR-041).
- [X] T003 Implement `ResolvedPathIdentity`, `DiskRevision`, path-kind detection, existing-path canonicalization, missing-final-component resolution, and platform comparison-key generation in `src-tauri/src/file_identity.rs` until T002 passes (FR-010, FR-011, FR-019, FR-020, FR-041).

  ```text
  resolve(path, allowMissing):
    if path exists:
      canonical = canonicalize(path)
      metadata = metadata(canonical)
      kind = file | directory
    else if allowMissing:
      parent = canonicalize(existing parent)
      canonical = parent + requested leaf
      kind = missing
      metadata = none
    else:
      return path_resolution error

    comparisonKey = platformComparisonKey(canonical)
    return identity
  ```

- [X] T004 Add `InspectPathRequest` camelCase request-shape tests plus `inspect_file_path(request)` command contract tests and command adapter in `src-tauri/src/commands/file.rs`, preserving existing `read_text_file`/`write_text_file` JSON contracts unchanged (FR-011, FR-041, FR-043).
- [X] T005 Register the new file-identity module and `inspect_file_path` Tauri command in `src-tauri/src/lib.rs` without changing existing file-codec ownership (FR-043).
- [X] T006 Add failing TypeScript tests for `inspectFilePath(path, allowMissing)` request/response/error normalization in `src/services/fileService.test.ts` (FR-010, FR-011, FR-041).
- [X] T007 Extend `FileCommandCode`, add `ResolvedPathIdentity`/`DiskRevision` frontend DTOs, add `FileService.inspectFilePath`, and implement the Tauri wrapper in `src/services/fileService.ts` until T006 passes (FR-010, FR-011, FR-041).
- [X] T008 Refactor `src/app/document/documentSession.ts` from one `ActiveDocumentSession` shape into the multi-document entity types defined in `data-model.md`: `DocumentId`, `DocumentSession`, `DocumentViewState`, `DocumentManagerSnapshot`, `TabSnapshot`, monotonic untitled helpers, while preserving existing `TextFormat` definitions (FR-004, FR-005, FR-006, FR-039, FR-040, FR-043).
- [X] T009 Add an application-scoped CodeMirror appearance reconfiguration boundary around the current theme in `src/editor/editorConfig.ts` while keeping the current visual result unchanged and ensuring every newly created document state uses the same shared extension factory (FR-042).

  ```text
  createEditorState(doc, runtimeExtensions):
    extensions = [basicSetup, appearanceBoundary(currentTheme), runtimeExtensions]

  // No theme selector in 002.
  // Goal: later theme changes can reconfigure states without rebuilding the multi-document model.
  ```

**Checkpoint**: Rust path identity, TypeScript path DTOs, session entity types, and state factory compile independently of the yet-to-be-built manager.

---

## Phase 3: User Story 1 — Work with Several Documents at Once (Priority: P1) 🎯 MVP

**Goal**: Replace the single-document lifecycle with an ordered multi-document manager, one shared CodeMirror view, independent per-document state/history, and a basic Tab strip.

**Independent Test**: Launch with `Untitled1`, create `Untitled2`/`Untitled3`, type/undo/select/scroll differently in each, switch repeatedly, close/recreate untitled documents, and verify independent state plus monotonic naming.

### Tests for User Story 1

- [X] T010 [US1] Replace/migrate the single-document controller test harness with failing manager tests for initial `Untitled1`, monotonic naming, ordered sessions, active id, activate-by-id, editor-state update routing by explicit document id, dirty transitions, and lightweight snapshot emission in `src/app/document/documentManager.test.ts` (FR-001–FR-007, FR-039, SC-001).

  Required assertions:

  ```text
  initial tabs = [Untitled1], active = id1
  New -> Untitled2, old session remains
  close/save Untitled1 -> next New must be Untitled3 (no hole reuse)
  update(idA, stateA2) must never mutate idB
  cursor-only update replaces session.editorState but emits no Tab snapshot
  clean -> dirty emits snapshot; dirty -> dirty typing does not need another metadata emission
  ```

- [X] T011 [US1] Add focused fake-editor/view-state utilities needed by manager tests in `src/app/document/documentManager.test.ts`, modelling `setState(documentId,state)`, `captureViewState`, `restoreViewState`, focus, undo, and redo without DOM dependencies (FR-006, FR-007).

### Implementation for User Story 1

- [X] T012 [US1] Implement `DocumentManager` core session collection, `activeDocumentId`, monotonic `nextUntitledNumber`, `getSession`, `getActiveSession`, `listSessions`, `getSnapshot`, subscribe/unsubscribe, and `createUntitled` in `src/app/document/documentManager.ts` until T010 foundational cases pass (FR-001–FR-005, FR-039, FR-040).

  ```text
  constructor:
    create Untitled1 session
    orderedIds = [id1]
    activeDocumentId = id1
    nextUntitledNumber = 2

  createUntitled:
    id = new stable DocumentId
    name = "Untitled" + nextUntitledNumber++
    state = createEditorState("")
    session.savedBaseline = state.doc
    append; activate; emit
  ```

- [X] T013 [US1] Refactor the editor bridge so it binds a `documentId` to the single live view, reports every `update.state` with that id, exposes `getState`/`setState(documentId,state)`, and captures/restores `DocumentViewState` in `src/editor/editorHandle.ts` (FR-006, FR-007, FR-039).

  ```text
  setState(id, state):
    boundDocumentId = id       // MUST happen before setState
    view.setState(state)

  updateListener(update):
    if boundDocumentId != null:
      listener(boundDocumentId, update.state, update.docChanged)
  ```

  Do not use `manager.getActiveSession()` inside the CodeMirror listener to guess ownership.

- [X] T014 [US1] Implement manager `handleEditorStateUpdate(id,state,docChanged)` and `activateDocument(id)` in `src/app/document/documentManager.ts`, storing every state reference, recomputing dirty only on `docChanged`, snapshotting outgoing view state, switching the editor by id/state, restoring target view state, and emitting UI metadata only when needed (FR-006, FR-007, FR-039, SC-001).

  ```text
  handleEditorStateUpdate:
    session = sessions.get(id); if missing return
    session.editorState = state
    if !docChanged return
    newDirty = !state.doc.eq(session.savedBaseline)
    if newDirty != session.dirty:
      session.dirty = newDirty
      emitSnapshot()

  activateDocument(target):
    if target == active return/focus
    current.viewState = editor.captureViewState()
    activeDocumentId = target
    editor.setState(target, targetSession.editorState)
    editor.restoreViewState(targetSession.viewState)
    emitSnapshot(); editor.focus()
  ```

- [X] T015 [US1] Change `Editor` to mount exactly one `EditorView` from the manager-provided initial document id/state and attach/detach through the new bridge contract in `src/editor/Editor.tsx`, preserving React Strict Mode cleanup behavior (FR-006, FR-007).
- [X] T016 [P] [US1] Implement a presentation-only `TabBar` component that renders `TabSnapshot[]`, active/dirty state, close button, full-path tooltip, and active-tab scroll-into-view behavior, and import the Tab styles from `src/styles/tabs.css`, in `src/app/tabs/TabBar.tsx` (FR-032, FR-033, FR-044).
- [X] T017 [P] [US1] Add Tab-strip layout, horizontal overflow, active/dirty/close styles using existing CSS variables in `src/styles/tabs.css` without hard-coding a future-incompatible palette (FR-032, FR-033, FR-042).
- [X] T018 [US1] Rewire `App` to construct the editor handle + `DocumentManager` once, subscribe React only to `DocumentManagerSnapshot`, wire editor state updates back to the manager, render `TabBar` + single `Editor`, and make `file.new` call `createUntitled` in `src/app/App.tsx` (FR-001–FR-007, FR-039, FR-040).
- [X] T019 [US1] Remove the obsolete single-document `DocumentController` implementation and any imports after equivalent manager behavior exists, deleting `src/app/document/documentController.ts` and migrating/removing `src/app/document/documentController.test.ts` so there is only one authoritative lifecycle owner (FR-040).

**Checkpoint**: US1 works without disk opening: many untitled Tabs, independent CodeMirror state/history/scroll, lightweight React metadata, one shared editor view.

---

## Phase 4: User Story 2 — Open Files into Tabs Without Duplicates (Priority: P1)

**Goal**: File > Open creates a new Tab without replacing the current one, and equivalent paths reuse the already-open document.

**Independent Test**: Open A, open B, reopen A, try an invalid file, and verify A/B remain, duplicate A activates existing, and failure creates no Tab.

### Tests for User Story 2

- [X] T020 [US2] Add failing manager tests for successful open, duplicate comparison-key activation before a second read, invalid/read/decode failure with no partial session, open cancellation, two same-basename/different-identity files, and New/Open never prompting current dirty work in `src/app/document/documentManager.test.ts` (FR-008–FR-014, SC-002).

### Implementation for User Story 2

- [X] T021 [US2] Add `openPathIndex`, `openFromDialog`, and `openPath(path, options)` to `src/app/document/documentManager.ts`; inspect identity first, reuse an owned comparison key before calling `readTextFile`, create/register a new session only after successful read, and keep failures/cancellation side-effect free (FR-008–FR-014).

  ```text
  openPath(path):
    identity = await files.inspectFilePath(path, false)
    if identity.kind == directory:
      return ignore-or-fail according to caller option
    existing = openPathIndex.get(identity.comparisonKey)
    if existing:
      activateDocument(existing)
      return activated-existing(existing)

    opened = await files.readTextFile(path)
    // ONLY NOW create session
    id = createDocumentId()
    session = opened session with identity + opened.format
    register ownership; append; activate; emit
  ```

- [X] T022 [US2] Update `file.open` command wiring in `src/app/App.tsx` to use the manager's open flow, removing the 001 replace-current/unsaved-guard behavior while keeping existing dialog error reporting (FR-008, FR-009, FR-013).
- [X] T023 [US2] Ensure `TabBar` exposes each disk-backed document's full path through native/browser tooltip semantics while retaining basename display in `src/app/tabs/TabBar.tsx` (FR-014).

**Checkpoint**: File > Open is multi-document-aware and duplicate-safe; 001 decoding/format behavior is unchanged.

---

## Phase 5: User Story 3 — Save and Close the Correct Document Safely (Priority: P1)

**Goal**: Save/Save As/close operations address explicit document ids, preserve 001 write guarantees, prevent cross-Tab races, and safely close Tabs/windows.

**Independent Test**: Delay A save, switch/edit B, race Save As X/Y, attempt Save As into another open Tab, close active/inactive dirty Tabs, and exercise multi-dirty window exit.

### Tests for User Story 3

- [X] T024 [US3] Add failing save tests for inactive-document save, delayed A save after B activation, same-path write serialization, clean-save no-op, missing/closed-session completion, and dirty recomputation against captured snapshot in `src/app/document/documentManager.test.ts` (FR-015–FR-018, FR-030, FR-043, SC-003).
- [X] T025 [US3] Add failing Save As tests for X-then-Y stale completion, target already owned by another document, own-current-target allowance, concurrent claim of the same missing target, claim release on failure/stale completion, and path-index replacement only after relevant success in `src/app/document/documentManager.test.ts` (FR-016–FR-020, SC-003).
- [X] T026 [US3] Add failing close tests for clean close, dirty Save/Don't Save/Cancel, cancelled Save As, save failure, inactive close without activation, active-left-neighbor selection, first-tab fallback, last-tab replacement, and monotonic replacement naming; also parameterize `prepareCloseAll()` with three dirty documents across eight completing Save/Don't Save sequences and 14 aborting Cancel/Save-failure sequences across every position and allowed prefix in `src/app/document/documentManager.test.ts` (FR-021–FR-029, SC-006).
- [X] T027 [P] [US3] Update window lifecycle tests for active-title updates plus `prepareCloseAll()` integration: clean native close passes through; dirty close prevents default; a declined guard leaves the window open; approved close destroys directly without last-Tab replacement in `src/app/window/windowLifecycle.test.ts` (FR-027–FR-029, SC-006).

### Implementation for User Story 3

- [X] T028 [US3] Port the 001 per-destination write-chain behavior into `DocumentManager` and implement `saveDocument(id)` using the target session's current `editorState.doc`, format, and per-document save generation in `src/app/document/documentManager.ts` (FR-015–FR-018, FR-030, FR-043).

  ```text
  saveDocument(id):
    session = require session(id)
    if path == null: return saveDocumentAs(id)
    if !dirty: return success

    generation = ++session.latestSaveGeneration
    snapshot = session.editorState.doc
    await enqueueWrite(session.path, snapshot...)

    current = sessions.get(id)
    if !current || generation != current.latestSaveGeneration:
      return success-without-metadata-change

    current.savedBaseline = snapshot
    current.dirty = !current.editorState.doc.eq(snapshot)
    emit if dirty changed
  ```

- [X] T029 [US3] Implement `saveDocumentAs(id)` target inspection, open-owner collision rejection, pending target claims, generation relevance, post-write identity refresh, path-index ownership transfer, baseline/dirty update, and cleanup in `src/app/document/documentManager.ts` (FR-016–FR-020).

  ```text
  target = await dialogs.pickSavePath(session.path)
  if null -> cancelled
  targetIdentity = await inspect(target, allowMissing=true)

  owner = openPathIndex[key]
  claimer = pendingPathClaims[key]
  if owner != null && owner != id -> reject
  if claimer != null && claimer != id -> reject

  pendingPathClaims[key] = id
  generation = ++session.latestSaveGeneration
  snapshot = session.editorState.doc
  try write...
  finally release claim unless committed

  if stale/missing after write -> no metadata mutation
  else inspect written target, remove old ownership, adopt new ownership/path, baseline=snapshot
  ```

- [X] T030 [US3] Implement `closeDocument(id)` and shared per-document unsaved guard in `src/app/document/documentManager.ts`, saving the explicit target id without activating inactive Tabs and applying deterministic neighbor/last-Tab behavior only after closure is approved (FR-021–FR-026).
- [X] T031 [US3] Implement `prepareCloseAll()` in `src/app/document/documentManager.ts` using a stable Tab-order id snapshot, prompting only dirty sessions and returning false on Cancel/save failure without deleting Tabs or creating replacement Untitled sessions (FR-027–FR-029).
- [X] T032 [P] [US3] Add stable `file.close` command id to `src/app/commands/commandIds.ts` and `Ctrl+W` to `src/app/commands/ideaKeymap.ts`, ensuring event mapping remains derived from the profile rather than adding another shortcut route (FR-031).
- [X] T033 [P] [US3] Add `Close` to the native File menu in `src/app/menu/appMenu.ts`, dispatching `file.close` through the existing registry and displaying `Ctrl+W` consistently with the keymap profile (FR-031).
- [X] T034 [US3] Wire `file.save`, `file.saveAs`, and `file.close` commands in `src/app/App.tsx` to capture/use the current active document id at invocation time and call the manager's id-addressed methods; keep undo/redo on the shared active editor view (FR-015, FR-031).
- [X] T035 [US3] Update `TabBar` close-button handling so it passes the clicked document id to `closeDocument` and stops the click from also activating an inactive Tab in `src/app/tabs/TabBar.tsx` (FR-024, FR-032).
- [X] T036 [US3] Refactor native window-title and close interception to subscribe to manager snapshots/active session and call `prepareCloseAll()` before forced destroy in `src/app/window/windowLifecycle.ts`, keeping approved close from recursively re-entering the close listener (FR-027–FR-029).
- [X] T037 [US3] Rewire `app.exit` in `src/app/App.tsx` to use the same `prepareCloseAll()` decision then `getCurrentWindow().destroy()`, and ensure normal Tab close logic is not used for application exit (FR-027–FR-029).

**Checkpoint**: Explicit Save/Save As remains user-driven; async completion is document-safe; Tab and window close semantics are correct.

---

## Phase 6: User Story 4 — Drag Files into Sorakada (Priority: P2)

**Goal**: Native desktop drag/drop opens one or more files through the same manager pipeline with deterministic order and partial-failure tolerance.

**Independent Test**: Drop `[valid A, invalid binary, directory, duplicate A, valid B]`; verify A reused/opened once, failure reported, directory skipped, B still opens, order is deterministic, and last successful handled document is active.

### Tests for User Story 4

- [X] T038 [US4] Add failing batch orchestration tests for input-order processing, partial failure continuation, ignored directories, duplicate activation, and final successful document activation in `src/app/dragdrop/fileDropController.test.ts` (FR-035–FR-037, SC-004).

### Implementation for User Story 4

- [X] T039 [US4] Implement a Tauri-independent `processDroppedPaths(paths, manager)` orchestration helper in `src/app/dragdrop/fileDropController.ts` that awaits paths sequentially, continues after failures, treats opened/activated-existing as success, ignores directory results, and ensures the last successful document is active (FR-035–FR-037).

  ```text
  lastId = null
  for path in paths:
    result = await manager.openPath(path, { ignoreDirectories: true })
    if result has documentId:
      lastId = result.documentId
    // failure already reported; continue
  if lastId != null:
    manager.activateDocument(lastId)
  ```

- [X] T040 [US4] Install/dispose Tauri `onDragDropEvent` in the existing native-surface effect in `src/app/App.tsx`: `enter/over` sets overlay state, `leave/drop` clears it, and `drop` forwards `payload.paths` to `processDroppedPaths`; skip installation entirely in browser-only runtime (FR-035–FR-038).
- [X] T041 [P] [US4] Add the drag-over overlay element/style using existing theme variables in `src/styles/tabs.css` (or a dedicated imported style file if cleaner), ensuring it does not block normal editor input when inactive and disappears on leave/drop (FR-038, FR-042).

**Checkpoint**: Drag/drop is a thin native surface over the same duplicate/open lifecycle used by File > Open.

---

## Phase 7: Cross-Cutting Hardening and Regression

**Purpose**: Close gaps that span stories, validate performance, and prevent accidental 003+ scope creep.

- [X] T042 Add or update command/keymap unit tests for `file.close` and exact `Ctrl+W` resolution while preserving all previous command mappings in `src/app/commands/ideaKeymap.test.ts` and `src/app/commands/commandRegistry.test.ts` (FR-031).
- [X] T043 Update file dialog comments/tests so unsaved prompts are documented as close/exit guards rather than New/Open guards, without changing the Save/Don't Save/Cancel mapping in `src/services/fileDialogs.ts` and `src/services/fileDialogs.test.ts` (FR-009, FR-022, FR-027).
- [X] T044 Review and update `src/styles/global.css`/`src/styles/editor.css` only as needed so the Tab strip + editor fill the window correctly, overflow does not expand the app width, and existing editor appearance remains unchanged (FR-033, FR-042).
- [X] T045 Add an automated 20-session manager stress/correctness case (state isolation, active ordering, no artificial cap) in `src/app/document/documentManager.test.ts`, plus a 20-request duplicate-reuse case alternating dialog and dropped-path orchestration in `src/app/dragdrop/fileDropController.test.ts`; assert one session owns the resolved comparison key after every request (FR-010, FR-044, SC-001, SC-002).
- [X] T046 Re-run the full automated verification gates from `package.json` and `src-tauri/Cargo.toml`: `npm run typecheck`, `npm run test`, `npm run build`, `cd src-tauri && cargo test`; fix only 002-caused regressions and keep all 001 codec/IPC tests green (FR-043, SC-007).
- [X] T047 Execute the non-native portions of `specs/002-multi-document-tabs/quickstart.md` and prepare the native GUI checklist results section for the user; do not use SendKeys/UI Automation or scripted native window control (SC-001–SC-008).

  **Agent portion done**: §3 scenarios 1–16 are all covered by `npm run test`/`cargo test`; §2's four gates pass; quickstart §15 carries the 19-row native GUI checklist (N1–N19) with expected results, plus §15.1 recording the automated half. **Completed**: `AGENTS.md` later permitted script-driven native surfaces, so all 19 rows were executed under script control (WebView2 CDP for the web layer, Win32 control ids for the pickers, real mouse events for the message boxes) and every row passes; the §15 table holds the result per row, and the three residual gaps (OLE drag source, un-clicked native menu, the browser-only `Ctrl+N` accelerator collision) are recorded in §15.1. One defect was found and fixed: `Editor.tsx` did not focus the editor at launch.
- [X] T048 Add benchmark-only timing marks around Tab selection and the first animation frame after target editor state binding/focus in `src/app/tabs/TabBar.tsx` and the activation integration, then give the user the manual 20-cycle switching checklist in `specs/002-multi-document-tabs/quickstart.md`; collect the user's 40 activation measurements and compare every value and the first/final 10-value medians against SC-005 without scripting native input or adding a second EditorView as an unmeasured optimization (SC-005).

  **Agent portion done**: `src/app/performance/activationBenchmark.ts` measures Tab selection → first frame after the target state is bound and focused, wired through `DocumentManager.selectDocument` (only for user Tab selections, never internal activations) and exposed as `window.sorakada.benchmark`; `activationBenchmark.test.ts` pins the interval and the SC-005 median/drift arithmetic; quickstart §12 documents the run and carries the §12.1 results table. **Completed**: the 20 cycles were driven through CDP clicks against a 24.0 MB `large.txt`, producing 40 measurements — slowest 14.20 ms (limit 500), medians 9.90 ms → 11.20 ms, drift 1.131 (limit 1.25). All three SC-005 clauses pass; the numbers are in §12.1.
- [X] T049 Audit the final implementation against `specs/002-multi-document-tabs/spec.md` out-of-scope list and remove/avoid speculative watcher, recovery, session persistence, autosave, workspace, search, Save All, Tab reorder/pin, or advanced theme UI code from the 002 change set (FR-030, FR-040–FR-042).

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (T001)**: establishes baseline.
- **Phase 2 (T002–T009)**: foundational; blocks all user stories.
- **US1 / Phase 3 (T010–T019)**: blocks US2 and US3 because they require the manager and shared editor-state model.
- **US2 / Phase 4 (T020–T023)**: required before drag/drop because drop reuses `openPath`; Save As identity also relies on Phase 2 path infrastructure.
- **US3 / Phase 5 (T024–T037)**: can begin after US1 + Phase 2; its open-path ownership tests are easier after US2. Complete before final regression.
- **US4 / Phase 6 (T038–T041)**: depends on US2 `openPath`.
- **Phase 7 (T042–T049)**: after desired user stories are integrated.

### User Story Dependencies

```text
Foundational
    ↓
US1 Multi-document state/Tabs
   ├──────────────→ US3 Save/Close safety
   ↓
US2 Open/Duplicate identity
   └──────────────→ US4 Drag/drop

US1 + US2 + US3 + US4
    ↓
Cross-cutting validation
```

### Within User Story 1

1. T010–T011 failing tests/fakes.
2. T012 manager core.
3. T013 editor bridge.
4. T014 activation/update integration.
5. T015 editor mount.
6. T016/T017 Tab UI can proceed in parallel once snapshot shape from T008 is stable.
7. T018 App integration.
8. T019 remove old controller only after manager parity exists.

### Within User Story 3

1. T024–T027 tests first.
2. T028 basic Save and same-path ordering.
3. T029 Save As generation/claims.
4. T030–T031 close flows.
5. T032/T033 command/menu changes can proceed in parallel with manager save work.
6. T034–T037 integrate surfaces after manager APIs pass tests.

---

## Parallel Opportunities

- T006 (TS service test) can run while T002/T003 Rust identity work is underway once the intended contract in `contracts/file-path-identity.md` is accepted.
- T016 and T017 can run in parallel with manager/editor internals after `TabSnapshot` is defined by T008.
- T027 window tests can run in parallel with T024–T026 manager tests because they edit different files.
- T032 and T033 are parallel after the `file.close` semantics are known; resolve any command-id dependency by doing T032 first if the type checker requires it.
- T041 styling can run in parallel with T039 after the overlay class/prop name is agreed.

## Requirement Coverage Map

| Requirement range | Primary tasks |
|---|---|
| FR-001–FR-007 | T008, T010–T018 |
| FR-008–FR-014 | T002–T007, T020–T023 |
| FR-015–FR-020 | T002–T007, T024–T029, T034 |
| FR-021–FR-026 | T026, T030, T035 |
| FR-027–FR-029 | T027, T031, T036, T037 |
| FR-030 | T028–T031, T049 |
| FR-031 | T032–T034, T042 |
| FR-032–FR-034 | T016–T018, T023, T035, T044 |
| FR-035–FR-038 | T038–T041 |
| FR-039–FR-040 | T008, T010, T012–T014, T018–T019 |
| FR-041 | T002–T007 |
| FR-042 | T009, T017, T041, T044, T049 |
| FR-043 | T004–T009, T024, T028, T046 |
| FR-044 | T016, T045 |

## Success Criteria Coverage

| Success criterion | Validation tasks |
|---|---|
| SC-001 | T010, T014, T045, T047 |
| SC-002 | T020, T021, T038, T045, T047 |
| SC-003 | T024, T025, T028, T029 |
| SC-004 | T038–T040 |
| SC-005 | T048 |
| SC-006 | T026, T027, T030, T031, T036, T047 |
| SC-007 | T046 |
| SC-008 | T047 |

---

## Implementation Strategy

### MVP first

The smallest meaningful architectural milestone is **Foundational + US1**:

1. Complete T001–T009.
2. Complete T010–T019.
3. Stop and validate independent Untitled Tabs/state switching.

At this point Sorakada is genuinely multi-document in memory even before disk open/save migration is finished.

### Incremental delivery

1. **US1**: multiple untitled Tabs + independent editor state.
2. **US2**: disk Open + duplicate identity.
3. **US3**: id-addressed save/close/window safety.
4. **US4**: drag/drop surface.
5. **Hardening**: performance/manual regression and scope audit.

### Lower-agent guardrails

- Do not add a second `EditorView` to make Tab switching easier.
- Do not store document text in React `useState`/context/store.
- Do not let async Save completion call `getActiveSession()` to decide what to mutate; capture `documentId` at invocation.
- Do not compare files with only `path.toLowerCase()` in TypeScript.
- Do not create a Tab before file identity + read/decode succeed.
- Do not call `closeDocument()` repeatedly to implement app exit; use `prepareCloseAll()` and destroy the window directly on success.
- Do not implement file watcher, recovery, session persistence, autosave, Save All, file tree, search, Tab reorder/pin, split view, or theme-selection UI in 002.
- Do not modify `file_codec.rs` behavior to solve path identity; keep path identity in its own Rust module/command.
- Do not use Windows PowerShell 5.1 default text cmdlets to edit repository files.
- Do not automate native GUI interactions; hand those checks to the user through `quickstart.md`.

## Notes

- Commit after each coherent phase or small task group; avoid a single mega-commit if it makes state-model regressions hard to bisect.
- Keep tests deterministic by using fake editor/file/dialog services for manager race cases.
- If an implementation detail conflicts with an invariant in `contracts/`, update the implementation rather than silently weakening the invariant; product-scope changes require spec review.

---

## Phase 8: Convergence

Appended by `$speckit-converge` after assessing the current code against `spec.md`, `plan.md`,
`contracts/`, `data-model.md`, and this task list. No earlier task, ID, or phase was modified;
the four items below are the remaining unbuilt work. Ordering is CRITICAL/HIGH first.

- [X] T050 Make Save As destination reservations generation-scoped in `src/app/document/documentManager.ts` so a superseded completion cannot release the reservation renewed by a newer in-flight Save As of the same document, preserving "one comparison key belongs to at most one live session" per FR-020 (partial)

  ```text
  pendingPathClaims: comparisonKey -> { documentId, generation }

  saveDocumentAs:
    reserve the key together with the generation that owns it

  completion (success, stale, or failure):
    release the claim ONLY when the stored generation equals this operation's
    generation; a stale completion must never delete a newer operation's claim

  adoptPath:
    never overwrite openPathIndex[comparisonKey] that another live session owns

  add a manager test: the same document starts Save As to one destination twice
  with the older completion arriving stale; while the newer operation is still in
  flight a different document's Save As to that destination must still be
  rejected, and only one session may own the key afterwards
  ```

- [X] T051 Reserve a document-open destination comparison key for the lifetime of an in-flight `openPath` in `src/app/document/documentManager.ts` so two overlapping open requests for the same new path cannot both register a session for one comparison key, awaiting the in-flight open and returning `activated-existing` instead per FR-010 (partial)

  ```text
  openPath:
    if comparisonKey is owned          -> activate existing (unchanged)
    if comparisonKey has a pending open -> await that open, then activate its session
    else reserve the key, inspect/read/decode, register ownership only on success,
         and release the reservation on failure or cancellation

  add a held-read fake (`holdReads` / `releaseReads`) to
  `src/app/document/documentManager.test.ts`, mirroring the existing
  `holdWrites` control, and a test that two concurrent `openPath` calls for the
  same path produce exactly one session and activate it
  ```

- [X] T052 Key the per-destination write chain by the destination comparison key instead of the raw path string in `src/app/document/documentManager.ts` so equivalent spellings of one destination still land in issue order per FR-018 (partial)

- [X] T053 Restore standard formatting for `appendUntitledSession` in `src/app/document/documentManager.ts` (the method's opening brace currently shares its line with the first statement of its body) per plan: DocumentManager implementation (partial)
