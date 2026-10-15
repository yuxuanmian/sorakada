# Tasks: Workspace and Explorer

**Input**: `spec.md`, `plan.md`, `research.md`, `data-model.md`, `contracts/`, `quickstart.md`  
**Base**: `feature-core` @ `95e6d2d130dedbb5a925a25c88017191101f193a`

Tasks are ordered to put 002 consistency repairs and shared command/path infrastructure ahead of Workspace mutations. Tests are included because 003 changes lifecycle/path-safety contracts and the repository requires both Vitest and Rust tests to remain green.

## Phase 1: Setup

**Purpose**: Put the feature artifacts and minimal module/dependency skeleton in place.

- [X] T001 Add the 003 design artifacts under `specs/003-workspace-explorer/spec.md`, `specs/003-workspace-explorer/plan.md`, `specs/003-workspace-explorer/tasks.md`, `specs/003-workspace-explorer/research.md`, `specs/003-workspace-explorer/data-model.md`, `specs/003-workspace-explorer/contracts/`, and `specs/003-workspace-explorer/quickstart.md`
- [X] T002 Add the Rust OS-trash dependency without enabling permanent-delete fallback in `src-tauri/Cargo.toml`
- [X] T003 [P] Create Workspace/Explorer/Shell module entry files described by the plan under `src/app/workspace/`, `src/app/explorer/`, `src/app/shell/`, `src/services/workspaceFileService.ts`, and `src/services/workspaceDialogs.ts`
- [X] T004 [P] Create `src-tauri/src/commands/workspace.rs` and `src-tauri/src/workspace_fs.rs` and export the module from `src-tauri/src/commands/mod.rs` without registering nonexistent command placeholders in `src-tauri/src/lib.rs`

**Checkpoint**: Feature structure exists; no behavior is changed yet.

---

## Phase 2: Foundational - 002 Safety and Shared Infrastructure

**Purpose**: Repair known 002 races and add the shared availability/path primitives that all 003 stories rely on.

**⚠️ CRITICAL**: Complete this phase before implementing Explorer Rename/Delete.

- [X] T005 [P] Add command-registry tests for optional `isEnabled`, disabled execution, unknown-command behavior, and live predicate evaluation in `src/app/commands/commandRegistry.test.ts` (FR-019–FR-022)
- [X] T006 Implement `CommandRegistration`, `CommandRegistry.isEnabled()`, and disabled-command execution guarding in `src/app/commands/commandRegistry.ts` (FR-019–FR-022)
- [X] T007 [P] Add regression tests for Open-vs-Save-As destination races and Save-As adoption failure baseline handling in `src/app/document/documentManager.test.ts` (FR-099, FR-100, FR-102)
- [X] T008 Refactor destination reservations/ownership in `src/app/document/documentManager.ts` so pending Open and Save As operations see compatible claims, stale operations cannot release newer claims, and failed Save-As adoption does not advance `savedBaseline` (FR-099, FR-100, FR-102)
- [X] T009 [P] Add regression tests where edits occur during a close-triggered Save and an exit-triggered Save in `src/app/document/documentManager.test.ts` and `src/app/window/windowLifecycle.test.ts` (FR-101)
- [X] T010 Update `closeDocument()` and `prepareCloseAll()` in `src/app/document/documentManager.ts` to re-check the live session after Save and repeat/continue the dirty guard instead of discarding newer edits (FR-101)
- [X] T011 Extend native menu installation to retain command menu items and expose a `syncAvailability()` path driven by `CommandRegistry.isEnabled()` in `src/app/menu/appMenu.ts` (FR-020)
- [X] T012 [P] Define typed Workspace filesystem DTOs/service methods matching `contracts/workspace-ipc.md` in `src/services/workspaceFileService.ts`
- [X] T013 [P] Extend Rust file/path error codes and reusable identity helpers needed by Workspace operations in `src-tauri/src/file_identity.rs`, `src-tauri/src/file_codec.rs`, and `src-tauri/src/commands/workspace.rs`

**Checkpoint**: Existing document lifecycle is safe enough for path mutations; commands have one availability source.

---

## Phase 3: User Story 4 - Work with Zero Open Documents (Priority: P1)

**Goal**: Make zero documents a valid steady state and expose explicit Empty State/New behavior.

**Independent Test**: Launch with no target, create a document, close the final Tab, and verify zero Tabs/Empty State without automatic Untitled replacement.

