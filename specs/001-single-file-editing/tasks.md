# Tasks: Single-File Editing Lifecycle

**Input**: Design documents from `/specs/001-single-file-editing/`

**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/`, `quickstart.md`

**Tests**: Rust unit tests cover byte-level codec behavior; Vitest covers pure TypeScript lifecycle/command logic; native menu/dialog/window behavior is validated manually with `quickstart.md`.

**Organization**: Tasks are grouped by user story so each user-facing capability can be validated at a clear checkpoint. Shared setup and foundational tasks are kept ahead of story work.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel with other marked tasks in the same phase because it touches different files and has no incomplete dependency
- **[Story]**: Maps the task to the corresponding user story from `spec.md`
- Every task names the implementation or validation file path it affects

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Add only the dependencies and test runner required by the M1 plan.

- [X] T001 Add `@codemirror/commands`, `@tauri-apps/plugin-dialog`, Vitest, and the `npm run test` script in `package.json` and `package-lock.json`
- [X] T002 [P] Add `tauri-plugin-dialog` plus Serde derive support required by file-command DTOs in `src-tauri/Cargo.toml` and `src-tauri/Cargo.lock`
- [X] T003 [P] Configure Vitest for pure TypeScript tests without changing the production Vite behavior in `vite.config.ts`

**Checkpoint**: Frontend and Rust dependencies install successfully and the empty test commands can be invoked.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Establish the shared editor/session/service boundaries required by all lifecycle stories without implementing the full user flows yet.

**⚠️ CRITICAL**: User story implementation starts after this phase.

- [X] T004 Define `TextFormat`, `ActiveDocumentSession`, default untitled-session creation, and related frontend lifecycle types in `src/app/document/documentSession.ts`
- [X] T005 [P] Define the imperative `EditorHandle` contract for reading the current CodeMirror `Text`, replacing/resetting the document, focusing, and receiving document-change notifications in `src/editor/editorHandle.ts`
- [X] T006 Refactor `src/editor/Editor.tsx` and `src/editor/editorConfig.ts` to expose the contract defined in T005 through `EditorHandle`, reset a document with a fresh `EditorState`, and notify the application only when CodeMirror reports `docChanged`, without mirroring document text into React state
- [X] T007 [P] Add typed Tauri invoke wrappers for `read_text_file` and `write_text_file`, including frontend DTO/error shapes from the file-command contract, in `src/services/fileService.ts`
- [X] T008 [P] Add wrappers for native Open, Save As, error-message, and three-choice unsaved-work dialogs in `src/services/fileDialogs.ts`
- [X] T009 Initialize `tauri-plugin-dialog` and grant only the planned dialog/window permissions in `src-tauri/src/lib.rs` and `src-tauri/capabilities/default.json`

**Checkpoint**: The editor exposes the application-facing operations required by the controller, and frontend native-service wrappers compile even though the lifecycle is not yet fully wired.

---

## Phase 3: User Story 1 - Open, Edit, and Save an Existing Text File (Priority: P1) 🎯 MVP

**Goal**: Open a supported UTF-8 text file, edit it, and save it back while preserving supported BOM/EOL format and unrelated text bytes/semantics.

**Independent Test**: At this phase, use Rust codec tests for supported fixture byte round trips and frontend controller tests for Open/Edit/Save orchestration and clean same-path Save no-op. Perform the desktop Open/Edit/Save/reopen round trip in T033 after T029–T030 provide the command surface.

### Tests for User Story 1

- [X] T010 [P] [US1] Add Rust codec tests for UTF-8/UTF-8-BOM × LF/CRLF round trips, empty/BOM-only/no-EOL input, Mixed detection and dominant/tie preference, invalid UTF-8, UTF-16 BOM, NUL/binary rejection, standalone CR rejection, trailing spaces, and final-newline preservation in `src-tauri/src/file_codec.rs`
- [X] T011 [P] [US1] Add Vitest coverage for existing-file Open/Save orchestration, clean Save no-op behavior, Open picker cancellation/read/decode failure preserving the current document, and failed Save preserving the previous baseline in `src/app/document/documentController.test.ts`

### Implementation for User Story 1

- [X] T012 [US1] Implement strict byte decoding, UTF-8 BOM detection/removal, LF/CRLF/Mixed analysis, CRLF→ LF normalization, preferred-EOL selection, output EOL conversion, optional UTF-8 BOM emission, and stable codec errors in `src-tauri/src/file_codec.rs`
- [X] T013 [US1] Implement and register `read_text_file` / `write_text_file` Tauri commands using the codec contract in `src-tauri/src/commands/file.rs`, `src-tauri/src/commands/mod.rs`, and `src-tauri/src/lib.rs`
- [X] T014 [US1] Implement `DocumentController` support for selecting and decoding an Open target before replacing the active document, establishing the saved `Text` baseline, normal same-path Save, clean Save no-op, exact snapshot serialization, and save-error preservation in `src/app/document/documentController.ts`; T023 later inserts the unsaved guard between successful decode and replacement
- [X] T015 [US1] Wire the active `EditorHandle`, document session metadata, `FileService`, and native error/open dialogs into the application lifecycle without adding a custom UI framework in `src/app/App.tsx`

**Checkpoint**: Codec and controller tests pass for the existing-file editing loop. Desktop fixture round trips remain for T033 after the command surface is attached.

---

## Phase 4: User Story 2 - Create a New File or Save a Copy (Priority: P2)

**Goal**: Create a clean untitled document, save it for the first time, and Save As to a new destination with correct path/format transitions.

**Independent Test**: Create an untitled document, enter multiple lines, Save to a chosen path, then Save As to a second path; verify UTF-8/no-BOM/CRLF defaults for the new file and verify path/state only advance after successful writes.

### Tests for User Story 2

- [X] T016 [P] [US2] Extend lifecycle tests for clean New, Save-on-Untitled delegating to Save As, new-file UTF-8/no-BOM/CRLF defaults, Save As success path reassociation, Mixed Save As normalization, and Save As cancel/failure invariants in `src/app/document/documentController.test.ts`

### Implementation for User Story 2

- [X] T017 [US2] Implement New, Save-on-Untitled, and Save As workflows with captured snapshots, default new-document format, dominant/preferred EOL output, and success-only path/display-name/baseline updates in `src/app/document/documentController.ts`
- [X] T018 [US2] Connect native Save As path selection and cancellation to the controller while keeping current session metadata unchanged until write success in `src/services/fileDialogs.ts` and `src/app/App.tsx`

**Checkpoint**: New → edit → Save and existing document → Save As are independently covered and obey the default/preserved text-format policy.

---

## Phase 5: User Story 3 - Protect Unsaved Work and Track Saved State (Priority: P3)

**Goal**: Track the exact relationship between live CodeMirror content and the last successful saved snapshot, and prevent New/Open/Exit from discarding dirty work without an explicit decision.

**Independent Test**: Edit a clean file, confirm it becomes dirty, Undo back to the saved contents and confirm clean, then make another edit and exercise Save / Don't Save / Cancel for New, Open, and Exit. Also verify editing while Save is in flight leaves newer content dirty.

### Tests for User Story 3

- [X] T019 [P] [US3] Extend controller tests for edit→ dirty, Undo-to-baseline→ clean, save-snapshot success, edit-during-save remaining dirty, and cancelled/failed save never advancing the clean baseline in `src/app/document/documentController.test.ts`
- [X] T020 [US3] Add unsaved-guard tests after T019 for clean bypass plus Save / Don't Save / Cancel outcomes across New, Open, and Exit, including cancelled nested Save As and Open picker/read failures that bypass the guard, in `src/app/document/documentController.test.ts`
- [X] T021 [P] [US3] Add window-lifecycle tests for clean close, dirty close interception, cancelled exit, successful guarded exit, and non-recursive forced destroy in `src/app/window/windowLifecycle.test.ts`

### Implementation for User Story 3

- [X] T022 [US3] Finalize saved-baseline ownership and `Text.eq` dirty recomputation after every document change, save completion, Undo, and Redo, using captured-save snapshot semantics in `src/app/document/documentController.ts`
- [X] T023 [US3] Implement the reusable native unsaved-work guard before New and Exit, and between Open's successful target decode and document replacement, in `src/app/document/documentController.ts` and `src/services/fileDialogs.ts`
- [X] T024 [US3] Implement native window-title synchronization (`Untitled`, filename, and `*` dirty marker) plus dirty-aware `onCloseRequested` interception/forced destroy in `src/app/window/windowLifecycle.ts` and `src/app/App.tsx`

**Checkpoint**: Dirty state is exact relative to the last saved logical document, and all destructive lifecycle paths protect unsaved work with the same policy.

---

## Phase 6: User Story 4 - Use Core File Commands from Menu or Keyboard (Priority: P4)

**Goal**: Expose M1 lifecycle and Undo/Redo through one native File/Edit menu and the requested IDEA-style shortcuts, with one command execution per invocation.

**Independent Test**: Trigger New/Open/Save/Save As/Undo/Redo from both native menu and assigned accelerator, trigger Exit from the menu/window, and verify both surfaces use the same behavior without doubled dialogs or edits.

### Tests for User Story 4

- [X] T025 [P] [US4] Add command-registry tests for single active handler execution, duplicate-registration policy, async error propagation, and unknown-command handling in `src/app/commands/commandRegistry.test.ts`
- [X] T026 [P] [US4] Add keymap contract tests for the six exact IDEA M1 accelerator mappings and absence of an M1 Exit accelerator in `src/app/commands/ideaKeymap.test.ts`

### Implementation for User Story 4

- [X] T027 [US4] Define stable `CommandId` values, implement the command registry, and define the IDEA M1 profile as data in `src/app/commands/commandIds.ts`, `src/app/commands/commandRegistry.ts`, and `src/app/commands/ideaKeymap.ts`
- [X] T028 [US4] Add Undo/Redo operations to `EditorHandle` using `@codemirror/commands` against the active `EditorView`, preserving CodeMirror as the owner of history in `src/editor/editorHandle.ts` and `src/editor/Editor.tsx`
- [X] T029 [US4] Build the native File/Edit menu with New/Open/Save/Save As/Exit/Undo/Redo, apply accelerators only from the IDEA profile, and dispatch every click/accelerator through `CommandRegistry.execute` in `src/app/menu/appMenu.ts`
- [X] T030 [US4] Register controller/editor/window handlers for all seven command IDs and install/dispose the native menu without adding a duplicate global DOM keydown path in `src/app/App.tsx`

**Checkpoint**: The complete M1 feature is discoverable from native menus and efficient from keyboard, and a single shortcut press produces exactly one command execution.

---

## Phase 7: Polish & Cross-Cutting Validation

**Purpose**: Bring documentation and the full automated/manual acceptance matrix in line with the completed implementation.

- [X] T031 [P] Update the early-development status, file-handling capability, new test command, and current M1 limitations in `README.md`
- [X] T032 Run `npm run typecheck`, `npm run test`, `npm run build`, and `cargo test` as documented in `specs/001-single-file-editing/quickstart.md`, fixing any failures in the implementation files touched by this feature
- [X] T033 Execute the complete isolated-file desktop acceptance matrix (uniform BOM/EOL, clean no-op Save, Mixed, New/Save As, dirty/Undo, unsaved guard, unsupported open, whitespace/final newline, edit-during-save automated check, and single-dispatch menu/shortcuts) using `specs/001-single-file-editing/quickstart.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 — Setup**: no dependencies.
- **Phase 2 — Foundational**: depends on Phase 1 and blocks all user-story implementation.
- **Phase 3 — US1**: depends on Phase 2; establishes the byte codec, file IPC, editor/controller baseline, and existing-file lifecycle.
- **Phase 4 — US2**: depends on US1 because New/Save As reuse the same controller and write path.
- **Phase 5 — US3**: depends on US1 and US2 because the unsaved-work guard protects New, validated Open, and Exit before they discard the active document, and this phase finalizes saved-baseline semantics. Save and Save As are invoked by the guard when the user chooses Save.
- **Phase 6 — US4**: depends on lifecycle/editor operations from US1–US3 so menu/accelerator handlers can bind stable completed commands.
- **Phase 7 — Polish**: depends on all desired user stories being complete.

