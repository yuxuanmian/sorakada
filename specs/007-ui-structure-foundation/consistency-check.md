# 007 Consistency / Analyze Report

**Feature**: `007-ui-structure-foundation`  
**Analyzed**: 2026-09-19  
**Baseline reviewed**: `feature-core` @ `8c8a9488dc7dfdbd9a7c2bc6e206146b1d9db9f4`

## Inputs Reviewed

- `spec.md`
- `plan.md`
- `tasks.md`
- `.specify/memory/constitution.md`
- `.specify/templates/spec-template.md`
- `.specify/templates/plan-template.md`
- `.specify/templates/tasks-template.md`
- `AGENTS.md`
- Relevant current repository implementation in `src/app/App.tsx`, `src/app/shell/**`, `src/app/explorer/**`, `src/app/tabs/**`, `src/app/menu/**`, `src/app/document/**`, `src/editor/**`, `src/styles/**`, `src-tauri/tauri.conf.json`, and `src-tauri/capabilities/default.json`
- Historical/superseded contracts from 003/004/005/006 that affect Shell, Explorer, Refresh, TabBar and watcher behavior

## Automated Structural Checks

| Check | Result |
|---|---|
| Functional requirements | PASS — FR-001 through FR-098 are contiguous and unique |
| Success criteria | PASS — SC-001 through SC-012 are contiguous and unique |
| Superseded requirements | PASS — SR-001 through SR-006 are contiguous and unique |
| Task ids | PASS — T001 through T216 are contiguous and unique |
| User-story task tags | PASS — only US1 through US8 are referenced |
| Clarification placeholders | PASS — no unresolved clarification marker remains |
| Template placeholders | PASS — no unresolved feature/date/argument template placeholder remains |
| Required repository gates | PASS — typecheck/test/build/cargo-test tasks are all present |
| Constitution check | PASS — all five principles have an explicit plan check |
| Deferred scope guard | PASS — Theme/Glass/Settings/Split/Git/Search/plugin systems remain explicitly deferred |

## Cross-Document Coverage

| Specification area | Plan decision | Task coverage | Result |
|---|---|---|---|
| Custom TopBar/AppShell/close guard | Sections 2–4, 22 | Phases 2–4, 11 | PASS |
| Headless primitive boundary | Sections 1, 20 | Phases 2, 4, 11 | PASS |
| Compact App Menu | Sections 3, 22 | Phase 4 | PASS |
| Explorer flattening | Section 8 | Phase 5 | PASS |
| Tree virtualization | Section 9 | Phase 5 + Phase 11 scale run | PASS |
| Virtualization + inline edit | Section 9 focus/pinning rule | Phase 5 | PASS |
| Horizontal overflow under virtualization | Section 10 | Phase 5 + Phase 11 | PASS |
| IDEA-like indent guides | Section 11 | Phase 5 | PASS |
| Type-to-search, visible nodes only | Section 13 | Phase 6 + no-I/O acceptance | PASS |
| Locate exact ancestor chain | Section 14 | Phase 6 + stale/I/O tests | PASS |
| Refresh de-emphasis | Section 15 | Phase 6 | PASS |
| Icon provider seams | Section 12 | Phases 2, 5 | PASS |
| EditorGroup structural seam | Sections 4, 16 | Phases 3, 7 | PASS |
| Many-Tab behavior | Sections 16–17 | Phase 7 + Phase 11 100-Tab run | PASS |
| Footer/breadcrumb/status | Section 18 | Phases 3, 9 | PASS |
| Density and Sidebar layout | Sections 5–7 | Phases 2, 8 | PASS |
| Simple preference persistence | Section 5 | Phases 2, 8 | PASS |
| UI debug without Settings | Section 21 | Phase 10 | PASS |
| 001–006 preservation | Throughout + testing strategy | Phase 11 | PASS |

## Issues Found During Analyze and Corrections Applied

### A-001 — Native menu migration order
**Initial issue**: A shell-phase task attempted to retire the native visible menu before the compact WebView menu phase had completed, creating an implementation-order gap in discoverability.

**Correction**: Native menu retirement now happens only after `CompactAppMenu` is wired and acceptance-ready. The shell phase may temporarily keep the prior native menu during incremental work.

**Status**: RESOLVED.

### A-002 — Preferred Sidebar width vs passive clamp
**Initial issue**: One task said to persist the final clamped width while another required the user's large-screen width to return after a temporary narrow-window clamp. Those behaviors conflict.

