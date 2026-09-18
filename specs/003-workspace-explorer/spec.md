# Feature Specification: Workspace and Explorer

**Feature Branch**: `003-workspace-explorer`

**Created**: 2026-09-18

**Status**: Ready for implementation — behavior frozen

**Input**: Add a single-root Workspace/WorkContext and Explorer to Sorakada, while preserving the existing multi-document model and keeping Workspace state independent from open documents.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Open and Manage a Workspace (Priority: P1)

A user can open one folder as the current Workspace, browse it from a Sidebar Explorer, replace it with another folder, or close it without affecting already-open documents.

**Why this priority**: The Workspace is the foundation for every Explorer and filesystem feature in 003.

**Independent Test**: Open a folder, verify the Explorer shows the root, open a second folder, then close the Workspace while keeping existing document Tabs unchanged.

**Acceptance Scenarios**:

1. **Given** no Workspace is active, **When** the user chooses Open Folder and selects a valid directory, **Then** that directory becomes the active Workspace and the Explorer displays its root.
2. **Given** Workspace A is active and documents are open, **When** the user opens Workspace B, **Then** only the Workspace changes from A to B and all existing documents remain open.
3. **Given** a Workspace is active and documents are open, **When** the user closes the Workspace, **Then** the Explorer returns to the no-Workspace state and all documents remain open.
4. **Given** a Workspace is active, **When** the user opens the same canonical root again, **Then** the operation is a no-op and the existing Explorer state is not rebuilt solely because of the duplicate request.
5. **Given** Workspace A is active, **When** opening Workspace B fails, **Then** Workspace A remains active and usable.
6. **Given** multiple Open Folder requests overlap, **When** an older request finishes after a newer request, **Then** the older result MUST NOT replace the newer Workspace.

---

### User Story 2 - Browse Workspace Files Lazily (Priority: P1)

A user can expand directories and browse files without Sorakada recursively scanning the entire Workspace.

**Why this priority**: Large developer projects, including projects containing `node_modules`, must remain usable without paying the cost of scanning files the user has not opened or expanded.

**Independent Test**: Open a real frontend project containing `node_modules`, expand only selected directories such as `src`, and verify Sorakada does not recursively traverse unopened directories.

**Acceptance Scenarios**:

1. **Given** a Workspace with nested directories, **When** it is opened, **Then** Sorakada reads only the root level needed to display the initial Explorer.
2. **Given** a directory whose children have never been loaded, **When** the user expands it, **Then** its direct children are loaded on demand.
3. **Given** a previously loaded directory is collapsed and expanded again, **When** no Refresh has occurred, **Then** the cached children are reused instead of rereading the directory.
4. **Given** a directory is loading, **When** the user collapses it before loading finishes, **Then** the result may be cached but MUST NOT force the directory open again.
5. **Given** a directory load fails, **When** the error occurs, **Then** the failure is localized to that node and the rest of the Explorer remains usable.
6. **Given** the active Workspace changes while an old directory load is in flight, **When** the old load finishes, **Then** its result MUST be discarded.
7. **Given** a symlink or junction resolves to a directory, **When** the user expands it, **Then** Sorakada may browse it lazily but MUST stop traversal when following it would create a canonical-path ancestor cycle.

---

### User Story 3 - Open Documents from the Explorer (Priority: P1)

A user can select files in the Explorer and open them in the existing multi-document editor without creating duplicate sessions or coupling Tab navigation to Tree navigation.

**Why this priority**: Workspace browsing is useful only when it integrates cleanly with the document lifecycle established in 002.

**Independent Test**: Open the same Workspace file through Explorer, File > Open, and drag/drop; verify all paths converge on one document session and Explorer selection remains independent from Tab switching.

**Acceptance Scenarios**:

1. **Given** a file node is visible, **When** the user single-clicks it, **Then** the node becomes selected but no document is opened.
2. **Given** a file node is visible, **When** the user double-clicks it, **Then** Sorakada opens or activates that file through the existing document-opening lifecycle.
3. **Given** a directory node is visible, **When** the user single-clicks it, **Then** it becomes selected and its expanded state is toggled; its chevron may independently toggle expansion.
4. **Given** a Workspace file is already open, **When** it is opened again through any supported entry point, **Then** the existing document session is activated instead of creating a duplicate.
5. **Given** an active document changes, **When** the user switches Tabs, **Then** Explorer selection, expansion and scroll position remain unchanged.
6. **Given** a file outside the Workspace is opened, **When** it becomes active, **Then** it behaves as a normal document and the Workspace remains unchanged.
7. **Given** a file inside the Workspace is dragged into Sorakada, **When** it is opened, **Then** it uses the same document identity rules as Explorer/File Open and does not automatically expand or select its Tree node.
8. **Given** a directory is dragged into Sorakada, **When** the drop is processed, **Then** the directory is ignored and the current Workspace is not changed.