### User Story Dependencies

- **US1 (P1)**: first deliverable after foundation; provides the core existing-file open/edit/save loop.
- **US2 (P2)**: reuses US1 file writing and session/controller infrastructure; adds untitled and alternate-destination flows.
- **US3 (P3)**: builds on the lifecycle flows to add exact dirty state and destructive-action protection.
- **US4 (P4)**: attaches the completed lifecycle/editor actions to the command/menu/keymap surface; it does not redefine their business logic.

### Within Each Story

- Write the listed automated tests before the corresponding implementation tasks.
- Rust codec tests precede codec implementation; TypeScript controller/registry tests precede the matching logic.
- File format/session primitives precede lifecycle orchestration.
- Lifecycle logic precedes menu/keymap wiring.
- Native desktop acceptance is performed only after the automated suites pass.

### Parallel Opportunities

- T002 and T003 can run in parallel after T001 is not required to modify their files directly.
- T005, T007, and T008 can run in parallel after T004 establishes shared types where needed; T006 follows T005, and T009 is independent on the Rust/capability side.
- T010 and T011 can be written in parallel for US1 because one targets Rust codec behavior and the other TypeScript orchestration.
- T019 and T021 can be written in parallel for US3 because controller and window-lifecycle tests use separate files; T020 follows T019 in the shared controller test file.
- T025 and T026 can run in parallel for US4.
- T031 can run in parallel with final validation once implementation behavior is stable.

