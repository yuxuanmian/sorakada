# Feature Specification: Multi-Document Tabs

**Feature Branch**: `feature-core`

**Created**: 2026-09-17

**Status**: Draft

**Input**: User description: "Upgrade Sorakada from a reliable single-document editor to a multi-document editor with tabs, independent document state, explicit Save/Save As semantics, safe close handling, and drag-and-drop file opening. Keep future file tree, theme switching, session recovery, and external-change detection extensible without implementing those subsystems now."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Work with several documents at once (Priority: P1)

A user can create multiple untitled documents, keep several files open simultaneously, and switch between them without losing edits, cursor/selection state, undo/redo history, or reading position.

**Why this priority**: Multi-document state is the architectural purpose of 002. Without it, a Tab bar would only be cosmetic and later file-tree/search work would still be constrained by the single-document model.

**Independent Test**: Start Sorakada, create three documents, edit each differently, move the cursor and scroll to different positions, switch among the Tabs repeatedly, and verify each document returns to its own content and editing position.

**Acceptance Scenarios**:

1. **Given** Sorakada has just started, **When** the editor becomes ready, **Then** exactly one Tab named `Untitled1` is active.
2. **Given** one document is open, **When** the user invokes New twice, **Then** `Untitled2` and `Untitled3` are created as additional Tabs and the previous documents remain open.
3. **Given** multiple Tabs contain different edits, selections, undo histories, and scroll positions, **When** the user switches among them, **Then** each Tab restores its own state without leaking state from another document.
4. **Given** `Untitled1` has been saved and later closed, **When** another untitled document is created in the same application session, **Then** its name uses the next unused monotonic number rather than reusing `Untitled1`.
5. **Given** many Tabs exceed the available Tab-strip width, **When** the user activates a Tab that is currently outside the visible portion of the strip, **Then** the strip allows horizontal navigation and brings the active Tab into view.

---

### User Story 2 - Open files into Tabs without duplicates (Priority: P1)

A user can open a disk file without replacing the current document. If the request resolves to the same canonical path comparison key through another path spelling or opening surface, Sorakada activates the existing Tab instead of creating a second editor session for that path.

**Why this priority**: File opening must become multi-document-aware before later file-tree and recent-file surfaces can safely reuse it.

**Independent Test**: Open two different files and then request the first file again through another supported opening path; verify both original Tabs remain and the first Tab is activated instead of duplicated.

**Acceptance Scenarios**:

1. **Given** document A is active, **When** the user opens file B successfully, **Then** B appears as a new active Tab and A remains open unchanged.
2. **Given** a file is already open, **When** a request resolves to its existing canonical path comparison key, **Then** the existing Tab is activated and no duplicate session is created.
3. **Given** two different files have the same base filename, **When** both are open, **Then** both Tabs may show the same short name but each provides its full path as disambiguating information.
4. **Given** an unsupported, unreadable, binary, or otherwise invalid file is requested, **When** opening fails, **Then** no empty or half-initialized Tab is created and the existing documents remain unchanged.
5. **Given** an existing dirty document is active, **When** another file is opened, **Then** opening the new file does not prompt to save or discard the active document because the active document is not being replaced.

---

### User Story 3 - Save and close the correct document safely (Priority: P1)

A user can save, save as, and close any document without an asynchronous operation accidentally mutating another Tab. Closing a dirty Tab or the window keeps the existing explicit user-driven save semantics.

**Why this priority**: Multi-document editing is unsafe if Save, Save As, or close actions are still implicitly tied to whichever Tab happens to be active when an asynchronous operation finishes.

**Independent Test**: Start a delayed save for document A, switch to and edit B before A completes, then verify A alone receives the save result; separately close dirty Tabs using Save, Don't Save, and Cancel and verify the intended documents remain or close.

**Acceptance Scenarios**:

1. **Given** A is saving, **When** the user switches to and edits B before A's save finishes, **Then** A's completion changes only A's saved state and never B's state.
2. **Given** a document performs Save As to target X and then a newer Save As to target Y, **When** the older operation finishes after the newer operation, **Then** the older completion cannot change the document path back to X or replace the newer saved-state decision.
3. **Given** Save As selects a file already owned by another open document, **When** Sorakada validates the target, **Then** the Save As is rejected, neither document is merged, and the source document keeps its prior path and dirty state.
4. **Given** a dirty Tab is closed, **When** the user chooses Save, Don't Save, or Cancel, **Then** the close follows that choice; a cancelled or failed save leaves the Tab open.
5. **Given** a clean Tab is closed, **When** no unsaved work would be lost, **Then** it closes without an unsaved-work prompt.
6. **Given** the active Tab closes and other Tabs remain, **When** closure succeeds, **Then** the nearest Tab to its left becomes active when available; otherwise the new first Tab becomes active.
7. **Given** the final remaining Tab is closed during normal application use, **When** closure succeeds, **Then** Sorakada immediately creates a new clean `UntitledN` Tab.
8. **Given** multiple dirty Tabs exist and the user closes the application window, **When** Sorakada processes unsaved documents, **Then** it prompts for them one at a time; any Cancel or failed Save aborts window closure, while already completed Save decisions remain completed.
9. **Given** the application is exiting, **When** all dirty-document decisions permit exit, **Then** the window closes directly rather than creating a replacement untitled Tab as part of normal last-Tab behavior.
10. **Given** a document is dirty, **When** the user does not invoke Save or Save As, **Then** Sorakada does not silently write that document back to its real file.

---

### User Story 4 - Drag files into Sorakada (Priority: P2)

A user can drag one or more local files from the operating system into Sorakada and have them opened through the same multi-document rules as File > Open.

**Why this priority**: Drag-and-drop is a small but high-value desktop workflow and becomes straightforward once the multi-document open path is unified.

**Independent Test**: Drag several files including a valid file, an unsupported file, a duplicate of an already-open file, and another valid file; verify valid files open in input order, the duplicate is reused, failure does not stop the batch, and the last successfully handled file becomes active.

**Acceptance Scenarios**:

1. **Given** a valid file is dragged over the editor window, **When** the drag enters the drop area, **Then** Sorakada shows a lightweight visual affordance that a file can be dropped.
2. **Given** a single valid file is dropped, **When** opening succeeds, **Then** it opens as a Tab using the same duplicate detection and file validation as File > Open.
3. **Given** multiple paths are dropped, **When** they are processed, **Then** successful files appear in the original dropped order and the last successfully opened or activated file becomes active.
4. **Given** one dropped file fails validation or reading, **When** later dropped files are valid, **Then** the failure is reported without aborting the remainder of the batch.
5. **Given** a dropped path is a directory, **When** 002 handles the drop, **Then** the directory is ignored and no workspace/folder-opening behavior is started.
6. **Given** the same file is already open, **When** it is dropped again, **Then** Sorakada activates the existing Tab rather than creating a duplicate.

---

### Edge Cases