---

### User Story 4 - Work with Zero Open Documents (Priority: P1)

A user can run Sorakada with no open documents and explicitly create or open a document when needed.

**Why this priority**: 003 changes the document lifecycle so the Workspace and application shell can exist independently from document sessions.

**Independent Test**: Launch Sorakada with no documents, create a document, close the final Tab, and verify the application returns to an Empty State without creating an automatic replacement document.

**Acceptance Scenarios**:

1. **Given** Sorakada starts without an explicit file target, **When** the application becomes ready, **Then** zero documents are open and the Editor Area displays an Empty State.
2. **Given** the last open Tab is closed, **When** its close flow succeeds, **Then** zero documents remain open and Sorakada MUST NOT create an automatic Untitled document.
3. **Given** zero documents are open, **When** the user presses the TabBar `+`, uses Ctrl+N, or chooses File > New, **Then** exactly one new Untitled document is created and activated.
4. **Given** zero documents are open, **When** a document-dependent command such as Save, Save As, Close, Undo or Redo is unavailable, **Then** it is disabled and invoking its shortcut has no document-side effect.
5. **Given** zero documents are open, **When** no Workspace is active, **Then** the Empty State provides direct Open File and Open Folder entry points.
6. **Given** zero documents are open and a Workspace is active, **When** the user views the Editor Area, **Then** the Workspace and Explorer remain visible while the Editor Area indicates that no file is open.

---

### User Story 5 - Create Files and Directories from the Explorer (Priority: P2)

A user can create real files and directories relative to the current Explorer selection while keeping ordinary New Document behavior independent from the Workspace.

**Why this priority**: Basic file creation is required for the Explorer to function as a practical project browser.

**Independent Test**: Create a file and folder from a selected directory, selected file, and root context; verify the new file opens and the new folder remains a filesystem item only.

**Acceptance Scenarios**:

1. **Given** a Workspace and a selected directory, **When** the user chooses Explorer New File or New Folder, **Then** the new entry is created inside that directory.
2. **Given** a Workspace and a selected file, **When** the user chooses Explorer New File or New Folder, **Then** the new entry is created in that file's parent directory.
3. **Given** a Workspace and no concrete node selection, **When** the user chooses Explorer New File or New Folder, **Then** the new entry is created under the Workspace root.
4. **Given** a Workspace root is the current context, **When** the user creates a file or folder, **Then** the entry is created under the root.
5. **Given** no Workspace is active, **When** the user invokes File > New, Ctrl+N, or the TabBar `+`, **Then** Sorakada creates an Untitled document and does not create a disk file.
6. **Given** no Workspace is active, **When** Workspace-only creation actions are shown, **Then** New Folder is unavailable.
7. **Given** an inline New File or New Folder editor is active, **When** the user presses Escape, **Then** the operation is cancelled and no filesystem entry is created.
8. **Given** a new file is successfully created, **When** creation completes, **Then** its node becomes selected and the file is opened as a document.
9. **Given** a new folder is successfully created, **When** creation completes, **Then** its node becomes selected without creating a document session.
10. **Given** creation fails because of invalid input, conflict, permissions or filesystem failure, **When** the failure is reported, **Then** no successful Tree state is committed for an entry that does not exist.

---

### User Story 6 - Rename Workspace Entries Safely (Priority: P2)

A user can rename Workspace files and directories without losing editor state or allowing the Explorer and open document paths to diverge from disk state.

**Why this priority**: Rename is a standard Explorer operation and directly affects open document identity.

**Independent Test**: Rename an unopened file, an open dirty file, and a directory containing multiple open files; verify paths update only after disk success while document identities and editing state are preserved.

**Acceptance Scenarios**:

1. **Given** a selected non-root file or directory, **When** the user invokes Rename, **Then** the node enters inline rename mode.
2. **Given** inline rename mode, **When** the user presses Escape, **Then** the operation is cancelled without changing the filesystem.
3. **Given** a rename succeeds, **When** the target is an open file, **Then** the same document session remains open with the same editor state, history and dirty state while its path-related metadata reflects the new location.
4. **Given** a directory rename succeeds, **When** open documents exist below that directory, **Then** all affected open document paths are updated consistently.
5. **Given** the rename destination is already owned by another open document or reserved by a conflicting path operation, **When** Rename is attempted, **Then** the operation is rejected without overwriting, merging or duplicating document ownership.
6. **Given** the filesystem rename fails, **When** the error is returned, **Then** Explorer and document paths remain unchanged.
7. **Given** the Workspace root is selected, **When** Rename availability is evaluated, **Then** Rename is unavailable.

---

### User Story 7 - Delete Workspace Entries Safely (Priority: P2)

A user can delete Workspace files and directories using normal desktop-editor behavior without silently losing unsaved document changes.

**Why this priority**: Delete is destructive and must coordinate with both the filesystem and existing document sessions.

**Independent Test**: Delete unopened entries, clean open files, dirty open files and a directory containing open documents; verify confirmation and document cleanup are correct and failed deletion leaves application state intact.

**Acceptance Scenarios**:

1. **Given** a selected non-root file or directory, **When** the user chooses Delete, **Then** Sorakada requests confirmation before deleting it.
2. **Given** a normal Delete operation is confirmed, **When** deletion succeeds, **Then** the target is moved to the operating system's recycle/trash facility rather than permanently deleted.
3. **Given** a clean open file is deleted successfully, **When** the filesystem operation completes, **Then** its corresponding Tab is closed without a second unsaved-work prompt.
4. **Given** a dirty open file is targeted for deletion, **When** confirmation is shown, **Then** the warning explicitly states that unsaved modifications will be discarded; cancellation leaves both file and document unchanged.
5. **Given** a directory contains open dirty documents, **When** the directory is targeted for deletion, **Then** confirmation identifies that unsaved open work will be discarded before deletion may proceed.
6. **Given** deletion fails, **When** the filesystem reports the failure, **Then** corresponding Tabs remain open and Explorer nodes are not committed as deleted.
7. **Given** the Workspace root is selected, **When** Delete availability is evaluated, **Then** Delete is unavailable.
8. **Given** the user wants permanent deletion, **When** using 003, **Then** no permanent-delete command is provided.

---

### User Story 8 - Use Explorer Actions and Context Menus Predictably (Priority: P2)

A user can invoke Explorer operations from buttons, context menus and keyboard shortcuts with one consistent operation target.

**Why this priority**: Multiple UI surfaces must not disagree about which file or directory an action targets.

**Independent Test**: Select one node, right-click another, invoke New/Rename/Delete from the context menu and shortcuts, and verify every action resolves against the expected Explorer context.

**Acceptance Scenarios**:

1. **Given** a node is right-clicked, **When** its context menu opens, **Then** that node becomes the current Explorer selection before operation context is resolved.
2. **Given** a directory is the context target, **When** its context menu opens, **Then** New File, New Folder, Rename, Delete and Refresh are available as applicable.
3. **Given** a file is the context target, **When** its context menu opens, **Then** New File, New Folder, Rename and Delete are available as applicable, with creation targeting the file's parent directory.
4. **Given** Explorer blank space is right-clicked while a Workspace is active, **When** the context menu opens, **Then** the operation context is the Workspace root and only root-appropriate actions such as New File, New Folder and Refresh are offered.
5. **Given** no Workspace is active, **When** the user views the Explorer, **Then** filesystem mutation context menus are not offered and an Open Folder entry point is available.
6. **Given** Explorer has keyboard focus and a renameable entry is selected, **When** F2 is pressed, **Then** Rename is invoked through the same action path as the context menu.
7. **Given** Explorer has keyboard focus and a deletable entry is selected, **When** Delete is pressed, **Then** Delete is invoked through the same action path as the context menu.
8. **Given** Editor rather than Explorer has keyboard focus, **When** F2 or Delete is pressed, **Then** those keystrokes MUST NOT trigger Explorer filesystem operations.

---

### User Story 9 - Refresh Loaded Workspace State (Priority: P3)

A user can manually refresh the Explorer to reconcile it with filesystem changes made outside Sorakada without enabling continuous file watching.

**Why this priority**: 003 intentionally defers file watching, so manual Refresh is the supported convergence mechanism for external changes.

**Independent Test**: Load several directories, modify them externally, press Refresh, and verify loaded data converges without recursively scanning unopened directories.