- [X] T014 [P] [US4] Add zero-document lifecycle tests covering bare construction, nullable active id, final-tab close, next explicit Untitled numbering, and no fake session in `src/app/document/documentManager.test.ts` (FR-012–FR-017, SR-001, SR-002)
- [X] T015 [US4] Change `DocumentManager` construction, active-session access, snapshots, activation/removal logic, and final-tab behavior for `DocumentId | null` in `src/app/document/documentManager.ts` and `src/app/document/documentSession.ts` (FR-012–FR-017)
- [X] T016 [P] [US4] Add optional-active-session window-title tests, including the zero-document title `Sorakada`, in `src/app/window/windowLifecycle.test.ts` (FR-015, FR-016)
- [X] T017 [US4] Update window title synchronization to handle no active document in `src/app/window/windowLifecycle.ts` (FR-015, FR-016)
- [X] T018 [US4] Make document/editor commands register `isEnabled` predicates and safely handle no active session in `src/app/App.tsx` (FR-019–FR-023)
- [X] T019 [P] [US4] Add the zero-document `EmptyState` UI for no-Workspace and Workspace-present variants in `src/app/shell/EmptyState.tsx` and `src/styles/shell.css` (FR-016)
- [X] T020 [US4] Refactor shared editor mounting so CodeMirror mounts on zero->one documents, stays mounted across Tab switches, and detaches on one->zero in `src/editor/Editor.tsx` and `src/app/App.tsx` (FR-012, FR-016)
- [X] T021 [US4] Split TabBar into a scrolling document-tab area plus fixed New button and wire the button to `file.new`/`createUntitled()` in `src/app/tabs/TabBar.tsx` and `src/styles/tabs.css` (FR-017, FR-018)
- [X] T022 [US4] Update native menu availability synchronization after document snapshot changes in `src/app/App.tsx` and `src/app/menu/appMenu.ts` (FR-020, FR-021)

**Checkpoint**: Sorakada can remain open with zero documents; New is always explicit.

---

## Phase 4: User Story 1 - Open and Manage a Workspace (Priority: P1)

**Goal**: Open, replace, no-op, and close one WorkContext without changing documents.

**Independent Test**: Open Workspace A, replace with B, fail an attempted C, reopen equivalent B, then close Workspace while Tabs remain untouched.

- [X] T023 [P] [US1] Define `WorkContext`, ids, snapshot types, and display-name derivation in `src/app/workspace/workContext.ts` (FR-001–FR-011)
- [X] T024 [P] [US1] Add Rust one-level directory-read contract tests for directory identity, direct children only, and root read errors in `src-tauri/src/commands/workspace.rs` and `src-tauri/src/workspace_fs.rs` (FR-002, FR-006)
- [X] T025 [US1] Implement one-level `read_workspace_directory` and root identity resolution in `src-tauri/src/workspace_fs.rs`, `src-tauri/src/commands/workspace.rs`, and `src-tauri/src/lib.rs` (FR-002, FR-006)
- [X] T026 [P] [US1] Add frontend IPC adapter tests for `readWorkspaceDirectory()` in `src/services/workspaceFileService.test.ts` and implement the adapter in `src/services/workspaceFileService.ts`
- [X] T027 [P] [US1] Add WorkContextManager tests for atomic open, same-root no-op, failed candidate preservation, close, and overlapping last-intent-wins requests in `src/app/workspace/workContextManager.test.ts` (FR-001–FR-008)
- [X] T028 [US1] Implement `WorkContextManager` with generation-guarded atomic candidate preparation/commit in `src/app/workspace/workContextManager.ts` (FR-001–FR-008)
- [X] T029 [P] [US1] Implement native folder picker and Workspace-level error reporting in `src/services/workspaceDialogs.ts` (FR-002)
- [X] T030 [US1] Add `workspace.openFolder` and `workspace.closeFolder` command ids/handlers/availability in `src/app/commands/commandIds.ts` and `src/app/App.tsx` (FR-002, FR-008, FR-024)
- [X] T031 [US1] Add Open Folder/Close Folder to the native File menu and synchronize Close Folder availability in `src/app/menu/appMenu.ts` (FR-024)
- [X] T032 [US1] Introduce the minimal Header + generic Sidebar + EditorArea composition and wire WorkContext snapshots without changing existing `DocumentSession`s in `src/app/App.tsx`, `src/app/shell/AppShell.tsx`, and `src/app/shell/Sidebar.tsx` (FR-003, FR-004, FR-008–FR-011, FR-090, FR-091)

**Checkpoint**: Workspace identity/lifecycle works independently of Tabs.

---

## Phase 5: User Story 2 - Browse Workspace Files Lazily (Priority: P1)

**Goal**: Render a single-root lazy Explorer whose cost follows loaded directories, not total project size.

**Independent Test**: Open a frontend project containing `node_modules`, expand only `src`, collapse/re-expand it from cache, and switch Workspace during an in-flight load without stale Tree mutation.

