# Tasks: UI Structure Foundation
**Input**: `specs/007-ui-structure-foundation/spec.md` and `plan.md`
**Baseline**: `feature-core` @ `8c8a9488dc7dfdbd9a7c2bc6e206146b1d9db9f4`
**Tests**: Required. 007 changes shell/window behavior, virtualization, command surfaces and layout boundaries; tests are listed before implementation where they can define the contract.
**Organization**: Setup/foundation tasks come first, then tasks are grouped by user story so each major behavior can be validated independently. Cross-cutting release gates come last.
## Format

`- [ ] T### [P?] [US#?] Description with exact file path(s)`

- **[P]** means the task can be implemented in parallel with adjacent tasks once its declared prerequisites exist.
- **[US#]** maps the task to the corresponding user story in `spec.md`.
## Global Invariants

- UI work MUST NOT introduce recursive Workspace scanning.
- CodeMirror/DocumentManager/ExplorerController/WorkContextManager remain the existing state owners.
- Visible actions route through canonical commands/handlers.
- Base UI stays behind `src/ui/**`; TanStack Virtual stays behind the Explorer UI adapter.
- Custom Close MUST preserve the dirty-document guard.
- 007 uses temporary semantic styling only; Theme/Glass/Settings/Split work is deferred.

## Phase 1: Baseline, Dependencies, and Safety Net

**Purpose**: Pin the pushed 006 baseline, add only the two justified frontend dependencies, and prove the repository is green before UI restructuring.
- [X] T001 Run and record the pre-007 baseline gates at `feature-core` HEAD `8c8a9488dc7dfdbd9a7c2bc6e206146b1d9db9f4`: `npm run typecheck`, `npm run test`, `npm run build`, and `cargo test` from `src-tauri`; do not start migration with a pre-existing red gate.
- [X] T002 Create `specs/007-ui-structure-foundation/` from the repository Speckit conventions and place the reviewed `spec.md`, `plan.md`, and `tasks.md` there before implementation starts.
- [X] T003 Add `@base-ui/react` to `package.json`/`package-lock.json`; verify the installed version supports Menu, ContextMenu and Portal APIs used by this plan, and do not add a styled component framework.
- [X] T004 Add `@tanstack/react-virtual` to `package.json`/`package-lock.json`; do not add a second virtualization package.
- [X] T005 Add a short dependency comment/ADR-style note in `specs/007-ui-structure-foundation/plan.md` implementation evidence (or the feature PR description) documenting why Base UI and TanStack Virtual are the only new runtime dependencies.
- [X] T006 Inventory existing UI imports/selectors with a one-time repository search for hard-coded palette literals outside `src/styles/global.css`, `!important`, `:deep`, and selectors that target dependency internals; record the pre-migration findings so 007 can distinguish inherited debt from new violations.
- [X] T007 Record the current manual UI baseline with screenshots/notes for zero-tab, Workspace+Explorer, many Tabs, context menu and dirty-close behavior so structural regressions can be compared after custom chrome is enabled.
- [X] T008 Create/confirm the single shared disposable large-Tree fixture generator under `src/app/performance/` or test helpers that can construct at least 10,000 materialized Explorer rows without touching the real filesystem; later performance tests and debug UI MUST reuse this generator rather than create another fixture.
- [X] T009 Create/confirm a disposable many-Tab fixture helper capable of producing 100 `TabSnapshot` items without creating 100 real files; it will be used by TabStrip manual/debug acceptance.
- [X] T010 Re-read `.specify/memory/constitution.md` and `AGENTS.md` immediately before implementation and fail the phase if any new dependency/state owner/action path violates the five constitutional principles.

## Phase 2: Shared UI Foundation

**Purpose**: Create the small Sorakada-owned boundaries that all later 007 stories depend on: semantic UI wrappers, overlay root, preference ownership, density tokens, icon-provider contracts and new command ids.
- [X] T011 Create `src/ui/overlay/OverlayRoot.tsx` with a single Sorakada-owned portal target/stacking boundary; mount it once near the application root and keep its API independent of Base UI types.
- [X] T012 Add the root stacking-context CSS needed by Base UI portals in `src/styles/global.css`/wrapper CSS, using named z-index/layer tokens rather than ad-hoc `z-index: 9999` values.
- [X] T013 Create `src/ui/menu/SoraMenu.tsx` as the only 007 Menu wrapper over `@base-ui/react/menu`; expose Sorakada concepts (items/groups/submenus/disabled/accelerator/icon/onAction) rather than re-exporting the library's complete prop surface.
- [X] T014 Create `src/ui/context-menu/SoraContextMenu.tsx` as the only 007 ContextMenu wrapper over `@base-ui/react/context-menu`; support command/action items, separators, disabled items, keyboard navigation and Sorakada overlay placement without leaking Base UI component types.
- [X] T015 Add wrapper-level CSS for Menu/ContextMenu open/closed/highlighted/disabled states using Sorakada classes/data attributes and semantic tokens; do not target generated Base UI class names.
- [X] T016 [P] Add focused unit tests for the pure menu-model helpers (grouping, disabled state, accelerator label, action identity) in `src/ui/menu/*.test.ts` without asserting Base UI internal DOM structure.
- [X] T017 Add a repository boundary test/script (or equivalent static assertion in a Vitest test) that fails if `@base-ui/react` is imported outside `src/ui/**`; 007 permits no exception to this boundary.
- [X] T018 Create `src/app/shell/uiPreferences.ts` defining `UiDensity`, versioned `UiPreferences`, safe defaults, validation/clamping and a minimal storage-adapter interface.
- [X] T019 Implement the browser-storage adapter in `src/app/shell/uiPreferences.ts` (or a sibling file) under one stable key; components must consume the store/API and must not call `localStorage` directly.
- [X] T020 Implement the observable `UiPreferencesStore` API (`getSnapshot`/`subscribe` plus explicit update methods) so `App.tsx` no longer owns an unrelated duplicate `UiLayoutState`; storage validation remains inside the store boundary.
- [X] T021 [P] Add tests for missing, valid, malformed, wrong-version, non-numeric width and out-of-range width preference payloads, proving conservative fallback/clamping rather than startup failure.
- [X] T022 Create `src/app/shell/uiDebugState.ts` for process-local diagnostics (`showTreeRowBounds`, `showVirtualRange`, counters visibility); keep it structurally separate from persisted `UiPreferences`.
- [X] T023 Create `src/styles/density.css` with `compact`, `default`, and `comfortable` density token sets for Tree row height/indent, Tab height/min/max width, menu/control height and spacing; leave font family/editor font ownership in existing typography tokens.
- [X] T024 Refactor `src/styles/global.css` so any new 007 palette values live only in central semantic tokens; keep the temporary/default colors coherent but explicitly avoid building Light/Dark theme switching.
- [X] T025 Replace component-local structural magic values that 007 immediately touches (for example Explorer `INDENT = 14`) with semantic/density tokens or metrics exported from a single UI metrics source.
- [X] T026 Create `src/app/icons/iconTypes.ts` defining provider-neutral `IconDescriptor`/icon ids sufficient for current UI and filesystem rows without tying the contract to an external icon library.
- [X] T027 Create `src/app/icons/uiIconProvider.ts` and adapt the existing `src/app/shell/AppIcon.tsx` glyph set as the default UI provider; preserve `currentColor` styling.
- [X] T028 Create `src/app/icons/fileIconProvider.ts` with a `FileIconProvider.resolve(node)` contract and a default provider that returns folder/open-folder/file/other/link fallbacks only; do not add language/special-file mappings yet.
- [X] T029 [P] Add provider tests proving every current `ExplorerNode` kind receives a fallback and that an unknown/special filename does not require Tree code changes.
- [X] T030 Extend `src/app/commands/commandIds.ts` with the concrete 007 commands needed by visible controls: window minimize/toggle-maximize/close, Explorer Locate/Collapse All, Sidebar reset width, the three density choices, and development debug toggle commands if those toggles are exposed as clickable menu actions.
- [X] T031 [P] Update command-registry/keymap tests so the new commands are stable ids but receive no accidental global shortcuts; preserve the existing shortcut profile unchanged unless a currently defined shortcut is merely displayed in the new menu.
- [X] T032 Create a compact app-menu presentation model under `src/app/menu/` that references only `CommandId`, labels and `acceleratorFor()`; keep command execution/availability outside the model.
- [X] T033 Add a CSS-contract audit helper/test that scans 007-owned component styles for new `!important`, `:deep`, and dependency-internal selector patterns and for palette hex literals outside approved token files.
- [X] T034 Wire the root `data-density` attribute from `UiPreferences` in `src/app/App.tsx` or AppShell root and prove switching the preference changes only structural UI metrics, not editor document content/state.
- [X] T035 Re-run `npm run typecheck` and `npm run test` after the shared foundation before migrating shell/Explorer, so wrapper and preference mistakes are isolated early.

## Phase 3: User Story 1 — Stable Desktop Application Shell

**Purpose**: Replace the decorated/native-menu shell with custom desktop chrome while preserving the existing close guard, title sync, zero-state behavior and browser fallback.
- [X] T036 [P] [US1] Add unit tests for a small `WindowChromeController` abstraction in `src/app/shell/windowChrome.test.ts`, proving `requestClose()` maps to normal window close (not destroy), while minimize/toggle-maximize map one-to-one to their native calls; add a TopBar gesture test proving a double-click on the non-interactive drag region dispatches toggle-maximize exactly once while interactive descendants dispatch it zero times.
- [X] T037 [P] [US1] Add a browser-fallback test for `WindowChromeController` proving unsupported/native-only operations are reported as unavailable or safe no-ops rather than throwing during Vite-only rendering.
- [X] T038 [US1] Create `src/app/shell/windowChrome.ts` with a narrow injectable Tauri window adapter; do not let React components call `getCurrentWindow()` directly in multiple places.
- [X] T039 [US1] Register `window.minimize`, `window.toggleMaximize`, and `window.close` in `src/app/App.tsx` through `WindowChromeController`, with `isEnabled` tied to Tauri runtime/capability availability; TopBar buttons dispatch these command ids instead of calling Tauri directly.
- [X] T040 [US1] Update `src-tauri/tauri.conf.json` main window to `decorations: false` while retaining existing size/min-size/resizable/center/title configuration.
- [X] T041 [US1] Update `src-tauri/capabilities/default.json` with only the window permissions required for custom close/minimize/maximize/drag operations; retain existing set-title/destroy permissions required by lifecycle code.
- [X] T042 [US1] Create `src/app/shell/TopBar.tsx` with App Menu slot, explicit draggable region and native-control region; interactive controls must opt out of drag behavior, and double-clicking only the non-interactive drag region must dispatch the canonical `window.toggleMaximize` command exactly once.
- [X] T043 [US1] Implement TopBar minimize/maximize/close buttons through the new window-chrome commands/controller; hide or disable the native-only controls in browser-only mode.
- [X] T044 [US1] Wire `window.close` so the visual close button calls the ordinary Tauri close request and therefore enters `installWindowLifecycle()`; explicitly prohibit direct `destroy()` from TopBar.
- [X] T045 [US1] Preserve `installWindowLifecycle()` title synchronization in `src/app/App.tsx` after native decorations are removed; verify `Sorakada`, `foo.txt - Sorakada`, and dirty title updates still execute.
- [X] T046 [P] [US1] Add a regression test around the close-request path (reuse/extend `src/app/window/windowLifecycle.test.ts` if present) proving a dirty-close Cancel leaves the window alive and the custom command does not bypass `prepareCloseAll()`.
- [X] T047 [US1] Create `src/app/shell/EditorWorkspace.tsx` as the content-side shell boundary; it owns no document state.
- [X] T048 [US1] Create `src/app/shell/EditorGroup.tsx` as a composition boundary containing TabStrip slot + EditorHost/EmptyState slot; do not add group ids, manager, or second editor handle.
- [X] T049 [US1] Create `src/app/shell/FooterBar.tsx` shell slots (`left`, `right`) now so AppShell's vertical structure is stable before Footer content is implemented in US7.
- [X] T050 [US1] Refactor `src/app/shell/AppShell.tsx` into TopBar + MainArea + FooterBar, with MainArea containing Sidebar and EditorWorkspace; remove the old wordmark-only header/body assumption.
- [X] T051 [US1] Refactor `src/app/App.tsx` composition so current Explorer is passed into Sidebar, current Tabs/Editor into the single EditorGroup, and Footer slots are present without changing DocumentManager/ExplorerController ownership.
- [X] T052 [US1] Update `src/styles/shell.css` for the new full-height shell grid/flex geometry; enforce `min-width: 0`/`min-height: 0` at every scroll/flex boundary to prevent accidental overflow overlap.
- [X] T053 [US1] Add TopBar/chrome semantic tokens (height, control hit area, separator/background) to root/density token files; use temporary default styling only.
- [X] T054 [US1] Ensure the MainArea consumes remaining height between TopBar and Footer and that Footer never overlays CodeMirror or Sidebar at the configured 640×400 minimum window.
- [X] T055 [US1] Keep `EmptyState` behavior unchanged for zero documents; validate zero Workspace + zero Tab, Workspace-only, document-only and both-present composition paths after AppShell refactor.
- [X] T056 [US1] Run browser-only `npm run dev`/build smoke validation with Tauri APIs unavailable and confirm AppShell renders without native-control exceptions.
- [X] T057 [US1] Perform a desktop smoke run confirming there is no duplicated native title bar after `decorations: false`, the window can be dragged, and interactive TopBar controls remain clickable; the old native App Menu may remain temporarily until Phase 4 replaces it.
- [X] T058 [US1] Run `npm run typecheck`, `npm run test`, and `npm run build` at the end of the shell phase; defer full `cargo test` to quality gates unless Tauri config/capability work required Rust source changes.

## Phase 4: User Story 5 — Consistent Menus and Overlay Surfaces

**Purpose**: Make the compact App Menu and Explorer context menus use the Sorakada headless wrapper layer while preserving canonical command targeting and availability.
- [X] T059 [P] [US5] Add tests for `CompactAppMenu`'s pure menu model proving File/Edit/View group composition, accelerator labels from `ideaKeymap.ts`, and disabled state from the registry snapshot/callback.
- [X] T060 [US5] Create `src/app/menu/CompactAppMenu.tsx` using `SoraMenu`; keep it presentation-only and dispatch `CommandId` through the same `dispatch()` function used by other surfaces.
- [X] T061 [US5] Place `CompactAppMenu` in `TopBar` as the single default discoverability trigger; do not create a permanent classic File/Edit/View bar in 007.
- [X] T062 [US5] Ensure existing File/New/Open/Open Folder/Close Folder/Save/Save As/Close/Exit and Edit/Undo/Redo commands remain reachable from the compact menu with current availability semantics.
- [X] T063 [US5] Ensure native-only commands such as window controls/Exit are disabled or safely omitted when `isTauriRuntime()` is false; the compact menu must not turn browser-only development into rejected Tauri IPC calls.
- [X] T064 [US5] Add View menu entries for Explorer toggle, Sidebar width reset and Density choices through stable commands; do not mutate `UiPreferences` directly from menu item callbacks.
- [X] T065 [US5] Add a debug-only View > UI Debug submenu entry point whose clickable toggles dispatch stable debug command ids registered in the same `CommandRegistry`; guard the entire submenu by build/development conditions without affecting production command behavior.
- [X] T066 [US5] Migrate `src/app/explorer/ExplorerContextMenu.tsx` from the custom fixed-position implementation to `SoraContextMenu` while keeping the same `ExplorerMenuAction`/command ids.
- [X] T067 [US5] Preserve 004 file-context rule: a file context menu omits New File/New Folder while directory/root contexts retain applicable creation actions.
- [X] T068 [US5] Preserve 003 right-click selection/operation-context rule when Base UI owns the popup behavior: the logical row must be selected before action context is captured.
- [X] T069 [US5] Preserve blank-space/root context behavior on the current Tree and keep one controlled Explorer-level operation target that the later virtualized Tree/background can reuse without authoritative popup state in recyclable rows.
- [X] T070 [US5] Verify ContextMenu keyboard focus, arrow navigation, Escape dismissal and outside-click dismissal through wrapper-level/manual tests without asserting dependency internals.
- [X] T071 [US5] Ensure portal popups render above Sidebar/Editor/Tab/TopBar content near all four window edges and are not clipped by Tree horizontal/vertical overflow containers.
- [X] T072 [US5] Delete or demote obsolete custom menu outside-click/z-index code once the Base UI-backed path is proven; do not leave two active dismissal systems.
- [X] T073 [US5] Retire `src/app/menu/appMenu.ts` native visible menu installer if no longer used, or reduce it to any narrowly required native integration; remove dead imports/ref synchronization from `App.tsx`.
- [X] T074 [P] [US5] Add a static import-boundary regression proving feature components use `SoraMenu`/`SoraContextMenu` rather than importing `@base-ui/react` directly.
- [X] T075 [P] [US5] Run command-path regression tests verifying one click/keyboard activation executes a command at most once after menu migration.
- [X] T076 [US5] Run `npm run typecheck`, `npm run test`, and `npm run build` after menu migration.

## Phase 5: User Story 2 — Flattened, Virtualized Explorer Tree

**Purpose**: Replace recursive Tree DOM with a pure visible-row projection and bounded virtual viewport while preserving all current ExplorerController semantics.
- [X] T077 [P] [US2] Write `src/app/explorer/explorerProjection.test.ts` first with fixtures for root-only, expanded nested directories, collapsed ancestors, files/other nodes, loading/error/cycle sentinels and stable ordering.
- [X] T078 [P] [US2] Add projection tests proving a collapsed ancestor excludes all descendants even if descendant nodes remain cached/expanded in the controller model for later restoration.
- [X] T079 [P] [US2] Add projection tests proving row depth and ancestor-guide metadata are correct across siblings/last-child boundaries, including deep paths and symlink/junction rows.
- [X] T080 [P] [US2] Add a purity test that constructs the projection with no service dependency and asserts no filesystem reader/controller reconciliation callback is invoked by projection work.
- [X] T081 [US2] Create `src/app/explorer/explorerProjection.ts` with `VisibleExplorerRow` union/types and `flattenVisibleExplorerRows(state)`; keep it a derived immutable projection with stable path-based keys.
- [X] T082 [US2] Represent loading/error/cycle notices as explicit flattened sentinel rows with deterministic keys and density-driven fixed row height; do not let verbose message text create arbitrary virtual heights.
- [X] T083 [P] [US2] Add `src/app/explorer/explorerTreeMetrics.test.ts` for horizontal extent using an injected deterministic text measurer, covering shallow/very-deep rows, long names, density changes and widest row outside a simulated virtual viewport.
- [X] T084 [US2] Create `src/app/explorer/explorerTreeMetrics.ts` with depth/indent/fixed-affordance width calculation and a cacheable label-measurement abstraction; never read filesystem data.
- [X] T085 [US2] Implement the production text measurer using a single Canvas/text-measurement context or equivalent non-row mechanism keyed by current UI font signature; avoid hidden rendering of every TreeRow.
- [X] T086 [US2] Invalidate horizontal label-width/extent caches when density/font signature changes; structural Tree changes must recompute only from the new visible projection.
- [X] T087 [US2] Create `src/app/explorer/ExplorerVirtualTree.tsx` using `useVirtualizer` from `@tanstack/react-virtual` with the Explorer body as scroll element and bounded overscan.
- [X] T088 [US2] Configure the React 19 virtualizer path deliberately (start with `useFlushSync: false` per current TanStack React guidance) and document any deviation discovered during implementation testing.
- [X] T089 [US2] Use density-derived fixed `estimateSize`/row metrics and trigger remeasurement on density changes; do not embed another row-height constant in the component.
- [X] T090 [US2] Render virtual rows from absolute/translated virtual positions inside a total-height container while retaining a computed horizontal content width from `explorerTreeMetrics`.
- [X] T091 [US2] Implement `ExplorerRow.tsx` (or equivalent extracted row renderer) for node/sentinel rows, carrying current 004 single-click/double-click/chevron semantics unchanged.
- [X] T092 [US2] Replace the old recursive `NodeRow` recursion in `src/app/explorer/ExplorerTree.tsx` with the flattened/virtualized pipeline or retire that file in favor of `ExplorerVirtualTree.tsx`.
- [X] T093 [US2] Render IDEA-like indent guides from row `depth`/ancestor metadata using CSS/pseudo-elements/guide slots, not nested ancestor DOM solely for lines.
- [X] T094 [US2] Move chevron/icon/label/dirty-notice spacing to density tokens and ensure guide/chevron/icon alignment remains consistent across all three density modes.
- [X] T095 [US2] Use `FileIconProvider` for every filesystem row and remove the Tree-local `iconFor(node)` decision; keep link/fallback indications provider-driven.
- [X] T096 [US2] Make the Explorer/Tree viewport a stable focus owner (`tabIndex`/equivalent) and preserve `aria-tree`/`treeitem`, `aria-selected`, `aria-expanded`, `aria-level` and active-descendant semantics; clicking a virtual row must select its logical path then return focus to the stable viewport so row recycling cannot lose Explorer keyboard scope.
- [X] T097 [US2] Preserve inline Rename/New rendering under virtualization: when an inline editor becomes active, reveal its logical row before focusing and configure the virtual range/range extractor to keep that edit row mounted until edit completion, preserving 004 commit/blur semantics.
- [X] T098 [US2] Ensure scrolling an inline-edit row out of the viewport does not implicitly commit/cancel the controller's logical edit; only existing explicit blur/context rules may do so.
- [X] T099 [US2] Make Explorer body the sole vertical/horizontal Tree scroll viewport while Header remains outside it; set horizontal overflow to `auto` only when computed content width exceeds viewport.
- [X] T100 [US2] Remove ordinary filename hover expansion across region boundaries; keep optional standard title/overlay detail without changing Tree layout.
- [X] T101 [US2] Reuse the shared T008 10,000-row fixture to verify mounted virtual row count stays under the SC-001 bound at steady state; expose the count to later debug instrumentation and do not create a second fixture.
- [X] T102 [P] [US2] Add regression coverage that Tree flattening/virtualization leaves `ExplorerController` selection, expansion, load/reconciliation and `WorkspaceWatchCoordinator` behavior untouched, and that the controlled `SoraContextMenu` target from T066–T069 works for virtual rows and Tree background without retaining a recycled row target.
- [X] T103 [US2] Run existing `explorerController.test.ts`, `explorerReconciliation.test.ts`, watcher suites and the full `npm run test` after replacing recursive rendering.

## Phase 6: User Story 3 — Explorer Header, Quick Search, Locate, Collapse, Refresh Placement

**Purpose**: Add fast IDEA-like navigation without turning UI search into a recursive Workspace search and without weakening watcher-based synchronization.
- [X] T104 [P] [US3] Add pure quick-search tests for case-insensitive visible-row matching, query changes, match disappearance after projection update, empty query and stable logical keys rather than raw indexes.
- [X] T105 [P] [US3] Add direct-key trigger tests covering ordinary printable keys, Ctrl/Alt/Meta shortcuts, `event.isComposing`, inline input focus and menu/search input ownership so typing is never stolen from text controls.
- [X] T106 [US3] Create `src/app/explorer/ExplorerHeader.tsx` with a stable left title/search slot and fixed right action region; entering search must not move Locate/Collapse/More horizontally.
- [X] T107 [US3] Create a small Explorer quick-search UI state/hook that consumes `VisibleExplorerRow[]` only; do not inject `workspaceFileService` or any filesystem service.
- [X] T108 [US3] Implement direct type-to-search activation while Explorer owns focus, seeding the transient input with the triggering printable character and transferring focus without re-dispatching the key.
- [X] T109 [US3] Implement Escape/clear exit from transient search, restoring the `Files` header state without changing Tree expansion. Restore focus to the stable Explorer viewport after closing the transient input.
- [X] T110 [US3] Implement visible-row result selection/reveal through logical keys and virtualizer `scrollToIndex`/equivalent; do not open files automatically as a side effect of search.
- [X] T111 [US3] Recompute matches when watcher/reconciliation produces a new visible projection; if the current match disappears, select the next valid match or clear match state without using stale indexes.
- [X] T112 [US3] Add `explorer.collapseAll` to `CommandId` registration in `App.tsx` and implement a controller API that collapses represented directory expansion without touching selection/document state.
- [X] T113 [P] [US3] Add `ExplorerController` tests for Collapse All over nested cached/expanded directories, proving cached child data remains available for later re-expansion and open documents are unaffected.
- [X] T114 [US3] Add `explorer.locateCurrentFile` registration with availability based on active disk-backed document + active Workspace rather than DOM focus.
- [X] T115 [US3] Design an injectable Locate coordinator/helper in `ExplorerActions` or a focused sibling module that captures document id/path and WorkContext id before asynchronous reveal begins.
- [X] T116 [P] [US3] Add Locate tests for untitled, outside-Workspace, no-Workspace, unreadable/missing component and stale document/WorkContext replacement; all unsupported cases must avoid recursive fallback search.
- [X] T117 [P] [US3] Add Locate tests for a depth-N inside-Workspace file proving only the exact ancestor-chain directories needed for reveal are loaded/reconciled and unrelated sibling branches receive zero reads.
- [X] T118 [US3] Implement path-aware Locate using existing canonical Workspace relation/path semantics; do not use raw `startsWith()` containment or filename search.
- [X] T119 [US3] Implement the controller reveal path one level at a time, validating context/generation at each async completion and expanding only the required ancestor nodes.
- [X] T120 [US3] After successful Locate, select the target path and request virtual viewport reveal by logical path/index; do not make ordinary Tab switching auto-locate.
- [X] T121 [US3] Replace Explorer Header New File/New Folder/Refresh visual buttons with Locate/Collapse/More; put New File/New Folder in `More` when the shared Explorer operation context enables them so creation remains discoverable without occupying primary Header space.
- [X] T122 [US3] Place `explorer.refresh` in Explorer More together with the applicable low-frequency creation actions and retain Refresh in appropriate root/directory context menus; remove it as a dedicated Header icon without changing the command implementation.
- [X] T123 [P] [US3] Verify a manual Refresh while watcher reconciliation is in flight still follows 006's newer-intent/stale-result rules; 007 placement changes must not create a second Refresh path.
- [X] T124 [P] [US3] Add Header/action availability tests for no Workspace, no active document, outside document and active inside file.
- [X] T125 [US3] Run the no-recursive-I/O acceptance fixture and record that type-to-search performs zero directory reads while Locate reads only its exact ancestor chain.
- [X] T126 [US3] Run `npm run typecheck` and `npm run test` after Explorer navigation work.

## Phase 7: User Story 4 — Scalable TabStrip and EditorGroup

**Purpose**: Move Tabs under the single EditorGroup, make many Tabs usable, and explicitly replace 004's scrolling New-button presentation.
- [X] T127 [P] [US4] Add pure Tab layout/overflow helper tests covering zero, few, 20 and 100 Tabs; assert one-row minimum-width behavior and fixed-action width is excluded from the scroll viewport.
- [X] T128 [P] [US4] Add Tab active-reveal helper tests for a Tab left of viewport, right of viewport, already visible, final Tab, and viewport resize; use explicit scroll viewport bounds rather than global `scrollIntoView()` assumptions.
- [X] T129 [P] [US4] Add `TabOverview` filter tests for display-name/path matching, tab-order preservation, active/dirty/external markers and selecting an existing `DocumentId`.
- [X] T130 [US4] Create/rename `src/app/tabs/TabStrip.tsx` from the current `TabBar.tsx`, keeping it presentation-only and preserving existing `TabSnapshot` inputs/callbacks.
- [X] T131 [US4] Move `TabStrip` rendering inside `EditorGroup` and ensure `AppShell`/TopBar no longer know about document Tabs.
- [X] T132 [US4] Split TabStrip DOM into `tab-strip__viewport` (horizontal scroll) and `tab-strip__actions` (fixed); move New (`+`) into the fixed action region, superseding 004's scrolling placement.
- [X] T133 [US4] Keep New behavior routed to the same `file.new` command/createUntitled path as Ctrl+N and File > New; only its presentation location changes.
- [X] T134 [US4] Implement density-token Tab height, min width and max width; allow tabs to flex-shrink down to min and then overflow horizontally without wrapping.
- [X] T135 [US4] Ensure dirty and 005 external modified/missing markers remain visible/accessible under narrow Tab widths and do not disappear because presentation was refactored.
- [X] T136 [US4] Keep Tab close behavior document-id-addressed; closing an inactive Tab must not activate it first.
- [X] T137 [US4] Replace broad `scrollIntoView()` with a viewport-aware active-tab reveal helper if necessary so activation never scrolls AppShell/outer containers or hides a Tab under the fixed action region.
- [X] T138 [US4] Observe Tab viewport size/scrollWidth (ResizeObserver or equivalent) to derive overflow state without storing it in `DocumentSession`.
- [X] T139 [US4] Create `src/app/tabs/TabOverview.tsx` using Sorakada popup primitives; show it from the fixed action region when overflow exists (or when manually forced by debug fixture).
- [X] T140 [US4] Add a lightweight filter input to Tab Overview that filters current `snapshot.tabs` by display name/path without filesystem access.
- [X] T141 [US4] Selecting a Tab Overview item must call `manager.selectDocument(id)`/the existing selection callback exactly once and close the popup; it must not call `openPath()`.
- [X] T142 [US4] Keep Tab Overview live while open: document close/rename/path rebind/dirty/external-state changes from the latest snapshot must update or safely remove items.
- [X] T143 [US4] Add semantic Tab presentation tokens (`active background/foreground/accent`, hover, min/max metrics) but keep only one temporary/default appearance and no user theme/accent setting.
- [X] T144 [US4] Do not add `accent`, `groupStyle`, `bigTab`, `mergedTab` or similar presentation flags to `DocumentSession`; add a code-review/static assertion note/test if helpful.
- [X] T145 [US4] Keep 007 at one `EditorGroup`/one live CodeMirror `EditorView`; verify Editor mount/attach/setState behavior is unchanged by the new composition wrapper.
- [X] T146 [US4] Run the 100-Tab fixture: verify single row, bounded shrink, overflow scrolling, fixed New, Overview filtering and active reveal from both Explorer and Overview activation paths.
- [X] T147 [US4] Run existing document/tab activation, close, save/external-state tests to prove the TabStrip redesign changed presentation only.
- [X] T148 [US4] Run `npm run typecheck`, `npm run test`, and `npm run build` after Tab migration.

## Phase 8: User Story 6 — Density, Sidebar Width, and Cross-Display Layout

**Purpose**: Make structural metrics adjustable and remove the old fixed Sidebar ceiling without using physical-resolution-specific layout rules.
- [X] T149 [P] [US6] Add `uiPreferences` tests proving density/sidebar changes publish one coherent preference snapshot and persist through the store adapter without direct component storage access.
- [X] T150 [P] [US6] Add pure `clampSidebarWidth`/layout-bound tests for the 640×400 minimum window, ordinary 1200px window, wide 4K logical viewport, tiny requested width, huge requested width and non-finite input; assert the layout preserves the frozen 320 CSS-logical-pixel EditorWorkspace minimum after fixed MainArea chrome/splitter space.
- [X] T151 [US6] Replace `SIDEBAR_MAX_WIDTH = 640` in `src/app/shell/Sidebar.tsx` with dynamic bounds derived from available MainArea width and the frozen `minEditorWidth = 320` CSS logical pixels; define the constant in the shared layout metrics owner used by T150 rather than choosing a component-local value.
- [X] T152 [US6] Use ResizeObserver or equivalent MainArea measurement in AppShell/Sidebar layout so bounds recompute when the window is resized or moved to a display with a different logical viewport.
- [X] T153 [US6] Persist Sidebar visibility and the user's preferred Sidebar width through `UiPreferencesStore`; passive clamping caused by a narrower window/display must affect only the rendered width and MUST NOT overwrite the preferred persisted width.
- [X] T154 [US6] Add `view.resetSidebarWidth` command to restore the density/default width through the preferences owner rather than hard-coding the value in the menu.
- [X] T155 [US6] Add density commands (`view.densityCompact`, `view.densityDefault`, `view.densityComfortable`) whose handlers update `UiPreferencesStore`; expose them in Compact App Menu > View.
- [X] T156 [US6] Ensure density selection updates the root `data-density` attribute and all structural CSS tokens without remounting DocumentManager, ExplorerController or CodeMirror state.
- [X] T157 [US6] Trigger virtualizer remeasurement and horizontal text-width cache invalidation after density changes; add regression assertions for row offsets before/after the switch.
- [X] T158 [US6] Ensure Tree body horizontal scrolling uses computed materialized width while Sidebar Header remains fixed and EditorWorkspace never receives Tree overflow.
- [X] T159 [US6] Audit 007 CSS for `vw`/`vh`-based basic control sizing and remove any linear physical-window scaling of Tree rows/Tabs/menu controls; layout may still use normal flex/grid percentages for region allocation where appropriate.
- [X] T160 [US6] Verify typography tokens are not silently changed by Density mode; editor font size/family remains outside 007 density behavior.
- [X] T161 [US6] Add preference/layout behavior for a stored preferred Sidebar width that exceeds the current narrow-window bound: render a safe clamp without overwriting the preference, then restore the preferred width automatically when sufficient MainArea space returns.
- [X] T162 [US6] Manually test Sidebar drag from minimum to >640 logical px on the 2160p display and verify Editor minimum space remains preserved.
- [X] T163 [US6] Move the running Tauri window between the user's 2160p and 1080p monitors, including different Windows scaling if configured, and verify no stale Tree row metrics/popup positions/Tab viewport geometry remain after the move.
- [X] T164 [US6] Repeat the cross-monitor run in Compact/Default/Comfortable density and record any WebView2 DPI-specific issue separately rather than papering it over with resolution detection.
- [X] T165 [US6] Run `npm run typecheck` and `npm run test` after preferences/layout changes.

## Phase 9: User Story 7 — Footer / StatusBar

**Purpose**: Populate the already-established full-width Footer with lightweight filesystem/document context without creating new state owners.
- [X] T166 [P] [US7] Write pure Footer projection tests first for no Workspace/no document, Workspace-only, untitled, inside-Workspace file, outside file, renamed/rebound file and different EOL formats.
- [X] T167 [US7] Create a footer projection helper (for example `src/app/shell/footerProjection.ts`) that derives display-only left breadcrumb/right format items from current WorkContext + active DocumentSession; it must not mutate either owner.
- [X] T168 [US7] Render the Footer left breadcrumb for an inside file using `WorkContext.comparisonKey`, `DocumentSession.pathIdentity.comparisonKey`, and existing component-aware relation helpers (for example `relativeWithinDirectory`) rather than lexical prefix checks; use user-facing `session.path` components for displayed casing/spelling.
- [X] T169 [US7] Render a sensible path/name context for outside files and Untitled documents without creating/changing WorkContext.
- [X] T170 [US7] When no document is active but a Workspace exists, show only Workspace-level left context; when neither exists, keep the Footer structurally present but visually minimal.
- [X] T171 [US7] Render initial right-side read-only document format items from `DocumentSession.format` (UTF-8 and preferred/detected LF/CRLF as defined by existing format semantics); do not add editing behavior.
- [X] T172 [US7] Update Footer projections after Save As, Explorer Rename, external relocation/rebind and active-Tab change by consuming existing snapshots/session reads, not by storing a second path copy.
- [X] T173 [US7] Add Footer CSS with a thin fixed structural height, left flexible/truncating context and right non-wrapping status items; ensure it never expands MainArea width or overlays CodeMirror.
- [X] T174 [US7] Add overflow/priority behavior so a narrow window hides/truncates low-priority breadcrumb portions before right status items force horizontal application overflow.
- [X] T175 [US7] Keep breadcrumb presentation non-interactive in 007 unless a click behavior is already completely defined through a stable command; do not sneak in automatic Tree selection.
- [X] T176 [US7] Verify Footer remains full-width below both Sidebar and EditorWorkspace while Sidebar visibility/resizing changes.
- [X] T177 [US7] Manually validate Footer states for Workspace-only, Untitled, inside file, outside file and zero-everything; record screenshots/notes for 008 visual work.

## Phase 10: User Story 8 — UI Debug and Foundation Inspection

**Purpose**: Provide the minimum debug/preview controls needed to prove virtualization and density without building Settings.
- [X] T178 [P] [US8] Add tests for `UiDebugOptions` defaults/toggles proving debug state is process-local and absent from persisted `UiPreferences` serialization.
- [X] T179 [US8] Create a development-only UI Debug submenu in Compact App Menu > View with toggles for row bounds, virtual range/counters and any other diagnostics actually implemented; do not expose unfinished Settings.
- [X] T180 [US8] Expose `visibleRowCount`, `renderedRowCount`, `virtualStart`, and `virtualEnd` from `ExplorerVirtualTree` to a debug presentation callback/context without making these counts application business state.
- [X] T181 [US8] Render a small debug overlay/section only when enabled, showing visible/rendered/range values and optional row-bound outlines; it must not alter Tree geometry when hidden.
- [X] T182 [US8] Expose the shared T008/T101 10,000-row fixture through a development-only action or harness that feeds the virtual Tree without real filesystem enumeration; do not create another fixture implementation.
- [X] T183 [US8] Add a 100-Tab debug fixture or developer harness if the existing performance fixture is not directly reachable in the app; keep it development-only and document how to invoke it.
- [X] T184 [US8] Verify production builds omit or hide debug-only controls/fixtures while ordinary Density and Sidebar preference commands remain available.
- [X] T185 [US8] Document the 007 debug workflow in the feature's implementation evidence section: how to switch density, display virtual counters, test large rows and reset Sidebar width.

## Phase 11: Cross-Cutting Regression, Performance, and Cleanup

**Purpose**: Prove 007 did not weaken 001–006 behavior, remove obsolete UI paths, and enforce the architecture boundaries that 008 will rely on.
- [X] T186 Run the complete existing frontend test suite and fix any regressions in 004 click/double-click/inline-edit semantics introduced by virtual row recycling.
- [X] T187 Run the 005 opened-document external-change suites and verify modified/missing Tab markers remain visible after TabStrip refactor.
- [X] T188 Run the 006 Workspace watcher/coordinator suites and verify no 007 Tree projection/search/width code causes never-loaded directories to be read.
- [X] T189 [P] Add a dedicated regression test/harness asserting type-to-search, horizontal width calculation, icon resolution and Footer projection perform zero workspace filesystem reads.
- [X] T190 [P] Add a dedicated regression assertion that only `ExplorerController` changes `selectedPath`/expansion/inlineEdit and virtual row unmount does not alter those fields.
- [X] T191 [P] Add a dedicated regression assertion that Tab Overview/new fixed actions never call `openPath()` for an already-open tab selection and never create duplicate document sessions.
- [X] T192 Audit `src/app/App.tsx` after migration: remove obsolete native-menu refs/install/dispose logic, keep watcher/window lifecycle setup single-instance-safe under React Strict Mode, and avoid turning App into a new UI state dump where a focused store/component owner is clearer.
- [X] T193 Audit `src/app/shell/AppIcon.tsx`/new icon providers: remove duplicated inline SVG glyphs from feature components and ensure all icon color still flows through `currentColor`/tokens.
- [X] T194 Audit `src/styles/*.css` plus wrapper CSS for new hard-coded palette values outside approved token declarations, `!important`, deep selectors, dependency internal selectors and accidental dashboard/card container patterns.
- [X] T195 Audit all imports for `@base-ui/react`; only `src/ui/**` may import it. Audit all imports for `@tanstack/react-virtual`; keep it localized to the Explorer virtualization adapter rather than leaking virtualizer objects into controller/business code.
- [X] T196 Audit `DocumentSession`, `DocumentManagerSnapshot` and Explorer domain models to confirm no visual-only fields (`accent`, `density`, `rowIndex`, virtual range, big/merged Tab style) were added to business state.
- [X] T197 Audit custom window-close code to confirm only approved lifecycle code uses forced `destroy()` after the guard; visual close/menu Exit paths must not create a second unsafe destroy path.
- [X] T198 Run the 10,000-visible-row acceptance fixture and record visible count, rendered row count, overscan configuration and whether mounted rows stay below 200 through full scroll.
- [X] T199 Run the 100-Tab acceptance fixture at wide and narrow window widths; verify one row, min-width floor, horizontal overflow, fixed New/Overview and active reveal.
- [X] T200 Run a long/deep materialized path fixture where the widest row is initially outside the vertical viewport; verify the Tree horizontal scrollbar still reflects that row without mounting all rows.
- [X] T201 Run Explorer quick search while watcher changes add/delete/rebase matching nodes; verify stale matches do not activate wrong rows and no recursive reads occur.
- [X] T202 Run Locate Current File during a WorkContext switch and during active-document rebind; verify stale locate intent cannot select a path in the replacement Workspace.
- [X] T203 Run inline Rename/New while virtual scrolling and watcher reconciliation occur; verify retained draft/blur/commit behavior remains consistent with 004/006 rules.
- [X] T204 Run zero Tab / zero Workspace / Workspace-only / document-only / both-active manual matrix against the new AppShell and Footer.
- [X] T205 Run custom TopBar manual matrix: drag, interactive menu click, minimize, maximize/restore, double-click title region, clean close, dirty Save/Don't Save/Cancel close.
- [X] T206 Run popup/context-menu manual matrix near left/right/top/bottom window edges and while Tree is horizontally scrolled; verify the overlay root prevents clipping.
- [X] T207 Run Sidebar resize manual matrix at 640×400, 1200×780 and large-screen widths; verify no overlap and >640px width is possible only while Editor minimum width is preserved.
- [X] T208 Run 2160p↔1080p cross-monitor manual acceptance and record Windows scale factors, density mode, popup positioning, Tree row alignment, font clarity, Tab overflow and window-control behavior.
- [X] T209 Run browser-only `npm run dev` smoke acceptance after all desktop chrome changes; verify no Tauri-only code crashes the React shell.
- [X] T210 Run `npm run typecheck` and fix every new TypeScript error/warning caused by the migration.
- [X] T211 Run `npm run test` and fix every failing frontend regression; do not weaken existing assertions merely to make the new UI pass.
- [X] T212 Run `npm run build` and fix production bundling/tree-shaking/portal issues, confirming Base UI/TanStack dependencies are included only as needed.
- [X] T213 Run `cargo test` from `src-tauri` and fix any native regression introduced by Tauri configuration/capability-adjacent source changes.
- [X] T214 Re-run the Constitution Check from `plan.md`; document state-owner/action-path/dependency findings and resolve any new violation before marking 007 complete.
- [X] T215 Run the Speckit-style consistency/analyze pass across `spec.md`, `plan.md`, and `tasks.md`: verify every FR/SC/superseded contract is represented, no task implements deferred 008 scope, and no unresolved clarification marker remains.
- [X] T216 Append execution evidence to `tasks.md` only after implementation: exact gate results, test counts, manual acceptance matrix, monitor/DPI environment and any accepted limitation; do not claim unperformed manual checks as PASS.

## Dependencies & Execution Order

### Phase dependencies

1. **Phase 1** is mandatory baseline/setup.
2. **Phase 2** establishes wrappers, tokens, preference/icon/command contracts and blocks any feature component from directly adopting Base UI.
3. **Phase 3 (US1)** establishes custom AppShell/chrome and the `EditorGroup`/Footer structural regions.
4. **Phase 4 (US5)** completes the compact menu/context-menu migration on top of Phase 2/3.
5. **Phase 5 (US2)** can begin after Phase 2 and the stable Sidebar/MainArea shell from Phase 3 exist; it must land before quick-search/Locate UI in Phase 6.
6. **Phase 6 (US3)** depends on the flattened visible-row projection and virtual viewport from Phase 5.
7. **Phase 7 (US4)** depends on the EditorGroup seam from Phase 3 and menu popup wrapper from Phase 2, but is otherwise independent of Explorer navigation.
8. **Phase 8 (US6)** depends on UiPreferences/density tokens from Phase 2 and touches both the shell and virtualizer, so it should land after Phases 5 and 7 are stable.
9. **Phase 9 (US7)** depends on the Footer structural slot from Phase 3 and existing Workspace/document metadata only.
10. **Phase 10 (US8)** depends on the virtualizer and preference systems it observes.
11. **Phase 11** is mandatory convergence/release validation.

### Story independence

- **US1** can be accepted with current Explorer/Tabs temporarily mounted inside the new shell before later migrations.
- **US5** can be accepted by App Menu and Explorer Context Menu keyboard/dismiss/command behavior without virtualization.
- **US2** can be accepted with synthetic Explorer state; it must not require watcher or real filesystem recursion.
- **US3** can be accepted against a fake Workspace reader that records exact directory reads.
- **US4** can be accepted with synthetic `TabSnapshot[]`; it does not need real 100-file I/O.
- **US6** can be accepted with fake preference storage plus manual multi-monitor validation.
- **US7** can be accepted from pure Workspace/document metadata fixtures.
- **US8** can be accepted entirely from development fixtures and virtualizer counters.

### Parallel opportunities

- Pure tests/model work in icon providers, preferences, Footer projection, Tab filtering and Explorer projection can run in parallel after shared types are agreed.
- TopBar window-chrome controller tests and UI primitive wrapper tests can proceed independently.
- Explorer projection/metrics tests can proceed in parallel with AppShell refactor because they do not depend on DOM composition.
- Tab Overview pure filtering tests can proceed before the final TabStrip DOM.
- Footer projection can be built while TabStrip work is underway.
- Do not parallelize two tasks that both restructure `App.tsx`, `Explorer.tsx`, `AppShell.tsx` or the same core CSS block without coordinating integration order.

## Requirement Traceability

The task phases cover the specification as follows:

| Spec area | Primary tasks/phases |
|---|---|
| FR-001–FR-012 AppShell/window chrome | Phase 3, Phase 11 manual close/chrome matrix |
| FR-013–FR-020 primitive/CSS contract | Phase 2, Phase 4, Phase 11 static audits |
| FR-021–FR-025 compact App Menu | Phase 4 |
| FR-026–FR-030 Sidebar/Header action surface | Phase 6 |
| FR-031–FR-045 flattened/virtual Tree + overflow | Phase 5 |
| FR-046–FR-055 quick search/Locate/Collapse | Phase 6 |
| FR-056–FR-060 icon contracts | Phase 2 + Phase 5 integration |
| FR-061–FR-072 TabStrip/EditorGroup | Phase 3 seam + Phase 7 |
| FR-073–FR-079 Footer | Phase 3 seam + Phase 9 |
| FR-080–FR-090 density/preferences/layout | Phase 2 + Phase 8 + Phase 10 |
| FR-091–FR-098 preservation/quality gates | Phase 11 |
| SR-001 fixed `+` supersession | Phase 7 |
| SR-002 Refresh de-emphasis | Phase 6 |
| SR-003 Locate no longer deferred | Phase 6 |
| SR-004 Footer now justified | Phase 3 + Phase 9 |
| SR-005 simple Sidebar preference persistence | Phase 2 + Phase 8 |
| SR-006 native visible menu replaced | Phase 3 + Phase 4 |
| SC-001–SC-012 | Phase 11 acceptance and gates |

## Deferred Guardrail

The following MUST NOT appear as implementation tasks added opportunistically to 007 without reopening the spec: Theme Engine, Light/Dark switcher, Monokai/editor-scheme manager, glass/blur/transparency, background image, smooth caret/advanced motion, full Settings, icon-theme selection, Git UI, Workspace Search/index, split/multiple EditorGroups, merged/big Tabs, Tab user-color settings, shortcut customization, plugin registries or Session/Recovery redesign.

## Completion Definition

007 is complete only when:
- all implementation tasks required by the accepted scope are checked;
- all four repository gates are green;
- the manual custom-chrome / large-Tree / many-Tab / cross-monitor matrix has recorded evidence;
- no data-safety or state-ownership regression is open;
- the final consistency/analyze pass finds no unresolved contradiction between `spec.md`, `plan.md`, and this task list.

## Execution Evidence (T216)

Recorded after implementation on branch `feature-core`, baseline commit
`8c8a9488dc7dfdbd9a7c2bc6e206146b1d9db9f4`, environment: Windows 10.0.19045, Node v25.2.1,
npm 11.6.2, no Tauri/WebView2 interactive session available to this agent.

### Gate results

| Gate | Pre-007 baseline | After 007 |
|---|---|---|
| `npm run typecheck` | exit 0 | exit 0 |
| `npm run test` | 744 tests / 23 files, exit 0 | **1115 tests / 51 files, exit 0** |
| `npm run build` | exit 0 (103.89 kB app + vendor/codemirror chunks) | exit 0 (142.55 kB app + vendor/codemirror chunks; CSS 16.52 kB) |
| `cargo test` (from `src-tauri`) | 145 tests, exit 0 | 145 tests, exit 0 (**no Rust source change**) |

The gate table above is the run recorded after the last convergence task (T230). The earlier runs were
`1107 tests / 50 files` after T227–T230's first pass, `1077 tests / 49 files` after T224/T226, and
`1069 tests / 49 files` before them; every convergence pass was gated green on its own before the next
one started.

New automated coverage added by 007 (28 new test files) includes: the dependency/CSS source
audits, the density and layout two-sided contracts, the preference fallback matrix, the flattened
projection and its purity, horizontal extent with an injected measurer, quick-search identity and
match selection, Locate's ancestor-chain reads (recording reader), Collapse All, Tab
layout/reveal/Overview, the Footer projection matrix, the window-chrome close path (including the
dirty-close Cancel case), the window-capability ACL contract, App Menu availability and
command-registration integrity, the disposable-fixture isolation boundaries and their wiring audits,
and the "UI does zero I/O" guarantees.

### Defect found during desktop verification (fixed)

Launching the desktop shell reported
`window.set_title not allowed on window "main", webview "main", URL: local`. Two causes were found
and fixed; see `plan.md` → “Defect found during desktop verification, and fixed” for the full
analysis:

1. `src-tauri/capabilities/default.json` had lost the baseline `"windows": ["main"]` scope, which
   makes Tauri resolve *no* window pattern for the capability and therefore deny **every**
   `core:window:*` permission in it (not just `set-title`). Restored, with
   `src/app/window/capabilityContract.test.ts` pinning the scope and the permission set.
2. `installWindowLifecycle()` awaited its first `setTitle` unprotected, so a refused title write
   rejected before the close guard was registered — silently removing the unsaved-work guard.
   Title writes are now best-effort, `App.tsx` reports native-surface failures instead of leaking
   an unhandled rejection, and `windowLifecycle.test.ts` proves the guard still blocks a dirty close
   and runs `prepareCloseAll()` exactly once in that situation (FR-008).

A Tab-width defect was found the same way: every Tab reserved the comfortable `--tab-max-width`
instead of sizing to its own name (FR-065 makes that a ceiling, not a default), and `.tab__label`
did not grow, so the slack appeared as a gap after the close button. Tabs are now content-sized and
uniformly squeezed only when they stop fitting; the label measurer also reads the UI font from
`<body>` (where it is declared) rather than `<html>`. See `plan.md` → “Defect found during desktop
verification: Tab width”.

Locate Current File was reported as failing when the opened file's parent folder was not visible in
the Tree. Its ancestor walk required ancestors to be *loaded* while the projection needs them
*expanded*; a collapsed root hid even a direct child; an in-flight read was not waited for; and the
Tree dropped a reveal request whose row was not yet in the projection. All four are fixed, with
exactly one bounded re-read of the file's own directory added for the stale-cache case. The read set
stays on the ancestor chain and sibling branches still receive zero reads (SC-003). See `plan.md` →
“Defect found during desktop verification: Locate Current File”.

The compact App Menu opened with every entry greyed out on the first click after launch. Availability
is read from the command registry, which is filled in the shell's mount effect — after the first
render — and nothing re-rendered the shell before that click, so the popup used a model built from an
empty registry. `CompactAppMenu` now owns its popup's open state (the model is rebuilt when the popup
appears) and the shell re-renders once registration completes. See `plan.md` → “Defect found during
desktop verification: first App Menu open was all greyed out”.


