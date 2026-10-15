# Feature Specification: Single-File Editing Lifecycle

**Feature Branch**: `[001-single-file-editing]`

**Created**: 2026-09-16

**Status**: Draft

**Input**: User description: "Add Sorakada's first complete single-file editing lifecycle: new/open/save/save-as, reliable dirty-state handling and unsaved-change protection, UTF-8 BOM and LF/CRLF/Mixed line-ending compatibility, plus a minimal File/Edit menu and a small IDEA-style shortcut set."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Open, Edit, and Save an Existing Text File (Priority: P1)

As a user, I can open a supported text file, edit its contents, and save it back without Sorakada unintentionally changing the file's text format.

**Why this priority**: This is the minimum useful editing loop for an existing file and is the primary purpose of this feature.

**Independent Test**: Open one supported file, modify a visible piece of text, save it, reopen the file, and verify that the intended text change is present while the original BOM and uniform line-ending style are retained.

**Acceptance Scenarios**:

1. **Given** a UTF-8 file without BOM using LF line endings, **When** the user opens, edits, and saves it, **Then** the intended text changes are persisted and the file remains UTF-8 without BOM using LF.
2. **Given** a UTF-8 file without BOM using CRLF line endings, **When** the user opens, edits, and saves it, **Then** the intended text changes are persisted and the file remains UTF-8 without BOM using CRLF.
3. **Given** a UTF-8 BOM file using LF or CRLF consistently, **When** the user opens, edits, and saves it, **Then** the BOM and original line-ending style are preserved.
4. **Given** a supported file that has not been edited, **When** the user opens it and performs a normal save, **Then** the file is not changed solely by opening and saving it.
5. **Given** a file that cannot be interpreted as supported text, **When** the user attempts to open it, **Then** Sorakada reports that the file is unsupported and leaves the current document unchanged.
6. **Given** a supported file with no final line break, **When** the user edits unrelated text and saves it, **Then** Sorakada does not add a final line break unless the user explicitly created one.

---

### User Story 2 - Create a New File or Save a Copy (Priority: P2)

As a user, I can start with an empty document or save the current document to a different path so that Sorakada supports both new-file creation and Save As workflows.

**Why this priority**: A usable single-file editor must support files that do not yet have a path and allow the current document to be saved under another name or location.

**Independent Test**: Create a new document, enter text, save it to a chosen path, then use Save As to create a second file and verify both outputs have the expected contents and default/preserved text format.

**Acceptance Scenarios**:

1. **Given** Sorakada has created a new untouched document, **When** the user has not typed anything, **Then** the document is considered clean and has no file path.
2. **Given** a new document with unsaved text, **When** the user invokes Save, **Then** Sorakada asks for a destination and saves the document there.
3. **Given** a new document is saved for the first time, **When** the save completes, **Then** it is written as UTF-8 without BOM using CRLF line endings when line breaks are present.
4. **Given** an existing supported document, **When** the user invokes Save As and chooses a new destination, **Then** a new file is written and the active document is associated with the new destination after the write succeeds.
5. **Given** a Save As operation is cancelled, **When** the file picker closes without a destination, **Then** the document path, contents, format, and dirty state remain unchanged.
6. **Given** a Save or Save As operation fails, **When** Sorakada cannot complete the write, **Then** it reports the failure and does not report the document as successfully saved.

---

### User Story 3 - Protect Unsaved Work and Track Saved State (Priority: P3)

As a user, I can tell whether the current document differs from its last successful save, and Sorakada prevents accidental loss of those changes when I replace or close the document.

**Why this priority**: Once file writing exists, incorrect dirty-state handling or silent data loss would make the editor unsafe to use.

**Independent Test**: Open a file, edit it, verify it becomes dirty, undo back to the saved contents and verify it becomes clean, then make another edit and attempt New, Open, and Exit to verify unsaved-change protection.

**Acceptance Scenarios**:

1. **Given** a clean opened or newly saved document, **When** the user changes its contents, **Then** the document becomes dirty.
2. **Given** a dirty document, **When** the user undoes changes until the document content again matches the last successful save, **Then** the document becomes clean.
3. **Given** a dirty document, **When** the user attempts New, Open, or Exit, **Then** Sorakada offers Save, Don't Save, and Cancel before discarding the current document.
4. **Given** the unsaved-change prompt is shown, **When** the user chooses Cancel, **Then** the requested destructive action is cancelled and the current document remains unchanged.
5. **Given** the unsaved-change prompt is shown, **When** the user chooses Save and the save fails or is cancelled, **Then** the requested destructive action does not continue.
6. **Given** a save begins for one document state and the user makes additional edits before that save finishes, **When** the earlier state is successfully written, **Then** Sorakada still considers the newer unsaved edits dirty.
7. **Given** a clean document, **When** it is displayed in the application window, **Then** its title identifies the current filename or an untitled document; **When** it becomes dirty, **Then** the title visibly indicates that unsaved changes exist.

---

### User Story 4 - Use Core File Commands from Menu or Keyboard (Priority: P4)

