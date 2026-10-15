# Tasks: Interaction Polish

**Input**: `specs/004-interaction-polish/spec.md` and `specs/004-interaction-polish/plan.md`  
**Implementation Base**: `feature-core` @ `690f285cb2cb9976682b8583e145f7d99e5890ac`

> **Agent scope warning**: This is a small frontend follow-up, not an Explorer/Workspace redesign. Preserve all completed 003 filesystem, path-ownership, document, Workspace, lazy-load, Refresh, and stale-operation architecture unless a task below explicitly says otherwise. Do not add unrelated abstractions or “improve” deferred features.

## Phase 1: Lock 004 Regression Contracts

**Goal**: Pin the two logic changes that are easy to accidentally broaden: file-context menu filtering and inline commit-result semantics.

- [X] **T001 [US2]** In `src/app/explorer/explorerActions.test.ts`, add focused tests for a new context-menu-only creation predicate covering **all four** operation contexts: no Workspace -> false; Workspace root/no concrete selection -> true; selected directory -> true; selected file -> false. In the same test block, retain/assert the existing `deriveFileOperationContext()` behavior that a selected file still has `createParentPath = parentPathOf(file)` and `isCreateAvailable(context) === true`. **Do not change selected-file target derivation to make this test pass.** (FR-006–FR-010, SR-002)

- [X] **T002 [US3]** After T001, in `src/app/explorer/explorerActions.test.ts`, add result-oriented tests around inline commit orchestration before changing UI event wiring. Cover at minimum: empty New File draft returns/behaves as `retained` with no filesystem call; create filesystem failure retains the draft; create success reports `committed`; rename filesystem failure retains the draft; successful rename reports `committed`; existing unchanged-name/empty-name rename behavior closes/cancels the inline editor and therefore reports `committed`. Reuse existing fakes/reservation assertions and do **not** weaken current disk-first or reservation tests. (FR-013–FR-016)

**Checkpoint**: The intended surface filtering and commit outcome contract are test-pinned without any architecture change.

---

## Phase 2: User Story 1 - Directory Selection vs Expansion (Priority: P1)

**Goal**: Separate ordinary directory selection from expansion while preserving the existing lazy-load controller.

- [X] **T003 [US1]** Update the interaction comments/contracts at the top of `src/app/explorer/ExplorerTree.tsx` so they no longer describe directory row `onClick` as expansion. Document the 004 rules explicitly in code comments: file single-click selects; file double-click opens; directory row single-click selects only; directory row double-click toggles; chevron toggles expansion only. Remove stale 003 commentary rather than leaving contradictory comments. (FR-001–FR-005, SR-001)

- [X] **T004 [US1]** Change `NodeRow` event wiring in `src/app/explorer/ExplorerTree.tsx`: the row `onClick` MUST focus the row and call only `props.onSelect(node.path)` for both files and directories; it MUST NOT call `onToggleDirectory`. The row `onDoubleClick` MUST call `props.onOpenFile(node.path)` for files and `props.onToggleDirectory(node.path)` exactly once for directories. Do not move any lazy-load/filesystem logic into the component. (FR-001–FR-004)

- [X] **T005 [US1]** In the directory chevron button in `src/app/explorer/ExplorerTree.tsx`, preserve `onClick -> stopPropagation() -> onToggleDirectory(node.path)` with no selection change, and add/retain a chevron `onDoubleClick` propagation guard so the chevron's double-click event cannot reach the row `onDoubleClick` and add an extra row-level toggle. Do **not** add timers, debounce, delayed single-click handling, or a new click state machine. (FR-005)

- [X] **T006 [US1]** Source-review the changed `ExplorerTree.tsx` after T004-T005 and confirm there is exactly one directory expansion entry point from row double-click and one from each chevron click, both still routed to the existing `onToggleDirectory` callback. Confirm ordinary row single-click cannot call `controller.toggleDirectory()` indirectly. Do not modify `ExplorerController` solely for this story. (SC-001, SC-002)

**Checkpoint**: Selection alone never expands a directory; double-click/chevron still reuse 003 lazy loading.