- [X] T033 [P] [US2] Add Rust directory-entry tests for file/directory/other metadata, symlink/junction flagging, and non-recursive reads in `src-tauri/src/workspace_fs.rs` (FR-025–FR-034)
- [X] T034 [US2] Complete directory entry metadata and resolved canonical-directory results in `src-tauri/src/workspace_fs.rs` and `src-tauri/src/commands/workspace.rs` (FR-026, FR-031–FR-034)
- [X] T035 [P] [US2] Define Explorer node/load/selection/inline-edit state types and stable sorting helper in `src/app/explorer/explorerModel.ts` (FR-025–FR-033)
- [X] T036 [P] [US2] Add Explorer controller tests for first-expand load, collapse-during-load, loaded-cache reuse, localized errors, stale WorkContext generation rejection, and directory-first case-insensitive sorting in `src/app/explorer/explorerController.test.ts` (FR-026–FR-031)
- [X] T037 [US2] Implement lazy directory loading/cache/error/generation behavior in `src/app/explorer/explorerController.ts` (FR-026–FR-030)
- [X] T038 [P] [US2] Add ancestor-cycle tests using repeated canonical directory identities in `src/app/explorer/explorerController.test.ts` (FR-034)
- [X] T039 [US2] Implement symlink/junction ancestor-cycle stopping without global graph suppression in `src/app/explorer/explorerController.ts` (FR-034)
- [X] T040 [US2] Build single-root tree rendering, file selection, directory selection/toggle, chevron toggle, loading/error rows, ellipsis, and full-path tooltips in `src/app/explorer/ExplorerTree.tsx` and `src/styles/explorer.css` (FR-025, FR-027, FR-029, FR-033, FR-035, FR-037)
- [X] T041 [US2] Build the Explorer container for active/no-Workspace states and connect it to WorkContext/Explorer controller state in `src/app/explorer/Explorer.tsx` and `src/app/App.tsx` (FR-025)

**Checkpoint**: Explorer can browse very large projects without recursive scanning.

---

## Phase 6: User Story 3 - Open Documents from the Explorer (Priority: P1)

**Goal**: Open/activate files through existing document identity while keeping Tree and Tabs independent.

**Independent Test**: Open one Workspace file through Explorer, File Open, and drag/drop and verify exactly one session plus no automatic Tree following.

- [X] T042 [P] [US3] Add Rust Workspace-relation tests for inside/outside, relative path, equivalent spelling, case behavior, sibling-prefix rejection, and link canonicalization in `src-tauri/src/file_identity.rs` and `src-tauri/src/commands/workspace.rs` (FR-041–FR-043)
- [X] T043 [US3] Implement `resolve_workspace_relation` using shared canonical/component-aware identity semantics in `src-tauri/src/file_identity.rs`, `src-tauri/src/commands/workspace.rs`, and `src-tauri/src/lib.rs` (FR-041–FR-043)
- [X] T044 [P] [US3] Add frontend relation-adapter tests and `WorkspaceRelation` mapping in `src/services/workspaceFileService.test.ts`, `src/services/workspaceFileService.ts`, and `src/app/workspace/workContext.ts` (FR-041–FR-043)
- [X] T045 [US3] Wire Explorer file double-click to `DocumentManager.openPath()` while leaving single-click selection-only behavior in `src/app/explorer/ExplorerTree.tsx` and `src/app/explorer/Explorer.tsx` (FR-035, FR-036, FR-038–FR-040)
- [X] T046 [P] [US3] Extend drag/drop tests for mixed file/directory batches and current-Workspace inside/outside files without Tree side effects in `src/app/dragdrop/fileDropController.test.ts` (FR-044–FR-048)
- [X] T047 [US3] Keep dropped directories ignored and route all dropped files through the existing `openPath()` pipeline without Explorer selection/expansion coupling in `src/app/dragdrop/fileDropController.ts` and `src/app/App.tsx` (FR-044–FR-048)

**Checkpoint**: All supported file-open entry points converge on one canonical document session.

---

## Phase 7: User Story 5 - Create Files and Directories from Explorer (Priority: P2)

**Goal**: Create disk files/folders at a target derived from persistent Tree selection, while File > New stays Untitled-only.

**Independent Test**: Create under selected directory, beside selected file, and at root; cancel/conflict creation; verify new file opens and new folder does not.