**Acceptance Scenarios**:

1. **Given** directories have previously been loaded, **When** the user invokes Refresh, **Then** all loaded directory nodes are reread while never-loaded descendants remain unloaded.
2. **Given** expanded nodes still exist after Refresh, **When** refreshed results are applied, **Then** their expanded state is preserved.
3. **Given** the selected path still exists after Refresh, **When** refreshed results are applied, **Then** the selection is preserved.
4. **Given** the selected path no longer exists after Refresh, **When** refreshed results are applied, **Then** the invalid selection is cleared.
5. **Given** an inline create or rename edit is active, **When** the user invokes Refresh, **Then** the uncommitted inline edit is cancelled before refreshed filesystem state is applied.
6. **Given** the Workspace root temporarily becomes unavailable, **When** Refresh/read fails, **Then** the WorkContext remains active and the Explorer shows an unavailable/error state instead of silently closing the Workspace.

---

### User Story 10 - Use a Stable Application Shell (Priority: P3)

A user can show, hide and resize the Explorer Sidebar while the TabBar and Editor Area remain stable and usable.

**Why this priority**: 003 establishes the shell that later Search, Git, Outline and additional editor layouts will build on, without implementing those later features now.

**Independent Test**: Toggle and resize the Sidebar with zero and multiple Tabs, verify the Editor Area remains usable and the TabBar New button remains visible.

**Acceptance Scenarios**:

1. **Given** the application is running, **When** the user toggles View > Explorer, **Then** the Sidebar is shown or hidden without altering open documents.
2. **Given** the Sidebar is visible, **When** the user resizes it, **Then** the Editor Area adjusts without losing document or Explorer state.
3. **Given** multiple Tabs overflow horizontally, **When** the Tab strip scrolls, **Then** the dedicated New Document `+` control remains visible outside the scrolling Tab area.
4. **Given** zero Tabs are open, **When** the application shell is shown, **Then** the TabBar remains present with the New Document `+` control available.

---

### Edge Cases

- Opening the same Workspace through a different equivalent path spelling MUST resolve to the same Workspace identity.
- Workspace/document containment MUST be path-segment aware; a sibling such as `D:\project-old` MUST NOT be treated as inside `D:\project`.
- Workspace/document relation MUST be derived from the current canonical document path and current Workspace, not from how the document was originally opened.
- An Untitled document has no disk path and therefore has an unbound Workspace relation.
- Saving or renaming an outside document into the Workspace MUST cause its relation to become inside without reopening the document.
- Saving or renaming an inside document outside the Workspace MUST cause its relation to become outside without reopening the document.
- Files outside the Workspace MUST remain fully editable and MUST NOT implicitly replace or create a Workspace.
- Opening or closing a Workspace MUST NOT trigger dirty-document prompts because no document is being discarded.
- Workspace replacement MUST discard the previous Explorer's transient expanded/selected/loaded state; 003 does not restore per-Workspace Explorer state when returning later.
- A stale async Explorer result from a previous WorkContext or previous request generation MUST NOT mutate the current Explorer.
- Filesystem operations that change a path MUST coordinate with document path ownership so that one canonical destination is never owned by two live document sessions.
- A path mutation affecting a document MUST NOT race independently with that document's path-changing Save As operation; the operations must be coordinated so only one path transition commits at a time.
- A normal file Save that is already writing when Rename/Delete is requested MUST not cause final in-memory path/document state to contradict the successful disk operation.
- Mixed drag/drop batches may contain files and directories; directories are ignored while file entries continue processing in drop order.
- Opening an unsupported/binary Workspace file MAY leave that Tree node selected, but MUST NOT create a partially initialized Tab.
- Expanding a very large directory MAY take noticeable time, but it MUST NOT trigger recursive traversal of its descendants.
- Symlink/junction directory traversal MUST terminate when a canonical-path ancestor cycle is detected.
- The application MUST tolerate the Workspace root being renamed, removed, disconnected or made inaccessible outside Sorakada; the failure is discovered on actual access/Refresh rather than through a watcher.
- Root Rename/Delete are outside the Workspace operation model; users may perform those operations externally and reopen the desired folder.

## Requirements *(mandatory)*

### Functional Requirements

#### Workspace Lifecycle

