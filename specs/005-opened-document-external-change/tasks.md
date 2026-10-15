# Tasks: Opened Document External Change

**Input**: Design documents from `/specs/005-opened-document-external-change/`

**Prerequisites**: `plan.md`, `spec.md`

**Tests**: Required for state transitions, save protection, watcher normalization, stale async results, and internal-mutation reconciliation. Prefer deterministic injected events/temp-file tests over timing-sensitive live watcher tests.

**Organization**: Tasks are grouped by user story. A blocking path-mapping/foundation phase prevents the implementation agent from inventing duplicate architecture when exact current source paths differ after 004.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel after its prerequisites are complete and it does not edit the same files as another in-flight task.
- **[Story]**: User story mapping from `spec.md`.
- Symbolic file aliases below MUST be resolved in Phase 1 before use. They are deliberately used instead of guessed repository paths for existing core modules.

## Existing-file aliases (resolve, do not duplicate)

```text
$DOC_MANAGER          src/app/document/documentManager.ts
$DOC_SESSION          src/app/document/documentSession.ts
$COMMAND_REGISTRY     src/app/commands/commandRegistry.ts
$TAB_BAR              src/app/tabs/TabBar.tsx
$FILE_SERVICE_TS      src/services/fileService.ts
$FILE_IDENTITY_RS     src-tauri/src/file_identity.rs
$FILE_COMMAND_RS      src-tauri/src/commands/file.rs
$TAURI_LIB_RS         src-tauri/src/lib.rs
$APP_TSX              src/app/App.tsx
$EDITOR_TSX           src/editor/Editor.tsx
$EDITOR_CONFIG_TS     src/editor/editorConfig.ts
```

**Non-negotiable implementation rule**: if an alias maps to an existing module, edit that module. Do NOT create a second `DocumentManager`, `FileService`, path identity layer, command registry, or parallel document state store just to satisfy a guessed layout.

---

## Phase 1: Repository Mapping and Regression Baseline

**Purpose**: Resolve current 004-era source paths and freeze existing behavior before introducing watcher code.

- [x] T001 Verify the concrete alias paths listed above still exist and locate the current usages of `read_text_file`, `write_text_file`, `inspect_file_path`, `diskRevision`, `commitRenamedPath()`, and the Save/Save As/Close/Rename/Delete flows. Record any path drift before implementation and update aliases to actual replacements rather than creating duplicate architecture. Do not modify production behavior in this task.
- [x] T002 Run the existing frontend and Rust test suites before changes and record any pre-existing failures; specifically identify current tests covering Save, Save As path adoption/ownership, dirty baseline advancement, close-after-save, path identity, and 003 internal Rename/Delete semantics.
- [x] T003 Confirm the current Cargo manifest has no watcher dependency, then add one toolchain-compatible `notify` version without upgrading unrelated dependencies. Record the selected version and lockfile impact in implementation notes; the dependency justification is the explicit Complexity Tracking entry in `plan.md`. Do not introduce a second watcher stack.

**Checkpoint**: Exact existing file locations are known; no duplicate core module will be created; baseline tests are understood.

---

## Phase 2: Foundational Watcher and Validation Infrastructure

**Purpose**: Build reusable infrastructure that all 005 stories depend on and that 006 can extend.

**⚠️ CRITICAL**: No user-story behavior should be wired into the UI until this foundation has deterministic tests.

- [x] T004 Add a reusable backend watcher manager in `src-tauri/src/filesystem_watcher.rs` (or the repository-equivalent Rust module if naming conventions require it) supporting subscription IDs, `NonRecursive` and future `Recursive` scopes, parent-directory watch refcount/sharing, unsubscribe, shutdown cleanup, and a normalized invalidation/error path; do not import document/workspace business types. Covers FR-005, FR-037, FR-038.
- [x] T005 [P] Define normalized watcher event DTOs in `src-tauri/src/watch_event.rs` (or colocated watcher module) with path/scope/subscription information and generic change hints plus `WatchInvalidated`; retain enough backend information for future 006 rename/move normalization but do not expose an opened-document-specific event type. Covers FR-007, FR-037, FR-038.
- [x] T006 Integrate watcher state/event emission/commands in `$TAURI_LIB_RS` and the existing command registration structure; expose start/stop subscription operations to the frontend and guarantee app shutdown releases watchers. Do not add Workspace watching. Covers FR-001–FR-007, FR-037–FR-040.
- [x] T007 [P] Add Rust unit tests beside `src-tauri/src/filesystem_watcher.rs` / `src-tauri/src/watch_event.rs` for shared non-recursive parent watches, refcount decrement/removal, independent subscriptions for unrelated directories, event normalization, duplicate event tolerance, and invalidation propagation. Pin the exact serialized command argument, subscription response, normalized event, error, and `WatchInvalidated` DTO shapes with `serde_json`; use synthetic backend events instead of sleeping on OS timing. Covers SC-004, SC-008 and the Constitution's Rust side of the IPC contract.
- [x] T008 Extend `$FILE_IDENTITY_RS` and/or `$FILE_COMMAND_RS` only as needed to expose the existing canonical/comparison-key and `diskRevision` inspection needed by validation for existing, missing, and unreadable paths; do not introduce a second path normalization implementation. Covers FR-010, FR-013–FR-015.
- [x] T009 [P] Add focused Rust tests for path inspection outcomes in the existing file-identity/file-command test area: unchanged existing file, changed revision, missing target, existing target with read/permission failure, parent missing, and recreated target. Covers FR-013–FR-015, FR-030–FR-034.
- [x] T010 Create `src/services/filesystemWatcher.ts` as the frontend adapter for Tauri watcher subscriptions/events, with typed subscription handles, event listener cleanup, and no direct `DocumentSession` mutation. Add `src/services/filesystemWatcher.test.ts` using injected invoke/listen boundaries to pin the exact command names/arguments, subscription response, normalized event, error/invalidation decoding, and listener cleanup against T007's Rust wire shapes. Covers FR-001–FR-007, FR-037 and the Constitution's TypeScript side of the IPC contract.
- [x] T011 [P] Create `src/services/watchEventNormalizer.ts` only if backend DTOs still need frontend normalization/coalescing; otherwise create the equivalent debounce/coalescing helper next to `filesystemWatcher.ts`. It must group bursty hints by canonical/comparison path without inferring rename/move. Covers FR-007, FR-010, FR-011, FR-038.
- [x] T012 Create `src/app/document/diskValidation.ts` with a reasoned validation API such as watcher-hint / tab-activate / window-focus / pre-save; reuse `$FILE_SERVICE_TS`/existing Tauri file APIs and return explicit unchanged/changed/missing/unverifiable outcomes rather than mutating sessions. Covers FR-007–FR-015, FR-020, FR-039.
- [x] T013 [P] Add unit tests for `diskValidation.ts` covering unchanged metadata, watcher-hinted change, missing path, temporary read failure, clean reappearance, dirty reappearance input, and stale expected-path/generation rejection; use fake/injected file inspection/read boundaries rather than real watcher timing. If T008 changes an inspection IPC payload, add matching TypeScript decoding assertions here or in `src/services/fileService.test.ts` that mirror T009's Rust serialization assertions. Covers FR-014, FR-015, FR-033, FR-034, FR-039.
- [x] T014 Create `src/app/document/internalFsOperationGuard.ts` implementing operation IDs/path claims, pending watcher-hint collection, post-operation reconcile, and cleanup; explicitly forbid count-based/time-only suppression, provide hooks used by current Save/Save As/Rename/Delete coordination, and keep them reusable by future Move operations. Covers FR-035, FR-036.
- [x] T015 [P] Add unit tests for `internalFsOperationGuard.ts`: own operation event burst reconciles cleanly, no-event internal operation completes, external mismatch during guarded operation is not swallowed, overlapping unrelated path operations remain independent, and stale operation completion cannot clear a newer guard. Covers FR-035, FR-036, SC-006.