- [X] T048 [P] [US5] Add FileOperationContext target-derivation tests for no Workspace, root/no selection, selected directory, and selected file in `src/app/explorer/explorerActions.test.ts` (FR-049–FR-053, FR-075)
- [X] T049 [US5] Implement shared `FileOperationContext` derivation and New File/New Folder availability helpers in `src/app/explorer/explorerActions.ts` (FR-049–FR-053, FR-075, FR-080)
- [X] T050 [P] [US5] Add Rust create-file/create-directory tests for single-component validation, existing-target conflict, empty-file creation, and error shape in `src-tauri/src/workspace_fs.rs` and `src-tauri/src/commands/workspace.rs` (FR-054–FR-057)
- [X] T051 [US5] Implement `create_workspace_entry` without overwrite in `src-tauri/src/workspace_fs.rs`, `src-tauri/src/commands/workspace.rs`, and `src-tauri/src/lib.rs` (FR-054–FR-057)
- [X] T052 [P] [US5] Add frontend create IPC tests in `src/services/workspaceFileService.test.ts` and implement `createWorkspaceEntry()` in `src/services/workspaceFileService.ts`
- [X] T053 [US5] Add `explorer.newFile`/`explorer.newFolder` command ids, handlers, and Workspace-based availability in `src/app/commands/commandIds.ts` and `src/app/App.tsx` (FR-049–FR-057, FR-080)
- [X] T054 [US5] Implement single-active inline create editor with Enter commit/Escape cancel/error retention in `src/app/explorer/ExplorerTree.tsx`, `src/app/explorer/explorerController.ts`, and `src/styles/explorer.css` (FR-054, FR-057)
- [X] T055 [US5] On successful file creation, select the node and call `DocumentManager.openPath()`; on folder creation, select only the directory in `src/app/explorer/explorerController.ts` and `src/app/explorer/explorerActions.ts` (FR-055, FR-056)

**Checkpoint**: Workspace creation is usable and remains distinct from Untitled New.

---

## Phase 8: User Story 6 - Rename Workspace Entries Safely (Priority: P2)

**Goal**: Rename filesystem entries disk-first and preserve/update affected open document sessions safely.

**Independent Test**: Rename a dirty open file and a directory containing multiple open files; verify identities/editor state are preserved and failed/conflicting renames commit nothing.

- [X] T056 [P] [US6] Add Rust rename tests for single-component names, no-overwrite conflict, file/directory rename, and returned new identity in `src-tauri/src/workspace_fs.rs` and `src-tauri/src/commands/workspace.rs` (FR-058–FR-064, FR-098)
- [X] T057 [US6] Implement `rename_workspace_entry` disk-first in `src-tauri/src/workspace_fs.rs`, `src-tauri/src/commands/workspace.rs`, and `src-tauri/src/lib.rs` (FR-060, FR-064, FR-098)
- [X] T058 [P] [US6] Add frontend rename IPC tests in `src/services/workspaceFileService.test.ts` and implement `renameWorkspaceEntry()` in `src/services/workspaceFileService.ts`
- [X] T059 [P] [US6] Add DocumentManager tests for same-document file path adoption, directory descendant path updates, dirty/history preservation, ownership conflicts, pending Open/Save-As coordination, and failed disk-operation no-commit in `src/app/document/documentManager.test.ts` (FR-061–FR-064, FR-099, FR-100, FR-103)
- [X] T060 [US6] Add explicit DocumentManager path-mutation coordination/commit APIs for successful file and directory renames without replacing document ids/editor states in `src/app/document/documentManager.ts` (FR-061–FR-064, FR-099, FR-100, FR-103)
- [X] T061 [P] [US6] Add Explorer rename-orchestration tests for target derivation, destination conflict, in-flight document operation waiting, and stale WorkContext result rejection in `src/app/explorer/explorerActions.test.ts` (FR-058–FR-064, FR-098, FR-103)
- [X] T062 [US6] Implement rename orchestration that claims/validates target, waits relevant path operations, performs disk rename, commits DocumentManager paths, then reconciles Tree selection in `src/app/explorer/explorerActions.ts` and `src/app/explorer/explorerController.ts` (FR-058–FR-064, FR-098–FR-103)
- [X] T063 [US6] Reuse the inline Tree editor for Rename with Enter/Escape/error behavior in `src/app/explorer/ExplorerTree.tsx` and `src/styles/explorer.css` (FR-059, FR-064)
- [X] T064 [US6] Add `explorer.rename` command id/handler/availability for selected non-root entries in `src/app/commands/commandIds.ts` and `src/app/App.tsx` (FR-058, FR-080)

**Checkpoint**: Rename preserves document state and cannot create duplicate canonical ownership.

---

## Phase 9: User Story 7 - Delete Workspace Entries Safely (Priority: P2)

**Goal**: Move entries to OS trash only after correct confirmation and remove affected sessions only after trash succeeds.

**Independent Test**: Delete unopened/open clean/dirty files and a directory containing open documents; verify explicit dirty warning, cancel safety, OS trash recovery, and no second Save prompt.