- **FR-001**: Sorakada MUST support at most one active Workspace/WorkContext at a time.
- **FR-002**: Users MUST be able to open a directory as the active Workspace.
- **FR-003**: Opening a Workspace MUST NOT close, save, discard or otherwise mutate existing document sessions solely because the Workspace changed.
- **FR-004**: Opening a new Workspace while another is active MUST replace only the active WorkContext.
- **FR-005**: Opening the same canonical Workspace again MUST behave as a no-op.
- **FR-006**: A failed Workspace open MUST leave the previously active Workspace unchanged.
- **FR-007**: Overlapping Workspace-open requests MUST use latest-intent-wins semantics; stale completions MUST NOT replace newer state.
- **FR-008**: Users MUST be able to close the active Workspace without closing documents.
- **FR-009**: Open File MUST NOT implicitly create a Workspace from the file's parent directory.
- **FR-010**: Sorakada MUST support documents whose disk paths are outside the active Workspace.
- **FR-011**: 003 MUST NOT add special Tab coloring or other mandatory visual distinction for outside-Workspace documents.

#### Zero-Document Lifecycle

- **FR-012**: Sorakada MUST support zero open document sessions as a valid steady state.
- **FR-013**: A bare application launch MUST NOT automatically create an Untitled document.
- **FR-014**: Closing the final Tab MUST leave zero open documents and MUST NOT automatically create a replacement Untitled document.
- **FR-015**: The document-dependent active identity MUST be allowed to have no current value when zero documents are open.
- **FR-016**: The Editor Area MUST display an Empty State when no document is active rather than representing the Empty State as a fake document session.
- **FR-017**: File > New, Ctrl+N and the TabBar `+` MUST have the same behavior: create and activate a new Untitled document.
- **FR-018**: The TabBar `+` MUST remain visible when there are zero Tabs and when the document Tab area overflows horizontally.

#### Commands and Availability

- **FR-019**: Application commands MUST expose a shared availability/enabled state in addition to execution behavior.
- **FR-020**: All UI/shortcut surfaces for the same command MUST use the same command availability decision.
- **FR-021**: Document-dependent commands including Save, Save As, Close, Undo and Redo MUST be unavailable when no document/editor state exists for them to act on.
- **FR-022**: A recognized shortcut for a disabled command MUST NOT execute the disabled handler or leak into another application action.
- **FR-023**: File > New MUST always create an Untitled document and MUST NOT change meaning based on Explorer selection or focus.
- **FR-024**: File menu actions MUST include Open Folder and Close Folder; Close Folder MUST be unavailable when no Workspace is active.

#### Explorer Browsing

- **FR-025**: The Explorer MUST display the active Workspace as a single-root tree.
- **FR-026**: Directory children MUST be loaded lazily; Sorakada MUST NOT recursively scan the Workspace merely because it was opened.
- **FR-027**: Directory load state MUST distinguish at least not-loaded, loading, loaded and error states as observable behavior.
- **FR-028**: A loaded directory MAY cache its direct children until Refresh or a Sorakada-originated filesystem mutation updates them.
- **FR-029**: A directory load failure MUST remain local to the affected node and MUST NOT invalidate the whole Explorer.
- **FR-030**: Explorer asynchronous results MUST be rejected when they belong to a stale WorkContext or superseded request.
- **FR-031**: Explorer entries MUST be sorted with directories before files and case-insensitively by name within each group.
- **FR-032**: Explorer MUST NOT automatically apply `.gitignore`, `node_modules`, `.git`, `.idea`, `.vscode` or similar filtering in 003.
- **FR-033**: Explorer MUST display long names without forcing unbounded Sidebar width and MUST provide access to the complete name/path through a tooltip or equivalent affordance.
- **FR-034**: Symlink/junction directory entries MAY be expanded, but traversal MUST stop when following the canonical target would create an ancestor cycle.

#### Explorer and Document Interaction

- **FR-035**: Single-clicking a file MUST select it without opening it.
- **FR-036**: Double-clicking a file MUST open or activate it through the existing document-open pipeline.
- **FR-037**: Directory selection/expansion behavior MUST NOT create document sessions.
- **FR-038**: Explorer selection and active document identity MUST remain independent state.
- **FR-039**: Switching Tabs MUST NOT automatically expand, scroll or change Explorer selection.
- **FR-040**: 003 MUST NOT implement automatic Tab-to-Tree location; an explicit Locate Current File operation is deferred.
- **FR-041**: Document-to-Workspace relation MUST be derived dynamically from the current canonical document path and current active WorkContext.
- **FR-042**: The derived relation MUST distinguish inside, outside and unbound documents, and an inside relation MUST provide a Workspace-relative path.
- **FR-043**: Workspace containment MUST use canonical filesystem-aware path semantics and MUST NOT rely on naive string-prefix comparison.