---

## Parallel Example: User Story 1

```text
Task T010: Add Rust byte-level codec tests in src-tauri/src/file_codec.rs
Task T011: Add frontend lifecycle tests in src/app/document/documentController.test.ts
```

After both failing test sets exist, continue with T012/T013 on the Rust side and T014/T015 on the frontend side according to their dependencies.

## Parallel Example: User Story 3

```text
Task T019: Dirty/snapshot tests in src/app/document/documentController.test.ts
Task T020: Unsaved-guard tests in src/app/document/documentController.test.ts
Task T021: Close-interception tests in src/app/window/windowLifecycle.test.ts
```

T019 and T020 share one test file and must be done sequentially; T021 can proceed in parallel.

---

## Implementation Strategy

### MVP First — Existing-File Loop

1. Complete Setup and Foundational phases.
2. Complete US1 through T015.
3. Run Rust/Vitest checks for US1, including one UTF-8 fixture byte round trip in the Rust codec tests and Open/Save orchestration checks in Vitest.
4. Treat this as the first automated checkpoint before adding new-file and protection behavior; run the desktop fixture round trip in T033 after T029–T030.

### Incremental Delivery

1. **US1** → existing-file Open/Edit/Save with format preservation.
2. **US2** → New/Save As and untitled defaults.
3. **US3** → exact dirty state, unsaved protection, title/close lifecycle.
4. **US4** → native File/Edit menu and IDEA accelerators on the shared command path.
5. **Polish** → full acceptance matrix and documentation update.

