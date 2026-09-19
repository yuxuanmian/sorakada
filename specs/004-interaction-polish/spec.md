# Feature Specification: Interaction Polish

**Implementation Branch**: `feature-core` (this feature intentionally shares the integration branch; the Spec Kit feature pointer is `specs/004-interaction-polish`)

**Created**: 2026-09-19

**Status**: Ready for implementation — behavior frozen

**Input**: Refine the completed 003 Workspace/Explorer interaction model without redesigning its filesystem, document, Workspace, or command architecture. The feature covers directory click semantics, file context-menu scope, inline-edit blur behavior, TabBar `+` placement, and CodeMirror selection rendering. The known WebView2 cursor-disappearance issue is explicitly deferred.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Select and Expand Directories Predictably (Priority: P1)

A user can select a directory without accidentally expanding it, and can expand or collapse it through either the chevron or a deliberate double-click on the directory row.

**Why this priority**: Directory selection and navigation are high-frequency Explorer interactions. Selection and expansion must not be coupled to a single ordinary click.

**Independent Test**: Open a Workspace with an unloaded directory, single-click its row, click its chevron, and double-click its row while observing selection, expansion, and directory-read behavior.

**Acceptance Scenarios**:

1. **Given** a collapsed directory is visible, **When** the user single-clicks the directory row outside the chevron, **Then** the directory becomes selected and its expanded state does not change.
2. **Given** an unloaded collapsed directory is visible, **When** the user single-clicks the directory row outside the chevron, **Then** no child-directory read is started solely by that selection click.
3. **Given** a directory is visible, **When** the user clicks its chevron once, **Then** its expanded state is toggled once and the click does not change Explorer selection.
4. **Given** a directory row is visible, **When** the user double-clicks the row outside the chevron, **Then** the directory becomes selected and its expanded state is toggled exactly once for that double-click gesture.
5. **Given** a file row is visible, **When** the user single-clicks it, **Then** it is selected without opening; **When** the user double-clicks it, **Then** it opens or activates through the existing document-open pipeline.
6. **Given** the user double-clicks directly on a directory chevron, **When** the browser emits the associated click/double-click events, **Then** the chevron interaction MUST NOT bubble into the directory-row double-click handler and cause an additional row-level toggle.

---

### User Story 2 - See Context Actions That Belong to the Target (Priority: P1)

A user who right-clicks a file sees actions that operate on that file, while creation actions remain available from directory/root contexts and from the Explorer header.

**Why this priority**: `New File` and `New Folder` in a file's context menu read as operations on that file even though 003 intentionally resolves creation to its parent directory. The menu should communicate the target more directly without changing the underlying creation model.

**Independent Test**: Right-click a file, a directory, and Explorer blank space; compare the menu items and then use the Explorer header while a file remains selected.

**Acceptance Scenarios**:

1. **Given** a file node is right-clicked, **When** its context menu opens, **Then** `New File` and `New Folder` are not shown.
2. **Given** a file node is right-clicked, **When** its context menu opens, **Then** file-appropriate actions such as Rename and Delete remain available according to the existing command rules.
3. **Given** a directory node is right-clicked, **When** its context menu opens, **Then** New File and New Folder remain available together with the existing directory-appropriate actions.
4. **Given** Explorer blank space or the Workspace root context is used, **When** its context menu opens, **Then** New File and New Folder remain available together with the existing root-appropriate actions.
5. **Given** a file remains the persistent Explorer selection, **When** the user presses the Explorer-header New File or New Folder button, **Then** creation still targets the selected file's parent directory exactly as defined by 003.
6. **Given** the file context menu omits creation actions, **When** command availability is evaluated elsewhere, **Then** the omission MUST NOT disable or redefine the shared Explorer creation commands themselves.

---

### User Story 3 - Dismiss Uncommitted Inline Edits Safely (Priority: P1)

A user can leave an unfinished inline New/Rename field without leaving a hidden pending edit behind or accidentally creating a partially named filesystem entry.

**Why this priority**: The current inline editor survives focus loss and becomes difficult to cancel. At the same time, a blur must not cancel an explicit Enter commit that has already started asynchronously.

**Independent Test**: Start New File, New Folder, and Rename; type partial names; move focus away; then repeat while pressing Enter before focus changes, including a forced create/rename failure.

**Acceptance Scenarios**:

1. **Given** an inline New File editor is active and Enter has not started a commit, **When** the input loses focus, **Then** the inline edit is cancelled and no filesystem entry is created.
2. **Given** an inline New Folder editor is active and Enter has not started a commit, **When** the input loses focus, **Then** the inline edit is cancelled and no filesystem entry is created.
3. **Given** an inline Rename editor is active and Enter has not started a commit, **When** the input loses focus, **Then** the rename draft is cancelled and the filesystem name is unchanged.
4. **Given** any inline editor is active and no commit attempt is in flight, **When** the user presses Escape, **Then** the existing explicit-cancel behavior remains unchanged.
5. **Given** any inline editor is active, **When** the user presses Enter, **Then** commit intent is established before the asynchronous filesystem operation begins. While that attempt is in flight, repeated Enter MUST NOT start another commit and Escape MUST NOT retroactively cancel the already-started attempt.
6. **Given** Enter has already established commit intent, **When** the input subsequently loses focus while that commit attempt is in flight, **Then** the blur MUST NOT cancel or invalidate that already-started commit attempt.
7. **Given** an Enter-triggered create/rename attempt fails or otherwise returns with the inline draft retained, **When** the failure handling completes, **Then** the same draft remains editable and editing focus is restored to the inline input when that input still belongs to the current Explorer context.
8. **Given** a Create attempt returns `retained` because its draft is empty/incomplete, or a Create/Rename failure retains the current draft, **When** editing resumes, **Then** a later ordinary blur once again acts as cancellation. An unchanged or empty Rename remains the existing 003 close-without-mutation case and does not retain an editor.
9. **Given** Refresh or WorkContext replacement occurs, **When** an uncommitted inline edit exists, **Then** the existing 003 cancellation/stale-context behavior remains authoritative; 004 does not redefine filesystem mutation reconciliation.

---

### User Story 4 - Keep the New-Tab Button with the Tab Strip (Priority: P2)

A user sees the TabBar `+` immediately after the last document Tab rather than pinned to the far right of the TabBar.

**Why this priority**: The `+` represents adding another document to the current Tab sequence and should visually belong to that sequence.

**Independent Test**: Observe the TabBar with zero, few, and overflowing Tabs; create new Tabs and switch among old Tabs.

**Acceptance Scenarios**:

1. **Given** one or more Tabs are open, **When** the TabBar is rendered, **Then** the `+` appears directly after the final Tab in Tab order.
2. **Given** zero Tabs are open, **When** the TabBar is rendered, **Then** the `+` remains available as the first item in the Tab strip.
3. **Given** the Tab strip overflows horizontally, **When** the user scrolls away from the end, **Then** the `+` is allowed to leave the viewport because it belongs to the scrolling Tab strip rather than a fixed control region.
4. **Given** the final Tab becomes active or a newly created Tab is appended and activated, **When** the active item is brought into view, **Then** the trailing `+` is also brought into view so the final Tab and `+` are both visible and the user can immediately create another Tab.
5. **Given** the user activates an older non-final Tab, **When** active state changes, **Then** the `+` does not move next to the active Tab; it remains after the final Tab.
6. **Given** the user activates the `+`, **When** the action is dispatched, **Then** it remains strictly equivalent to File > New / Ctrl+N / `createUntitled()` and does not create a Workspace file.

---

### User Story 5 - See Text Selection Clearly Across Partial Lines (Priority: P2)

A user can clearly see every selected text segment in CodeMirror, including partial first/last lines and selections that overlap the active line.

**Why this priority**: Selection feedback is a fundamental editor interaction. A line background must not visually erase the editor's selection layer.

**Independent Test**: Make a selection beginning midway through one line, spanning a complete middle line, and ending midway through a third line while the active-line highlight is visible.

**Acceptance Scenarios**:

1. **Given** a single-line partial selection, **When** the editor is focused, **Then** the selected characters have a visible selection background.
2. **Given** a selection starts midway through line A, includes all of line B, and ends midway through line C, **When** it is rendered, **Then** all three selected portions show continuous and visible selection background appropriate to their selected ranges.
3. **Given** part of the selection intersects the active line, **When** both selection and active-line styling are rendered, **Then** the active-line background does not obscure the selected region.
4. **Given** the existing application color-token/theme boundary, **When** selection rendering is corrected, **Then** the fix continues to use the existing application styling system rather than introducing an independent editor palette or a new theme subsystem.
5. **Given** CodeMirror's existing selection/history/document architecture, **When** the visual fix is applied, **Then** no document content, selection state, history state, or React document model behavior is changed solely to obtain the desired rendering.

---

### Edge Cases