**Checkpoint**: Watcher, normalization, validation, invalidation representation, and internal-operation guard exist independently of `DocumentManager`/Explorer.

---

## Phase 3: User Story 1 - Clean document follows external edits (Priority: P1) 🎯

**Goal**: Clean disk-bound documents automatically adopt supported external disk changes without becoming dirty or retaining stale undo history.

**Independent Test**: Open a clean file, modify it externally/simulate a validated watcher hint, and verify the same session reloads, remains clean, clears undo history, and preserves/clamps view state.

### Tests for User Story 1

- [x] T016 [P] [US1] Add `DocumentManager`/document-domain tests in the existing manager test file for clean external change → reload same `documentId`, baseline/format/revision update, dirty remains false, external state returns normal, and background-tab reload does not activate the tab. Covers FR-016, FR-017, SC-001.
- [x] T017 [P] [US1] Add editor-state tests in the existing editor/document test area proving external reload clears undo/redo history; preserves every selection anchor/head at the same absolute offset clamped to the new document length; and restores a view that keeps the clamped primary head visible without requiring exact pixel scroll preservation after layout changes. Covers FR-018, FR-019.
- [x] T018 [P] [US1] Add failure-path tests proving unsupported/binary/undecodable or transiently unreadable external content never replaces the existing editor buffer and is reported through the existing non-destructive error path. Covers FR-015, FR-020, FR-043.

### Implementation for User Story 1

- [x] T019 [US1] Extend `$DOC_SESSION` with the minimal external-disk state and any binding/validation generation needed by the plan; preserve existing `dirty`, `savedBaseline`, `format`, `diskRevision`, `documentId`, and path identity semantics rather than creating a watcher-owned session model. Covers FR-008, FR-009, FR-039.
- [x] T020 [US1] Add explicit `DocumentManager` operations in `$DOC_MANAGER` for applying validated clean external reload, marking validation errors, and committing external-state changes; keep all session mutation behind manager methods. Covers FR-016–FR-020, FR-037.
- [x] T021 [US1] Implement the CodeMirror replacement/reconfiguration helper in `$EDITOR_CONFIG_TS`, `$EDITOR_TSX`, or the existing editor bridge used by `DocumentManager` so an external reload replaces document content as a new disk baseline, clears undo/redo, preserves/clamps selection, and restores view state without generating a user-edit dirty transaction. Covers FR-016–FR-019.
- [x] T022 [US1] Create `src/app/document/openedDocumentWatchCoordinator.ts` that registers bound sessions, maps normalized hints by existing comparison-key identity, debounces/coalesces path hints, invokes `diskValidation.ts`, and requests `DocumentManager` transitions; it must verify the current session/path generation before applying async results. Covers FR-001–FR-012, FR-016–FR-020, FR-039.
- [x] T023 [US1] Wire document open/close and every successful bound-path change in `$DOC_MANAGER` to register/unregister/migrate opened-document watch interest. This includes Save As and the existing `commitRenamedPath()` flow for file and directory Rename; Untitled documents remain unwatched until successful binding, the same parent directory shares the backend watch, and each new/migrated subscription performs a post-subscription validation (or equivalent race-free ordering). Covers FR-001–FR-006, FR-044.
- [x] T024 [US1] Add tab-activation validation through the existing activation path in `$DOC_MANAGER`/`$TAB_BAR` integration without making TabBar own validation logic; activation triggers validation of the target bound document while leaving UI selection behavior unchanged. Covers FR-012.
- [x] T025 [US1] Wire application window focus regain in `$APP_TSX` (using the existing Tauri/window focus mechanism) to request cheap validation of all currently bound open sessions; do not unconditionally reread every file and do not couple this to Workspace Explorer refresh. Covers FR-012, FR-040, SC-005, SC-009.

**Checkpoint**: Clean opened files inside or outside Workspace follow external disk changes safely and automatically.