- [X] T065 [P] [US7] Add Rust trash command tests/error-mapping coverage that verifies failure is surfaced and no permanent-delete fallback is called in `src-tauri/src/workspace_fs.rs` and `src-tauri/src/commands/workspace.rs` (FR-065–FR-074)
- [X] T066 [US7] Implement `trash_workspace_entry` with the OS trash crate and no permanent fallback in `src-tauri/src/workspace_fs.rs`, `src-tauri/src/commands/workspace.rs`, and `src-tauri/src/lib.rs` (FR-066, FR-067, FR-073)
- [X] T067 [P] [US7] Add frontend trash IPC tests in `src/services/workspaceFileService.test.ts` and implement `trashWorkspaceEntry()` in `src/services/workspaceFileService.ts`
- [X] T068 [P] [US7] Add delete-confirmation mapping tests for normal and dirty-discard warnings in `src/services/workspaceDialogs.test.ts` and implement dialogs in `src/services/workspaceDialogs.ts` (FR-068–FR-070)
- [X] T069 [P] [US7] Add DocumentManager tests for finding sessions under a canonical path and removing confirmed-deleted sessions without ordinary close/save prompts in `src/app/document/documentManager.test.ts` (FR-071, FR-072, FR-074)
- [X] T070 [US7] Implement affected-session lookup and no-second-prompt removal APIs in `src/app/document/documentManager.ts` (FR-071, FR-072, FR-074)
- [X] T071 [P] [US7] Add Explorer delete-orchestration tests for clean/dirty targets, dirty state changing while confirmation is open, cancel, trash failure, directory descendants, pending save/path operation coordination, and stale context in `src/app/explorer/explorerActions.test.ts` (FR-068–FR-073, FR-098, FR-103)
- [X] T072 [US7] Implement delete orchestration with affected-session revalidation, dirty-warning loop, disk-trash-first commit, no-second-prompt session removal, and Tree reconciliation in `src/app/explorer/explorerActions.ts` and `src/app/explorer/explorerController.ts` (FR-068–FR-074, FR-098, FR-103)
- [X] T073 [US7] Add `explorer.delete` command id/handler/availability for selected non-root entries in `src/app/commands/commandIds.ts` and `src/app/App.tsx` (FR-065, FR-080)

**Checkpoint**: Delete is recoverable, data-safe, and never silently permanent.

---

## Phase 10: User Story 8 - Explorer Actions and Context Menus (Priority: P2)

**Goal**: Expose the same operation targeting/availability through right-click, header controls, and Explorer-scoped keys.

**Independent Test**: Right-click different nodes/blank space, use header actions, press F2/Delete with Explorer/editor focus, and verify every action targets the expected entry/root.

- [X] T074 [P] [US8] Add right-click target and blank-space root-context tests in `src/app/explorer/explorerActions.test.ts` (FR-075–FR-081)
- [X] T075 [US8] Implement functional custom Explorer context menu with node-first selection, root blank-space context, separators, outside-click close, and Escape close in `src/app/explorer/ExplorerContextMenu.tsx` and `src/styles/explorer.css` (FR-076–FR-081)
- [X] T076 [US8] Add Explorer header New File/New Folder controls wired through command ids and shared availability in `src/app/explorer/Explorer.tsx` (FR-078, FR-080)
- [X] T077 [P] [US8] Extend command/keymap tests to prove plain F2/Delete are not global editor shortcuts in `src/app/commands/ideaKeymap.test.ts` and `src/app/commands/commandRegistry.test.ts` (FR-079, FR-080)
- [X] T078 [US8] Implement Explorer-local F2/Delete key handling that dispatches shared commands only while Explorer owns keyboard focus in `src/app/explorer/Explorer.tsx` (FR-079, FR-080)

**Checkpoint**: Explorer actions behave consistently regardless of surface without swallowing editor Delete.

---

## Phase 11: User Story 9 - Refresh Loaded Workspace State (Priority: P3)

**Goal**: Manually reconcile already-loaded Tree state with external filesystem changes without a watcher or recursive preload.

**Independent Test**: Change loaded/unloaded directories externally, Refresh, and verify only loaded nodes reread while expansion/valid selection remain.

- [X] T079 [P] [US9] Add Explorer Refresh tests for rereading every loaded node, leaving never-loaded descendants untouched, preserving surviving expansion/selection, clearing missing selection, cancelling inline edit, and stale refresh generation rejection in `src/app/explorer/explorerController.test.ts` (FR-082–FR-089)
- [X] T080 [US9] Implement loaded-node Refresh reconciliation and inline-edit cancellation in `src/app/explorer/explorerController.ts` (FR-082–FR-089)
- [X] T081 [P] [US9] Add root-unavailable/retry tests to `src/app/workspace/workContextManager.test.ts` and `src/app/explorer/explorerController.test.ts` (FR-088)
- [X] T082 [US9] Preserve WorkContext while exposing root unavailable/error state and retry through Refresh in `src/app/workspace/workContextManager.ts`, `src/app/explorer/explorerController.ts`, and `src/app/explorer/Explorer.tsx` (FR-088)
- [X] T083 [US9] Add `explorer.refresh` command id/handler/availability, test root/directory context availability in `src/app/explorer/explorerActions.test.ts`, and connect the Explorer header, root-context, and directory-context Refresh actions to the same loaded-tree operation in `src/app/commands/commandIds.ts`, `src/app/App.tsx`, `src/app/explorer/Explorer.tsx`, and `src/app/explorer/ExplorerContextMenu.tsx` (FR-080, FR-082, FR-083)