- A directory row double-click consists of ordinary click events followed by a double-click event; the implementation MUST avoid adding an extra row-level toggle from a chevron double-click.
- A file right-click still selects that file before the reduced context menu is derived.
- Omitting creation items from the file context menu is a presentation/surface rule only; a selected file remains a valid creation context for the Explorer header, targeting its parent directory.
- Blur cancellation applies only before an explicit commit attempt is active. It MUST NOT be implemented as an unconditional `onBlur -> cancel` that races Enter-triggered async work.
- If an async commit attempt fails after a native error dialog temporarily steals focus, the retained inline draft must remain usable rather than becoming a stranded, unfocused edit.
- If the WorkContext changes while a commit is already in flight, existing 003 origin/generation guards remain responsible for preventing stale Tree mutation; 004 does not weaken those guards.
- The TabBar `+` follows Tab order, not active-document identity. Activating an older Tab MUST NOT reorder either Tabs or the `+`.
- Moving the `+` into the scroll area MUST NOT change zero-document behavior or document creation semantics.
- Selection rendering must be checked with both the active line inside and outside the selected range.

## Functional Requirements

### Explorer Row Interaction

- **FR-001**: Single-clicking a file row MUST select it without opening it.
- **FR-002**: Double-clicking a file row MUST continue to open/activate it through the existing document-open pipeline.
- **FR-003**: Single-clicking a directory row outside its chevron MUST select it without changing its expanded state.
- **FR-004**: Double-clicking a directory row outside its chevron MUST toggle that directory's expanded state exactly once for the row double-click gesture.
- **FR-005**: Clicking a directory chevron MUST toggle expansion without changing persistent Explorer selection, and chevron double-click events MUST NOT bubble into the row double-click toggle.

### Context-Menu Surface Rules

- **FR-006**: A file-node context menu MUST NOT show New File or New Folder.
- **FR-007**: Directory and Workspace-root/blank-space context menus MUST continue to show creation actions when the existing creation command is available.
- **FR-008**: The Explorer header MUST continue to expose New File/New Folder according to the existing shared command availability.
- **FR-009**: A selected file MUST remain a valid creation context whose parent directory is the creation target for non-context-menu surfaces.
- **FR-010**: File-context menu filtering MUST NOT change `FileOperationContext` path targeting, shared command ids, or the underlying create operation.

### Inline Editing

- **FR-011**: Inline New File, New Folder, and Rename MUST treat ordinary input blur as cancellation only while no Enter-triggered commit attempt is active.
- **FR-012**: Blur cancellation MUST discard only the transient inline draft and MUST NOT perform any filesystem create/rename operation.
- **FR-013**: Enter MUST establish commit intent synchronously before awaiting create/rename work so a subsequent blur cannot cancel the active commit attempt; while that attempt is active, repeated Enter MUST NOT start a duplicate commit.
- **FR-014**: Escape MUST retain its existing explicit-cancel behavior when no commit attempt is active; once Enter has started a commit attempt, Escape MUST NOT retroactively cancel that in-flight operation.
- **FR-015**: When an Enter-triggered commit succeeds, existing 003 success reconciliation behavior MUST remain unchanged. An empty Create draft MUST return `retained`; an unchanged or empty Rename that existing 003 behavior closes without mutation MUST continue to close and report `committed`.
- **FR-016**: When an Enter-triggered commit attempt finishes with the inline draft retained, the input MUST return to the normal editable state and regain focus when it still belongs to the current Explorer context.
- **FR-017**: 004 MUST NOT replace inline editing with a modal/popup UI; a future dedicated create/rename surface may supersede these inline-specific blur semantics.

### TabBar New Control

- **FR-018**: The TabBar `+` MUST be rendered inside the same horizontally scrolling strip as document Tabs, immediately after the final Tab.
- **FR-019**: With zero Tabs, the TabBar `+` MUST remain present and usable.
- **FR-020**: The TabBar `+` MAY leave the viewport when the user scrolls away from the strip end; 004 no longer requires it to remain fixed during overflow.
- **FR-021**: When the final Tab is active, the TabBar MUST reveal both that Tab and the trailing `+` without reordering Tabs.
- **FR-022**: The TabBar `+` MUST continue to dispatch the same Untitled-document New command as Ctrl+N and File > New.

### CodeMirror Selection Rendering

- **FR-023**: Focused CodeMirror text selections MUST display a visible background for partial-line and full-line selected ranges.
- **FR-024**: Active-line styling MUST NOT visually cover or erase the selection background where the two overlap.
- **FR-025**: Selection rendering MUST continue to use CodeMirror's existing selection mechanism and application styling tokens; 004 MUST NOT mirror selection/document state into React to solve a visual issue.
- **FR-026**: The selection rendering fix MUST NOT alter editor history, cursor/selection semantics, document content, or document lifecycle behavior.

### Scope and Preservation