---

## Phase 4: User Story 2 - Dirty document is protected from external divergence (Priority: P1)

**Goal**: Preserve dirty in-memory work and prevent silent overwrite of externally changed disk content.

**Independent Test**: Make a document dirty, externally change disk, invoke Save, and verify normal Save is blocked until explicit Overwrite; Cancel changes nothing and Overwrite only clears states after a successful write.

### Tests for User Story 2

- [x] T026 [P] [US2] Add document-domain tests in the existing manager test file for dirty + external change → keep editor state, keep dirty, set external modified, no auto-reload, and repeated watcher hints do not repeatedly disrupt state. Covers FR-021, FR-022, FR-041.
- [x] T027 [P] [US2] Add Save integration tests in the existing save/manager test area for mandatory pre-save validation discovering a missed external change before write; assert no write occurs until explicit overwrite. Covers FR-013, FR-023, FR-026, SC-002, SC-005.
- [x] T028 [P] [US2] Add conflict-decision tests for Cancel and Overwrite, including failed write, stale older save completion, and edit-during-overwrite cases; baseline/revision/dirty/external state may advance only for the successful current operation. Covers FR-024, FR-025.

### Implementation for User Story 2

- [x] T029 [US2] Extend `openedDocumentWatchCoordinator.ts` + `$DOC_MANAGER` transition logic for dirty validated divergence: never replace EditorState, set external modified, keep dirty, and expose a stable non-modal state to UI. Covers FR-021, FR-022, FR-041.
- [x] T030 [US2] Insert mandatory validation into the existing `saveDocument(id)` flow in `$DOC_MANAGER` before any write to an existing bound path; keep the existing operation-generation/path-ownership safeguards and branch to normal-save / external-conflict / missing-save behavior. Covers FR-013, FR-023, FR-026.
- [x] T031 [US2] Implement the explicit external-conflict overwrite decision through the existing dialog/confirmation abstraction used by the current React app/close guards; expose only clear `Overwrite` and `Cancel` semantics for 005 and do not build diff/merge UI. Update `$COMMAND_REGISTRY` only if Save command plumbing requires it. Covers FR-023, FR-024, FR-042.
- [x] T032 [US2] Route Overwrite through the existing save writer in `$DOC_MANAGER`/`$FILE_SERVICE_TS` and wrap it with `internalFsOperationGuard.ts`; commit baseline/revision/dirty/external-state changes only after the current operation successfully writes and adopts the expected target. Covers FR-025, FR-035, FR-036.
- [x] T033 [US2] Ensure any existing or future Reload-from-Disk action checks `$DOC_SESSION.dirty` and requires explicit discard confirmation before applying validated disk content; if no general reload command exists in 004, add only a reusable guarded manager method/test contract and do not add a new UI feature solely for 005. Covers FR-027.

**Checkpoint**: Dirty user edits cannot be silently overwritten by a detected/missed external disk change.

---

## Phase 5: User Story 3 - Externally deleted file remains recoverable (Priority: P1)

**Goal**: External deletion keeps the document open and recoverable; Save recreates the original target when safe.

**Independent Test**: Delete an open file outside Sorakada, verify missing state with unchanged buffer, then Save and verify recreation; also cover missing parent and path reappearance.

### Tests for User Story 3

- [x] T034 [P] [US3] Add tests for clean and dirty external delete: same `documentId`, tab remains open, EditorState/content unchanged, dirty unchanged, external state becomes missing, and no 003 internal-Delete close behavior is invoked. Covers FR-028, FR-029, SC-003.
- [x] T035 [P] [US3] Add tests for Save while missing: both clean and dirty missing documents keep the canonical `file.save` command available; `saveDocument()` enters the missing branch before its clean-document no-op; recreate at the original path when the parent exists; do not recursively create missing parent directories; failed recreation leaves session/path/content recoverable. Covers FR-030–FR-032.
- [x] T036 [P] [US3] Add tests for delete→recreate at same path: clean missing auto-reloads reappeared file; dirty missing becomes external modified and preserves local buffer; rapid remove/create event order must not determine final semantics. Covers FR-033, FR-034.

### Implementation for User Story 3

- [x] T037 [US3] Add missing-state transition handling in `openedDocumentWatchCoordinator.ts` and `$DOC_MANAGER`: confirmed absence keeps the session/tab/path/content, preserves dirty, and sets missing; do not call the 003 internal Delete pathway. Covers FR-014, FR-028, FR-029.
- [x] T038 [US3] Add the missing-target branch to `saveDocument(id)` in `$DOC_MANAGER` before the current `!session.dirty` early return, so clean and dirty missing documents can both recreate. Preserve the existing `file.save` command availability, revalidate target/parent, reuse current path-ownership rules, then immediately confirm the target is still absent before the recreate write; if it reappeared, branch to clean-reappearance or dirty-conflict handling instead of overwriting it. Recreate only the target file through the existing writer and do not create missing ancestors. Covers FR-030, FR-031, FR-045.
- [x] T039 [US3] On successful missing-file recreation, reconcile pending internal watcher hints via `internalFsOperationGuard.ts` and commit the new disk revision/baseline, dirty=false, externalState=normal only for the current operation generation. Covers FR-032, FR-035, FR-036.
- [x] T040 [US3] Handle reappearance of a missing path in `diskValidation.ts` / `openedDocumentWatchCoordinator.ts`: clean session adopts/reloads; dirty session transitions to modified without reload. Covers FR-033, FR-034.

**Checkpoint**: External deletion never destroys an open document, and recovery through Save is deterministic.

---

## Phase 6: User Story 4 - Reliable fallback validation and internal-operation reconciliation (Priority: P2)

**Goal**: Realtime watcher irregularities and Sorakada-originated events do not corrupt final document/disk state.

**Independent Test**: Inject duplicate/missed/stale events and internal Save/Save As watcher hints; verify focus/activation/pre-save fallback converges correctly and own operations do not create false external conflicts.