As a user, I can invoke the core single-file commands through a desktop application menu or familiar IDEA-style keyboard shortcuts.

**Why this priority**: The feature remains usable without a larger UI redesign while still supporting discoverability and efficient keyboard-driven testing.

**Independent Test**: Invoke each of the six shortcut-bound commands once from the application menu and once from its keyboard shortcut, and verify equivalent behavior with one execution per invocation. Invoke Exit from the menu and, in a separate run, from the window close control; verify both use the same unsaved-work guard.

**Acceptance Scenarios**:

1. **Given** Sorakada is focused, **When** the user presses `Ctrl+N`, `Ctrl+O`, `Ctrl+S`, or `Ctrl+Shift+S`, **Then** Sorakada invokes New, Open, Save, or Save As respectively.
2. **Given** the editor is focused, **When** the user presses `Ctrl+Z` or `Ctrl+Shift+Z`, **Then** Sorakada performs Undo or Redo respectively.
3. **Given** the application menu is available, **When** the user selects New, Open, Save, Save As, Undo, or Redo, **Then** the same command behavior is used as the corresponding keyboard invocation; Exit is available from the menu and window close control without an assigned shortcut.
4. **Given** a keyboard shortcut is pressed once, **When** its command is valid in the current state, **Then** the command is executed once rather than being duplicated by multiple input routes.

### Edge Cases

- Empty files and one-line files with no line-ending bytes must open successfully and remain clean; if the user later introduces line breaks, the default output style is CRLF for this Windows-focused release.
- Files containing a mixture of LF and CRLF must open successfully and must not become dirty merely because mixed endings were detected.
- When a mixed-ending file is edited and saved, Sorakada normalizes line endings to the style occurring most often in the original file. If LF and CRLF occur equally often, CRLF is used for this Windows-focused release.
- Saving an unedited mixed-ending file must not rewrite it solely to normalize its existing line endings.
- Save As of a mixed-ending document creates the new file using the selected dominant/default line-ending style rather than reproducing per-line mixed endings.
- A supported file with a BOM but no text after the BOM must still be treated as a valid empty text file and preserve the BOM when saved.
- Opening an unsupported or non-text file must fail without replacing, clearing, or dirtying the currently active document.
- A CR byte that is not part of CRLF is unsupported in this release, including in a file that also contains LF or CRLF; opening such a file reports an unsupported line-ending error and leaves the current document unchanged.
- Cancelling Open or Save As must have no effect on the current document.
- Open selects and validates the target file before asking whether to discard unsaved work; cancelling the picker or failing to read/decode the target does not trigger a save or change the current document.
- A failed save must leave the previous successful saved baseline intact so that unsaved changes are not mistakenly marked clean.
- Saving must not silently trim trailing spaces, add/remove a final line break, or otherwise normalize text beyond the explicitly defined BOM and line-ending behavior.
- Changes made to a file by another program while it is open in Sorakada are not detected or reconciled in this feature.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Sorakada MUST maintain exactly one active document in this feature.
- **FR-002**: Users MUST be able to create a new empty untitled document.
- **FR-003**: A newly created untouched document MUST begin in a clean state.
- **FR-004**: Users MUST be able to choose and open a text file from the desktop file system.
- **FR-005**: Sorakada MUST support reading and writing UTF-8 text files both with and without a UTF-8 BOM.
- **FR-006**: Sorakada MUST preserve whether a uniformly formatted supported file originally used a UTF-8 BOM when saving back to the same document.
- **FR-007**: Sorakada MUST support files using LF or CRLF line endings and MUST preserve the original uniform line-ending style when saving.
- **FR-008**: Sorakada MUST accept files containing mixed LF and CRLF line endings without marking them dirty merely because they are mixed.
- **FR-009**: After a mixed-ending file has been edited, Sorakada MUST use the most frequent original line-ending style when saving; ties MUST resolve to CRLF for this release.
- **FR-010**: Saving an unedited mixed-ending document to its existing path MUST NOT rewrite it solely to normalize line endings.
- **FR-011**: Save As for a mixed-ending document MUST write the new file using the dominant line-ending style, with CRLF used for ties.
- **FR-012**: New files MUST default to UTF-8 without BOM and CRLF line endings when line breaks are present.
- **FR-013**: Files with no line-ending bytes MUST open successfully; if new line breaks are added, those line breaks MUST be written using the release's default CRLF style unless the document already has another established uniform style.
- **FR-014**: Sorakada MUST reject files that cannot be treated as supported text in this release, including any file with a CR byte outside CRLF, and MUST leave the currently active document unchanged after such a failed open attempt.
- **FR-015**: Users MUST be able to save the current document to its existing path.
- **FR-016**: Invoking Save for a document without a path MUST use the Save As flow.
- **FR-017**: Users MUST be able to save the current document to a new path using Save As.
- **FR-018**: The active document's path MUST change to the Save As destination only after the new file has been written successfully.
- **FR-019**: Cancelling Open or Save As MUST leave the current document, path, format, and dirty state unchanged. Open MUST select and successfully read/decode its target before prompting to save or discard unsaved work.
- **FR-020**: A failed save MUST be reported to the user and MUST NOT mark unsaved content as saved.
- **FR-021**: Sorakada MUST track whether current document contents differ from the last successfully saved contents.
- **FR-022**: If Undo restores the document to the last successfully saved contents, Sorakada MUST return the document to a clean state.
- **FR-023**: A successful save MUST establish the exact saved document state as the new clean baseline.
- **FR-024**: If additional edits occur while a save is in progress, completion of that save MUST NOT mark those newer edits as clean.
- **FR-025**: Before New, Open, or Exit discards a dirty document, Sorakada MUST offer the user Save, Don't Save, and Cancel choices.
- **FR-026**: Choosing Cancel in an unsaved-change prompt MUST cancel the requested New, Open, or Exit operation.
- **FR-027**: Choosing Save in an unsaved-change prompt MUST allow the requested destructive operation to continue only after a successful save; a cancelled or failed save MUST keep the current document open.
- **FR-028**: Sorakada MUST visibly identify the current filename or untitled state in the application window and MUST visibly distinguish a dirty document from a clean document.
- **FR-029**: Saving MUST preserve user text exactly except for the explicitly defined BOM and line-ending policies; it MUST NOT silently trim whitespace, add/remove a final line break, or apply other text normalization.
- **FR-030**: The application menu MUST expose New, Open, Save, Save As, Exit, Undo, and Redo commands.
- **FR-031**: The initial IDEA-style shortcut profile MUST map `Ctrl+N` to New, `Ctrl+O` to Open, `Ctrl+S` to Save, `Ctrl+Shift+S` to Save As, `Ctrl+Z` to Undo, and `Ctrl+Shift+Z` to Redo.
- **FR-032**: For the six commands with assigned shortcuts, invoking a command from the application menu or its keyboard shortcut MUST produce the same user-visible behavior and MUST NOT cause duplicate execution. Exit MUST be available from the menu and window close control without an assigned shortcut.