#### Drag and Drop

- **FR-044**: Dropped files MUST use the same document-opening and duplicate-detection pipeline as other Open File entry points.
- **FR-045**: Dropped directories MUST be ignored in 003 and MUST NOT open or replace a Workspace.
- **FR-046**: A dropped file inside the Workspace MUST NOT cause automatic Explorer expansion, scrolling or selection.
- **FR-047**: A dropped file outside the Workspace MUST open normally without altering the active Workspace.
- **FR-048**: Mixed file/directory drop batches MUST continue processing file entries even when directory entries are ignored.

#### Explorer File Creation

- **FR-049**: Explorer New File and New Folder MUST resolve their creation parent from the current WorkContext and Explorer selection.
- **FR-050**: With a selected directory, Explorer creation MUST target that directory.
- **FR-051**: With a selected file, Explorer creation MUST target the selected file's parent directory.
- **FR-052**: With no concrete selection or with the Workspace root context, Explorer creation MUST target the Workspace root.
- **FR-053**: With no active Workspace, Explorer New Folder MUST be unavailable.
- **FR-054**: New File/New Folder MUST use an inline editing flow with explicit commit and cancel behavior.
- **FR-055**: A successful Explorer New File MUST select and open the newly created file.
- **FR-056**: A successful Explorer New Folder MUST select the new directory without creating a document session.
- **FR-057**: Failed or cancelled creation MUST NOT leave a successful-looking filesystem node that does not exist on disk.

#### Rename

- **FR-058**: Rename MUST be available only for non-root Workspace entries.
- **FR-059**: Rename MUST use inline editing with explicit commit and cancel behavior.
- **FR-060**: Explorer/document path state MUST be committed only after the filesystem rename succeeds.
- **FR-061**: Renaming an open file MUST preserve its existing stable document identity, editor state, edit history and dirty state.
- **FR-062**: Renaming a directory MUST update the paths of all open documents contained under that directory after disk success.
- **FR-063**: Rename MUST reject a destination already owned or incompatibly reserved by another live document/path operation.
- **FR-064**: A failed Rename MUST leave Explorer and document path state unchanged.

#### Delete

- **FR-065**: Delete MUST be available only for non-root Workspace entries.
- **FR-066**: Normal Delete in 003 MUST move the selected entry to the operating system's recycle/trash facility rather than permanently deleting it.
- **FR-067**: 003 MUST NOT expose a permanent-delete command.
- **FR-068**: Delete MUST require confirmation before committing the destructive operation.
- **FR-069**: Deleting a dirty open file or a directory containing dirty open documents MUST explicitly warn that unsaved changes will be discarded.
- **FR-070**: Cancelling Delete MUST leave filesystem, Explorer and document state unchanged.
- **FR-071**: After successful deletion of an open file, the associated document session MUST be removed without running a second ordinary close/save prompt.
- **FR-072**: After successful deletion of a directory, all open document sessions whose current paths are inside that directory MUST be removed.
- **FR-073**: If deletion fails, Sorakada MUST NOT close affected Tabs or remove the target from Explorer as though deletion succeeded.
- **FR-074**: 003 MUST NOT introduce a special "deleted but still open" document state.

#### Explorer Operation Context and Menus

- **FR-075**: Explorer filesystem operations MUST derive a shared operation context from the active WorkContext and persistent Explorer selection.
- **FR-076**: Right-clicking a node MUST select that node before resolving the context-menu operation target.
- **FR-077**: Right-clicking Explorer blank space MUST use Workspace-root context rather than a stale previous node target.
- **FR-078**: The Workspace root context MUST offer creation/refresh operations but MUST NOT offer Rename/Delete.
- **FR-079**: F2 and Delete MAY invoke Explorer Rename/Delete only while Explorer has keyboard focus and a valid target exists.
- **FR-080**: Context menu, Explorer header buttons and keyboard operations MUST share the same target-resolution and availability rules.
- **FR-081**: 003 MUST provide a functional Explorer context menu but MUST NOT require a generic extensible context-menu/plugin registry.

#### Refresh and External Changes