---

## Phase 3: User Story 2 - File Context-Menu Scope (Priority: P1)

**Goal**: Hide creation from file context menus without changing shared creation commands or selected-file parent targeting.

- [X] **T007 [US2]** In `src/app/explorer/explorerActions.ts`, add a narrowly named helper such as `isContextMenuCreateAvailable(context: FileOperationContext): boolean`. Its semantics MUST be: false with no Workspace; false when `context.selectedEntry?.kind === "file"`; otherwise defer to the existing `isCreateAvailable(context)`. Leave `deriveFileOperationContext()`, `isCreateAvailable()`, `createParentPath`, command ids, and create orchestration unchanged. (FR-006–FR-010)

- [X] **T008 [US2]** In `src/app/explorer/ExplorerContextMenu.tsx`, use the new context-menu-specific helper only when deciding whether to render the New File/New Folder group. Do not change Rename/Delete/Refresh grouping except where TypeScript imports require adjustment. A file context menu after this task MUST show no creation group; directory/root contexts MUST continue to show it. (FR-006, FR-007)

- [X] **T009 [US2]** Verify `src/app/explorer/Explorer.tsx` header button availability still calls `actions.isCreateAvailable()` for New File/New Folder. Do not redirect the header to the context-menu predicate. If no code change is required, leave the file untouched and record the verification in the final implementation handoff under `004 Manual Verification`. (FR-008, FR-009, SR-002)

- [X] **T010 [US2]** Run the targeted `explorerActions.test.ts` cases after T007-T009 and confirm both of these are true simultaneously: file context-menu creation predicate is false; ordinary creation availability for the same selected file remains true and targets its parent. If either condition fails, fix only the surface predicate/use site rather than changing the target model. (SC-003)

**Checkpoint**: File right-click reads as file-local actions, while header creation still works beside the selected file.

---

## Phase 4: User Story 3 - Inline Blur Cancellation Without Commit Races (Priority: P1)

**Goal**: Ordinary blur cancels an uncommitted inline draft, while Enter-triggered async work is protected and retained failures recover focus.

- [X] **T011 [US3]** In `src/app/explorer/explorerActions.ts`, define/export a minimal result type for inline commit completion, e.g. `InlineCommitResult = "committed" | "retained"`, and change `commitInlineEdit()` to return `Promise<InlineCommitResult>`. Do not introduce a new controller state machine or persisted `committing` field. (FR-013–FR-016)

- [X] **T012 [US3]** Thread the `InlineCommitResult` through the existing `commitCreate()` branches in `src/app/explorer/explorerActions.ts` with **no orchestration rewrite**: trimmed-empty draft -> `retained`; identity inspection failure -> `retained`; path reservation failure -> `retained`; filesystem create failure -> `retained`; successful create after existing reconciliation/open behavior -> `committed`. Keep reservation acquisition/release order, stale-origin checks, selection, and `DocumentManager.openPath()` behavior exactly as in 003. (FR-015, FR-016, FR-027)

- [X] **T013 [US3]** Thread the same result through the existing `commitRename()` branches in `src/app/explorer/explorerActions.ts` with **no path/document coordination redesign**: existing unchanged/empty-name branch that closes the editor -> `committed`; identity inspection failure -> `retained`; reservation failure -> `retained`; affected-session resolution failure -> `retained`; filesystem rename failure -> `retained`; successful rename after existing document/tree reconciliation -> `committed`. Preserve `commitRenamedPath()`, reservation release, affected-session lookup, and origin checks unchanged apart from required return statements. (FR-015, FR-016, FR-027)

- [X] **T014 [US3]** Change `ExplorerTreeProps.onInlineCommit` and `InlineEditorInput` in `src/app/explorer/ExplorerTree.tsx` to use the promise result from T011. Add an `input` ref and a transient `commitInFlight` ref local to the input component. Do **not** add React/application state for this flag. (FR-013, FR-016)