- **FR-027**: 004 MUST preserve the completed 003 lazy-loading, Refresh, symlink/junction cycle protection, stale WorkContext guards, disk-first mutation rules, path ownership, and document coordination semantics.
- **FR-028**: 004 MUST NOT require Rust/Tauri filesystem-command changes, DocumentManager redesign, WorkContext redesign, new command ids, new application settings, or a generic context-menu/panel framework.
- **FR-029**: The WebView2 mouse-pointer disappearance observed around native dialogs is a known deferred compatibility issue and is NOT part of the 004 implementation scope.

## Superseded Requirements

004 intentionally changes the following completed 003 interaction contracts. The 003 specification remains a historical record of that milestone; the requirements below take precedence from 004 onward.

### SR-001 - Directory Single-Click Expansion

**Previous 003 behavior**: 003 User Story 3 acceptance scenario 3 and its implementation task T040 coupled a directory-row single click to both selection and expand/collapse behavior.

**004 behavior**: A directory-row single click only selects. Expansion/collapse is performed by the chevron or by double-clicking the directory row. Directory selection remains independent from document opening and does not itself trigger a lazy child read.

### SR-002 - Creation Actions in a File Context Menu

**Previous 003 behavior**: 003 User Story 8 acceptance scenario 3 exposed New File and New Folder when right-clicking a file, with creation targeting the selected file's parent. FR-080 broadly required context menu, header, and keyboard surfaces to share the same target-resolution and availability rules.

**004 behavior**: A file context menu no longer shows New File/New Folder. This supersedes only the context-menu presentation/availability equivalence for those two items. The 003 selected-file creation target rule (FR-051) remains valid for the Explorer header and any future non-file-context-menu creation surface. Shared command ids, operation-context derivation, and underlying create behavior remain unchanged.

### SR-003 - Fixed TabBar New Button

**Previous 003 behavior**: 003 FR-018, User Story 10 acceptance scenario 3, and task T021 kept the TabBar `+` fixed outside the horizontally scrolling Tab area so it remained visible during overflow.

**004 behavior**: The `+` belongs to the scrolling Tab strip and is rendered immediately after the final Tab. It remains present with zero Tabs but may scroll out of view when the user navigates away from the strip end.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Repeated single-click selection of an unloaded directory changes selection without changing expansion state or increasing that directory's read count.
- **SC-002**: Chevron clicks and directory-row double-clicks toggle expansion with no additional unintended row-level toggle from event bubbling.
- **SC-003**: In manual and automated context-rule checks, a file context menu contains no New File/New Folder items while the Explorer header can still create beside the selected file using its parent directory.
- **SC-004**: For New File, New Folder, and Rename, losing focus before Enter leaves no filesystem mutation and no lingering inline editor state.
- **SC-005**: For an Enter-triggered create/rename attempt, focus loss during the async operation never cancels the started attempt; on a retained failure draft, the same draft is editable again with focus restored when its context still exists.
- **SC-006**: With zero, few, and overflowing Tabs, the `+` always occupies the logical position immediately after the final Tab; activating an older Tab never relocates it next to that active Tab.
- **SC-007**: In the default application theme, a three-line selection with partial first/last lines produces a non-transparent `--color-selection`-derived background on every CodeMirror selection fragment. When a selected fragment overlaps the active line, the active-line rule does not replace or visually cover that background, and no document/editor state changes are introduced.

## Assumptions

- 003 is complete and the implementation base is the `feature-core` branch after the Workspace/Explorer commit.
- The existing Explorer `FileOperationContext` target derivation is correct and remains the source of truth for where creation occurs.
- The Explorer header is an intentional global-to-Explorer creation surface; unlike a file's context menu, it may use the selected file's parent as its creation target.
- Inline editing remains the temporary 004 UI. A future IDEA-like dedicated popup/dialog can define its own dismissal semantics without preserving 004's inline-specific blur rule.
- CodeMirror remains the sole owner of live editor document/selection state.
- The WebView2 cursor issue may need packaging/runtime strategy later, but no workaround or Runtime pinning is introduced here.

## Out of Scope / Deferred

- Redesigning Explorer filesystem/path architecture
- Changing canonical path ownership/reservation behavior
- Changing Workspace lifecycle or lazy-loading rules
- Changing DocumentManager or DocumentSession models
- New Rust/Tauri filesystem commands
- New file-creation popup/modal/dialog UI
- Settings for single-click vs double-click Explorer behavior
- Generic/extensible context-menu framework
- Tab drag/reorder, pinning, grouping, preview Tabs, or multi-row Tabs
- Theme-system redesign or user-selectable themes
- WebView2 Runtime pinning, Fixed Runtime packaging, or cursor-disappearance workaround
- File watcher, external-change notifications, Search/Index, Git, Session/Recovery, or other previously deferred 003 subsystems