### Tests for User Story 4

- [x] T041 [P] [US4] Add coordinator tests for duplicate/coalesced events, out-of-order remove/create hints, watch invalidation, and a missed event later discovered by tab activation/window focus; assert final state derives from validation rather than raw sequence. Covers FR-007, FR-011, FR-012, FR-038, SC-004, SC-005.
- [x] T042 [P] [US4] Add internal-operation integration tests around Save, Save As, existing Explorer Rename, and existing Explorer Delete when they affect watched open documents: watcher hints generated by the successful operation reconcile without a false external modified/missing transition; Rename moves interest to the new path, Delete closes/unsubscribes under existing 003 semantics, and a controlled external mismatch before guard settlement remains discoverable. Covers FR-035, FR-036, SC-006.
- [x] T043 [P] [US4] Add stale/race tests: close during validation, Save As or internal Rename rebinding during validation, old-path event after either rebinding path, older reload completion after a newer validation, initial-open/read→watch registration gap, Save As/Rename adoption→watch migration gap, missing-save target reappearing immediately before recreate, and unsubscribe cleanup; none may mutate a closed/rebound/currently newer session or silently overwrite a reappeared target. Covers FR-003, FR-004, FR-039, FR-044, FR-045, SC-007.

### Implementation for User Story 4

- [x] T044 [US4] Complete event coalescing/invalidation handling in `filesystemWatcher.ts` / `watchEventNormalizer.ts` so invalidation becomes a validation request rather than an assumption that detailed events are complete; 005 may revalidate affected opened interests but must not trigger Workspace rescan. Covers FR-011, FR-038, FR-040.
- [x] T045 [US4] Integrate `internalFsOperationGuard.ts` with existing Save As and Explorer Rename/Delete orchestration. Save As and successful `commitRenamedPath()` guard old/new relevant paths, migrate watch interest only after successful path adoption, perform post-subscription validation, and reconcile pending hints once while preserving duplicate-path ownership rejection. Successful internal Delete retains 003 close semantics and disposes watch interest without being surfaced as an external delete. Covers FR-004, FR-035, FR-036.
- [x] T046 [US4] Audit every async validation/reload callback in `openedDocumentWatchCoordinator.ts`, `diskValidation.ts`, and `$DOC_MANAGER` for `{documentId, expectedPathIdentity/bindingGeneration}` checks before mutation; centralize the check rather than duplicating ad-hoc stale guards. Covers FR-039.
- [x] T047 [US4] Verify watcher subscriptions are disposed on document close and application shutdown and that refcounted parent-directory watches are removed only when their final interested document unsubscribes. Covers FR-003, FR-005, SC-008.

**Checkpoint**: Watcher behavior is a resilient hint channel, not a second source of truth, and internal writes are reconciled safely.

---

## Phase 7: Minimal UI State and Cross-Feature Integration

**Purpose**: Surface 005 state without pre-empting 007 UI foundation work.

- [x] T048 Extend `$TAB_BAR` and the existing tab metadata projection from `$DOC_MANAGER` with a minimal non-modal visual state for externally `modified` and `missing`; preserve existing active/dirty behavior and use current React/CSS architecture (not Vue, no UI rewrite). Covers FR-041.
- [x] T049 [P] Add minimal styles in the existing `src/styles/` file(s) for the external-state indicator using existing CSS tokens; do not introduce a new theme or notification system. Covers FR-041.
- [x] T050 [P] The repository has no React component-test harness, so do not add jsdom or React Testing Library solely for 005. Extend `src/app/document/documentManager.test.ts` to verify the existing tab snapshot/projection exposes stable `modified`/`missing` state, repeated hints do not request repeated dialogs, and clean auto-reload requests no confirmation. Verify the actual TabBar rendering manually in T055. Covers FR-041, SC-001, SC-004.
- [x] T051 Verify `$APP_TSX`/Explorer integration has no subscription that mutates Workspace tree from 005 events; add a regression test in the existing Workspace/Explorer integration test area proving external opened-file changes do not add/remove/rename Explorer entries until 006. Covers FR-040, SC-009.

---

## Phase 8: Regression, Performance, and Scope Guard

**Purpose**: Validate the complete feature against prior contracts and 006 extension requirements.

- [x] T052 Run all four mandatory repository gates and fix only regressions caused by 005: `npm run typecheck`, `npm run test`, `npm run build`, and `cargo test` from `src-tauri/`. Specifically re-run 002 multi-document isolation/Save As races, synchronized TypeScript/Rust IPC wire-contract tests, and 003 internal Rename/Delete/path-migration tests. Do not report completion unless all four commands pass.
- [x] T053 Add/execute an integration scenario with several opened files sharing one directory plus several outside-Workspace files in unrelated directories; verify shared-directory subscriptions are reused, unrelated watches remain independent, and external changes route only to interested sessions. Covers FR-001, FR-005, FR-006, SC-008.
- [x] T054 Add/execute a deterministic performance smoke test with 50 unchanged bound documents: over a simulated/measured 60-second idle interval assert zero periodic full-content reads; on one window-focus trigger assert no more than one cheap inspection per document, zero full-content reads for unchanged revisions, and no synchronous wait on content reads in the focus handler. Use injected counters/deferred reads rather than subjective UI feel. Covers SC-008.
- [x] T055 Execute manual smoke scenarios: Notepad/another editor changes active clean file, changes dirty file, changes background tab, deletes/recreates file, Alt+Tab away/back, Save conflict Cancel/Overwrite, clean and dirty missing Save recreation, missing parent failure, outside-Workspace file, Save As migration, internal Explorer Rename migration, internal Delete, and visible TabBar modified/missing indicators. Record pass/fail evidence in the final implementation handoff under `005 Manual Verification`; if using a PR, copy the matrix into the PR description.
- [x] T056 Audit source imports and behavior for deferred-scope leakage: no recursive Workspace root watcher started by 005, no Explorer external synchronization, no external rename/move inference, no diff/merge/Git/index/recovery/autosave implementation, and no persistent file-identity database. Remove any accidental scope creep before completion.
- [x] T057 Review `filesystem_watcher.rs`, normalized event DTOs, `internalFsOperationGuard.ts`, and `openedDocumentWatchCoordinator.ts` specifically for 006 reuse: backend is consumer-agnostic, supports future recursive scope, represents invalidation, and does not import Explorer/Workspace domain. Covers FR-037, FR-038, FR-040.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 — Repository Mapping**: first; resolves real paths and prevents duplicate architecture.
- **Phase 2 — Foundation**: depends on Phase 1 and blocks all user stories.
- **Phase 3 — US1 clean reload**: depends on Phase 2.
- **Phase 4 — US2 dirty protection**: depends on Phase 2 and reuses the coordinator/session fields established in US1; implement after US1 in a single-agent workflow to minimize edits to `$DOC_MANAGER`.
- **Phase 5 — US3 missing/recovery**: depends on Phase 2 and the same state/coordinator foundation; implement after US2 in a single-agent workflow.
- **Phase 6 — US4 reliability**: depends on US1–US3 behaviors being present so fallback/internal-operation tests can exercise all transitions.
- **Phase 7 — UI integration**: depends on stable external-state/domain behavior; can partially run in parallel with late US4 work if files do not overlap.
- **Phase 8 — Regression/performance/scope audit**: final gate.