- [X] **T015 [US3]** Implement commit-key handling in `InlineEditorInput`: on Enter, first `preventDefault()` and `stopPropagation()`; if `commitInFlight.current` is already true, consume the repeated Enter and return without calling `onInlineCommit()` again. Otherwise synchronously set `commitInFlight.current = true`, await `onInlineCommit()`, and in a `finally`-safe path clear the flag. If the result is `retained` and the same input is still mounted, refocus it after the action/dialog has completed. While `commitInFlight.current` is true, consume Escape without calling `onInlineCancel()` because an already-started filesystem operation cannot be retroactively cancelled by dismissing the input. When no commit is active, preserve the existing Escape -> explicit cancel behavior. Do not cancel the inline editor merely because the native error dialog caused blur during the awaited operation. (FR-013–FR-016, SC-005)

- [X] **T016 [US3]** Add `onBlur` to `InlineEditorInput` in `src/app/explorer/ExplorerTree.tsx`: if `commitInFlight.current` is false, call `onInlineCancel()`; if true, ignore that blur. Preserve existing `onClick`/`onDoubleClick` propagation stopping. This blur rule applies equally to create-file, create-folder, and rename because all three use the same input component. Do not add a second commit/cancel state outside this local ref. (FR-011, FR-012, FR-014)

- [X] **T017 [US3]** In `src/app/explorer/Explorer.tsx`, stop discarding the promise from `actions.commitInlineEdit()` for the `onInlineCommit` prop; return that promise/result to `ExplorerTree`. Do not change command-registry handlers or filesystem service interfaces for this purpose. (FR-013–FR-016)

- [X] **T018 [US3]** Extend/adjust the T002 tests after T011-T017 so every result branch passes and existing create/rename reservation, disk-first, stale-WorkContext, and document-path tests still pass unchanged. Specifically confirm the new return values did not cause any early return before reservation release or successful reconciliation. (FR-027, SC-004, SC-005)

**Checkpoint**: Blur no longer strands inline edit; Enter remains authoritative once a commit starts; failures return the user to the retained draft.

---

## Phase 5: User Story 4 - Trailing TabBar `+` (Priority: P2)

**Goal**: Make the New control part of Tab order visually and spatially without changing what New does.

- [X] **T019 [US4]** In `src/app/tabs/TabBar.tsx`, move the existing `.tab-bar__new` button inside `.tab-bar__scroll`, after `tabs.map(...)`. Keep `onNew`, title, accessibility label, and `AppIcon("plus")` unchanged. There MUST NOT be a second fixed/new button outside the scroll container. (FR-018, FR-019, FR-022, SR-003)

- [X] **T020 [US4]** Add a ref for the trailing New button in `src/app/tabs/TabBar.tsx`. Update the existing active-tab visibility effect so a non-final active Tab is still scrolled into view as before, while an active **final** Tab scrolls the tail/New button into view and guarantees both the final Tab and `+` are visible. Do not reorder Tabs, do not make `+` follow arbitrary active Tabs, and do not create a new TabBar state model. (FR-021)

- [X] **T021 [US4]** Update `src/styles/tabs.css` for the new DOM structure: remove CSS/comment assumptions that `.tab-bar__new` is a fixed sibling outside `.tab-bar__scroll`; keep the button non-shrinking inside the flex scroll strip; preserve the existing 30px control size and visual treatment unless a minimal border adjustment is required. Do not restyle unrelated Tabs. (FR-018–FR-020)

- [X] **T022 [US4]** Source-review `TabBar.tsx`/`tabs.css` after T019-T021 and confirm the zero-tab render path still produces one visible `+` inside the strip and that clicking it still reaches only `onNew`. Confirm no Workspace creation path was introduced. (SC-006)

**Checkpoint**: `+` is always the tail item of the Tab sequence, not a fixed toolbar control.

---

## Phase 6: User Story 5 - CodeMirror Selection Visibility (Priority: P2)

**Goal**: Correct the visual stacking/specificity issue without touching editor/document state.