**Checkpoint**: External changes converge manually without watcher or recursive scanning.

---

## Phase 12: User Story 10 - Stable Application Shell (Priority: P3)

**Goal**: Establish Sidebar/Editor composition, show/hide/resize behavior, shared icons, and stable Tab/Editor layout.

**Independent Test**: Toggle and resize Sidebar with zero/many Tabs; verify state is retained and Tab `+` stays fixed during overflow.

- [X] T084 [P] [US10] Add transient `sidebarVisible`/`sidebarWidth` layout state and show/hide plumbing to the existing shell in `src/app/shell/AppShell.tsx` and `src/app/shell/Sidebar.tsx` (FR-090–FR-094)
- [X] T085 [P] [US10] Add centralized `AppIcon` names needed by Explorer/header/context menu in `src/app/shell/AppIcon.tsx` (FR-096)
- [X] T086 [US10] Finalize shell composition so Sidebar accepts generic content and EditorArea keeps TabBar plus EditorHost/EmptyState stable without making Sidebar identity Explorer-specific in `src/app/App.tsx` and `src/app/shell/AppShell.tsx` (FR-090, FR-091)
- [X] T087 [US10] Add `view.toggleExplorer` command and native View > Explorer menu item in `src/app/commands/commandIds.ts`, `src/app/App.tsx`, and `src/app/menu/appMenu.ts` (FR-092)
- [X] T088 [US10] Implement Sidebar drag resize with reasonable process-local bounds and no persistence in `src/app/shell/Sidebar.tsx` and `src/styles/shell.css` (FR-093, FR-094)
- [X] T089 [US10] Consolidate new shell/Explorer colors, spacing, borders, hover/active states, and sizing into shared CSS tokens in `src/styles/global.css`, `src/styles/shell.css`, `src/styles/explorer.css`, and `src/styles/tabs.css` without adding a StatusBar placeholder (FR-095–FR-097)

**Checkpoint**: 003 shell is stable enough for later Sidebar views without implementing a panel framework.

---

## Phase 13: Polish, Cross-Cutting Validation, and Performance

**Purpose**: Verify the complete 003 feature and close traceability/performance gaps without expanding scope.

- [X] T090 [P] Add cross-story command-availability, WorkContext/document-independence, and stale path-operation regression cases to `src/app/commands/commandRegistry.test.ts`, `src/app/workspace/workContextManager.test.ts`, `src/app/explorer/explorerActions.test.ts`, and `src/app/document/documentManager.test.ts`
- [X] T091 [P] Update `src/app/dragdrop/fileDropController.test.ts`, `src/app/window/windowLifecycle.test.ts`, and existing 002 tests for all intentional 003 superseded behaviors while preserving unaffected 002 regressions
- [X] T092 Verify no Workspace-open/Refresh code recursively walks unopened descendants and document the code-path evidence in `specs/003-workspace-explorer/quickstart.md` (SC-001–SC-003)
- [X] T093 Run the disposable real-frontend-project `node_modules` scenarios Q3/Q4/Q8 from `specs/003-workspace-explorer/quickstart.md`; record the SC-002 root-entry/file-count fixture, three root-read-to-selection timings, and directory-read evidence, plus any virtualization evidence without adding filtering/indexing scope (SC-001, SC-002, SC-004, SC-012, SC-014)
- [X] T094 Run the destructive scratch-Workspace New/Rename/Delete/trash scenarios Q5-Q7 and record pass/fail notes in `specs/003-workspace-explorer/quickstart.md` (SC-007–SC-010, SC-014)
- [X] T095 Run stale Workspace/open/load and symlink/junction cycle scenarios Q9-Q10 and record pass/fail notes in `specs/003-workspace-explorer/quickstart.md` (SC-011, SC-013)
- [X] T096 Run shell/zero-document scenarios Q1/Q2/Q11 and record pass/fail notes in `specs/003-workspace-explorer/quickstart.md` (SC-005, SC-006)
- [X] T097 Run `npm run typecheck`, `npm run test`, and `npm run build` from repository root and fix only 003-related regressions in affected `src/` files
- [X] T098 Run `cargo test` in `src-tauri/` and fix only 003-related regressions in affected `src-tauri/src/` files
- [X] T099 Perform a final spec/plan/tasks traceability review and update only contradictory or missing references in `specs/003-workspace-explorer/spec.md`, `specs/003-workspace-explorer/plan.md`, and `specs/003-workspace-explorer/tasks.md`

---

## Dependencies & Execution Order

### Phase dependencies