### User Story Dependencies

- **US1** establishes the session external-state plumbing and watcher coordinator and is the practical MVP slice.
- **US2** reuses US1 infrastructure but adds data-safety Save behavior; it is mandatory for shipping 005, not an optional enhancement.
- **US3** reuses the same validation/state machine and is also mandatory for shipping 005.
- **US4** hardens the delivery mechanism and internal-operation boundary; it is required before 005 is considered complete because 006 depends on these foundations.

### Parallel Opportunities

- T005/T007/T009 can proceed in parallel with other Phase 2 tasks after the relevant interfaces are established and if they do not edit the same Rust files.
- Validation tests T013 and guard tests T015 can run in parallel after their module APIs are sketched.
- Within US1, T016–T018 are parallel test-authoring opportunities.
- Within US2, T026–T028 are parallel test-authoring opportunities.
- Within US3, T034–T036 are parallel test-authoring opportunities.
- Within US4, T041–T043 are parallel test-authoring opportunities.
- T049/T050 can run in parallel once T048 defines the tab metadata/UI contract.

## Parallel Example: Foundational Layer

```text
Agent A: T004/T006 backend watcher lifecycle
Agent B: T008/T009 disk/path inspection tests
Agent C: T010/T011 frontend watcher adapter/coalescer
Agent D: T012/T013 disk validation module/tests
Agent E: T014/T015 internal operation guard/tests
```

Do not parallelize tasks that concurrently modify `$DOC_MANAGER` unless changes are coordinated; that file is a central consistency boundary.

## Implementation Strategy

### MVP Validation Slice

A technically useful first checkpoint is Phase 1 + Phase 2 + US1: a clean opened document outside or inside Workspace can be watched/revalidated and auto-reloaded safely. Do **not** ship 005 at that checkpoint because dirty conflict and external-delete protection are core safety requirements.

### Completion Order for a Single Coding Agent

1. Resolve paths and baseline tests (T001–T003).
2. Build watcher/validation/guard infrastructure and deterministic tests (T004–T015).
3. Implement clean reload (T016–T025).
4. Implement dirty save protection (T026–T033).
5. Implement missing/reappearance behavior (T034–T040).
6. Harden event/fallback/internal-operation races (T041–T047).
7. Add minimal React UI indication only after domain behavior is stable (T048–T051).
8. Run regression/performance/scope gates (T052–T057).

### Guardrails for the Implementation Agent

- Do not redesign existing document architecture.
- Do not rename/move existing modules as cleanup.
- Do not replace React UI with another framework; Sorakada uses React.
- Do not let watcher callbacks write directly into CodeMirror or session objects.
- Do not add recursive Workspace monitoring in 005.
- Do not change Explorer external-change behavior.
- Do not infer external rename/move.
- Do not add diff/merge UI.
- Do not add broad settings/theme/notification frameworks; 007 is the UI foundation milestone.
- Do not silently relax conflict protection to simplify tests.
- Preserve existing path ownership and operation-generation rules from 002/003/004.

## Requirement Coverage Index

- **Watch lifecycle/identity**: T004–T013, T022–T025, T043, T047, T053
- **Clean reload**: T016–T025
- **Dirty protection/save conflict**: T026–T033
- **External delete/missing/reappearance**: T034–T040
- **Internal operation suppression/reconciliation**: T014–T015, T032, T039, T042, T045
- **Watcher reliability/invalidation/stale async**: T004–T007, T011–T013, T041–T047
- **User feedback**: T031, T048–T050
- **003/006 scope compatibility**: T051, T052, T056, T057

---

## Implementation Notes (005 delivery)

### T003 — watcher dependency

- Added **`notify = "8.2.0"`** to `src-tauri/Cargo.toml` with a comment pinning it as the
  only watcher stack. Toolchain at implementation time: `rustc 1.94.0` / `cargo 1.94.0`.
- Lockfile impact: **additions only** — `notify 8.2.0`, `notify-types 2.1.0`, plus the
  platform backends `inotify`, `inotify-sys`, `kqueue`, `kqueue-sys`, `fsevent-sys`
  (and `filetime`). **No existing dependency was upgraded.**
- No second watcher stack, no polling loop, and no bespoke OS watcher was introduced.

### Resolved alias paths (T001)