**Correction**: `UiPreferences.sidebarWidth` is now explicitly the user's preferred logical width. Current layout computes a safe rendered clamp without overwriting the preference on passive window/display resize. Explicit drag/reset changes the preference.

**Status**: RESOLVED.

### A-003 — Virtualized row focus loss
**Initial issue**: A recyclable Tree row owning keyboard focus can unmount when scrolled away, unintentionally losing Explorer keyboard scope and breaking type-to-search/F2/Delete behavior.

**Correction**: The plan/tasks now require a stable Explorer/Tree viewport focus owner. Logical selection is independent of virtual row DOM; accessible row state is exposed through active-descendant/level metadata where practical.

**Status**: RESOLVED.

### A-004 — Inline edit unmount causing accidental blur/cancel
**Initial issue**: 004 defines meaningful inline-edit blur behavior. A virtualizer that unmounts an active rename/create input would manufacture a blur/cancel merely because the row left the viewport.

**Correction**: FR-037, plan and tasks now require the active inline-edit row to be pinned/included in the virtual range until the edit ends.

**Status**: RESOLVED.

### A-005 — Horizontal overflow vs vertical virtualization
**Initial issue**: With off-screen rows unmounted, natural DOM `scrollWidth` cannot know about the widest materialized Tree row. That would violate the requested deep/long-path horizontal-scroll fallback.

**Correction**: 007 now has an explicit Tree horizontal-metrics projection using already-materialized visible rows plus cached text measurement/depth metrics. It produces horizontal extent without mounting all rows or reading unopened directories.

**Status**: RESOLVED.

### A-006 — Footer Workspace relation ambiguity
**Initial issue**: A breadcrumb requirement said "derive Workspace relation" without identifying whether the UI would accidentally fall back to lexical path prefix checks or create a new relation owner.

**Correction**: Spec/plan/tasks now require existing canonical `WorkContext.comparisonKey` + `DocumentSession.pathIdentity.comparisonKey` semantics (for example `relativeWithinDirectory`) or the existing relation service. Display casing comes from the user-facing document path; no lexical `startsWith()` containment is allowed.

**Status**: RESOLVED.

### A-007 — Explorer creation discoverability after Header simplification
**Initial issue**: Replacing New File/New Folder/Refresh Header buttons with Locate/Collapse/More could leave New File/New Folder discoverable only by context menu.

**Correction**: `More` now explicitly includes New File/New Folder when the shared operation context permits them, plus Refresh; context-menu behavior remains intact.

**Status**: RESOLVED.

### A-008 — Debug menu action path
**Initial issue**: A clickable development UI Debug menu could bypass the constitution's single-command execution rule if it mutated debug state directly.

**Correction**: Tasks now require stable debug command ids/handlers for clickable debug menu toggles, still guarded to development builds and stored separately from persisted preferences.

**Status**: RESOLVED.

### A-009 — Browser-only native command failure
**Initial issue**: Once the compact App Menu exists in browser-only Vite mode, native window/Exit actions could become visible while their Tauri APIs are unavailable.

**Correction**: Shell/menu tasks now require native-only commands to have runtime-aware availability or omission; browser-capable commands remain usable.

**Status**: RESOLVED.

### A-010 — Footer right-side scope too optional
**Initial issue**: The structural Footer was required, but the initial right-side status was phrased as optional despite the product decision that a conventional lower-right status area matters.

**Correction**: FR-076 now requires existing UTF-8 and preferred LF/CRLF metadata when a document is active. Rich cursor/language/indentation controls remain deferred.

**Status**: RESOLVED.

### A-011 — Base UI boundary task allowed an exception
**Initial issue**: T017 allowed a documented direct `@base-ui/react` import outside
`src/ui/**`, while FR-014 and the plan make that boundary unconditional.

**Correction**: T017 now fails every out-of-boundary import and explicitly permits
no 007 exception.

**Status**: RESOLVED.

### A-012 — TopBar double-click had validation but no implementation task
**Initial issue**: US1 required double-click maximize/restore and the manual matrix
tested it, but no task wired the drag-region gesture to the canonical command.

**Correction**: FR-007, the plan, T036 and T042 now require and test exactly-once
dispatch through `window.toggleMaximize`, excluding interactive descendants.

**Status**: RESOLVED.

### A-013 — EditorWorkspace minimum width was not frozen
**Initial issue**: SC-005 referred to a defined minimum Editor width, while the
specification and plan left the value for implementation to choose.