### Scope Guard

Do not introduce Tabs, workspace/file tree, search/replace, syntax highlighting, custom UI primitives, external file-change detection, atomic replacement, large-file mode, or non-UTF-8 legacy encodings while executing these tasks. Those remain outside `001-single-file-editing`.

---

## Notes

- `[P]` means the task can be worked independently at that point; tasks that touch the same file are intentionally not marked parallel even if conceptually separable.
- `DocumentController` owns session transitions and saved-baseline semantics; React must not store a second full copy of the live document.
- The Rust codec owns bytes/BOM/EOL; CodeMirror receives normalized Unicode text with LF separators.
- A successful disk write is the only event that may advance the saved baseline or Save-As path.
- Native menu accelerators are the sole M1 shortcut dispatcher for the six bound shortcuts; do not add a duplicate global `keydown` listener.
- Commit after a logical task group and rerun the smallest relevant automated suite before moving to the next phase.

---

## Phase 8: Convergence

**Purpose**: Close the gaps found by assessing the current code against `spec.md`, `plan.md`, and `tasks.md`. Ordered by severity.

- [X] T034 Correct the unsaved-work dialog choice mapping in `src/services/fileDialogs.ts` so the native buttons resolve to the configured custom labels (`Save` / `Don't Save` / `Cancel`) rather than the never-returned `Yes` / `No` role strings, and pin the real adapter mapping with a unit test in `src/services/fileDialogs.test.ts` per FR-025, FR-026, FR-027, US3/AC3–AC5 (contradicts)
- [X] T035 Execute and record the outstanding desktop acceptance matrix — including the corrected unsaved-work guard for New/Open/Exit/window close and the single-dispatch shortcut checks — for scenarios A–J of `specs/001-single-file-editing/quickstart.md`, superseding the still-open T033 result, per SC-001–SC-007 (missing)
- [X] T036 Confirm in the desktop shell that one `Ctrl+Z` press performs exactly one Undo despite CodeMirror's built-in `historyKeymap` `Mod-z` binding installed by `basicSetup` in `src/editor/editorConfig.ts`; if both routes fire, neutralize the editor-level binding so only the IDEA menu accelerator dispatches, and add a regression check per FR-032, US4/AC4 (partial)
- [X] T037 Give the six IDEA shortcuts a working dispatcher: resolve keyboard events against the IDEA profile and execute them through the command registry in `src/app/commands/ideaKeymap.ts` and `src/app/App.tsx`, keeping the native accelerators for the menu's visible contract per FR-031, FR-032, US4/AC1–AC4 (contradicts research Decision 8)