No path drift was found; every alias in the task header still resolves exactly as written.
Usages of `read_text_file` / `write_text_file` / `inspect_file_path` / `diskRevision` /
`commitRenamedPath()` and the Save / Save As / Close / Rename / Delete flows were located
before any code changed. Baseline (T002): **372 frontend tests and 75 Rust tests, all green.**

### Documented implementation decisions (no design change, recorded for review)

1. **`commands/watcher.rs`** was added as the IPC adapter and registered from `lib.rs`
   (T006 says "in `$TAURI_LIB_RS` and the existing command registration structure"). The
   repository keeps every `#[tauri::command]` in `src-tauri/src/commands/`, and the plan
   allows adapting new files to the repository's existing naming convention, so the watcher
   commands follow `commands/file.rs` and `commands/workspace.rs` rather than living in
   `lib.rs`. The manager itself stays Tauri-free in `filesystem_watcher.rs` so 006 can reuse it.
2. **`inspect_document_path`** was added (T008) because `inspect_file_path` cannot separate
   "absent" from "exists but unreadable", which FR-014/FR-015 require. It is additive: the
   existing identity/`diskRevision`/`comparison_key` implementation is reused unchanged.
3. **`DiskValidationResult` gained a `stale` outcome** (T012) so a result that no longer
   describes the binding it was asked about is reported explicitly instead of being silently
   dropped; the four required outcomes (`unchanged` / `changed` / `missing` / `unverifiable`)
   are unchanged.
4. **The manager's `DocumentManagerDeps` gained required `diskValidator` and
   `internalFsOperations` collaborators.** FR-013 makes pre-save validation mandatory, so an
   omitted validator would silently drop a data-safety guarantee rather than fail loudly.
5. **`PathMutationRequest` gained a required `kind`** so the internal-operation guard knows
   which paths a reserved mutation is expected to add or remove; the three Explorer call
   sites (`create`, `rename`, `delete`) now declare it.
6. **A document whose adopted revision cannot be confirmed after a write degrades that
   revision to `null` ("unknown")** rather than keeping a known-stale one. Validation then
   escalates to a content read, which is what keeps Sorakada's own successful write from
   being reported as an external modification (SC-006).
7. **`EditorHandle` gained `reloadDocumentState`** (T021) because FR-019 requires the clamped
   primary head to be brought into view, which a state cannot do for itself, and because
   `createExternalReloadState` deliberately has no view access.
8. **`TabSnapshot` gained `externalState`** — the only projection change — so FR-041 can be
   satisfied non-modally without the UI deriving state from watcher events.

### T055 — manual smoke matrix

T055 requires an interactive desktop session (Notepad/another editor, Alt+Tab, the visible
TabBar). The implementation agent could not execute it, so it was left unchecked with the
automated coverage listed as a stand-in. A human operator has since **executed the full matrix
on a real desktop session and it passed** (evidence under `005 Manual Verification` at the end
of this file), after the post-acceptance fix recorded below.

---

## Phase 9: Convergence

Appended by `$speckit-converge` on 2026-09-19 after re-assessing the codebase against
`spec.md`, `plan.md`, the constitution (v1.0.0), and the 57 existing tasks. All four
repository gates were re-run and pass (`npm run typecheck`, `npm run test` — 548 tests /
19 files, `npm run build`, `cargo test` — 108 tests). Every FR-001–FR-045, SC-001–SC-009,
US1–US4 acceptance scenario, plan decision, and constitution principle was traced to
existing implementation and test evidence; the single residual item below is a
human-executed acceptance check that no code change can complete.

- [x] T058 Execute and record the interactive T055 acceptance matrix on a real desktop session: external edit of the active clean file, external edit of a dirty file, background-tab external edit, external delete and recreate, Alt+Tab away/back focus revalidation, Save conflict Cancel/Overwrite, clean and dirty missing Save recreation, missing-parent Save failure, outside-Workspace file, Save As watch migration, internal Explorer Rename migration, internal Explorer Delete, and the visible TabBar `modified`/`missing` indicators. Record pass/fail evidence under `005 Manual Verification` (Constitution: Development Workflow and Quality Gates — native dialogs, menus and other behavior not covered by automated tests MUST be validated against the acceptance matrix) (partial)
### Post-acceptance fix (recorded after T055 manual testing began)

The first manual acceptance run reported that a **clean** document did not follow an
external modification at all. Root cause and fixes:

1. **React Strict Mode disabled the whole consumer.** `src/main.tsx` renders inside
   `<StrictMode>`, so in the desktop dev shell React runs the effect, cleans it up and runs
   it again. The cleanup called `OpenedDocumentWatchCoordinator.dispose()`, which marked the
   instance permanently disposed, and the second `start()` returned immediately — so no
   subscription was ever established and no fallback validation ran either. `start()` is now
   restartable (it re-arms, rebuilds the coalescing normalizer, and re-registers every
   still-bound document), and the normalizer is created in `start()` rather than in the
   constructor. Pinned by two tests: "keeps watching after a Strict Mode unmount/remount" and
   "revalidates an already-bound document after a restart". (The automated suite could not
   have caught it before: nothing exercised `start → dispose → start`.)
2. **A failed subscription was never retried.** A path that was unwatchable at open time kept
   `handle === null` forever, leaving that one document permanently without realtime hints.
   The cheap triggers (tab activation, window focus, invalidation) now retry it. Pinned by
   "retries a subscription that could not be established (unwatchable path)".
3. **The OS half is now verified directly.** `filesystem_watcher.rs` gained the feature's only
   live-backend test: the real `notify` watcher on a real temp directory, a real external
   write, and a bounded wait for the normalized payload. It passes in ~0.1 s, which rules out
   the backend/routing/emission layer for this class of report. The write is retried until an
   event arrives, so the platform's arming gap cannot make the test flaky.

T055 and T058 are now closed: the GUI pass was repeated by a human after this fix and passed.
---

## 005 Manual Verification (executed)