**Correction**: The minimum is now frozen at 320 CSS logical pixels and is used by
FR-083, SC-005, the layout formula and T150/T151 acceptance tests.

**Status**: RESOLVED.

### A-014 — Context-menu migration order differed between plan and tasks
**Initial issue**: The plan placed context-menu migration after virtualization,
while the task sequence migrated it first and already referred to virtual rows.

**Correction**: The plan now explicitly migrates the controlled Explorer-level
context surface before virtualization. T069 establishes the reusable target and
T102 verifies its later virtual-row/background integration.

**Status**: RESOLVED.

### A-015 — Large-Tree fixture tasks could create three implementations
**Initial issue**: T008, T101 and T182 each used creation language for a 10,000-row
fixture.

**Correction**: T008 owns the one shared generator; T101 uses it for acceptance and
T182 exposes it through development-only UI.

**Status**: RESOLVED.

### A-016 — Non-measurable responsiveness wording
**Initial issue**: The plan used “perceptually immediate” without a threshold.

**Correction**: The performance goal now uses the existing measurable mounted-row
bound and zero-filesystem-I/O constraint.

**Status**: RESOLVED.

## Supersession / Historical Contract Check

- **004 scrolling Tab `+`**: explicitly superseded; 007 fixes New in a non-scrolling action region and adds Tab Overview.
- **003 prominent Header Refresh**: explicitly superseded in presentation only; 006 reconciliation command remains unchanged.
- **003 Locate deferred**: explicitly superseded by an explicit bounded Locate command; automatic Tab-to-Tree sync remains forbidden.
- **003 no-empty-StatusBar rule**: no conflict; 007 Footer is now justified and populated.
- **003 non-persistent Sidebar layout**: explicitly superseded by small `UiPreferences` persistence.
- **Native visible File/Edit/View menu**: superseded in presentation by compact TopBar menu; command/keymap ownership is preserved.
- **005/006 watcher/data-safety rules**: no supersession; 007 is required to preserve them.

## Constitution Review

### I. User Data Is Inviolable
PASS. No document save/baseline logic is moved into UI. Custom close goes through the existing guard. Tree search/measurement is read-free.

### II. State Has One Owner
PASS. New state owners are narrow:
- `UiPreferencesStore`: density/sidebar preferences only
- `UiDebugOptions`: non-persisted diagnostics only
- virtualizer/quick-search/Tab overview: presentation-only derived state

Document, Workspace and Explorer facts remain with their established owners.

### III. Contracts Are Verified From Both Sides
PASS. No filesystem/document IPC contract change is required. Custom Tauri window capability/config changes are explicitly manual-tested in the desktop environment.

### IV. Commands Have One Execution Path
PASS after A-008/A-009 fixes. App Menu, TopBar window buttons, Explorer actions and debug menu actions use command ids/handlers.

### V. Scope and Complexity Must Be Earned
PASS. The two runtime dependencies map directly to current requirements. Theme Engine, Settings, split editor, icon-theme framework, Git UI and Workspace Search remain deferred.

## Remaining Risks (Not Clarifications)

These are implementation risks, not unresolved product decisions:

1. **Tauri custom chrome details on Windows/WebView2** — must be validated manually after `decorations:false`, especially dragging, double-click maximize and DPI transitions.
2. **Base UI portal/context-menu integration with a virtualized Tree** — use one controlled Explorer-level context target or otherwise ensure a recycled row cannot become authoritative menu state.
3. **React 19 + TanStack Virtual scrolling behavior** — start with the planned React-19-safe configuration and tune overscan only from measured behavior.
4. **Canvas/text measurement for horizontal extent** — cache and invalidate carefully; correctness is more important than exact pixel tightness, and overestimation is preferable to clipping.
5. **Cross-monitor DPI** — cannot be fully proven by unit tests; the explicit 2160p/1080p manual matrix is mandatory.

None of these requires a new product decision before implementation.

## Final Analyze Result

**PASS after corrections.**

The three core documents are mutually consistent at the current design level:
- 98 functional requirements
- 12 measurable success criteria
- 6 explicit superseded contracts
- 8 user stories
- 216 detailed implementation/validation tasks
- 0 unresolved clarification markers
- 0 Constitution exceptions

007 remains correctly cut at **UI structure/foundation**. Final themes, Monokai, glass/blur, rich motion, full Settings, split EditorGroups, Git UI and Workspace Search have not leaked into implementation scope.