### Manual acceptance matrix — performed by the maintainer (2026-09-19)

**Provenance matters here:** this agent has no display, so it could not and did not run any part of
the manual matrix. The maintainer performed the manual review in a real desktop/browser session and
reported it complete on 2026-09-19; on that basis the manual tasks are marked complete in this list:

`T007`/`T225` (pre- and post-007 manual UI baseline), `T056`/`T209`/`T222` (browser-only smoke),
`T057`/`T205`/`T206`/`T217` (TopBar drag / double-click maximize-once / minimize / maximize / clean
and dirty close), `T070`/`T201`–`T203`/`T223` (context-menu keyboard and dismissal, Refresh during
reconciliation, search during watcher updates, Locate during a Workspace switch, inline edit while
scrolling), `T101`/`T198`/`T200`/`T218` (10,000-row fixture and the off-screen wide row),
`T123` (Refresh while watcher reconciliation is in flight), `T146`/`T199`/`T219` (100-Tab run and
Overview), `T162`–`T164`/`T207`/`T208`/`T220` (Sidebar drag beyond 640 logical px, 2160p↔1080p move,
density repeat), `T177`/`T204`/`T221` (Footer and composition-state matrix), and the remaining
`T199`–`T209` runs. The reviewer's own screenshots/notes are the artifact for these runs; none are
reproduced here, because this agent did not observe them.