**Result: PASS.** Executed by a human operator on a real desktop session (`npm run tauri dev`,
restarted after the post-acceptance fix above), against the T055 acceptance matrix. Native
dialogs, Alt+Tab focus, the real OS watcher and the visible TabBar cannot be exercised by the
automated suite, which is why this pass is the acceptance evidence for those paths.

| # | Scenario | Evidence |
|---|---|---|
| 1 | External edit of the **active clean** file (Notepad, no window switch) | PASS — content followed automatically, tab stayed clean, no dialog |
| 2 | External edit of a **background tab** | PASS — reloaded without activating the tab |
| 3 | External edit of a **dirty** file | PASS — buffer preserved, no auto-reload, `modified` indicator shown |
| 4 | Save conflict **Cancel** | PASS — neither buffer nor disk changed |
| 5 | Save conflict **Overwrite** | PASS — in-memory content written, indicator cleared, document clean |
| 6 | External **delete** (clean and dirty) | PASS — tab and complete content preserved, `missing` indicator, not closed |
| 7 | Save while **missing** (clean and dirty) | PASS — original path recreated from the in-memory content |
| 8 | Save with the **parent directory gone** | PASS — failed without creating ancestors, document stayed recoverable |
| 9 | Delete then **recreate** at the same path | PASS — clean adopted the new disk file; dirty became `modified` without reloading |
| 10 | **Alt+Tab away/back** focus revalidation | PASS — external change discovered on focus regain |
| 11 | **Tab activation** revalidation | PASS |
| 12 | **Outside-Workspace** file | PASS — identical behaviour to a Workspace-contained file |
| 13 | **Save As** watch migration | PASS — the new path kept being watched |
| 14 | Internal **Explorer Rename** migration | PASS — path migrated, watch followed, no false conflict |
| 15 | Internal **Explorer Delete** | PASS — 003 close semantics retained, not reported as an external delete |
| 16 | Visible TabBar **`modified` / `missing`** indicators | PASS — both visible alongside the dirty marker |
| 17 | No Explorer tree changes for external changes to unopened files | PASS — 006 scope respected |

The first manual run failed scenario 1 (no detection at all). That finding, its root cause and
the fix are recorded under *Post-acceptance fix* above; the full matrix was then re-executed and
passed.

Final gate state at close-out: `npm run typecheck` clean, `npm run test` — **551 tests / 19
files passed**, `npm run build` succeeded, `cargo test` — **109 tests passed**.

---

## Phase 10: Convergence

- [x] T059 **CRITICAL** Add an atomic no-replace recreation path for a missing document so a target that reappears after the final validation but before the write cannot be overwritten. Keep byte encoding/EOL work in `file_codec.rs`, expose and pin matching Rust/TypeScript IPC contracts, route only the missing-file recreate branch through create-if-absent semantics, and on an already-existing target return to clean-reappearance or dirty-conflict handling without changing disk content. Add a deterministic race test that recreates the target at the write boundary. per FR-045 and Constitution I (contradicts)
- [x] T060 **CRITICAL** Strengthen internal filesystem-operation settlement so Save/Overwrite/Recreate/Save As cannot declare watcher hints reconciled or advance the saved baseline merely because the target exists. Prove that the final supported disk text/format/revision matches the snapshot this operation wrote, and surface/revalidate every captured same-kind hint when that proof fails or a later external write wins. Preserve dirty/external conflict state on mismatch and add deterministic tests for an outside write landing between Sorakada's write, post-write inspection, baseline commit, and guard settlement. per FR-036 and Constitution I (contradicts)
- [x] T061 When a dirty document's disk revision changes, read the supported disk snapshot for comparison without adopting it. Compare both normalized text and supported format metadata with the document's saved baseline/format: an identical metadata-only touch must adopt only the fresh revision and remain dirty + external `normal`, while real text/format divergence must preserve the buffer and become `modified`. Cover watcher-hint and mandatory pre-save paths with regression tests. per spec Edge Cases (metadata-only touch), FR-021, and FR-022 (partial)
- [x] T062 Make `OpenedDocumentWatchCoordinator` lifecycle startup generation-safe. Capture a per-start epoch/token across asynchronous listener installation and subscription registration; `dispose()` must invalidate the epoch so an older unresolved `start()` can only release its newly obtained resources, never install listeners or manager subscriptions into a later run. Add a deferred-listen test for overlapping `start → dispose → start` that proves exactly one listener/subscription set remains and subsequent hints are processed once. per FR-003, FR-039, and plan: watcher lifecycle (partial)
- [x] T063 Surface a clean document's pre-save `unverifiable` validation through the existing deduplicated non-destructive error path instead of returning silent success. Keep the buffer, baseline, format, dirty flag, external state, and disk unchanged, and add tests for both a first Save-discovered failure and repeated identical failures. per FR-043 (partial)

### Phase 10 implementation notes (T059–T063)

All five convergence tasks are implemented. Everything below is a *hardening* change: the
visible normal-path behaviour of 005 is unchanged, and no scenario in the T055 matrix changes
its outcome.

**T059 — atomic no-replace recreation.** New IPC contract, pinned from both sides:
`create_text_file_if_absent` (same `WriteRequest` shape as `write_text_file`) backed by
`file_codec::create_file_if_absent`, which reuses the existing `encode()` and opens the target
with `write(true).create_new(true)`; a target that already exists is reported as the new
`already_exists` code and is never touched. Only the missing-file recreate branch uses it (via
the same per-destination write chain as a save); every other write keeps using
`write_text_file`. On the frontend, `FileService.createTextFileIfAbsent` is the new method (and
`already_exists` joins the `FileCommandCode` union), the recreate branch routes an
`already_exists` failure into `applyReappearance`, and the race is pinned by tests that make the
target appear at the create boundary (clean → adopts the winner; dirty → explicit
Cancel/Overwrite decision; Overwrite → plain write only after the decision).
Note (from the Rust implementation): on Windows a *directory* target fails with
`PermissionDenied` before the existence check can report `already_exists`, so that case is
`io_write` there; the guarantee that matters — nothing is replaced — holds either way.