- **FR-082**: 003 MUST provide the same manual, loaded-tree Explorer Refresh from the Explorer header, Workspace-root context menu, and directory context menus, and MUST NOT require continuous filesystem watching.
- **FR-083**: Refresh MUST reread every directory node that has already been loaded while leaving never-loaded descendants unloaded.
- **FR-084**: Refresh MUST preserve expanded state and selection when the corresponding paths still exist.
- **FR-085**: Refresh MUST clear selection when the selected path no longer exists.
- **FR-086**: A Sorakada-originated successful New/Rename/Delete operation SHOULD update affected Explorer state directly without requiring manual Refresh.
- **FR-087**: External filesystem changes are required to converge only after a relevant read/Refresh in 003.
- **FR-088**: Loss of Workspace-root availability MUST NOT automatically close the WorkContext; the Explorer MUST expose an error/unavailable state and allow later retry/Refresh.
- **FR-089**: Refresh or WorkContext replacement MUST cancel any uncommitted inline create/rename edit associated with the prior Tree state.

#### Application Shell

- **FR-090**: 003 MUST establish a stable application shell separating Sidebar and Editor Area responsibilities.
- **FR-091**: The Sidebar MUST host Explorer in 003 but MUST NOT be defined as Explorer-specific in a way that prevents later Sidebar views.
- **FR-092**: Users MUST be able to show/hide the Explorer Sidebar.
- **FR-093**: Users MUST be able to resize the Sidebar within reasonable UI bounds.
- **FR-094**: 003 MUST NOT require persistence of Sidebar width or visibility across application sessions.
- **FR-095**: The visual system MUST continue to use shared application styling/tokens rather than introducing independent hard-coded palettes for every new component.
- **FR-096**: File/folder/action icons SHOULD use a shared icon abstraction rather than duplicating inline SVG definitions throughout Explorer components.
- **FR-097**: 003 MUST NOT introduce an empty StatusBar solely as a placeholder; later status information may add one when needed.

#### Consistency and Data Safety

- **FR-098**: Filesystem path mutations MUST commit document/Explorer state only after the corresponding disk operation succeeds.
- **FR-099**: Path ownership and reservation rules MUST prevent two live document sessions from owning the same canonical destination.
- **FR-100**: Open, Save As and Explorer path-mutation operations MUST participate in compatible destination ownership rules so pending operations cannot create duplicate ownership through races.
- **FR-101**: A successful save used as part of a close/exit decision MUST NOT permit the document to close if newer edits made during that save leave the document dirty.
- **FR-102**: If a path-changing save cannot adopt its destination because ownership changed, it MUST NOT incorrectly advance the document's saved baseline or mark the document clean for that failed adoption.
- **FR-103**: Rename/Delete MUST coordinate with relevant in-flight document save/path operations so asynchronous completions cannot restore stale paths or close documents whose final state contradicts the disk result.

### Key Entities *(include if feature involves data)*

- **WorkContext**: The currently active single-root Workspace identity. It represents the user-selected root directory and its canonical filesystem identity, but does not own document sessions or transient Explorer UI state.
- **Explorer Node**: A visible filesystem entry under the current WorkContext. A directory also has observable expansion and load state. Nodes represent filesystem state, not document contents.
- **Explorer State**: Transient UI state for the current WorkContext, including selection, expanded directories, loaded children and localized load/error state. It is replaced when the WorkContext changes and is not persisted in 003.
- **Document Session**: The existing 002 editor document identity. It remains independent from WorkContext and may be untitled, inside the Workspace or outside it.
- **Workspace Relation**: A dynamic relation between a disk-backed document and the current WorkContext: `inside` with a relative path, `outside`, or `unbound` for documents without a disk path.
- **File Operation Context**: The effective Workspace and Explorer target used to resolve New File, New Folder, Rename and Delete behavior consistently across UI surfaces.
- **Application Command**: A stable application action with shared execution and availability state so menu items, shortcuts and other surfaces cannot disagree about whether the action is currently valid.

## Superseded Requirements

003 intentionally changes the following behavior established by 002. The 002 specification remains a historical record of that milestone; these requirements take precedence from 003 onward.

### SR-001 - Mandatory Document Session

**Previous 002 behavior**: A normal running application always contains at least one document session. Closing the final Tab automatically creates the next `UntitledN` document.

**003 behavior**: Zero open documents are a valid steady state. Bare launch and closing the final Tab show an Empty State and MUST NOT create a replacement document. Untitled documents are created only by explicit New actions.

### SR-002 - Non-null Active Document