```text
Phase 1 Setup
  ↓
Phase 2 Foundation / 002 safety
  ↓
Phase 3 US4 Zero documents
  ├──────────────┐
  ↓              │
Phase 4 US1 Workspace lifecycle
  ↓              │
Phase 5 US2 Lazy Explorer
  ↓              │
Phase 6 US3 Document integration
  ↓              │
Phase 7 US5 Create
  ↓
Phase 8 US6 Rename
  ↓
Phase 9 US7 Delete
  ↓
Phase 10 US8 Context menu / keys
  ↓
Phase 11 US9 Refresh
  ↓
Phase 12 US10 Shell completion
  ↓
Phase 13 Cross-cutting validation
```

US10 shell primitives may be developed earlier in parallel where needed by Empty State/Explorer, but the complete shell acceptance criteria are closed in Phase 12.

### User story dependencies

- **US4 (P1)**: Depends only on Foundation and is intentionally first because it changes the active-document invariant used by App/commands.
- **US1 (P1)**: Depends on Foundation; independent from document count semantics at the domain level but integrated after US4 to avoid reworking App wiring twice.
- **US2 (P1)**: Depends on US1 for an active WorkContext/root.
- **US3 (P1)**: Depends on US2 for Explorer interactions and existing 002 `DocumentManager` open semantics.
- **US5 (P2)**: Depends on US2 plus Workspace filesystem service.
- **US6 (P2)**: Depends on US5 operation context and Foundation path ownership.
- **US7 (P2)**: Depends on US6-era path coordination and affected-session APIs, but not on Rename UI itself.
- **US8 (P2)**: Depends on the commands/actions it exposes from US5-US7.
- **US9 (P3)**: Depends on the Explorer model from US2 and mutation reconciliation from US5-US7.
- **US10 (P3)**: Shell components can start early; final integration depends on Explorer/Empty State/TabBar surfaces.

## Parallel Opportunities

- T003/T004 can run in parallel after T001/T002 decisions are known.
- T005, T007, T009, T012, and T013 touch distinct foundational concerns and can largely proceed in parallel before their corresponding implementation tasks.
- Within each story, Rust contract tests, frontend controller tests, and isolated UI component construction marked `[P]` can run concurrently when they do not edit the same files.
- US5 filesystem create command work and operation-context tests can run in parallel.
- US6 Rust rename work and DocumentManager rename tests can run in parallel after Foundation.
- US7 Rust trash work, dialog work, and DocumentManager removal tests can run in parallel.
- US10 `AppIcon` can be completed independently of Sidebar layout.

## Parallel Example: US6 Rename

```text
T056 Rust rename contract/tests
T058 Frontend IPC rename adapter tests
T059 DocumentManager path-adoption/descendant tests
T061 Explorer rename-orchestration tests
```

After those contracts/tests establish the required behavior, complete T057/T060/T062/T063/T064 in dependency order.

## Implementation Strategy

### First stable slice

1. Complete Phase 1 and Phase 2.
2. Complete US4 zero-document lifecycle.
3. Complete US1 + US2 so Workspace and lazy browsing work without mutations.
4. Stop and validate Q1-Q3 before adding Rename/Delete complexity.

### Second slice

5. Complete US3 document integration and US5 file/folder creation.
6. Validate canonical duplicate-open and New semantics.

### Data-safety slice

7. Complete US6 Rename and validate dirty/history/path ownership cases.
8. Complete US7 Delete and validate dirty confirmation + OS trash.
9. Only then expose the full context-menu/F2/Delete surface in US8.

### Final slice

10. Complete Refresh and final shell polish.
11. Run the real `node_modules` project validation and all four automated repository gates.

## Task Summary

- Total tasks: **99**
- Foundational/setup tasks: **13**
- US4: **9**
- US1: **10**
- US2: **9**
- US3: **6**
- US5: **8**
- US6: **9**
- US7: **9**
- US8: **5**
- US9: **5**
- US10: **6**
- Polish/cross-cutting: **10**

All implementation tasks use the required checkbox + sequential task id format, user-story tasks carry `[USn]`, parallel-safe tasks carry `[P]`, and actionable tasks identify concrete repository paths.

---

## Phase 14: Convergence

Appended by `$speckit-converge` after assessing the current code against `spec.md`, `plan.md`, `tasks.md`, and `contracts/` on a repository whose Phase 1-13 tasks are complete and whose four automated gates pass. No existing task was renumbered, reordered, or rewritten. Ordered MEDIUM first, then LOW; no CRITICAL or HIGH finding remains.