- [X] **T023 [US5]** In `src/editor/editorConfig.ts`, adjust the CodeMirror theme so the focused drawn selection layer has a selector specific enough to reliably apply `var(--color-selection)` to `.cm-selectionBackground`. Keep CodeMirror `basicSetup`/drawSelection behavior; do not replace it with React state, custom selection transactions, or DOM text wrapping. (FR-023, FR-025, FR-026)

- [X] **T024 [US5]** In `src/editor/editorConfig.ts`, make `.cm-activeLine` and `.cm-activeLineGutter` styling non-occluding where necessary so the text selection remains visible through an active-line overlap. Prefer composing existing CSS tokens or one narrowly scoped editor token; do not change the entire application palette. Preserve active-line visibility outside selected regions. (FR-024, FR-025)

- [X] **T025 [US5]** Review `src/styles/global.css` only if T024 genuinely requires a new/adjusted shared token. If no token change is necessary, do not touch `global.css`. Do not repurpose `--color-selection` or broadly alter Tab/Explorer colors just to solve the editor-layering issue. (FR-025)

**Checkpoint**: Selection rendering is fixed by theme/CSS only; editor state and document lifecycle remain untouched.

---

## Phase 7: Focused Manual Verification

**Goal**: Validate DOM/focus/visual behaviors that the current repository does not have a dedicated React component-test framework for. Do not add a new test dependency just to avoid these focused checks.

**Evidence location**: Record T026-T031 results in the final implementation handoff under a section titled `004 Manual Verification`. For each task, record pass/fail, the relevant workspace/theme/setup, and any limitation that prevented a scenario from being exercised. If the change is submitted through a pull request, copy the same matrix into the PR description.

- [X] **T026 [P]** Using a disposable Workspace, verify directory interaction: single-click an unloaded directory row and confirm selection changes with no expansion/read; click chevron and confirm expansion without unintended selection change; collapse/expand by row double-click and confirm one row-level toggle per double-click; double-click the chevron and confirm no extra row double-click toggle is added. Record pass/fail notes. (SC-001, SC-002)

- [X] **T027 [P]** Verify context-menu scope: file right-click selects the file and shows no New File/New Folder; directory and blank/root contexts still show New actions; while the file remains selected, use Explorer-header New File/New Folder and confirm creation still occurs in the file's parent directory. Use disposable targets. (SC-003)

- [X] **T028 [P]** Verify inline edit blur behavior for New File, New Folder, and Rename: type a partial draft and click another Explorer/UI control without pressing Enter; confirm the editor disappears and disk/tree names do not change. Repeat with Escape to confirm explicit cancel still works. (SC-004)

- [X] **T029 [P]** Verify the commit-race boundary: press Enter on a valid create/rename and move focus while the async operation is in flight; confirm the operation is not cancelled. While that attempt is still active, press Enter again and Escape and confirm neither starts a duplicate commit nor makes the already-started operation appear cancelled. Then force a conflict/invalid/filesystem failure that triggers the existing error path; after the dialog closes, confirm the same draft remains and the inline input regains focus. Confirm a later ordinary blur can cancel that retained draft. (SC-005)

- [X] **T030 [P]** Verify TabBar behavior with zero Tabs, a few Tabs, and enough Tabs to overflow: `+` is immediately after the last Tab; it may scroll away when viewing earlier Tabs; activating/creating the final Tab reveals the tail; activating an older Tab does not move `+` beside it; `+` still creates one Untitled document. (SC-006)

- [X] **T031 [P]** In the default application theme, verify CodeMirror selection rendering with: (a) one-line partial selection; (b) three-line selection beginning/ending mid-line; (c) active line inside the selected range; (d) active line outside the selected range. Confirm each `.cm-selectionBackground` fragment has a non-transparent background derived from `--color-selection`, every selected segment remains visibly painted, and active-line styling remains visible without replacing or covering selection. (SC-007)

**Checkpoint**: All five user-visible changes match the frozen 004 interaction contract.

---

## Phase 8: Repository Gates and Scope Audit

**Goal**: Prove the small follow-up did not introduce architecture drift or regress completed 003 behavior.