### Key Entities

- **Active Document**: The single document currently being edited, identified by an optional file path, a user-visible filename or untitled state, its current contents, its saved/dirty relationship, and its text-format characteristics.
- **Text Format**: The file characteristics that affect round-trip preservation in this feature: UTF-8 BOM presence and line-ending style (LF, CRLF, mixed, or no existing line endings).
- **Saved Baseline**: The exact logical document state corresponding to the most recent successful save, used to determine whether current edits are dirty.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: All supported combinations in the acceptance matrix—UTF-8 or UTF-8 BOM crossed with LF or CRLF—can be opened, edited, saved, and reopened with the intended edit present and the original BOM/uniform line-ending style preserved.
- **SC-002**: Opening and saving a clean supported file with uniform line endings produces no unintended file-content or format change; all such round-trip test cases pass.
- **SC-003**: Dirty-state acceptance tests pass for edit, save, undo-to-saved-content, cancelled save, failed save, and edit-during-save scenarios with no false clean state.
- **SC-004**: In every tested New, Open, and Exit flow involving unsaved work, the user can prevent data loss by choosing Cancel, and the current document remains unchanged.
- **SC-005**: Unsupported-file and save-failure acceptance tests never replace the active document, falsely update its destination, or report unsaved changes as successfully saved.
- **SC-006**: Each of the six commands with assigned shortcuts can be successfully invoked from both the application menu and its keyboard shortcut, with one command execution per invocation. Exit can be invoked from the menu and window close control.
- **SC-007**: The defined single-file acceptance suite can be completed using only isolated test files with no dependency on multi-file workspaces, external file modification, or advanced UI features.

## Assumptions

- Sorakada is Windows-focused for this release, so new documents and line-ending tie cases default to CRLF.
- New documents use UTF-8 without BOM by default.
- Only UTF-8 and UTF-8 BOM are supported text encodings in this feature; broader character-set support will be added later.
- Existing core text editing operations such as text insertion, deletion, Undo, and Redo are already available and this feature integrates them into the file lifecycle rather than redefining general editing behavior.
- Acceptance testing uses one isolated file at a time and does not intentionally modify that file from another program while Sorakada has it open.
- Whole-file operation on ordinary test files is acceptable for this release; dedicated large-file optimization is deferred.

## Out of Scope

- Multiple tabs, simultaneous open documents, workspaces, and file-tree navigation.
- Search/replace UI, syntax highlighting, language-aware editing, and theme/design-system work.
- Recent-file history, session restoration, automatic saving, and crash recovery.
- External file-change detection, file watching, merge/conflict handling, or protection against another program modifying the file after it has been opened.
- Encodings beyond UTF-8 and UTF-8 BOM, including UTF-16, GBK/GB18030, Shift-JIS, Big5, and automatic legacy-encoding detection.
- User-configurable keymaps, shortcut-conflict UI, chord shortcuts, and complete IDEA/Windows shortcut profiles beyond the explicitly listed bindings.
- User-facing controls to convert BOM or line-ending formats manually.
- Per-line preservation of mixed line endings after the document has been edited.
- Dedicated streaming, memory-mapped, or other large-file modes.