- A Save or Save As operation completes after its document has already been closed: the disk operation may finish, but the completion must not mutate another document or resurrect the closed session.
- A user closes a non-active dirty Tab and then cancels the prompt: the currently active Tab must remain active and unchanged.
- Save As chooses the same path already owned by the same document: this is not treated as a cross-document collision.
- Two Save As operations race toward different targets: only the newest still-relevant operation may adopt a new path or saved baseline for the document.
- Two documents attempt to claim the same not-yet-existing Save As target nearly simultaneously: Sorakada must preserve the invariant that one canonical path comparison key belongs to at most one open document session.
- A duplicate file is requested through differently spelled but equivalent filesystem paths: Sorakada must identify it as the same file where the platform can resolve equivalence.
- An open operation is cancelled before a path is selected: the Tab list and active document remain unchanged.
- A file becomes unavailable between identity resolution and reading: opening fails without creating a partial Tab.
- Multiple dropped files include directories and invalid files among valid files: directories are ignored, failures do not stop later valid files, and successful order is deterministic.
- A large file and a small file are switched repeatedly: the editor remains responsive and state isolation remains correct.
- Tab labels collide because different directories contain the same filename: full-path disambiguation remains available without requiring smart label rewriting in 002.
- Browser-only development mode is used without a native desktop bridge: the editor still renders; native Tab behavior that does not require OS integration remains testable, while native drag/drop and dialogs are simply unavailable.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Sorakada MUST maintain an ordered collection of simultaneously open document sessions and exactly one active document while the application is in normal editing mode.
- **FR-002**: Sorakada MUST start a fresh application session with one clean document named `Untitled1`.
- **FR-003**: Invoking New MUST create and activate an additional clean untitled document instead of replacing or prompting about the current document.
- **FR-004**: Untitled display numbers MUST begin at 1, increase monotonically for the lifetime of the process, and MUST NOT be reused after an untitled document is saved or closed.
- **FR-005**: Every open document MUST have a stable internal identity that does not change when the document is renamed through Save As.
- **FR-006**: Each document MUST preserve its own text, selection/cursor state, undo/redo history, and reading position when inactive and restore them when reactivated.
- **FR-007**: State from one document MUST NOT leak into another document during activation, editing, undo, redo, save, or close operations.
- **FR-008**: Opening a valid file MUST create and activate a new document without replacing existing documents.
- **FR-009**: New and Open MUST NOT invoke an unsaved-work prompt merely because another dirty document is already open.
- **FR-010**: Sorakada MUST recognize when an open request resolves to a canonical path comparison key already owned by a document session and activate that session instead of creating a duplicate.
- **FR-011**: Duplicate-file recognition MUST use filesystem-resolved canonical path equivalence appropriate to the target platform rather than raw display-string equality alone. Distinct hard-link paths are not required to collapse to one Tab in 002.
- **FR-012**: An open operation MUST complete path/file validation and text decoding before the new session becomes visible in the Tab list.
- **FR-013**: Failed or cancelled open operations MUST leave the existing Tab list, active document, and document contents unchanged except for any user-visible error message.
- **FR-014**: Two different files with the same base filename MUST be allowed to coexist as separate Tabs, and full-path information MUST remain available to disambiguate them.
- **FR-015**: Save and Save As MUST operate on a specific document identity and MUST NOT infer their target document from whichever Tab is active when asynchronous work finishes.
- **FR-016**: Only a successful, still-relevant disk write MAY advance a document's saved baseline or adopt a new Save As path.
- **FR-017**: A newer Save/Save As intent for a document MUST NOT be overwritten by completion of an older asynchronous operation.
- **FR-018**: Writes targeting the same destination MUST NOT land in an order that leaves an older snapshot on disk after a newer snapshot from the same Sorakada session.
- **FR-019**: Save As MUST reject a target already owned by another open document session, while allowing a document to select its own current target.
- **FR-020**: The application MUST prevent concurrent document sessions from successfully claiming the same Save As destination during one process lifetime.
- **FR-021**: Closing a clean Tab MUST close it without an unsaved-work prompt.
- **FR-022**: Closing a dirty Tab MUST offer Save, Don't Save, and Cancel using the existing unsaved-work semantics.
- **FR-023**: Cancel or a failed/cancelled Save during Tab close MUST leave that document open.
- **FR-024**: Closing a non-active Tab MUST NOT require activating it first and MUST NOT change the active Tab if the close is cancelled.
- **FR-025**: After a successful close of the active Tab, Sorakada MUST activate the closest remaining Tab on its left when one exists; otherwise it MUST activate the new first Tab.
- **FR-026**: Closing the final Tab during normal use MUST create and activate the next clean `UntitledN` document so normal editing mode always contains a document.
- **FR-027**: Window exit MUST inspect all dirty documents and process their unsaved-work decisions one at a time; any Cancel or failed Save MUST abort exit.
- **FR-028**: Successful Save decisions made earlier in a multi-document window-close sequence MUST remain effective even if a later document cancels the overall exit.
- **FR-029**: Window exit MUST close the window directly after all dirty-document decisions permit it and MUST NOT trigger the normal "create a replacement Untitled" last-Tab rule.
- **FR-030**: Real file content MUST continue to be written only by explicit Save or Save As actions in 002; crash recovery, session persistence, and automatic real-file saving are out of scope.
- **FR-031**: The File menu and keyboard command system MUST expose a Close Current Tab action, with the IDEA-style `Ctrl+W` binding, through the same command dispatch path as other editor commands.
- **FR-032**: The Tab strip MUST show active state, dirty state, document display name, and a close affordance for each open document.
- **FR-033**: When the Tab strip exceeds the available width, it MUST support horizontal overflow without resizing the editor area beyond the window, and activating a hidden Tab MUST reveal that Tab.
- **FR-034**: Opening or activating a document through New, Open, Tab selection, or successful drag/drop SHOULD return keyboard focus to the editor.
- **FR-035**: Sorakada MUST accept one or more dropped local file paths through the native desktop window and route each file through the same document-open validation and duplicate-detection rules as normal Open.
- **FR-036**: Multiple dropped paths MUST be handled in their original order, and processing failure for one file MUST NOT prevent subsequent paths from being handled.
- **FR-037**: Dropped directories MUST be ignored in 002 without starting workspace/folder behavior.
- **FR-038**: While valid files are dragged over the desktop editor window, Sorakada SHOULD provide a lightweight visual drop indication that disappears on drop or drag leave.
- **FR-039**: The user interface MUST receive lightweight document/Tab metadata updates without requiring the live document text to be mirrored into general application UI state.
- **FR-040**: The multi-document model MUST expose document operations by stable document identity so later Save All, session persistence, recovery, external-change validation, and file-tree features can integrate without changing the basic document ownership model.
- **FR-041**: The document model MUST retain a place for resolved disk identity/revision metadata even though continuous file watching and external-modification conflict UX are not implemented in 002.
- **FR-042**: New Tab UI and editor configuration changes introduced by 002 MUST remain compatible with application-level appearance/theme reconfiguration; 002 MUST NOT require theme settings to be stored independently as per-document user preferences.
- **FR-043**: 002 MUST preserve the existing supported text-format behavior from 001, including UTF-8 validation, UTF-8 BOM preservation, supported line-ending behavior, and the existing explicit-save semantics.
- **FR-044**: No artificial maximum Tab count MUST be imposed by 002.