The manual review is also what surfaced the defects recorded above — the refused `window.set_title`
(which exposed the missing capability scope and the unguarded title write), the over-wide Tab, the
Locate failure on a collapsed ancestor chain, and the all-greyed-out first App Menu open. Each was
fixed with regression coverage, and the gates were re-run green after every fix.

The two checks that need no display were already covered automatically, and remain so:

- `T200`/SC-006's arithmetic: `explorerTreeMetrics.test.ts` proves the horizontal extent is computed
  from a row that lies outside the vertical viewport, without mounting it.
- `T101`/SC-001's bound: `explorerVirtualRegression.test.ts` proves `maxMountedRows(viewportHeight,
  rowHeight)` stays far below 200 for all three densities at the 1200×780 acceptance size, and that
  the bound depends on the viewport rather than on the 10,000 visible rows.

### Accepted limitations

The three items previously listed here — unverified window dragging, unverified cross-monitor/DPI
behaviour, and the fixtures being observable only in the debug harness — were all part of the manual
matrix and are therefore covered by the maintainer's review above. No limitation from the 007 manual
matrix remains open.

### Convergence tasks closed after the manual review (T224, T226)

Both were implementation gaps raised by the convergence pass, not manual checks, and both are now
implemented and covered:

- **T224** — `app.exit` was the one native window command without a runtime gate, so a browser-only
  session could dispatch it and reach `getCurrentWindow().destroy()` on an unavailable Tauri API
  (contradicting T063). It now declares the same availability the window controls do
  (`chrome.isAvailable()`, i.e. the Tauri runtime), so the compact App Menu shows it disabled in a
  browser-only build. `appMenuAvailability.test.ts` audits that every native window command
  (`app.exit`, `window.minimize`, `window.toggleMaximize`, `window.close`) declares runtime
  availability, and that an unavailable Exit is disabled in the menu model. Dialog-backed commands
  (`file.open`, `workspace.openFolder`, Save As) are deliberately outside that set: T224 scopes the
  gate to the window/Exit commands, and the dialog path reports its own failure through the
  application error surface.
- **T226** — search result navigation revealed a match but never selected it, so arrow-key
  navigation had no logical anchor (partial against US3/AC3). The current match's row is now also
  *selected* while the search is active: `selectableMatchPath` resolves the match key to a logical
  path when it names a real entry, and the Explorer selects it, so the match is identifiable as well
  as visible. Sentinels and the inline-create row still reveal without changing the selection,
  because they carry no selectable path. Covered by `explorerQuickSearch.test.ts` (entry row
  resolves; sentinel, inline-create, missing and empty keys resolve to nothing).

### Convergence tasks closed after the manual review (T227–T230)

Four further gaps raised by the convergence pass, all in the development-only scale harness or in
geometry derived from measured boxes. Each is implemented with regressions; the four gates were run
green after all of them.

- **T227** — the 100-Tab fixture was a static `TabSnapshot[]`: clicking one of its Tabs called
  `DocumentManager.selectDocument("fixture-doc-N")`, which names no session, so nothing happened —
  no active marker moved and no reveal ran (partial against SC-004). The fixture now owns its own
  active state (`activateFixtureTab`), closing one is a harmless list operation
  (`closeFixtureTab`), and `App.tsx` routes a Tab gesture by identity: `isFixtureDocumentId(id)`
  decides between the fixture and the manager, so a fixture id can never reach
  `DocumentManager` even if a gesture arrives after the fixture was switched off. Real document
  ids stay `doc-<n>`, so the two families cannot collide; `uiFixtures.test.ts` pins the routing,
  the exactly-one-active invariant, and that an activation far down the strip produces a reveal
  offset through the strip's own `revealTabOffset`. The Tab Overview activates through the same
  `onSelect` prop, so both paths are covered by that one decision.
- **T228** — `TabStrip` measured only the strip's own width, and only when the Tab count changed.
  Showing the Overview widens the *fixed action region* without changing the strip, so the Tab
  viewport stayed too wide and the Tabs were laid out underneath the fixed actions; a density
  transition resized those controls the same way (partial against FR-066–FR-069, T138). The two
  observed boxes (`stripWidth`, `actionsWidth`) are now the only inputs to `solveTabStrip`, the
  actions element is observed alongside the strip, and `showOverview` participates in the measuring
  effect so the Overview's own width is subtracted before paint. The loop settles because
  `overflows` is monotone in the viewport width — once offered, the Overview cannot turn itself off.
  `tabStrip.test.ts` pins the viewport subtraction, the settle property across six strip widths and
  five Tab counts, the per-density recomputation, that the geometry from the wider observation would
  have overflowed the narrower viewport, and that after reveal no active Tab is ever outside the Tab
  viewport at any width/count/position.
- **T229** — the 10,000-row fixture harness still reached the real application: quick-search
  selection called `ExplorerController.selectPath()` with a fixture path, the context gesture called
  `actions.handleContextMenu()` and derived a menu from the real operation context, and the Header's
  More menu was built from the real Workspace — so a fixture view could run real filesystem
  operations on the Tree behind it. The harness also could not render at all without a real
  Workspace, because the Explorer's no-Workspace early return keyed on the *real* state's context.
  The fixture's own context marker now decides that the harness is on screen
  (`isFixtureExplorerState`), its selection is UI state owned by the Explorer
  (`fixtureExplorerProjection`), and every selection gesture goes through one routing decision
  (`routeExplorerSelection`): a fixture row — click, right-click target or quick-search match —
  becomes fixture-local state and never a controller path. The Header offers no real-Workspace
  actions while a different Tree is displayed, F2/Delete dispatch nothing, and the context popup is
  suppressed while the gesture target is still recorded
  (`ExplorerContextMenu.suppressPopup`). `explorerFixtureIsolation.test.ts` proves each boundary
  against a real controller with a recording reader: the fixture renders standalone, the projection
  differs from the fixture model in at most `selectedPath`, no fixture path is ever routed to the
  controller, and a quick-search selection inside the fixture performs zero reads and leaves the real
  selection untouched.
- **T230** — `aria-activedescendant` was derived from the first-to-last mounted virtual index span.
  The set is not a span: the range extractor pins an off-screen inline-edit row into it (FR-037), so
  a row between the viewport range and the pinned row has *no* element while lying inside the span —
  and naming it points assistive technology at nothing (partial against T096). Mounted-ness is now
  tested per index (`activeDescendantFor`), and the pinning itself is one pure helper
  (`withPinnedIndex`) that the component's range extractor uses. `explorerTreeMetrics.test.ts` pins
  the non-contiguous mounted set, the pinned and in-range hits, the no-selection and empty-set cases,
  and the same behaviour on the real 10,000-row projection.

The four behavioural boundaries above are pure decisions, so they are also pinned *in the wiring*:
`fixtureIsolationAudit.test.ts` reads `App.tsx`, `Explorer.tsx` and `ExplorerVirtualTree.tsx` and
asserts that the strip receives the routed Tab callbacks, that `manager.selectDocument` has exactly
one call site and it sits behind `isFixtureDocumentId`, that `controller.selectPath` has exactly one
call site and it sits inside the `routeExplorerSelection` decision, that the harness is decided from
the fixture's own marker rather than the raw prop, and that the active descendant no longer compares
against the first-to-last virtual span. This is the same static-audit technique the dependency, CSS,
icon and menu-registration contracts already use, and it is what makes the T229 defect (an effect
calling `controller.selectPath` with a fixture match) unable to return silently.

## Phase 12: Convergence

- [X] T217 Perform the desktop custom-chrome acceptance matrix in a real Tauri/WebView2 session and record PASS/FAIL evidence: TopBar drag, double-click on the non-interactive drag region dispatching `window.toggleMaximize` exactly once, interactive descendants dispatching it zero times, minimize, maximize/restore, clean close, and dirty close through Save / Don't Save / Cancel per SC-008, US1/AC4-7, FR-007, FR-008, T057, T205, T206 (missing)
- [X] T218 Feed the shared T008 10,000-row fixture into a real viewport and record visible rows, rendered/mounted row count, overscan configuration and whether the mounted count stays below the SC-001 bound through a full top-to-bottom scroll; then run the wide/deep path fixture whose widest row starts outside the vertical viewport and verify the rendered horizontal scrollbar reflects it without mounting every row per SC-001, SC-006, US2/AC2, FR-036, FR-043, T101, T198, T200 (missing)
- [X] T219 Run the shared T009 100-Tab fixture at wide and narrow window widths and record evidence for one-row layout, the minimum-width floor, horizontal overflow, fixed New/Overview, active-Tab reveal from both the Explorer and the Overview activation paths, and Overview filtering per SC-004, US4/AC3-6, FR-064-FR-069, T146, T199 (missing)
- [X] T220 Run the Sidebar/layout acceptance matrix and record evidence: 640x400 minimum window with Sidebar and EditorWorkspace both visible and non-overlapping, 1200x780, Sidebar dragged from minimum to beyond 640 logical px while at least 320 logical px remain for EditorWorkspace, a 2160p<->1080p window move including the configured Windows scale factors, and a Compact/Default/Comfortable density repeat after the move per SC-005, SC-007, FR-010, FR-083, FR-084, T162-T164, T207, T208 (missing)
- [X] T221 Run the composition/Footer state matrix and record evidence for zero-Tab, zero-Workspace, Workspace-only, document-only and both-present states, including Footer breadcrumb/format agreement with application-owned metadata and the narrow-window truncation order per SC-011, US1/AC1-3, US1/AC9, US7/AC1-6, T177, T204 (missing)
- [X] T222 Run the browser-only `npm run dev`/build smoke acceptance with Tauri APIs unavailable and confirm the shell renders without native-control exceptions or rejected native IPC calls per US1/AC8, US5/AC8, FR-024, T056, T209 (missing)
- [X] T223 Run the Explorer interaction acceptance matrix in a real session and record evidence: context-menu keyboard focus/arrow navigation/Escape and outside-press dismissal without asserting dependency internals; a manual Refresh while watcher reconciliation is in flight; quick search while watcher changes add/delete/rebase matching nodes; Locate Current File during a WorkContext switch and an active-document rebind; and inline Rename/New while virtual scrolling and reconciliation occur per US2/AC6, US3/AC4, US3/AC10, FR-037, FR-048, FR-049, FR-093, T070, T123, T201-T203 (missing)
- [X] T224 Gate `app.exit` on the Tauri runtime the way the window controls already are (runtime-aware availability or omission from the compact App Menu) so browser-only development cannot reach `getCurrentWindow().destroy()`, and pin the behaviour with a menu-availability test per plan: browser/Tauri split, FR-024, T063 (contradicts)
- [X] T225 Capture the post-007 manual UI baseline (screenshots/notes for zero-tab, Workspace+Explorer, many Tabs, context menu and dirty-close) so later visual work in 008 can be compared against the 007 structure per T007 (missing)
- [X] T226 Move Explorer quick-search result navigation beyond viewport reveal: the current match must become visible *and* identifiable (selection through `ExplorerController` and/or an explicit current-match presentation) so arrow-key result navigation has a logical selection anchor rather than only a scroll offset per US3/AC3, FR-048, T110 (partial)

## Phase 13: Convergence

- [X] T227 Make the development-only 100-Tab fixture own UI-only active state while enabled so direct Tab and Tab Overview selection update exactly one fixture Tab, trigger active-Tab reveal, and never call the real document manager with fixture IDs; make fixture close behavior harmless and add regressions for direct and Overview activation/reveal per SC-004, T183, T219 (partial)
- [X] T228 Recompute TabStrip overflow and active-Tab reveal whenever the actual Tab viewport or fixed action region changes size, including Overview visibility and runtime density transitions, and add regressions proving New/Overview never cover the active Tab per FR-066-FR-069, SC-004, T138 (partial)
- [X] T229 Make the development-only 10,000-row Explorer fixture fully filesystem-free and read-only: render it without a real Workspace, keep quick-search selection and context targeting inside disposable fixture UI state, prevent fixture paths from reaching the real controller/actions, and add regressions for these isolation boundaries per plan: T182 debug workflow, FR-089, FR-095 (contradicts)
- [X] T230 Derive Explorer `aria-activedescendant` from exact membership in the mounted virtual-item set rather than the first-to-last virtual index span, and add a regression with a pinned off-screen inline-edit row proving an unmounted selected row is never referenced per FR-037, T096 (partial)