**Previous 002 behavior**: The document model and UI may assume an active document always exists.

**003 behavior**: There may be no active document. Document-dependent commands and the editor host must handle that state explicitly.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Opening a Workspace containing a large `node_modules` tree does not recursively enumerate that tree unless the user expands relevant directories; filesystem access is proportional to loaded/expanded directories rather than total Workspace file count.
- **SC-002**: With a Workspace containing at least 100,000 descendant files and no more than 200 direct root entries, the Explorer root is visible and accepts selection within 2 seconds after the initial root directory read returns; no descendant directory is read before user expansion.
- **SC-003**: Repeatedly collapsing and re-expanding an already loaded directory does not cause additional directory reads until Refresh or a Sorakada-originated mutation requires updated data.
- **SC-004**: Opening the same file through Explorer, File Open and drag/drop results in exactly one live document session for the same canonical destination.
- **SC-005**: Closing the final Tab reliably leaves zero documents open and does not create an Untitled document across repeated manual and automated lifecycle tests.
- **SC-006**: In a zero-document state, every document-dependent command is consistently unavailable across menu and keyboard entry points and produces no editor/document mutation when invoked.
- **SC-007**: Renaming an open dirty file preserves its document identity, text, undo/redo history and dirty state while updating the visible/path identity only after disk rename succeeds.
- **SC-008**: Renaming a directory containing multiple open documents updates all affected document paths without producing duplicate path ownership.
- **SC-009**: Cancelling or failing New/Rename/Delete leaves Explorer, disk state and open documents mutually consistent in all tested cases.
- **SC-010**: Deleting a dirty open file or directory never discards unsaved edits without an explicit deletion warning and confirmation.
- **SC-011**: Switching rapidly between two Workspace-open requests or switching Workspaces during directory loading never allows stale asynchronous results from the previous WorkContext to appear in the current Explorer.
- **SC-012**: Manual Refresh detects external changes in previously loaded directories without recursively loading unopened directories.
- **SC-013**: Expanding symlink/junction directory structures that contain a cycle terminates safely and never causes unbounded recursive loading.
- **SC-014**: A realistic frontend project containing `node_modules`, hidden/configuration directories and nested source trees can be opened, browsed, edited, refreshed, renamed and deleted through the defined 003 flows without UI state corruption or document loss.

## Assumptions

- Sorakada remains Windows-first for 003, while path behavior should avoid assumptions that unnecessarily prevent later cross-platform support.
- The existing 002 multi-document model, stable document identity, text-format preservation and canonical path identity behavior remain the foundation for document handling.
- Workspace is a navigation/filesystem context, not a container that owns document lifetime.
- Workspace root identity and document containment use filesystem-aware canonical path semantics.
- Explorer reads filesystem metadata/entry names only; it does not preload file contents for browsing.
- A directory's direct child count can be large. 003 requires the UI to remain usable but does not mandate a particular rendering optimization such as virtualization; implementation may add one if realistic testing demonstrates the need.
- Ordinary Delete uses the operating system recycle/trash mechanism. Permanent deletion may be added in a later feature.
- External filesystem changes are discovered on explicit/relevant filesystem access; no watcher is required in 003.
- Inline file creation and rename are transient UI operations and are cancelled when their WorkContext/Tree context is replaced or explicitly refreshed before commit.
- Workspace-specific file creation is exposed through Explorer surfaces; File > New, Ctrl+N and TabBar `+` remain document-buffer creation actions.

## Out of Scope / Deferred

- Multiple Workspace roots / multi-root workspaces
- File watcher and automatic external-change notifications
- Workspace search, global indexing or background recursive scanning
- Session persistence, automatic Workspace restore or Recent Workspaces
- Git/source-control integration
- Tree drag-and-drop move operations
- Explorer Copy/Cut/Paste operations
- Preview Tabs
- Split editor panes
- Open Editors panel
- Automatic Tab-to-Tree synchronization
- Locate Current File command
- Special visual styling for outside-Workspace Tabs
- `.gitignore`/exclude-pattern aware Explorer filtering
- Configurable Explorer sorting
- Full theme system or icon-theme system
- Generic Panel Registry, Context Menu Registry or plugin contribution framework
- Persistent Sidebar layout preferences
- Permanent Delete / Shift+Delete
- Single-instance secondary-launch handling
- OS file associations, shell "Open with Sorakada" integration, or directory shell integration
- Packaging/installer integration related to startup file/folder targets