### Key Entities

- **Document Session**: One open editable document. It has a stable identity, optional disk path/identity, display name, file-format metadata, dirty/saved relationship, independent editing state, and reading-position state.
- **Document Manager**: Owns the ordered set of document sessions, the active document identity, untitled-number allocation, duplicate-file ownership, and lifecycle operations addressed to explicit documents.
- **Tab Projection**: The lightweight user-interface representation of a document: identity, display name, optional full path, dirty flag, active flag, and order. It intentionally does not contain the full text buffer.
- **Resolved File Identity**: The platform-resolved information used to decide whether two requested paths represent the same file/target during the current process lifetime.
- **Disk Revision Metadata**: Lightweight metadata captured with a disk-backed document to support later external-modification validation. 002 stores/threads the model but does not implement continuous validation or watcher UX.
- **Document View State**: Reading-position information not inherently represented by the document's logical text/history state, such as vertical and horizontal scroll position.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can create at least 20 Tabs, edit distinct content in each, and switch among them without any document receiving another document's content, undo history, selection, or dirty state.
- **SC-002**: Reopening a file 20 times through a mix of File > Open and native drag/drop paths that resolve to the same canonical path comparison key produces exactly one document session for that key and repeatedly activates that session.
- **SC-003**: In automated race tests, 100% of delayed Save/Save As completions mutate only the originating document, and an older Save As completion never replaces the path decision of a newer Save As intent.
- **SC-004**: A dropped batch containing valid files, an invalid file, a duplicate file, and another valid file opens/activates every successful entry in original order while allowing the batch to continue after the failure.
- **SC-005**: On the project's reference Windows development machine, alternate between an approximately 10 KB text document and a 20–50 MB text document for 20 cycles (one cycle is small → large → small). Measure each activation from the Tab-selection event to the first animation frame after the target editor state is bound and focused. All 40 activations MUST be within 500 ms; the median of the 10 activations in the final five cycles MUST be no more than 25% slower than the median of the 10 activations in the first five cycles.
- **SC-006**: For three dirty documents, the close-window decision matrix MUST pass all eight completing Save/Don't Save sequences and all 14 aborting sequences that place Cancel or Save failure at each document position after every possible Save/Don't Save prefix. No sequence may silently discard a document without the user's approval.
- **SC-007**: All existing 001 automated verification continues to pass after 002, including TypeScript type checking, Vitest tests, production build, Rust tests, and the existing file-format round-trip assertions.
- **SC-008**: A user can complete the primary 002 workflow—create multiple documents, switch among them, save one, close another, and drag in a file—without encountering a state where the editor has no active document during normal use.

## Assumptions

- Windows 10/11 remains the primary supported desktop target for this stage; cross-platform abstractions should not deliberately prevent future support, but 002 acceptance is Windows-first.
- File > Open remains a single-file picker in 002. Multi-file opening in this feature is required for drag/drop; multi-select in the native Open dialog can be added separately later.
- `UntitledN` numbering is process-local in 002. Session persistence and cross-launch restoration of the counter are deferred.
- Smart same-filename Tab label disambiguation is deferred; showing the short filename plus full-path tooltip/details is sufficient for 002.
- Canonical path comparison covers equivalent spellings and filesystem links that resolve to the same canonical path. Distinct hard-link paths may appear as separate Tabs in 002; native file-ID deduplication is deferred.
- External file watching, external-change prompts, safe-write/atomic replacement upgrades, crash recovery, persisted sessions, Save All, autosave, local history, file tree/workspace, search/replace, Tab pinning, Tab drag reordering, split views, multi-window Tab transfer, and advanced Tab context menus are explicitly out of scope.
- The existing 001 file decoding/encoding rules remain authoritative unless 002 needs additional path-identity metadata; 002 does not broaden supported encodings or line endings.
- Native GUI flows that cannot be safely automated will be validated with a manual checklist rather than scripted operating-system input automation.