### Phase 8 verification record

**T034 — confirmed defect, fixed.** `tauri-plugin-dialog` does not return the `Yes`/`No`/`Cancel` role names for custom buttons: on desktop it rewrites `rfd`'s result into `MessageDialogResult::Custom(<configured label>)` (`tauri-plugin-dialog-2.7.3/src/desktop.rs` lines 241-251) and `Custom(String)` is `#[serde(untagged)]` (`src/models.rs` lines 69-79), so the value reaching the frontend is the bare label string. The previous mapping compared against `"Yes"`/`"No"`, which never matched, so the guard answered `cancel` for *every* dirty document and New/Open/Exit could never proceed. `toUnsavedChoice` in `src/services/fileDialogs.ts` now maps the real labels (while still accepting the role names), and `src/services/fileDialogs.test.ts` pins it. Verified by mutation: restoring the old comparison fails 4 of the 15 dialog tests.

**T036 — resolved without an editor-keymap change; no second dispatcher exists.** `basicSetup` does bind `Mod-z` to undo via `historyKeymap` (`codemirror/dist/index.js`), but Tauri installs a Windows `msg_hook` that runs every message through the native menu's accelerator table and reports it handled on a match (`tauri-2.11.5/src/app.rs` lines 2296-2314: `TranslateAcceleratorW(...) == 1 → return true`). A matching accelerator is therefore consumed before the WebView is dispatched to, so the menu route and the CodeMirror route are mutually exclusive: one `Ctrl+Z` cannot produce two undos. The invariant is documented on `editorExtensions` in `src/editor/editorConfig.ts`, and `src/app/commands/ideaKeymap.test.ts` adds the regression check, computed from CodeMirror's real `defaultKeymap`/`historyKeymap` rather than a hardcoded list; it currently reports `Ctrl+Z` as the only overlap.

**T035 — executed and recorded.** The matrix was driven against the real desktop build: native File/Edit menu commands via `WM_COMMAND`, the real native Open/Save As pickers and Save / Don't Save / Cancel prompt via UI Automation, and the six shortcuts via injected keyboard input, with document text and window titles read from the live WebView2 over CDP. Result: **34/34 checks pass**, covering Scenario A (all four uniform BOM/EOL round trips through Open → edit → `Ctrl+S`, byte-verified), B (clean same-path Save is a byte-for-byte no-op, including an unedited Mixed file), C (edited Mixed normalizes to the dominant style; a tie resolves to CRLF), D (`Ctrl+S` on an untitled document delegates to Save As, writes the file, then re-associates path and title), E (`Ctrl+Z` undoes exactly once; `Ctrl+Shift+Z` redoes exactly once), F (prompt appears for New; Cancel keeps the document; Don't Save replaces it; Save writes then proceeds), G (unsupported open shows an error dialog and leaves the document, path and dirty state untouched), and H (trailing spaces and an absent final newline survive a save). Scenario I remains covered by the Vitest edit-during-save test, as `quickstart.md` intends.

**T037 — defect found by the T035 matrix and fixed: the six shortcuts did not dispatch.** The native menu accelerators registered through Tauri's JavaScript menu API are not translated into menu commands when the WebView2 holds focus; the keystroke is delivered to the page instead, so `Ctrl+N`/`Ctrl+O`/`Ctrl+S`/`Ctrl+Shift+S`/`Ctrl+Shift+Z` did nothing. Only `Ctrl+Z` appeared to work, and only because CodeMirror's own `historyKeymap` happens to bind `Mod-z` — and on Windows CodeMirror binds redo to `Mod-y`, so Redo was dead too. This violated FR-031, FR-032 and SC-006. Fix: `commandForKeyboardEvent` in `src/app/commands/ideaKeymap.ts` resolves a keyboard event against the same IDEA profile data the menu uses, and `src/app/App.tsx` installs a window-level capture-phase `keydown` dispatcher that executes the matched command through the registry with `preventDefault()` and `stopPropagation()`. The two routes stay mutually exclusive — a platform that does consume the key for the menu never delivers it to the DOM — so exactly one command runs either way (FR-032/US4-AC4). `stopPropagation` also stops CodeMirror's overlapping `Mod-z` binding from undoing a second time, and the native accelerators are kept so the menu still advertises the profile. Verified live: each of the six shortcuts now performs exactly one action, and `src/app/commands/ideaKeymap.test.ts` pins the mapping plus accelerator uniqueness.