- [X] T100 Derive a document's `WorkspaceRelation` at runtime from its current canonical path and the active WorkContext, return `unbound` for a session with no disk path, and consume the derivation in document/Workspace containment so `resolve_workspace_relation`, `WorkspaceRelation`, and `toWorkspaceRelation` are no longer without a production caller; cover the Edge Cases where Save As or Rename moves a document inside or outside the Workspace without reopening it per FR-041, FR-042, `data-model.md` WorkspaceRelation rules (partial)
- [X] T101 Make right-clicking Explorer blank space resolve Workspace-root context across the whole scrollable Explorer body rather than only the area covered by rendered tree rows, without letting a stale previous node target survive, in `src/app/explorer/Explorer.tsx`, `src/app/explorer/ExplorerTree.tsx`, and `src/styles/explorer.css` per FR-077, US8 acceptance 4 (partial)
- [X] T102 Capture the Workspace-open intent token before awaiting the native folder picker so an earlier-started request that resolves later cannot replace a newer Workspace, and add an overlapping `openFromDialog` regression case in `src/app/workspace/workContextManager.ts` and `src/app/workspace/workContextManager.test.ts` per FR-007, US1 acceptance 6 (partial)
- [X] T103 Add a per-request or per-node token to `readDirectoryInto` so a superseded read of the same directory cannot apply its result, including the `targets.length === 0` `loadRoot()` path and a re-found refresh target whose `loadState` is already `loading`, in `src/app/explorer/explorerController.ts` per FR-030 (partial)
- [X] T104 Replace the `selectedPath.startsWith(...)` selection rebase and clear in `applyRenamedEntry` and `applyDeletedEntry` with the component-aware containment helpers so a prefix sibling such as a `src2` directory is not rebased or cleared when `src` is renamed or deleted, in `src/app/explorer/explorerController.ts` per FR-043 and the sibling-prefix Edge Case (partial)
- [X] T105 Clear the Explorer's `rootUnavailable` state and its error row when a successful Workspace open or duplicate reopen proves the root readable again, so the unavailable banner cannot outlive recovery, in `src/app/App.tsx` and `src/app/explorer/explorerController.ts` per FR-088, FR-086 (partial)
- [X] T106 Replace the `MAX_MUTATION_WAITS` fall-through in `openPathWaitingForMutations` and `saveDocumentInternal` with a deterministic `path_resolution` failure or continued waiting while a reservation still covers the destination, so a registered session or write can never contradict a successful disk operation, in `src/app/document/documentManager.ts` per FR-100, FR-103 (partial)
- [X] T107 Reserve the resolved destination before `create_workspace_entry` and release it after the open commit, or document explicitly why Explorer file creation is exempt from the destination ownership rules, in `src/app/explorer/explorerActions.ts` per FR-100, plan decision 15 (partial)
- [X] T108 Gate the Explorer context-menu Refresh item to root and directory contexts so a file context offers New File, New Folder, Rename, and Delete only, in `src/app/explorer/ExplorerContextMenu.tsx` and `src/app/explorer/explorerActions.ts` per plan decision 12 (contradicts)
- [X] T109 Move the Explorer context-menu shadow colour into a shared token in `src/styles/global.css` and reference it from `src/styles/explorer.css` instead of the hard-coded `rgb(0 0 0 / 45%)` per FR-095 (partial)

---

## Phase 15: Convergence

Appended by `$speckit-converge` after re-assessing the code against `spec.md`, `plan.md`, `tasks.md`, and `contracts/`. T100-T109 are implemented and verified, but the relation rewiring those tasks introduced left one HIGH regression, listed below. No existing task was renumbered, reordered, or rewritten.

- [X] T110 Make Explorer Delete find the affected open sessions for a file target again: `affectedSessions` asks `resolve_workspace_relation` with the target as its root, but that command rejects a non-directory root (`file_identity.rs:191,206-228`), so deleting an open file silently reports no affected session, drops the dirty-discard warning, and `removeDeletedSessions([])` leaves the Tab open after the file was trashed, where a later Save would recreate it; include the exact-target session by its own canonical identity or the still-injected `findSessionsUnder`, and surface a relation-resolution failure instead of silently degrading to `outside`, with a regression test whose fake rejects a file root the way the Rust command does per FR-069, FR-071, FR-062, US7 acceptance 3 and 4 (contradicts)

---

## Phase 16: Convergence

- [X] T111 Make `rename_workspace_entry` preserve existing destinations without a check-then-rename overwrite window: in `src-tauri/src/workspace_fs.rs`, reject a distinct destination symlink that resolves to the source, allow only a genuine case-only rename of the same directory entry, and use a platform-appropriate no-replace operation for the final disk rename; add Rust regressions for an alias symlink and a destination appearing after validation per plan decision 9, `contracts/workspace-ipc.md` Rename guarantees, US6/AC5, SC-009 (partial)
- [X] T112 Guard Explorer action continuations against WorkContext replacement: capture the context id/generation before awaits in `beginCreate`, `commitCreate`, and `commitRename`, and apply selection, inline-edit cancellation, and Tree changes only to the originating Explorer state after the awaits; keep document-path commits after successful disk mutations, and add deferred-operation tests in `src/app/explorer/explorerActions.test.ts` for a Workspace switch during expansion, creation, and rename per FR-030, FR-089, US1/AC2 (partial)