**T060 — a write is only settled once the disk is proven to hold it.** `finishWrite` (shared by
Save, Overwrite, recreate and Save As) now reads the destination back and compares the
normalized text plus the two byte-relevant format fields (`bom`, `lineEnding`) against the
snapshot the operation wrote. Only a confirmed proof may (a) advance the adopted revision, (b)
return the document to external `normal`, and (c) settle the internal-operation guard as
reconciled. A diverged or unverifiable proof still advances the baseline — the write did happen
— but the adopted revision is degraded to *unknown* (so the next validation reads content
again), a divergence is recorded as `modified` rather than papered over, an unverifiable
read-back preserves whatever external state the document already had, and every captured hint is
surfaced for revalidation instead of being declared internal. Cost: one extra read per completed
write. That is deliberate — the alternative is claiming reconciliation from mere existence,
which is exactly the hole FR-036 forbids — and it does not affect the idle/focus budget of
SC-008 (no periodic reads).

**T061 — a moved revision is not a moved content.** `DiskValidationRequest.wantsContent` was
removed: "may I adopt disk content?" is a document-state decision (dirty plus an explicit
discard), not a validation-tier decision, so a differing revision now always reads the supported
snapshot and hands it to the caller as comparison material. The manager compares text *and* the
byte-relevant format against its own baseline, so a metadata-only touch adopts only the fresh
revision and stays dirty + external `normal` (and a Save proceeds without any prompt), while a
real text or format divergence preserves the buffer and becomes `modified`. A matching revision
still short-circuits with zero reads for every trigger, including on a dirty document.

**T062 — generation-safe startup.** The coordinator keeps a monotonic `startEpoch`: `start()`
captures it, `dispose()` invalidates it, every post-await checkpoint in the start body verifies
it, each `Interest` carries the epoch that created it, and `establishSubscription` refuses to
adopt a handle from a superseded run (releasing it instead). A superseded run therefore installs
no listener and no manager subscriptions. The four new tests are mutation-checked: with only the
epoch checks removed, three of them fail (leaked listener, duplicated manager subscriptions,
missing stale unlisten).

**T063 — a clean document's pre-save failure is no longer silent.** A pre-save `unverifiable`
result now goes through the existing deduplicated non-destructive error path for a clean
document too, while the save itself still reports success (nothing needed writing) and the
buffer, baseline, format, dirty flag, external state and disk are all left untouched. A dirty
document keeps the stronger behaviour (reported and reported-as-failed). Repeated identical
failures show one dialog; a different message is shown again.

**One manual-verification delta worth re-checking.** The T055/T058 acceptance pass was executed
on the revision *before* Phase 10. Nothing in Phase 10 changes a scenario in that matrix, but two
previously-invisible paths are now user-visible and are worth a spot check: Ctrl+S on a *clean*
file that cannot be verified (for example a file locked by another program) now shows the
non-destructive error once, and a save whose read-back cannot be completed no longer returns the
document to a clean, conflict-free `normal` state. Both are error paths, and both keep the buffer
intact.

Final gate state: `npm run typecheck` clean, `npm run test` — **571 tests / 19 files passed**,
`npm run build` succeeded, `cargo test` — **118 tests passed**.

---

## Phase 11: Convergence

- [x] T064 Close the remaining post-proof reconciliation race: a same-path external `created`/`changed` hint captured after write read-back has succeeded but before the internal-operation guard settles MUST NOT be discarded using that earlier proof alone. Revalidate the final disk state or surface the captured hint for validation without creating a false conflict for Sorakada's own write, and add a deterministic regression test that lands an outside write and its hint specifically between read-back proof, baseline commit, and guard settlement. per FR-036, US3/AC4, and T060 (partial)

### Phase 11 implementation note (T064)

**The race.** `finishWrite` committed the baseline and settled the internal-operation guard
using a proof taken *before* both. A same-path `created`/`changed` notification that arrived
after that proof but before the settlement was still held by the guard, and a `succeeded: true`
settlement reconciled it as "our own write" — discarding a notification that may have described
a genuine outside write. The document then looked clean and conflict-free until some later
trigger noticed the moved revision.

**The ordering fact that closes it.** A proof only explains the notifications that arrived before
it. So the manager now re-proves the disk until a proof completes during which no notification
for its own key arrives; at that point every held notification is explained by the write itself,
and the *disk evidence* — not a count or a timer — is what justifies calling them internal. The
loop is bounded by `MAX_SETTLEMENT_RECHECKS` (3 re-proofs); if notifications keep arriving faster
than the disk can be re-read, the operation reconciles nothing and hands the held hints to the
consumer for validation instead of guessing. In the ordinary case (one early notification, or
none) the loop breaks after the first proof, so the added cost is zero.

**The query this needed.** `InternalFsOperationGuard.capturedHintCountFor(comparisonKey)` — a
monotonic per-key count of hints ever held. The held set cannot answer the ordering question,
because held hints are only released when the operation settles. This is explicitly *not*
count-based suppression: the number only ever triggers another read-back of the disk, and nothing
is declared internal because "the count was expected". `settle` still decides key ownership and
surfacing exactly as before, and a `diverged` proof still records `modified` while an
unattributable one preserves the document's existing external state (no false conflict for
Sorakada's own write).

**Mutation-checked tests** (3 new, in `documentManager.test.ts` → `settlement after the write
proof`): with the re-proof loop disabled, two of them fail; with `unattribute` forced false, the
third fails. They land an outside write *and* its hint specifically between the read-back proof
and the guard settlement (via a read hook on the first and second proofs), pin the Save As route
through the same code, and prove the burst case surfaces hints without inventing a conflict.

Final gate state: `npm run typecheck` clean, `npm run test` — **574 tests / 19 files passed**,
`npm run build` succeeded, `cargo test` — **118 tests passed**.