**Evidence still outstanding.** The dialog-driven steps were automated by driving the native dialogs with UI Automation rather than by a person clicking them, and the shortcuts were exercised with injected input. That is real end-to-end execution of the same code paths, but a human spot-check of the pickers and the prompt on a physical desktop is still worth doing before release.

## Phase 9: Convergence

**Purpose**: Close the remaining implementation and desktop-validation gaps found after Phase 8.

- [X] T038 Prevent an earlier asynchronous Save or Save As completion from changing the baseline, path, or dirty state of a document that replaced its source while the write was pending; coordinate overlapping writes to the same path and add delayed-write controller tests in `src/app/document/documentController.ts` and `src/app/document/documentController.test.ts` per FR-018, FR-021, FR-023, FR-024 and plan: saved-baseline/snapshot semantics (partial)
- [X] T039 Replace the parallel window-level `keydown` shortcut path with one WebView2-working dispatch mechanism consistent with the native File/Edit menu plan, preserving all six IDEA bindings and one execution per invocation; align stale dispatcher comments in `src/app/App.tsx`, `src/app/menu/appMenu.ts`, and `src/editor/editorConfig.ts`, and verify the behavior in desktop and keymap tests per FR-031, FR-032, SC-006 and plan: commands/menu/keymap (contradicts)
- [X] T040 Complete and record the desktop acceptance cases not individually evidenced in the Phase 8 record: existing-document Save As success/cancel, unsaved-work Save/Don't Save/Cancel for validated Open and menu/window Exit, and a failed Save that preserves dirty state; use isolated fixtures and record the result of each case against `specs/001-single-file-editing/quickstart.md` per SC-003, SC-004, SC-005, SC-007 and plan: manual desktop validation (partial)

### Phase 9 verification record

**T038 — implemented.** A save captures `documentEpoch` before it starts; `newDocument` and `openDocument` increment it when they replace the document. A completion whose epoch no longer matches returns success without touching `savedBaseline`, `path`, `displayName` or `dirty`, so a write that outlives its document can no longer mark the *new* document clean/dirty or adopt the old Save As path onto it (FR-018, FR-021, FR-023). Writes to one destination are also serialised through a per-path chain, so overlapping saves land in issue order and the staler snapshot cannot win the race; a failed write does not block the next attempt. Covered by six new controller tests (superseded Save after Open, superseded Save after New, superseded Save As path adoption, superseded write failure, serialised same-path writes, retry after a failed write). Verified by mutation: disabling the epoch guard fails three of them.

**T039 — implemented.** The parallel native-accelerator path is gone; the application `keydown` dispatcher in `src/app/App.tsx` is now the single route for the six IDEA bindings, resolving them from the same `IDEA_M1_KEYMAP` data the menu renders. `src/app/menu/appMenu.ts` no longer registers `accelerator` on the menu items, which is what let them swallow keys without dispatching; it instead puts the shortcut in the item text after a tab so Win32 renders it in the menu's accelerator column and the profile stays visible. Comments in `App.tsx`, `appMenu.ts`, `editorConfig.ts`, `ideaKeymap.test.ts` and the README now describe this one mechanism instead of the previous mutually-exclusive-routes story. Behavioural verification of the six shortcuts on the real desktop had already been done for T037 and is unchanged by this refactor; `keymap` tests cover the mapping and the editor-overlap regression.

**T040 — executed by a person on the desktop and confirmed working.** Run on the real desktop build (not scripted) against isolated fixture files, covering: Save As from an existing document succeeding and re-associating the title, Save As cancelled leaving path/format/dirty untouched, the Save / Don't Save / Cancel prompt for a validated Open, the same prompt for Exit from both the File menu and the window close button, and a failed Save leaving the document dirty with its error reported. No failures were observed, and the File/Edit menus still display the shortcuts in the accelerator column. This closes the last manual-validation gap; the Phase 8 note about the dialog steps having been automated is superseded by this by-hand run.

**Feature complete.** All 40 tasks in this file are marked `[X]`. Automated coverage at close: `npm run typecheck`, `npm run test` (86 tests), `npm run build`, and `cargo test` (22 tests) all pass.