- [X] **T032** Run `npm run typecheck` from repository root and fix only 004-related TypeScript issues. Do not use type errors as a reason to redesign Explorer action/controller interfaces beyond the minimal `InlineCommitResult` contract. 

- [X] **T033** Run `npm run test` and fix only regressions caused by 004. Existing 001-003 tests for document identity, path reservation, Workspace lazy load, Rename/Delete, Refresh, and stale operations MUST continue passing. Do not weaken/delete old tests merely because their implementation path is inconvenient; update only tests whose asserted interaction was explicitly superseded by 004. 

- [X] **T034** Run `npm run build` and resolve only 004-related build issues.

- [X] **T035** Run `cargo test` from `src-tauri/`. No Rust change is expected; any Rust source diff introduced during 004 should be treated as design drift and removed unless separately justified outside this feature.

- [X] **T036** Perform a final diff scope audit. Expected production touch set is limited to `ExplorerTree.tsx`, `Explorer.tsx`, `ExplorerContextMenu.tsx`, `explorerActions.ts`, `TabBar.tsx`, `tabs.css`, `editorConfig.ts`, plus `explorerActions.test.ts` and at most a minimal `explorer.css`/`global.css` styling adjustment. Explicitly verify there are **no unintended changes** in `src-tauri/**`, `src/app/document/**`, `src/app/workspace/**`, file/path services, package dependencies, command ids, or Workspace filesystem contracts. Revert unrelated refactors, renamed abstractions, formatting churn, or speculative enhancements. (FR-027–FR-029)

- [X] **T037** Perform final spec/plan/tasks traceability and Constitution review against `specs/004-interaction-polish/` and `.specify/memory/constitution.md`. Confirm all three superseded 003 behaviors are implemented exactly as SR-001..SR-003 state, the WebView2 cursor issue remains untouched/deferred, and the actual diff still passes every pre-design/post-design Constitution check recorded in `plan.md`. Do not edit 003 historical requirements to hide the supersession. (SR-001–SR-003, FR-029)

---

## Dependencies & Execution Order

```text
Phase 1 contract tests
  ├─> Phase 2 directory interaction
  ├─> Phase 3 context-menu filtering
  └─> Phase 4 inline commit/blur

Phase 5 TabBar and Phase 6 selection styling
  can proceed independently after Phase 1

All implementation phases
  ↓
Phase 7 focused manual verification
  ↓
Phase 8 full repository gates + scope audit
```

### Parallel-safe work

- T001 and T002 both edit `explorerActions.test.ts` and MUST run sequentially in task order; they are intentionally not marked `[P]`.
- Phase 2, Phase 5, and Phase 6 touch separate production files and are conceptually parallel-safe.
- T026-T031 are independent manual checks and may be performed in any order after their corresponding implementation tasks.
- Do not parallelize T011-T018 across multiple agents unless they share a precise patch order; those tasks deliberately thread one return contract through the same `explorerActions.ts` / `ExplorerTree.tsx` flow.

## Task Summary

- Total tasks: **37**
- Contract/regression setup: **2**
- US1 directory interaction: **4**
- US2 context-menu scope: **4**
- US3 inline blur/commit boundary: **8**
- US4 TabBar `+`: **4**
- US5 selection rendering: **3**
- Focused manual verification: **6**
- Repository gates/scope audit: **6**

The intentionally high task granularity is a guard against implementation drift: each task specifies the allowed files, the behavior to preserve, and the architectural areas that MUST NOT be redesigned.

---

## Phase 9: Convergence

- [X] T038 Record the Phase 7 manual acceptance evidence for T026-T031 in the 004 implementation handoff under a section titled `004 Manual Verification`, with pass/fail, the workspace/theme/setup used, and any limitation per scenario — directory single-click select / row double-click toggle-once / chevron isolation, file context-menu scope plus header creation beside a selected file, ordinary-blur cancel and the Enter commit-race boundary with focus restoration on a retained draft, TabBar `+` placement with zero/few/overflowing Tabs, and CodeMirror partial-line selection visibility with the active line both inside and outside the selection — per SC-001–SC-007 and plan: manual Tauri verification (partial)
